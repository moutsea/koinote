package server

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/jackc/pgx/v5"
	"koinote/backend/internal/model"
)

// GEO uses the same durable decisions, cancellation and undo records as article
// edits. Generated drafts are paid results; applying/rejecting/undoing never calls
// a model or charges again. No document body/revision is changed.
func (a *App) proposeAgentGeoTx(ctx context.Context, tx pgx.Tx, t writingTask, session agentSession, user model.User, doc model.Document, previous, next *wechatGeoSummaryView, key string) (agentOperation, error) {
	op := agentOperation{TaskID: t.ID, Status: "pending", Reason: "等待用户审批",
		Input:  agentOperationInput{Key: key, Kind: "wechat_geo", Path: agentDocumentPath(doc.DocID), ExpectedRevision: doc.Revision, Title: doc.Title, Geo: next},
		Before: &agentSnapshot{Document: model.Document{DocID: doc.DocID, Title: doc.Title, Revision: doc.Revision}, Path: agentDocumentPath(doc.DocID), Geo: previous, GeoSourceHash: wechatGeoSummaryFingerprint(doc.Title, doc.Content)}}
	op.Hash = publicationDigest(op.Input)
	var err error
	op.ID, err = randomUUID()
	if err != nil {
		return op, err
	}
	input, _ := json.Marshal(op.Input)
	before, _ := json.Marshal(op.Before)
	if err = tx.QueryRow(ctx, `INSERT INTO agent_operations(id,task_id,user_id,request_key,input_hash,input,before_state,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING created_at`, op.ID, t.ID, t.UserID, key, op.Hash, input, before, op.Reason).Scan(&op.CreatedAt); err != nil {
		return op, err
	}
	var count int
	var advice bool
	if err = tx.QueryRow(ctx, `SELECT (SELECT count(*) FROM agent_operations WHERE task_id=$1),advice_only FROM writing_agent_tasks WHERE id=$1`, t.ID).Scan(&count, &advice); err != nil {
		return op, err
	}
	if count > 40 {
		return op, errors.New("本轮最多处理 40 项改动，请分批执行")
	}
	if session.Permission == "full" && !advice {
		if _, err = a.applyAgentOperationTx(ctx, tx, user, &op, "full", "用户已完全授权本会话"); err != nil {
			return op, err
		}
	}
	if err = a.checkAgentTaskBudget(ctx, tx, user, t.ID); err != nil {
		return op, err
	}
	_, err = tx.Exec(ctx, `UPDATE agent_sessions SET updated_at=clock_timestamp() WHERE id=$1`, session.ID)
	return op, err
}

func (a *App) agentGeoOperationResult(ctx context.Context, t writingTask, op agentOperation) (agentGeoOutput, error) {
	out := agentGeoResult(op.Before.Document, op.Input.Geo, op.Status)
	out.Stale = op.Input.Geo.SourceHash != op.Before.GeoSourceHash
	out.Credits = op.Input.Geo.CreditsCharged
	response := agentOperationsResponse(t, []agentOperation{op})
	out.Operations = response["operations"].([]map[string]any)
	out.OperationResults = response["operationResults"].([]map[string]string)
	out.OperationStatus = "failed"
	if op.Status == "pending" {
		out.OperationStatus = "pending_approval"
	}
	if op.Status == "applied" {
		doc, _, view, err := a.loadAgentGeo(ctx, a.db, t, op.Input.Path, false)
		if err != nil {
			return out, err
		}
		out.Path, out.Revision, out.Geo, out.Stale = agentDocumentPath(doc.DocID), doc.Revision, view, view != nil && view.SourceHash != wechatGeoSummaryFingerprint(doc.Title, doc.Content)
		out.Status, out.OperationStatus = "saved", "applied"
	}
	return out, nil
}

func (a *App) applyAgentGeoOperationTx(ctx context.Context, tx pgx.Tx, userID int, op *agentOperation, undo bool) (agentOperationResult, error) {
	if op.Before == nil || op.Input.Geo == nil || op.Before.Document.DocID != agentPathDocumentID(op.Input.Path) {
		return agentOperationResult{}, errAgentInput
	}
	task := writingTask{ID: op.TaskID, UserID: userID}
	if err := tx.QueryRow(ctx, `SELECT session_id::text FROM writing_agent_tasks WHERE id=$1 AND user_id=$2`, op.TaskID, userID).Scan(&task.SessionID); err != nil {
		return agentOperationResult{}, err
	}
	doc, id, current, err := a.loadAgentGeo(ctx, tx, task, op.Input.Path, true)
	if err != nil {
		return agentOperationResult{}, err
	}
	if doc.Revision != op.Input.ExpectedRevision {
		return agentOperationResult{}, errDocumentRevisionConflict
	}
	next := op.Input.Geo
	if undo {
		if op.Result == nil || op.Result.GeoUpdatedAt == nil || current == nil || !current.UpdatedAt.Equal(*op.Result.GeoUpdatedAt) {
			return agentOperationResult{}, errDocumentRevisionConflict
		}
		next = op.Before.Geo
	} else if publicationDigest(current) != publicationDigest(op.Before.Geo) {
		return agentOperationResult{}, errDocumentRevisionConflict
	}
	var stamp time.Time
	if next == nil {
		_, err = tx.Exec(ctx, `DELETE FROM document_wechat_geo_summaries WHERE document_id=$1`, id)
	} else {
		topics, _ := json.Marshal(next.Topics)
		keywords, _ := json.Marshal(next.Keywords)
		err = tx.QueryRow(ctx, `INSERT INTO document_wechat_geo_summaries(document_id,rendered_text,summary,topics,keywords,source_hash,enabled,provider_mode,model)
 VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9)
 ON CONFLICT(document_id) DO UPDATE SET rendered_text=EXCLUDED.rendered_text,summary=EXCLUDED.summary,topics=EXCLUDED.topics,keywords=EXCLUDED.keywords,source_hash=EXCLUDED.source_hash,enabled=EXCLUDED.enabled,provider_mode=EXCLUDED.provider_mode,model=EXCLUDED.model,updated_at=clock_timestamp() RETURNING updated_at`, id, next.Text, next.Summary, topics, keywords, next.SourceHash, next.Enabled, next.ProviderMode, next.Model).Scan(&stamp)
	}
	return agentOperationResult{DocID: doc.DocID, Path: op.Input.Path, Revision: doc.Revision, GeoUpdatedAt: &stamp}, err
}
