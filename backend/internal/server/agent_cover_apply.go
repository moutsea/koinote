package server

import (
	"bytes"
	"context"
	"crypto/hmac"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"io"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"koinote/backend/internal/model"
)

type agentCoverSelection struct {
	ArtifactID string `json:"artifactId"`
	Source     string `json:"source"`
	Ratio      string `json:"ratio"`
}

const agentCoverApplyHeader = "X-Koinote-Agent-Cover-Apply"

func agentCoverApplyEnabled(t writingTask) bool {
	var capability struct {
		Enabled bool `json:"coverApplyEnabled"`
	}
	return t.CoverEnabled && json.Unmarshal(t.Skill, &capability) == nil && capability.Enabled
}

type agentSetCoverInput struct {
	Path             string            `json:"path" jsonschema:"Canonical document path from get_document. Use the article discussed in the conversation, not a different editor focus."`
	ExpectedRevision int64             `json:"expectedRevision" jsonschema:"Saved revision from get_document."`
	ArtifactID       string            `json:"artifactId" jsonschema:"ID of an existing generated cover in this conversation, from generate_cover or get_conversation. Reuse it without generating or charging again."`
	Proof            *agentIntentProof `json:"_agentTaskProof,omitempty" jsonschema:"Reserved host proof. Never supply or invent this field."`
}

func normalizeAgentSetCover(in agentSetCoverInput) (agentSetCoverInput, error) {
	in.Proof = nil
	if agentPathDocumentID(in.Path) == "" || in.ExpectedRevision < 1 || !validUUID(in.ArtifactID) {
		return in, errors.New("请使用 get_document 返回的文章路径和版本，以及本会话已生成封面的 artifactId")
	}
	return in, nil
}

func agentSetCoverKey(in agentSetCoverInput) string {
	return "cover-" + in.ArtifactID + "-" + agentPathDocumentID(in.Path)
}

func (a *App) loadAgentCoverArtifact(ctx context.Context, q imageUsageQuerier, t writingTask, id string) ([]byte, error) {
	var data []byte
	err := q.QueryRow(ctx, `SELECT a.data FROM agent_artifacts a JOIN writing_agent_tasks original ON original.id=a.task_id JOIN agent_sessions s ON s.id=original.session_id WHERE a.id=$1 AND a.user_id=$2 AND original.session_id=$3 AND s.deleted_at IS NULL AND a.name LIKE 'koi-cover-%' AND a.mime_type='image/jpeg' AND (original.created_at<$4 OR original.id=$5)`, id, t.UserID, t.SessionID, t.CreatedAt, t.ID).Scan(&data)
	if err != nil {
		return nil, fmt.Errorf("只能使用本会话已生成的封面，请读取 get_conversation 核对图片: %w", err)
	}
	return data, nil
}

func (a *App) validateAgentSetCover(ctx context.Context, q imageUsageQuerier, t writingTask, s agentSession, in agentSetCoverInput) error {
	if !agentCoverApplyEnabled(t) {
		return errors.New("当前客户端尚不支持封面设置审批，请升级客户端或使用网页版")
	}
	if s.WriteDocumentID != "" && agentPathDocumentID(in.Path) != s.WriteDocumentID {
		return errArticleWriteScope
	}
	library, err := agentLibraryTask(ctx, q, t, s)
	if err != nil {
		return err
	}
	if library {
		return errors.New(agentLibraryScopeInstruction)
	}
	var revision int64
	if err := q.QueryRow(ctx, `SELECT d.revision FROM documents d JOIN agent_document_reads r ON r.doc_id=d.doc_id AND r.task_id=$3 WHERE d.doc_id=$1 AND d.user_id=$2 AND d.trashed_at IS NULL AND (r.snapshot->'document'->>'revision')::bigint=d.revision`, agentPathDocumentID(in.Path), t.UserID, t.ID).Scan(&revision); err != nil {
		return errors.New("请先用 get_document 读取目标文章的最新版本")
	}
	if revision != in.ExpectedRevision {
		return errDocumentRevisionConflict
	}
	_, err = a.loadAgentCoverArtifact(ctx, q, t, in.ArtifactID)
	return err
}

// Transfer into ordinary image storage, so the article and publishing do not
// depend on the private conversation download or the lifetime of its session.
// No database transaction/connection spans the Worker request and quota callback.
func (a *App) uploadAgentCover(ctx context.Context, user model.User, data []byte) (string, error) {
	if a.cfg.WorkerURL == "" || a.cfg.InternalToken == "" {
		return "", errors.New("图片转存服务尚未配置；封面仍保存在会话中，可下载后手动设置")
	}
	request, err := http.NewRequestWithContext(ctx, "POST", a.cfg.WorkerURL+"/api/images", bytes.NewReader(data))
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", "image/jpeg")
	request.Header.Set("X-Koinote-Internal-Token", a.cfg.InternalToken)
	request.Header.Set("X-Auth-User-Id", user.AuthUserID)
	client := &http.Client{Timeout: 30 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	response, err := client.Do(request)
	if err != nil {
		return "", errors.New("封面转存失败，请重试；无需重新生成图片")
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusRequestEntityTooLarge || response.StatusCode == http.StatusConflict {
		return "", errors.New("云存储空间不足，无法设置封面；请清理空间后重试，无需重新生图")
	}
	var result struct{ Image struct{ Key string } }
	if response.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(response.Body, 16<<10)).Decode(&result) != nil {
		return "", errors.New("封面转存失败，请重试；无需重新生成图片")
	}
	owner, valid := imageKeyOwner(result.Image.Key)
	if !valid || owner != user.AuthUserID {
		return "", errors.New("封面转存返回了无效图片地址")
	}
	return "/images/" + result.Image.Key, nil
}

func (a *App) agentSetDocumentCover(ctx context.Context, _ *mcp.CallToolRequest, original agentSetCoverInput) (*mcp.CallToolResult, map[string]any, error) {
	t := ctx.Value(writingMCPContext{}).(writingTask)
	in, err := normalizeAgentSetCover(original)
	if err != nil {
		return nil, nil, err
	}
	user, err := a.agentUser(ctx, t.UserID)
	if err != nil {
		return nil, nil, err
	}
	key, hash := agentSetCoverKey(in), publicationDigest(in)
	// Check scope/proof and a durable retry before doing any image I/O.
	check := func(tx pgx.Tx) (writingTask, agentSession, error) {
		current, s, err := a.lockAgentTask(ctx, tx, t.UserID, t.ID, true)
		if err != nil {
			return current, s, err
		}
		proof := original.Proof
		if current.IntentVersion > 0 && (proof == nil || proof.TaskID != t.SessionID || proof.SessionID != t.SessionID || proof.Version != current.IntentVersion || proof.CurrentMessageID != agentUserMessageID(t.ID) || !hmac.Equal([]byte(proof.Token), []byte(a.agentIntentToken(current, s, "set_document_cover", in, agentGeoEffects(in.Path, in.ExpectedRevision))))) {
			return current, s, errors.New("invalid_cover_task_proof")
		}
		return current, s, nil
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, nil, err
	}
	_, initialSession, err := check(tx)
	if err != nil {
		_ = tx.Rollback(ctx)
		return nil, nil, err
	}
	existing, err := scanAgentOperation(tx.QueryRow(ctx, `SELECT `+agentOperationColumns+` FROM agent_operations WHERE task_id=$1 AND request_key=$2`, t.ID, key))
	if err == nil {
		_ = tx.Rollback(ctx)
		if existing.Hash != hash {
			return nil, nil, errAgentSessionConflict
		}
		return nil, agentOperationsResponse(t, []agentOperation{existing}), nil
	}
	if errors.Is(err, pgx.ErrNoRows) {
		err = a.validateAgentSetCover(ctx, tx, t, initialSession, in)
	}
	_ = tx.Rollback(ctx)
	if err != nil {
		return nil, nil, err
	}
	data, err := a.loadAgentCoverArtifact(ctx, a.db, t, in.ArtifactID)
	if err != nil {
		return nil, nil, err
	}
	config, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width <= 0 || config.Height <= 0 {
		return nil, nil, errors.New("生成的封面图片无法读取")
	}
	// Generated covers are at most 940px per side. Scaling both pixel dimensions
	// preserves their exact ratio in the shared two-decimal, <=100-per-side format.
	ratio := fmt.Sprintf("%.2f:%.2f", float64(config.Width)/100, float64(config.Height)/100)
	if !validWechatCoverRatio(ratio) {
		ratio = wechatCoverRatioWide
	}
	source, err := a.uploadAgentCover(ctx, user, data)
	if err != nil {
		return nil, nil, err
	}
	// Retain pending/undo references; failed or cancelled proposals become GC candidates.
	defer func() {
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		a.enqueueOrphanedImages(cleanup, userRef{ID: user.ID, AuthUserID: user.AuthUserID}, source)
	}()
	tx, err = a.db.Begin(ctx)
	if err != nil {
		return nil, nil, err
	}
	defer tx.Rollback(ctx)
	current, session, err := check(tx)
	if err != nil {
		return nil, nil, err
	}
	// A concurrent identical request may have committed during the upload.
	existing, err = scanAgentOperation(tx.QueryRow(ctx, `SELECT `+agentOperationColumns+` FROM agent_operations WHERE task_id=$1 AND request_key=$2`, t.ID, key))
	if err == nil {
		if existing.Hash != hash {
			return nil, nil, errAgentSessionConflict
		}
		return nil, agentOperationsResponse(t, []agentOperation{existing}), nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, nil, err
	}
	if err = a.validateAgentSetCover(ctx, tx, current, session, in); err != nil {
		return nil, nil, err
	}
	before, err := a.loadAgentSnapshot(ctx, tx, t.UserID, agentPathDocumentID(in.Path))
	if err != nil {
		return nil, nil, err
	}
	op := agentOperation{TaskID: t.ID, Hash: hash, Status: "pending", Reason: "等待用户审批", Before: &before, Input: agentOperationInput{Key: key, Kind: "cover", Path: in.Path, ExpectedRevision: in.ExpectedRevision, Title: before.Document.Title, Content: "![](" + source + ")", Explanation: "将已生成的图片设为文章封面，保留标题和正文。", Cover: &agentCoverSelection{ArtifactID: in.ArtifactID, Source: source, Ratio: ratio}}}
	op.ID, err = randomUUID()
	if err != nil {
		return nil, nil, err
	}
	inputJSON, _ := json.Marshal(op.Input)
	beforeJSON, _ := json.Marshal(op.Before)
	if err = tx.QueryRow(ctx, `INSERT INTO agent_operations(id,task_id,user_id,request_key,input_hash,input,before_state,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING created_at`, op.ID, t.ID, t.UserID, key, hash, inputJSON, beforeJSON, op.Reason).Scan(&op.CreatedAt); err != nil {
		return nil, nil, err
	}
	var advice bool
	var count int
	if err = tx.QueryRow(ctx, `SELECT advice_only,(SELECT count(*) FROM agent_operations WHERE task_id=$1) FROM writing_agent_tasks WHERE id=$1`, t.ID).Scan(&advice, &count); err != nil {
		return nil, nil, err
	}
	if count > 40 {
		return nil, nil, errors.New("本轮最多处理 40 项改动，请分批执行")
	}
	var update *documentUpdateResult
	if session.Permission == "full" && !advice {
		update, err = a.applyAgentOperationTx(ctx, tx, user, &op, "full", "用户已完全授权本会话")
		if err != nil {
			return nil, nil, err
		}
	}
	if err = a.checkAgentTaskBudget(ctx, tx, user, t.ID); err != nil {
		return nil, nil, err
	}
	if _, err = tx.Exec(ctx, `UPDATE agent_sessions SET updated_at=clock_timestamp() WHERE id=$1`, session.ID); err != nil {
		return nil, nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, nil, err
	}
	if update != nil {
		a.finishDocumentUpdate(ctx, user, *update)
	}
	return nil, agentOperationsResponse(t, []agentOperation{op}), nil
}

func (a *App) applyAgentCoverTx(ctx context.Context, tx pgx.Tx, user model.User, op *agentOperation, undo bool) (*documentUpdateResult, agentOperationResult, error) {
	if op.Before == nil || op.Input.Cover == nil {
		return nil, agentOperationResult{}, errAgentInput
	}
	var locked string
	if err := tx.QueryRow(ctx, `SELECT doc_id FROM documents WHERE doc_id=$1 AND user_id=$2 AND trashed_at IS NULL FOR UPDATE`, op.Before.Document.DocID, user.ID).Scan(&locked); err != nil {
		return nil, agentOperationResult{}, err
	}
	fresh, err := a.loadAgentSnapshot(ctx, tx, user.ID, locked)
	if err != nil {
		return nil, agentOperationResult{}, err
	}
	mode, ratio, source, prompt := wechatCoverModeArticle, op.Input.Cover.Ratio, op.Input.Cover.Source, ""
	expectedCover := op.Before.Document
	if undo {
		if op.Result == nil {
			return nil, agentOperationResult{}, errAgentInput
		}
		expectedCover = model.Document{CoverMode: mode, CoverRatio: ratio, CoverImageSource: source, CoverPrompt: prompt}
		mode, ratio, source, prompt = op.Before.Document.CoverMode, op.Before.Document.CoverRatio, op.Before.Document.CoverImageSource, op.Before.Document.CoverPrompt
	}
	// This operation reviews only cover metadata. Text/theme edits after the
	// preview (or before undo) remain intact; a changed cover always conflicts.
	if fresh.Document.CoverMode != expectedCover.CoverMode || fresh.Document.CoverRatio != expectedCover.CoverRatio || fresh.Document.CoverImageSource != expectedCover.CoverImageSource || fresh.Document.CoverPrompt != expectedCover.CoverPrompt {
		return nil, agentOperationResult{}, errDocumentRevisionConflict
	}
	want := fresh.Document.Revision
	r, err := a.updateDocumentTx(ctx, tx, updateDocumentParams{User: user, DocID: locked, Title: fresh.Document.Title, Content: fresh.Document.Content, Theme: fresh.Document.Theme, ExpectedRevision: want, Source: documentSourceAgent, CoverMode: &mode, CoverRatio: &ratio, CoverImageSource: &source, CoverPrompt: &prompt})
	result := agentOperationResult{DocID: locked, Path: op.Input.Path, FolderID: fresh.FolderID, Revision: r.Document.Revision}
	if undo {
		result = *op.Result
		result.UndoRevision = r.Document.Revision
	}
	return &r, result, err
}
