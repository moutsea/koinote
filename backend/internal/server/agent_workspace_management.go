package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"koinote/backend/internal/httpx"
)

var (
	errAgentWorkspaceSelection = errors.New("multiple repositories exist; specify workspaceId")
	errAgentWorkspaceDisabled  = errors.New("enable Skills/Agent cloud sync in Koinote Settings first")
	errAgentWorkspaceName      = errors.New("name must contain 1 to 80 characters and description at most 500 characters")
	errAgentWorkspaceLimit     = errors.New("repository limit reached")
	errAgentWorkspaceQuota     = errors.New("agent workspace storage quota exceeded")
)

type agentWorkspaceSummary struct {
	WorkspaceID int64     `json:"workspaceId"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Revision    int64     `json:"revision"`
	UpdatedAt   time.Time `json:"updatedAt"`
	FileCount   int       `json:"fileCount"`
	SizeBytes   int64     `json:"sizeBytes"`
}

type agentWorkspaceMetadataInput struct {
	Name             string `json:"name"`
	Description      string `json:"description"`
	Locale           string `json:"locale,omitempty"`
	ExpectedRevision *int64 `json:"expectedRevision"`
}

func (a *App) agentWorkspaceEnabled(ctx context.Context, userID int) (bool, error) {
	var enabled bool
	err := a.db.QueryRow(ctx, `
		SELECT COALESCE((SELECT enabled FROM agent_workspace_settings WHERE user_id = $1), false)
	`, userID).Scan(&enabled)
	return enabled, err
}

func (a *App) requireAgentWorkspaceEnabled(w http.ResponseWriter, r *http.Request, userID int) bool {
	enabled, err := a.agentWorkspaceEnabled(r.Context(), userID)
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return false
	}
	if !enabled {
		writeAgentWorkspaceError(w, errAgentWorkspaceDisabled)
		return false
	}
	return true
}

func (a *App) agentWorkspaceSettingsGet(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	enabled, err := a.agentWorkspaceEnabled(r.Context(), user.ID)
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"enabled": enabled})
}

func (a *App) agentWorkspaceSettingsPut(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	var input struct {
		Enabled *bool `json:"enabled"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil || input.Enabled == nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "enabled is required")
		return
	}
	_, err := a.db.Exec(r.Context(), `
		INSERT INTO agent_workspace_settings (user_id, enabled) VALUES ($1, $2)
		ON CONFLICT (user_id) DO UPDATE SET enabled = EXCLUDED.enabled, updated_at = now()
	`, user.ID, *input.Enabled)
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"enabled": *input.Enabled})
}

func agentWorkspaceIDFromRequest(w http.ResponseWriter, r *http.Request) (int64, bool) {
	raw := r.PathValue("workspaceId")
	if raw == "" {
		raw = r.URL.Query().Get("workspaceId")
	}
	if raw == "" {
		return 0, true
	}
	workspaceID, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || workspaceID <= 0 {
		writeAgentWorkspaceError(w, errAgentWorkspaceNotFound)
		return 0, false
	}
	return workspaceID, true
}

func writeAgentWorkspaceError(w http.ResponseWriter, err error) {
	var sensitive *agentWorkspaceSensitiveError
	switch {
	case errors.Is(err, errAgentRepositoryStorage):
		httpx.ErrorCode(w, http.StatusServiceUnavailable, "repository_storage_unavailable", errAgentRepositoryStorage.Error())
	case errors.Is(err, errAgentWorkspaceCommentSensitive):
		httpx.ErrorCode(w, 422, "sensitive_comment", err.Error())
	case errors.Is(err, errAgentWorkspaceCommentInvalid):
		httpx.ErrorCode(w, 400, "invalid_comment", err.Error())
	case errors.As(err, &sensitive):
		httpx.ErrorCode(w, http.StatusUnprocessableEntity, "sensitive_data_detected", err.Error())
	case errors.Is(err, errAgentGitHubCredentialRequired):
		httpx.ErrorCode(w, http.StatusForbidden, "github_token_required", err.Error())
	case errors.Is(err, errAgentGitHubCredentialInvalid):
		httpx.ErrorCode(w, http.StatusBadRequest, "github_token_invalid", err.Error())
	case errors.Is(err, errAgentGitHubCredentialCrypto):
		httpx.ErrorCode(w, http.StatusServiceUnavailable, "github_credential_unavailable", "GitHub credential storage is unavailable")
	case errors.Is(err, errAgentGitHubRepositoryInvalid), errors.Is(err, errAgentGitHubLicense):
		httpx.ErrorCode(w, http.StatusBadRequest, "github_repository_invalid", err.Error())
	case errors.Is(err, errAgentGitHubRepositoryMissing):
		httpx.ErrorCode(w, http.StatusNotFound, "github_repository_unavailable", err.Error())
	case errors.Is(err, errAgentGitHubArchiveInvalid):
		httpx.ErrorCode(w, http.StatusUnprocessableEntity, "github_archive_invalid", err.Error())
	case errors.Is(err, errAgentGitHubRateLimited), errors.Is(err, errAgentGitHubImportBusy):
		w.Header().Set("Retry-After", "60")
		httpx.ErrorCode(w, http.StatusTooManyRequests, "github_rate_limited", err.Error())
	case errors.Is(err, errAgentWorkspaceRevisionNotFound):
		httpx.ErrorCode(w, http.StatusNotFound, "revision_not_found", err.Error())
	case errors.Is(err, errAgentWorkspaceFileNotFound):
		httpx.ErrorCode(w, http.StatusNotFound, "file_not_found", err.Error())
	case errors.Is(err, errAgentWorkspaceDisabled):
		httpx.ErrorCode(w, http.StatusForbidden, "agent_workspace_disabled", err.Error())
	case errors.Is(err, errAgentWorkspaceNotFound):
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", err.Error())
	case errors.Is(err, errAgentWorkspaceSelection):
		httpx.ErrorCode(w, http.StatusConflict, "workspace_selection_required", err.Error())
	case errors.Is(err, errAgentWorkspaceConflict):
		httpx.ErrorCode(w, http.StatusConflict, "revision_conflict", err.Error())
	case errors.Is(err, errAgentWorkspaceName), errors.Is(err, errAgentWorkspaceLimit):
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_agent_workspace", err.Error())
	case errors.Is(err, errAgentWorkspaceQuota):
		httpx.ErrorCode(w, http.StatusRequestEntityTooLarge, "agent_workspace_quota_exceeded", err.Error())
	default:
		log.Printf("agent workspace: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
	}
}

func (a *App) listAgentWorkspaces(ctx context.Context, userID int) ([]agentWorkspaceSummary, error) {
	rows, err := a.db.Query(ctx, `
		SELECT w.id, w.name, w.description, w.revision, w.updated_at,
		       count(f.id), COALESCE(sum(f.size_bytes), 0)::bigint
		FROM agent_workspaces w LEFT JOIN agent_workspace_files f ON f.workspace_id = w.id
		WHERE w.user_id = $1 AND w.deleted_at IS NULL
		GROUP BY w.id ORDER BY w.updated_at DESC, w.id DESC
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	workspaces := []agentWorkspaceSummary{}
	for rows.Next() {
		var workspace agentWorkspaceSummary
		if err := rows.Scan(&workspace.WorkspaceID, &workspace.Name, &workspace.Description,
			&workspace.Revision, &workspace.UpdatedAt, &workspace.FileCount, &workspace.SizeBytes); err != nil {
			return nil, err
		}
		workspaces = append(workspaces, workspace)
	}
	return workspaces, rows.Err()
}

func (a *App) agentWorkspacesList(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireAgentWorkspaceUser(w, r, false)
	if !ok {
		return
	}
	workspaces, err := a.listAgentWorkspaces(r.Context(), user.ID)
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"workspaces": workspaces})
}

func validateAgentWorkspaceMetadata(name, description string) (string, string, error) {
	name, description = strings.TrimSpace(name), strings.TrimSpace(description)
	if name == "" || utf8.RuneCountInString(name) > 80 || utf8.RuneCountInString(description) > 500 {
		return "", "", errAgentWorkspaceName
	}
	return name, description, nil
}

func (a *App) createAgentWorkspace(ctx context.Context, userID int, name, description, locale string) (agentWorkspaceView, error) {
	name, description, err := validateAgentWorkspaceMetadata(name, description)
	if err != nil {
		return agentWorkspaceView{}, err
	}
	readme := []byte(agentWorkspaceREADMEForLocale(a.cfg.AppURL, locale))
	readmeHash := sha256.Sum256(readme)
	file := agentWorkspaceFile{Path: "README.md", Content: readme, MimeType: "text/markdown", SHA256: hex.EncodeToString(readmeHash[:])}
	staged, err := a.stageAgentRepositoryFiles(ctx, userID, []agentWorkspaceFile{file})
	if err != nil {
		return agentWorkspaceView{}, err
	}
	defer a.expireAgentRepositoryStaging(ctx, staged)

	tx, err := a.db.Begin(ctx)
	if err != nil {
		return agentWorkspaceView{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, userID); err != nil {
		return agentWorkspaceView{}, err
	}
	if err := checkAgentRepositoryCapacity(ctx, tx, userID); err != nil {
		return agentWorkspaceView{}, err
	}
	var previousBytes int64
	if err := tx.QueryRow(ctx, `SELECT agent_workspace_storage_bytes($1)`, userID).Scan(&previousBytes); err != nil {
		return agentWorkspaceView{}, err
	}
	var workspaceID int64
	if err := tx.QueryRow(ctx, `
		INSERT INTO agent_workspaces (user_id, name, description) VALUES ($1, $2, $3) RETURNING id
	`, userID, name, description).Scan(&workspaceID); err != nil {
		return agentWorkspaceView{}, err
	}
	if err := insertAgentRepositoryFile(ctx, tx, workspaceID, file, staged); err != nil {
		return agentWorkspaceView{}, err
	}

	if _, err := tx.Exec(ctx, `SELECT record_agent_workspace_commit($1, 'create')`, workspaceID); err != nil {
		return agentWorkspaceView{}, err
	}
	if err := checkAgentWorkspaceQuota(ctx, tx, userID, previousBytes); err != nil {
		return agentWorkspaceView{}, err
	}
	view, err := loadAgentWorkspaceFrom(ctx, tx, userID, workspaceID)
	if err != nil {
		return agentWorkspaceView{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return agentWorkspaceView{}, err
	}
	return view, nil
}

func (a *App) agentWorkspaceCreate(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireAgentWorkspaceUser(w, r, true)
	if !ok {
		return
	}
	if !a.rateLimit().allow("agent-workspace-write:"+strconv.Itoa(user.ID), agentWorkspaceWriteLimit, time.Minute) {
		tooManyAttempts(w)
		return
	}
	var input agentWorkspaceMetadataInput
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid request")
		return
	}
	view, err := a.createAgentWorkspace(r.Context(), user.ID, input.Name, input.Description, input.Locale)
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"workspace": view})
}

func (a *App) manageAgentWorkspace(ctx context.Context, userID int, workspaceID, expectedRevision int64, name, description string, remove bool) (agentWorkspaceView, error) {
	if workspaceID <= 0 {
		return agentWorkspaceView{}, errAgentWorkspaceNotFound
	}
	var err error
	if !remove {
		name, description, err = validateAgentWorkspaceMetadata(name, description)
		if err != nil {
			return agentWorkspaceView{}, err
		}
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return agentWorkspaceView{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, userID); err != nil {
		return agentWorkspaceView{}, err
	}
	var revision int64
	err = tx.QueryRow(ctx, `SELECT revision FROM agent_workspaces WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE`, workspaceID, userID).Scan(&revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return agentWorkspaceView{}, errAgentWorkspaceNotFound
	}
	if err != nil {
		return agentWorkspaceView{}, err
	}
	if revision != expectedRevision {
		return agentWorkspaceView{}, errAgentWorkspaceConflict
	}
	view := agentWorkspaceView{}
	if remove {
		_, err = tx.Exec(ctx, `DELETE FROM agent_workspaces WHERE id = $1`, workspaceID)
	} else {
		if _, err := tx.Exec(ctx, `SELECT record_agent_workspace_commit($1, 'baseline')`, workspaceID); err != nil {
			return agentWorkspaceView{}, err
		}
		_, err = tx.Exec(ctx, `
			UPDATE agent_workspaces SET name = $2, description = $3, revision = revision + 1, updated_at = now() WHERE id = $1
		`, workspaceID, name, description)
		if err == nil {
			_, err = tx.Exec(ctx, `SELECT record_agent_workspace_commit($1, 'metadata')`, workspaceID)
		}
		if err == nil {
			view, err = loadAgentWorkspaceFrom(ctx, tx, userID, workspaceID)
		}
	}
	if err != nil {
		return agentWorkspaceView{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return agentWorkspaceView{}, err
	}
	return view, nil
}

func (a *App) agentWorkspaceManage(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireAgentWorkspaceUser(w, r, true)
	if !ok {
		return
	}
	if !a.rateLimit().allow("agent-workspace-write:"+strconv.Itoa(user.ID), agentWorkspaceWriteLimit, time.Minute) {
		tooManyAttempts(w)
		return
	}
	workspaceID, ok := agentWorkspaceIDFromRequest(w, r)
	if !ok {
		return
	}
	var input agentWorkspaceMetadataInput
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil || input.ExpectedRevision == nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "expectedRevision is required")
		return
	}
	remove := r.Method == http.MethodDelete
	view, err := a.manageAgentWorkspace(r.Context(), user.ID, workspaceID, *input.ExpectedRevision, input.Name, input.Description, remove)
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	if remove {
		httpx.JSON(w, http.StatusOK, map[string]bool{"success": true})
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"workspace": view})
}
