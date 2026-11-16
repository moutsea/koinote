package server

import (
	"context"
	"crypto/hmac"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"koinote/backend/internal/model"
)

const agentGeoHeader = "X-Koinote-Agent-Geo"

func agentGeoEnabled(t writingTask) bool {
	var capability struct {
		Enabled bool `json:"geoEnabled"`
	}
	return t.Conversation && json.Unmarshal(t.Skill, &capability) == nil && capability.Enabled
}

const agentGeoInstructions = `Koi can read, generate, edit and enable/disable an article's WeChat GEO hidden summary with get_wechat_geo_summary, generate_wechat_geo_summary and update_wechat_geo_summary. No Skill is needed. Write tools require a client supporting GEO approval; if unavailable ask the user to update the client or use the web app. Only generate or update at the user's request. Read get_wechat_geo_summary for canonical path, saved document revision and summary timestamp. Generation uses providerMode=builtin and charges additional Credits by actual tokens, separately from this conversation, once a durable draft is created. Applying, rejecting or undoing costs no additional generation Credits; rejecting or undoing does not refund the draft's generation cost. A current summary is reused for free unless explicitly asked to regenerate; reuse preserves its enabled state. If status=generating, poll EXACTLY the same arguments; never claim success early or restart. Generation and updates produce operations: pending means NOT applied, awaiting user approval; only full permission applies directly. After resumption rely on get_operation_results and re-read get_wechat_geo_summary before using the saved summary. Rejected, cancelled or undone proposals are not saved summaries. Failures create no new generation charge; report the error and request a new message to retry. These tools never change title/body or send externally. Updates do not call a model or charge generation Credits. Show the draft or saved summary, its actual status and generation cost in the user's language, without hashes or IDs. Include a saved summary in WeChat publishing previews with includeGeo=true only at the user's request, after get_wechat_geo_summary confirms enabled and stale=false. Other channels do not support it. For body edits plus GEO, apply body edits first and generate from the saved article in a new message. Do not promise search indexing or ranking. Unsaved editor changes are not used.`

func (a *App) addAgentGeoTools(s *mcp.Server, task writingTask) {
	mcp.AddTool(s, &mcp.Tool{Name: "get_wechat_geo_summary", Meta: agentIntentMeta("read"), Description: "Read an owned saved article's GEO hidden summary, its enabled/stale state, document revision and summary timestamp. Omit path only for the focused article. No model call or charge."}, a.agentGetGeoSummary)
	if !agentGeoEnabled(task) {
		return
	}
	mcp.AddTool(s, &mcp.Tool{Name: "generate_wechat_geo_summary", Meta: agentApprovalMeta(), Description: "Generate a GEO hidden-summary proposal using managed AI and additional usage-based Credits. Draft generation is charged once even if the user rejects or undoes applying it. Only full permission applies directly; otherwise wait for user approval. Reuses a current summary for free unless regenerate=true. Poll identical arguments while generating. Does not change article body or publish."}, a.agentGenerateGeoSummary)
	mcp.AddTool(s, &mcp.Tool{Name: "update_wechat_geo_summary", Meta: agentApprovalMeta(), Description: "Propose edits or enable/disable an existing GEO hidden summary using its revision and updatedAt. Only full permission applies directly; otherwise user approval is required. Does not change article body, publish, call a model or charge generation Credits."}, a.agentUpdateGeoSummary)
}

type agentGeoReadInput struct {
	Path string `json:"path,omitempty" jsonschema:"Canonical /documents/... path. Omit only for the current focused article."`
}
type agentGeoGenerateInput struct {
	Path             string            `json:"path"`
	ExpectedRevision int64             `json:"expectedRevision" jsonschema:"Saved document revision from get_wechat_geo_summary."`
	ProviderMode     string            `json:"providerMode" jsonschema:"Must be builtin; confirms additional usage-based GEO generation Credits."`
	Regenerate       bool              `json:"regenerate,omitempty" jsonschema:"Only true when the user explicitly asks to replace an existing current summary."`
	Proof            *agentIntentProof `json:"_agentTaskProof,omitempty" jsonschema:"Reserved host proof. Never supply or invent this field."`
}
type agentGeoUpdateInput struct {
	Path              string            `json:"path"`
	ExpectedRevision  int64             `json:"expectedRevision"`
	ExpectedUpdatedAt string            `json:"expectedUpdatedAt" jsonschema:"Copy geo.updatedAt from get_wechat_geo_summary to avoid overwriting newer edits."`
	Text              *string           `json:"text,omitempty" jsonschema:"Replacement hidden summary, 1 to 2400 characters. Never article body."`
	Enabled           *bool             `json:"enabled,omitempty"`
	Proof             *agentIntentProof `json:"_agentTaskProof,omitempty" jsonschema:"Reserved host proof. Never supply or invent this field."`
}
type agentGeoOutput struct {
	Operations       []map[string]any      `json:"operations"`
	OperationResults []map[string]string   `json:"operationResults,omitempty"`
	Path             string                `json:"path"`
	Revision         int64                 `json:"revision"`
	Geo              *wechatGeoSummaryView `json:"geo"`
	Stale            bool                  `json:"stale"`
	Status           string                `json:"status,omitempty"`
	Credits          int64                 `json:"credits"`
	OperationStatus  string                `json:"operationStatus,omitempty"`
}

func agentGeoResult(doc model.Document, view *wechatGeoSummaryView, status string) agentGeoOutput {
	return agentGeoOutput{Operations: []map[string]any{}, OperationResults: []map[string]string{}, Path: agentDocumentPath(doc.DocID), Revision: doc.Revision, Geo: view, Status: status,
		Stale: view != nil && view.SourceHash != wechatGeoSummaryFingerprint(doc.Title, doc.Content)}
}

func (a *App) loadAgentGeo(ctx context.Context, q imageUsageQuerier, t writingTask, path string, write bool) (model.Document, int, *wechatGeoSummaryView, error) {
	id := agentPathDocumentID(path)
	if id == "" {
		return model.Document{}, 0, nil, errors.New("请先读取文章，使用返回的文章路径")
	}
	if write {
		session, err := a.loadAgentSession(ctx, q, t.SessionID, t.UserID)
		if err != nil {
			return model.Document{}, 0, nil, err
		}
		if session.WriteDocumentID != "" && session.WriteDocumentID != id {
			return model.Document{}, 0, nil, errArticleWriteScope
		}
	}
	var documentID int
	query := `SELECT id FROM documents WHERE doc_id=$1 AND user_id=$2 AND trashed_at IS NULL`
	if write {
		query += ` FOR NO KEY UPDATE`
	}
	if err := q.QueryRow(ctx, query, id, t.UserID).Scan(&documentID); err != nil {
		return model.Document{}, 0, nil, err
	}
	snapshot, err := a.loadAgentSnapshot(ctx, q, t.UserID, id)
	if err != nil {
		return model.Document{}, 0, nil, err
	}
	query = `SELECT rendered_text,summary,topics,keywords,source_hash,enabled,provider_mode,model,updated_at FROM document_wechat_geo_summaries WHERE document_id=$1`
	if write {
		query += ` FOR UPDATE`
	}
	view, err := scanWechatGeoSummary(q.QueryRow(ctx, query, documentID))
	if errors.Is(err, pgx.ErrNoRows) {
		return snapshot.Document, documentID, nil, nil
	}
	if err != nil {
		return model.Document{}, 0, nil, err
	}
	return snapshot.Document, documentID, &view, nil
}

func (a *App) agentGetGeoSummary(ctx context.Context, _ *mcp.CallToolRequest, in agentGeoReadInput) (*mcp.CallToolResult, agentGeoOutput, error) {
	t := ctx.Value(writingMCPContext{}).(writingTask)
	if in.Path == "" {
		in.Path = agentDocumentPath(t.Source.DocID)
	}
	doc, _, view, err := a.loadAgentGeo(ctx, a.db, t, in.Path, false)
	return nil, agentGeoResult(doc, view, ""), err
}

func agentGeoEffects(path string, revision int64) []agentIntentEffect {
	return []agentIntentEffect{{ResourceID: path, Kind: "execute", Revision: strconv.FormatInt(revision, 10)}}
}
func (a *App) verifyAgentGeoProof(t writingTask, s agentSession, tool string, in any, path string, revision int64, proof *agentIntentProof) error {
	if t.IntentVersion == 0 {
		return nil
	}
	if proof == nil || proof.TaskID != t.SessionID || proof.SessionID != t.SessionID || proof.Version != t.IntentVersion || proof.CurrentMessageID != agentUserMessageID(t.ID) || !hmac.Equal([]byte(proof.Token), []byte(a.agentIntentToken(t, s, tool, in, agentGeoEffects(path, revision)))) {
		return errors.New("invalid_geo_task_proof")
	}
	return nil
}
func normalizeAgentGeoGenerate(in agentGeoGenerateInput) (agentGeoGenerateInput, error) {
	in.Proof = nil
	if agentPathDocumentID(in.Path) == "" || in.ExpectedRevision < 1 || in.ProviderMode != "builtin" {
		return in, errors.New("请使用读取摘要返回的文章路径与版本，并确认 providerMode=builtin 的生成费用")
	}
	return in, nil
}
func normalizeAgentGeoUpdate(in agentGeoUpdateInput) (agentGeoUpdateInput, error) {
	in.Proof = nil
	if agentPathDocumentID(in.Path) == "" || in.ExpectedRevision < 1 || in.ExpectedUpdatedAt == "" || (in.Text == nil && in.Enabled == nil) {
		return in, errAgentInput
	}
	if _, err := time.Parse(time.RFC3339Nano, in.ExpectedUpdatedAt); err != nil {
		return in, errAgentInput
	}
	if in.Text != nil {
		text := strings.TrimSpace(*in.Text)
		if text == "" || utf8.RuneCountInString(text) > wechatGeoRenderedMaxRunes {
			return in, errors.New("GEO 隐藏摘要需为 1–2400 字")
		}
		in.Text = &text
	}
	return in, nil
}

func (a *App) agentGenerateGeoSummary(ctx context.Context, _ *mcp.CallToolRequest, original agentGeoGenerateInput) (*mcp.CallToolResult, agentGeoOutput, error) {
	t := ctx.Value(writingMCPContext{}).(writingTask)
	if !agentGeoEnabled(t) {
		return nil, agentGeoOutput{}, errors.New("当前客户端尚不支持 GEO 摘要审批，请更新客户端或使用网页版后重新发送")
	}
	in, err := normalizeAgentGeoGenerate(original)
	if err != nil {
		return nil, agentGeoOutput{}, err
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, agentGeoOutput{}, err
	}
	defer tx.Rollback(ctx)
	current, session, err := a.lockAgentTask(ctx, tx, t.UserID, t.ID, true)
	if err == nil {
		err = a.verifyAgentGeoProof(current, session, "generate_wechat_geo_summary", in, in.Path, in.ExpectedRevision, original.Proof)
	}
	if err != nil {
		return nil, agentGeoOutput{}, err
	}
	doc, _, view, err := a.loadAgentGeo(ctx, tx, t, in.Path, true)
	if err != nil {
		return nil, agentGeoOutput{}, err
	}
	if doc.Revision != in.ExpectedRevision {
		return nil, agentGeoOutput{}, errors.New("文章已变化，请重新读取后再生成 GEO 摘要")
	}
	hash := publicationDigest(in)
	var existingHash string
	err = tx.QueryRow(ctx, `SELECT input_hash FROM agent_geo_generations WHERE task_id=$1 AND doc_id=$2`, t.ID, doc.DocID).Scan(&existingHash)
	if err == nil && existingHash != hash {
		return nil, agentGeoOutput{}, errors.New("本轮已开始过 GEO 生成，请发送新消息生成其他版本")
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return nil, agentGeoOutput{}, err
	}
	if errors.Is(err, pgx.ErrNoRows) {
		if view != nil && view.SourceHash == wechatGeoSummaryFingerprint(doc.Title, doc.Content) && !in.Regenerate {
			out := agentGeoResult(doc, view, "reused")
			out.OperationStatus = "applied"
			return nil, out, nil
		}
		var count int
		if err = tx.QueryRow(ctx, `SELECT count(*) FROM agent_geo_generations WHERE task_id=$1`, t.ID).Scan(&count); err != nil {
			return nil, agentGeoOutput{}, err
		}
		if count >= 5 {
			return nil, agentGeoOutput{}, errors.New("本轮最多生成 5 篇文章的 GEO 摘要，请分批发送")
		}
		if !a.rateLimit().allow("wechat-geo-summary:user:"+strconv.Itoa(t.UserID), wechatGeoSummaryRateLimit, wechatGeoSummaryRateWindow) {
			return nil, agentGeoOutput{}, errors.New("GEO 生成过于频繁，请稍后重试")
		}
		if _, err = tx.Exec(ctx, `INSERT INTO agent_geo_generations(task_id,doc_id,input_hash,status) VALUES($1,$2,$3,'generating')`, t.ID, doc.DocID, hash); err != nil {
			return nil, agentGeoOutput{}, err
		}
		if err = tx.Commit(ctx); err != nil {
			return nil, agentGeoOutput{}, err
		}
		// No connection or transaction spans the model request. A short MCP wait
		// can expire while this single bounded, durably claimed attempt continues.
		work, cancel := context.WithTimeout(context.WithoutCancel(ctx), wechatGeoSummaryRunLimit)
		go func() { defer cancel(); a.runAgentGeoGeneration(work, t, doc, publicationDigest(view)) }()
	} else {
		_ = tx.Rollback(ctx)
	}
	until := time.NewTimer(agentCoverWait)
	defer until.Stop()
	for {
		out, err := a.agentGeoGenerationResult(ctx, t, doc)
		if err != nil || out.Status != "generating" {
			return nil, out, err
		}
		select {
		case <-ctx.Done():
			return nil, agentGeoOutput{}, ctx.Err()
		case <-until.C:
			return nil, out, nil
		case <-time.After(300 * time.Millisecond):
		}
	}
}

func (a *App) runAgentGeoGeneration(ctx context.Context, task writingTask, doc model.Document, summaryStamp string) {
	u, err := a.agentUser(ctx, task.UserID)
	if err == nil {
		_, err = a.generateWechatGeoSummary(ctx, u, doc, func(ctx context.Context, generated generatedWechatGeoSummary, provider agentLLMProvider, reservation string, tokens int) (wechatGeoSummaryView, error) {
			tx, err := a.db.Begin(ctx)
			if err != nil {
				return wechatGeoSummaryView{}, err
			}
			defer tx.Rollback(ctx)
			var session agentSession
			if _, session, err = a.lockAgentTask(ctx, tx, task.UserID, task.ID, true); err != nil {
				return wechatGeoSummaryView{}, err
			}
			current, _, previous, err := a.loadAgentGeo(ctx, tx, task, agentDocumentPath(doc.DocID), true)
			if err != nil {
				return wechatGeoSummaryView{}, err
			}
			if current.Revision != doc.Revision || wechatGeoSummaryFingerprint(current.Title, current.Content) != wechatGeoSummaryFingerprint(doc.Title, doc.Content) || publicationDigest(previous) != summaryStamp {
				return wechatGeoSummaryView{}, errors.New("文章或 GEO 摘要在生成期间发生变化，未保存本次结果；请发送新消息重试")
			}
			view := wechatGeoSummaryView{Text: formatWechatGeoSummary(generated), Summary: generated.Summary, Topics: generated.Topics, Keywords: generated.Keywords, SourceHash: wechatGeoSummaryFingerprint(doc.Title, doc.Content), Enabled: true, ProviderMode: provider.Mode, Model: provider.Model}
			if provider.Mode == "builtin" {
				_, view.CreditsCharged, err = commitCreditReservationTx(ctx, tx, task.UserID, reservation, tokens, map[string]any{"feature": "wechat_geo_summary", "docId": doc.DocID, "protocol": provider.Protocol, "model": provider.Model})
				if err != nil {
					return wechatGeoSummaryView{}, err
				}
			}
			if _, err = a.proposeAgentGeoTx(ctx, tx, task, session, u, doc, previous, &view, "geo-generate:"+doc.DocID); err != nil {
				return wechatGeoSummaryView{}, err
			}
			if _, err = tx.Exec(ctx, `UPDATE agent_geo_generations SET status='saved',credits=$3 WHERE task_id=$1 AND doc_id=$2`, task.ID, doc.DocID, view.CreditsCharged); err != nil {
				return wechatGeoSummaryView{}, err
			}
			if err = tx.Commit(ctx); err != nil {
				return wechatGeoSummaryView{}, err
			}
			return view, nil
		})
	}
	if err != nil {
		cleanup, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		code := "generation_failed"
		if errors.Is(err, errInsufficientCredits) {
			code = "insufficient_credits"
		}
		if strings.Contains(err.Error(), "not configured") {
			code = "service_unavailable"
		}
		if strings.Contains(err.Error(), "在生成期间发生变化") {
			code = "source_changed"
		}
		_, _ = a.db.Exec(cleanup, `UPDATE agent_geo_generations SET status='failed',error_code=$3 WHERE task_id=$1 AND doc_id=$2 AND status='generating'`, task.ID, doc.DocID, code)
	}
}

func (a *App) agentGeoGenerationResult(ctx context.Context, t writingTask, doc model.Document) (agentGeoOutput, error) {
	var status string
	var code string
	var credits int64
	if err := a.db.QueryRow(ctx, `SELECT CASE WHEN status='generating' AND created_at<now()-interval '2 minutes' THEN 'failed' ELSE status END,credits,error_code FROM agent_geo_generations WHERE task_id=$1 AND doc_id=$2`, t.ID, doc.DocID).Scan(&status, &credits, &code); err != nil {
		return agentGeoOutput{}, err
	}
	if status == "failed" {
		message := "GEO 摘要生成失败或任务已停止，请发送新消息重试"
		switch code {
		case "insufficient_credits":
			message = "可用 Credits 不足以生成 GEO 摘要，请补充 Credits 后发送新消息重试；对话费用另计"
		case "service_unavailable":
			message = "GEO 摘要生成服务暂未配置，请稍后重试"
		case "source_changed":
			message = "文章或 GEO 摘要在生成期间发生变化，已保留最新内容，请重新读取后发送新消息重试"
		}
		return agentGeoOutput{}, errors.New(message + "；本次未扣 GEO 生成 Credits")
	}
	out := agentGeoResult(doc, nil, status)
	out.OperationStatus = "proposed"
	if status == "saved" {
		op, err := scanAgentOperation(a.db.QueryRow(ctx, `SELECT `+agentOperationColumns+` FROM agent_operations WHERE task_id=$1 AND request_key=$2`, t.ID, "geo-generate:"+doc.DocID))
		if err == nil {
			return a.agentGeoOperationResult(ctx, t, op)
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return out, err
		}
		// Pre-approval-protocol generations keep their original saved receipt.
		current, _, view, err := a.loadAgentGeo(ctx, a.db, t, agentDocumentPath(doc.DocID), false)
		if err != nil {
			return out, err
		}
		out = agentGeoResult(current, view, status)
		out.Credits, out.OperationStatus = credits, "applied"
	}
	return out, nil
}

func (a *App) agentUpdateGeoSummary(ctx context.Context, _ *mcp.CallToolRequest, original agentGeoUpdateInput) (*mcp.CallToolResult, agentGeoOutput, error) {
	t := ctx.Value(writingMCPContext{}).(writingTask)
	if !agentGeoEnabled(t) {
		return nil, agentGeoOutput{}, errors.New("当前客户端尚不支持 GEO 摘要审批，请更新客户端或使用网页版后重新发送")
	}
	in, err := normalizeAgentGeoUpdate(original)
	if err != nil {
		return nil, agentGeoOutput{}, err
	}
	user, err := a.agentUser(ctx, t.UserID)
	if err != nil {
		return nil, agentGeoOutput{}, err
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, agentGeoOutput{}, err
	}
	defer tx.Rollback(ctx)
	current, session, err := a.lockAgentTask(ctx, tx, t.UserID, t.ID, true)
	if err == nil {
		err = a.verifyAgentGeoProof(current, session, "update_wechat_geo_summary", in, in.Path, in.ExpectedRevision, original.Proof)
	}
	if err != nil {
		return nil, agentGeoOutput{}, err
	}
	key := "geo-update:" + publicationDigest(in)
	op, err := scanAgentOperation(tx.QueryRow(ctx, `SELECT `+agentOperationColumns+` FROM agent_operations WHERE task_id=$1 AND request_key=$2`, t.ID, key))
	if err == nil {
		_ = tx.Rollback(ctx)
		out, err := a.agentGeoOperationResult(ctx, t, op)
		return nil, out, err
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return nil, agentGeoOutput{}, err
	}
	doc, _, view, err := a.loadAgentGeo(ctx, tx, t, in.Path, true)
	if err != nil {
		return nil, agentGeoOutput{}, err
	}
	if view == nil {
		return nil, agentGeoOutput{}, errors.New("这篇文章还没有 GEO 摘要，请先生成")
	}
	stamp, _ := time.Parse(time.RFC3339Nano, in.ExpectedUpdatedAt)
	if doc.Revision == in.ExpectedRevision && (in.Text == nil || *in.Text == view.Text) && (in.Enabled == nil || *in.Enabled == view.Enabled) {
		out := agentGeoResult(doc, view, "saved")
		out.OperationStatus = "applied"
		return nil, out, nil
	}
	if doc.Revision != in.ExpectedRevision || !view.UpdatedAt.Equal(stamp) {
		return nil, agentGeoOutput{}, errors.New("文章或 GEO 摘要已变化，请重新读取后再修改")
	}
	next := *view
	if in.Text != nil {
		next.Text = *in.Text
	}
	if in.Enabled != nil {
		next.Enabled = *in.Enabled
	}
	op, err = a.proposeAgentGeoTx(ctx, tx, t, session, user, doc, view, &next, key)
	if err != nil {
		return nil, agentGeoOutput{}, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, agentGeoOutput{}, err
	}
	out, err := a.agentGeoOperationResult(ctx, t, op)
	return nil, out, err
}
