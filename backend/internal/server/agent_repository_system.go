package server

import (
	"context"
	"net/http"

	"github.com/jackc/pgx/v5"

	"koinote/backend/internal/httpx"
)

const agentRepositorySystemLimit = 1000

// User IDs are positive. The system catalog has its own transaction lock.
func agentRepositoryOwnerLock(ownerID *int) int64 {
	if ownerID == nil {
		return -20261011
	}
	return int64(*ownerID)
}

func checkAgentRepositoryCapacity(ctx context.Context, q imageUsageQuerier, userID int) error {
	var count int
	if err := q.QueryRow(ctx, `SELECT count(*) FROM agent_workspaces WHERE user_id=$1 AND deleted_at IS NULL`, userID).Scan(&count); err != nil {
		return err
	}
	if count >= agentWorkspaceMaxRepositories {
		return errAgentWorkspaceLimit
	}
	return nil
}

// A NULL owner is the database-enforced system scope. Keep capacity, quota and
// auditing decisions here; callers still authenticate the acting administrator.
func checkAgentRepositoryImportCapacity(ctx context.Context, q imageUsageQuerier, ownerID *int) (int64, error) {
	if ownerID == nil {
		var count int
		if err := q.QueryRow(ctx, `SELECT count(*) FROM agent_workspaces WHERE is_system AND deleted_at IS NULL`).Scan(&count); err != nil {
			return 0, err
		}
		if count >= agentRepositorySystemLimit {
			return 0, errAgentWorkspaceLimit
		}
		return 0, nil
	}
	var enabled bool
	var previous int64
	if err := q.QueryRow(ctx, `SELECT COALESCE((SELECT enabled FROM agent_workspace_settings WHERE user_id=$1),false),agent_workspace_storage_bytes($1)`, *ownerID).Scan(&enabled, &previous); err != nil {
		return 0, err
	}
	if !enabled {
		return 0, errAgentWorkspaceDisabled
	}
	return previous, checkAgentRepositoryCapacity(ctx, q, *ownerID)
}

func checkAgentRepositoryOwnerQuota(ctx context.Context, tx pgx.Tx, ownerID *int, previous int64) error {
	if ownerID == nil {
		return nil
	}
	return checkAgentWorkspaceQuota(ctx, tx, *ownerID, previous)
}

func recordAgentRepositorySystemEvent(ctx context.Context, tx pgx.Tx, ownerID *int, actorID int, id int64, action string, revision int64) error {
	if ownerID != nil {
		return nil
	}
	_, err := tx.Exec(ctx, `INSERT INTO agent_repository_system_events(workspace_id,actor_user_id,action,revision) VALUES($1,$2,$3,$4)`, id, actorID, action, revision)
	return err
}

// All administrators can manage the catalog, even when personal sync is disabled.
func (a *App) agentSystemRepositoriesList(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if _, ok := a.requireAdmin(w, r); !ok {
		return
	}
	rows, err := a.db.Query(r.Context(), `SELECT w.id,w.name,w.description,w.revision,w.updated_at,
      count(f.id),COALESCE(sum(f.size_bytes),0)::bigint,w.github_source,p.revision,w.hub_category
      FROM agent_workspaces w LEFT JOIN agent_workspace_files f ON f.workspace_id=w.id
      LEFT JOIN agent_repository_publications p ON p.workspace_id=w.id
      WHERE w.is_system AND w.deleted_at IS NULL GROUP BY w.id,p.revision ORDER BY w.id DESC LIMIT $1`, agentRepositorySystemLimit)
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	defer rows.Close()
	type summary struct {
		agentWorkspaceSummary
		Category          string             `json:"category"`
		SystemManaged     bool               `json:"systemManaged"`
		GitHubSource      *agentGitHubSource `json:"githubSource,omitempty"`
		PublishedRevision *int64             `json:"publishedRevision"`
	}
	items := []summary{}
	for rows.Next() {
		item := summary{SystemManaged: true}
		if err = rows.Scan(&item.WorkspaceID, &item.Name, &item.Description, &item.Revision, &item.UpdatedAt, &item.FileCount, &item.SizeBytes, &item.GitHubSource, &item.PublishedRevision, &item.Category); err != nil {
			writeAgentWorkspaceError(w, err)
			return
		}
		items = append(items, item)
	}
	if err = rows.Err(); err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"repositories": items})
}
