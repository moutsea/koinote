package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"koinote/backend/internal/httpx"
)

// Public reads stay anonymous when no valid interactive session is present.
// MCP tokens never identify a viewer or gain account interaction permissions.
func (a *App) publicRepositoryViewerID(r *http.Request) (*int, error) {
	user, _, err := a.sessionUser(r)
	if _, invalid := err.(*sessionAuthError); invalid {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &user.ID, nil
}

type agentRepositoryEngagement struct {
	StarCount  int64 `json:"starCount"`
	Starred    bool  `json:"starred"`
	CloneCount int64 `json:"cloneCount"`
}

func loadAgentRepositoryEngagement(ctx context.Context, q agentWorkspaceQuerier, id int64, viewer *int) (agentRepositoryEngagement, error) {
	var result agentRepositoryEngagement
	err := q.QueryRow(ctx, `SELECT
 (SELECT COALESCE((SELECT star_count FROM agent_repository_stats WHERE workspace_id=$1),0)),
 EXISTS(SELECT 1 FROM agent_repository_stars WHERE workspace_id=$1 AND user_id=$2),
 (SELECT COALESCE((SELECT clone_count FROM agent_repository_stats WHERE workspace_id=$1),0))`, id, viewer).Scan(&result.StarCount, &result.Starred, &result.CloneCount)
	return result, err
}

func lockPublicAgentRepository(ctx context.Context, tx pgx.Tx, id int64) (int64, error) {
	// Match publish/Fork/delete lock order; withdrawal cannot race an interaction.
	var workspaceID, revision int64
	err := tx.QueryRow(ctx, `SELECT id FROM agent_workspaces WHERE id=$1 AND deleted_at IS NULL FOR SHARE`, id).Scan(&workspaceID)
	if err == nil {
		err = tx.QueryRow(ctx, `SELECT revision FROM agent_repository_publications WHERE workspace_id=$1 FOR SHARE`, id).Scan(&revision)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, errAgentWorkspaceNotFound
	}
	return revision, err
}

func (a *App) publicAgentRepositoryStar(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	id, ok := agentWorkspaceIDFromRequest(w, r)
	if !ok {
		return
	}
	if !a.rateLimit().allow("agent-repository-star:"+strconv.Itoa(user.ID), 60, time.Minute) {
		tooManyAttempts(w)
		return
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	if _, err = lockPublicAgentRepository(r.Context(), tx, id); err == nil {
		if r.Method == http.MethodPut {
			_, err = tx.Exec(r.Context(), `INSERT INTO agent_repository_stars(workspace_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING`, id, user.ID)
		} else {
			_, err = tx.Exec(r.Context(), `DELETE FROM agent_repository_stars WHERE workspace_id=$1 AND user_id=$2`, id, user.ID)
		}
	}
	var result agentRepositoryEngagement
	if err == nil {
		result, err = loadAgentRepositoryEngagement(r.Context(), tx, id, &user.ID)
	}
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	httpx.JSON(w, 200, result)
}

// Records a Clone initiation, not proof that the agent installed or downloaded files.
// Anonymous entries store no IP, cookie identifier or fingerprint.
func (a *App) publicAgentRepositoryClone(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !a.rateLimit().allow("agent-repository-clone:"+a.publicRepositoryRequestIP(r), 30, time.Minute) || !a.rateLimit().allow("agent-repository-clone:global", 600, time.Minute) {
		w.Header().Set("Retry-After", "60")
		tooManyAttempts(w)
		return
	}
	id, ok := agentWorkspaceIDFromRequest(w, r)
	if !ok {
		return
	}
	var input struct {
		ExpectedRevision *int64 `json:"expectedRevision"`
		RequestID        string `json:"requestId"`
		Method           string `json:"method"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	if json.NewDecoder(r.Body).Decode(&input) != nil || !validUUID(input.RequestID) || input.ExpectedRevision == nil || *input.ExpectedRevision < 0 || (input.Method != "zip" && input.Method != "home" && input.Method != "agent") {
		httpx.ErrorCode(w, 400, "bad_request", "expectedRevision, UUID v4 requestId and method (zip/home/agent) are required")
		return
	}
	viewer, err := a.publicRepositoryViewerID(r)
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	defer func() { _ = tx.Rollback(r.Context()) }()
	revision, err := lockPublicAgentRepository(r.Context(), tx, id)
	if err == nil && revision != *input.ExpectedRevision {
		err = errAgentWorkspaceConflict
	}
	if err == nil {
		_, err = tx.Exec(r.Context(), `INSERT INTO agent_repository_clones(request_id,workspace_id,user_id,revision,method) VALUES($1::uuid,$2,$3,$4,$5) ON CONFLICT DO NOTHING`, input.RequestID, id, viewer, revision, input.Method)
	}
	if err == nil {
		var matches bool
		err = tx.QueryRow(r.Context(), `SELECT workspace_id=$2 AND user_id IS NOT DISTINCT FROM $3::integer AND revision=$4 AND method=$5 FROM agent_repository_clones WHERE request_id=$1::uuid`, input.RequestID, id, viewer, revision, input.Method).Scan(&matches)
		if err == nil && !matches {
			err = errAgentWorkspaceConflict
		}
	}
	var result agentRepositoryEngagement
	if err == nil {
		result, err = loadAgentRepositoryEngagement(r.Context(), tx, id, viewer)
	}
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	httpx.JSON(w, 200, result)
}
