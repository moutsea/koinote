package config

import (
	"os"
	"path/filepath"
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

		// OAuth 回调基址：本地 dev 默认走 Vite dev server（前端同源代理 /api 到后端）
		AppURL:            getenv("APP_URL", "http://localhost:5173"),
		GoogleOAuthID:     os.Getenv("GOOGLE_CLIENT_ID"),
		GoogleOAuthSecret: os.Getenv("GOOGLE_CLIENT_SECRET"),
		GitHubOAuthID:     os.Getenv("GITHUB_CLIENT_ID"),
		GitHubOAuthSecret: os.Getenv("GITHUB_CLIENT_SECRET"),
	}

	origins := getenv("ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:3000")
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
