package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"koinote/backend/internal/config"
	"koinote/backend/internal/migrations"
)

func TestDesktopAuthorizationValidation(t *testing.T) {
	if bearerToken(httptest.NewRequest(http.MethodGet, "/", nil)) != "" {
		t.Fatal("missing Authorization header must not produce a token")
	}
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "bEaReR token-value")
	if got := bearerToken(req); got != "token-value" {
		t.Fatalf("bearer token = %q", got)
	}
	for _, invalid := range []string{"", "short", strings.Repeat("a", 42), strings.Repeat("a", 129), "bad+character" + strings.Repeat("a", 40)} {
		if pkceValuePattern.MatchString(invalid) {
			t.Fatalf("invalid PKCE value accepted: %q", invalid)
		}
	}
	if !pkceValuePattern.MatchString(strings.Repeat("a", 43)) {
		t.Fatal("43-character PKCE value should be accepted")
	}
	if !validUUID("123e4567-e89b-42d3-a456-426614174000") || validUUID("123e4567-e89b-12d3-a456-426614174000") {
		t.Fatal("desktop client IDs must be canonical UUID v4 values")
	}
	for _, test := range []struct {
		method  string
		path    string
		allowed bool
	}{
		{http.MethodGet, "/api/auth/session", true},
		{http.MethodGet, "/api/billing/status", true},
		{http.MethodPost, "/api/documents", true},
		{http.MethodGet, "/api/documents", true},
		{http.MethodGet, "/api/documents/search", true},
		{http.MethodGet, "/api/documents/trash", true},
		{http.MethodGet, "/api/documents/doc-id", true},
		{http.MethodPut, "/api/documents/doc-id", true},
		{http.MethodDelete, "/api/documents/doc-id", true},
		{http.MethodPut, "/api/documents/doc-id/folder", true},
		{http.MethodPost, "/api/documents/doc-id/restore", true},
		{http.MethodPost, "/api/documents/doc-id/share", true},
		{http.MethodDelete, "/api/documents/doc-id/share", true},
		{http.MethodGet, "/api/documents/doc-id/versions", true},
		{http.MethodGet, "/api/documents/doc-id/versions/2", true},
		{http.MethodPost, "/api/documents/doc-id/versions/2/restore", true},
		{http.MethodDelete, "/api/documents/doc-id/permanent", true},
		{http.MethodGet, "/api/folders", true},
		{http.MethodPost, "/api/folders", true},
		{http.MethodPut, "/api/folders/folder-id", true},
		{http.MethodDelete, "/api/folders/folder-id", true},
		{http.MethodDelete, "/api/folders/folder-id/empty", true},
		{http.MethodPut, "/api/folders/folder-id/parent", true},
		{http.MethodGet, "/api/editor/tabs", true},
		{http.MethodPut, "/api/editor/tabs", true},
		{http.MethodGet, "/api/storage/usage", true},
		{http.MethodGet, "/api/invitations", true},
		{http.MethodPost, "/api/analytics/events", true},
		{http.MethodGet, "/api/settings/document-history", true},
		{http.MethodPut, "/api/settings/document-history", true},
		{http.MethodPost, "/api/billing/checkout", true},
		{http.MethodPost, "/api/billing/checkout/confirm", true},
		{http.MethodGet, "/api/mcp/tokens", true},
		{http.MethodPost, "/api/mcp/tokens", true},
		{http.MethodPatch, "/api/mcp/tokens/token-id", true},
		{http.MethodDelete, "/api/mcp/tokens/token-id", true},
		{http.MethodPost, "/api/mcp/tokens/token-id/reveal", true},
		{http.MethodGet, "/api/mcp/tokens/token-id/reveal", false},
		{http.MethodGet, "/api/mcp/activity", true},
		{http.MethodPost, "/api/mcp/activity", false},
		{http.MethodGet, "/api/agent/settings", true},
		{http.MethodPut, "/api/agent/settings", true},
		{http.MethodPost, "/api/agent/settings", false},
		{http.MethodGet, "/api/agent/channels", true},
		{http.MethodPost, "/api/agent/channels", true},
		{http.MethodPut, "/api/agent/channels/channel-id", true},
		{http.MethodDelete, "/api/agent/channels/channel-id", true},
		{http.MethodGet, "/api/agent/channels/channel-id", false},
		{http.MethodGet, "/api/agent/credits", true},
		{http.MethodPost, "/api/agent/credits", false},
		{http.MethodPost, "/api/agent/credits/checkout", true},
		{http.MethodGet, "/api/agent/credits/checkout", false},
		{http.MethodPost, "/api/agent/credits/checkout/confirm", true},
		{http.MethodGet, "/api/agent/credits/checkout/confirm", false},
		{http.MethodGet, "/api/documents/doc-id/agent-reviews", true},
		{http.MethodPost, "/api/documents/doc-id/agent-reviews", true},
		{http.MethodDelete, "/api/documents/doc-id/agent-reviews", false},
		{http.MethodGet, "/api/agent/reviews/review-id", true},
		{http.MethodPost, "/api/agent/reviews/review-id", false},
		{http.MethodPost, "/api/agent/reviews/review-id/apply-all", true},
		{http.MethodPost, "/api/agent/reviews/review-id/dismiss", true},
		{http.MethodPost, "/api/agent/reviews/review-id/suggestions/suggestion-id/apply", true},
		{http.MethodPost, "/api/agent/reviews/review-id/suggestions/suggestion-id/dismiss", true},
		{http.MethodGet, "/api/agent/reviews/review-id/suggestions/suggestion-id/apply", false},
		{http.MethodGet, "/api/admin/stats", true},
		{http.MethodPost, "/api/admin/stats", false},
		{http.MethodGet, "/api/admin/server-status", true},
		{http.MethodPost, "/api/admin/server-status", false},
		{http.MethodGet, "/api/admin/announcements", true},
		{http.MethodPost, "/api/admin/announcements", true},
		{http.MethodDelete, "/api/admin/announcements/42", true},
		{http.MethodGet, "/api/admin/announcements/42", false},
		{http.MethodGet, "/api/announcements/unread?locale=zh", true},
		{http.MethodPost, "/api/announcements/42/read", true},
		{http.MethodGet, "/api/announcements/42/read", false},
		{http.MethodPost, "/api/auth/password", false},
		{http.MethodPost, "/api/auth/sessions/invalidate", false},
		{http.MethodPost, "/api/billing/webhook", false},
		{http.MethodPost, "/api/images/record", false},
	} {
		req := httptest.NewRequest(test.method, test.path, nil)
		if got := desktopRequestAllowed(req); got != test.allowed {
			t.Errorf("desktopRequestAllowed(%s %s)=%v want=%v", test.method, test.path, got, test.allowed)
		}
	}
}

func TestDesktopAuthorizationEndToEnd(t *testing.T) {
	dsn := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set; CI runs the desktop authorization integration test")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("connect database: %v", err)
	}
	defer pool.Close()
	if err := migrations.Apply(ctx, pool, "../../migrations"); err != nil {
		t.Fatalf("apply migrations: %v", err)
	}

	suffix, err := randomHex(8)
	if err != nil {
		t.Fatal(err)
	}
	authUserID := "desktop-test-" + suffix
	var userID int
	if err := pool.QueryRow(ctx, `
		INSERT INTO users (
			auth_user_id, email, is_verified, is_admin,
			membership_tier, membership_granted_at
		)
		VALUES ($1, $2, true, true, 'lifetime', now()) RETURNING id
	`, authUserID, authUserID+"@example.test").Scan(&userID); err != nil {
		t.Fatalf("seed user: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, userID)
	})

	app := New(config.Config{
		SessionSecret:   "desktop-test-session-secret",
		ImageQuotaBytes: 500 * 1024 * 1024,
	}, pool)
	handler := app.Routes()
	largeTokenRequest := httptest.NewRequest(
		http.MethodPost,
		"/api/auth/desktop/token",
		strings.NewReader(`{"grantType":"`+strings.Repeat("x", authBodyMax)+`"}`),
	)
	largeTokenRequest.Header.Set("Content-Type", "application/json")
	largeTokenResponse := httptest.NewRecorder()
	handler.ServeHTTP(largeTokenResponse, largeTokenRequest)
	if largeTokenResponse.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized token request status=%d body=%s", largeTokenResponse.Code, largeTokenResponse.Body.String())
	}
	sessionValue, _ := app.signSession(authUserID, 1)
	sessionCookie := &http.Cookie{Name: sessionCookieName, Value: sessionValue, Path: "/"}
	verifier := strings.Repeat("v", 64)
	verifierHash := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(verifierHash[:])

	authorize := func(state string) string {
		t.Helper()
		body := `{"clientId":"` + desktopClientID + `","codeChallenge":"` + challenge + `","state":"` + state + `"}`
		req := httptest.NewRequest(http.MethodPost, "/api/auth/desktop/authorize", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(sessionCookie)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Header().Get("Cache-Control") != "no-store" {
			t.Fatalf("authorize cache-control=%q", rec.Header().Get("Cache-Control"))
		}
		if rec.Code != http.StatusOK {
			t.Fatalf("authorize status=%d body=%s", rec.Code, rec.Body.String())
		}
		var response struct {
			RedirectURI string `json:"redirectUri"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		callback, err := url.Parse(response.RedirectURI)
		if err != nil || callback.Scheme != "koinote" || callback.Host != "auth" {
			t.Fatalf("invalid callback %q: %v", response.RedirectURI, err)
		}
		if callback.Query().Get("state") != state {
			t.Fatalf("callback state=%q", callback.Query().Get("state"))
		}
		return callback.Query().Get("code")
	}

	exchange := func(body string, expectedStatus int) desktopTokenResponse {
		t.Helper()
		req := httptest.NewRequest(http.MethodPost, "/api/auth/desktop/token", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Header().Get("Cache-Control") != "no-store" || rec.Header().Get("Pragma") != "no-cache" {
			t.Fatalf("token cache headers cache-control=%q pragma=%q", rec.Header().Get("Cache-Control"), rec.Header().Get("Pragma"))
		}
		if rec.Code != expectedStatus {
			t.Fatalf("token status=%d want=%d body=%s", rec.Code, expectedStatus, rec.Body.String())
		}
		if expectedStatus != http.StatusOK {
			return desktopTokenResponse{}
		}
		var response desktopTokenResponse
		if err := json.Unmarshal(rec.Body.Bytes(), &response); err != nil {
			t.Fatal(err)
		}
		return response
	}

	accessSessionStatus := func(accessToken string) int {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "/api/auth/session", nil)
		req.Header.Set("Authorization", "Bearer "+accessToken)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec.Code
	}
	authenticatedJSON := func(accessToken, method, path, body string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+accessToken)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}

	code := authorize("state-one")
	if !strings.HasPrefix(code, desktopAuthorizationPrefix) {
		t.Fatalf("authorization code prefix missing: %q", code)
	}
	codeHash := sha256.Sum256([]byte(code))
	var storedCodeHash []byte
	if err := pool.QueryRow(ctx, `
		SELECT code_hash FROM desktop_authorization_codes
		WHERE user_id = $1
	`, userID).Scan(&storedCodeHash); err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(storedCodeHash, []byte(code)) || !bytes.Equal(storedCodeHash, codeHash[:]) {
		t.Fatal("authorization code must be stored only as its SHA-256 hash")
	}
	pair1 := exchange(`{"grantType":"authorization_code","clientId":"`+desktopClientID+`","code":"`+code+`","codeVerifier":"`+verifier+`"}`, http.StatusOK)
	if pair1.User.AuthUserID != authUserID || pair1.ExpiresInSeconds != int(desktopAccessTokenTTL.Seconds()) {
		t.Fatalf("unexpected token response: %+v", pair1)
	}
	if status := accessSessionStatus(pair1.AccessToken); status != http.StatusOK {
		t.Fatalf("access token session status=%d", status)
	}
	for _, allowedPath := range []string{
		"/api/admin/stats",
		"/api/admin/server-status",
		"/api/billing/pricing",
		"/api/mcp/tokens",
		"/api/agent/settings",
		"/api/agent/channels",
		"/api/agent/credits",
	} {
		rec := authenticatedJSON(pair1.AccessToken, http.MethodGet, allowedPath, "")
		if rec.Code != http.StatusOK {
			t.Fatalf("desktop scope %s status=%d body=%s", allowedPath, rec.Code, rec.Body.String())
		}
	}
	checkout := authenticatedJSON(pair1.AccessToken, http.MethodPost, "/api/billing/checkout", `{ "currency": "usd" }`)
	if checkout.Code != http.StatusServiceUnavailable {
		t.Fatalf("desktop checkout should pass scope before config validation: status=%d body=%s", checkout.Code, checkout.Body.String())
	}
	for _, test := range []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodPost, "/api/auth/password", `{ "currentPassword": "old", "newPassword": "new-password" }`},
		{http.MethodPost, "/api/auth/sessions/invalidate", ""},
	} {
		forbidden := authenticatedJSON(pair1.AccessToken, test.method, test.path, test.body)
		if forbidden.Code != http.StatusForbidden {
			t.Fatalf("desktop restricted endpoint %s %s status=%d body=%s", test.method, test.path, forbidden.Code, forbidden.Body.String())
		}
	}

	// Authorization codes are single-use even when every request field is repeated.
	exchange(`{"grantType":"authorization_code","clientId":"`+desktopClientID+`","code":"`+code+`","codeVerifier":"`+verifier+`"}`, http.StatusUnauthorized)

	pair2 := exchange(`{"grantType":"refresh_token","clientId":"`+desktopClientID+`","refreshToken":"`+pair1.RefreshToken+`"}`, http.StatusOK)
	if pair2.RefreshToken == pair1.RefreshToken || pair2.AccessToken == pair1.AccessToken {
		t.Fatal("refresh must rotate both opaque tokens")
	}
	if status := accessSessionStatus(pair1.AccessToken); status != http.StatusUnauthorized {
		t.Fatalf("old access token status=%d after refresh", status)
	}
	pair1RefreshHash := sha256.Sum256([]byte(pair1.RefreshToken))
	if _, err := pool.Exec(ctx, `
		UPDATE desktop_refresh_tokens
		SET revoked_at = now() - interval '25 hours'
		WHERE token_hash = $1
	`, pair1RefreshHash[:]); err != nil {
		t.Fatal(err)
	}
	cleanupCode := authorize("state-cleanup")
	exchange(`{"grantType":"authorization_code","clientId":"`+desktopClientID+`","code":"`+cleanupCode+`","codeVerifier":"`+verifier+`"}`, http.StatusOK)
	var rotatedTokenRetained bool
	if err := pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM desktop_refresh_tokens
			WHERE token_hash = $1 AND expires_at > now()
		)
	`, pair1RefreshHash[:]).Scan(&rotatedTokenRetained); err != nil {
		t.Fatal(err)
	}
	if !rotatedTokenRetained {
		t.Fatal("rotated refresh token must remain until expiry so delayed replay can revoke its family")
	}

	folderID, err := randomUUID()
	if err != nil {
		t.Fatal(err)
	}
	folderBody := `{"folderId":"` + folderID + `","name":"Offline","organizerKind":"smart"}`
	for attempt := 1; attempt <= 2; attempt++ {
		rec := authenticatedJSON(pair2.AccessToken, http.MethodPost, "/api/folders", folderBody)
		if rec.Code != http.StatusOK {
			t.Fatalf("idempotent folder create attempt %d status=%d body=%s", attempt, rec.Code, rec.Body.String())
		}
	}
	var storedOrganizerKind string
	if err := pool.QueryRow(ctx, `SELECT organizer_kind FROM folders WHERE folder_id = $1`, folderID).Scan(&storedOrganizerKind); err != nil {
		t.Fatal(err)
	}
	if storedOrganizerKind != folderOrganizerSmart {
		t.Fatalf("desktop-created folder organizer kind=%q", storedOrganizerKind)
	}
	docID, err := randomUUID()
	if err != nil {
		t.Fatal(err)
	}
	documentBody := `{"docId":"` + docID + `","title":"Offline draft","theme":"github","content":"body","folderId":"` + folderID + `"}`
	for attempt := 1; attempt <= 2; attempt++ {
		rec := authenticatedJSON(pair2.AccessToken, http.MethodPost, "/api/documents", documentBody)
		if rec.Code != http.StatusOK {
			t.Fatalf("idempotent document create attempt %d status=%d body=%s", attempt, rec.Code, rec.Body.String())
		}
	}
	occupiedDelete := authenticatedJSON(pair2.AccessToken, http.MethodDelete, "/api/folders/"+folderID+"/empty", "")
	if occupiedDelete.Code != http.StatusOK {
		t.Fatalf("occupied organizer folder delete status=%d body=%s", occupiedDelete.Code, occupiedDelete.Body.String())
	}
	var occupiedFolderExists bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM folders WHERE folder_id = $1)`, folderID).Scan(&occupiedFolderExists); err != nil {
		t.Fatal(err)
	}
	if !occupiedFolderExists {
		t.Fatal("empty-only deletion removed an occupied organizer folder")
	}
	var storedTheme string
	if err := pool.QueryRow(ctx, `SELECT theme FROM documents WHERE doc_id = $1`, docID).Scan(&storedTheme); err != nil {
		t.Fatal(err)
	}
	if storedTheme != "github" {
		t.Fatalf("desktop-created document theme=%q", storedTheme)
	}
	conflict := authenticatedJSON(pair2.AccessToken, http.MethodPost, "/api/documents",
		`{"docId":"`+docID+`","title":"Different","content":"body"}`)
	if conflict.Code != http.StatusConflict {
		t.Fatalf("different document retry status=%d body=%s", conflict.Code, conflict.Body.String())
	}
	trash := authenticatedJSON(pair2.AccessToken, http.MethodDelete, "/api/documents/"+docID, "")
	if trash.Code != http.StatusOK {
		t.Fatalf("desktop document trash status=%d body=%s", trash.Code, trash.Body.String())
	}
	purge := authenticatedJSON(pair2.AccessToken, http.MethodDelete, "/api/documents/"+docID+"/permanent", `{ "confirmation": "Offline draft" }`)
	if purge.Code != http.StatusOK {
		t.Fatalf("desktop document purge status=%d body=%s", purge.Code, purge.Body.String())
	}
	var purgedDocumentExists bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM documents WHERE doc_id = $1)`, docID).Scan(&purgedDocumentExists); err != nil {
		t.Fatal(err)
	}
	if purgedDocumentExists {
		t.Fatal("desktop permanent deletion left the document in the database")
	}
	emptyDelete := authenticatedJSON(pair2.AccessToken, http.MethodDelete, "/api/folders/"+folderID+"/empty", "")
	if emptyDelete.Code != http.StatusOK {
		t.Fatalf("empty organizer folder delete status=%d body=%s", emptyDelete.Code, emptyDelete.Body.String())
	}
	var emptyFolderExists bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM folders WHERE folder_id = $1)`, folderID).Scan(&emptyFolderExists); err != nil {
		t.Fatal(err)
	}
	if emptyFolderExists {
		t.Fatal("empty organizer folder was not deleted")
	}
	cookieOnly := httptest.NewRequest(http.MethodPost, "/api/documents", strings.NewReader(
		`{"docId":"`+docID+`","title":"Cookie cannot choose IDs"}`,
	))
	cookieOnly.Header.Set("Content-Type", "application/json")
	cookieOnly.AddCookie(sessionCookie)
	cookieOnlyRec := httptest.NewRecorder()
	handler.ServeHTTP(cookieOnlyRec, cookieOnly)
	if cookieOnlyRec.Code != http.StatusBadRequest {
		t.Fatalf("browser-selected document id status=%d body=%s", cookieOnlyRec.Code, cookieOnlyRec.Body.String())
	}

	// Reusing a rotated refresh token revokes the whole family. Otherwise an
	// attacker who refreshes a stolen token first could keep the new child token.
	exchange(`{"grantType":"refresh_token","clientId":"`+desktopClientID+`","refreshToken":"`+pair1.RefreshToken+`"}`, http.StatusUnauthorized)
	if status := accessSessionStatus(pair2.AccessToken); status != http.StatusUnauthorized {
		t.Fatalf("refresh-token replay left family access active: status=%d", status)
	}
	exchange(`{"grantType":"refresh_token","clientId":"`+desktopClientID+`","refreshToken":"`+pair2.RefreshToken+`"}`, http.StatusUnauthorized)

	revokeCode := authorize("state-revoke")
	revokePair := exchange(`{"grantType":"authorization_code","clientId":"`+desktopClientID+`","code":"`+revokeCode+`","codeVerifier":"`+verifier+`"}`, http.StatusOK)

	revokeReq := httptest.NewRequest(http.MethodPost, "/api/auth/desktop/revoke", nil)
	revokeReq.Header.Set("Authorization", "Bearer "+revokePair.AccessToken)
	revokeRec := httptest.NewRecorder()
	handler.ServeHTTP(revokeRec, revokeReq)
	if revokeRec.Code != http.StatusOK {
		t.Fatalf("revoke status=%d body=%s", revokeRec.Code, revokeRec.Body.String())
	}
	if status := accessSessionStatus(revokePair.AccessToken); status != http.StatusUnauthorized {
		t.Fatalf("revoked access token status=%d", status)
	}
	exchange(`{"grantType":"refresh_token","clientId":"`+desktopClientID+`","refreshToken":"`+revokePair.RefreshToken+`"}`, http.StatusUnauthorized)

	code3 := authorize("state-three")
	pair3 := exchange(`{"grantType":"authorization_code","clientId":"`+desktopClientID+`","code":"`+code3+`","codeVerifier":"`+verifier+`"}`, http.StatusOK)
	if _, err := pool.Exec(ctx, `UPDATE users SET session_version = session_version + 1 WHERE id = $1`, userID); err != nil {
		t.Fatal(err)
	}
	if status := accessSessionStatus(pair3.AccessToken); status != http.StatusUnauthorized {
		t.Fatalf("session-version-invalidated access status=%d", status)
	}
	exchange(`{"grantType":"refresh_token","clientId":"`+desktopClientID+`","refreshToken":"`+pair3.RefreshToken+`"}`, http.StatusUnauthorized)

	var consumedCodeStored bool
	code3Hash := sha256.Sum256([]byte(code3))
	if err := pool.QueryRow(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM desktop_authorization_codes
			WHERE code_hash = $1
		)
	`, code3Hash[:]).Scan(&consumedCodeStored); err != nil {
		t.Fatal(err)
	}
	if consumedCodeStored {
		t.Fatal("consumed authorization code should not remain in the database")
	}

	// Expiry values are bounded rather than permanent credentials.
	var refreshExpires time.Time
	if err := pool.QueryRow(ctx, `
		SELECT max(expires_at) FROM desktop_refresh_tokens WHERE user_id = $1
	`, userID).Scan(&refreshExpires); err != nil {
		t.Fatal(err)
	}
	if remaining := time.Until(refreshExpires); remaining <= 29*24*time.Hour || remaining > desktopRefreshTokenTTL+time.Minute {
		t.Fatalf("unexpected refresh lifetime: %v", remaining)
	}
}
