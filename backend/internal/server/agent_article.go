package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/jackc/pgx/v5"
	"koinote/backend/internal/httpx"
)

var errArticleWriteScope = fmt.Errorf("Koi AI 只能编辑当前文章的标题和正文，其他文档只可作为参考: %w", errAgentInput)

// The document is selected when the session is created. Neither later focus
// changes nor a model-supplied path can widen this authority.
func (a *App) articleAgentSession(w http.ResponseWriter, r *http.Request) {
	u, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	docID := r.PathValue("docId")
	if !validUUID(docID) {
		agentError(w, errAgentInput)
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
	var title, id string
	if err = tx.QueryRow(r.Context(), `SELECT title FROM documents WHERE user_id=$1 AND doc_id=$2 AND trashed_at IS NULL`, u.ID, docID).Scan(&title); err != nil {
		agentError(w, err)
		return
	}
	err = tx.QueryRow(r.Context(), `SELECT id::text FROM agent_sessions WHERE user_id=$1 AND write_document_id=$2 AND deleted_at IS NULL`, u.ID, docID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		id, err = randomUUID()
		if err == nil {
			_, err = tx.Exec(r.Context(), `INSERT INTO agent_sessions(id,user_id,title,permission,write_document_id) VALUES ($1,$2,left($3,100),'review',$4)`, id, u.ID, title, docID)
		}
		if err == nil {
			err = a.checkAgentStorage(r.Context(), tx, u)
		}
	}
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		agentError(w, err)
		return
	}
	r.SetPathValue("sessionId", id)
	a.agentSessionGet(w, r)
}

func checkArticleOperations(docID string, inputs []agentOperationInput) error {
	if docID == "" {
		return nil
	}
	for _, op := range inputs {
		if op.Kind != "update" || op.Path != agentDocumentPath(docID) || op.FolderID != "" || op.TargetID != "" {
			return errArticleWriteScope
		}
	}
	return nil
}

// Recheck the stored operation at both execution boundaries (single or batch,
// including undo). Its actual target comes from the snapshot/receipt.
func checkStoredArticleOperation(ctx context.Context, tx pgx.Tx, userID int, o *agentOperation) error {
	var docID string
	if err := tx.QueryRow(ctx, `SELECT COALESCE(s.write_document_id,'') FROM writing_agent_tasks t JOIN agent_sessions s ON s.id=t.session_id AND s.user_id=t.user_id WHERE t.id=$1 AND t.user_id=$2`, o.TaskID, userID).Scan(&docID); err != nil {
		return err
	}
	if docID == "" {
		return nil
	}
	if err := checkArticleOperations(docID, []agentOperationInput{o.Input}); err != nil {
		return err
	}
	if o.Before == nil || o.Before.Folder != nil || o.Before.Document.DocID != docID || (o.Result != nil && o.Result.DocID != docID) {
		return errArticleWriteScope
	}
	return nil
}

// Historical review records can still be read. Older clients cannot start
// another model run or reserve credits through the retired review endpoints.
func (a *App) retiredAgentReview(w http.ResponseWriter, r *http.Request) {
	if _, ok := a.requireLifetimeMember(w, r); !ok {
		return
	}
	httpx.ErrorCode(w, http.StatusGone, "agent_review_retired", "AI 优化已下线，请在编辑器打开 Koi AI 并输入指令。")
}
