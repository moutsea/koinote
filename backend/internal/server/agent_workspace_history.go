package server

import (
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
	page, err := a.listAgentWorkspaceCommits(r.Context(), user.ID, workspaceID, before)
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, page)
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
	view, err := a.loadAgentWorkspaceCommit(r.Context(), user.ID, workspaceID, revision)
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, view)
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
	file, err := a.loadAgentWorkspaceCommitFile(r.Context(), user.ID, workspaceID, revision, r.URL.Query().Get("path"))
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
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
		AllowSensitive   bool   `json:"allowSensitive"`
	}
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil || input.ExpectedRevision == nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "revision_required", "expectedRevision is required")
		return
	}
	view, err := a.mutateAgentWorkspaceWithHistory(r.Context(), user.ID, workspaceID, *input.ExpectedRevision, nil, nil, true, &revision, input.AllowSensitive && agentWorkspaceSensitiveOverrideAllowed(r))
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
