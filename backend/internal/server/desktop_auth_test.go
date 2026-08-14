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
		{http.MethodPost, "/api/documents", true},
		{http.MethodPut, "/api/documents/doc-id", true},
		{http.MethodDelete, "/api/documents/doc-id/permanent", false},
		{http.MethodPost, "/api/billing/checkout", false},
		{http.MethodGet, "/api/mcp/tokens", false},
		{http.MethodGet, "/api/admin/stats", false},
		{http.MethodPost, "/api/auth/sessions/invalidate", false},
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
		INSERT INTO users (auth_user_id, email, is_verified)
		VALUES ($1, $2, true) RETURNING id
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
	for _, forbiddenPath := range []string{
		"/api/admin/stats",
		"/api/mcp/tokens",
	} {
		rec := authenticatedJSON(pair1.AccessToken, http.MethodGet, forbiddenPath, "")
		if rec.Code != http.StatusForbidden {
			t.Fatalf("desktop scope %s status=%d body=%s", forbiddenPath, rec.Code, rec.Body.String())
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
	folderBody := `{"folderId":"` + folderID + `","name":"Offline"}`
	for attempt := 1; attempt <= 2; attempt++ {
		rec := authenticatedJSON(pair2.AccessToken, http.MethodPost, "/api/folders", folderBody)
		if rec.Code != http.StatusOK {
			t.Fatalf("idempotent folder create attempt %d status=%d body=%s", attempt, rec.Code, rec.Body.String())
		}
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
