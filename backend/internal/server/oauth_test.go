package server

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"koinote/backend/internal/config"
)

// ---------- 开放重定向防护 ----------

// sanitizeRedirectPath 是防开放重定向的唯一闸口，必须只放行站内相对路径。
func TestSanitizeRedirectPath(t *testing.T) {
	cases := []struct {
		name     string
		input    string
		expected string
	}{
		{"正常站内路径", "/dashboard", "/dashboard"},
		{"带子路径", "/editor/doc-1", "/editor/doc-1"},
		{"带查询串", "/dashboard?tab=recent", "/dashboard?tab=recent"},
		{"空值回落默认", "", "/dashboard"},
		{"仅空白回落默认", "   ", "/dashboard"},
		{"协议相对 URL 必须挡掉", "//evil.com/phish", "/dashboard"},
		{"绝对 http URL 必须挡掉", "http://evil.com", "/dashboard"},
		{"绝对 https URL 必须挡掉", "https://evil.com/steal", "/dashboard"},
		{"不以斜杠开头", "dashboard", "/dashboard"},
		{"javascript 伪协议", "javascript:alert(1)", "/dashboard"},
		{"data 伪协议", "data:text/html,<script>", "/dashboard"},
		{"反斜杠变体", "\\\\evil.com", "/dashboard"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := sanitizeRedirectPath(tc.input); got != tc.expected {
				t.Fatalf("输入 %q，期望 %q，实际 %q", tc.input, tc.expected, got)
			}
		})
	}
}

// encodeStatePayload 把原始 JSON 编成 state token 的载荷段，用于构造伪造用例。
func encodeStatePayload(raw []byte) string {
	return base64.RawURLEncoding.EncodeToString(raw)
}

// ---------- state 签名往返 ----------

func TestOAuthStateRoundTrip(t *testing.T) {
	app := appWithSecret("state-secret")
	payload := oauthStatePayload{
		Provider:   "google",
		RedirectTo: "/dashboard",
		Nonce:      "abc123",
		ExpiresAt:  time.Now().Add(oauthStateTTL).Unix(),
	}

	token, err := app.signOAuthState(payload)
	if err != nil {
		t.Fatalf("签名 state 失败: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.AddCookie(&http.Cookie{Name: oauthStateCookieName, Value: token})

	got, ok := app.oauthStateFromCookie(req)
	if !ok {
		t.Fatal("自签的 state 应当校验通过")
	}
	if got.Provider != "google" || got.Nonce != "abc123" || got.RedirectTo != "/dashboard" {
		t.Fatalf("state 载荷往返不一致: %+v", got)
	}
}

func TestOAuthStateRejectsTampering(t *testing.T) {
	app := appWithSecret("state-secret")
	valid, _ := app.signOAuthState(oauthStatePayload{
		Provider: "google", Nonce: "n1", ExpiresAt: time.Now().Add(time.Hour).Unix(),
	})
	validPayload := strings.Split(valid, ".")[0]

	// 攻击者改 provider 但无法重签
	forged, _ := json.Marshal(oauthStatePayload{
		Provider: "github", Nonce: "n1", ExpiresAt: time.Now().Add(time.Hour).Unix(),
	})
	forgedEncoded := encodeStatePayload(forged)

	cases := []struct {
		name  string
		value string
	}{
		{"无分隔符", "garbage"},
		{"签名被清零", validPayload + ".AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},
		{"分段过多", valid + ".extra"},
		{"伪造载荷配假签名", forgedEncoded + ".fakesig"},
		{"载荷非法 base64", "!!!." + app.sessionSignature("x")},
		{"空 cookie 值", ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			if tc.value != "" {
				req.AddCookie(&http.Cookie{Name: oauthStateCookieName, Value: tc.value})
			}
			if _, ok := app.oauthStateFromCookie(req); ok {
				t.Fatal("被篡改的 state 不应通过校验")
			}
		})
	}
}

// state cookie 换密钥后同样必须失效
func TestOAuthStateRejectedAfterSecretRotation(t *testing.T) {
	old := appWithSecret("old")
	token, _ := old.signOAuthState(oauthStatePayload{
		Provider: "google", Nonce: "n", ExpiresAt: time.Now().Add(time.Hour).Unix(),
	})

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.AddCookie(&http.Cookie{Name: oauthStateCookieName, Value: token})

	if _, ok := appWithSecret("new").oauthStateFromCookie(req); ok {
		t.Fatal("换密钥后旧 state 仍被接受")
	}
}

// ---------- provider 配置 ----------

func TestOAuthProviderConfig(t *testing.T) {
	app := newTestApp(config.Config{
		AppURL:            "https://koinote.app/",
		GoogleOAuthID:     "gid",
		GoogleOAuthSecret: "gsecret",
		GitHubOAuthID:     "hid",
		GitHubOAuthSecret: "hsecret",
	})

	t.Run("google 回调地址由 AppURL 拼出且去掉尾斜杠", func(t *testing.T) {
		p, ok := app.oauthProvider("google")
		if !ok {
			t.Fatal("google 应为受支持的 provider")
		}
		want := "https://koinote.app/api/auth/oauth/google/callback"
		if p.RedirectURI != want {
			t.Fatalf("期望回调 %q，实际 %q", want, p.RedirectURI)
		}
		if !strings.Contains(p.Scope, "email") {
			t.Errorf("google scope 应包含 email，实际 %q", p.Scope)
		}
	})

	t.Run("github 配置", func(t *testing.T) {
		p, ok := app.oauthProvider("github")
		if !ok {
			t.Fatal("github 应为受支持的 provider")
		}
		want := "https://koinote.app/api/auth/oauth/github/callback"
		if p.RedirectURI != want {
			t.Fatalf("期望回调 %q，实际 %q", want, p.RedirectURI)
		}
	})

	t.Run("未知 provider", func(t *testing.T) {
		if _, ok := app.oauthProvider("facebook"); ok {
			t.Fatal("facebook 不应被支持")
		}
	})
}

// ---------- start 端点 ----------

// doRequest 走完整 mux 路由，确保 PathValue("provider") 能取到值。
func doRequest(app *App, method, target string, cookies ...*http.Cookie) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, target, nil)
	for _, c := range cookies {
		req.AddCookie(c)
	}
	rec := httptest.NewRecorder()
	app.Routes().ServeHTTP(rec, req)
	return rec
}

func TestOAuthStartUnconfigured(t *testing.T) {
	// 凭证全空：必须返回 501 而不是把空 client_id 送去 provider
	app := newTestApp(config.Config{AppURL: "http://localhost:5173"})
	rec := doRequest(app, http.MethodGet, "/api/auth/oauth/google/start")

	if rec.Code != http.StatusNotImplemented {
		t.Fatalf("期望 501，实际 %d", rec.Code)
	}
	if code := decodeErrorCode(t, rec); code != "oauth_not_configured" {
		t.Fatalf("期望错误码 oauth_not_configured，实际 %q", code)
	}
}

func TestOAuthStartUnsupportedProvider(t *testing.T) {
	app := newTestApp(config.Config{AppURL: "http://localhost:5173"})
	rec := doRequest(app, http.MethodGet, "/api/auth/oauth/facebook/start")

	if rec.Code != http.StatusNotFound {
		t.Fatalf("期望 404，实际 %d", rec.Code)
	}
	if code := decodeErrorCode(t, rec); code != "oauth_unsupported" {
		t.Fatalf("期望错误码 oauth_unsupported，实际 %q", code)
	}
}

// 配好凭证后应重定向到 provider，且只把 nonce 放进 state 参数，
// redirectTo 等敏感载荷留在签名 cookie 里，不暴露给 provider 和 URL。
func TestOAuthStartRedirectsWithSignedState(t *testing.T) {
	app := newTestApp(config.Config{
		AppURL:            "http://localhost:5173",
		SessionSecret:     "sess",
		GoogleOAuthID:     "gid",
		GoogleOAuthSecret: "gsecret",
	})
	rec := doRequest(app, http.MethodGet, "/api/auth/oauth/google/start?redirectTo=/editor")

	if rec.Code != http.StatusFound {
		t.Fatalf("期望 302，实际 %d", rec.Code)
	}

	location := rec.Header().Get("Location")
	if !strings.HasPrefix(location, "https://accounts.google.com/") {
		t.Fatalf("应重定向到 google 授权页，实际 %q", location)
	}
	if strings.Contains(location, "gsecret") {
		t.Fatal("client_secret 绝不能出现在重定向 URL 里")
	}
	if strings.Contains(location, "/editor") {
		t.Fatal("redirectTo 不应泄露到 provider URL，应留在签名 cookie 内")
	}

	stateCookie := readSetCookie(t, rec, oauthStateCookieName)
	if !stateCookie.HttpOnly {
		t.Error("state cookie 必须是 HttpOnly")
	}
	if stateCookie.SameSite != http.SameSiteLaxMode {
		t.Errorf("state cookie 期望 SameSite=Lax，实际 %v", stateCookie.SameSite)
	}

	// cookie 里的 nonce 必须与 URL 上的 state 参数一致，callback 才能对上
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.AddCookie(stateCookie)
	payload, ok := app.oauthStateFromCookie(req)
	if !ok {
		t.Fatal("start 写出的 state cookie 应当可校验")
	}
	if payload.RedirectTo != "/editor" {
		t.Errorf("期望 cookie 内 redirectTo=/editor，实际 %q", payload.RedirectTo)
	}
	if !strings.Contains(location, "state="+payload.Nonce) {
		t.Error("URL 上的 state 应等于 cookie 内的 nonce")
	}
}

// 恶意 redirectTo 必须在写入 cookie 前就被 sanitize 掉
func TestOAuthStartSanitizesRedirectTo(t *testing.T) {
	app := newTestApp(config.Config{
		AppURL:            "http://localhost:5173",
		SessionSecret:     "sess",
		GoogleOAuthID:     "gid",
		GoogleOAuthSecret: "gsecret",
	})
	rec := doRequest(app, http.MethodGet, "/api/auth/oauth/google/start?redirectTo=https://evil.com")

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.AddCookie(readSetCookie(t, rec, oauthStateCookieName))
	payload, ok := app.oauthStateFromCookie(req)
	if !ok {
		t.Fatal("state cookie 应当可校验")
	}
	if payload.RedirectTo != "/dashboard" {
		t.Fatalf("外部地址应被过滤为 /dashboard，实际 %q", payload.RedirectTo)
	}
}

// ---------- callback 端点 ----------

// callback 的所有失败分支都应 302 回前端登录页并带错误码，不能泄露内部细节。
func TestOAuthCallbackFailureRedirects(t *testing.T) {
	app := newTestApp(config.Config{
		AppURL:            "http://localhost:5173",
		SessionSecret:     "sess",
		GoogleOAuthID:     "gid",
		GoogleOAuthSecret: "gsecret",
	})

	cases := []struct {
		name         string
		target       string
		cookie       *http.Cookie
		expectedCode string
	}{
		{
			name:         "provider 不支持",
			target:       "/api/auth/oauth/facebook/callback?code=c&state=s",
			expectedCode: "oauth_unsupported",
		},
		{
			name:         "用户拒绝授权",
			target:       "/api/auth/oauth/google/callback?error=access_denied",
			expectedCode: "oauth_denied",
		},
		{
			name:         "缺 code",
			target:       "/api/auth/oauth/google/callback?state=s",
			expectedCode: "oauth_missing_params",
		},
		{
			name:         "缺 state",
			target:       "/api/auth/oauth/google/callback?code=c",
			expectedCode: "oauth_missing_params",
		},
		{
			name:         "没有 state cookie",
			target:       "/api/auth/oauth/google/callback?code=c&state=s",
			expectedCode: "oauth_invalid_state",
		},
		{
			name:         "state cookie 被篡改",
			target:       "/api/auth/oauth/google/callback?code=c&state=s",
			cookie:       &http.Cookie{Name: oauthStateCookieName, Value: "forged.sig"},
			expectedCode: "oauth_invalid_state",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var rec *httptest.ResponseRecorder
			if tc.cookie != nil {
				rec = doRequest(app, http.MethodGet, tc.target, tc.cookie)
			} else {
				rec = doRequest(app, http.MethodGet, tc.target)
			}

			if rec.Code != http.StatusFound {
				t.Fatalf("期望 302，实际 %d", rec.Code)
			}
			location := rec.Header().Get("Location")
			if !strings.HasPrefix(location, "/login?error=") {
				t.Fatalf("应跳回站内登录页，实际 %q", location)
			}
			if !strings.Contains(location, tc.expectedCode) {
				t.Fatalf("期望错误码 %q，实际跳转 %q", tc.expectedCode, location)
			}
		})
	}
}

// nonce 对不上（CSRF / state 重放）必须拒绝
func TestOAuthCallbackRejectsNonceMismatch(t *testing.T) {
	app := newTestApp(config.Config{
		AppURL: "http://localhost:5173", SessionSecret: "sess",
		GoogleOAuthID: "gid", GoogleOAuthSecret: "gsecret",
	})
	token, _ := app.signOAuthState(oauthStatePayload{
		Provider: "google", RedirectTo: "/dashboard",
		Nonce: "real-nonce", ExpiresAt: time.Now().Add(time.Hour).Unix(),
	})

	rec := doRequest(app, http.MethodGet,
		"/api/auth/oauth/google/callback?code=c&state=attacker-nonce",
		&http.Cookie{Name: oauthStateCookieName, Value: token})

	if !strings.Contains(rec.Header().Get("Location"), "oauth_invalid_state") {
		t.Fatalf("nonce 不匹配应被拒绝，实际跳转 %q", rec.Header().Get("Location"))
	}
}

// 过期的 state 必须拒绝
func TestOAuthCallbackRejectsExpiredState(t *testing.T) {
	app := newTestApp(config.Config{
		AppURL: "http://localhost:5173", SessionSecret: "sess",
		GoogleOAuthID: "gid", GoogleOAuthSecret: "gsecret",
	})
	token, _ := app.signOAuthState(oauthStatePayload{
		Provider: "google", RedirectTo: "/dashboard",
		Nonce: "n", ExpiresAt: time.Now().Add(-time.Minute).Unix(),
	})

	rec := doRequest(app, http.MethodGet,
		"/api/auth/oauth/google/callback?code=c&state=n",
		&http.Cookie{Name: oauthStateCookieName, Value: token})

	if !strings.Contains(rec.Header().Get("Location"), "oauth_invalid_state") {
		t.Fatalf("过期 state 应被拒绝，实际跳转 %q", rec.Header().Get("Location"))
	}
}

// 用 A provider 签的 state 不能拿到 B provider 的 callback 上用
func TestOAuthCallbackRejectsProviderMismatch(t *testing.T) {
	app := newTestApp(config.Config{
		AppURL: "http://localhost:5173", SessionSecret: "sess",
		GoogleOAuthID: "gid", GoogleOAuthSecret: "gsecret",
		GitHubOAuthID: "hid", GitHubOAuthSecret: "hsecret",
	})
	token, _ := app.signOAuthState(oauthStatePayload{
		Provider: "github", RedirectTo: "/dashboard",
		Nonce: "n", ExpiresAt: time.Now().Add(time.Hour).Unix(),
	})

	rec := doRequest(app, http.MethodGet,
		"/api/auth/oauth/google/callback?code=c&state=n",
		&http.Cookie{Name: oauthStateCookieName, Value: token})

	if !strings.Contains(rec.Header().Get("Location"), "oauth_invalid_state") {
		t.Fatalf("provider 交叉使用应被拒绝，实际跳转 %q", rec.Header().Get("Location"))
	}
}

// 错误码需经 URL 转义，防注入到 Location 头
func TestOAuthFailureRedirectEscapes(t *testing.T) {
	app := appWithSecret("s")
	got := app.oauthFailureRedirect("weird code&x=1")
	if strings.Contains(got, "&x=1") {
		t.Fatalf("错误码应被转义，实际 %q", got)
	}
	if !strings.HasPrefix(got, "/login?error=") {
		t.Fatalf("应指向站内登录页，实际 %q", got)
	}
}
