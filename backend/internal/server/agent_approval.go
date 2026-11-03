package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"koinote/backend/internal/httpx"
)

type agentApprovalInput struct {
	OperationIDs []string `json:"operationIds"`
}

func agentApprovalMeta() mcp.Meta {
	meta := agentIntentMeta("guarded")
	meta["agent-gpt/approval"] = map[string]any{"version": 1, "resolveTool": "get_operation_results"}
	return meta
}

func agentOperationsResponse(t writingTask, ops []agentOperation) map[string]any {
	summaries := make([]map[string]any, 0, len(ops))
	for _, op := range ops {
		summaries = append(summaries, agentOperationSummary(op))
	}
	return map[string]any{"operations": summaries, "operationResults": agentIntentReceipts(t, ops)}
}

func (a *App) agentOperationResults(ctx context.Context, _ *mcp.CallToolRequest, in agentApprovalInput) (*mcp.CallToolResult, map[string]any, error) {
	t := ctx.Value(writingMCPContext{}).(writingTask)
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, nil, err
	}
	defer tx.Rollback(ctx)
	if _, _, err = a.lockAgentTask(ctx, tx, t.UserID, t.ID, true); err != nil {
		return nil, nil, err
	}
	ops, err := loadAgentApprovalOperations(ctx, tx, t, in.OperationIDs)
	if err != nil {
		return nil, nil, err
	}
	return nil, agentOperationsResponse(t, ops), nil
}

func loadAgentApprovalOperations(ctx context.Context, tx pgx.Tx, t writingTask, ids []string) ([]agentOperation, error) {
	if len(ids) == 0 || len(ids) > 40 {
		return nil, errAgentInput
	}
	seen := map[string]bool{}
	ops := make([]agentOperation, 0, len(ids))
	for _, id := range ids {
		if !validUUID(id) || seen[id] {
			return nil, errAgentInput
		}
		seen[id] = true
		op, err := scanAgentOperation(tx.QueryRow(ctx, `SELECT `+agentOperationColumns+` FROM agent_operations WHERE id=$1 AND task_id=$2 AND user_id=$3`, id, t.ID, t.UserID))
		if err != nil {
			return nil, err
		}
		ops = append(ops, op)
	}
	return orderAgentOperations(ops)
}

// Approve exactly the displayed snapshot, atomically. New proposals arriving
// after the request are not implicitly approved. Retries never repeat writes.
func (a *App) agentOperationBatchAction(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	var in struct {
		Operations []struct {
			ID   string `json:"id"`
			Hash string `json:"hash"`
		} `json:"operations"`
	}
	action, taskID := r.PathValue("action"), r.PathValue("taskId")
	if decodeJSONBody(r, &in) != nil || !validUUID(taskID) || (action != "approve" && action != "reject" && action != "undo") || len(in.Operations) == 0 || len(in.Operations) > 40 {
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
	t, err := scanWritingTask(tx.QueryRow(r.Context(), `SELECT `+writingTaskColumns+` FROM writing_agent_tasks WHERE id=$1 AND user_id=$2 FOR UPDATE`, taskID, user.ID))
	if err != nil {
		agentError(w, err)
		return
	}
	if _, err = a.loadAgentSession(r.Context(), tx, t.SessionID, user.ID); err != nil {
		agentError(w, err)
		return
	}
	ids, hashes := []string{}, map[string]string{}
	for _, item := range in.Operations {
		ids = append(ids, item.ID)
		hashes[item.ID] = item.Hash
	}
	ops, err := loadAgentApprovalOperations(r.Context(), tx, t, ids)
	if err != nil {
		agentError(w, err)
		return
	}
	if action == "undo" {
		folderOperations := make(map[string]string, len(ops))
		for _, op := range ops {
			if op.Input.Kind != "delete_folder" || op.Before == nil || op.Before.Folder == nil {
				agentError(w, errAgentInput)
				return
			}
			folderOperations[op.Before.Folder.ID] = op.ID
		}
		ops, err = orderDependentAgentOperations(ops, func(op agentOperation) string {
			return folderOperations[op.Before.Folder.ParentID]
		})
		if err != nil {
			agentError(w, err)
			return
		}
	}
	updates := []documentUpdateResult{}
	applied := []agentOperation{}
	for i := range ops {
		op := &ops[i]
		if op.Hash != hashes[op.ID] {
			agentError(w, errAgentSessionConflict)
			return
		}
		if action == "undo" {
			if op.Status == "undone" {
				continue
			}
			if _, e := a.undoAgentOperationTx(r.Context(), tx, user, op); e != nil {
				agentError(w, e)
				return
			}
			continue
		}
		if action == "approve" && op.Status == "applied" || action == "reject" && op.Status == "rejected" {
			continue
		}
		if op.Status != "pending" || t.CancelRequested {
			agentError(w, errAgentSessionConflict)
			return
		}
		if action == "approve" {
			update, e := a.applyAgentOperationTx(r.Context(), tx, user, op, "user", "用户批量批准")
			if e != nil {
				agentError(w, e)
				return
			}
			if update != nil {
				updates = append(updates, *update)
			}
			applied = append(applied, *op)
		} else {
			op.Status, op.Approval = "rejected", "user"
			if _, err = tx.Exec(r.Context(), `UPDATE agent_operations SET status='rejected',approval='user',updated_at=now() WHERE id=$1`, op.ID); err != nil {
				agentError(w, err)
				return
			}
		}
	}
	if action == "approve" {
		if err = a.checkAgentTaskStorageLimit(r.Context(), tx, user, taskID, agentTaskStorageBudget); err != nil {
			agentError(w, err)
			return
		}
	}
	if _, err = tx.Exec(r.Context(), `UPDATE writing_agent_tasks SET next_poll_at=now() WHERE id=$1`, taskID); err == nil {
		_, err = tx.Exec(r.Context(), `UPDATE agent_sessions SET updated_at=clock_timestamp() WHERE id=$1`, t.SessionID)
	}
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		agentError(w, err)
		return
	}
	for _, update := range updates {
		a.finishDocumentUpdate(r.Context(), user, update)
	}
	for _, op := range applied {
		if op.Input.Kind == "create" {
			a.recordProductMilestone(r.Context(), user.ID, milestoneFirstDocument)
			a.cancelPendingImageDeletions(r.Context(), userRef{ID: user.ID, AuthUserID: user.AuthUserID}, op.Input.Content)
		}
	}
	httpx.JSON(w, 200, map[string]any{"operations": ops})
}

type agentRemoteApproval struct {
	ToolName     string          `json:"toolName"`
	CheckpointID string          `json:"checkpointId"`
	ToolCallID   string          `json:"toolCallId"`
	ExpiresAt    time.Time       `json:"expiresAt"`
	Input        json.RawMessage `json:"input"`
}

// A durable outbox: only wake a known host checkpoint after every referenced
// operation has a user decision. No remote request is made inside a DB lock.
func (a *App) advanceAgentApproval(ctx context.Context, t *writingTask, job writingRemoteJob, jobPath string) error {
	approval := job.Approval
	if approval == nil || approval.ToolName != "host_operations" || approval.CheckpointID == "" || approval.ToolCallID == "" {
		return errors.New("unsupported remote approval")
	}
	var in struct {
		Version      int      `json:"version"`
		OperationIDs []string `json:"operationIds"`
	}
	if json.Unmarshal(approval.Input, &in) != nil || in.Version != 1 {
		return errAgentInput
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	current, _, err := a.lockAgentTask(ctx, tx, t.UserID, t.ID, true)
	if err != nil {
		return err
	}
	ops, err := loadAgentApprovalOperations(ctx, tx, current, in.OperationIDs)
	if err != nil {
		return err
	}
	pending := false
	for _, op := range ops {
		if op.Status == "pending" {
			pending = true
		}
	}
	canResume := false
	if !pending {
		canResume, err = agentExecutionSlotAvailable(ctx, tx, t.UserID, t.ID)
		if err != nil {
			return err
		}
	}
	var changed pgconn.CommandTag
	if !canResume {
		until := approval.ExpiresAt
		if until.IsZero() || until.After(time.Now().Add(24*time.Hour)) {
			until = time.Now().Add(24 * time.Hour)
		}
		if !until.After(time.Now()) {
			return errors.New("host approval expired")
		}
		// Persist the deadline once per checkpoint. Repeated polls never extend it.
		status, checkpoint := "awaiting_approval", approval.CheckpointID
		if !pending {
			status, checkpoint = "queued", "waiting-resume:"+approval.CheckpointID
		}
		changed, err = tx.Exec(ctx, `UPDATE writing_agent_tasks SET status=$2,
			deadline=CASE WHEN approval_checkpoint IN ($3,$4) THEN deadline ELSE $5 END,
			approval_checkpoint=$3,updated_at=now() WHERE id=$1 AND (status<>$2 OR approval_checkpoint<>$3)`,
			t.ID, status, checkpoint, approval.CheckpointID, until)
	} else {
		// A lost wake-up response is retryable, but retries must not keep the
		// execution authorization alive indefinitely.
		changed, err = tx.Exec(ctx, `UPDATE writing_agent_tasks SET status='queued',deadline=CASE WHEN approval_checkpoint<>$2 THEN now()+interval '20 minutes' ELSE deadline END,approval_checkpoint=$2,updated_at=now() WHERE id=$1 AND (status<>'queued' OR approval_checkpoint<>$2)`, t.ID, "resume:"+approval.CheckpointID)
	}
	if err == nil && changed.RowsAffected() > 0 {
		err = syncAgentReservationDeadline(ctx, tx, t.ID, t.UserID)
	}
	if err == nil && changed.RowsAffected() > 0 {
		_, err = tx.Exec(ctx, `UPDATE agent_sessions SET updated_at=clock_timestamp() WHERE id=$1`, t.SessionID)
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	if err != nil || !canResume {
		return err
	}
	var response struct {
		Approved bool `json:"approved"`
	}
	if err = a.agentGPTRequest(ctx, "POST", jobPath+"/approve-checkpoint", a.writingExternalID(t.UserID), "", map[string]any{"checkpointId": approval.CheckpointID, "toolCallId": approval.ToolCallID, "operationIds": in.OperationIDs}, &response); err != nil {
		return err
	}
	// A stale/duplicate wake-up must not overwrite the next checkpoint.
	if !response.Approved {
		return nil
	}
	_, err = a.db.Exec(ctx, `UPDATE writing_agent_tasks SET status='queued',next_poll_at=now(),updated_at=now() WHERE id=$1 AND approval_checkpoint=$2 AND status NOT IN ('completed','failed','cancelled') AND NOT cancel_requested`, t.ID, "resume:"+approval.CheckpointID)
	return err
}
