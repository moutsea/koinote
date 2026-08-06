package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"koinote/backend/internal/config"
)

// 标签接口在未登录时必须 401，且要在触达数据库之前返回。
// 没有这道门禁，任何人都能读到别人打开了哪些文档。
func TestEditorTabsRequireAuth(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "s"})

	for _, method := range []string{http.MethodGet, http.MethodPut} {
		t.Run(method+" /api/editor/tabs", func(t *testing.T) {
			req := httptest.NewRequest(method, "/api/editor/tabs", strings.NewReader(`{}`))
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

// 标签路由不接受其他方法
func TestEditorTabsRejectWrongMethod(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "s"})

	for _, method := range []string{http.MethodPost, http.MethodDelete, http.MethodPatch} {
		req := httptest.NewRequest(method, "/api/editor/tabs", strings.NewReader(`{}`))
		rec := httptest.NewRecorder()
		app.Routes().ServeHTTP(rec, req)

		// 未注册的方法由 mux 返回 405，不该落到 handler 里
		if rec.Code == http.StatusOK {
			t.Errorf("%s 不该被接受", method)
		}
	}
}

func strptr(s string) *string { return &s }

func TestNormalizeTabs(t *testing.T) {
	t.Run("保持顺序并去重", func(t *testing.T) {
		tabs, _, err := normalizeTabs(tabsPayload{Tabs: []string{"a", "b", "a", "c", "b"}})
		if err != nil {
			t.Fatalf("不该报错：%v", err)
		}
		want := []string{"a", "b", "c"}
		if len(tabs) != len(want) {
			t.Fatalf("期望 %v，实际 %v", want, tabs)
		}
		for i := range want {
			if tabs[i] != want[i] {
				t.Fatalf("期望 %v，实际 %v", want, tabs)
			}
		}
	})

	t.Run("空串与纯空白被丢掉", func(t *testing.T) {
		tabs, _, err := normalizeTabs(tabsPayload{Tabs: []string{"", "  ", "a"}})
		if err != nil {
			t.Fatalf("不该报错：%v", err)
		}
		if len(tabs) != 1 || tabs[0] != "a" {
			t.Fatalf("期望 [a]，实际 %v", tabs)
		}
	})

	t.Run("首尾空白被去掉", func(t *testing.T) {
		tabs, _, err := normalizeTabs(tabsPayload{Tabs: []string{"  a  "}})
		if err != nil || len(tabs) != 1 || tabs[0] != "a" {
			t.Fatalf("期望 [a]，实际 %v（err=%v）", tabs, err)
		}
	})

	t.Run("超上限报错", func(t *testing.T) {
		many := make([]string, maxOpenTabs+1)
		for i := range many {
			many[i] = string(rune('a'+i%26)) + string(rune('0'+i/26))
		}
		if _, _, err := normalizeTabs(tabsPayload{Tabs: many}); err == nil {
			t.Fatal("超过上限应报错")
		}
	})

	t.Run("恰好等于上限允许", func(t *testing.T) {
		many := make([]string, maxOpenTabs)
		for i := range many {
			many[i] = string(rune('a'+i%26)) + string(rune('0'+i/26))
		}
		if _, _, err := normalizeTabs(tabsPayload{Tabs: many}); err != nil {
			t.Fatalf("等于上限应允许，实际 %v", err)
		}
	})

	t.Run("活动标签正常带出", func(t *testing.T) {
		_, active, _ := normalizeTabs(tabsPayload{
			Tabs:        []string{"a", "b"},
			ActiveDocID: strptr("b"),
		})
		if active == nil || *active != "b" {
			t.Fatalf("期望 b，实际 %v", active)
		}
	})

	t.Run("活动标签不在列表里时退回第一个", func(t *testing.T) {
		// 客户端状态错乱时不该把悬空的 activeDocId 写进库
		_, active, _ := normalizeTabs(tabsPayload{
			Tabs:        []string{"a", "b"},
			ActiveDocID: strptr("zzz"),
		})
		if active == nil || *active != "a" {
			t.Fatalf("期望退回 a，实际 %v", active)
		}
	})

	t.Run("没给活动标签时取第一个", func(t *testing.T) {
		_, active, _ := normalizeTabs(tabsPayload{Tabs: []string{"a", "b"}})
		if active == nil || *active != "a" {
			t.Fatalf("期望 a，实际 %v", active)
		}
	})

	t.Run("空标签组没有活动标签", func(t *testing.T) {
		tabs, active, err := normalizeTabs(tabsPayload{Tabs: []string{}})
		if err != nil {
			t.Fatalf("空组不该报错：%v", err)
		}
		if len(tabs) != 0 {
			t.Fatalf("期望空，实际 %v", tabs)
		}
		if active != nil {
			t.Fatalf("空组不该有活动标签，实际 %v", *active)
		}
	})

	t.Run("nil 标签组等同空组", func(t *testing.T) {
		tabs, active, err := normalizeTabs(tabsPayload{Tabs: nil})
		if err != nil || len(tabs) != 0 || active != nil {
			t.Fatalf("期望空且无活动，实际 tabs=%v active=%v err=%v", tabs, active, err)
		}
	})

	t.Run("去重后活动标签仍能命中", func(t *testing.T) {
		_, active, _ := normalizeTabs(tabsPayload{
			Tabs:        []string{"a", "b", "b"},
			ActiveDocID: strptr("b"),
		})
		if active == nil || *active != "b" {
			t.Fatalf("期望 b，实际 %v", active)
		}
	})
}
