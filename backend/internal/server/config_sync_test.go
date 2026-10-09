package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"koinote/backend/internal/config"
)

func TestConfigSyncGrantIntegration(t *testing.T) {
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "config-sync-test", AppURL: "https://koinote.example"}, pool)
	owner := seedMCPUser(t, pool, app, "free")
	other := seedMCPUser(t, pool, app, "free")
	cookie := sessionCookieFor(t, app, owner.AuthUserID, owner.SessionVersion)
	otherCookie := sessionCookieFor(t, app, other.AuthUserID, other.SessionVersion)
	ctx := context.Background()
	envelope, _ := json.Marshal(map[string]any{
		"version": 1, "kdf": "PBKDF2-SHA-256", "iterations": 310000,
		"salt": base64.StdEncoding.EncodeToString(make([]byte, 16)), "iv": base64.StdEncoding.EncodeToString(make([]byte, 12)),
		"ciphertext": base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{42}, configSyncChunkBytes*3)),
	})
	payload, _ := json.Marshal(configSnapshotCreateInput{Name: "Private configs", FileCount: 1, EnvelopeVersion: 1, Envelope: string(envelope)})
	created := callLLMChannelAPI(t, app, cookie, http.MethodPost, "/api/config-snapshots", string(payload))
	if created.Code != 201 {
		t.Fatalf("create: %d %s", created.Code, created.Body)
	}
	var snapshot struct {
		Snapshot configSnapshotSummary `json:"snapshot"`
	}
	decodeJSONResponse(t, created, &snapshot)
	endpoint := "/api/config-snapshots/" + snapshot.Snapshot.SnapshotID + "/agent-sync"
	for _, tc := range []struct {
		cookie *http.Cookie
		body   string
		status int
	}{
		{&http.Cookie{Name: "unused", Value: "unauthenticated"}, `{"revision":1}`, 401}, {otherCookie, `{"revision":1}`, 404}, {cookie, `{"revision":2}`, 409}, {cookie, `{}`, 400},
	} {
		response := callLLMChannelAPI(t, app, tc.cookie, http.MethodPost, endpoint, tc.body)
		if response.Code != tc.status {
			t.Fatalf("grant expected %d got %d: %s", tc.status, response.Code, response.Body)
		}
	}
	response := callLLMChannelAPI(t, app, cookie, http.MethodPost, endpoint, `{"revision":1}`)
	if response.Code != 201 {
		t.Fatalf("grant: %d %s", response.Code, response.Body)
	}
	var grant struct {
		Token     string    `json:"token"`
		ExpiresAt time.Time `json:"expiresAt"`
		MCPURL    string    `json:"mcpUrl"`
	}
	decodeJSONResponse(t, response, &grant)
	if !strings.HasPrefix(grant.Token, configSyncTokenPrefix) || time.Until(grant.ExpiresAt) < 29*time.Minute || time.Until(grant.ExpiresAt) > configSyncLifetime {
		t.Fatal("incorrect temporary grant lifetime or token prefix")
	}
	if grant.MCPURL != "https://koinote.example/api/config-sync/mcp" {
		t.Fatal("wrong MCP endpoint")
	}
	server := httptest.NewServer(app.Routes())
	defer server.Close()
	request := func(method, path, token string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		recorder := httptest.NewRecorder()
		app.Routes().ServeHTTP(recorder, req)
		return recorder
	}
	downloaded := request("GET", "/api/config-sync/envelope", grant.Token)
	if downloaded.Code != 200 || !bytes.Equal(downloaded.Body.Bytes(), envelope) || downloaded.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("encrypted download did not round-trip")
	}
	// A sync grant never acts as a browser, desktop, repository or document token.
	for _, path := range []string{"/api/config-snapshots", "/api/config-snapshots/" + snapshot.Snapshot.SnapshotID, "/api/agent/workspaces", "/api/documents", "/mcp"} {
		if got := request("GET", path, grant.Token).Code; got < 400 {
			t.Fatalf("sync token escaped scope via %s: %d", path, got)
		}
	}
	if got := request("POST", endpoint, grant.Token).Code; got != 401 {
		t.Fatalf("grant minted another token: %d", got)
	}
	if got := request("GET", "/api/config-sync/envelope", "knt_agent_"+strings.Repeat("a", 64)).Code; got != 401 {
		t.Fatal("repository token accepted for encrypted configs")
	}
	session, err := connectMCPClient(ctx, server.URL+"/api/config-sync/mcp", grant.Token)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	assertMCPToolSet(t, session, []string{"get_config_sync_snapshot", "read_config_sync_envelope"})
	var info configSyncInfo
	decodeMCPStructured(t, callMCPToolOK(t, session, "get_config_sync_snapshot", map[string]any{}), &info)
	if info.SnapshotID != snapshot.Snapshot.SnapshotID || info.Revision != 1 || info.Bytes != int64(len(envelope)) {
		t.Fatalf("wrong snapshot info: %+v", info)
	}
	var combined []byte
	for offset := int64(0); ; {
		result := callMCPToolOK(t, session, "read_config_sync_envelope", map[string]any{"offset": offset})
		serialized, _ := json.Marshal(result)
		if len(serialized) >= 32<<10 {
			t.Fatalf("oversized MCP chunk: %d", len(serialized))
		}
		var chunk configSyncReadOutput
		decodeMCPStructured(t, result, &chunk)
		decoded, err := base64.StdEncoding.DecodeString(chunk.ContentBase64)
		if err != nil {
			t.Fatal(err)
		}
		combined = append(combined, decoded...)
		if !chunk.HasMore {
			break
		}
		offset = *chunk.NextOffset
	}
	if !bytes.Equal(combined, envelope) {
		t.Fatal("MCP chunks did not round-trip")
	}
	for _, offset := range []int64{-1, int64(len(envelope)) + 1, configSnapshotMaxEnvelopeBytes + 1} {
		if !callMCPTool(t, session, "read_config_sync_envelope", map[string]any{"offset": offset}).IsError {
			t.Fatalf("invalid offset accepted: %d", offset)
		}
	}
	// Reads recheck the revision, including when it changes after MCP initialize.
	if _, err = pool.Exec(ctx, `UPDATE config_snapshots SET revision = revision + 1 WHERE snapshot_id = $1`, info.SnapshotID); err != nil {
		t.Fatal(err)
	}
	if !callMCPTool(t, session, "get_config_sync_snapshot", map[string]any{}).IsError {
		t.Fatal("stale MCP grant read a new revision")
	}
	if got := request("GET", "/api/config-sync/envelope", grant.Token).Code; got != 409 {
		t.Fatalf("stale grant status: %d", got)
	}
	hash := sha256.Sum256([]byte(grant.Token))
	if _, err = pool.Exec(ctx, `UPDATE config_sync_grants SET expires_at = now() - interval '1 second' WHERE token_hash = $1`, hash[:]); err != nil {
		t.Fatal(err)
	}
	if got := request("GET", "/api/config-sync/envelope", grant.Token).Code; got != 401 {
		t.Fatalf("expired grant status: %d", got)
	}
	// The dedicated endpoint rejects chunked oversized requests with the normal 413 guard.
	renewed := callLLMChannelAPI(t, app, cookie, http.MethodPost, endpoint, `{"revision":2}`)
	if renewed.Code != 201 {
		t.Fatalf("renew grant: %d %s", renewed.Code, renewed.Body)
	}
	decodeJSONResponse(t, renewed, &grant)
	req := httptest.NewRequest("POST", "/api/config-sync/mcp", io.NopCloser(strings.NewReader(strings.Repeat(" ", mcpMaxRequestBytes+1))))
	req.ContentLength = -1
	req.Header.Set("Authorization", "Bearer "+grant.Token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	recorder := httptest.NewRecorder()
	app.Routes().ServeHTTP(recorder, req)
	if recorder.Code != 413 {
		t.Fatalf("chunked limit: %d %s", recorder.Code, recorder.Body)
	}
	if _, err = pool.Exec(ctx, `DELETE FROM config_snapshots WHERE snapshot_id = $1`, info.SnapshotID); err != nil {
		t.Fatal(err)
	}
	if got := request("GET", "/api/config-sync/envelope", grant.Token).Code; got != 401 {
		t.Fatalf("deleted grant status: %d", got)
	}
}

func TestConfigSyncRevocationAndTransferLimits(t *testing.T) {
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "config-sync-revocation-test", AppURL: "https://koinote.example"}, pool)
	owner := seedMCPUser(t, pool, app, "free")
	other := seedMCPUser(t, pool, app, "free")
	ctx := context.Background()
	cookie := sessionCookieFor(t, app, owner.AuthUserID, owner.SessionVersion)
	otherCookie := sessionCookieFor(t, app, other.AuthUserID, other.SessionVersion)
	id, err := randomUUID()
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO config_snapshots (snapshot_id, user_id, name, revision, file_count, envelope_version, envelope, bytes) VALUES ($1, $2, 'Sync', 1, 1, 1, $3, $4)`, id, owner.ID, []byte(`{"encrypted":"fixture"}`), 23); err != nil {
		t.Fatal(err)
	}
	endpoint := "/api/config-snapshots/" + id + "/agent-sync"
	request := func(method, path, token, body string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept", "application/json, text/event-stream")
		result := httptest.NewRecorder()
		app.Routes().ServeHTTP(result, req)
		return result
	}
	issue := func(t *testing.T, desktopToken string) string {
		t.Helper()
		var result *httptest.ResponseRecorder
		if desktopToken == "" {
			result = callLLMChannelAPI(t, app, cookie, "POST", endpoint, `{"revision":1}`)
		} else {
			result = request("POST", endpoint, desktopToken, `{"revision":1}`)
		}
		if result.Code != 201 {
			t.Fatalf("issue: %d %s", result.Code, result.Body)
		}
		var grant struct {
			Token string `json:"token"`
		}
		decodeJSONResponse(t, result, &grant)
		return grant.Token
	}
	assertRevoked := func(t *testing.T, token string) {
		t.Helper()
		for _, path := range []string{"/api/config-sync/envelope", "/api/config-sync/mcp"} {
			if got := request("GET", path, token, "").Code; got != 401 {
				t.Fatalf("revoked grant accepted by %s: %d", path, got)
			}
		}
	}

	t.Run("owner can revoke every grant for a snapshot", func(t *testing.T) {
		first, second := issue(t, ""), issue(t, "")
		if got := callLLMChannelAPI(t, app, otherCookie, "DELETE", endpoint, "").Code; got != 404 {
			t.Fatalf("cross-user revoke: %d", got)
		}
		if got := request("GET", "/api/config-sync/envelope", first, "").Code; got != 200 {
			t.Fatalf("unexpected rejection: %d", got)
		}
		if got := callLLMChannelAPI(t, app, cookie, "DELETE", endpoint, "").Code; got != 200 {
			t.Fatalf("revoke: %d", got)
		}
		assertRevoked(t, first)
		assertRevoked(t, second)
	})
	t.Run("password change and global session invalidation", func(t *testing.T) {
		token := issue(t, "")
		// Password changes and global sign-out both increment this version.
		if _, err := pool.Exec(ctx, `UPDATE users SET session_version = session_version + 1 WHERE id = $1`, owner.ID); err != nil {
			t.Fatal(err)
		}
		assertRevoked(t, token)
		cookie = sessionCookieFor(t, app, owner.AuthUserID, owner.SessionVersion+1)
	})
	t.Run("desktop rotation preserves grant and logout revokes family", func(t *testing.T) {
		pair, err := app.issueDesktopTokenPair(ctx, pool, owner.ID, "")
		if err != nil {
			t.Fatal(err)
		}
		token := issue(t, pair.AccessToken)
		rotated, err := app.rotateDesktopRefreshToken(ctx, pair.RefreshToken)
		if err != nil {
			t.Fatal(err)
		}
		if got := request("GET", "/api/config-sync/envelope", token, "").Code; got != 200 {
			t.Fatalf("rotation invalidated grant: %d", got)
		}
		// Normal rotation replaces the access token but preserves the family grant.
		if got := request("POST", "/api/auth/desktop/revoke", rotated.AccessToken, "").Code; got != 200 {
			t.Fatalf("desktop logout: %d", got)
		}
		assertRevoked(t, token)
		if _, err := app.rotateDesktopRefreshToken(ctx, rotated.RefreshToken); err == nil {
			t.Fatal("logged-out family was refreshable")
		}
		pair, err = app.issueDesktopTokenPair(ctx, pool, owner.ID, "")
		if err != nil {
			t.Fatal(err)
		}
		token = issue(t, pair.AccessToken)
		if got := request("DELETE", endpoint, pair.AccessToken, "").Code; got != 200 {
			t.Fatalf("desktop revoke API: %d", got)
		}
		assertRevoked(t, token)
	})
	t.Run("large envelope requires whole download", func(t *testing.T) {
		token := issue(t, "")
		grantCtx := context.WithValue(ctx, configSyncContextKey{}, configSyncGrant{UserID: owner.ID, SnapshotID: id, Revision: 1})
		boundary := bytes.Repeat([]byte("A"), configSyncMaxMCPEnvelopeBytes)
		if _, err := pool.Exec(ctx, `UPDATE config_snapshots SET envelope = $1, bytes = $2 WHERE snapshot_id = $3`, boundary, len(boundary), id); err != nil {
			t.Fatal(err)
		}
		_, chunk, err := app.mcpConfigSyncRead(grantCtx, nil, configSyncReadInput{Offset: configSyncMaxMCPEnvelopeBytes - 5})
		if err != nil || chunk.HasMore || chunk.ContentBase64 != base64.StdEncoding.EncodeToString([]byte("AAAAA")) {
			t.Fatalf("MCP size boundary: %+v %v", chunk, err)
		}
		large := append([]byte(`{"ciphertext":"`), bytes.Repeat([]byte("A"), configSnapshotMaxEnvelopeBytes-len(`{"ciphertext":""}`))...)
		large = append(large, []byte(`"}`)...)
		if len(large) != configSnapshotMaxEnvelopeBytes {
			t.Fatal("fixture must reach full envelope limit")
		}
		if _, err := pool.Exec(ctx, `UPDATE config_snapshots SET envelope = $1, bytes = $2 WHERE snapshot_id = $3`, large, len(large), id); err != nil {
			t.Fatal(err)
		}
		_, info, err := app.mcpConfigSyncSnapshot(grantCtx, nil, struct{}{})
		if err != nil || info.MaxMCPEnvelopeBytes != configSyncMaxMCPEnvelopeBytes || info.Bytes != int64(len(large)) {
			t.Fatalf("metadata: %+v %v", info, err)
		}
		_, _, err = app.mcpConfigSyncRead(grantCtx, nil, configSyncReadInput{})
		if err == nil || !strings.Contains(err.Error(), "downloadUrl") {
			t.Fatalf("large MCP fallback was allowed: %v", err)
		}
		response := request("GET", "/api/config-sync/envelope", token, "")
		if response.Code != 200 || !bytes.Equal(response.Body.Bytes(), large) {
			t.Fatalf("large download: %d", response.Code)
		}
		if got := request("POST", "/api/config-sync/mcp", token, strings.Repeat(" ", mcpMaxRequestBytes+1)).Code; got != 413 {
			t.Fatalf("known-length request limit: %d", got)
		}
	})
	t.Run("issuance does not clean another user and background cleanup does", func(t *testing.T) {
		otherID, _ := randomUUID()
		if _, err := pool.Exec(ctx, `INSERT INTO config_snapshots (snapshot_id, user_id, name, revision, file_count, envelope_version, envelope, bytes) VALUES ($1, $2, 'Other', 1, 1, 1, $3, 2)`, otherID, other.ID, []byte(`{}`)); err != nil {
			t.Fatal(err)
		}
		hash := sha256.Sum256([]byte("expired-fixture"))
		if _, err := pool.Exec(ctx, `INSERT INTO config_sync_grants (token_hash, user_id, snapshot_id, revision, expires_at, session_version) VALUES ($1, $2, $3, 1, now() - interval '1 second', $4)`, hash[:], other.ID, otherID, other.SessionVersion); err != nil {
			t.Fatal(err)
		}
		token := issue(t, "")
		var count int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM config_sync_grants WHERE token_hash = $1`, hash[:]).Scan(&count); err != nil || count != 1 {
			t.Fatalf("issuance touched another user: %d %v", count, err)
		}
		if err := app.cleanupConfigSyncGrants(ctx); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM config_sync_grants WHERE token_hash = $1`, hash[:]).Scan(&count); err != nil || count != 0 {
			t.Fatalf("cleanup: %d %v", count, err)
		}
		if got := request("GET", "/api/config-sync/envelope", token, "").Code; got != 200 {
			t.Fatalf("cleanup removed live grant: %d", got)
		}
	})
}
