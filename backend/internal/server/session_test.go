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

// newTestApp 造一个只带配置、不连库的 App。
// 只要测试路径不触达 a.db（如签名校验、参数校验、早期返回分支）就是安全的。
func newTestApp(cfg config.Config) *App {
	return &App{cfg: cfg}
}

func appWithSecret(secret string) *App {
	return newTestApp(config.Config{SessionSecret: secret})
}

// ---------- 密钥回退优先级 ----------

func TestSessionSecretPriority(t *testing.T) {
	cases := []struct {
		name     string
		cfg      config.Config
		expected string
	}{
		{
			name:     "SESSION_SECRET 优先",
			cfg:      config.Config{SessionSecret: "primary", InternalToken: "fallback"},
			expected: "primary",
		},
		{
			name:     "缺省回退到 InternalToken",
			cfg:      config.Config{InternalToken: "fallback"},
			expected: "fallback",
		},
		{
			name:     "两者皆空用开发默认值",
			cfg:      config.Config{},
			expected: "koinote-dev-session-secret",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := newTestApp(tc.cfg).sessionSecret(); got != tc.expected {
				t.Fatalf("期望密钥 %q，实际 %q", tc.expected, got)
			}
		})
	}
}

// ---------- 签名与往返 ----------

func TestSignSessionRoundTrip(t *testing.T) {
	app := appWithSecret("test-secret-abc")
	token, expiresAt := app.signSession("user-123")

	if !strings.Contains(token, ".") {
		t.Fatalf("token 应为 payload.signature 两段式，实际 %q", token)
	}
	if time.Until(expiresAt) <= 0 {
		t.Fatal("过期时间应当在未来")
	}

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: token})

	got, ok := app.authUserIDFromSessionCookie(req)
	if !ok {
		t.Fatal("自签的 cookie 应当校验通过")
	}
	if got != "user-123" {
		t.Fatalf("期望 user-123，实际 %q", got)
	}
}

// 换密钥后旧 token 必须失效，这是轮换密钥的安全前提。
func TestSessionRejectedAfterSecretRotation(t *testing.T) {
	oldApp := appWithSecret("old-secret")
	token, _ := oldApp.signSession("user-123")

	newApp := appWithSecret("new-secret")
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: token})

	if _, ok := newApp.authUserIDFromSessionCookie(req); ok {
		t.Fatal("换密钥后旧 token 仍被接受，密钥轮换失效")
	}
}

// ---------- 伪造与畸形输入 ----------

func TestSessionCookieRejectsInvalidTokens(t *testing.T) {
	app := appWithSecret("test-secret-abc")
	validToken, _ := app.signSession("user-123")
	validPayload := strings.Split(validToken, ".")[0]

	// 伪造一个未来过期、身份为 admin 的载荷，但签不出正确签名
	forged, _ := json.Marshal(sessionPayload{AuthUserID: "attacker", ExpiresAt: time.Now().Add(time.Hour).Unix()})
	forgedPayload := base64.RawURLEncoding.EncodeToString(forged)

	// 已过期但签名合法的 token
	expiredPayload, _ := json.Marshal(sessionPayload{AuthUserID: "user-123", ExpiresAt: time.Now().Add(-time.Hour).Unix()})
	expiredEncoded := base64.RawURLEncoding.EncodeToString(expiredPayload)
	expiredToken := expiredEncoded + "." + app.sessionSignature(expiredEncoded)

	// 载荷合法签名合法，但 AuthUserID 为空
	emptyIDPayload, _ := json.Marshal(sessionPayload{AuthUserID: "", ExpiresAt: time.Now().Add(time.Hour).Unix()})
	emptyIDEncoded := base64.RawURLEncoding.EncodeToString(emptyIDPayload)
	emptyIDToken := emptyIDEncoded + "." + app.sessionSignature(emptyIDEncoded)

	cases := []struct {
		name  string
		value string
	}{
		{"空值", ""},
		{"无分隔符", "garbage"},
		{"分段过多", validToken + ".extra"},
		{"签名被清零", validPayload + ".AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"},
		{"签名为空", validPayload + "."},
		{"伪造载荷配假签名", forgedPayload + ".deadbeef"},
		{"伪造载荷配他人合法签名", forgedPayload + "." + app.sessionSignature(validPayload)},
		{"载荷非法 base64", "!!!not-base64!!!." + app.sessionSignature("x")},
		{"载荷非 JSON", base64.RawURLEncoding.EncodeToString([]byte("not json")) + "." + app.sessionSignature(base64.RawURLEncoding.EncodeToString([]byte("not json")))},
		{"签名合法但已过期", expiredToken},
		{"签名合法但用户为空", emptyIDToken},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			if tc.value != "" {
				req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: tc.value})
			}
			if id, ok := app.authUserIDFromSessionCookie(req); ok {
				t.Fatalf("非法 token 被接受了，解析出身份 %q", id)
			}
		})
	}
}

func TestSessionCookieMissingEntirely(t *testing.T) {
	app := appWithSecret("test-secret-abc")
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	if _, ok := app.authUserIDFromSessionCookie(req); ok {
		t.Fatal("没有 cookie 时不应解析出身份")
	}
}

// ---------- cookie 属性 ----------

func readSetCookie(t *testing.T, rec *httptest.ResponseRecorder, name string) *http.Cookie {
	t.Helper()
	for _, c := range rec.Result().Cookies() {
		if c.Name == name {
			return c
		}
	}
	t.Fatalf("响应里没有找到 cookie %q", name)
	return nil
}

// HttpOnly 防 XSS 读取，SameSite=Lax 防 CSRF，生产 Secure 强制 HTTPS。缺一个都是安全缺口。
func TestSetSessionCookieAttributes(t *testing.T) {
	t.Run("开发环境不带 Secure", func(t *testing.T) {
		app := newTestApp(config.Config{SessionSecret: "s", NodeEnv: "development"})
		rec := httptest.NewRecorder()
		app.setSessionCookie(rec, "user-1")

		c := readSetCookie(t, rec, sessionCookieName)
		if !c.HttpOnly {
			t.Error("session cookie 必须是 HttpOnly")
		}
		if c.SameSite != http.SameSiteLaxMode {
			t.Errorf("期望 SameSite=Lax，实际 %v", c.SameSite)
		}
		if c.Path != "/" {
			t.Errorf("期望 Path=/，实际 %q", c.Path)
		}
		if c.Secure {
			t.Error("开发环境不该带 Secure，否则 http://localhost 下 cookie 发不出去")
		}
	})

	t.Run("生产环境必须带 Secure", func(t *testing.T) {
		app := newTestApp(config.Config{SessionSecret: "s", NodeEnv: "production"})
		rec := httptest.NewRecorder()
		app.setSessionCookie(rec, "user-1")

		if c := readSetCookie(t, rec, sessionCookieName); !c.Secure {
			t.Error("生产环境 session cookie 必须带 Secure")
		}
	})
}

func TestClearSessionCookie(t *testing.T) {
	app := appWithSecret("s")
	rec := httptest.NewRecorder()
	app.clearSessionCookie(rec)

	c := readSetCookie(t, rec, sessionCookieName)
	if c.Value != "" {
		t.Errorf("登出时 cookie 值应被清空，实际 %q", c.Value)
	}
	if c.MaxAge >= 0 {
		t.Errorf("登出时 MaxAge 应为负数以立即失效，实际 %d", c.MaxAge)
	}
}

// ---------- 内部令牌信任路径 ----------

// Worker → 后端用内部令牌 + X-Auth-User-Id 传递身份。
// 令牌未配置或不匹配时，这两个头必须完全无效，否则任何人都能冒充任意用户。
func TestAuthUserIDFromRequestInternalToken(t *testing.T) {
	cases := []struct {
		name       string
		configured string
		sentToken  string
		sentUserID string
		expectedID string
	}{
		{"令牌匹配则采信头部身份", "secret-token", "secret-token", "worker-user", "worker-user"},
		{"令牌未配置则忽略头部", "", "anything", "attacker", ""},
		{"令牌不匹配则忽略头部", "secret-token", "wrong-guess", "attacker", ""},
		{"令牌匹配但身份为空", "secret-token", "secret-token", "", ""},
		{"令牌匹配但身份仅空白", "secret-token", "secret-token", "   ", ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			app := newTestApp(config.Config{InternalToken: tc.configured, SessionSecret: "unrelated"})
			req := httptest.NewRequest(http.MethodGet, "/", nil)
			req.Header.Set("X-Koinote-Internal-Token", tc.sentToken)
			req.Header.Set("X-Auth-User-Id", tc.sentUserID)

			if got := app.authUserIDFromRequest(req); got != tc.expectedID {
				t.Fatalf("期望身份 %q，实际 %q", tc.expectedID, got)
			}
		})
	}
}

// 内部令牌无效时应继续回退到 cookie 校验，两条路径不能互相干扰。
func TestAuthUserIDFallsBackToCookie(t *testing.T) {
	app := newTestApp(config.Config{InternalToken: "real-token", SessionSecret: "sess"})
	token, _ := app.signSession("cookie-user")

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("X-Koinote-Internal-Token", "wrong")
	req.Header.Set("X-Auth-User-Id", "attacker")
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: token})

	if got := app.authUserIDFromRequest(req); got != "cookie-user" {
		t.Fatalf("应回退到 cookie 身份 cookie-user，实际 %q", got)
	}
}
