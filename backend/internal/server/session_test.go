package server

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
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

// ---------- 会话密钥只认 SESSION_SECRET ----------
//
// 这组断言取代了原来的「回退优先级」测试 —— 那套回退本身就是漏洞。
//
// 原链条：SESSION_SECRET → BACKEND_INTERNAL_TOKEN → 硬编码 "koinote-dev-session-secret"。
// 开源之后最后那个常量公开可见，拿它就能签出任意用户的会话，不需要密码。
// 而拦这件事的 main.go 检查只在 NODE_ENV=production 时生效，.env.example 里
// 写的却是 development —— 照 README 走一遍就绕过去了。
//
// 所以现在：只认 SESSION_SECRET，缺失即 panic（启动期由 main.go 提前 Fatal）。

func TestSessionSecretOnlyUsesSessionSecret(t *testing.T) {
	if got := appWithSecret("primary").sessionSecret(); got != "primary" {
		t.Fatalf("期望 primary，实际 %q", got)
	}
}

// 内部令牌绝不能再充当会话密钥。
//
// 它是 Worker → 后端的横向凭据，与会话签名是两种用途、两种轮换周期。混用意味着
// 轮换内部令牌会把所有人踢下线，且任何能读到内部令牌的组件都顺带获得了伪造
// 任意会话的能力。
func TestSessionSecretIgnoresInternalToken(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "real", InternalToken: "internal"})
	if got := app.sessionSecret(); got != "real" {
		t.Fatalf("期望 real，实际 %q", got)
	}

	// 只有内部令牌、没有会话密钥时不许"凑合能用"，必须炸
	defer func() {
		if recover() == nil {
			t.Fatal("只配了 InternalToken 时应当 panic，不能拿它当会话密钥")
		}
	}()
	newTestApp(config.Config{InternalToken: "internal"}).sessionSecret()
}

// 空密钥必须 panic 而不是返回空串。
//
// 返回空串的后果比崩溃严重得多：HMAC 用空密钥照样能算，于是任何人都能自己
// 算出合法签名 —— 全站会话可伪造，而且没有任何报错。
func TestSessionSecretPanicsWhenEmpty(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Fatal("密钥为空时必须 panic，不能用空密钥签名")
		}
	}()
	newTestApp(config.Config{}).sessionSecret()
}

// 那个曾经的硬编码兜底不能再出现在源码里。
//
// 单靠上面几条行为断言不够：有人可能"顺手"把常量加回去作为默认值，而行为测试
// 只覆盖了 cfg 为空的路径。直接读源码把这个字符串钉死。
func TestNoHardcodedSessionSecretInSource(t *testing.T) {
	for _, path := range []string{"session.go", "../config/config.go"} {
		src, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("读 %s: %v", path, err)
		}
		if strings.Contains(string(src), "koinote-dev-session-secret") {
			t.Errorf("%s 里仍有硬编码会话密钥 —— 开源后等于公开签名密钥", path)
		}
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
