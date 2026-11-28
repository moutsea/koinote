package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"koinote/backend/internal/config"
)

func attributionJSON(t *testing.T, value any) json.RawMessage {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func attributionInput() map[string]any {
	return map[string]any{
		"utmSource": "search", "utmMedium": "organic", "utmCampaign": "launch_2026",
		"referrerHost": "WWW.GOOGLE.COM.", "landingPath": "/docs?search=private#secret",
		"capturedAt": time.Now().UTC().Add(-time.Minute).Format(time.RFC3339Nano),
	}
}

func TestRegistrationAttributionCleaning(t *testing.T) {
	app := New(config.Config{AppURL: "https://koinote.app"}, nil)
	cases := []struct {
		name, field string
		value       any
		source      string
		missing     bool
	}{
		{"utm priority", "firstSource", "forged", "search", false},
		{"host fallback", "utmSource", "", "www.google.com", false},
		{"url label", "utmSource", "https://private.test/path", "www.google.com", false},
		{"search text", "utmSource", "private search words", "www.google.com", false},
		{"email label", "utmSource", "person@example.test", "www.google.com", false},
		{"long label", "utmSource", strings.Repeat("a", 129), "www.google.com", false},
		{"maximum label", "utmSource", strings.Repeat("a", 128), strings.Repeat("a", 128), false},
		{"missing time", "capturedAt", "", "", true},
		{"future time", "capturedAt", time.Now().Add(time.Hour).Format(time.RFC3339), "", true},
		{"unknown path", "landingPath", "/private-name.docx", "", true},
		{"absolute path", "landingPath", "https://koinote.app/docs", "", true},
		{"bad optional type", "utmSource", 123, "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			input := attributionInput()
			input[tc.field] = tc.value
			got := app.cleanRegistrationAttribution(attributionJSON(t, input))
			if tc.missing {
				if got != nil {
					t.Fatalf("expected omitted attribution: %+v", got)
				}
				return
			}
			if got == nil || got.FirstSource != tc.source || got.LandingPath != "/docs" {
				t.Fatalf("unexpected cleaned attribution: %+v", got)
			}
		})
	}
	for _, host := range []string{"koinote.app", "accounts.google.com", "oauth2.googleapis.com", "https://search.test/query?q=private", "user@search.test", "127.0.0.1", "[::1]", "search.test:443"} {
		input := attributionInput()
		input["utmSource"] = ""
		input["referrerHost"] = host
		got := app.cleanRegistrationAttribution(attributionJSON(t, input))
		if got == nil || got.FirstSource != "direct" || got.ReferrerHost != "" {
			t.Fatalf("host %q was retained: %+v", host, got)
		}
	}
	for _, raw := range []string{"null", `"wrong"`, `{}`, `{"capturedAt":false}`} {
		if app.cleanRegistrationAttribution(json.RawMessage(raw)) != nil {
			t.Fatalf("accepted %s", raw)
		}
	}
	for path, want := range map[string]string{
		"/share/" + strings.Repeat("a", 32) + "?password=secret": "/share/:token",
		"/editor/private-document":                               "/editor/:docId", "/repositories/123": "/repositories/:repositoryId",
		"/agent/workspaces/42": "/agent/workspaces/:workspaceId", "/editor/a/b": "", "/editor/%2fsecret": "", "/": "/",
	} {
		if got := attributionLandingPath(path); got != want {
			t.Fatalf("path %q: %q != %q", path, got, want)
		}
	}
	input := attributionInput()
	input["utmSource"] = ""
	input["referrerHost"] = ""
	input["landingPath"] = "/share/" + strings.Repeat("b", 32)
	input["shareSourceKey"] = strings.Repeat("b", 32)
	got := app.cleanRegistrationAttribution(attributionJSON(t, input))
	if got == nil || got.FirstSource != "share" || got.ShareSourceKey != "" {
		t.Fatalf("share normalization: %+v", got)
	}
}

func newAttributionApp(t *testing.T, pool *pgxpool.Pool) *App {
	t.Helper()
	return New(config.Config{SessionSecret: "attribution-test", AppURL: "https://koinote.app", GoogleOAuthID: "google-id", GoogleOAuthSecret: "google-secret", GitHubOAuthID: "github-id", GitHubOAuthSecret: "github-secret"}, pool)
}

func attributionShare(t *testing.T, pool *pgxpool.Pool, app *App) (int, string) {
	t.Helper()
	owner := seedMCPUser(t, pool, app, membershipTierFree)
	token, err := randomHex(16)
	if err != nil {
		t.Fatal(err)
	}
	var id int
	if err := pool.QueryRow(context.Background(), `INSERT INTO documents (doc_id,user_id,title,content,share_token,share_access) VALUES ($1,$2,'private title','private body',$3,'link') RETURNING id`, "attribution-"+token, owner.ID, token).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id, token
}

func attributionRequest(t *testing.T, app *App, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(string(attributionJSON(t, body))))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	app.Routes().ServeHTTP(rec, req)
	return rec
}

func emailAttributionBody(t *testing.T, pool *pgxpool.Pool, app *App) map[string]any {
	t.Helper()
	suffix, err := randomHex(8)
	if err != nil {
		t.Fatal(err)
	}
	email := "attribution-" + suffix + "@example.test"
	if _, err := pool.Exec(context.Background(), `INSERT INTO email_verification_codes (email,code_hash,expires_at) VALUES ($1,$2,now()+interval '10 minutes')`, email, app.verificationCodeHash(email, "123456")); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE email=$1`, email)
		_, _ = pool.Exec(context.Background(), `DELETE FROM email_verification_codes WHERE email=$1`, email)
	})
	return map[string]any{"username": "attr-" + suffix, "email": email, "password": "secret123", "verificationCode": "123456", "firstTouch": attributionInput()}
}

func attributionCounts(t *testing.T, pool *pgxpool.Pool, email string) (int, int, int) {
	t.Helper()
	var users, first, shares int
	err := pool.QueryRow(context.Background(), `SELECT count(*),
        (SELECT count(*) FROM user_registration_attribution a JOIN users u ON u.id=a.user_id WHERE u.email=$1),
        (SELECT count(*) FROM product_milestones m JOIN users u ON u.id=m.user_id WHERE u.email=$1 AND event_name='share_signup')
        FROM users WHERE email=$1`, email).Scan(&users, &first, &shares)
	if err != nil {
		t.Fatal(err)
	}
	return users, first, shares
}

func TestEmailRegistrationAttributionDatabase(t *testing.T) {
	pool := newGCTestPool(t)
	for _, mode := range []string{"utm-share", "share-landing", "referrer", "direct", "legacy", "invalid", "ordinary-redirect", "revoked", "trashed", "bad-token", "password", "public"} {
		t.Run(mode, func(t *testing.T) {
			app := newAttributionApp(t, pool)
			docID, token := attributionShare(t, pool, app)
			body := emailAttributionBody(t, pool, app)
			body["shareSignupToken"] = token
			expectedFirst, expectedShare := 1, 1
			switch mode {
			case "share-landing":
				first := body["firstTouch"].(map[string]any)
				first["utmSource"] = ""
				first["referrerHost"] = ""
				first["landingPath"] = "/share/" + token
				digest := sha256.Sum256([]byte(token))
				first["shareSourceKey"] = hex.EncodeToString(digest[:])
			case "referrer":
				body["firstTouch"].(map[string]any)["utmSource"] = ""
			case "direct":
				body["firstTouch"].(map[string]any)["utmSource"] = ""
				body["firstTouch"].(map[string]any)["referrerHost"] = ""
			case "legacy":
				delete(body, "firstTouch")
				delete(body, "shareSignupToken")
				expectedFirst = 0
				expectedShare = 0
			case "invalid":
				body["firstTouch"] = map[string]any{"capturedAt": false}
				body["shareSignupToken"] = map[string]any{"token": token}
				expectedFirst = 0
				expectedShare = 0
			case "ordinary-redirect":
				delete(body, "shareSignupToken")
				body["redirectTo"] = "/share/" + token
				expectedShare = 0
			case "revoked":
				_, err := pool.Exec(context.Background(), `UPDATE documents SET share_token=NULL WHERE id=$1`, docID)
				if err != nil {
					t.Fatal(err)
				}
				expectedShare = 0
			case "trashed":
				_, err := pool.Exec(context.Background(), `UPDATE documents SET trashed_at=now() WHERE id=$1`, docID)
				if err != nil {
					t.Fatal(err)
				}
				expectedShare = 0
			case "bad-token":
				body["shareSignupToken"] = strings.Repeat("f", 32)
				expectedShare = 0
			case "password":
				_, err := pool.Exec(context.Background(), `UPDATE documents SET share_access='password',share_password_hash='test-hash' WHERE id=$1`, docID)
				if err != nil {
					t.Fatal(err)
				}
			case "public":
				_, err := pool.Exec(context.Background(), `UPDATE documents SET share_access='public' WHERE id=$1`, docID)
				if err != nil {
					t.Fatal(err)
				}
			}
			rec := attributionRequest(t, app, "POST", "/api/auth/register", body)
			if rec.Code != 200 {
				t.Fatalf("registration: %d %s", rec.Code, rec.Body.String())
			}
			email := body["email"].(string)
			users, first, shares := attributionCounts(t, pool, email)
			if users != 1 || first != expectedFirst || shares != expectedShare {
				t.Fatalf("counts %d %d %d", users, first, shares)
			}
			var id, registered int
			if err := pool.QueryRow(context.Background(), `SELECT id,(SELECT count(*) FROM product_milestones WHERE user_id=u.id AND event_name='registered') FROM users u WHERE email=$1`, email).Scan(&id, &registered); err != nil || registered != 1 {
				t.Fatalf("registered=%d err=%v", registered, err)
			}
			if expectedFirst == 1 {
				var firstSource, path, medium, campaign, host string
				if err := pool.QueryRow(context.Background(), `SELECT first_source,landing_path,utm_medium,utm_campaign,referrer_host FROM user_registration_attribution WHERE user_id=$1`, id).Scan(&firstSource, &path, &medium, &campaign, &host); err != nil {
					t.Fatal(err)
				}
				expectedSource := "search"
				if mode == "referrer" {
					expectedSource = "www.google.com"
				}
				if mode == "direct" {
					expectedSource = "direct"
				}
				expectedPath := "/docs"
				if mode == "share-landing" {
					expectedSource = "share"
					expectedPath = "/share/:token"
				}
				if firstSource != expectedSource || path != expectedPath || medium != "organic" || campaign != "launch_2026" {
					t.Fatalf("persisted fields: %s %s %s %s %s", firstSource, path, medium, campaign, host)
				}
			}
			before := attributionSnapshot(t, pool, id)
			body["firstTouch"] = map[string]any{"landingPath": "/", "capturedAt": time.Now().Format(time.RFC3339), "utmSource": "changed"}
			login := attributionRequest(t, app, "POST", "/api/auth/login", body)
			if login.Code != 200 {
				t.Fatalf("login: %d %s", login.Code, login.Body.String())
			}
			again := attributionRequest(t, app, "POST", "/api/auth/register", body)
			if again.Code != 409 {
				t.Fatalf("duplicate registration: %d", again.Code)
			}
			after := attributionSnapshot(t, pool, id)
			if before != after {
				t.Fatalf("login/duplicate changed attribution: %s -> %s", before, after)
			}
			if strings.Contains(after, token) || strings.Contains(after, "private") {
				t.Fatalf("private source content in analytics: %s", after)
			}
			if _, err := pool.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, id); err != nil {
				t.Fatal(err)
			}
			var remaining int
			if err := pool.QueryRow(context.Background(), `SELECT (SELECT count(*) FROM user_registration_attribution WHERE user_id=$1)+(SELECT count(*) FROM product_milestones WHERE user_id=$1)`, id).Scan(&remaining); err != nil || remaining != 0 {
				t.Fatalf("cascade: %d %v", remaining, err)
			}
		})
	}
}

func attributionSnapshot(t *testing.T, pool *pgxpool.Pool, id int) string {
	t.Helper()
	var snapshot string
	if err := pool.QueryRow(context.Background(), `SELECT json_build_object('first',(SELECT row_to_json(a) FROM user_registration_attribution a WHERE user_id=$1),'events',(SELECT json_agg(m ORDER BY event_name) FROM product_milestones m WHERE user_id=$1))::text`, id).Scan(&snapshot); err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func TestRegistrationAttributionRollbackAndConcurrentEmail(t *testing.T) {
	pool := newGCTestPool(t)
	app := newAttributionApp(t, pool)
	_, token := attributionShare(t, pool, app)
	body := emailAttributionBody(t, pool, app)
	body["shareSignupToken"] = token
	// 在首触写入时制造真实数据库失败，证明账号、验证码、事件共同回滚。
	if _, err := pool.Exec(context.Background(), `ALTER TABLE user_registration_attribution ADD CONSTRAINT attribution_test_failure CHECK (utm_campaign <> 'force_rollback')`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `ALTER TABLE user_registration_attribution DROP CONSTRAINT IF EXISTS attribution_test_failure`)
	})
	body["firstTouch"].(map[string]any)["utmCampaign"] = "force_rollback"
	failed := attributionRequest(t, app, "POST", "/api/auth/register", body)
	if failed.Code != 500 {
		t.Fatalf("expected failed transaction: %d %s", failed.Code, failed.Body.String())
	}
	if users, first, shares := attributionCounts(t, pool, body["email"].(string)); users+first+shares != 0 {
		t.Fatalf("rollback left data: %d %d %d", users, first, shares)
	}
	var codes int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM email_verification_codes WHERE email=$1`, body["email"]).Scan(&codes); err != nil || codes != 1 {
		t.Fatalf("verification rollback: %d %v", codes, err)
	}
	body["firstTouch"].(map[string]any)["utmCampaign"] = "launch_2026"
	raw := string(attributionJSON(t, body))
	results := make(chan int, 4)
	var wait sync.WaitGroup
	for range 4 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			req := httptest.NewRequest("POST", "/api/auth/register", strings.NewReader(raw))
			rec := httptest.NewRecorder()
			app.Routes().ServeHTTP(rec, req)
			results <- rec.Code
		}()
	}
	wait.Wait()
	close(results)
	success := 0
	for status := range results {
		if status == 200 {
			success++
		} else if status != 400 && status != 409 {
			t.Errorf("unexpected conflict status %d", status)
		}
	}
	if success != 1 {
		t.Fatalf("successful concurrent registrations=%d", success)
	}
	if users, first, shares := attributionCounts(t, pool, body["email"].(string)); users != 1 || first != 1 || shares != 1 {
		t.Fatalf("concurrent rows %d %d %d", users, first, shares)
	}
}

// 实际 provider HTTP 交换与 profile 读取由本地 httptest 接管，数据库保持真实。
func mockRegistrationOAuth(t *testing.T, email, providerID string) {
	t.Helper()
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/token", "/login/oauth/access_token":
			fmt.Fprint(w, `{"access_token":"mock-access"}`)
		case "/v1/userinfo":
			_ = json.NewEncoder(w).Encode(map[string]any{"sub": providerID, "email": email, "email_verified": true, "name": "OAuth Test"})
		case "/user":
			fmt.Fprint(w, `{"id":73001234,"login":"test","email":"unverified@example.test"}`)
		case "/user/emails":
			_ = json.NewEncoder(w).Encode([]map[string]any{{"email": email, "primary": true, "verified": true}})
		default:
			http.Error(w, "unexpected endpoint", 404)
		}
	}))
	t.Cleanup(upstream.Close)
	target, _ := url.Parse(upstream.URL)
	previous := http.DefaultTransport
	http.DefaultTransport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		switch r.URL.Host {
		case "oauth2.googleapis.com", "openidconnect.googleapis.com", "github.com", "api.github.com":
		default:
			return nil, fmt.Errorf("unexpected oauth host")
		}
		clone := r.Clone(r.Context())
		clone.URL.Scheme = target.Scheme
		clone.URL.Host = target.Host
		return previous.RoundTrip(clone)
	})
	t.Cleanup(func() { http.DefaultTransport = previous })
}

func oauthAttributionStart(t *testing.T, app *App, provider, token string) (*http.Cookie, oauthStatePayload) {
	t.Helper()
	params := url.Values{"redirectTo": {"/docs"}, "firstTouch": {string(attributionJSON(t, attributionInput()))}, "shareSignupToken": {token}}
	rec := doRequest(app, "GET", "/api/auth/oauth/"+provider+"/start?"+params.Encode())
	if rec.Code != 302 {
		t.Fatalf("oauth start %d %s", rec.Code, rec.Body.String())
	}
	cookie := readSetCookie(t, rec, oauthStateCookieName)
	if len(cookie.String()) > 4096 {
		t.Fatalf("oversized cookie: %d", len(cookie.String()))
	}
	req := httptest.NewRequest("GET", "/", nil)
	req.AddCookie(cookie)
	state, ok := app.oauthStateFromCookie(req)
	if !ok {
		t.Fatal("invalid signed state")
	}
	if raw := string(attributionJSON(t, state.Registration)); strings.Contains(raw, token) {
		t.Fatal("raw token retained in signed analytics context")
	}
	return cookie, state
}

func TestOAuthRegistrationAttributionDatabase(t *testing.T) {
	pool := newGCTestPool(t)
	for _, provider := range []string{"google", "github"} {
		t.Run(provider, func(t *testing.T) {
			app := newAttributionApp(t, pool)
			_, token := attributionShare(t, pool, app)
			suffix, _ := randomHex(8)
			email := "oauth-" + suffix + "@example.test"
			t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE email=$1`, email) })
			mockRegistrationOAuth(t, email, suffix)
			cookie, state := oauthAttributionStart(t, app, provider, token)
			rec := doRequest(app, "GET", "/api/auth/oauth/"+provider+"/callback?code=mock&state="+state.Nonce, cookie)
			if rec.Code != 302 || rec.Header().Get("Location") != "/docs" {
				t.Fatalf("callback: %d %s", rec.Code, rec.Header().Get("Location"))
			}
			if users, first, shares := attributionCounts(t, pool, email); users != 1 || first != 1 || shares != 1 {
				t.Fatalf("oauth rows %d %d %d", users, first, shares)
			}
			var id int
			if err := pool.QueryRow(context.Background(), `SELECT id FROM users WHERE email=$1`, email).Scan(&id); err != nil {
				t.Fatal(err)
			}
			before := attributionSnapshot(t, pool, id)
			// 同 provider 登录与另一个 provider 的同邮箱复用都不能补写或覆盖。
			for _, loginProvider := range []string{"google", "github"} {
				cookie, state := oauthAttributionStart(t, app, loginProvider, token)
				state.Registration.FirstTouch.UTMSource = "changed"
				state.Registration.FirstTouch.FirstSource = "changed"
				signed, err := app.signOAuthState(state)
				if err != nil {
					t.Fatal(err)
				}
				cookie.Value = signed
				rec := doRequest(app, "GET", "/api/auth/oauth/"+loginProvider+"/callback?code=mock&state="+state.Nonce, cookie)
				if rec.Header().Get("Location") != "/docs" {
					t.Fatalf("reuse failed: %s", rec.Header().Get("Location"))
				}
			}
			if after := attributionSnapshot(t, pool, id); after != before {
				t.Fatalf("oauth reuse changed analytics: %s -> %s", before, after)
			}
		})
	}
}

func TestOAuthRegistrationAttributionRevocationAndLegacyReuse(t *testing.T) {
	pool := newGCTestPool(t)
	for _, mode := range []string{"revoked", "rotated", "trashed", "legacy", "invalid-invite", "unverified"} {
		t.Run(mode, func(t *testing.T) {
			app := newAttributionApp(t, pool)
			docID, token := attributionShare(t, pool, app)
			suffix, _ := randomHex(8)
			email := "oauth-" + suffix + "@example.test"
			t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE email=$1`, email) })
			mockRegistrationOAuth(t, email, suffix)
			cookie, state := oauthAttributionStart(t, app, "google", token)
			if state.Registration.ShareSignup == nil {
				t.Fatal("valid CTA missing from state")
			}
			switch mode {
			case "revoked":
				_, err := pool.Exec(context.Background(), `UPDATE documents SET share_token=NULL WHERE id=$1`, docID)
				if err != nil {
					t.Fatal(err)
				}
			case "rotated":
				_, err := pool.Exec(context.Background(), `UPDATE documents SET share_token=$2 WHERE id=$1`, docID, strings.Repeat("d", 32))
				if err != nil {
					t.Fatal(err)
				}
			case "trashed":
				_, err := pool.Exec(context.Background(), `UPDATE documents SET trashed_at=now() WHERE id=$1`, docID)
				if err != nil {
					t.Fatal(err)
				}
			case "legacy", "unverified":
				_, err := pool.Exec(context.Background(), `INSERT INTO users (auth_user_id,email,is_verified) VALUES ($1,$2,$3)`, suffix, email, mode == "legacy")
				if err != nil {
					t.Fatal(err)
				}
			case "invalid-invite":
				state.InvitationCodeInvalid = true
				signed, err := app.signOAuthState(state)
				if err != nil {
					t.Fatal(err)
				}
				cookie.Value = signed
			}
			rec := doRequest(app, "GET", "/api/auth/oauth/google/callback?code=mock&state="+state.Nonce, cookie)
			want := "/docs"
			expectedUsers, expectedFirst := 1, 1
			if mode == "legacy" {
				expectedFirst = 0
			}
			if mode == "invalid-invite" {
				want = "/register?error=invalid_invitation_code"
				expectedUsers = 0
				expectedFirst = 0
			}
			if mode == "unverified" {
				want = "/login?error=oauth_sync_failed"
				expectedFirst = 0
			}
			if rec.Header().Get("Location") != want {
				t.Fatalf("callback location %q", rec.Header().Get("Location"))
			}
			if users, first, shares := attributionCounts(t, pool, email); users != expectedUsers || first != expectedFirst || shares != 0 {
				t.Fatalf("rows %d %d %d", users, first, shares)
			}
		})
	}
}

func TestRegistrationAttributionConcurrentPersistence(t *testing.T) {
	pool := newGCTestPool(t)
	app := newAttributionApp(t, pool)
	_, token := attributionShare(t, pool, app)
	source := app.registrationShareSource(context.Background(), attributionJSON(t, token))
	first := app.cleanRegistrationAttribution(attributionJSON(t, attributionInput()))
	suffix, _ := randomHex(8)
	email := "concurrent-attribution-" + suffix + "@example.test"
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE email=$1`, email) })
	ctx := context.Background()
	var wait sync.WaitGroup
	errs := make(chan error, 12)
	ids := make(chan int, 12)
	for index := range 12 {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			provider := "google"
			if index%2 == 1 {
				provider = "github"
			}
			user, err := app.getOrCreateOAuthUser(ctx, oauthProfile{Provider: provider, ProviderUserID: suffix, Email: email}, "", false, registrationContext{FirstTouch: first, ShareSignup: source})
			errs <- err
			ids <- user.ID
		}(index)
	}
	wait.Wait()
	close(errs)
	close(ids)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	id := 0
	for candidate := range ids {
		if id != 0 && candidate != id {
			t.Fatal("different users created")
		}
		id = candidate
	}
	before := attributionSnapshot(t, pool, id)
	var timestamp time.Time
	var key string
	if err := pool.QueryRow(ctx, `SELECT occurred_at,share_source_key FROM product_milestones WHERE user_id=$1 AND event_name='share_signup'`, id).Scan(&timestamp, &key); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(token))
	if key != hex.EncodeToString(digest[:]) {
		t.Fatalf("unexpected share key %q", key)
	}
	errs = make(chan error, 12)
	for range 12 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			tx, err := pool.Begin(ctx)
			if err == nil {
				defer tx.Rollback(ctx)
				changed := *first
				changed.FirstSource = "changed"
				changed.CapturedAt = time.Now()
				err = insertRegistrationAttribution(ctx, tx, id, registrationContext{FirstTouch: &changed, ShareSignup: source})
				if err == nil {
					err = tx.Commit(ctx)
				}
				if err == nil {
					err = app.insertProductMilestone(ctx, id, milestoneShareSignup, *source)
				}
			}
			errs <- err
		}()
	}
	wait.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	if users, first, shares := attributionCounts(t, pool, email); users != 1 || first != 1 || shares != 1 {
		t.Fatalf("idempotency rows %d %d %d", users, first, shares)
	}
	if after := attributionSnapshot(t, pool, id); after != before {
		t.Fatal("repeated writes changed initial values or timestamps")
	}
	for _, event := range []productMilestone{milestoneRegistered, milestoneFirstDocument, milestoneFirstUpload, milestoneFirstExport, milestoneMCPConnected, milestoneCheckoutStarted, milestoneCheckoutCompleted} {
		if err := app.insertProductMilestone(ctx, id, event); err != nil {
			t.Fatalf("old event %s: %v", event, err)
		}
	}
	var started bool
	if err := pool.QueryRow(ctx, `SELECT attribution_started_at IS NOT NULL AND share_signup_started_at IS NOT NULL FROM product_analytics_meta WHERE singleton`).Scan(&started); err != nil || !started {
		t.Fatalf("tracking start %v %v", started, err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO product_milestones(user_id,event_name) VALUES ($1,'share_signup')`, id); err == nil {
		t.Fatal("accepted missing share source")
	}
}

func TestRegistrationMilestoneFailureDoesNotBlockSignup(t *testing.T) {
	pool := newGCTestPool(t)
	app := newAttributionApp(t, pool)
	_, token := attributionShare(t, pool, app)
	// NOT VALID 只约束后续写入，不影响其他测试的已有事件。
	if _, err := pool.Exec(context.Background(), `ALTER TABLE product_milestones ADD CONSTRAINT attribution_test_event_failure CHECK (event_name <> 'share_signup') NOT VALID`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `ALTER TABLE product_milestones DROP CONSTRAINT IF EXISTS attribution_test_event_failure`)
	})
	body := emailAttributionBody(t, pool, app)
	body["shareSignupToken"] = token
	rec := attributionRequest(t, app, "POST", "/api/auth/register", body)
	if rec.Code != 200 {
		t.Fatalf("analytics failure blocked email registration: %d %s", rec.Code, rec.Body.String())
	}
	if users, first, shares := attributionCounts(t, pool, body["email"].(string)); users != 1 || first != 1 || shares != 0 {
		t.Fatalf("email rows %d %d %d", users, first, shares)
	}
	suffix, _ := randomHex(8)
	email := "best-effort-" + suffix + "@example.test"
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE email=$1`, email) })
	mockRegistrationOAuth(t, email, suffix)
	cookie, state := oauthAttributionStart(t, app, "google", token)
	rec = doRequest(app, "GET", "/api/auth/oauth/google/callback?code=mock&state="+state.Nonce, cookie)
	if rec.Header().Get("Location") != "/docs" {
		t.Fatalf("analytics failure blocked OAuth: %s", rec.Header().Get("Location"))
	}
	if users, first, shares := attributionCounts(t, pool, email); users != 1 || first != 1 || shares != 0 {
		t.Fatalf("OAuth rows %d %d %d", users, first, shares)
	}
}

func TestOAuthRegistrationAttributionTransactionRollback(t *testing.T) {
	pool := newGCTestPool(t)
	app := newAttributionApp(t, pool)
	_, token := attributionShare(t, pool, app)
	if _, err := pool.Exec(context.Background(), `ALTER TABLE user_registration_attribution ADD CONSTRAINT attribution_test_oauth_failure CHECK (utm_campaign <> 'force_rollback')`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `ALTER TABLE user_registration_attribution DROP CONSTRAINT IF EXISTS attribution_test_oauth_failure`)
	})
	suffix, _ := randomHex(8)
	email := "rollback-" + suffix + "@example.test"
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE email=$1`, email) })
	mockRegistrationOAuth(t, email, suffix)
	cookie, state := oauthAttributionStart(t, app, "google", token)
	state.Registration.FirstTouch.UTMCampaign = "force_rollback"
	signed, err := app.signOAuthState(state)
	if err != nil {
		t.Fatal(err)
	}
	cookie.Value = signed
	rec := doRequest(app, "GET", "/api/auth/oauth/google/callback?code=mock&state="+state.Nonce, cookie)
	if rec.Header().Get("Location") != "/login?error=oauth_sync_failed" {
		t.Fatalf("failed transaction response: %s", rec.Header().Get("Location"))
	}
	if users, first, shares := attributionCounts(t, pool, email); users+first+shares != 0 {
		t.Fatalf("rollback left rows %d %d %d", users, first, shares)
	}
}
