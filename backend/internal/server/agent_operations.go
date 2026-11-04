package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"koinote/backend/internal/httpx"
	"koinote/backend/internal/model"
)

type agentSnapshot struct {
	Folder   *agentFolderSnapshot `json:"folder,omitempty"`
	Document model.Document       `json:"document"`
	FolderID string               `json:"folderId"`
	Path     string               `json:"path"`
	// Nil for older snapshots, or projected moves whose order is only known at apply.
	SortOrder *int64 `json:"sortOrder,omitempty"`
	// Server-owned dependency within one proposal batch. The snapshot is the
	// expected state immediately after this predecessor, including no-op edits.
	DependsOn string `json:"dependsOn,omitempty"`
}
type agentOperationInput struct {
	ExpectedFolderVersion string `json:"expectedFolderVersion,omitempty" jsonschema:"Required for delete_folder: copy version from list_folders; use its /folders/... path. No document revision is needed."`
	Key                   string `json:"key" jsonschema:"Unique stable key for this operation in the task. Reuse only for an identical retry."`
	Kind                  string `json:"kind" jsonschema:"One of update, create, move, trash (documents only), folder (create), delete_folder (empty folders only). Propose related operations together in execution order; trash must be last for that document."`
	Path                  string `json:"path,omitempty" jsonschema:"Document path from search_documents/get_document for update, move and trash; folder path from list_folders for delete_folder."`
	ExpectedRevision      int64  `json:"expectedRevision,omitempty" jsonschema:"Version returned by get_document; required for existing documents. Reuse that original revision for every operation on the same document in this batch; the server tracks internal version changes."`
	Title                 string `json:"title,omitempty"`
	Content               string `json:"content,omitempty" jsonschema:"Complete Markdown for update or create. Preserve unmodified content."`
	FolderID              string `json:"folderId,omitempty" jsonschema:"Destination or parent folder ID from list_folders; empty means root."`
	Explanation           string `json:"explanation"`
	MinorEdit             bool   `json:"minorEdit,omitempty" jsonschema:"True only after checking the actual diff is a minor correction with no semantic change. The server independently validates this claim."`
	TargetID              string `json:"targetId,omitempty" jsonschema:"Leave empty; the server assigns new document or folder IDs."`
}
type agentOperationResult struct {
	DocID    string `json:"docId,omitempty"`
	FolderID string `json:"folderId,omitempty"`
	Revision int64  `json:"revision,omitempty"`
	Path     string `json:"path,omitempty"`
	// Version produced by undo, separate from the immutable applied revision.
	// A predecessor can only continue undoing at this exact restored version.
	UndoRevision int64 `json:"undoRevision,omitempty"`
	// Manual sorting does not bump document revisions, so moves also guard this value.
	SortOrder *int64 `json:"sortOrder,omitempty"`
}
type agentOperation struct {
	ID        string                `json:"id"`
	TaskID    string                `json:"taskId"`
	Hash      string                `json:"hash"`
	Input     agentOperationInput   `json:"input"`
	Before    *agentSnapshot        `json:"before"`
	Status    string                `json:"status"`
	Approval  string                `json:"approval"`
	Reason    string                `json:"reason"`
	Result    *agentOperationResult `json:"result"`
	CreatedAt time.Time             `json:"createdAt"`
}

const agentOperationColumns = `id::text,task_id::text,input_hash,input,before_state,status,approval,reason,result,created_at`

func scanAgentOperation(row pgx.Row) (agentOperation, error) {
	var o agentOperation
	err := row.Scan(&o.ID, &o.TaskID, &o.Hash, &o.Input, &o.Before, &o.Status, &o.Approval, &o.Reason, &o.Result, &o.CreatedAt)
	return o, err
}
func (a *App) loadAgentOperations(ctx context.Context, userID int, ids []string) ([]agentOperation, error) {
	rows, err := a.db.Query(ctx, `SELECT `+agentOperationColumns+` FROM agent_operations WHERE user_id=$1 AND task_id=ANY($2::uuid[]) ORDER BY created_at,id`, userID, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ops := []agentOperation{}
	for rows.Next() {
		o, e := scanAgentOperation(rows)
		if e != nil {
			return nil, e
		}
		ops = append(ops, o)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return orderAgentOperations(ops)
}

// created_at is shared by operations inserted in one transaction. UUID order
// must not put a dependent card before its predecessor (including "approve all").
func orderAgentOperations(ops []agentOperation) ([]agentOperation, error) {
	return orderDependentAgentOperations(ops, func(op agentOperation) string {
		if op.Before != nil {
			return op.Before.DependsOn
		}
		return ""
	})
}

func orderDependentAgentOperations(ops []agentOperation, dependency func(agentOperation) string) ([]agentOperation, error) {
	byID := make(map[string]agentOperation, len(ops))
	for _, op := range ops {
		byID[op.ID] = op
	}
	ordered := make([]agentOperation, 0, len(ops))
	state := map[string]int{}
	var visit func(agentOperation) error
	visit = func(op agentOperation) error {
		if state[op.ID] == 2 {
			return nil
		}
		if state[op.ID] == 1 {
			return errors.New("cyclic Agent operation dependency")
		}
		state[op.ID] = 1
		if previous, ok := byID[dependency(op)]; ok {
			if err := visit(previous); err != nil {
				return err
			}
		}
		state[op.ID] = 2
		ordered = append(ordered, op)
		return nil
	}
	for _, op := range ops {
		if err := visit(op); err != nil {
			return nil, err
		}
	}
	return ordered, nil
}

func agentSnapshotAfter(previous agentOperation) (agentSnapshot, error) {
	if previous.Before == nil {
		return agentSnapshot{}, errAgentInput
	}
	next := *previous.Before
	next.DependsOn = previous.ID
	switch previous.Input.Kind {
	case "update":
		if next.Document.Title != previous.Input.Title || next.Document.Content != previous.Input.Content {
			next.Document.Revision++
		}
		next.Document.Title, next.Document.Content = previous.Input.Title, previous.Input.Content
	case "move":
		next.Document.Revision++
		next.FolderID = previous.Input.FolderID
		next.SortOrder = nil
	default:
		return agentSnapshot{}, fmt.Errorf("移入回收站必须是该文档在本组中的最后一项操作: %w", errAgentInput)
	}
	return next, nil
}
func (a *App) loadAgentSnapshot(ctx context.Context, q imageUsageQuerier, userID int, id string) (agentSnapshot, error) {
	var s agentSnapshot
	s.Path = agentDocumentPath(id)
	err := q.QueryRow(ctx, `SELECT d.doc_id,d.title,d.content,d.theme,d.revision,d.created_at,d.updated_at,COALESCE(f.folder_id,''),d.sort_order FROM documents d LEFT JOIN folders f ON f.id=d.folder_id WHERE d.user_id=$1 AND d.doc_id=$2 AND d.trashed_at IS NULL`, userID, id).Scan(&s.Document.DocID, &s.Document.Title, &s.Document.Content, &s.Document.Theme, &s.Document.Revision, &s.Document.CreatedAt, &s.Document.UpdatedAt, &s.FolderID, &s.SortOrder)
	return s, err
}

func (a *App) lockAgentTask(ctx context.Context, tx pgx.Tx, userID int, id string, live bool) (writingTask, agentSession, error) {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, userID); err != nil {
		return writingTask{}, agentSession{}, err
	}
	t, err := scanWritingTask(tx.QueryRow(ctx, `SELECT `+writingTaskColumns+` FROM writing_agent_tasks WHERE id=$1 AND user_id=$2 FOR UPDATE`, id, userID))
	if err != nil {
		return t, agentSession{}, err
	}
	s, err := a.loadAgentSession(ctx, tx, t.SessionID, userID)
	if err != nil {
		return t, s, err
	}
	if t.CancelRequested || (live && (writingTerminal(t.Status) || time.Now().After(t.Deadline))) {
		return t, s, errAgentSessionConflict
	}
	if live && t.IntentVersion > 0 {
		if err = a.checkAgentIntentVersion(ctx, tx, t); err != nil {
			return t, s, err
		}
	}
	var member bool
	if err = tx.QueryRow(ctx, `SELECT membership_tier='lifetime' FROM users WHERE id=$1`, userID).Scan(&member); err != nil {
		return t, s, err
	}
	if !member {
		return t, s, errAgentSessionConflict
	}
	return t, s, nil
}
func (a *App) checkAgentTaskBudget(ctx context.Context, tx pgx.Tx, user model.User, id string) error {
	return a.checkAgentTaskStorageLimit(ctx, tx, user, id, agentTaskStorageBudget-(512<<10))
}
func (a *App) checkAgentTaskStorageLimit(ctx context.Context, tx pgx.Tx, user model.User, id string, limit int64) error {
	var bytes int64
	if err := tx.QueryRow(ctx, `SELECT agent_task_storage_bytes($1)`, id).Scan(&bytes); err != nil {
		return err
	}
	if bytes > limit {
		return fmt.Errorf("本轮结果超过 4 MB，请缩小处理范围或分批执行: %w", errAgentInput)
	}
	return a.checkAgentStorage(ctx, tx, user)
}
func (a *App) cancelAgentTask(ctx context.Context, userID int, id string) error {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, userID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE writing_agent_tasks SET cancel_requested=true,next_poll_at=now() WHERE id=$1 AND user_id=$2`, id, userID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE agent_operations SET status='cancelled',updated_at=now() WHERE task_id=$1 AND user_id=$2 AND status='pending'`, id, userID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Conservative independent check: ordinary text corrections only. Markdown/code,
// numbers, titles, links and semantic rewrites require human review in assist mode.
func agentMinorCorrection(before, after string) bool {
	if before == after {
		return true
	}
	if strings.ContainsAny(before+after, "`<>[]*#|\\") || strings.Contains(before+after, "://") {
		return false
	}
	normalize := func(s string) string {
		s = strings.ReplaceAll(s, "\r\n", "\n")
		lines := strings.Split(s, "\n")
		for i := range lines {
			// Preserve Markdown hard breaks; removing two trailing spaces changes rendering.
			if !strings.HasSuffix(lines[i], "  ") {
				lines[i] = strings.TrimRight(lines[i], " \t")
			}
		}
		return strings.TrimRight(strings.Join(lines, "\n"), "\n")
	}
	before, after = normalize(before), normalize(after)
	for before != "" && after != "" {
		corrected := false
		for _, p := range [][2]string{{"帐户", "账户"}, {"错别子", "错别字"}, {"迫不急待", "迫不及待"}, {"再接再励", "再接再厉"}, {"一如继往", "一如既往"}} {
			if strings.HasPrefix(before, p[0]) && strings.HasPrefix(after, p[1]) {
				before, after = before[len(p[0]):], after[len(p[1]):]
				corrected = true
				break
			}
		}
		if corrected {
			continue
		}
		b, size := utf8.DecodeRuneInString(before)
		a, afterSize := utf8.DecodeRuneInString(after)
		if b != a {
			return false
		}
		before, after = before[size:], after[afterSize:]
	}
	return before == after
}
func agentOperationMinor(o agentOperation) bool {
	if o.Input.Kind == "create" {
		return true
	}
	return o.Input.Kind == "update" && o.Input.MinorEdit && o.Before != nil && o.Input.Title == o.Before.Document.Title && agentMinorCorrection(o.Before.Document.Content, o.Input.Content)
}

func (a *App) proposeAgentOperations(ctx context.Context, t writingTask, inputs []agentOperationInput, authorization ...agentIntentAuthorization) ([]agentOperation, error) {
	if len(inputs) < 1 || len(inputs) > 20 {
		return nil, errAgentInput
	}
	user, err := a.agentUser(ctx, t.UserID)
	if err != nil {
		return nil, err
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(ctx)
	current, s, err := a.lockAgentTask(ctx, tx, t.UserID, t.ID, true)
	if err != nil {
		return nil, err
	}
	if err = checkArticleOperations(s.WriteDocumentID, inputs); err != nil {
		return nil, err
	}
	libraryTask, err := agentLibraryTask(ctx, tx, current, s)
	if err != nil {
		return nil, err
	}
	if libraryTask {
		for _, input := range inputs {
			if input.Kind != "folder" && input.Kind != "move" {
				return nil, fmt.Errorf("%s: %w", agentLibraryScopeInstruction, errAgentInput)
			}
		}
	}
	if err = a.verifyAgentIntentTx(ctx, tx, current, s, inputs, authorization); err != nil {
		return nil, err
	}
	var advice bool
	if err = tx.QueryRow(ctx, `SELECT advice_only FROM writing_agent_tasks WHERE id=$1`, t.ID).Scan(&advice); err != nil {
		return nil, err
	}
	ops := []agentOperation{}
	newIDs := map[string]bool{}
	keys := map[string]bool{}
	lastDocumentOperation := map[string]agentOperation{}
	deletedFolders := map[string]bool{}
	allMinor := true
	for _, in := range inputs {
		if len(in.Key) < 1 || len(in.Key) > 100 || keys[in.Key] || in.TargetID != "" || len(in.Explanation) > 8000 || len(in.Content) > 512<<10 {
			return nil, errAgentInput
		}
		keys[in.Key] = true
		raw, _ := json.Marshal(in)
		digest := sha256.Sum256(raw)
		hash := hex.EncodeToString(digest[:])
		existing, e := scanAgentOperation(tx.QueryRow(ctx, `SELECT `+agentOperationColumns+` FROM agent_operations WHERE task_id=$1 AND request_key=$2`, t.ID, in.Key))
		if e == nil {
			if existing.Hash != hash {
				return nil, errAgentSessionConflict
			}
			ops = append(ops, existing)
			if existing.Before != nil && existing.Before.Folder == nil {
				lastDocumentOperation[existing.Input.Path] = existing
			}
			if !agentOperationMinor(existing) {
				allMinor = false
			}
			continue
		}
		if !errors.Is(e, pgx.ErrNoRows) {
			return nil, e
		}
		op := agentOperation{TaskID: t.ID, Hash: hash, Input: in, Status: "pending", Reason: "等待用户审批"}
		op.ID, err = randomUUID()
		if err != nil {
			return nil, err
		}
		switch in.Kind {
		case "update", "move", "trash":
			id := agentPathDocumentID(in.Path)
			if id == "" {
				return nil, fmt.Errorf("操作 %q 的 path 必须是 search_documents 或 get_document 返回的完整文档路径: %w", in.Key, errAgentInput)
			}
			if in.ExpectedRevision < 1 {
				return nil, fmt.Errorf("操作 %q 缺少有效的 expectedRevision；请复制 get_document 返回的 revision。update、move 和 trash 操作都必须携带该版本号: %w", in.Key, errAgentInput)
			}
			var before agentSnapshot
			var readChars int
			if err = tx.QueryRow(ctx, `SELECT snapshot,read_chars FROM agent_document_reads WHERE task_id=$1 AND doc_id=$2`, t.ID, id).Scan(&before, &readChars); err != nil {
				return nil, errors.New("请先调用 get_document 读取目标文档")
			}
			if in.Kind == "update" && readChars < utf8.RuneCountInString(before.Document.Content) {
				return nil, fmt.Errorf("正文未读取完整，请调用 get_document 从 offset %d 继续读取后再提交修改", readChars)
			}
			if before.Document.Revision != in.ExpectedRevision {
				return nil, errDocumentRevisionConflict
			}
			op.Before = &before
			fresh, e := a.loadAgentSnapshot(ctx, tx, user.ID, id)
			if e != nil {
				return nil, e
			}
			if fresh.Document.Revision != in.ExpectedRevision || fresh.FolderID != before.FolderID {
				return nil, errDocumentRevisionConflict
			}
			if previous, ok := lastDocumentOperation[in.Path]; ok {
				if previous.Input.ExpectedRevision != in.ExpectedRevision {
					return nil, errDocumentRevisionConflict
				}
				projected, e := agentSnapshotAfter(previous)
				if e != nil {
					return nil, e
				}
				op.Before = &projected
			}
		case "delete_folder":
			if deletedFolders[in.Path] {
				return nil, errAgentInput
			}
			deletedFolders[in.Path] = true
			op.Before, err = a.loadEmptyAgentFolder(ctx, tx, user.ID, in)
			if err != nil {
				return nil, err
			}
		case "create", "folder":
			op.Input.TargetID, err = randomUUID()
			if err != nil {
				return nil, err
			}
		default:
			return nil, errAgentInput
		}
		if in.Kind == "update" || in.Kind == "create" {
			if strings.TrimSpace(in.Title) == "" || utf8.RuneCountInString(in.Title) > 200 {
				return nil, errAgentInput
			}
		}
		if in.Kind == "folder" {
			if _, err = validateFolderName(in.Title); err != nil {
				return nil, err
			}
		}
		if in.FolderID != "" {
			var exists bool
			err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM folders WHERE folder_id=$1 AND user_id=$2) OR EXISTS(SELECT 1 FROM agent_operations WHERE task_id=$3 AND input->>'kind'='folder' AND input->>'targetId'=$1 AND status='pending')`, in.FolderID, user.ID, t.ID).Scan(&exists)
			if err != nil {
				return nil, err
			}
			if !exists {
				return nil, errors.New("目标文件夹不可用")
			}
		}
		if !agentOperationMinor(op) {
			allMinor = false
		}
		inputJSON, _ := json.Marshal(op.Input)
		var beforeJSON []byte
		if op.Before != nil {
			beforeJSON, _ = json.Marshal(op.Before)
		}
		err = tx.QueryRow(ctx, `INSERT INTO agent_operations(id,task_id,user_id,request_key,input_hash,input,before_state,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING created_at`, op.ID, t.ID, user.ID, in.Key, hash, inputJSON, beforeJSON, op.Reason).Scan(&op.CreatedAt)
		if err != nil {
			return nil, err
		}
		ops = append(ops, op)
		if op.Before != nil && op.Before.Folder == nil {
			lastDocumentOperation[in.Path] = op
		}
		newIDs[op.ID] = true
	}
	var previousCount int
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM agent_operations WHERE task_id=$1`, t.ID).Scan(&previousCount); err != nil {
		return nil, err
	}
	if previousCount > 40 {
		return nil, errors.New("本轮最多处理 40 项改动，请分批执行")
	}
	// Assist only automates a single small change; large/fragmented batches stay reviewable.
	auto := !advice && (s.Permission == "full" || (s.Permission == "assist" && allMinor && previousCount == 1))
	updates := []documentUpdateResult{}
	for i := range ops {
		if !auto || !newIDs[ops[i].ID] {
			continue
		}
		approval := "full"
		reason := "用户已完全授权本会话"
		if s.Permission == "assist" {
			approval = "agent"
			reason = "Agent 判断为轻微修正或无覆盖草稿，已通过执行校验"
		}
		update, e := a.applyAgentOperationTx(ctx, tx, user, &ops[i], approval, reason)
		if e != nil {
			return nil, e
		}
		if update != nil {
			updates = append(updates, *update)
		}
	}
	if err = a.checkAgentTaskBudget(ctx, tx, user, current.ID); err != nil {
		return nil, err
	}
	if len(newIDs) > 0 {
		// Auto-applied operations leave active/pending counts unchanged. Publish
		// their activity in the same transaction so other chats refresh immediately.
		// Identical retries must not continually invalidate clients' caches.
		if _, err = tx.Exec(ctx, `UPDATE agent_sessions SET updated_at=clock_timestamp() WHERE id=$1`, s.ID); err != nil {
			return nil, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	for _, u := range updates {
		a.finishDocumentUpdate(ctx, user, u)
	}
	for _, o := range ops {
		if newIDs[o.ID] && o.Status == "applied" && o.Input.Kind == "create" {
			a.recordProductMilestone(ctx, user.ID, milestoneFirstDocument)
			a.cancelPendingImageDeletions(ctx, userRef{ID: user.ID, AuthUserID: user.AuthUserID}, o.Input.Content)
		}
	}
	return ops, nil
}

func (a *App) applyAgentOperationTx(ctx context.Context, tx pgx.Tx, user model.User, o *agentOperation, approval, reason string) (*documentUpdateResult, error) {
	article, err := checkStoredArticleOperation(ctx, tx, user.ID, o)
	if err != nil {
		return nil, err
	}
	if o.Status != "pending" {
		return nil, errAgentSessionConflict
	}
	in := o.Input
	expectedRevision := in.ExpectedRevision
	result := agentOperationResult{}
	var update *documentUpdateResult
	var folder *int
	if in.FolderID != "" {
		var id int
		if err := tx.QueryRow(ctx, `SELECT id FROM folders WHERE folder_id=$1 AND user_id=$2`, in.FolderID, user.ID).Scan(&id); err != nil {
			return nil, err
		}
		folder = &id
	}
	if o.Before != nil && o.Before.Folder == nil {
		if o.Before.DependsOn != "" {
			previous, err := scanAgentOperation(tx.QueryRow(ctx, `SELECT `+agentOperationColumns+` FROM agent_operations WHERE id=$1 AND task_id=$2 AND user_id=$3`, o.Before.DependsOn, o.TaskID, user.ID))
			if err != nil {
				return nil, err
			}
			if previous.Status != "applied" || previous.Result == nil {
				return nil, fmt.Errorf("请先批准本组的前置操作；已拒绝或撤销的前置操作需要重新生成提案: %w", errAgentSessionConflict)
			}
			expectedRevision = o.Before.Document.Revision
			if previous.Result.DocID != o.Before.Document.DocID || previous.Result.Revision != expectedRevision || previous.Result.FolderID != o.Before.FolderID {
				return nil, errDocumentRevisionConflict
			}
		}
		fresh, err := a.loadAgentSnapshot(ctx, tx, user.ID, o.Before.Document.DocID)
		if err != nil {
			return nil, err
		}
		// Article proposals replace only title and Markdown. A metadata save
		// can advance the revision without invalidating the diff the user saw.
		if article && o.Before.DependsOn == "" && fresh.Document.Title == o.Before.Document.Title && fresh.Document.Content == o.Before.Document.Content {
			expectedRevision = fresh.Document.Revision
			o.Before.Document.Theme = fresh.Document.Theme
		}
		if fresh.Document.Revision != expectedRevision || fresh.FolderID != o.Before.FolderID {
			return nil, errDocumentRevisionConflict
		}
		// Capture the actual order immediately before each write. Projected batch
		// snapshots cannot know the destination order chosen by a preceding move.
		o.Before.SortOrder = fresh.SortOrder
		result = agentOperationResult{DocID: fresh.Document.DocID, Revision: fresh.Document.Revision, Path: fresh.Path, FolderID: fresh.FolderID}
	}
	switch in.Kind {
	case "delete_folder":
		var err error
		result, err = a.deleteAgentFolderTx(ctx, tx, user.ID, o)
		if err != nil {
			return nil, err
		}
	case "update":
		r, err := a.updateDocumentTx(ctx, tx, updateDocumentParams{User: user, DocID: result.DocID, Title: in.Title, Content: in.Content, Theme: o.Before.Document.Theme, ExpectedRevision: expectedRevision, Source: documentSourceAgent, ForceVersion: true})
		if err != nil {
			return nil, err
		}
		update = &r
		result.Revision = r.Document.Revision
	case "create":
		// Explicitly reject overwriting a same-title document in the destination.
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM documents WHERE user_id=$1 AND title=$2 AND folder_id IS NOT DISTINCT FROM $3::integer AND trashed_at IS NULL)`, user.ID, in.Title, folder).Scan(&exists); err != nil {
			return nil, err
		}
		if exists {
			return nil, errors.New("目标文件夹已有同名文章，请使用不同标题")
		}
		doc, err := a.createDocumentTx(ctx, tx, createDocumentParams{User: user, DocID: in.TargetID, Title: in.Title, Content: in.Content, FolderID: &in.FolderID})
		if err != nil {
			return nil, err
		}
		result = agentOperationResult{DocID: doc.DocID, Revision: doc.Revision, FolderID: in.FolderID, Path: agentDocumentPath(doc.DocID)}
	case "move":
		if err := tx.QueryRow(ctx, `UPDATE documents SET folder_id=$3,sort_order=COALESCE((SELECT MAX(sort_order)+1 FROM documents WHERE user_id=$2 AND folder_id IS NOT DISTINCT FROM $3::integer AND trashed_at IS NULL),0),revision=revision+1,updated_at=now() WHERE doc_id=$1 AND user_id=$2 AND revision=$4 AND trashed_at IS NULL RETURNING revision,sort_order`, result.DocID, user.ID, folder, expectedRevision).Scan(&result.Revision, &result.SortOrder); err != nil {
			return nil, err
		}
		result.FolderID = in.FolderID
	case "trash":
		d, err := trashDocumentTx(ctx, tx, user, result.DocID, expectedRevision)
		if err != nil {
			return nil, err
		}
		result.Revision = d.Revision
	case "folder":
		if folder != nil {
			depth, err := a.folderDepthTx(ctx, tx, *folder)
			if err != nil {
				return nil, err
			}
			if depth+1 > maxFolderDepth {
				return nil, errors.New("文件夹层级过深")
			}
		}
		var exists bool
		if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM folders WHERE user_id=$1 AND name=$2 AND parent_id IS NOT DISTINCT FROM $3::integer)`, user.ID, in.Title, folder).Scan(&exists); err != nil {
			return nil, err
		}
		if exists {
			return nil, errors.New("目标位置已有同名文件夹")
		}
		if _, err := tx.Exec(ctx, `INSERT INTO folders(folder_id,user_id,name,parent_id) VALUES($1,$2,$3,$4)`, in.TargetID, user.ID, in.Title, folder); err != nil {
			return nil, err
		}
		result.FolderID = in.TargetID
	default:
		return nil, errAgentInput
	}
	o.Status = "applied"
	o.Approval = approval
	o.Reason = reason
	o.Result = &result
	data, _ := json.Marshal(result)
	var beforeJSON []byte
	if o.Before != nil {
		beforeJSON, _ = json.Marshal(o.Before)
	}
	_, err = tx.Exec(ctx, `UPDATE agent_operations SET status='applied',approval=$2,reason=$3,result=$4,before_state=$5,updated_at=now() WHERE id=$1`, o.ID, approval, reason, data, beforeJSON)
	return update, err
}

func (a *App) agentOperationAction(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	var in struct {
		Hash string `json:"hash"`
	}
	id := r.PathValue("operationId")
	action := r.PathValue("action")
	if decodeJSONBody(r, &in) != nil || !validUUID(id) || (action != "approve" && action != "reject" && action != "undo") {
		agentError(w, errAgentInput)
		return
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		agentError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	if _, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock($1)`, user.ID); err != nil {
		agentError(w, err)
		return
	}
	o, err := scanAgentOperation(tx.QueryRow(r.Context(), `SELECT `+agentOperationColumns+` FROM agent_operations WHERE id=$1 AND user_id=$2 FOR UPDATE`, id, user.ID))
	if err != nil {
		agentError(w, err)
		return
	}
	if o.Hash != in.Hash {
		agentError(w, errAgentSessionConflict)
		return
	}
	// Successful identical replay must remain successful even if the task was later stopped.
	if (action == "approve" && o.Status == "applied") || (action == "undo" && o.Status == "undone") || (action == "reject" && o.Status == "rejected") {
		httpx.JSON(w, 200, map[string]any{"operation": o})
		return
	}
	var sessionID string
	if err = tx.QueryRow(r.Context(), `SELECT session_id::text FROM writing_agent_tasks WHERE id=$1`, o.TaskID).Scan(&sessionID); err != nil {
		agentError(w, err)
		return
	}
	if _, err = a.loadAgentSession(r.Context(), tx, sessionID, user.ID); err != nil {
		agentError(w, err)
		return
	}
	var update *documentUpdateResult
	switch action {
	case "approve":
		if _, _, err = a.lockAgentTask(r.Context(), tx, user.ID, o.TaskID, false); err == nil {
			update, err = a.applyAgentOperationTx(r.Context(), tx, user, &o, "user", "用户批准")
		}
	case "reject":
		if o.Status != "pending" {
			err = errAgentSessionConflict
			break
		}
		o.Status = "rejected"
		_, err = tx.Exec(r.Context(), `UPDATE agent_operations SET status='rejected',approval='user',updated_at=now() WHERE id=$1`, o.ID)
	case "undo":
		update, err = a.undoAgentOperationTx(r.Context(), tx, user, &o)
	}
	if err == nil && action == "approve" {
		// Completed tasks may have used the reserved final-answer headroom.
		// Rejecting an operation must also remain possible at the storage limit.
		err = a.checkAgentTaskStorageLimit(r.Context(), tx, user, o.TaskID, agentTaskStorageBudget)
	}
	if err == nil {
		_, err = tx.Exec(r.Context(), `UPDATE writing_agent_tasks SET next_poll_at=now() WHERE id=$1`, o.TaskID)
	}
	if err == nil {
		_, err = tx.Exec(r.Context(), `UPDATE agent_sessions SET updated_at=now() WHERE id=$1`, sessionID)
	}
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		agentError(w, err)
		return
	}
	if update != nil {
		a.finishDocumentUpdate(r.Context(), user, *update)
	}
	if action == "approve" && o.Input.Kind == "create" {
		a.recordProductMilestone(r.Context(), user.ID, milestoneFirstDocument)
		a.cancelPendingImageDeletions(r.Context(), userRef{ID: user.ID, AuthUserID: user.AuthUserID}, o.Input.Content)
	}
	httpx.JSON(w, 200, map[string]any{"operation": o})
}

func (a *App) undoAgentOperationTx(ctx context.Context, tx pgx.Tx, user model.User, o *agentOperation) (*documentUpdateResult, error) {
	article, err := checkStoredArticleOperation(ctx, tx, user.ID, o)
	if err != nil {
		return nil, err
	}
	if o.Status != "applied" || o.Result == nil {
		return nil, errAgentSessionConflict
	}
	var update *documentUpdateResult
	result := *o.Result
	if o.Input.Kind == "delete_folder" {
		if err := a.restoreAgentFolderTx(ctx, tx, user.ID, o); err != nil {
			return nil, err
		}
	} else if o.Input.Kind == "folder" {
		if err := undoCreatedAgentFolder(ctx, tx, user.ID, o); err != nil {
			return nil, err
		}
	} else {
		var revision int64
		var sortOrder int64
		var trashed bool
		var folderID string
		if err := tx.QueryRow(ctx, `SELECT d.revision,d.trashed_at IS NOT NULL,COALESCE(f.folder_id,''),d.sort_order FROM documents d LEFT JOIN folders f ON f.id=d.folder_id WHERE d.doc_id=$1 AND d.user_id=$2 FOR UPDATE OF d`, result.DocID, user.ID).Scan(&revision, &trashed, &folderID, &sortOrder); err != nil {
			return nil, err
		}
		if folderID != result.FolderID {
			return nil, errDocumentRevisionConflict
		}
		var appliedChild, restoredByChild bool
		if err := tx.QueryRow(ctx, `SELECT
 EXISTS(SELECT 1 FROM agent_operations WHERE task_id=$1 AND user_id=$2 AND before_state->>'dependsOn'=$3 AND status='applied'),
 EXISTS(SELECT 1 FROM agent_operations WHERE task_id=$1 AND user_id=$2 AND before_state->>'dependsOn'=$3 AND status='undone'
 AND before_state->'document'->>'docId'=$4 AND before_state->'document'->'revision'=to_jsonb($5::bigint)
 AND before_state->>'folderId'=$6 AND result->'undoRevision'=to_jsonb($7::bigint))`, o.TaskID, user.ID, o.ID, result.DocID, result.Revision, result.FolderID, revision).Scan(&appliedChild, &restoredByChild); err != nil {
			return nil, err
		}
		// Undo children first, including no-op edits. Only an undo in this exact
		// dependency chain can explain a newer revision; unrelated edits still conflict.
		updateTheme := ""
		if o.Input.Kind == "update" {
			updateTheme = o.Before.Document.Theme
		}
		articleTextMatches := false
		if article && !trashed && o.Before.DependsOn == "" {
			current, err := a.loadAgentSnapshot(ctx, tx, user.ID, result.DocID)
			if err != nil {
				return nil, err
			}
			articleTextMatches = current.Document.Title == o.Input.Title && current.Document.Content == o.Input.Content
			updateTheme = current.Document.Theme
		}
		if appliedChild || (revision != result.Revision && !restoredByChild && !articleTextMatches) {
			return nil, errDocumentRevisionConflict
		}
		switch o.Input.Kind {
		case "update":
			before := o.Before.Document
			r, err := a.updateDocumentTx(ctx, tx, updateDocumentParams{User: user, DocID: result.DocID, Title: before.Title, Content: before.Content, Theme: updateTheme, ExpectedRevision: revision, Source: documentSourceRestore, ForceVersion: true})
			if err != nil {
				return nil, err
			}
			update = &r
			result.UndoRevision = r.Document.Revision
		case "create":
			doc, err := trashDocumentTx(ctx, tx, user, result.DocID, revision)
			if err != nil {
				return nil, err
			}
			result.UndoRevision = doc.Revision
		case "trash":
			if !trashed {
				return nil, errDocumentRevisionConflict
			}
			if err := tx.QueryRow(ctx, `UPDATE documents SET trashed_at=NULL,revision=revision+1,updated_at=now() WHERE doc_id=$1 AND user_id=$2 RETURNING revision`, result.DocID, user.ID).Scan(&result.UndoRevision); err != nil {
				return nil, err
			}
		case "move":
			if trashed || (result.SortOrder != nil && sortOrder != *result.SortOrder) {
				return nil, errDocumentRevisionConflict
			}
			var parent *int
			if o.Before.FolderID != "" {
				var id int
				if err := tx.QueryRow(ctx, `SELECT id FROM folders WHERE folder_id=$1 AND user_id=$2`, o.Before.FolderID, user.ID).Scan(&id); err != nil {
					return nil, err
				}
				parent = &id
			}
			if err := tx.QueryRow(ctx, `UPDATE documents SET folder_id=$3,sort_order=COALESCE($4::bigint,sort_order),revision=revision+1,updated_at=now() WHERE doc_id=$1 AND user_id=$2 RETURNING revision`, result.DocID, user.ID, parent, o.Before.SortOrder).Scan(&result.UndoRevision); err != nil {
				return nil, err
			}
		default:
			return nil, errAgentInput
		}
	}
	o.Status = "undone"
	o.Result = &result
	data, _ := json.Marshal(result)
	_, err = tx.Exec(ctx, `UPDATE agent_operations SET status='undone',result=$2,updated_at=now() WHERE id=$1`, o.ID, data)
	return update, err
}
