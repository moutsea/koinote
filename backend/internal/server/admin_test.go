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
		SET membership_tier = 'lifetime', membership_granted_at = now()
		WHERE auth_user_id = $1
	`, normalID); err != nil {
		t.Fatalf("设置测试会员: %v", err)
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
