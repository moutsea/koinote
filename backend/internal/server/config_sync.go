package server

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"koinote/backend/internal/httpx"
)

const configSyncTokenPrefix = "knt_config_sync_"
const configSyncLifetime = 30 * time.Minute
const configSyncMaxActive = 10
const configSyncChunkBytes = 8 << 10

// Keep the MCP fallback well below the 30-minute/120-request-per-minute budget.
// Larger envelopes must use the authenticated whole-envelope download.
const configSyncMaxMCPEnvelopeBytes = 8 << 20

type configSyncGrant struct {
	UserID     int
	SnapshotID string
	Revision   int
}
type configSyncContextKey struct{}

func (a *App) configSyncCreate(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	id := r.PathValue("snapshotId")
	if !validUUID(id) {
		httpx.ErrorCode(w, 400, "invalid_snapshot_id", "Invalid snapshot id")
		return
	}
	if !a.rateLimit().allow("config-sync-create:"+strconv.Itoa(user.ID), 10, time.Minute) {
		httpx.ErrorCode(w, 429, "rate_limited", "Please try again later")
		return
	}
	var input struct {
		Revision int `json:"revision"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&input); err != nil || input.Revision < 1 {
		httpx.ErrorCode(w, 400, "invalid_snapshot", "A current snapshot revision is required")
		return
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		configSyncServerError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	if _, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock($1)`, user.ID); err != nil {
		configSyncServerError(w, err)
		return
	}
	var sessionVersion int64
	if err = tx.QueryRow(r.Context(), `SELECT session_version FROM users WHERE id = $1 FOR SHARE`, user.ID).Scan(&sessionVersion); err != nil {
		configSyncServerError(w, err)
		return
	}
	if sessionVersion != user.SessionVersion {
		httpx.ErrorCode(w, 401, "session_expired", "Session expired")
		return
	}
	var desktopFamily *string
	if token := bearerToken(r); strings.HasPrefix(token, desktopAccessTokenPrefix) {
		hash := sha256.Sum256([]byte(token))
		err = tx.QueryRow(r.Context(), `SELECT rt.family_id::text FROM desktop_access_tokens at
			JOIN desktop_refresh_tokens rt ON rt.id = at.refresh_token_id
			WHERE at.token_hash = $1 AND at.user_id = $2 AND at.revoked_at IS NULL AND at.expires_at > now()`, hash[:], user.ID).Scan(&desktopFamily)
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.ErrorCode(w, 401, "session_expired", "Session expired")
			return
		}
		if err != nil {
			configSyncServerError(w, err)
			return
		}
	}
	var revision int
	err = tx.QueryRow(r.Context(), `SELECT revision FROM config_snapshots WHERE snapshot_id = $1 AND user_id = $2 FOR SHARE`, id, user.ID).Scan(&revision)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.ErrorCode(w, 404, "snapshot_not_found", "Snapshot not found")
		return
	}
	if err != nil {
		configSyncServerError(w, err)
		return
	}
	if revision != input.Revision {
		httpx.ErrorCode(w, 409, "config_snapshot_conflict", "Unlock the latest snapshot before copying")
		return
	}
	// Touch only this user's stale grants while holding their issuance lock.
	if _, err = tx.Exec(r.Context(), `DELETE FROM config_sync_grants WHERE user_id = $1 AND (expires_at <= now() OR session_version <> $2)`, user.ID, sessionVersion); err != nil {
		configSyncServerError(w, err)
		return
	}
	var count int
	if err = tx.QueryRow(r.Context(), `SELECT count(*) FROM config_sync_grants WHERE user_id = $1`, user.ID).Scan(&count); err != nil {
		configSyncServerError(w, err)
		return
	}
	if count >= configSyncMaxActive {
		httpx.ErrorCode(w, 429, "rate_limited", "Too many active sync grants; wait for an earlier grant to expire")
		return
	}
	secret, err := randomHex(32)
	if err != nil {
		configSyncServerError(w, err)
		return
	}
	token := configSyncTokenPrefix + secret
	hash := sha256.Sum256([]byte(token))
	expires := time.Now().UTC().Add(configSyncLifetime)
	_, err = tx.Exec(r.Context(), `INSERT INTO config_sync_grants (token_hash, user_id, snapshot_id, revision, expires_at, session_version, desktop_family_id) VALUES ($1, $2, $3, $4, $5, $6, $7)`, hash[:], user.ID, id, revision, expires, sessionVersion, desktopFamily)
	if err != nil {
		configSyncServerError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		configSyncServerError(w, err)
		return
	}
	base := strings.TrimRight(a.cfg.AppURL, "/")
	httpx.JSON(w, 201, map[string]any{"token": token, "expiresAt": expires, "snapshotId": id, "revision": revision, "mcpUrl": base + "/api/config-sync/mcp", "downloadUrl": base + "/api/config-sync/envelope"})
}

func configSyncServerError(w http.ResponseWriter, err error) {
	log.Printf("config sync: %v", err)
	httpx.ErrorCode(w, 500, "server_error", "Configuration sync is unavailable")
}

func (a *App) authorizeConfigSync(w http.ResponseWriter, r *http.Request) (configSyncGrant, bool) {
	w.Header().Set("Cache-Control", "no-store")
	var grant configSyncGrant
	if !a.validMCPOrigin(r) {
		http.Error(w, "forbidden origin", 403)
		return grant, false
	}
	token := bearerToken(r)
	suffix, found := strings.CutPrefix(token, configSyncTokenPrefix)
	if !found || len(suffix) != 64 {
		http.Error(w, "unauthorized", 401)
		return grant, false
	}
	if _, err := hex.DecodeString(suffix); err != nil {
		http.Error(w, "unauthorized", 401)
		return grant, false
	}
	hash := sha256.Sum256([]byte(token))
	err := a.db.QueryRow(r.Context(), `
        SELECT g.user_id, g.snapshot_id::text, g.revision FROM config_sync_grants g
        JOIN config_snapshots s ON s.snapshot_id = g.snapshot_id AND s.user_id = g.user_id
        JOIN users u ON u.id = g.user_id AND u.session_version = g.session_version
        WHERE g.token_hash = $1 AND g.expires_at > now()
        AND (g.desktop_family_id IS NULL OR EXISTS (
            SELECT 1 FROM desktop_refresh_tokens t WHERE t.family_id = g.desktop_family_id
            AND t.user_id = g.user_id AND t.session_version = u.session_version
            AND t.revoked_at IS NULL AND t.expires_at > now()))
    `, hash[:]).Scan(&grant.UserID, &grant.SnapshotID, &grant.Revision)
	if errors.Is(err, pgx.ErrNoRows) {
		http.Error(w, "unauthorized or expired sync token", 401)
		return grant, false
	}
	if err != nil {
		configSyncServerError(w, err)
		return grant, false
	}
	if !a.rateLimit().allow("config-sync:"+hex.EncodeToString(hash[:]), mcpRequestsPerMinute, time.Minute) {
		w.Header().Set("Retry-After", "60")
		http.Error(w, "rate limit exceeded", 429)
		return grant, false
	}
	return grant, true
}

func (a *App) configSyncDownload(w http.ResponseWriter, r *http.Request) {
	grant, ok := a.authorizeConfigSync(w, r)
	if !ok {
		return
	}
	var envelope []byte
	err := a.db.QueryRow(r.Context(), `SELECT envelope FROM config_snapshots WHERE snapshot_id = $1 AND user_id = $2 AND revision = $3`, grant.SnapshotID, grant.UserID, grant.Revision).Scan(&envelope)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.ErrorCode(w, 409, "config_snapshot_conflict", "Snapshot changed; copy a new sync instruction")
		return
	}
	if err != nil {
		configSyncServerError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Content-Length", strconv.Itoa(len(envelope)))
	w.Header().Set("Content-Disposition", `attachment; filename="koinote-config.encrypted.json"`)
	_, _ = w.Write(envelope)
}

func (a *App) configSyncMCPHandler() http.Handler {
	sdk := mcp.NewStreamableHTTPHandler(func(_ *http.Request) *mcp.Server {
		server := mcp.NewServer(&mcp.Implementation{Name: "koinote-config-sync", Version: mcpServerVersion}, &mcp.ServerOptions{SchemaCache: &a.mcpSchemaCache})
		readOnly := &mcp.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: boolPtr(false)}
		mcp.AddTool(server, &mcp.Tool{Name: "get_config_sync_snapshot", Description: "Describe the single encrypted configuration revision authorized by this temporary token. Prefer downloadUrl with the same Authorization Bearer header for large snapshots. Decrypt locally using the snapshot key the user supplied; the server never knows that key.", Annotations: readOnly}, a.mcpConfigSyncSnapshot)
		mcp.AddTool(server, &mcp.Tool{Name: "read_config_sync_envelope", Description: fmt.Sprintf("Read up to %d encrypted envelope bytes as base64 for envelopes at most %d bytes. Larger envelopes MUST use downloadUrl from get_config_sync_snapshot with the same Bearer token. Decode each chunk, concatenate in order and JSON-parse the envelope.", configSyncChunkBytes, configSyncMaxMCPEnvelopeBytes), Annotations: readOnly}, a.mcpConfigSyncRead)
		return server
	}, &mcp.StreamableHTTPOptions{Stateless: true, JSONResponse: true})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		grant, ok := a.authorizeConfigSync(w, r)
		if !ok {
			return
		}
		serveLimitedMCP(sdk, w, r.WithContext(context.WithValue(r.Context(), configSyncContextKey{}, grant)), mcpMaxRequestBytes)
	})
}

type configSyncInfo struct {
	SnapshotID          string `json:"snapshotId"`
	Revision            int    `json:"revision"`
	Name                string `json:"name"`
	Bytes               int64  `json:"bytes"`
	DownloadURL         string `json:"downloadUrl"`
	MaxMCPEnvelopeBytes int64  `json:"maxMcpEnvelopeBytes"`
}

func (a *App) mcpConfigSyncSnapshot(ctx context.Context, _ *mcp.CallToolRequest, _ struct{}) (*mcp.CallToolResult, configSyncInfo, error) {
	grant, ok := ctx.Value(configSyncContextKey{}).(configSyncGrant)
	if !ok {
		return nil, configSyncInfo{}, errors.New("unauthorized")
	}
	result := configSyncInfo{SnapshotID: grant.SnapshotID, Revision: grant.Revision, DownloadURL: strings.TrimRight(a.cfg.AppURL, "/") + "/api/config-sync/envelope"}
	result.MaxMCPEnvelopeBytes = configSyncMaxMCPEnvelopeBytes
	err := a.db.QueryRow(ctx, `SELECT name, octet_length(envelope) FROM config_snapshots WHERE snapshot_id = $1 AND user_id = $2 AND revision = $3`, grant.SnapshotID, grant.UserID, grant.Revision).Scan(&result.Name, &result.Bytes)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, configSyncInfo{}, errors.New("snapshot changed or deleted; copy a new sync instruction")
	}
	if err != nil {
		log.Printf("config sync MCP metadata: %v", err)
		return nil, configSyncInfo{}, errors.New("configuration sync is unavailable")
	}
	return nil, result, nil
}

type configSyncReadInput struct {
	Offset int64 `json:"offset,omitempty" jsonschema:"Byte offset, starting at zero."`
}
type configSyncReadOutput struct {
	ContentBase64 string `json:"contentBase64"`
	mcpAgentWorkspaceChunkRange
}

func (a *App) mcpConfigSyncRead(ctx context.Context, _ *mcp.CallToolRequest, input configSyncReadInput) (*mcp.CallToolResult, configSyncReadOutput, error) {
	grant, ok := ctx.Value(configSyncContextKey{}).(configSyncGrant)
	if !ok {
		return nil, configSyncReadOutput{}, errors.New("unauthorized")
	}
	if input.Offset < 0 || input.Offset > configSnapshotMaxEnvelopeBytes {
		return nil, configSyncReadOutput{}, errors.New("invalid byte offset")
	}
	var chunk []byte
	var size int64
	err := a.db.QueryRow(ctx, `SELECT substring(envelope FROM $4::integer FOR $5::integer), octet_length(envelope) FROM config_snapshots WHERE snapshot_id = $1 AND user_id = $2 AND revision = $3`, grant.SnapshotID, grant.UserID, grant.Revision, input.Offset+1, configSyncChunkBytes).Scan(&chunk, &size)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, configSyncReadOutput{}, errors.New("snapshot changed or deleted; copy a new sync instruction")
	}
	if err != nil {
		log.Printf("config sync MCP read: %v", err)
		return nil, configSyncReadOutput{}, errors.New("configuration sync is unavailable")
	}
	if input.Offset > size {
		return nil, configSyncReadOutput{}, errors.New("offset exceeds envelope length")
	}
	if size > configSyncMaxMCPEnvelopeBytes {
		return nil, configSyncReadOutput{}, errors.New("envelope too large for MCP chunk transfer; use downloadUrl from get_config_sync_snapshot with the same Authorization Bearer token")
	}
	return nil, configSyncReadOutput{ContentBase64: base64.StdEncoding.EncodeToString(chunk), mcpAgentWorkspaceChunkRange: newMCPAgentWorkspaceChunkRange(input.Offset, int64(len(chunk)), size)}, nil
}

func (a *App) configSyncRevoke(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	id := r.PathValue("snapshotId")
	if !validUUID(id) {
		httpx.ErrorCode(w, 400, "invalid_snapshot_id", "Invalid snapshot id")
		return
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		configSyncServerError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	if _, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock($1)`, user.ID); err != nil {
		configSyncServerError(w, err)
		return
	}
	var exists bool
	if err = tx.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM config_snapshots WHERE snapshot_id = $1 AND user_id = $2)`, id, user.ID).Scan(&exists); err != nil {
		configSyncServerError(w, err)
		return
	}
	if !exists {
		httpx.ErrorCode(w, 404, "snapshot_not_found", "Snapshot not found")
		return
	}
	if _, err = tx.Exec(r.Context(), `DELETE FROM config_sync_grants WHERE snapshot_id = $1 AND user_id = $2`, id, user.ID); err != nil {
		configSyncServerError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		configSyncServerError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]bool{"success": true})
}

func (a *App) cleanupConfigSyncGrants(ctx context.Context) error {
	_, err := a.db.Exec(ctx, `DELETE FROM config_sync_grants WHERE token_hash IN (
		SELECT token_hash FROM config_sync_grants WHERE expires_at <= now()
		ORDER BY expires_at LIMIT 500 FOR UPDATE SKIP LOCKED)`)
	return err
}

func (a *App) StartConfigSyncCleanup(ctx context.Context) {
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			if err := a.cleanupConfigSyncGrants(ctx); err != nil && ctx.Err() == nil {
				log.Printf("config sync cleanup: %v", err)
			}
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
}
