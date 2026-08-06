package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"koinote/backend/internal/config"
)

// ---------- 鉴权门禁 ----------

// 五个端点在未登录时都必须 401，且必须在触达数据库之前返回。
// 这里 App.db 为 nil，一旦鉴权失守就会 panic，所以这组用例同时也是「不越过鉴权」的证明。
func TestDocumentEndpointsRequireAuth(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "s"})

	cases := []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/documents"},
		{http.MethodPost, "/api/documents"},
		{http.MethodGet, "/api/documents/some-doc-id"},
		{http.MethodPut, "/api/documents/some-doc-id"},
		{http.MethodDelete, "/api/documents/some-doc-id"},
	}

	for _, tc := range cases {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(`{}`))
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			app.Routes().ServeHTTP(rec, req)

			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("期望 401，实际 %d（响应 %s）", rec.Code, rec.Body.String())
			}
			if code := decodeErrorCode(t, rec); code != "unauthorized" {
				t.Fatalf("期望错误码 unauthorized，实际 %q", code)
			}
		})
	}
}

// 伪造的会话 cookie 同样不能进入文档接口
func TestDocumentEndpointsRejectForgedSession(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "s"})

	for _, cookieValue := range []string{"garbage", "payload.badsig", ""} {
		req := httptest.NewRequest(http.MethodGet, "/api/documents", nil)
		if cookieValue != "" {
			req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: cookieValue})
		}
		rec := httptest.NewRecorder()
		app.Routes().ServeHTTP(rec, req)

		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("cookie=%q 期望 401，实际 %d", cookieValue, rec.Code)
		}
	}
}

// 伪造内部令牌头也不能绕过（令牌未配置时这两个头必须无效）
func TestDocumentEndpointsRejectSpoofedInternalToken(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "s"})

	req := httptest.NewRequest(http.MethodGet, "/api/documents", nil)
	req.Header.Set("X-Koinote-Internal-Token", "guess")
	req.Header.Set("X-Auth-User-Id", "attacker")
	rec := httptest.NewRecorder()
	app.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("伪造内部令牌头应被拒，期望 401，实际 %d", rec.Code)
	}
}

// ---------- 路由方法限定 ----------

// 防止用 GET 触发写操作（GET 可被预取或通过 <img> 触发，是 CSRF 的常见入口）。
func TestDocumentRoutesRejectWrongMethod(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "s"})

	cases := []struct {
		method string
		path   string
	}{
		{http.MethodDelete, "/api/documents"},
		{http.MethodPut, "/api/documents"},
		{http.MethodPost, "/api/documents/some-doc-id"},
		{http.MethodPatch, "/api/documents/some-doc-id"},
	}

	for _, tc := range cases {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(`{}`))
			rec := httptest.NewRecorder()
			app.Routes().ServeHTTP(rec, req)

			// 405 由 mux 给出；401 说明匹配到了别的合法路由但被鉴权挡下。
			// 无论哪种都不能是 2xx。
			if rec.Code >= 200 && rec.Code < 300 {
				t.Fatalf("%s %s 不应成功，实际 %d", tc.method, tc.path, rec.Code)
			}
		})
	}
}

// ---------- 输入校验 ----------

// validateDocumentInput 是纯函数，可直接测，不需要数据库或会话。
func TestValidateDocumentInput(t *testing.T) {
	t.Run("正常输入去除标题首尾空白", func(t *testing.T) {
		rec := httptest.NewRecorder()
		title, content, ok := validateDocumentInput(rec, "  我的文档  ", "# 正文")
		if !ok {
			t.Fatal("正常输入应通过校验")
		}
		if title != "我的文档" {
			t.Errorf("标题应去掉首尾空白，实际 %q", title)
		}
		if content != "# 正文" {
			t.Errorf("正文不应被改动，实际 %q", content)
		}
	})

	t.Run("空标题空正文允许（新建空文档）", func(t *testing.T) {
		rec := httptest.NewRecorder()
		if _, _, ok := validateDocumentInput(rec, "", ""); !ok {
			t.Fatal("空文档应允许创建")
		}
	})

	t.Run("标题按字符数计上限", func(t *testing.T) {
		// 200 个汉字（600 字节）应通过；按字节计的实现会在此误拒
		rec := httptest.NewRecorder()
		if _, _, ok := validateDocumentInput(rec, strings.Repeat("字", maxTitleRunes), ""); !ok {
			t.Fatalf("%d 个汉字的标题应通过（上限按字符数而非字节数）", maxTitleRunes)
		}
	})

	t.Run("标题超一个字符即拒", func(t *testing.T) {
		rec := httptest.NewRecorder()
		if _, _, ok := validateDocumentInput(rec, strings.Repeat("字", maxTitleRunes+1), ""); ok {
			t.Fatal("超长标题应被拒")
		}
		if rec.Code != http.StatusBadRequest {
			t.Errorf("期望 400，实际 %d", rec.Code)
		}
		if code := decodeErrorCode(t, rec); code != "title_too_long" {
			t.Errorf("期望错误码 title_too_long，实际 %q", code)
		}
	})

	t.Run("正文达上限允许", func(t *testing.T) {
		rec := httptest.NewRecorder()
		if _, _, ok := validateDocumentInput(rec, "", strings.Repeat("a", maxContentBytes)); !ok {
			t.Fatal("正文恰好达到上限应允许")
		}
	})

	t.Run("正文超上限返回 413", func(t *testing.T) {
		rec := httptest.NewRecorder()
		if _, _, ok := validateDocumentInput(rec, "", strings.Repeat("a", maxContentBytes+1)); ok {
			t.Fatal("超限正文应被拒")
		}
		if rec.Code != http.StatusRequestEntityTooLarge {
			t.Errorf("期望 413，实际 %d", rec.Code)
		}
		if code := decodeErrorCode(t, rec); code != "content_too_large" {
			t.Errorf("期望错误码 content_too_large，实际 %q", code)
		}
	})
}

// ---------- 主题白名单 ----------

// 主题 id 直接进 SQL 的 UPDATE，白名单是它唯一的约束。
// 非法值必须落回默认而不是原样写库，也不该让整篇文档保存失败。
func TestNormalizeDocumentTheme(t *testing.T) {
	t.Run("白名单内的 id 原样保留", func(t *testing.T) {
		for _, id := range []string{"minimal", "linear", "event", "magazine"} {
			if got := normalizeDocumentTheme(id); got != id {
				t.Errorf("%q 应原样保留，实际 %q", id, got)
			}
		}
	})

	t.Run("空串是合法值：表示不套主题", func(t *testing.T) {
		if got := normalizeDocumentTheme(""); got != "" {
			t.Errorf("空串应保留为空串，实际 %q", got)
		}
	})

	t.Run("首尾空白被去掉后仍能命中白名单", func(t *testing.T) {
		if got := normalizeDocumentTheme("  minimal  "); got != "minimal" {
			t.Errorf("期望 minimal，实际 %q", got)
		}
	})

	t.Run("未知 id 落回默认", func(t *testing.T) {
		for _, id := range []string{"nope", "MINIMAL", "../etc/passwd", "'; DROP TABLE documents;--"} {
			if got := normalizeDocumentTheme(id); got != defaultDocumentTheme {
				t.Errorf("%q 应落回 %q，实际 %q", id, defaultDocumentTheme, got)
			}
		}
	})
}
