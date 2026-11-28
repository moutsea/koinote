package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log"
	"net"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// 仅允许活动标签，不接受 URL、邮箱、搜索词或自由文本。
var campaignLabelPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var attributionHostPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$`)
var shareSourceKeyPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var attributionShareTokenPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)

// 首触与分享 CTA 分开传递，搜索首触不会被后续分享注册覆盖。
type registrationAttribution struct {
	UTMSource      string    `json:"utmSource,omitempty"`
	UTMMedium      string    `json:"utmMedium,omitempty"`
	UTMCampaign    string    `json:"utmCampaign,omitempty"`
	ReferrerHost   string    `json:"referrerHost,omitempty"`
	LandingPath    string    `json:"landingPath"`
	CapturedAt     time.Time `json:"capturedAt"`
	ShareSourceKey string    `json:"shareSourceKey,omitempty"`
	FirstSource    string    `json:"firstSource"`
}

type signupShareSource struct {
	DocumentID int    `json:"documentId"`
	Key        string `json:"key"`
}

type registrationContext struct {
	FirstTouch  *registrationAttribution `json:"firstTouch,omitempty"`
	ShareSignup *signupShareSource       `json:"shareSignup,omitempty"`
}

func cleanCampaignLabel(value string) string {
	value = strings.TrimSpace(value)
	if !campaignLabelPattern.MatchString(value) {
		return ""
	}
	return value
}

func cleanAttributionHost(value, appURL string) string {
	value = strings.ToLower(strings.TrimSuffix(strings.TrimSpace(value), "."))
	if len(value) > 253 || !attributionHostPattern.MatchString(value) || net.ParseIP(value) != nil {
		return ""
	}
	site, _ := url.Parse(appURL)
	if site != nil && strings.EqualFold(strings.TrimSuffix(site.Hostname(), "."), value) {
		return ""
	}
	// OAuth 返回页可能没有存储记录，授权服务器不能成为注册首触。
	if value == "accounts.google.com" || value == "oauth2.googleapis.com" {
		return ""
	}
	return value
}

func attributionLandingPath(value string) string {
	// 只接受相对路径，完整 URL 和反斜杠直接丢弃。
	if !strings.HasPrefix(value, "/") || strings.HasPrefix(value, "//") || strings.Contains(value, `\`) {
		return ""
	}
	value = strings.SplitN(strings.SplitN(value, "?", 2)[0], "#", 2)[0]
	value = strings.TrimSuffix(value, "/")
	if value == "" {
		return "/"
	}
	switch value {
	case "/pricing", "/docs", "/docs/mcp", "/docs/version-history", "/docs/ai-optimization",
		"/docs/ai-optimization/case", "/docs/wechat-official-account", "/changelog", "/editor",
		"/login", "/register", "/desktop/authorize", "/billing/desktop-return", "/dashboard",
		"/settings", "/repositories", "/agent/workspaces", "/space/settings", "/agent/settings",
		"/space", "/ai-settings", "/mcp/activity", "/documents", "/trash", "/invitations",
		"/admin", "/privacy", "/terms", "/cookies":
		return value
	}
	for _, route := range []struct{ prefix, template string }{
		{"/share/", "/share/:token"}, {"/editor/", "/editor/:docId"},
		{"/repositories/", "/repositories/:repositoryId"}, {"/agent/workspaces/", "/agent/workspaces/:workspaceId"},
	} {
		if strings.HasPrefix(value, route.prefix) {
			segment := strings.TrimPrefix(value, route.prefix)
			if segment != "" && !strings.ContainsAny(segment, "/%") {
				return route.template
			}
		}
	}
	return ""
}

func (a *App) cleanRegistrationAttribution(raw json.RawMessage) *registrationAttribution {
	if len(raw) == 0 || len(raw) > 2048 {
		return nil
	}
	var value registrationAttribution
	if json.Unmarshal(raw, &value) != nil {
		return nil
	}
	value.LandingPath = attributionLandingPath(value.LandingPath)
	if value.LandingPath == "" || value.CapturedAt.Before(time.Date(2020, 1, 1, 0, 0, 0, 0, time.UTC)) || value.CapturedAt.After(time.Now().Add(5*time.Minute)) {
		return nil
	}
	value.UTMSource = cleanCampaignLabel(value.UTMSource)
	value.UTMMedium = cleanCampaignLabel(value.UTMMedium)
	value.UTMCampaign = cleanCampaignLabel(value.UTMCampaign)
	value.ReferrerHost = cleanAttributionHost(value.ReferrerHost, a.cfg.AppURL)
	if value.LandingPath != "/share/:token" || !shareSourceKeyPattern.MatchString(value.ShareSourceKey) {
		value.ShareSourceKey = ""
	}
	switch {
	case value.UTMSource != "":
		value.FirstSource = value.UTMSource
	case value.ReferrerHost != "":
		value.FirstSource = value.ReferrerHost
	case value.LandingPath == "/share/:token":
		value.FirstSource = "share"
	default:
		value.FirstSource = "direct"
	}
	return &value
}

// token 只用作当前有效分享的查询凭据。签名 state 和分析表只持有摘要。
func (a *App) registrationShareSource(ctx context.Context, raw json.RawMessage) *signupShareSource {
	var token string
	if len(raw) > 80 || json.Unmarshal(raw, &token) != nil || !attributionShareTokenPattern.MatchString(token) || a.db == nil {
		return nil
	}
	var documentID int
	err := a.db.QueryRow(ctx, `SELECT id FROM documents WHERE share_token = $1 AND trashed_at IS NULL`, token).Scan(&documentID)
	if err != nil {
		if err != pgx.ErrNoRows {
			log.Print("registration share lookup failed")
		}
		return nil
	}
	digest := sha256.Sum256([]byte(token))
	return &signupShareSource{DocumentID: documentID, Key: hex.EncodeToString(digest[:])}
}

// 仅在新建账号事务中调用。有效首触与用户原子提交，复用账号分支不写入。
func insertRegistrationAttribution(ctx context.Context, tx pgx.Tx, userID int, registration registrationContext) error {
	if first := registration.FirstTouch; first != nil {
		if _, err := tx.Exec(ctx, `
            INSERT INTO user_registration_attribution
                (user_id, utm_source, utm_medium, utm_campaign, referrer_host, landing_path, first_source, captured_at, share_source_key)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
            ON CONFLICT (user_id) DO NOTHING
        `, userID, first.UTMSource, first.UTMMedium, first.UTMCampaign, first.ReferrerHost,
			first.LandingPath, first.FirstSource, first.CapturedAt, nullableString(first.ShareSourceKey)); err != nil {
			return err
		}
	}
	_, err := tx.Exec(ctx, `
        UPDATE product_analytics_meta
        SET attribution_started_at = COALESCE(attribution_started_at, now()),
            share_signup_started_at = COALESCE(share_signup_started_at, now())
        WHERE singleton AND (attribution_started_at IS NULL OR share_signup_started_at IS NULL)
    `)
	return err
}
