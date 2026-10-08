package server

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"koinote/backend/internal/httpx"
)

type agentWorkspaceCommit struct {
	CommitID       string    `json:"commitId"`
	Revision       int64     `json:"revision"`
	ParentRevision *int64    `json:"parentRevision"`
	Action         string    `json:"action"`
	RestoredFrom   *int64    `json:"restoredFrom"`
	Name           string    `json:"name"`
	Description    string    `json:"description"`
	FileCount      int       `json:"fileCount"`
	SizeBytes      int64     `json:"sizeBytes"`
	CreatedAt      time.Time `json:"createdAt"`
}

type agentWorkspaceCommitFile struct {
	Path      string `json:"path"`
	MimeType  string `json:"mimeType"`
	SizeBytes int64  `json:"sizeBytes"`
	SHA256    string `json:"sha256"`
}

func scanAgentWorkspaceCommit(row pgx.Row) (agentWorkspaceCommit, error) {
	var commit agentWorkspaceCommit
	err := row.Scan(&commit.CommitID, &commit.Revision, &commit.ParentRevision, &commit.Action,
		&commit.RestoredFrom, &commit.Name, &commit.Description, &commit.FileCount, &commit.SizeBytes, &commit.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		err = errAgentWorkspaceNotFound
	}
	return commit, err
}

func (a *App) agentWorkspaceCommitsList(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireAgentWorkspaceUser(w, r, false)
	if !ok {
		return
	}
	workspaceID, ok := agentWorkspaceIDFromRequest(w, r)
	if !ok {
		return
	}
	var before *int64
	if raw := r.URL.Query().Get("before"); raw != "" {
		value, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || value < 0 {
			httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid before revision")
			return
		}
		before = &value
	}
	var exists bool
	if err := a.db.QueryRow(r.Context(), `SELECT EXISTS (SELECT 1 FROM agent_workspaces WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL)`, workspaceID, user.ID).Scan(&exists); err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	if !exists {
		writeAgentWorkspaceError(w, errAgentWorkspaceNotFound)
		return
	}
	rows, err := a.db.Query(r.Context(), `
		SELECT c.commit_id, c.revision, c.parent_revision, c.action, c.restored_from,
		       c.name, c.description, c.file_count, c.size_bytes, c.created_at
		FROM agent_workspace_commits c JOIN agent_workspaces w ON w.id = c.workspace_id
		WHERE w.id = $1 AND w.user_id = $2 AND w.deleted_at IS NULL
		  AND ($3::bigint IS NULL OR c.revision < $3)
		ORDER BY c.revision DESC LIMIT 26
	`, workspaceID, user.ID, before)
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	defer rows.Close()
	commits := []agentWorkspaceCommit{}
	for rows.Next() {
		commit, err := scanAgentWorkspaceCommit(rows)
		if err != nil {
			writeAgentWorkspaceError(w, err)
			return
		}
		commits = append(commits, commit)
	}
	if err := rows.Err(); err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	var nextBefore *int64
	if len(commits) > 25 {
		commits = commits[:25]
		nextBefore = &commits[24].Revision
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"commits": commits, "nextBefore": nextBefore})
}

func (a *App) agentWorkspaceCommitGet(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireAgentWorkspaceUser(w, r, false)
	if !ok {
		return
	}
	workspaceID, revision, ok := agentWorkspaceHistoryIDs(w, r)
	if !ok {
		return
	}
	commit, err := scanAgentWorkspaceCommit(a.db.QueryRow(r.Context(), `
		SELECT c.commit_id, c.revision, c.parent_revision, c.action, c.restored_from,
		       c.name, c.description, c.file_count, c.size_bytes, c.created_at
		FROM agent_workspace_commits c JOIN agent_workspaces w ON w.id = c.workspace_id
		WHERE w.id = $1 AND w.user_id = $2 AND c.revision = $3 AND w.deleted_at IS NULL
	`, workspaceID, user.ID, revision))
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	rows, err := a.db.Query(r.Context(), `
		SELECT path, mime_type, size_bytes, sha256 FROM agent_workspace_commit_files
		WHERE workspace_id = $1 AND revision = $2 ORDER BY path
	`, workspaceID, revision)
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	defer rows.Close()
	files := []agentWorkspaceCommitFile{}
	for rows.Next() {
		var file agentWorkspaceCommitFile
		if err := rows.Scan(&file.Path, &file.MimeType, &file.SizeBytes, &file.SHA256); err != nil {
			writeAgentWorkspaceError(w, err)
			return
		}
		files = append(files, file)
	}
	if err := rows.Err(); err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"commit": commit, "files": files})
}

func (a *App) agentWorkspaceCommitFileGet(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireAgentWorkspaceUser(w, r, false)
	if !ok {
		return
	}
	workspaceID, revision, ok := agentWorkspaceHistoryIDs(w, r)
	if !ok {
		return
	}
	var file struct {
		agentWorkspaceCommitFile
		ContentBase64 string `json:"contentBase64"`
	}
	var content []byte
	err := a.db.QueryRow(r.Context(), `
		SELECT f.path, f.mime_type, f.size_bytes, f.sha256, b.content
		FROM agent_workspace_commit_files f JOIN agent_workspace_blobs b USING (workspace_id, sha256)
		JOIN agent_workspaces w ON w.id = f.workspace_id
		WHERE w.id = $1 AND w.user_id = $2 AND f.revision = $3 AND f.path = $4 AND w.deleted_at IS NULL
	`, workspaceID, user.ID, revision, r.URL.Query().Get("path")).Scan(&file.Path, &file.MimeType, &file.SizeBytes, &file.SHA256, &content)
	if errors.Is(err, pgx.ErrNoRows) {
		err = errAgentWorkspaceNotFound
	}
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	file.ContentBase64 = base64.StdEncoding.EncodeToString(content)
	httpx.JSON(w, http.StatusOK, map[string]any{"file": file})
}

func (a *App) agentWorkspaceCommitRestore(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireAgentWorkspaceUser(w, r, true)
	if !ok {
		return
	}
	if !a.rateLimit().allow("agent-workspace-write:"+strconv.Itoa(user.ID), agentWorkspaceWriteLimit, time.Minute) {
		tooManyAttempts(w)
		return
	}
	workspaceID, revision, ok := agentWorkspaceHistoryIDs(w, r)
	if !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	var input struct {
		ExpectedRevision *int64 `json:"expectedRevision"`
	}
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil || input.ExpectedRevision == nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "revision_required", "expectedRevision is required")
		return
	}
	view, err := a.mutateAgentWorkspaceWithHistory(r.Context(), user.ID, workspaceID, *input.ExpectedRevision, nil, nil, true, &revision)
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"workspace": view})
}

func agentWorkspaceHistoryIDs(w http.ResponseWriter, r *http.Request) (int64, int64, bool) {
	workspaceID, ok := agentWorkspaceIDFromRequest(w, r)
	if !ok {
		return 0, 0, false
	}
	revision, err := strconv.ParseInt(r.PathValue("revision"), 10, 64)
	if err != nil || revision < 0 {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid revision")
		return 0, 0, false
	}
	return workspaceID, revision, true
}
