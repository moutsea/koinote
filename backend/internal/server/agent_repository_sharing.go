package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"koinote/backend/internal/httpx"
)

const publicRepositoryPageSize = 24

type agentRepositoryPublication struct {
	agentWorkspaceView
	agentRepositoryEngagement
	License     string `json:"license"`
	URL         string `json:"url"`
	ManifestURL string `json:"manifestUrl"`
}

type agentRepositorySource struct {
	WorkspaceID *int64 `json:"workspaceId"`
	Revision    int64  `json:"revision"`
	Name        string `json:"name"`
	License     string `json:"license"`
}

// Sharing changes require an interactive user session, never an Agent token.
// Revocation remains available even after membership or sync has been disabled.
func (a *App) agentRepositorySharing(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	id, ok := agentWorkspaceIDFromRequest(w, r)
	if !ok {
		return
	}
	if r.Method == http.MethodGet {
		var currentRevision int64
		err := a.db.QueryRow(r.Context(), `SELECT revision FROM agent_workspaces WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, id, user.ID).Scan(&currentRevision)
		if errors.Is(err, pgx.ErrNoRows) {
			writeAgentWorkspaceError(w, errAgentWorkspaceNotFound)
			return
		}
		if err != nil {
			writeAgentWorkspaceError(w, err)
			return
		}
		publication, err := a.loadPublicAgentRepository(r.Context(), id, nil)
		if err != nil && !errors.Is(err, errAgentWorkspaceNotFound) {
			writeAgentWorkspaceError(w, err)
			return
		}
		var source agentRepositorySource
		err = a.db.QueryRow(r.Context(), `SELECT source_workspace_id, source_revision, source_name, source_license FROM agent_repository_forks WHERE workspace_id=$1`, id).Scan(&source.WorkspaceID, &source.Revision, &source.Name, &source.License)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			writeAgentWorkspaceError(w, err)
			return
		}
		var sourceValue *agentRepositorySource
		if err == nil {
			sourceValue = &source
		}
		httpx.JSON(w, http.StatusOK, map[string]any{"publication": publication, "source": sourceValue, "currentRevision": currentRevision})
		return
	}
	if r.Method == http.MethodPut {
		if user.MembershipTier != membershipTierLifetime {
			httpx.ErrorCode(w, http.StatusForbidden, "membership_required", "Lifetime membership is required")
			return
		}
		if !a.requireAgentWorkspaceEnabled(w, r, user.ID) {
			return
		}
	}
	if !a.rateLimit().allow("agent-workspace-write:"+strconv.Itoa(user.ID), agentWorkspaceWriteLimit, time.Minute) {
		tooManyAttempts(w)
		return
	}
	var input struct {
		ExpectedRevision *int64 `json:"expectedRevision"`
		License          string `json:"license"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	if json.NewDecoder(r.Body).Decode(&input) != nil || input.ExpectedRevision == nil || *input.ExpectedRevision < 0 {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "expectedRevision is required")
		return
	}
	err := a.setAgentRepositoryPublication(r.Context(), user.ID, id, *input.ExpectedRevision, input.License, r.Method == http.MethodDelete)
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"success": true})
}

func agentRepositoryLicenseAllowed(value string) bool {
	switch value {
	case "UNLICENSED", "MIT", "Apache-2.0", "BSD-3-Clause", "GPL-3.0-only", "CC0-1.0", "CC-BY-4.0":
		return true
	}
	return false
}

// Content scanning cannot be overridden for publication, even for files that
// the owner previously chose to keep in their private repository.
func agentRepositorySensitivePath(value string) bool {
	base := strings.ToLower(path.Base(value))
	return base == ".env" || strings.HasPrefix(base, ".env.") || base == ".credentials.yaml" || base == "credentials.json" || base == "auth.json" || base == "id_rsa" || base == "id_ed25519" || strings.HasSuffix(base, ".p12") || strings.HasSuffix(base, ".pfx") || strings.HasSuffix(base, ".key")
}

func (a *App) setAgentRepositoryPublication(ctx context.Context, userID int, id, revision int64, license string, revoke bool) error {
	var scans agentRepositoryContentScans
	var err error
	if !revoke {
		scans, err = a.checkAgentRepositoryPublication(ctx, userID, id, revision)
		if err != nil {
			return err
		}
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, userID); err != nil {
		return err
	}
	var current int64
	var name, description string
	var githubSource *agentGitHubSource
	err = tx.QueryRow(ctx, `SELECT revision, name, description, github_source FROM agent_workspaces WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR UPDATE`, id, userID).Scan(&current, &name, &description, &githubSource)
	if errors.Is(err, pgx.ErrNoRows) {
		return errAgentWorkspaceNotFound
	}
	if err != nil {
		return err
	}
	if current != revision {
		return errAgentWorkspaceConflict
	}
	if revoke {
		_, err = tx.Exec(ctx, `DELETE FROM agent_repository_publications WHERE workspace_id=$1`, id)
	} else {
		if !agentRepositoryLicenseAllowed(license) && (githubSource == nil || githubSource.License != license) {
			return errAgentGitHubLicense
		}
		// Recording a baseline makes this safe for repositories created by older clients.
		if _, err = tx.Exec(ctx, `SELECT record_agent_workspace_commit($1, 'baseline')`, id); err != nil {
			return err
		}
		// Legacy rows may not have had blobs when scanned. Cache their verified
		// results now that baseline recording has created the content-addressed rows.
		if err = scans.save(ctx, tx, id); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `INSERT INTO agent_repository_publications (workspace_id, revision, name, description, license, github_source)
 VALUES ($1,$2,$3,$4,$5,(SELECT github_source - 'private' FROM agent_workspaces WHERE id=$1)) ON CONFLICT(workspace_id) DO UPDATE SET revision=EXCLUDED.revision, name=EXCLUDED.name, description=EXCLUDED.description, license=EXCLUDED.license, github_source=EXCLUDED.github_source, published_at=now()`, id, revision, name, description, license)
		if err != nil {
			return err
		}
		if _, err = tx.Exec(ctx, `DELETE FROM agent_repository_publication_files WHERE workspace_id=$1`, id); err != nil {
			return err
		}
		_, err = tx.Exec(ctx, `INSERT INTO agent_repository_publication_files (workspace_id,file_id,path,mime_type,sha256,size_bytes)
 SELECT workspace_id,id,path,mime_type,sha256,size_bytes FROM agent_workspace_files WHERE workspace_id=$1`, id)
	}
	if err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `SELECT prune_agent_workspace_history($1,100000000)`, id); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (a *App) allowPublicRepositoryRead(w http.ResponseWriter, r *http.Request) bool {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if a.rateLimit().allow("public-agent-repository:"+a.publicRepositoryRequestIP(r), 600, time.Minute) {
		return true
	}
	w.Header().Set("Retry-After", "60")
	tooManyAttempts(w)
	return false
}

func (a *App) publicAgentRepositoriesList(w http.ResponseWriter, r *http.Request) {
	if !a.allowPublicRepositoryRead(w, r) {
		return
	}
	var cursor struct {
		PublishedAt time.Time `json:"publishedAt"`
		ID          int64     `json:"id"`
	}
	if raw := r.URL.Query().Get("cursor"); raw != "" {
		if len(raw) > 400 {
			httpx.ErrorCode(w, 400, "bad_request", "Invalid cursor")
			return
		}
		decoded, err := base64.RawURLEncoding.DecodeString(raw)
		if err != nil || json.Unmarshal(decoded, &cursor) != nil || cursor.PublishedAt.IsZero() || cursor.ID <= 0 {
			httpx.ErrorCode(w, 400, "bad_request", "Invalid cursor")
			return
		}
	}
	viewer, err := a.publicRepositoryViewerID(r)
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if utf8.RuneCountInString(query) > 80 {
		httpx.ErrorCode(w, 400, "bad_request", "Search is too long")
		return
	}
	rows, err := a.db.Query(r.Context(), `SELECT p.workspace_id,p.name,p.description,p.revision,p.published_at,count(f.path),COALESCE(sum(f.size_bytes),0)::bigint,p.license,p.github_source,
 (SELECT COALESCE((SELECT star_count FROM agent_repository_stats s WHERE s.workspace_id=p.workspace_id),0)),
 EXISTS(SELECT 1 FROM agent_repository_stars s WHERE s.workspace_id=p.workspace_id AND s.user_id=$5),
 (SELECT COALESCE((SELECT clone_count FROM agent_repository_stats s WHERE s.workspace_id=p.workspace_id),0))
 FROM agent_repository_publications p JOIN agent_workspaces w ON w.id=p.workspace_id
 LEFT JOIN agent_repository_publication_files f ON f.workspace_id=p.workspace_id
 WHERE w.deleted_at IS NULL AND ($1::bigint=0 OR (p.published_at,p.workspace_id)<($4::timestamptz,$1)) AND ($2='' OR strpos(lower(p.name||' '||p.description),lower($2))>0)
 GROUP BY p.workspace_id ORDER BY p.published_at DESC,p.workspace_id DESC LIMIT $3`, cursor.ID, query, publicRepositoryPageSize+1, cursor.PublishedAt, viewer)
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	defer rows.Close()
	type summary struct {
		agentWorkspaceSummary
		agentRepositoryEngagement
		License      string             `json:"license"`
		GitHubSource *agentGitHubSource `json:"githubSource,omitempty"`
	}
	items := []summary{}
	for rows.Next() {
		var item summary
		if err = rows.Scan(&item.WorkspaceID, &item.Name, &item.Description, &item.Revision, &item.UpdatedAt, &item.FileCount, &item.SizeBytes, &item.License, &item.GitHubSource, &item.StarCount, &item.Starred, &item.CloneCount); err != nil {
			writeAgentWorkspaceError(w, err)
			return
		}
		items = append(items, item)
	}
	if err = rows.Err(); err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	var next *string
	if len(items) > publicRepositoryPageSize {
		items = items[:publicRepositoryPageSize]
		last := items[len(items)-1]
		cursor.PublishedAt = last.UpdatedAt
		cursor.ID = last.WorkspaceID
		encoded, _ := json.Marshal(cursor)
		value := base64.RawURLEncoding.EncodeToString(encoded)
		next = &value
	}
	httpx.JSON(w, 200, map[string]any{"repositories": items, "nextCursor": next})
}

func (a *App) loadPublicAgentRepository(ctx context.Context, id int64, revision *int64) (*agentRepositoryPublication, error) {
	return a.loadPublicAgentRepositoryForViewer(ctx, id, revision, nil)
}

func (a *App) loadPublicAgentRepositoryForViewer(ctx context.Context, id int64, revision *int64, viewer *int) (*agentRepositoryPublication, error) {
	tx, err := a.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var result agentRepositoryPublication
	var published time.Time
	err = tx.QueryRow(ctx, `SELECT p.workspace_id,p.name,p.description,p.revision,p.published_at,p.license,p.github_source FROM agent_repository_publications p JOIN agent_workspaces w ON w.id=p.workspace_id WHERE p.workspace_id=$1 AND w.deleted_at IS NULL AND ($2::bigint IS NULL OR p.revision=$2)`, id, revision).Scan(&result.WorkspaceID, &result.Name, &result.Description, &result.Revision, &published, &result.License, &result.GitHubSource)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errAgentWorkspaceNotFound
	}
	if err != nil {
		return nil, err
	}
	result.agentRepositoryEngagement, err = loadAgentRepositoryEngagement(ctx, tx, id, viewer)
	if err != nil {
		return nil, err
	}
	result.UpdatedAt = published.UTC().Format(time.RFC3339)
	result.URL = strings.TrimRight(a.cfg.AppURL, "/") + "/repositories/" + strconv.FormatInt(id, 10)
	result.ManifestURL = strings.TrimRight(a.cfg.AppURL, "/") + "/api/agent/repositories/" + strconv.FormatInt(id, 10) + "?revision=" + strconv.FormatInt(result.Revision, 10)
	result.Files = []agentWorkspaceFileView{}
	rows, err := tx.Query(ctx, `SELECT file_id,path,mime_type,size_bytes,sha256 FROM agent_repository_publication_files WHERE workspace_id=$1 ORDER BY path`, id)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var file agentWorkspaceFileView
		if err = rows.Scan(&file.FileID, &file.Path, &file.MimeType, &file.SizeBytes, &file.SHA256); err != nil {
			rows.Close()
			return nil, err
		}
		result.Files = append(result.Files, file)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return &result, nil
}

func publicRepositoryRevision(w http.ResponseWriter, r *http.Request, required bool) (*int64, bool) {
	raw := r.URL.Query().Get("revision")
	if raw == "" && !required {
		return nil, true
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < 0 {
		httpx.ErrorCode(w, 400, "bad_request", "revision is required")
		return nil, false
	}
	return &value, true
}

func (a *App) publicAgentRepositoryGet(w http.ResponseWriter, r *http.Request) {
	if !a.allowPublicRepositoryRead(w, r) {
		return
	}
	id, ok := agentWorkspaceIDFromRequest(w, r)
	if !ok {
		return
	}
	revision, ok := publicRepositoryRevision(w, r, false)
	if !ok {
		return
	}
	viewer, err := a.publicRepositoryViewerID(r)
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	repository, err := a.loadPublicAgentRepositoryForViewer(r.Context(), id, revision, viewer)
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"repository": repository})
}

func (a *App) publicAgentRepositoryFileGet(w http.ResponseWriter, r *http.Request) {
	if !a.allowPublicRepositoryRead(w, r) {
		return
	}
	id, ok := agentWorkspaceIDFromRequest(w, r)
	if !ok {
		return
	}
	revision, ok := publicRepositoryRevision(w, r, true)
	if !ok {
		return
	}
	fileID, err := strconv.ParseInt(r.PathValue("fileId"), 10, 64)
	if err != nil || fileID <= 0 {
		writeAgentWorkspaceError(w, errAgentWorkspaceFileNotFound)
		return
	}
	var file agentWorkspaceFileContentView
	var content []byte
	err = a.db.QueryRow(r.Context(), `SELECT f.file_id,f.path,f.mime_type,f.size_bytes,f.sha256,b.content
 FROM agent_repository_publications p JOIN agent_workspaces w ON w.id=p.workspace_id
 JOIN agent_repository_publication_files f ON f.workspace_id=p.workspace_id JOIN agent_workspace_blobs b ON b.workspace_id=f.workspace_id AND b.sha256=f.sha256
 WHERE p.workspace_id=$1 AND p.revision=$2 AND f.file_id=$3 AND w.deleted_at IS NULL`, id, revision, fileID).Scan(&file.FileID, &file.Path, &file.MimeType, &file.SizeBytes, &file.SHA256, &content)
	if errors.Is(err, pgx.ErrNoRows) {
		writeAgentWorkspaceError(w, errAgentWorkspaceNotFound)
		return
	}
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	file.ContentBase64 = base64.StdEncoding.EncodeToString(content)
	httpx.JSON(w, 200, map[string]any{"file": file})
}

func (a *App) publicAgentRepositoryFork(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireLifetimeMember(w, r)
	if !ok || !a.requireAgentWorkspaceEnabled(w, r, user.ID) {
		return
	}
	id, ok := agentWorkspaceIDFromRequest(w, r)
	if !ok {
		return
	}
	if !a.rateLimit().allow("agent-workspace-write:"+strconv.Itoa(user.ID), agentWorkspaceWriteLimit, time.Minute) {
		tooManyAttempts(w)
		return
	}
	var input struct {
		ExpectedRevision *int64 `json:"expectedRevision"`
		RequestID        string `json:"requestId"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	if json.NewDecoder(r.Body).Decode(&input) != nil || input.ExpectedRevision == nil || *input.ExpectedRevision < 0 {
		httpx.ErrorCode(w, 400, "bad_request", "expectedRevision and requestId are required")
		return
	}
	if !validUUID(input.RequestID) {
		httpx.ErrorCode(w, 400, "bad_request", "Invalid requestId")
		return
	}
	workspace, err := a.forkAgentRepository(r.Context(), user.ID, id, *input.ExpectedRevision, strings.TrimSpace(input.RequestID))
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	httpx.JSON(w, 201, map[string]any{"workspace": workspace})
}

func (a *App) forkAgentRepository(ctx context.Context, userID int, id, revision int64, requestID string) (agentWorkspaceView, error) {
	var empty agentWorkspaceView
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return empty, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, userID); err != nil {
		return empty, err
	}
	var existingID, existingRevision int64
	var sourceID *int64
	err = tx.QueryRow(ctx, `SELECT workspace_id,source_workspace_id,source_revision FROM agent_repository_forks WHERE user_id=$1 AND request_id=$2::uuid`, userID, requestID).Scan(&existingID, &sourceID, &existingRevision)
	if err == nil {
		if sourceID == nil || *sourceID != id || existingRevision != revision {
			return empty, errAgentWorkspaceConflict
		}
		return loadAgentWorkspaceFrom(ctx, tx, userID, existingID)
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return empty, err
	}
	// Lock the source workspace before its publication, matching publish/delete order.
	var sourceExists int64
	err = tx.QueryRow(ctx, `SELECT id FROM agent_workspaces WHERE id=$1 AND deleted_at IS NULL FOR SHARE`, id).Scan(&sourceExists)
	if errors.Is(err, pgx.ErrNoRows) {
		return empty, errAgentWorkspaceNotFound
	}
	if err != nil {
		return empty, err
	}
	var name, description, license string
	var githubSource *agentGitHubSource
	var publishedRevision int64
	err = tx.QueryRow(ctx, `SELECT p.name,p.description,p.license,p.revision,p.github_source FROM agent_repository_publications p JOIN agent_workspaces w ON w.id=p.workspace_id WHERE p.workspace_id=$1 AND w.deleted_at IS NULL FOR SHARE OF p`, id).Scan(&name, &description, &license, &publishedRevision, &githubSource)
	if errors.Is(err, pgx.ErrNoRows) {
		return empty, errAgentWorkspaceNotFound
	}
	if err != nil {
		return empty, err
	}
	if publishedRevision != revision {
		return empty, errAgentWorkspaceConflict
	}
	var count int
	var previousBytes int64
	if err = tx.QueryRow(ctx, `SELECT count(*) FROM agent_workspaces WHERE user_id=$1 AND deleted_at IS NULL`, userID).Scan(&count); err != nil {
		return empty, err
	}
	if count >= agentWorkspaceMaxRepositories {
		return empty, errAgentWorkspaceLimit
	}
	if err = tx.QueryRow(ctx, `SELECT agent_workspace_storage_bytes($1)`, userID).Scan(&previousBytes); err != nil {
		return empty, err
	}
	var newID int64
	if err = tx.QueryRow(ctx, `INSERT INTO agent_workspaces(user_id,name,description,github_source) VALUES($1,$2,$3,$4) RETURNING id`, userID, name, description, githubSource).Scan(&newID); err != nil {
		return empty, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO agent_workspace_files(workspace_id,path,content,mime_type,size_bytes,sha256)
 SELECT $1,f.path,b.content,f.mime_type,f.size_bytes,f.sha256 FROM agent_repository_publication_files f JOIN agent_workspace_blobs b USING(workspace_id,sha256) WHERE f.workspace_id=$2`, newID, id); err != nil {
		return empty, err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO agent_repository_forks(workspace_id,source_workspace_id,source_revision,source_name,source_license,user_id,request_id) VALUES($1,$2,$3,$4,$5,$6,$7::uuid)`, newID, id, revision, name, license, userID, requestID); err != nil {
		return empty, err
	}
	if _, err = tx.Exec(ctx, `SELECT record_agent_workspace_commit($1,'fork',NULL,$2)`, newID, fmt.Sprintf("Forked public repository %d at revision %d", id, revision)); err != nil {
		return empty, err
	}

	if err = checkAgentWorkspaceQuota(ctx, tx, userID, previousBytes); err != nil {
		return empty, err
	}
	workspace, err := loadAgentWorkspaceFrom(ctx, tx, userID, newID)
	if err != nil {
		return empty, err
	}
	if err = tx.Commit(ctx); err != nil {
		return empty, err
	}
	return workspace, nil
}
