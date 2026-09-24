package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"

	"koinote/backend/internal/config"
)

func TestShareGrowthEndToEnd(t *testing.T) {
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "share-growth-secret"}, pool)
	owner := seedMCPUser(t, pool, app, membershipTierFree)
	publicToken := strings.Repeat("a", 32)
	protectedToken := strings.Repeat("b", 32)
	password := "correct horse"
	passwordHash, err := bcrypt.GenerateFromPassword([]byte(password), bcryptCost)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO documents (
			doc_id, user_id, title, content, share_token, share_access, share_password_hash, shared_at
		) VALUES
			($1, $2, '公开标题', $3, $4, 'link', NULL, now()),
			($5, $2, '口令秘密标题', '口令秘密正文', $6, 'password', $7, now())
	`, "share-public-"+owner.AuthUserID, owner.ID,
		"# 开头\n\n公开摘要 ![](https://img.koinote.app/u/test-user/0123456789abcdef.png)\n\n"+strings.Repeat("过渡段落", 35)+"后半篇秘密", publicToken,
		"share-protected-"+owner.AuthUserID, protectedToken, string(passwordHash)); err != nil {
		t.Fatalf("插入分享测试文档: %v", err)
	}

	requestAs := func(method, path, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		if body != "" {
			req.Header.Set("Content-Type", "application/json")
		}
		if cookie != nil {
			req.AddCookie(cookie)
		}
		rec := httptest.NewRecorder()
		app.Routes().ServeHTTP(rec, req)
		return rec
	}
	request := func(method, path, body string) *httptest.ResponseRecorder {
		return requestAs(method, path, body, nil)
	}

	public := request(http.MethodGet, "/api/share/"+publicToken, "")
	if public.Code != http.StatusOK || !strings.Contains(public.Body.String(), `"viewCount":1`) {
		t.Fatalf("公开阅读应计数一次: %d %s", public.Code, public.Body.String())
	}
	if !strings.Contains(public.Body.String(), `"isPreview":true`) || strings.Contains(public.Body.String(), "后半篇秘密") {
		t.Fatalf("匿名分享响应只能包含前半篇: %s", public.Body.String())
	}
	verifyWithoutPassword := request(http.MethodPost, "/api/share/"+publicToken+"/verify", `{"password":""}`)
	if verifyWithoutPassword.Code != http.StatusOK || !strings.Contains(verifyWithoutPassword.Body.String(), `"isPreview":true`) ||
		strings.Contains(verifyWithoutPassword.Body.String(), "后半篇秘密") {
		t.Fatalf("验证接口不能绕过匿名预览: %d %s", verifyWithoutPassword.Code, verifyWithoutPassword.Body.String())
	}
	verifiedCookie := sessionCookieFor(t, app, owner.AuthUserID, owner.SessionVersion)
	full := requestAs(http.MethodGet, "/api/share/"+publicToken, "", verifiedCookie)
	if full.Code != http.StatusOK || !strings.Contains(full.Body.String(), `"isPreview":false`) || !strings.Contains(full.Body.String(), "后半篇秘密") {
		t.Fatalf("已登录访问应取得全文: %d %s", full.Code, full.Body.String())
	}
	staleCookie := sessionCookieFor(t, app, owner.AuthUserID, owner.SessionVersion+1)
	stale := requestAs(http.MethodGet, "/api/share/"+publicToken, "", staleCookie)
	if stale.Code != http.StatusOK || !strings.Contains(stale.Body.String(), `"isPreview":true`) || strings.Contains(stale.Body.String(), "后半篇秘密") {
		t.Fatalf("失效会话只能取得预览: %d %s", stale.Code, stale.Body.String())
	}
	forged := requestAs(http.MethodGet, "/api/share/"+publicToken, "", &http.Cookie{Name: sessionCookieName, Value: "forged"})
	if forged.Code != http.StatusOK || !strings.Contains(forged.Body.String(), `"isPreview":true`) || strings.Contains(forged.Body.String(), "后半篇秘密") {
		t.Fatalf("伪造会话只能取得预览: %d %s", forged.Code, forged.Body.String())
	}
	meta := request(http.MethodGet, "/api/share/"+publicToken+"/meta", "")
	var metaBody map[string]any
	if err := json.Unmarshal(meta.Body.Bytes(), &metaBody); err != nil {
		t.Fatal(err)
	}
	if meta.Code != http.StatusOK || metaBody["title"] != "公开标题" ||
		metaBody["protected"] != false || metaBody["imageKey"] != "u/test-user/0123456789abcdef.png" ||
		!strings.Contains(metaBody["description"].(string), "公开摘要") ||
		strings.Contains(meta.Body.String(), "后半篇秘密") {
		t.Fatalf("公开 OG 元数据异常: code=%d body=%v", meta.Code, metaBody)
	}

	protected := request(http.MethodGet, "/api/share/"+protectedToken, "")
	if protected.Code != http.StatusOK || !strings.Contains(protected.Body.String(), `"requiresPassword":true`) {
		t.Fatalf("口令分享入口异常: %d %s", protected.Code, protected.Body.String())
	}
	protectedMeta := request(http.MethodGet, "/api/share/"+protectedToken+"/meta", "")
	var protectedMetaBody map[string]any
	if err := json.Unmarshal(protectedMeta.Body.Bytes(), &protectedMetaBody); err != nil {
		t.Fatal(err)
	}
	if protectedMeta.Code != http.StatusOK || strings.Contains(protectedMeta.Body.String(), "秘密") ||
		len(protectedMetaBody) != 1 || protectedMetaBody["protected"] != true {
		t.Fatalf("口令分享元数据泄露: %d %v", protectedMeta.Code, protectedMetaBody)
	}
	wrong := request(http.MethodPost, "/api/share/"+protectedToken+"/verify", `{"password":"wrong"}`)
	if wrong.Code != http.StatusUnauthorized {
		t.Fatalf("错误口令期望 401，实际 %d", wrong.Code)
	}
	var protectedViews int64
	if err := pool.QueryRow(context.Background(), `
		SELECT share_view_count FROM documents WHERE share_token = $1
	`, protectedToken).Scan(&protectedViews); err != nil {
		t.Fatal(err)
	}
	if protectedViews != 0 {
		t.Fatalf("未解锁的口令分享不应计数，实际 %d", protectedViews)
	}
	correct := request(http.MethodPost, "/api/share/"+protectedToken+"/verify", `{"password":"correct horse"}`)
	if correct.Code != http.StatusOK || !strings.Contains(correct.Body.String(), `"viewCount":1`) ||
		!strings.Contains(correct.Body.String(), `"isPreview":true`) {
		t.Fatalf("匿名口令验证成功后仍应只返回预览: %d %s", correct.Code, correct.Body.String())
	}
	correctLoggedIn := requestAs(http.MethodPost, "/api/share/"+protectedToken+"/verify", `{"password":"correct horse"}`, verifiedCookie)
	if correctLoggedIn.Code != http.StatusOK || !strings.Contains(correctLoggedIn.Body.String(), `"isPreview":false`) ||
		!strings.Contains(correctLoggedIn.Body.String(), "口令秘密正文") {
		t.Fatalf("登录并验证口令后应返回全文: %d %s", correctLoggedIn.Code, correctLoggedIn.Body.String())
	}
}

func TestProductMilestonesAreIdempotentAndFeedAdminFunnel(t *testing.T) {
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "analytics-secret"}, pool)
	user := seedMCPUser(t, pool, app, membershipTierFree)
	before, err := app.loadAdminFunnel(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	app.recordProductMilestone(context.Background(), user.ID, milestoneFirstExport)
	app.recordProductMilestone(context.Background(), user.ID, milestoneFirstExport)
	after, err := app.loadAdminFunnel(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if after.FirstExport != before.FirstExport+1 {
		t.Fatalf("重复里程碑应只计一次: before=%d after=%d", before.FirstExport, after.FirstExport)
	}
	var count int
	if err := pool.QueryRow(context.Background(), `
		SELECT COUNT(*) FROM product_milestones WHERE user_id = $1 AND event_name = $2
	`, user.ID, milestoneFirstExport).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("用户首次导出记录数 = %d，期望 1", count)
	}
}

func TestActivityTrackerRecordsOncePerUTCDay(t *testing.T) {
	var tracker activityTracker
	day := time.Date(2026, 8, 14, 0, 0, 0, 0, time.UTC)
	if !tracker.firstToday(7, day) || tracker.firstToday(7, day.Add(time.Hour)) {
		t.Fatal("同一 UTC 日同一用户只能首次返回 true")
	}
	if !tracker.firstToday(8, day.Add(time.Hour)) {
		t.Fatal("同一日不同用户应独立记录")
	}
	if !tracker.firstToday(7, day.Add(24*time.Hour)) {
		t.Fatal("跨 UTC 日后应重新记录")
	}
}
