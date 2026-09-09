package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"koinote/backend/internal/config"
	"koinote/backend/internal/migrations"
)

type staticSiteAnalytics struct {
	traffic siteTraffic
	err     error
}

func (s staticSiteAnalytics) Traffic(context.Context, time.Time, time.Time) (siteTraffic, error) {
	return s.traffic, s.err
}

func TestAdminStatsRequiresAuthentication(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "secret"})
	rec := doRequest(app, http.MethodGet, "/api/admin/stats")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("未登录期望 401，实际 %d", rec.Code)
	}
}

func TestAdminServerStatusRequiresAuthentication(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "secret"})
	rec := doRequest(app, http.MethodGet, "/api/admin/server-status")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("未登录期望 401，实际 %d", rec.Code)
	}
}

func TestAdminOverviewCacheUsesOneMinuteSnapshot(t *testing.T) {
	var cache adminOverviewCache
	start := time.Date(2026, 8, 12, 0, 0, 0, 0, time.UTC)
	calls := 0
	loader := func() (adminOverview, error) {
		calls++
		return adminOverview{Users: int64(calls)}, nil
	}

	first, err := cache.load(start, start.Add(24*time.Hour), loader)
	if err != nil {
		t.Fatal(err)
	}
	second, err := cache.load(start, start.Add(24*time.Hour), loader)
	if err != nil {
		t.Fatal(err)
	}
	if calls != 1 || first.Users != 1 || second.Users != 1 {
		t.Fatalf("一分钟内应复用快照: calls=%d first=%+v second=%+v", calls, first, second)
	}

	if _, err := cache.load(start.Add(24*time.Hour), start.Add(48*time.Hour), loader); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatalf("跨统计日必须刷新缓存，calls=%d", calls)
	}
}

func TestAdminStatsAuthorizationAndAggregation(t *testing.T) {
	dsn := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("未设 TEST_DATABASE_URL，跳过管理员统计集成测试（CI 里会跑）")
	}

	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("连库失败: %v", err)
	}
	defer pool.Close()
	if err := migrations.Apply(ctx, pool, "../../migrations"); err != nil {
		t.Fatalf("跑迁移失败: %v", err)
	}

	suffix := strconv.FormatInt(time.Now().UnixNano(), 36)
	adminID := "admin-stats-" + suffix
	normalID := "normal-stats-" + suffix
	if _, err := pool.Exec(ctx, `
		INSERT INTO users (auth_user_id, email, is_verified, is_admin)
		VALUES ($1, $2, true, true), ($3, $4, true, false)
	`, adminID, adminID+"@example.com", normalID, normalID+"@example.com"); err != nil {
		t.Fatalf("插入测试用户: %v", err)
	}
	defer func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE auth_user_id = ANY($1)`, []string{adminID, normalID})
	}()
	if _, err := pool.Exec(ctx, `
		UPDATE users
		SET membership_tier = 'lifetime',
		    membership_granted_at = now()
		WHERE auth_user_id = $1
	`, normalID); err != nil {
		t.Fatalf("设置测试会员: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO credit_accounts (user_id, balance, reserved)
		SELECT id, 119, 27 FROM users WHERE auth_user_id = $1
		ON CONFLICT (user_id) DO UPDATE
		SET balance = EXCLUDED.balance, reserved = EXCLUDED.reserved
	`, normalID); err != nil {
		t.Fatalf("设置测试会员额度: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO credit_reservations (
			reservation_id, user_id, reserved_credits, status, expires_at
		)
		SELECT $1, id, 20, 'active', now() + interval '10 minutes'
		FROM users WHERE auth_user_id = $2
		UNION ALL
		SELECT $3, id, 7, 'active', now() - interval '10 minutes'
		FROM users WHERE auth_user_id = $2
	`, "admin-active-reservation-"+suffix, normalID, "admin-expired-reservation-"+suffix); err != nil {
		t.Fatalf("插入测试额度预留: %v", err)
	}
	var testDocumentID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO documents (doc_id, user_id, title, content)
		VALUES ($1, (SELECT id FROM users WHERE auth_user_id = $2), 'Token test', '')
		RETURNING id
	`, normalID+"-doc", normalID).Scan(&testDocumentID); err != nil {
		t.Fatalf("插入 token 测试文档: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO agent_reviews (
			review_id, user_id, document_id, base_revision, current_revision,
			provider_mode, provider_protocol, model, status,
			input_tokens, output_tokens, total_tokens, credits_charged
		)
		VALUES ($1, (SELECT id FROM users WHERE auth_user_id = $2), $3,
			1, 1, 'builtin', 'openai', 'test-model', 'ready', 1200, 300, 1500, 1)
	`, normalID+"-review", normalID, testDocumentID); err != nil {
		t.Fatalf("插入 token 测试审阅: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO agent_reviews (
			review_id, user_id, document_id, base_revision, current_revision,
			provider_mode, provider_protocol, model, status,
			input_tokens, output_tokens, total_tokens, credits_charged
		)
		VALUES ($1, (SELECT id FROM users WHERE auth_user_id = $2), $3,
			1, 1, 'byok', 'openai', 'byok-test-model', 'ready', 8000, 1999, 9999, 0)
	`, normalID+"-byok-review", normalID, testDocumentID); err != nil {
		t.Fatalf("插入 BYOK token 测试审阅: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO credit_transactions (
			entry_id, user_id, kind, amount, balance_after, reference_key
		)
		VALUES ($1, (SELECT id FROM users WHERE auth_user_id = $2), 'agent_usage', -1, 119, $3)
	`, "admin-token-entry-"+suffix, normalID, "admin-token-usage-"+suffix); err != nil {
		t.Fatalf("插入 token 测试消费: %v", err)
	}

	app := New(config.Config{
		SessionSecret: "secret",
		InternalToken: "internal-token",
		TimeZone:      "Asia/Shanghai",
	}, pool)

	forgedRequest := httptest.NewRequest(http.MethodGet, "/api/admin/stats", nil)
	forgedRequest.Header.Set("X-Auth-User-Id", adminID)
	forged := httptest.NewRecorder()
	app.Routes().ServeHTTP(forged, forgedRequest)
	if forged.Code != http.StatusUnauthorized {
		t.Fatalf("只有身份头、没有内部令牌必须拒绝，实际 %d", forged.Code)
	}
	normal := adminRequest(app, normalID)
	if normal.Code != http.StatusForbidden || !strings.Contains(normal.Body.String(), "admin_required") {
		t.Fatalf("普通用户期望 403 admin_required，实际 %d %s", normal.Code, normal.Body.String())
	}
	normalServerStatus := adminRequestPath(app, normalID, "/api/admin/server-status")
	if normalServerStatus.Code != http.StatusForbidden || !strings.Contains(normalServerStatus.Body.String(), "admin_required") {
		t.Fatalf("普通用户访问服务器监控期望 403 admin_required，实际 %d %s", normalServerStatus.Code, normalServerStatus.Body.String())
	}
	if _, err := pool.Exec(ctx, `
		UPDATE users
		SET last_client = 'desktop', last_client_at = now()
		WHERE auth_user_id = $1
	`, normalID); err != nil {
		t.Fatalf("设置测试客户端: %v", err)
	}

	withoutAnalytics := adminRequest(app, adminID)
	if withoutAnalytics.Code != http.StatusOK {
		t.Fatalf("管理员统计期望 200，实际 %d: %s", withoutAnalytics.Code, withoutAnalytics.Body.String())
	}
	var first adminStatsResponse
	if err := json.Unmarshal(withoutAnalytics.Body.Bytes(), &first); err != nil {
		t.Fatalf("解析响应: %v", err)
	}
	if first.Traffic.Available || first.Traffic.Reason != "not_configured" {
		t.Fatalf("未配置 Cloudflare 时应单独降级: %+v", first.Traffic)
	}
	if first.Overview.Users < 2 || first.Overview.Members < 1 || len(first.Trend) != adminTrendDays {
		t.Fatalf("业务统计不完整: overview=%+v trend=%d", first.Overview, len(first.Trend))
	}
	var recentNormal *adminRecentUser
	for index := range first.RecentUsers {
		if first.RecentUsers[index].Email == normalID+"@example.com" {
			recentNormal = &first.RecentUsers[index]
			break
		}
	}
	if recentNormal == nil || recentNormal.LastClient == nil || *recentNormal.LastClient != "desktop" || recentNormal.LastClientAt == nil {
		t.Fatalf("最近用户应返回客户端与使用时间: %+v", recentNormal)
	}
	if first.PaidTokenUsage.PaidUsers < 1 || first.PaidTokenUsage.TotalTokens < 1500 ||
		first.PaidTokenUsage.UsedCredits < 1 || first.PaidTokenUsage.AvailableCredits < 99 {
		t.Fatalf("付费用户 token 汇总不符: %+v", first.PaidTokenUsage)
	}
	var paidNormal *adminPaidUser
	for index := range first.PaidUsers {
		if first.PaidUsers[index].Email == normalID+"@example.com" {
			paidNormal = &first.PaidUsers[index]
			break
		}
	}
	if paidNormal == nil || paidNormal.TotalTokens != 1500 || paidNormal.UsedCredits != 1 ||
		paidNormal.ReservedCredits != 20 || paidNormal.AvailableCredits != 99 {
		t.Fatalf("付费用户 token 明细应排除 BYOK 审阅: %+v", paidNormal)
	}

	app.siteAnalytics = staticSiteAnalytics{traffic: siteTraffic{
		PageViews: 21, UniqueVisitors: 8, Requests: 34, Bytes: 55,
	}}
	withAnalytics := adminRequest(app, adminID)
	var second adminStatsResponse
	if err := json.Unmarshal(withAnalytics.Body.Bytes(), &second); err != nil {
		t.Fatalf("解析流量响应: %v", err)
	}
	if !second.Traffic.Available || second.Traffic.PageViews != 21 || second.Traffic.UniqueVisitors != 8 {
		t.Fatalf("流量统计不符: %+v", second.Traffic)
	}

	serverStatusRecorder := adminRequestPath(app, adminID, "/api/admin/server-status")
	if serverStatusRecorder.Code != http.StatusOK {
		t.Fatalf("管理员服务器监控期望 200，实际 %d: %s", serverStatusRecorder.Code, serverStatusRecorder.Body.String())
	}
	var serverStatus adminServerStatusResponse
	if err := json.Unmarshal(serverStatusRecorder.Body.Bytes(), &serverStatus); err != nil {
		t.Fatalf("解析服务器监控响应: %v", err)
	}
	if serverStatus.GeneratedAt.IsZero() {
		t.Fatalf("服务器监控缺少采集时间: %+v", serverStatus)
	}
}

func adminRequest(app *App, authUserID string) *httptest.ResponseRecorder {
	return adminRequestPath(app, authUserID, "/api/admin/stats")
}

func adminRequestPath(app *App, authUserID string, path string) *httptest.ResponseRecorder {
	token, _ := app.signSession(authUserID, 1)
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.AddCookie(&http.Cookie{Name: sessionCookieName, Value: token})
	rec := httptest.NewRecorder()
	app.Routes().ServeHTTP(rec, req)
	return rec
}
