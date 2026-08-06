package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"koinote/backend/internal/config"
)

// 文件夹的六个端点在未登录时都必须 401，且要在触达数据库之前返回。
// 少了这道门禁，别人的目录结构就能被读到。
func TestFolderEndpointsRequireAuth(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "s"})

	cases := []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/folders"},
		{http.MethodPost, "/api/folders"},
		{http.MethodPut, "/api/folders/some-folder-id"},
		{http.MethodDelete, "/api/folders/some-folder-id"},
		{http.MethodPut, "/api/folders/some-folder-id/parent"},
		{http.MethodPut, "/api/documents/some-doc-id/folder"},
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

// 伪造的会话 cookie 同样进不去
func TestFolderEndpointsRejectForgedSession(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "s"})

	req := httptest.NewRequest(http.MethodGet, "/api/folders", nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "forged|deadbeef"})
	rec := httptest.NewRecorder()
	app.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("期望 401，实际 %d（响应 %s）", rec.Code, rec.Body.String())
	}
}

func TestValidateFolderName(t *testing.T) {
	t.Run("去掉首尾空白", func(t *testing.T) {
		name, err := validateFolderName("  项目笔记  ")
		if err != nil {
			t.Fatalf("不该报错：%v", err)
		}
		if name != "项目笔记" {
			t.Errorf("期望 %q，实际 %q", "项目笔记", name)
		}
	})

	t.Run("空名字允许（前端会显示占位名）", func(t *testing.T) {
		if _, err := validateFolderName(""); err != nil {
			t.Fatalf("空名字应允许：%v", err)
		}
	})

	t.Run("按字符数计上限，不是字节数", func(t *testing.T) {
		// 60 个汉字是 180 字节；按字节计的实现会在这里误拒
		if _, err := validateFolderName(strings.Repeat("字", maxFolderNameRunes)); err != nil {
			t.Fatalf("%d 个汉字应通过：%v", maxFolderNameRunes, err)
		}
	})

	t.Run("超一个字符即拒", func(t *testing.T) {
		if _, err := validateFolderName(strings.Repeat("字", maxFolderNameRunes+1)); err == nil {
			t.Fatal("超长名字应被拒")
		}
	})
}

func TestDerefOrEmpty(t *testing.T) {
	if got := derefOrEmpty(nil); got != "" {
		t.Errorf("nil 应得空串，实际 %q", got)
	}
	s := "  abc  "
	if got := derefOrEmpty(&s); got != "abc" {
		t.Errorf("应去掉首尾空白，实际 %q", got)
	}
	empty := "   "
	if got := derefOrEmpty(&empty); got != "" {
		t.Errorf("纯空白应得空串，实际 %q", got)
	}
}

// 把文件夹移到自己身上：这条不需要数据库就能挡掉，所以能在单测里覆盖。
// 移进子孙的那条要递归查库，留给集成测试。
func TestFolderMoveRejectsSelfAsParent(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "s"})

	req := httptest.NewRequest(
		http.MethodPut,
		"/api/folders/same-id/parent",
		strings.NewReader(`{"parentFolderId":"same-id"}`),
	)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	app.Routes().ServeHTTP(rec, req)

	// 未登录时门禁先返回 401 —— 这正是期望的顺序：鉴权在业务校验之前
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("期望 401（鉴权应先于业务校验），实际 %d", rec.Code)
	}
}
