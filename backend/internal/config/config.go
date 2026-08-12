package config

import (
	"fmt"
	"log"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/joho/godotenv"
)

// Config 保存后端运行所需的环境配置。
type Config struct {
	Port           string
	DatabaseURL    string
	InternalToken  string // Worker 与后端双向调用使用的内部鉴权令牌
	SessionSecret  string // session HMAC 签名密钥，不允许回退到其他凭据
	NodeEnv        string // "production" | "development"
	AutoMigrate    bool
	MigrationsDir  string
	AllowedOrigins []string

	// DotEnvPath 记录实际加载的 .env 绝对路径，空表示没找到（如容器内）。仅用于启动日志。
	DotEnvPath string

	// WorkerURL 是 Cloudflare Worker 的基址。后端调它删除 R2 对象，并通过
	// Email binding 发送注册验证码。空表示图片回收不启动、验证码发信返回 503。
	WorkerURL string

	// ImageQuotaBytes 是每用户的图床上限，来自 IMAGE_QUOTA_MB。
	//
	// 放环境变量而不是代码常量：这是运营旋钮，改它不该要重新编译，dev、自部署、
	// 生产也本该能给不同的值。
	ImageQuotaBytes int64

	// OAuth：用于拼回调地址的对外基址，及各 provider 的凭证
	AppURL            string
	GoogleOAuthID     string
	GoogleOAuthSecret string
	GitHubOAuthID     string
	GitHubOAuthSecret string

	// 邮箱验证码由后端生成并写入 Postgres，再调用 Worker 的 Email binding 发出。
	// 开发环境可回退复用 SessionSecret；生产环境由 main.go 强制要求独立配置。
	EmailVerificationSecret string
	EnableMockEmail         bool

	// Stripe Checkout：三项必须同时配置；全部留空时关闭会员购买，方便自部署。
	StripeSecretKey         string
	StripeWebhookSecret     string
	StripeLifetimeProductID string

	// 飞书付款通知沿用 Kimiseek 的机器人配置名。两项同时配置才启用；
	// 生产环境只配置一项时拒绝启动，避免付款后静默漏通知。
	BotWebhook       string
	BotWebhookSecret string

	// Admin 流量面板通过 Cloudflare GraphQL Analytics API 读取边缘 UV/PV。
	// Token 应只授予目标 Zone 的 Analytics Read 权限；缺失时业务统计仍可用。
	CloudflareZoneID         string
	CloudflareAnalyticsToken string
	CloudflareAnalyticsHost  string
	TimeZone                 string
}

// dotenvCandidates 是相对工作目录向上查找 .env 的顺序。
// 裸跑 `go run ./cmd/server` 时 cwd 是 backend/，.env 在上一级；
// 在仓库根跑时就是 ./.env。容器里没有 .env，全部落空也不算错。
var dotenvCandidates = []string{".env", "../.env", "../../.env"}

// loadDotEnv 加载第一个找到的 .env 文件。
// 用 godotenv.Load（非 Overload）：真实环境变量优先级更高，
// 所以 docker-compose 注入的值不会被文件里的旧值覆盖。
func loadDotEnv() string {
	for _, candidate := range dotenvCandidates {
		if _, err := os.Stat(candidate); err != nil {
			continue
		}
		if err := godotenv.Load(candidate); err != nil {
			continue
		}
		abs, err := filepath.Abs(candidate)
		if err != nil {
			return candidate
		}
		return abs
	}
	return ""
}

func Load() Config {
	dotEnvPath := loadDotEnv()

	nodeEnv := getenv("NODE_ENV", "development")
	cfg := Config{
		DotEnvPath:    dotEnvPath,
		Port:          getenv("PORT", "8080"),
		DatabaseURL:   getenv("DATABASE_URL", "postgres://koinote:koinote@localhost:5432/koinote?sslmode=disable"),
		InternalToken: os.Getenv("BACKEND_INTERNAL_TOKEN"),
		SessionSecret: os.Getenv("SESSION_SECRET"),
		NodeEnv:       nodeEnv,
		AutoMigrate:   getenv("AUTO_MIGRATE", "true") == "true",
		MigrationsDir: getenv("MIGRATIONS_DIR", "migrations"),
		WorkerURL:     strings.TrimRight(os.Getenv("WORKER_URL"), "/"),

		ImageQuotaBytes: imageQuotaBytes(),

		// OAuth 回调基址：本地 dev 默认走 Vite dev server（前端同源代理 /api 到后端）。
		// 5273 要与 vite.config.ts 的 DEV_PORT 回落值一致 —— 这两处默认值不一致时，
		// 没设 DEV_PORT 的人会遇到「前端在 5273，而 OAuth 回跳去 5173」，
		// 而 provider 按登记地址回跳打到空端口，报错还查不出来。
		AppURL:            getenv("APP_URL", "http://localhost:5273"),
		GoogleOAuthID:     os.Getenv("GOOGLE_CLIENT_ID"),
		GoogleOAuthSecret: os.Getenv("GOOGLE_CLIENT_SECRET"),
		GitHubOAuthID:     os.Getenv("GITHUB_CLIENT_ID"),
		GitHubOAuthSecret: os.Getenv("GITHUB_CLIENT_SECRET"),

		EmailVerificationSecret: os.Getenv("EMAIL_VERIFICATION_SECRET"),
		EnableMockEmail:         nodeEnv != "production" && getenv("ENABLE_MOCK_EMAIL", "false") == "true",

		StripeSecretKey:         strings.TrimSpace(os.Getenv("STRIPE_SECRET_KEY")),
		StripeWebhookSecret:     strings.TrimSpace(os.Getenv("STRIPE_WEBHOOK_SECRET")),
		StripeLifetimeProductID: strings.TrimSpace(os.Getenv("STRIPE_LIFETIME_PRODUCT_ID")),

		BotWebhook:       strings.TrimSpace(os.Getenv("BOT_WEBHOOK")),
		BotWebhookSecret: strings.TrimSpace(os.Getenv("BOT_WEBHOOK_SECRET")),

		CloudflareZoneID:         strings.TrimSpace(os.Getenv("CLOUDFLARE_ZONE_ID")),
		CloudflareAnalyticsToken: strings.TrimSpace(os.Getenv("CLOUDFLARE_ANALYTICS_TOKEN")),
		CloudflareAnalyticsHost:  strings.TrimSpace(os.Getenv("CLOUDFLARE_ANALYTICS_HOST")),
		TimeZone:                 getenv("TZ", "Asia/Shanghai"),
	}

	if cfg.CloudflareAnalyticsHost == "" {
		if parsed, err := url.Parse(cfg.AppURL); err == nil {
			cfg.CloudflareAnalyticsHost = parsed.Hostname()
		}
	}

	// 同上：5273 与 vite 的默认端口对齐
	origins := getenv("ALLOWED_ORIGINS", "http://localhost:5273,http://localhost:3000")
	for _, o := range strings.Split(origins, ",") {
		if trimmed := strings.TrimSpace(o); trimmed != "" {
			cfg.AllowedOrigins = append(cfg.AllowedOrigins, trimmed)
		}
	}

	return cfg
}

func (c Config) Addr() string {
	return ":" + c.Port
}

func (c Config) IsProduction() bool {
	return c.NodeEnv == "production"
}

// StripeEnabled 表示 Checkout 与成功页确认所需的密钥和 Price 已就绪。
// Webhook secret 只在接收 webhook 时需要；本地可先不跑 Stripe CLI。
func (c Config) StripeEnabled() bool {
	return c.StripeSecretKey != "" && c.StripeLifetimeProductID != ""
}

func (c Config) StripeWebhookEnabled() bool {
	return c.StripeEnabled() && c.StripeWebhookSecret != ""
}

func (c Config) FeishuEnabled() bool {
	if !c.IsProduction() || c.BotWebhook == "" || c.BotWebhookSecret == "" {
		return false
	}
	return validBotWebhook(c.BotWebhook)
}

func validBotWebhook(rawURL string) bool {
	parsed, err := url.Parse(rawURL)
	return err == nil && parsed.Scheme == "https" && parsed.Host != "" && parsed.User == nil
}

// ValidateStripeConfig 在生产环境拒绝只配置一部分的状态。开发环境允许暂缺 webhook
// secret，靠成功页确认即可本地走通；生产必须有 webhook 兜住用户未回跳的情况。
func (c Config) ValidateStripeConfig() error {
	configured := 0
	for _, value := range []string{c.StripeSecretKey, c.StripeWebhookSecret, c.StripeLifetimeProductID} {
		if value != "" {
			configured++
		}
	}
	if configured == 0 || configured == 3 || !c.IsProduction() {
		return nil
	}
	return fmt.Errorf("STRIPE_SECRET_KEY、STRIPE_WEBHOOK_SECRET、STRIPE_LIFETIME_PRODUCT_ID 必须同时配置或同时留空")
}

// ValidateFeishuConfig 与 Kimiseek 一样只在生产环境发送通知。自部署可以把两项
// 都留空来关闭；若要启用，必须成对配置且只能请求 HTTPS webhook。
func (c Config) ValidateFeishuConfig() error {
	if !c.IsProduction() || (c.BotWebhook == "" && c.BotWebhookSecret == "") {
		return nil
	}
	if c.BotWebhook == "" || c.BotWebhookSecret == "" {
		return fmt.Errorf("BOT_WEBHOOK、BOT_WEBHOOK_SECRET 必须同时配置或同时留空")
	}
	if !validBotWebhook(c.BotWebhook) {
		return fmt.Errorf("BOT_WEBHOOK 必须是合法的 HTTPS URL")
	}
	return nil
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// DefaultImageQuotaMB 是没配 IMAGE_QUOTA_MB 时的默认值。
const DefaultImageQuotaMB int64 = 500

// imageQuotaBytes 读 IMAGE_QUOTA_MB 并换成字节。
//
// 单位用 MB 而不是字节：让人在 .env 里写 500 比写 524288000 好 —— 后者既难读，
// 也容易少打一个 0 而无人察觉。
//
// 解析失败或值非正时回落到默认值，而不是取 0：0 的后果是所有人都传不了图，
// 也就是一个手滑的配置（`IMAGE_QUOTA_MB=` 或 `IMAGE_QUOTA_MB=五百`）能让功能整体失效。
// 配置错误宁可退回一个能用的默认值，并在日志里说明。
func imageQuotaBytes() int64 {
	const mib = 1024 * 1024
	raw := strings.TrimSpace(os.Getenv("IMAGE_QUOTA_MB"))
	if raw == "" {
		return DefaultImageQuotaMB * mib
	}

	parsed, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || parsed <= 0 {
		log.Printf(
			"IMAGE_QUOTA_MB=%q 无法解析为正整数，回落到默认的 %d MB",
			raw, DefaultImageQuotaMB,
		)
		return DefaultImageQuotaMB * mib
	}

	// 上界：超过这个数就说明单位写错了（比如把字节数填进了 MB 字段）。
	// 不加的话 parsed*mib 会溢出 int64 变成负数，而负配额意味着谁都传不了图
	const maxMB = 1024 * 1024 // 1 PB，远超任何真实用途
	if parsed > maxMB {
		log.Printf(
			"IMAGE_QUOTA_MB=%d 过大（上限 %d），回落到默认的 %d MB —— 单位是 MB，不是字节",
			parsed, maxMB, DefaultImageQuotaMB,
		)
		return DefaultImageQuotaMB * mib
	}

	return parsed * mib
}
