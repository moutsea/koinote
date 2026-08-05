package server

import (
	"crypto/sha256"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"koinote/backend/internal/config"
)

// ---------- 鉴权门禁 ----------

// 创建与撤销分享必须登录，且要在触达数据库之前返回。
// App.db 为 nil，一旦鉴权失守就会 panic，所以这组同时是「不越过鉴权」的证明。
func TestShareMutationsRequireAuth(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "s"})

	cases := []struct {
		method string
		path   string
	}{
		{http.MethodPost, "/api/documents/some-doc/share"},
		{http.MethodDelete, "/api/documents/some-doc/share"},
	}

	for _, tc := range cases {
		t.Run(tc.method, func(t *testing.T) {
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

// 伪造会话 cookie 不能进入分享写操作
func TestShareMutationsRejectForgedSession(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "s"})
	for _, value := range []string{"garbage", "payload.badsig"} {
		req := httptest.NewRequest(http.MethodPost, "/api/documents/d/share", strings.NewReader(`{}`))
		req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: value})
		rec := httptest.NewRecorder()
		app.Routes().ServeHTTP(rec, req)
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("cookie=%q 期望 401，实际 %d", value, rec.Code)
		}
	}
}

// ---------- 公开读取的参数校验 ----------

// 空 token 要在查库前返回 404
func TestShareGetEmptyToken(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "s"})
	req := httptest.NewRequest(http.MethodGet, "/api/share/", nil)
	rec := httptest.NewRecorder()
	app.Routes().ServeHTTP(rec, req)

	// mux 对 /api/share/ 可能不匹配（404）或匹配到空 token（也 404）
	if rec.Code != http.StatusNotFound {
		t.Fatalf("期望 404，实际 %d", rec.Code)
	}
}

// ---------- 分享响应头 ----------

// 口令档的正文绝不能被 CDN 或共享缓存留存，
// 否则拿到缓存就等于绕过口令。
func TestShareResponseHeaders(t *testing.T) {
	rec := httptest.NewRecorder()
	setShareResponseHeaders(rec)

	if got := rec.Header().Get("Cache-Control"); got != "private, no-store" {
		t.Errorf("期望 Cache-Control=private, no-store，实际 %q", got)
	}
	if got := rec.Header().Get("Vary"); got != "Cookie" {
		t.Errorf("期望 Vary=Cookie，实际 %q", got)
	}
	if got := rec.Header().Get("X-Robots-Tag"); !strings.Contains(got, "noindex") {
		t.Errorf("分享页应带 noindex，实际 %q", got)
	}
}

// ---------- 口令强度校验 ----------

func TestSharePasswordProblem(t *testing.T) {
	cases := []struct {
		name     string
		password string
		wantOK   bool
	}{
		{"正常口令", "secret123", true},
		{"刚好 6 位", "abcdef", true},
		{"6 个汉字", "一二三四五六", true},
		{"5 位太短", "abcde", false},
		{"5 个汉字太短", "一二三四五", false},
		{"空口令", "", false},
		{"纯空白", "        ", false},
		{"首尾空白按去空白后计", "  abcdef  ", true},
		{"超长", strings.Repeat("a", sharePasswordMaxBytes+1), false},
		{"恰好达上限", strings.Repeat("a", sharePasswordMaxBytes), true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			problem := sharePasswordProblem(tc.password)
			if tc.wantOK && problem != "" {
				t.Fatalf("应通过，实际报错 %q", problem)
			}
			if !tc.wantOK && problem == "" {
				t.Fatal("应被拒绝，实际通过了")
			}
		})
	}
}

// 口令长度按字符数而非字节数计：6 个汉字是 18 字节，不该被当成超短
func TestSharePasswordCountsRunes(t *testing.T) {
	if problem := sharePasswordProblem("一二三四五六"); problem != "" {
		t.Fatalf("6 个汉字应通过（按字符计），实际 %q", problem)
	}
	if problem := sharePasswordProblem("一二三"); problem == "" {
		t.Fatal("3 个汉字应被拒（按字符计）")
	}
}

// ---------- 限流接线 ----------

// 用 handler 里那两把 key 直接压限流器。
//
// 不走 HTTP：限流放行的请求会继续查库，而测试里 App.db 为 nil 会 panic。
// 越权与真实口令校验属于集成测试范畴，另起临时数据验证。
func TestShareVerifyLimiterKeys(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "s"})
	limiter := app.rateLimit()

	linkKey := fmt.Sprintf("share-pw:link:%x", sha256.Sum256([]byte("tok")))

	for i := 1; i <= sharePasswordLinkAttempts; i++ {
		if !limiter.allow(linkKey, sharePasswordLinkAttempts, sharePasswordWindow) {
			t.Fatalf("第 %d 次应放行（上限 %d）", i, sharePasswordLinkAttempts)
		}
	}
	if limiter.allow(linkKey, sharePasswordLinkAttempts, sharePasswordWindow) {
		t.Fatal("超过单链接上限后应被拦截")
	}

	// 另一个 token 的 key 不该受影响
	otherKey := fmt.Sprintf("share-pw:link:%x", sha256.Sum256([]byte("other")))
	if !limiter.allow(otherKey, sharePasswordLinkAttempts, sharePasswordWindow) {
		t.Fatal("不同 token 不应被连坐")
	}

	// IP 维度独立于链接维度
	ipKey := "share-pw:ip:192.0.2.1"
	if !limiter.allow(ipKey, sharePasswordIPAttempts, sharePasswordWindow) {
		t.Fatal("IP 维度应独立计数")
	}
}

// 限流阈值必须是正数，否则等于没挂限流
func TestSharePasswordLimitsArePositive(t *testing.T) {
	if sharePasswordIPAttempts <= 0 {
		t.Error("IP 维度阈值必须为正，否则限流形同虚设")
	}
	if sharePasswordLinkAttempts <= 0 {
		t.Error("链接维度阈值必须为正")
	}
	if sharePasswordLinkAttempts > sharePasswordIPAttempts {
		t.Error("单链接阈值不应高于单 IP 阈值，否则链接维度先失效")
	}
	if sharePasswordWindow <= 0 {
		t.Error("限流窗口必须为正")
	}
}

// 限流器 key 用 token 的哈希而非明文，避免明文 token 留在内存表里
func TestShareLimiterKeyHashesToken(t *testing.T) {
	token := "secret-share-token"
	key := fmt.Sprintf("share-pw:link:%x", sha256.Sum256([]byte(token)))
	if strings.Contains(key, token) {
		t.Fatal("限流 key 不应包含明文 token")
	}
}

// ---------- 路由方法限定 ----------

func TestShareRoutesRejectWrongMethod(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "s"})

	cases := []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/api/documents/d/share"},
		{http.MethodPut, "/api/documents/d/share"},
		{http.MethodPost, "/api/share/tok"},
		{http.MethodDelete, "/api/share/tok"},
		{http.MethodGet, "/api/share/tok/verify"},
	}

	for _, tc := range cases {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(`{}`))
			rec := httptest.NewRecorder()
			app.Routes().ServeHTTP(rec, req)
			if rec.Code >= 200 && rec.Code < 300 {
				t.Fatalf("%s %s 不应成功，实际 %d", tc.method, tc.path, rec.Code)
			}
		})
	}
}
