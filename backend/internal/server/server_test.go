package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"koinote/backend/internal/config"
)

// ---------- 健康检查 ----------

func TestHealthEndpoint(t *testing.T) {
	app := newTestApp(config.Config{})
	rec := doRequest(app, http.MethodGet, "/health")

	if rec.Code != http.StatusOK {
		t.Fatalf("期望 200，实际 %d", rec.Code)
	}
	if body := rec.Body.String(); !strings.Contains(body, `"status":"ok"`) {
		t.Fatalf("响应体不符，实际 %q", body)
	}
}

// ---------- CORS ----------

// 白名单之外的来源不能拿到 CORS 头，否则任意站点都能带 cookie 打接口。
func TestCORSOriginWhitelist(t *testing.T) {
	app := newTestApp(config.Config{
		AllowedOrigins: []string{"http://localhost:5173", "https://koinote.app"},
	})

	cases := []struct {
		name        string
		origin      string
		shouldAllow bool
	}{
		{"白名单内 localhost", "http://localhost:5173", true},
		{"白名单内生产域名", "https://koinote.app", true},
		{"白名单外恶意站点", "https://evil.com", false},
		{"协议不匹配", "https://localhost:5173", false},
		{"端口不匹配", "http://localhost:9999", false},
		{"子域名不算匹配", "https://sub.koinote.app", false},
		{"无 Origin 头", "", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/health", nil)
			if tc.origin != "" {
				req.Header.Set("Origin", tc.origin)
			}
			rec := httptest.NewRecorder()
			app.Routes().ServeHTTP(rec, req)

			allowOrigin := rec.Header().Get("Access-Control-Allow-Origin")
			allowCreds := rec.Header().Get("Access-Control-Allow-Credentials")

			if tc.shouldAllow {
				if allowOrigin != tc.origin {
					t.Errorf("期望回显来源 %q，实际 %q", tc.origin, allowOrigin)
				}
				if allowCreds != "true" {
					t.Errorf("带 cookie 的跨域需要 Allow-Credentials: true，实际 %q", allowCreds)
				}
				if vary := rec.Header().Get("Vary"); vary != "Origin" {
					t.Errorf("按来源变化的响应必须设 Vary: Origin，实际 %q", vary)
				}
			} else {
				if allowOrigin != "" {
					t.Errorf("非白名单来源不应收到 Allow-Origin，实际 %q", allowOrigin)
				}
				if allowCreds != "" {
					t.Errorf("非白名单来源不应收到 Allow-Credentials，实际 %q", allowCreds)
				}
			}
		})
	}
}

// 绝不能回显通配符 *，它与 Allow-Credentials 组合会被浏览器拒绝，
// 且意味着任意站点可读响应。
func TestCORSNeverUsesWildcard(t *testing.T) {
	app := newTestApp(config.Config{AllowedOrigins: []string{"http://localhost:5173"}})
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	req.Header.Set("Origin", "http://localhost:5173")
	rec := httptest.NewRecorder()
	app.Routes().ServeHTTP(rec, req)

	if got := rec.Header().Get("Access-Control-Allow-Origin"); got == "*" {
		t.Fatal("Allow-Origin 不能是通配符")
	}
}

// 预检请求应直接 204 返回，不落到业务 handler
func TestCORSPreflight(t *testing.T) {
	app := newTestApp(config.Config{AllowedOrigins: []string{"http://localhost:5173"}})
	req := httptest.NewRequest(http.MethodOptions, "/api/auth/login", nil)
	req.Header.Set("Origin", "http://localhost:5173")
	rec := httptest.NewRecorder()
	app.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusNoContent {
		t.Fatalf("预检期望 204，实际 %d", rec.Code)
	}
	if methods := rec.Header().Get("Access-Control-Allow-Methods"); methods == "" {
		t.Error("预检响应应带 Allow-Methods")
	}
}

// ---------- 邮箱归一化 ----------

// 邮箱大小写不敏感依赖这个函数，它与数据库的 lower(email) 唯一索引必须一致。
func TestNormalizeEmail(t *testing.T) {
	cases := []struct {
		input    string
		expected string
	}{
		{"User@Example.COM", "user@example.com"},
		{"  spaced@example.com  ", "spaced@example.com"},
		{"\tTabbed@Example.com\n", "tabbed@example.com"},
		{"ALLCAPS@EXAMPLE.COM", "allcaps@example.com"},
		{"already@lower.com", "already@lower.com"},
		{"", ""},
		{"   ", ""},
	}

	for _, tc := range cases {
		if got := normalizeEmail(tc.input); got != tc.expected {
			t.Errorf("normalizeEmail(%q) = %q，期望 %q", tc.input, got, tc.expected)
		}
	}
}

// ---------- OAuth 资料兜底工具 ----------

func TestFirstNonEmpty(t *testing.T) {
	cases := []struct {
		name     string
		input    []string
		expected string
	}{
		{"取第一个", []string{"a", "b"}, "a"},
		{"跳过空串", []string{"", "b"}, "b"},
		{"跳过纯空白", []string{"   ", "\t", "c"}, "c"},
		{"全空返回空", []string{"", "  "}, ""},
		{"无参数", nil, ""},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := firstNonEmpty(tc.input...); got != tc.expected {
				t.Fatalf("期望 %q，实际 %q", tc.expected, got)
			}
		})
	}
}

// 空白资料要写成 NULL 而不是空串，避免 COALESCE(NULLIF(...)) 逻辑外的脏数据。
func TestNullableString(t *testing.T) {
	if got := nullableString("value"); got != "value" {
		t.Errorf("非空值应原样返回，实际 %v", got)
	}
	if got := nullableString(""); got != nil {
		t.Errorf("空串应返回 nil，实际 %v", got)
	}
	if got := nullableString("   "); got != nil {
		t.Errorf("纯空白应返回 nil，实际 %v", got)
	}
}

// ---------- 随机数 ----------

func TestRandomHex(t *testing.T) {
	seen := make(map[string]bool, 100)
	for i := 0; i < 100; i++ {
		got, err := randomHex(16)
		if err != nil {
			t.Fatalf("生成随机串失败: %v", err)
		}
		if len(got) != 32 {
			t.Fatalf("16 字节应编码成 32 个 hex 字符，实际 %d", len(got))
		}
		if seen[got] {
			t.Fatalf("生成了重复的 nonce %q", got)
		}
		seen[got] = true
	}
}

// ---------- 路由注册 ----------

// 认证端点必须限定方法，防止用 GET 触发写操作（GET 可被预取 / CSRF 利用）。
func TestAuthRoutesRejectWrongMethod(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "s"})

	cases := []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/auth/login"},
		{http.MethodGet, "/api/auth/register"},
		{http.MethodGet, "/api/auth/verification-code"},
		{http.MethodGet, "/api/auth/verify-email"},
		{http.MethodGet, "/api/auth/logout"},
		{http.MethodPost, "/api/auth/session"},
		{http.MethodPost, "/api/invitations"},
	}

	for _, tc := range cases {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			rec := doRequest(app, tc.method, tc.path)
			if rec.Code == http.StatusOK {
				t.Fatalf("%s %s 不应被接受", tc.method, tc.path)
			}
		})
	}
}

func TestBillingRoutesRejectWrongMethod(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "s"})
	for _, tc := range []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/api/billing/status"},
		{http.MethodGet, "/api/billing/checkout"},
		{http.MethodGet, "/api/billing/checkout/confirm"},
		{http.MethodGet, "/api/billing/webhook"},
	} {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			rec := doRequest(app, tc.method, tc.path)
			if rec.Code != http.StatusMethodNotAllowed {
				t.Fatalf("%s %s 期望 405，实际 %d", tc.method, tc.path, rec.Code)
			}
		})
	}
}

func TestAdminRouteRejectsWrongMethod(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "s"})
	rec := doRequest(app, http.MethodPost, "/api/admin/stats")
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST /api/admin/stats 期望 405，实际 %d", rec.Code)
	}
}
