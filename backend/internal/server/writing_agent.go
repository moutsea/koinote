package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"koinote/backend/internal/httpx"
	"koinote/backend/internal/model"
)

const writingReservationCredits = int64(100)

type writingSource struct {
	Path     string `json:"path,omitempty"`
	DocID    string `json:"docId"`
	Title    string `json:"title"`
	Content  string `json:"content"`
	Theme    string `json:"theme"`
	Revision int64  `json:"revision"`
}
type writingProposal struct {
	Title       string `json:"title"`
	Content     string `json:"content"`
	Explanation string `json:"explanation"`
	Revision    int64  `json:"revision"`
	Hash        string `json:"hash"`
}

// Only these fields are needed to render a task. The stored continuation
// contains private evidence and model output used by prepareAgentIntentInput.
type writingIntentSummary struct {
	Outcome      string `json:"outcome"`
	InputVersion int64  `json:"inputVersion"`
	Question     string `json:"question,omitempty"`
	Reason       string `json:"reason,omitempty"`
	Reply        string `json:"reply,omitempty"`
}

type writingLoadedSkill struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Loaded string `json:"loadedAt"`
}

type writingTask struct {
	CoverEnabled    bool                  `json:"-"`
	CoverGeneration *agentCoverState      `json:"coverGeneration,omitempty"`
	LoadedSkills    []writingLoadedSkill  `json:"loadedSkills,omitempty"`
	SkillSnapshot   json.RawMessage       `json:"-"`
	IntentVersion   int64                 `json:"intentVersion,omitempty"`
	IntentState     json.RawMessage       `json:"-"`
	IntentResult    json.RawMessage       `json:"-"`
	TaskIntent      *writingIntentSummary `json:"taskIntent,omitempty"`
	Conversation    bool                  `json:"conversation"`
	SessionID       string                `json:"sessionId,omitempty"`
	ID              string                `json:"id"`
	UserID          int                   `json:"-"`
	Message         string                `json:"message"`
	Source          writingSource         `json:"source"`
	Skill           json.RawMessage       `json:"-"`
	WorkspaceID     string                `json:"-"`
	JobID           string                `json:"-"`
	RemoteInput     json.RawMessage       `json:"-"`
	Status          string                `json:"status"`
	Result          string                `json:"result"`
	Error           string                `json:"error"`
	Proposal        *writingProposal      `json:"proposal"`
	AppliedDocument *model.Document       `json:"appliedDocument"`
	ReservationID   string                `json:"-"`
	ReservedCredits int64                 `json:"reservedCredits"`
	ChargedCredits  int64                 `json:"chargedCredits"`
	Usage           json.RawMessage       `json:"usage"`
	BillingStatus   string                `json:"billingStatus"`
	Cursor          int64                 `json:"cursor"`
	CancelRequested bool                  `json:"cancelRequested"`
	Deadline        time.Time             `json:"deadline"`
	CreatedAt       time.Time             `json:"createdAt"`
}

const writingTaskColumns = `id::text,user_id,message,source,skill,skill_snapshot,workspace_id,job_id,remote_input,status,result,error,proposal,applied_document,reservation_id,reserved_credits,charged_credits,usage,billing_status,cursor,cancel_requested,deadline,created_at,COALESCE(session_id::text,''),conversation_task,intent_version,intent_state,intent_result,cover_enabled,(SELECT jsonb_build_object('status',g.status,'errorCode',g.error_code) FROM agent_cover_generations g WHERE g.task_id=writing_agent_tasks.id)`

const writingResultClipped = "\n结果过长，已保存前文；请缩小范围继续。"

func writingDisplayResult(text string) string {
	if len(text) <= 128<<10 {
		return text
	}
	runes := []rune(text)
	return string(runes[:min(len(runes), 32000)]) + writingResultClipped
}

func scanWritingTask(row pgx.Row) (writingTask, error) {
	var t writingTask
	err := row.Scan(&t.ID, &t.UserID, &t.Message, &t.Source, &t.Skill, &t.SkillSnapshot, &t.WorkspaceID, &t.JobID, &t.RemoteInput, &t.Status, &t.Result, &t.Error, &t.Proposal, &t.AppliedDocument, &t.ReservationID, &t.ReservedCredits, &t.ChargedCredits, &t.Usage, &t.BillingStatus, &t.Cursor, &t.CancelRequested, &t.Deadline, &t.CreatedAt, &t.SessionID, &t.Conversation, &t.IntentVersion, &t.IntentState, &t.IntentResult, &t.CoverEnabled, &t.CoverGeneration)
	if t.CoverGeneration != nil && t.CoverGeneration.Status == "completed" {
		t.CoverGeneration.ChargedCredits = wechatCoverGenerationCredits
	} else if t.CoverGeneration != nil && writingTerminal(t.Status) && t.CoverGeneration.Status == "generating" {
		// A finished/cancelled task can no longer commit an in-flight image.
		t.CoverGeneration.Status = "failed"
		t.CoverGeneration.ErrorCode = "generation_failed"
	}
	if t.SessionID != "" {
		t.Result = writingDisplayResult(t.Result)
	}
	if err == nil && len(t.IntentResult) != 0 {
		var result struct {
			writingIntentSummary
			ModelOutput string `json:"modelOutput"`
		}
		if json.Unmarshal(t.IntentResult, &result) == nil && result.Outcome != "" {
			summary := result.writingIntentSummary
			// Only project the final reviewed reply, never the private continuation
			// or an upstream field that merely claims to be public.
			summary.Reply = ""
			if (summary.Outcome == "operations_reported" || summary.Outcome == "partial") && strings.TrimSpace(result.ModelOutput) != "" {
				summary.Reply = writingDisplayResult(redactAgentReply(result.ModelOutput))
			}
			switch summary.Reason {
			case "step_limit", "tool_limit", "no_progress":
			default:
				summary.Reason = ""
			}
			if summary.Question != "" {
				// Clarification results carry the user-visible (redacted) question.
				summary.Question = t.Result
			}
			t.TaskIntent = &summary
		}
	}
	return t, err
}
func writingTerminal(s string) bool { return s == "completed" || s == "failed" || s == "cancelled" }
func (a *App) loadWritingTask(ctx context.Context, id string, userID int) (writingTask, error) {
	if !validUUID(id) {
		return writingTask{}, pgx.ErrNoRows
	}
	t, err := scanWritingTask(a.db.QueryRow(ctx, `SELECT `+writingTaskColumns+` FROM writing_agent_tasks WHERE id=$1 AND user_id=$2 AND (session_id IS NULL OR EXISTS(SELECT 1 FROM agent_sessions WHERE id=session_id AND deleted_at IS NULL))`, id, userID))
	if err == nil {
		t.LoadedSkills, err = a.loadWritingLoadedSkills(ctx, id)
	}
	return t, err
}
func writingError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, pgx.ErrNoRows), errors.Is(err, errDocumentNotFound):
		httpx.ErrorCode(w, 404, "not_found", "Task or document not found")
	case errors.Is(err, errInsufficientCredits):
		httpx.ErrorCode(w, 402, "insufficient_credits", "Not enough credits")
	case errors.Is(err, errDocumentRevisionConflict):
		httpx.ErrorCode(w, 409, "revision_conflict", "The document changed; start a new task from the latest version")
	case errors.Is(err, errDocumentQuotaExceeded):
		httpx.ErrorCode(w, 409, "storage_quota_exceeded", "云端空间不足，请清理会话或扩容后重试")
	default:
		log.Printf("writing agent: %v", err)
		httpx.ErrorCode(w, 500, "writing_agent_error", "Writing task could not be processed")
	}
}
func (a *App) writingConfig(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	discoverRepositories := true
	if a.koiSkillAccountAllowed(user.AuthUserID) {
		settings, err := a.koiSettingsForUser(r.Context(), user.ID)
		if err != nil {
			writingError(w, err)
			return
		}
		discoverRepositories = settings.LibraryMode == "legacy" && settings.AutoSkills
	}
	rows, err := a.db.Query(r.Context(), `SELECT w.id,w.name,f.path FROM agent_workspaces w JOIN agent_workspace_files f ON f.workspace_id=w.id WHERE w.user_id=$1 AND $2::boolean AND w.deleted_at IS NULL AND (f.path='SKILL.md' OR f.path LIKE '%/SKILL.md') ORDER BY w.name,f.path LIMIT 200`, user.ID, discoverRepositories)
	if err != nil {
		writingError(w, err)
		return
	}
	defer rows.Close()
	type skillOption struct {
		RepositoryID int64  `json:"repositoryId"`
		Name         string `json:"name"`
		Path         string `json:"path"`
	}
	skills := []skillOption{}
	for rows.Next() {
		var skill skillOption
		if err = rows.Scan(&skill.RepositoryID, &skill.Name, &skill.Path); err != nil {
			writingError(w, err)
			return
		}
		skills = append(skills, skill)
	}
	if err = rows.Err(); err != nil {
		writingError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, 200, map[string]any{"enabled": a.writingEnabled(), "reservedCredits": writingReservationCredits, "skills": skills, "maxMinutes": 20})
}
func (a *App) writingTasksList(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	rows, err := a.db.Query(r.Context(), `SELECT id::text,message,status,created_at FROM writing_agent_tasks WHERE user_id=$1 AND doc_id=$2 ORDER BY created_at DESC LIMIT 20`, user.ID, r.URL.Query().Get("docId"))
	if err != nil {
		writingError(w, err)
		return
	}
	defer rows.Close()
	type summary struct {
		ID        string    `json:"id"`
		Message   string    `json:"message"`
		Status    string    `json:"status"`
		CreatedAt time.Time `json:"createdAt"`
	}
	tasks := []summary{}
	for rows.Next() {
		var t summary
		if err = rows.Scan(&t.ID, &t.Message, &t.Status, &t.CreatedAt); err != nil {
			writingError(w, err)
			return
		}
		tasks = append(tasks, t)
	}
	if err = rows.Err(); err != nil {
		writingError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, 200, map[string]any{"tasks": tasks})
}

type writingCreateInput struct {
	RequestID         string `json:"requestId"`
	DocID             string `json:"docId"`
	ExpectedRevision  int64  `json:"expectedRevision"`
	Message           string `json:"message"`
	SkillRepositoryID int64  `json:"skillRepositoryId"`
	SkillPath         string `json:"skillPath"`
}

func (a *App) writingTaskCreate(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	if !a.writingEnabled() {
		httpx.ErrorCode(w, 503, "writing_agent_unavailable", "Writing Agent is not configured")
		return
	}
	var in writingCreateInput
	if err := decodeJSONBody(r, &in); err != nil || !validUUID(in.RequestID) || !validUUID(in.DocID) || in.ExpectedRevision < 1 || utf8.RuneCountInString(strings.TrimSpace(in.Message)) < 1 || len(in.Message) > 16000 {
		httpx.ErrorCode(w, 400, "bad_request", "Invalid writing task")
		return
	}
	raw, _ := json.Marshal(in)
	h := sha256.Sum256(raw)
	hash := hex.EncodeToString(h[:])
	// Check replay before rereading the document: a successful apply changes its revision.
	var existingID, existingHash string
	err := a.db.QueryRow(r.Context(), `SELECT id::text,input_hash FROM writing_agent_tasks WHERE user_id=$1 AND request_key=$2`, user.ID, in.RequestID).Scan(&existingID, &existingHash)
	if err == nil {
		if existingHash != hash {
			httpx.ErrorCode(w, 409, "idempotency_conflict", "Request id was used with different input")
			return
		}
		t, e := a.loadWritingTask(r.Context(), existingID, user.ID)
		if e != nil {
			writingError(w, e)
			return
		}
		httpx.JSON(w, 200, map[string]any{"task": t})
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		writingError(w, err)
		return
	}
	doc, err := a.loadAgentReviewDocument(r.Context(), user.ID, in.DocID)
	if err != nil {
		writingError(w, err)
		return
	}
	if doc.Revision != in.ExpectedRevision {
		writingError(w, errDocumentRevisionConflict)
		return
	}
	if len(doc.Content) > 512<<10 {
		httpx.ErrorCode(w, 413, "document_too_large", "Writing tasks support documents up to 512 KiB")
		return
	}
	skill, err := a.writingSkill(r.Context(), user.ID, in.SkillRepositoryID, in.SkillPath)
	if err != nil {
		httpx.ErrorCode(w, 400, "skill_unavailable", "Skill is unavailable or incompatible; use an owned repository with SKILL.md")
		return
	}
	source, _ := json.Marshal(writingSource{Path: agentDocumentPath(doc.DocID), DocID: doc.DocID, Title: doc.Title, Content: doc.Content, Theme: doc.Theme, Revision: doc.Revision})
	taskID, err := randomUUID()
	if err != nil {
		writingError(w, err)
		return
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		writingError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	// Share the same storage lock and lock order as conversation tasks, document
	// writes, image uploads and settlement: user -> credit account -> task.
	if _, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock($1)`, user.ID); err != nil {
		writingError(w, err)
		return
	}
	balance, err := lockCreditAccount(r.Context(), tx, user.ID)
	if err != nil {
		writingError(w, err)
		return
	}
	balance, err = releaseExpiredCreditReservationsForUser(r.Context(), tx, user.ID, balance)
	if err != nil {
		writingError(w, err)
		return
	}
	// Serialize concurrent requests on the account, then repeat the replay check.
	err = tx.QueryRow(r.Context(), `SELECT id::text,input_hash FROM writing_agent_tasks WHERE user_id=$1 AND request_key=$2`, user.ID, in.RequestID).Scan(&existingID, &existingHash)
	if err == nil {
		tx.Rollback(r.Context())
		if hash != existingHash {
			httpx.ErrorCode(w, 409, "idempotency_conflict", "Request input differs")
			return
		}
		t, e := a.loadWritingTask(r.Context(), existingID, user.ID)
		if e != nil {
			writingError(w, e)
			return
		}
		httpx.JSON(w, 200, map[string]any{"task": t})
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		writingError(w, err)
		return
	}
	// Receipt recovery above retains its frozen payload. A new legacy-format
	// request must not restore a repository Skill after migration or disablement.
	if (in.SkillRepositoryID != 0 || in.SkillPath != "") && a.koiSkillAccountAllowed(user.AuthUserID) {
		settings, modeErr := a.resolveKoiLibraryMode(r.Context(), tx, user.ID)
		if modeErr != nil {
			writingError(w, modeErr)
			return
		}
		if settings.LibraryMode != "legacy" || !settings.AutoSkills {
			httpx.ErrorCode(w, 400, "skill_unavailable", "Repository Skill selection is no longer available; use Koi AI in the current editor")
			return
		}
	}
	var active int
	err = tx.QueryRow(r.Context(), `SELECT count(*) FROM writing_agent_tasks WHERE user_id=$1 AND status NOT IN ('completed','failed','cancelled')`, user.ID).Scan(&active)
	if err != nil {
		writingError(w, err)
		return
	}
	if active >= 2 {
		httpx.ErrorCode(w, 429, "writing_agent_busy", "At most two writing tasks can run at once")
		return
	}
	if balance.Available < writingReservationCredits {
		writingError(w, errInsufficientCredits)
		return
	}
	_, err = tx.Exec(r.Context(), `INSERT INTO credit_reservations(reservation_id,user_id,reserved_credits,status,expires_at) VALUES($1,$2,$3,'active',now()+interval '30 minutes')`, taskID, user.ID, writingReservationCredits)
	if err == nil {
		_, err = tx.Exec(r.Context(), `UPDATE credit_accounts SET reserved=reserved+$2,updated_at=now() WHERE user_id=$1`, user.ID, writingReservationCredits)
	}
	if err == nil {
		_, err = tx.Exec(r.Context(), `INSERT INTO agent_sessions(id,user_id,title) VALUES($1,$2,$3)`, taskID, user.ID, string([]rune(in.Message)[:min(40, len([]rune(in.Message)))]))
	}
	if err == nil {
		_, err = tx.Exec(r.Context(), `INSERT INTO writing_agent_tasks(id,user_id,doc_id,request_key,input_hash,message,source,skill,reservation_id,reserved_credits,deadline,session_id,storage_budget_bytes) VALUES($1::uuid,$2,$3,$4,$5,$6,$7,$8,$1::text,$9,now()+interval '20 minutes',$1::uuid,$10)`, taskID, user.ID, in.DocID, in.RequestID, hash, in.Message, source, skill, writingReservationCredits, agentTaskStorageBudget)
	}
	if err == nil {
		err = a.checkAgentStorage(r.Context(), tx, user)
	}
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		writingError(w, err)
		return
	}
	a.notifyWritingAgent()
	t, err := a.loadWritingTask(r.Context(), taskID, user.ID)
	if err != nil {
		writingError(w, err)
		return
	}
	httpx.JSON(w, 202, map[string]any{"task": t})
}
func (a *App) writingTaskGet(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	t, err := a.loadWritingTask(r.Context(), r.PathValue("taskId"), user.ID)
	if err != nil {
		writingError(w, err)
		return
	}
	rows, err := a.db.Query(r.Context(), `SELECT seq,event FROM writing_agent_events WHERE task_id=$1 AND event->>'type' NOT IN ('model.delta','model.started','context.budget') ORDER BY seq DESC LIMIT 100`, t.ID)
	if err != nil {
		writingError(w, err)
		return
	}
	defer rows.Close()
	type event struct {
		Seq   int64           `json:"seq"`
		Event json.RawMessage `json:"event"`
	}
	events := []event{}
	for rows.Next() {
		var e event
		if err = rows.Scan(&e.Seq, &e.Event); err != nil {
			writingError(w, err)
			return
		}
		// Keep full events in storage for reconciliation; send only progress metadata.
		var progress struct {
			Type     string `json:"type"`
			ToolCall *struct {
				Name string `json:"name"`
			} `json:"toolCall,omitempty"`
			ToolName string `json:"toolName,omitempty"`
			Error    string `json:"error,omitempty"`
		}
		if json.Unmarshal(e.Event, &progress) == nil {
			if t.Conversation {
				// Older workers could retain raw diagnostics when an event changed shape.
				progress.Error = ""
			}
			e.Event, _ = json.Marshal(progress)
			events = append(events, e)
		}
	}
	if err = rows.Err(); err != nil {
		writingError(w, err)
		return
	}
	// Progress polling does not need a repeated article snapshot until a diff exists.
	if t.Proposal == nil {
		t.Source.Content = ""
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.JSON(w, 200, map[string]any{"task": t, "events": events})
}
func (a *App) writingTaskCancel(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	t, err := a.loadWritingTask(r.Context(), r.PathValue("taskId"), user.ID)
	if err != nil {
		writingError(w, err)
		return
	}
	if t.SessionID != "" {
		err = a.cancelAgentTask(r.Context(), user.ID, t.ID)
		if err != nil {
			agentError(w, err)
			return
		}
		httpx.JSON(w, 202, map[string]bool{"accepted": true})
		return
	}
	_, err = a.db.Exec(r.Context(), `UPDATE writing_agent_tasks SET cancel_requested=true,next_poll_at=now() WHERE id=$1 AND status NOT IN ('completed','failed','cancelled')`, t.ID)
	if err != nil {
		writingError(w, err)
		return
	}
	a.notifyWritingAgent()
	httpx.JSON(w, 202, map[string]bool{"accepted": true})
}

func (a *App) writingTaskApply(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	var in struct {
		ExpectedRevision int64  `json:"expectedRevision"`
		ProposalHash     string `json:"proposalHash"`
	}
	if decodeJSONBody(r, &in) != nil || !validUUID(r.PathValue("taskId")) {
		httpx.ErrorCode(w, 400, "bad_request", "Invalid proposal")
		return
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		writingError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	// Match document mutation's user-lock ordering before taking the task row lock.
	_, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock($1)`, user.ID)
	if err != nil {
		writingError(w, err)
		return
	}
	t, err := scanWritingTask(tx.QueryRow(r.Context(), `SELECT `+writingTaskColumns+` FROM writing_agent_tasks WHERE id=$1 AND user_id=$2 FOR UPDATE`, r.PathValue("taskId"), user.ID))
	if err != nil {
		writingError(w, err)
		return
	}
	if t.CancelRequested || t.Status != "completed" || t.Proposal == nil || in.ProposalHash != t.Proposal.Hash {
		httpx.ErrorCode(w, 409, "proposal_not_ready", "This proposal is not ready")
		return
	}
	if t.AppliedDocument != nil {
		tx.Rollback(r.Context())
		r.SetPathValue("docId", t.Source.DocID)
		a.documentGet(w, r)
		return
	}
	if in.ExpectedRevision != t.Source.Revision {
		writingError(w, errDocumentRevisionConflict)
		return
	}
	var currentRevision int64
	err = tx.QueryRow(r.Context(), `SELECT revision FROM documents WHERE user_id=$1 AND doc_id=$2 AND trashed_at IS NULL FOR UPDATE`, user.ID, t.Source.DocID).Scan(&currentRevision)
	if err != nil {
		writingError(w, err)
		return
	}
	if currentRevision != t.Source.Revision {
		writingError(w, errDocumentRevisionConflict)
		return
	}
	result, err := a.updateDocumentTx(r.Context(), tx, updateDocumentParams{User: user, DocID: t.Source.DocID, Title: t.Proposal.Title, Content: t.Proposal.Content, Theme: t.Source.Theme, ExpectedRevision: t.Source.Revision, Source: documentSourceAgent, ForceVersion: true})
	if err != nil {
		writingError(w, err)
		return
	}
	data, _ := json.Marshal(result.Document)
	_, err = tx.Exec(r.Context(), `UPDATE writing_agent_tasks SET applied_document=$2,updated_at=now() WHERE id=$1`, t.ID, data)
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		writingError(w, err)
		return
	}
	a.finishDocumentUpdate(r.Context(), user, result)
	httpx.JSON(w, 200, map[string]any{"document": result.Document})
}

func (a *App) writingExternalID(userID int) string {
	if a.agentGPTTestExternalID != "" {
		return a.agentGPTTestExternalID
	}
	namespace := a.cfg.AgentGPTUserNamespace
	if namespace == "" {
		namespace = "koinote"
	}
	return fmt.Sprintf("%s:%d", namespace, userID)
}
