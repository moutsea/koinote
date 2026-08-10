package config

import (
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/joho/godotenv"
)

// Config 保存后端运行所需的环境配置。MVP 只需数据库、会话密钥、内部令牌与环境标识。
type Config struct {
	Port           string
	DatabaseURL    string
	InternalToken  string // Worker → 后端的内部鉴权令牌，同时用作 session 签名密钥
	SessionSecret  string // session HMAC 签名密钥（缺省回退到 InternalToken）
	NodeEnv        string // "production" | "development"
	AutoMigrate    bool
	MigrationsDir  string
	AllowedOrigins []string

	// DotEnvPath 记录实际加载的 .env 绝对路径，空表示没找到（如容器内）。仅用于启动日志。
	DotEnvPath string

	// WorkerURL 是 Cloudflare Worker 的基址，后端的图片回收任务调它删 R2 对象。
	// 空表示不启动回收 —— 待删记录仍会入队，配好后重启即可补上。
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

	cfg := Config{
		DotEnvPath:    dotEnvPath,
		Port:          getenv("PORT", "8080"),
		DatabaseURL:   getenv("DATABASE_URL", "postgres://koinote:koinote@localhost:5432/koinote?sslmode=disable"),
		InternalToken: os.Getenv("BACKEND_INTERNAL_TOKEN"),
		SessionSecret: os.Getenv("SESSION_SECRET"),
		NodeEnv:       getenv("NODE_ENV", "development"),
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
