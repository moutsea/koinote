package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type writingMCPContext struct{}

func (a *App) writingMCP() http.Handler {
	handler := mcp.NewStreamableHTTPHandler(func(r *http.Request) *mcp.Server {
		s := mcp.NewServer(&mcp.Implementation{Name: "koinote-writing", Version: "1.0.0"}, nil)
		if task, ok := r.Context().Value(writingMCPContext{}).(writingTask); ok && task.Conversation {
			a.addAgentConversationTools(s)
			return s
		}
		mcp.AddTool(s, &mcp.Tool{Name: "get_document", Description: "Read this task's authorized document snapshot. Call with {} for the first page: omit docId to select the bound document automatically. Use offset and limit for additional pages. The response supplies the actual docId and revision required for a proposal.", Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true}}, a.writingReadDocument)
		mcp.AddTool(s, &mcp.Tool{Name: "propose_document_change", Description: "Save a complete proposed Markdown revision for human review. This does not modify the article. Submit exactly one final proposal after research; content must contain the complete article, not a patch."}, a.writingProposeDocument)
		return s
	}, &mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.PathValue("taskId")
		if !validUUID(id) || !hmac.Equal([]byte(bearerToken(r)), []byte(a.writingSecret(id, "mcp"))) {
			http.Error(w, "unauthorized", 401)
			return
		}
		t, err := scanWritingTask(a.db.QueryRow(r.Context(), `SELECT `+writingTaskColumns+` FROM writing_agent_tasks WHERE id=$1`, id))
		if err != nil || writingTerminal(t.Status) || t.CancelRequested || time.Now().After(t.Deadline) {
			http.Error(w, "task authorization expired", 403)
			return
		}
		var allowed bool
		if t.Conversation {
			err = a.db.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM users u JOIN agent_sessions s ON s.user_id=u.id WHERE u.id=$1 AND u.membership_tier='lifetime' AND s.id=$2 AND s.deleted_at IS NULL)`, t.UserID, t.SessionID).Scan(&allowed)
		} else {
			err = a.db.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM users u JOIN documents d ON d.user_id=u.id WHERE u.id=$1 AND u.membership_tier='lifetime' AND d.doc_id=$2 AND d.trashed_at IS NULL)`, t.UserID, t.Source.DocID).Scan(&allowed)
		}
		if err != nil || !allowed {
			http.Error(w, "document unavailable", 403)
			return
		}
		if !a.rateLimit().allow("writing-mcp:"+id, 120, time.Minute) {
			http.Error(w, "rate limit exceeded", 429)
			return
		}
		serveLimitedMCP(handler, w, r.WithContext(context.WithValue(r.Context(), writingMCPContext{}, t)), mcpMaxRequestBytes)
	})
}

type writingReadInput struct {
	DocID  string `json:"docId,omitempty" jsonschema:"Omit this field to read the task's document. If supplied, copy the exact docId returned by get_document. A tool name or its hash suffix is not a document ID."`
	Offset int    `json:"offset,omitempty" jsonschema:"Character offset. Omit for the first page; use nextOffset from the prior result for subsequent pages."`
	Limit  int    `json:"limit,omitempty" jsonschema:"Maximum characters to return, from 1 to 40000. Defaults to 12000."`
}
type writingReadOutput struct {
	DocID      string `json:"docId"`
	Title      string `json:"title"`
	Revision   int64  `json:"revision"`
	Content    string `json:"content"`
	NextOffset int    `json:"nextOffset"`
	HasMore    bool   `json:"hasMore"`
}

func (a *App) writingReadDocument(ctx context.Context, _ *mcp.CallToolRequest, in writingReadInput) (*mcp.CallToolResult, writingReadOutput, error) {
	t := ctx.Value(writingMCPContext{}).(writingTask)
	if in.DocID != "" && in.DocID != t.Source.DocID {
		return nil, writingReadOutput{}, errors.New("document is outside this task's scope; call get_document with {} (omit docId) to read the authorized document and obtain its actual ID")
	}
	chars := []rune(t.Source.Content)
	limit := in.Limit
	if limit == 0 {
		limit = 12000
	}
	if in.Offset < 0 || in.Offset > len(chars) || limit < 1 || limit > 40000 {
		return nil, writingReadOutput{}, errors.New("invalid document range")
	}
	end := min(len(chars), in.Offset+limit)
	return nil, writingReadOutput{DocID: t.Source.DocID, Title: t.Source.Title, Revision: t.Source.Revision, Content: string(chars[in.Offset:end]), NextOffset: end, HasMore: end < len(chars)}, nil
}

type writingProposalInput struct {
	Proof            *agentIntentProof `json:"_agentTaskProof,omitempty"`
	DocID            string            `json:"docId" jsonschema:"Copy the exact docId returned by get_document. Do not use a tool name or its hash suffix."`
	ExpectedRevision int64             `json:"expectedRevision" jsonschema:"Copy the revision returned by get_document. This is the source revision being edited."`
	Title            string            `json:"title"`
	Content          string            `json:"content"`
	Explanation      string            `json:"explanation"`
}

func (a *App) writingProposeDocument(ctx context.Context, _ *mcp.CallToolRequest, in writingProposalInput) (*mcp.CallToolResult, map[string]any, error) {
	t := ctx.Value(writingMCPContext{}).(writingTask)
	if t.Conversation {
		ops, err := a.proposeAgentOperations(ctx, t, agentProposalOperations(in), agentIntentAuthorization{ToolName: "propose_document_change", Proof: in.Proof})
		if err != nil {
			return nil, nil, err
		}
		return nil, map[string]any{"status": ops[0].Status, "operationId": ops[0].ID, "operations": []map[string]any{agentOperationSummary(ops[0])}, "operationResults": agentIntentReceipts(t, ops)}, nil
	}
	if in.DocID != t.Source.DocID || in.ExpectedRevision != t.Source.Revision {
		return nil, nil, errors.New("document or revision does not match the task")
	}
	if strings.TrimSpace(in.Title) == "" || utf8.RuneCountInString(in.Title) > 200 || len(in.Content) > 512<<10 || len(in.Explanation) > 8000 || strings.TrimSpace(in.Content) == "" {
		return nil, nil, errors.New("invalid proposed article")
	}
	raw, _ := json.Marshal(in)
	digest := sha256.Sum256(raw)
	proposal := writingProposal{Title: in.Title, Content: in.Content, Explanation: in.Explanation, Revision: in.ExpectedRevision, Hash: hex.EncodeToString(digest[:])}
	data, _ := json.Marshal(proposal)
	user, err := a.agentUser(ctx, t.UserID)
	if err != nil {
		return nil, nil, err
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, nil, err
	}
	defer tx.Rollback(ctx)
	if _, _, err = a.lockAgentTask(ctx, tx, t.UserID, t.ID, true); err != nil {
		return nil, nil, err
	}
	// Immutable once submitted; a retry must carry the same proposal.
	tag, err := tx.Exec(ctx, `UPDATE writing_agent_tasks SET proposal=$2,updated_at=now() WHERE id=$1 AND status NOT IN ('completed','failed','cancelled') AND NOT cancel_requested AND deadline>now() AND (proposal IS NULL OR proposal->>'hash'=$3)`, t.ID, data, proposal.Hash)
	if err != nil {
		return nil, nil, err
	}
	if tag.RowsAffected() != 1 {
		return nil, nil, errors.New("a different proposal exists or this task has stopped")
	}
	// Also covers tasks created before output reservations were introduced.
	if err = a.checkAgentTaskBudget(ctx, tx, user, t.ID); err != nil {
		return nil, nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, nil, err
	}
	return nil, map[string]any{"status": "awaiting_user_confirmation", "proposalHash": proposal.Hash}, nil
}

func (a *App) writingWebhook(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("taskId")
	if !validUUID(id) {
		http.NotFound(w, r)
		return
	}
	raw, err := readWritingCallback(r)
	if err != nil {
		http.Error(w, "invalid callback", 400)
		return
	}
	if !verifyWritingCallback(a.writingSecret(id, "callback"), r.Header.Get("X-Agent-Timestamp"), r.Header.Get("X-Agent-Signature"), raw, time.Now()) {
		http.Error(w, "unauthorized", 401)
		return
	}
	var event struct {
		JobID       string `json:"jobId"`
		WorkspaceID string `json:"workspaceId"`
	}
	delivery := r.Header.Get("X-Agent-Delivery")
	if json.Unmarshal(raw, &event) != nil || delivery == "" || len(delivery) > 200 {
		http.Error(w, "invalid callback", 400)
		return
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		http.Error(w, "unavailable", 503)
		return
	}
	defer tx.Rollback(r.Context())
	var workspace, job string
	err = tx.QueryRow(r.Context(), `SELECT workspace_id,job_id FROM writing_agent_tasks WHERE id=$1`, id).Scan(&workspace, &job)
	if errors.Is(err, pgx.ErrNoRows) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		http.Error(w, "unavailable", 503)
		return
	}
	// A callback can arrive before the enqueue response; retry until its job id is durable.
	if job == "" {
		http.Error(w, "submission pending", 503)
		return
	}
	if workspace != event.WorkspaceID || job != event.JobID {
		http.Error(w, "wrong task", 403)
		return
	}
	_, err = tx.Exec(r.Context(), `INSERT INTO writing_agent_deliveries(task_id,delivery_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, id, delivery)
	if err == nil {
		_, err = tx.Exec(r.Context(), `UPDATE writing_agent_tasks SET next_poll_at=now() WHERE id=$1`, id)
	}
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		http.Error(w, "unavailable", 503)
		return
	}
	// Reconcile from the authoritative Job endpoint; callbacks never write articles or charge.
	w.WriteHeader(204)
}
