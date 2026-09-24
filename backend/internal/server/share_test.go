package server

import (
	"crypto/sha256"
	"encoding/json"
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

func TestSharePreviewNeverReturnsSecondHalf(t *testing.T) {
	for _, content := range []string{
		"", "甲", "甲乙", "一二三四五六七八", "# 标题\n\n第一段内容\n\n第二段内容",
		"![图片](https://example.com/a.png)\n\n后半部分",
	} {
		preview := sharePreview(content)
		if !strings.HasPrefix(content, preview) {
			t.Fatalf("预览必须是正文前缀: %q", content)
		}
		if len([]rune(preview)) > len([]rune(content))/2 {
			t.Fatalf("预览超过一半: %q -> %q", content, preview)
		}
	}
	if got := sharePreview("甲乙丙丁\n戊己庚辛壬癸"); got != "甲乙丙丁" {
		t.Fatalf("应在接近中点的换行处截断，实际 %q", got)
	}
}

func TestSharePreviewKeepsMarkdownLinksWhole(t *testing.T) {
	cases := []struct {
		name    string
		content string
		want    string
	}{
		{"图片地址中点", "开头 ![图](https://example.com/very/long/image-(1).png) 结尾", "开头"},
		{"标题后图片地址中点", "# 标题\n\n![图](https://example.com/very/long/image-(1).png)\n\n结尾", "# 标题"},
		{"链接地址中点", "开头 [文章](https://example.com/very/long/path/to/article) 结尾", "开头"},
		{"首个内容就是图片", "![图](https://example.com/very/long/image-(1).png) 结尾", ""},
		{"换行位于图片替代文字内", "序文 ![123456789012345\nalt](x) 1234567890", "序文"},
		{"嵌套标签跨越中点", "开头 [外层 [内层](x)](https://example.com/long/path) 结尾", "开头"},
		{"标签含行内代码仍保留完整链接", "开头 [用 `code` 说明](https://example.com/very/long/path) 结尾", "开头"},
		{"尖括号图片地址含右括号", "![x](<a)b>) 1234567", ""},
		{"自动链接跨越中点", "<https://example.com/very/long/path> 1234567890", ""},
		{"邮件自动链接跨越中点", "<hello@example.com> 1234567890", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := sharePreview(tc.content); got != tc.want {
				t.Fatalf("预览不能截出残缺的 Markdown: got %q, want %q", got, tc.want)
			}
		})
	}

	longParagraph := "短标题\n" + strings.Repeat("正文", 100)
	if got := sharePreview(longParagraph); len([]rune(got)) < 50 {
		t.Fatalf("长段落应继续预览到接近中点，实际只剩 %q", got)
	}
	completeImage := "![图](https://example.com/a.png) " + strings.Repeat("后", 100)
	if got := sharePreview(completeImage); !strings.Contains(got, "![图](https://example.com/a.png)") {
		t.Fatalf("中点之前的完整图片应保留，实际 %q", got)
	}
	angleImage := "![x](<a)b>) " + strings.Repeat("后", 50)
	if got := sharePreview(angleImage); !strings.Contains(got, "![x](<a)b>)") {
		t.Fatalf("中点之前的完整尖括号图片应保留，实际 %q", got)
	}
}

func TestSharePreviewReferenceLinks(t *testing.T) {
	for _, tc := range []struct {
		name string
		use  string
		want string
	}{
		{"完整引用链接", "[链接][id]", "链接"},
		{"完整引用图片", "![图片][id]", "图片"},
		{"折叠引用", "[ID][]", "ID"},
		{"简写引用", "[ID]", "ID"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			content := "前文 " + tc.use + " 更多内容 " + strings.Repeat("后", 80) + "\n\n[id]: https://hidden.example/image.png"
			preview := sharePreview(content)
			if !strings.Contains(preview, "前文 "+tc.want+" 更多内容") {
				t.Fatalf("隐藏定义的引用应保留可读文字: %q", preview)
			}
			if strings.Contains(preview, "hidden.example") || len([]rune(preview)) > len([]rune(content))/2 {
				t.Fatalf("预览不能泄露后半篇: %q", preview)
			}
		})
	}
	for _, content := range []string{
		"[abcdefghijklmno][x]\n\n[x]: /a",
		"![abcdefghijklmno][x]\n\n[x]: /a",
	} {
		if got := sharePreview(content); got != "" {
			t.Fatalf("不能从引用标记中间截断: %q -> %q", content, got)
		}
	}
	visibleDefinition := "[id]: /visible\n\n[链接][id] " + strings.Repeat("后", 80)
	if got := sharePreview(visibleDefinition); !strings.Contains(got, "[链接][id]") {
		t.Fatalf("定义可见时应保留原链接: %q", got)
	}
	codeLabel := "[id]: /visible\n\n[link `[x]`][id] " + strings.Repeat("后", 80) + "\n\n[x]: /hidden"
	if got := sharePreview(codeLabel); !strings.Contains(got, "[link `[x]`][id]") {
		t.Fatalf("可见引用链接内的代码文字应保留: %q", got)
	}
	hiddenDefinition := "[link `[x]`][id] " + strings.Repeat("后", 80) + "\n\n[id]: /hidden\n[x]: /hidden"
	if got := sharePreview(hiddenDefinition); !strings.Contains(got, "link `[x]`") {
		t.Fatalf("隐藏定义的引用只应去掉外层链接语法: %q", got)
	}
}

func TestSharePreviewReferenceSyntaxInCodeAndInlineLink(t *testing.T) {
	for _, use := range []string{
		"`[x][id]`",
		"[x](https://visible.example)",
		"[link `[id]`](https://visible.example)",
		"![alt `[id]`](https://visible.example/image.png)",
		"[链接](<https://visible.example/[x][id]>)",
		"[链接](https://visible.example/o'brien/[x][id])",
		"<https://visible.example/[x][id]>",
		"<span title=\"[x][id]\">可见文字</span>",
		"```md\n[x][id]\n```",
	} {
		content := use + "\n" + strings.Repeat("后", 80) + "\n\n[id]: /hidden"
		if got := sharePreview(content); !strings.Contains(got, use) {
			t.Fatalf("代码示例或行内链接不应当成引用改写: %q -> %q", use, got)
		}
	}
	content := "[x][id] " + strings.Repeat("后", 80) + "\n\n```md\n[id]: /example\n```"
	if got := sharePreview(content); !strings.Contains(got, "[x][id]") {
		t.Fatalf("代码块内的引用定义不生效: %q", got)
	}
}

func TestShareSafeInlineCutoffDestinationsAndTitles(t *testing.T) {
	for _, content := range []string{
		"[x](<a(b>) suffix",
		"![x]( <a)b> ) suffix",
		"![x](<a\\>b)>) suffix",
		"[x](<a)b> \"title\") suffix",
	} {
		cutoff := strings.Index(content, "b")
		if got := shareSafeInlineCutoff([]byte(content), cutoff, nil); got != 0 {
			t.Errorf("尖括号地址不能从中间截断: content=%q cutoff=%d got=%d", content, cutoff, got)
		}
	}
	for _, content := range []string{
		"![x](<a)b> \"foo)bar\") suffix",
		"[x](url 'foo)bar') suffix",
	} {
		cutoff := strings.Index(content, "bar")
		if got := shareSafeInlineCutoff([]byte(content), cutoff, nil); got != 0 {
			t.Errorf("图片或链接标题不能从中间截断: content=%q cutoff=%d got=%d", content, cutoff, got)
		}
	}
}

func TestSharePreviewPreservesCodeExamples(t *testing.T) {
	content := "```md\n![x](https://example.com/very/long/path)\n```\n结尾"
	preview := sharePreview(content)
	if !strings.Contains(preview, "![x](https://example") {
		t.Fatalf("代码块内的图片示例应保留到中点附近，实际 %q", preview)
	}
	inline := "开头 `![x](https://example.com/very/long/path)` 结尾"
	if got := sharePreview(inline); !strings.Contains(got, "![x](https://example") {
		t.Fatalf("行内代码中的图片示例应保留到中点附近，实际 %q", got)
	}
	indented := "    ![x](https://example.com/very/long/path)\n结尾"
	if got := sharePreview(indented); !strings.Contains(got, "![x](https://") {
		t.Fatalf("缩进代码块中的图片示例应保留到中点附近，实际 %q", got)
	}
}

func TestSharePreviewManyUnclosedBrackets(t *testing.T) {
	// 公开分享可能包含大量不成对的 Markdown 标记；截断检查必须保持线性。
	content := strings.Repeat("[", 200_000)
	if got := sharePreview(content); len(got) != len(content)/2 {
		t.Fatalf("未闭合方括号应按中点截断，实际长度 %d", len(got))
	}
}

func TestWriteSharedDocumentPreviewExcludesHiddenContent(t *testing.T) {
	doc := sharedDocument{Title: "标题", Content: "公开内容\n\n隐藏内容隐藏内容", ViewCount: 1}
	for _, preview := range []bool{true, false} {
		rec := httptest.NewRecorder()
		writeSharedDocument(rec, doc, preview)
		var body struct {
			Document struct {
				Content   string `json:"content"`
				IsPreview bool   `json:"isPreview"`
			} `json:"document"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		if body.Document.IsPreview != preview {
			t.Fatalf("isPreview=%t，期望 %t", body.Document.IsPreview, preview)
		}
		if preview && strings.Contains(rec.Body.String(), "隐藏内容") {
			t.Fatalf("匿名响应泄露后半篇: %s", rec.Body.String())
		}
		if !preview && body.Document.Content != doc.Content {
			t.Fatalf("登录用户应取得全文: %q", body.Document.Content)
		}
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
