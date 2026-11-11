package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"koinote/backend/internal/httpx"
	"koinote/backend/internal/model"
)

const agentTaskStorageBudget = int64(4 << 20)

type agentSession struct {
	WriteDocumentID   string    `json:"writeDocumentId,omitempty"`
	ChargedCredits    int64     `json:"chargedCredits"`
	ID                string    `json:"id"`
	Title             string    `json:"title"`
	Permission        string    `json:"permission"`
	Revision          int64     `json:"revision"`
	UpdatedAt         time.Time `json:"updatedAt"`
	UsedBytes         int64     `json:"usedBytes"`
	ActiveTasks       int       `json:"activeTasks"`
	PendingOperations int       `json:"pendingOperations"`
}

func validAgentPermission(s string) bool { return s == "review" || s == "assist" || s == "full" }
func agentDocumentPath(id string) string { return "/documents/" + id }
func agentPathDocumentID(path string) string {
	id := strings.TrimPrefix(path, "/documents/")
	if path == agentDocumentPath(id) && validUUID(id) {
		return id
	}
	return ""
}
func (a *App) agentUser(ctx context.Context, id int) (model.User, error) {
	var authID string
	if err := a.db.QueryRow(ctx, `SELECT auth_user_id FROM users WHERE id=$1`, id).Scan(&authID); err != nil {
		return model.User{}, err
	}
	u, err := a.getUserByAuthUserID(ctx, authID)
	if err == nil && u.MembershipTier != "lifetime" {
		err = errors.New("Agent membership unavailable")
	}
	return u, err
}
func agentError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errDocumentQuotaExceeded):
		httpx.ErrorCode(w, 409, "storage_quota_exceeded", "云端空间不足，请清理会话或扩容后重试")
	case errors.Is(err, errAgentSessionConflict):
		httpx.ErrorCode(w, 409, "agent_conflict", err.Error())
	case errors.Is(err, errAgentInput):
		httpx.ErrorCode(w, 400, "bad_request", err.Error())
	default:
		writingError(w, err)
	}
}

var errAgentSessionConflict = errors.New("会话或操作状态已变化，请刷新后重试")
var errAgentInput = errors.New("无效的 Agent 请求")

func (a *App) agentSettings(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	if r.Method == "PUT" {
		var in struct {
			Permission string `json:"permission"`
		}
		if decodeJSONBody(r, &in) != nil || !validAgentPermission(in.Permission) {
			agentError(w, errAgentInput)
			return
		}
		if _, err := a.db.Exec(r.Context(), `INSERT INTO agent_session_settings(user_id,permission) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET permission=EXCLUDED.permission`, u.ID, in.Permission); err != nil {
			agentError(w, err)
			return
		}
	}
	var permission string
	if err := a.db.QueryRow(r.Context(), `SELECT COALESCE((SELECT permission FROM agent_session_settings WHERE user_id=$1),'review')`, u.ID).Scan(&permission); err != nil {
		agentError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"permission": permission})
}

func (a *App) agentSessions(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	if r.Method == "POST" {
		var in struct {
			ID string `json:"id"`
		}
		if decodeJSONBody(r, &in) != nil || !validUUID(in.ID) {
			agentError(w, errAgentInput)
			return
		}
		tx, err := a.db.Begin(r.Context())
		if err != nil {
			agentError(w, err)
			return
		}
		defer tx.Rollback(r.Context())
		if _, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock($1)`, u.ID); err == nil {
			_, err = tx.Exec(r.Context(), `INSERT INTO agent_sessions(id,user_id,permission) VALUES($1,$2,COALESCE((SELECT permission FROM agent_session_settings WHERE user_id=$2),'review')) ON CONFLICT(id) DO NOTHING`, in.ID, u.ID)
		}
		if err == nil {
			err = a.checkAgentStorage(r.Context(), tx, u)
		}
		if err == nil {
			err = tx.Commit(r.Context())
		}
		if err != nil {
			agentError(w, err)
			return
		}
		r.SetPathValue("sessionId", in.ID)
		a.agentSessionGet(w, r)
		return
	}
	offset, limit, err := parseMCPPage(r.URL.Query().Get("cursor"), 50)
	if err != nil {
		agentError(w, errAgentInput)
		return
	}
	rows, err := a.db.Query(r.Context(), `SELECT s.id::text,s.title,s.permission,s.revision,s.updated_at,
 octet_length(s.title)+COALESCE(octet_length(s.intent_state::text),0)+COALESCE((SELECT SUM(agent_task_storage_bytes(t.id)) FROM writing_agent_tasks t WHERE t.session_id=s.id),0) AS used_bytes,
 (SELECT count(*) FROM writing_agent_tasks t WHERE t.session_id=s.id AND t.status NOT IN ('completed','failed','cancelled')),
 (SELECT count(*) FROM agent_operations o JOIN writing_agent_tasks t ON t.id=o.task_id WHERE t.session_id=s.id AND o.status='pending')
 +(SELECT count(*) FROM writing_agent_tasks t WHERE t.session_id=s.id AND t.status='completed' AND t.proposal IS NOT NULL AND t.applied_document IS NULL AND NOT t.cancel_requested)
 FROM agent_sessions s WHERE s.user_id=$1 AND s.write_document_id IS NULL AND s.deleted_at IS NULL AND strpos(lower(s.title),lower($2))>0 ORDER BY CASE WHEN $5::boolean THEN octet_length(s.title)+COALESCE(octet_length(s.intent_state::text),0)+COALESCE((SELECT SUM(agent_task_storage_bytes(t.id)) FROM writing_agent_tasks t WHERE t.session_id=s.id),0) ELSE 0 END DESC,s.updated_at DESC,s.id LIMIT $3 OFFSET $4`, u.ID, r.URL.Query().Get("q"), limit+1, offset, r.URL.Query().Get("sort") == "size")
	if err != nil {
		agentError(w, err)
		return
	}
	defer rows.Close()
	sessions := []agentSession{}
	for rows.Next() {
		var s agentSession
		if err = rows.Scan(&s.ID, &s.Title, &s.Permission, &s.Revision, &s.UpdatedAt, &s.UsedBytes, &s.ActiveTasks, &s.PendingOperations); err != nil {
			agentError(w, err)
			return
		}
		sessions = append(sessions, s)
	}
	if err = rows.Err(); err != nil {
		agentError(w, err)
		return
	}
	cursor := ""
	if len(sessions) > limit {
		sessions = sessions[:limit]
		cursor = encodeMCPCursor(offset + limit)
	}
	rows.Close()
	var running, pending int
	if err = a.db.QueryRow(r.Context(), `SELECT
 (SELECT count(*) FROM writing_agent_tasks t JOIN agent_sessions s ON s.id=t.session_id WHERE s.user_id=$1 AND s.write_document_id IS NULL AND s.deleted_at IS NULL AND t.status NOT IN('completed','failed','cancelled')),
 (SELECT count(*) FROM agent_operations o JOIN writing_agent_tasks t ON t.id=o.task_id JOIN agent_sessions s ON s.id=t.session_id WHERE s.user_id=$1 AND s.write_document_id IS NULL AND s.deleted_at IS NULL AND o.status='pending')
 +(SELECT count(*) FROM writing_agent_tasks t JOIN agent_sessions s ON s.id=t.session_id WHERE s.user_id=$1 AND s.write_document_id IS NULL AND s.deleted_at IS NULL AND t.status='completed' AND t.proposal IS NOT NULL AND t.applied_document IS NULL AND NOT t.cancel_requested)`, u.ID).Scan(&running, &pending); err != nil {
		agentError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, 200, map[string]any{"sessions": sessions, "nextCursor": cursor, "activity": map[string]int{"running": running, "pending": pending}})
}

func (a *App) loadAgentSession(ctx context.Context, q imageUsageQuerier, id string, userID int) (agentSession, error) {
	var s agentSession
	if !validUUID(id) {
		return s, pgx.ErrNoRows
	}
	err := q.QueryRow(ctx, `SELECT id::text,title,permission,revision,updated_at,COALESCE(write_document_id,'') FROM agent_sessions WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, id, userID).Scan(&s.ID, &s.Title, &s.Permission, &s.Revision, &s.UpdatedAt, &s.WriteDocumentID)
	return s, err
}

func (a *App) agentSessionGet(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	s, err := a.loadAgentSession(r.Context(), a.db, r.PathValue("sessionId"), u.ID)
	if err != nil {
		agentError(w, err)
		return
	}
	offset, limit, err := parseMCPPage(r.URL.Query().Get("cursor"), 20)
	if err != nil {
		agentError(w, errAgentInput)
		return
	}
	rows, err := a.db.Query(r.Context(), `SELECT `+writingTaskColumns+` FROM writing_agent_tasks WHERE session_id=$1 AND user_id=$2 ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4`, s.ID, u.ID, limit+1, offset)
	if err != nil {
		agentError(w, err)
		return
	}
	defer rows.Close()
	tasks := []writingTask{}
	for rows.Next() {
		t, e := scanWritingTask(rows)
		if e != nil {
			agentError(w, e)
			return
		}
		tasks = append(tasks, t)
	}
	if err = rows.Err(); err != nil {
		agentError(w, err)
		return
	}
	rows.Close()
	cursor := ""
	if len(tasks) > limit {
		tasks = tasks[:limit]
		cursor = encodeMCPCursor(offset + limit)
	}
	ids := []string{}
	for _, t := range tasks {
		ids = append(ids, t.ID)
	}
	loadedSkills, err := a.loadWritingLoadedSkillsForTasks(r.Context(), ids)
	if err != nil {
		agentError(w, err)
		return
	}
	for index := range tasks {
		tasks[index].LoadedSkills = loadedSkills[tasks[index].ID]
	}
	ops, err := a.loadAgentOperations(r.Context(), u.ID, ids)
	if err != nil {
		agentError(w, err)
		return
	}
	if err = a.db.QueryRow(r.Context(), `SELECT octet_length($2::text)+COALESCE((SELECT octet_length(intent_state::text) FROM agent_sessions WHERE id=$1),0)+COALESCE(SUM(agent_task_storage_bytes(id)),0),COALESCE(SUM(charged_credits),0) FROM writing_agent_tasks WHERE session_id=$1`, s.ID, s.Title).Scan(&s.UsedBytes, &s.ChargedCredits); err != nil {
		agentError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	artifactRows, err := a.db.Query(r.Context(), `SELECT id::text,task_id::text,name,mime_type,octet_length(data) FROM agent_artifacts WHERE user_id=$1 AND task_id=ANY($2::uuid[]) ORDER BY created_at`, u.ID, ids)
	if err != nil {
		agentError(w, err)
		return
	}
	defer artifactRows.Close()
	artifacts := []agentArtifact{}
	for artifactRows.Next() {
		var item agentArtifact
		if err = artifactRows.Scan(&item.ID, &item.TaskID, &item.Name, &item.MimeType, &item.Bytes); err != nil {
			agentError(w, err)
			return
		}
		artifacts = append(artifacts, item)
	}
	if err = artifactRows.Err(); err != nil {
		agentError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"session": s, "tasks": tasks, "operations": ops, "artifacts": artifacts, "nextCursor": cursor})
}

func (a *App) agentSessionUpdate(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	var in struct {
		Title      *string `json:"title"`
		Permission *string `json:"permission"`
		Revision   int64   `json:"revision"`
	}
	if decodeJSONBody(r, &in) != nil || !validUUID(r.PathValue("sessionId")) || in.Revision < 1 || (in.Title != nil && (strings.TrimSpace(*in.Title) == "" || utf8.RuneCountInString(*in.Title) > 100)) || (in.Permission != nil && !validAgentPermission(*in.Permission)) {
		agentError(w, errAgentInput)
		return
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		agentError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	if _, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock($1)`, u.ID); err == nil {
		var tag interface{ RowsAffected() int64 }
		tag, err = tx.Exec(r.Context(), `UPDATE agent_sessions SET title=COALESCE($4,title),permission=COALESCE($5,permission),revision=revision+1,updated_at=now() WHERE id=$1 AND user_id=$2 AND revision=$3 AND deleted_at IS NULL AND (write_document_id IS NULL OR COALESCE($5,permission)='review')`, r.PathValue("sessionId"), u.ID, in.Revision, in.Title, in.Permission)
		if err == nil && tag.RowsAffected() != 1 {
			err = errAgentSessionConflict
		}
	}
	if err == nil {
		err = a.checkAgentStorage(r.Context(), tx, u)
	}
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		agentError(w, err)
		return
	}
	a.agentSessionGet(w, r)
}

func (a *App) agentSessionDelete(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	if !validUUID(r.PathValue("sessionId")) {
		agentError(w, pgx.ErrNoRows)
		return
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		agentError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	if _, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock($1)`, u.ID); err != nil {
		agentError(w, err)
		return
	}
	if _, err = a.loadAgentSession(r.Context(), tx, r.PathValue("sessionId"), u.ID); err != nil {
		agentError(w, err)
		return
	}
	imageRows, err := tx.Query(r.Context(), `SELECT DISTINCT 'u/'||matches[1]||'/'||matches[2]||'.'||matches[3] FROM agent_session_image_contents CROSS JOIN LATERAL regexp_matches(content,$2,'g') AS matches WHERE session_id=$1`, r.PathValue("sessionId"), imageKeyPattern.String())
	if err != nil {
		agentError(w, err)
		return
	}
	imageKeys := []string{}
	for imageRows.Next() {
		var key string
		if err = imageRows.Scan(&key); err != nil {
			imageRows.Close()
			agentError(w, err)
			return
		}
		imageKeys = append(imageKeys, key)
	}
	err = imageRows.Err()
	imageRows.Close()
	if err != nil {
		agentError(w, err)
		return
	}
	for _, query := range []string{
		`UPDATE agent_sessions SET deleted_at=now(),intent_state=NULL,title='',revision=revision+1 WHERE id=$1`,
		`UPDATE writing_agent_tasks SET cancel_requested=true,storage_budget_bytes=0,intent_state=NULL,intent_result=NULL,message='',result='',source='{}',proposal=NULL,applied_document=NULL,skill='{}',remote_input=CASE WHEN job_id<>'' OR status IN('completed','failed','cancelled') THEN NULL ELSE remote_input END,next_poll_at=now() WHERE session_id=$1`,
		`DELETE FROM agent_document_reads WHERE task_id IN(SELECT id FROM writing_agent_tasks WHERE session_id=$1)`,
		`DELETE FROM koi_skill_loads WHERE task_id IN(SELECT id FROM writing_agent_tasks WHERE session_id=$1)`,
		`DELETE FROM agent_operations WHERE task_id IN(SELECT id FROM writing_agent_tasks WHERE session_id=$1)`,
		`DELETE FROM agent_artifacts WHERE task_id IN(SELECT id FROM writing_agent_tasks WHERE session_id=$1)`,
		`DELETE FROM writing_agent_events WHERE task_id IN(SELECT id FROM writing_agent_tasks WHERE session_id=$1)`,
	} {
		if _, err = tx.Exec(r.Context(), query, r.PathValue("sessionId")); err != nil {
			agentError(w, err)
			return
		}
	}
	if err = tx.Commit(r.Context()); err != nil {
		agentError(w, err)
		return
	}
	// Deleting a session cancels its unfinished task; let a worker settle it now.
	a.notifyWritingAgent()
	a.enqueueOrphanedImageKeys(r.Context(), userRef{ID: u.ID, AuthUserID: u.AuthUserID}, imageKeys)
	httpx.JSON(w, 200, map[string]bool{"deleted": true})
}

func (a *App) checkAgentStorage(ctx context.Context, tx pgx.Tx, u model.User) error {
	usage, err := storageUsageForQuerier(ctx, tx, u.ID)
	if err != nil {
		return err
	}
	if usage.Total() > a.storageQuotaFor(u) {
		return errDocumentQuotaExceeded
	}
	return nil
}

type agentTaskInput struct {
	RequestID string `json:"requestId"`
	Message   string `json:"message"`
	Context   *struct {
		Title string `json:"title"`
		Path  string `json:"path"`
	} `json:"context,omitempty"`
	SkillRepositoryID int64  `json:"skillRepositoryId"`
	SkillPath         string `json:"skillPath"`
	SupersedeTaskID   string `json:"supersedeTaskId,omitempty"`
}

func (a *App) agentTaskCreate(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	if !a.writingEnabled() {
		httpx.ErrorCode(w, 503, "writing_agent_unavailable", "Agent 服务尚未配置")
		return
	}
	var in agentTaskInput
	if decodeJSONBody(r, &in) != nil || !validUUID(in.RequestID) || !validUUID(r.PathValue("sessionId")) || strings.TrimSpace(in.Message) == "" || len(in.Message) > 16000 || (in.Context != nil && (agentPathDocumentID(in.Context.Path) == "" || len(in.Context.Title) > 1000)) || (in.SupersedeTaskID != "" && !validUUID(in.SupersedeTaskID)) {
		agentError(w, errAgentInput)
		return
	}
	raw, _ := json.Marshal(in)
	h := sha256.Sum256(append([]byte(r.PathValue("sessionId")+":"), raw...))
	hash := hex.EncodeToString(h[:])
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		agentError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	// Account storage -> credits -> task is the common ordering for all session writes.
	if _, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock($1)`, u.ID); err != nil {
		agentError(w, err)
		return
	}
	s, err := a.loadAgentSession(r.Context(), tx, r.PathValue("sessionId"), u.ID)
	if err != nil {
		agentError(w, err)
		return
	}
	var existingID, existingHash string
	err = tx.QueryRow(r.Context(), `SELECT id::text,input_hash FROM writing_agent_tasks WHERE user_id=$1 AND request_key=$2`, u.ID, in.RequestID).Scan(&existingID, &existingHash)
	if err == nil {
		if existingHash != hash {
			agentError(w, errAgentSessionConflict)
			return
		}
		tx.Rollback(r.Context())
		t, e := a.loadWritingTask(r.Context(), existingID, u.ID)
		if e != nil {
			agentError(w, e)
			return
		}
		httpx.JSON(w, 200, map[string]any{"task": t})
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		agentError(w, err)
		return
	}
	var busy bool
	if err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM writing_agent_tasks WHERE session_id=$1 AND status NOT IN('completed','failed','cancelled'))`, s.ID).Scan(&busy); err != nil {
		agentError(w, err)
		return
	}
	if busy {
		httpx.ErrorCode(w, 409, "agent_session_busy", "当前会话仍在执行，请等待或停止后发送")
		return
	}
	// Keep the original request fields/hash for old-window retries, but every
	// new conversation discovers optional Skills itself. Base rules are fixed.
	skill := json.RawMessage(`{"automaticDiscovery":true}`)
	source := writingSource{}
	if s.WriteDocumentID != "" {
		if in.Context != nil && agentPathDocumentID(in.Context.Path) != s.WriteDocumentID {
			agentError(w, errArticleWriteScope)
			return
		}
		source.DocID, source.Path = s.WriteDocumentID, agentDocumentPath(s.WriteDocumentID)
	} else if in.Context != nil {
		source.DocID, source.Path = agentPathDocumentID(in.Context.Path), in.Context.Path
	}
	if source.DocID != "" {
		if err = tx.QueryRow(r.Context(), `SELECT title FROM documents WHERE doc_id=$1 AND user_id=$2 AND trashed_at IS NULL`, source.DocID, u.ID).Scan(&source.Title); err != nil {
			agentError(w, err)
			return
		}
	}
	balance, err := lockCreditAccount(r.Context(), tx, u.ID)
	if err == nil {
		balance, err = releaseExpiredCreditReservationsForUser(r.Context(), tx, u.ID, balance)
	}
	if err != nil {
		agentError(w, err)
		return
	}
	if balance.Available < writingReservationCredits {
		agentError(w, errInsufficientCredits)
		return
	}
	taskID, err := randomUUID()
	if err != nil {
		agentError(w, err)
		return
	}
	sourceJSON, _ := json.Marshal(source)
	if _, err = tx.Exec(r.Context(), `INSERT INTO credit_reservations(reservation_id,user_id,reserved_credits,status,expires_at) VALUES($1,$2,$3,'active',now()+interval '24 hours 10 minutes')`, taskID, u.ID, writingReservationCredits); err != nil {
		agentError(w, err)
		return
	}
	if _, err = tx.Exec(r.Context(), `UPDATE credit_accounts SET reserved=reserved+$2,updated_at=now() WHERE user_id=$1`, u.ID, writingReservationCredits); err != nil {
		agentError(w, err)
		return
	}
	var intentVersion int64
	var intentState json.RawMessage
	if err = tx.QueryRow(r.Context(), `UPDATE agent_sessions SET intent_version=intent_version+1,intent_message_id=$2 WHERE id=$1 RETURNING intent_version,intent_state`, s.ID, agentUserMessageID(taskID)).Scan(&intentVersion, &intentState); err != nil {
		agentError(w, err)
		return
	}
	advice := agentAdviceOnly(in.Message)
	_, err = tx.Exec(r.Context(), `INSERT INTO writing_agent_tasks(id,user_id,doc_id,request_key,input_hash,message,source,skill,reservation_id,reserved_credits,deadline,session_id,storage_budget_bytes,permission_revision,advice_only,conversation_task,intent_version,intent_state) VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,$1::text,$9,now()+interval '24 hours',$10,$11,$12,$13,true,$14,$15)`, taskID, u.ID, source.DocID, in.RequestID, hash, in.Message, sourceJSON, skill, writingReservationCredits, s.ID, agentTaskStorageBudget, s.Revision, advice, intentVersion, intentState)
	if err == nil && s.WriteDocumentID == "" && a.koiSkillAccountAllowed(u.AuthUserID) {
		err = a.pinKoiTaskSkills(r.Context(), tx, u, taskID)
	}
	if err == nil && in.SupersedeTaskID != "" {
		_, err = tx.Exec(r.Context(), `UPDATE agent_operations SET status='superseded',updated_at=now() WHERE task_id IN(SELECT id FROM writing_agent_tasks WHERE id=$1 AND session_id=$2) AND status='pending'`, in.SupersedeTaskID, s.ID)
	}
	if err == nil {
		title := string([]rune(strings.TrimSpace(in.Message))[:min(40, len([]rune(strings.TrimSpace(in.Message))))])
		_, err = tx.Exec(r.Context(), `UPDATE agent_sessions SET revision=CASE WHEN title='新会话' THEN revision+1 ELSE revision END,title=CASE WHEN title='新会话' THEN $2 ELSE title END,updated_at=now() WHERE id=$1`, s.ID, title)
	}
	if err == nil {
		err = a.checkAgentStorage(r.Context(), tx, u)
	}
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		agentError(w, err)
		return
	}
	// Wake a worker now that the task is durably queued and visible to FOR UPDATE
	// SKIP LOCKED. The 2s ticker is only the crash-recovery backstop.
	a.notifyWritingAgent()
	t, err := a.loadWritingTask(r.Context(), taskID, u.ID)
	if err != nil {
		agentError(w, err)
		return
	}
	httpx.JSON(w, 202, map[string]any{"task": t})
}

func agentAdviceOnly(message string) bool {
	s := strings.ToLower(message)
	for _, p := range []string{"先别改", "暂时别改", "暂时不改", "先不要改", "不要修改", "只给建议", "先给建议", "不要执行", "don't change", "do not change", "do not modify", "suggestions only"} {
		if !strings.Contains(s, p) {
			continue
		}
		if p == "不要修改" {
			// A restriction on a named OTHER document is not an advice-only
			// request for the whole task. Keep the legacy global guard; the
			// intent protocol checks scoped restrictions against each real effect.
			for _, clause := range strings.FieldsFunc(s, func(r rune) bool { return strings.ContainsRune("，。；,;\n", r) }) {
				at := strings.Index(clause, p)
				if at < 0 {
					continue
				}
				prefix := strings.TrimSpace(clause[:at])
				if prefix == "" || prefix == "请" || prefix == "先" || prefix == "请先" || prefix == "暂时" || prefix == "都" || prefix == "全部" {
					return true
				}
			}
			continue
		}
		return true
	}
	return false
}

// Claim a user's execution slot before remote I/O. New chats beyond the limit
// remain queued, and retries reuse the same slot without starting another Job.
func (a *App) claimAgentDispatch(ctx context.Context, t *writingTask) (bool, error) {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, t.UserID); err != nil {
		return false, err
	}
	var started, cancelled bool
	if err = tx.QueryRow(ctx, `SELECT dispatch_started,cancel_requested FROM writing_agent_tasks WHERE id=$1 FOR UPDATE`, t.ID).Scan(&started, &cancelled); err != nil {
		return false, err
	}
	if cancelled {
		return false, nil
	}
	if started {
		return true, nil
	}
	free, err := agentExecutionSlotAvailable(ctx, tx, t.UserID, t.ID)
	if err != nil {
		return false, err
	}
	if !free {
		_, err = tx.Exec(ctx, `UPDATE writing_agent_tasks SET status='queued' WHERE id=$1`, t.ID)
		if err != nil {
			return false, err
		}
		return false, tx.Commit(ctx)
	}
	if err = tx.QueryRow(ctx, `UPDATE writing_agent_tasks SET dispatch_started=true,status='preparing',deadline=now()+interval '20 minutes' WHERE id=$1 RETURNING deadline`, t.ID).Scan(&t.Deadline); err != nil {
		return false, err
	}
	if err = syncAgentReservationDeadline(ctx, tx, t.ID, t.UserID); err != nil {
		return false, err
	}
	return true, tx.Commit(ctx)
}

// Call under the per-user transaction lock, both for first dispatch and wake-up.
// Only a confirmed host approval checkpoint releases its slot.
func agentExecutionSlotAvailable(ctx context.Context, tx pgx.Tx, userID int, taskID string) (bool, error) {
	var free bool
	err := tx.QueryRow(ctx, `SELECT count(*) < 2 FROM writing_agent_tasks
		WHERE user_id=$1 AND id<>$2 AND (dispatch_started OR job_id<>'')
		AND status NOT IN ('completed','failed','cancelled')
		AND NOT (status='awaiting_approval' AND approval_checkpoint<>''
		         AND approval_checkpoint NOT LIKE 'resume:%')
        AND NOT (status='queued' AND approval_checkpoint LIKE 'waiting-resume:%')`, userID, taskID).Scan(&free)
	return free, err
}

func syncAgentReservationDeadline(ctx context.Context, tx pgx.Tx, taskID string, userID int) error {
	_, err := tx.Exec(ctx, `UPDATE credit_reservations SET expires_at=(SELECT deadline+interval '10 minutes' FROM writing_agent_tasks WHERE id=$1::uuid)
		WHERE reservation_id=$1::text AND user_id=$2 AND status='active'`, taskID, userID)
	return err
}
