package config

import (
	"os"
	"path/filepath"
	"testing"
)

// chdir 切到临时目录并在测试结束后自动切回。
func chdir(t *testing.T, dir string) {
	t.Helper()
	original, err := os.Getwd()
	if err != nil {
		t.Fatalf("获取工作目录失败: %v", err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatalf("切换工作目录失败: %v", err)
	}
	t.Cleanup(func() { _ = os.Chdir(original) })
}

func TestLoadDotEnvReadsCurrentDir(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte("KOINOTE_TEST_KEY=from_dotenv\n"), 0o600); err != nil {
		t.Fatalf("写入 .env 失败: %v", err)
	}
	chdir(t, dir)
	t.Setenv("KOINOTE_TEST_KEY", "")
	_ = os.Unsetenv("KOINOTE_TEST_KEY")

	path := loadDotEnv()
	if path == "" {
		t.Fatal("期望找到 .env，实际返回空路径")
	}
	if got := os.Getenv("KOINOTE_TEST_KEY"); got != "from_dotenv" {
		t.Fatalf("期望 KOINOTE_TEST_KEY=from_dotenv，实际 %q", got)
	}
}

// 裸跑 `go run ./cmd/server` 时 cwd 是 backend/，.env 在上一级，必须能向上找到。
func TestLoadDotEnvReadsParentDir(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, ".env"), []byte("KOINOTE_TEST_PARENT=parent_value\n"), 0o600); err != nil {
		t.Fatalf("写入 .env 失败: %v", err)
	}
	sub := filepath.Join(root, "backend")
	if err := os.Mkdir(sub, 0o755); err != nil {
		t.Fatalf("创建子目录失败: %v", err)
	}
	chdir(t, sub)
	_ = os.Unsetenv("KOINOTE_TEST_PARENT")

	if path := loadDotEnv(); path == "" {
		t.Fatal("期望在上一级找到 .env，实际返回空路径")
	}
	if got := os.Getenv("KOINOTE_TEST_PARENT"); got != "parent_value" {
		t.Fatalf("期望 KOINOTE_TEST_PARENT=parent_value，实际 %q", got)
	}
}

// 真实环境变量优先级必须高于 .env 文件，否则 compose 注入的值会被文件里的旧值覆盖。
func TestRealEnvWinsOverDotEnv(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, ".env"), []byte("KOINOTE_TEST_PRIORITY=from_file\n"), 0o600); err != nil {
		t.Fatalf("写入 .env 失败: %v", err)
	}
	chdir(t, dir)
	t.Setenv("KOINOTE_TEST_PRIORITY", "from_real_env")

	loadDotEnv()
	if got := os.Getenv("KOINOTE_TEST_PRIORITY"); got != "from_real_env" {
		t.Fatalf("真实环境变量应当胜出，期望 from_real_env，实际 %q", got)
	}
}

// 容器内没有 .env，缺失不能报错或 panic。
func TestLoadDotEnvMissingIsNotFatal(t *testing.T) {
	chdir(t, t.TempDir())
	if path := loadDotEnv(); path != "" {
		t.Fatalf("期望没找到 .env 时返回空路径，实际 %q", path)
	}
}

// ---------- 图床配额 ----------

// IMAGE_QUOTA_MB 的解析。
//
// 这里的每一条坏输入都对应一种真实的手滑，而它们的后果是同一个：配额变成 0 或负数，
// 于是所有人都传不了图。所以解析失败必须回落到默认值，不能取零值。
func TestImageQuotaBytes(t *testing.T) {
	const mib int64 = 1024 * 1024
	fallback := DefaultImageQuotaMB * mib

	cases := []struct {
		name string
		set  bool
		raw  string
		want int64
	}{
		{name: "未设置时用默认", set: false, want: fallback},
		{name: "空串用默认", set: true, raw: "", want: fallback},
		{name: "只有空白用默认", set: true, raw: "   ", want: fallback},

		{name: "常规值", set: true, raw: "500", want: 500 * mib},
		{name: "较小的值", set: true, raw: "50", want: 50 * mib},
		{name: "1 MB", set: true, raw: "1", want: 1 * mib},
		{name: "两侧空白被裁掉", set: true, raw: "  250  ", want: 250 * mib},

		// 零和负数：语义上是"谁都不能传图"，几乎肯定不是本意
		{name: "0 回落", set: true, raw: "0", want: fallback},
		{name: "负数回落", set: true, raw: "-100", want: fallback},

		// 非数字
		{name: "非数字回落", set: true, raw: "五百", want: fallback},
		{name: "带单位后缀回落", set: true, raw: "500MB", want: fallback},
		{name: "小数回落", set: true, raw: "500.5", want: fallback},

		// 把字节数误填进 MB 字段。不设上界的话 parsed*mib 会溢出 int64 变成负数，
		// 而负配额同样意味着谁都传不了图 —— 这是最隐蔽的一种手滑
		{name: "疑似填了字节数，回落", set: true, raw: "524288000", want: fallback},
		{name: "int64 溢出边界，回落", set: true, raw: "9223372036854775807", want: fallback},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if tc.set {
				t.Setenv("IMAGE_QUOTA_MB", tc.raw)
			} else {
				t.Setenv("IMAGE_QUOTA_MB", "")
				_ = os.Unsetenv("IMAGE_QUOTA_MB")
			}

			got := imageQuotaBytes()
			if got != tc.want {
				t.Fatalf("IMAGE_QUOTA_MB=%q → %d，期望 %d", tc.raw, got, tc.want)
			}
			// 无论输入多离谱，结果必须是正数
			if got <= 0 {
				t.Fatalf("IMAGE_QUOTA_MB=%q 得到非正配额 %d", tc.raw, got)
			}
		})
	}
}

// Load 要把配额填进 Config，而不是留零值。
func TestLoadPopulatesImageQuota(t *testing.T) {
	chdir(t, t.TempDir()) // 避免读到仓库里真实的 .env
	t.Setenv("IMAGE_QUOTA_MB", "128")

	cfg := Load()
	if want := int64(128 * 1024 * 1024); cfg.ImageQuotaBytes != want {
		t.Fatalf("cfg.ImageQuotaBytes = %d，期望 %d", cfg.ImageQuotaBytes, want)
	}
}

// 没配时 Load 也要给出正数，否则默认部署直接不能传图。
func TestLoadImageQuotaDefaultsWhenUnset(t *testing.T) {
	chdir(t, t.TempDir())
	t.Setenv("IMAGE_QUOTA_MB", "")
	_ = os.Unsetenv("IMAGE_QUOTA_MB")

	cfg := Load()
	if cfg.ImageQuotaBytes != DefaultImageQuotaMB*1024*1024 {
		t.Fatalf("未配置时 cfg.ImageQuotaBytes = %d，期望默认 %d MB 对应的字节数",
			cfg.ImageQuotaBytes, DefaultImageQuotaMB)
	}
}

func TestLoadPopulatesHostMetricsPaths(t *testing.T) {
	chdir(t, t.TempDir())
	t.Setenv("HOST_METRICS_PROC_PATH", "/host/proc")
	t.Setenv("HOST_METRICS_FILESYSTEM_PATH", "/host/rootfs")

	cfg := Load()
	if cfg.HostMetricsProcPath != "/host/proc" || cfg.HostMetricsFilesystemPath != "/host/rootfs" {
		t.Fatalf("宿主机监控路径未进入配置: %+v", cfg)
	}
}

func TestMockEmailCanOnlyBeEnabledOutsideProduction(t *testing.T) {
	for _, tc := range []struct {
		name    string
		nodeEnv string
		want    bool
	}{
		{name: "development 可启用", nodeEnv: "development", want: true},
		{name: "production 强制关闭", nodeEnv: "production", want: false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			chdir(t, t.TempDir())
			t.Setenv("NODE_ENV", tc.nodeEnv)
			t.Setenv("ENABLE_MOCK_EMAIL", "true")
			if got := Load().EnableMockEmail; got != tc.want {
				t.Fatalf("NODE_ENV=%s 时 EnableMockEmail=%v，期望 %v", tc.nodeEnv, got, tc.want)
			}
		})
	}
}

func TestStripeConfigurationMustBeComplete(t *testing.T) {
	membershipOnly := Config{
		StripeSecretKey:         "sk_test_example",
		StripeWebhookSecret:     "whsec_example",
		StripeLifetimeProductID: "prod_example",
	}
	if err := membershipOnly.ValidateStripeConfig(); err != nil {
		t.Fatalf("仅会员商品的完整 Stripe 配置不应报错: %v", err)
	}
	if !membershipOnly.StripeEnabled() || !membershipOnly.StripeClientEnabled() || membershipOnly.StripeCreditsEnabled() {
		t.Fatalf("仅会员商品的启用状态错误: %+v", membershipOnly)
	}

	creditsOnly := Config{
		StripeSecretKey:        "sk_test_example",
		StripeWebhookSecret:    "whsec_example",
		StripeCreditsProductID: "prod_credits",
	}
	if err := creditsOnly.ValidateStripeConfig(); err != nil {
		t.Fatalf("仅 Credits 商品的完整 Stripe 配置不应报错: %v", err)
	}
	if creditsOnly.StripeEnabled() || !creditsOnly.StripeCreditsEnabled() || !creditsOnly.StripeClientEnabled() {
		t.Fatalf("仅 Credits 商品的启用状态错误: %+v", creditsOnly)
	}

	bothProducts := Config{
		StripeSecretKey:         "sk_test_example",
		StripeWebhookSecret:     "whsec_example",
		StripeLifetimeProductID: "prod_membership",
		StripeCreditsProductID:  "prod_credits",
	}
	if err := bothProducts.ValidateStripeConfig(); err != nil || !bothProducts.StripeWebhookEnabled() {
		t.Fatalf("两个商品共用 Stripe 客户端和 webhook 失败: err=%v cfg=%+v", err, bothProducts)
	}

	disabled := Config{}
	if err := disabled.ValidateStripeConfig(); err != nil {
		t.Fatalf("全部留空应视为关闭，不应报错: %v", err)
	}
	if disabled.StripeEnabled() {
		t.Fatal("全部留空时不应启用 Stripe")
	}

	for _, cfg := range []Config{
		{NodeEnv: "production", StripeSecretKey: "sk_test_example"},
		{NodeEnv: "production", StripeSecretKey: "sk_test_example", StripeLifetimeProductID: "prod_example"},
		{NodeEnv: "production", StripeSecretKey: "sk_test_example", StripeCreditsProductID: "prod_credits"},
		{NodeEnv: "production", StripeWebhookSecret: "whsec_example", StripeLifetimeProductID: "prod_example"},
		{NodeEnv: "production", StripeWebhookSecret: "whsec_example", StripeCreditsProductID: "prod_credits"},
	} {
		if err := cfg.ValidateStripeConfig(); err == nil {
			t.Fatalf("部分 Stripe 配置应报错: %+v", cfg)
		}
		if cfg.StripeWebhookEnabled() {
			t.Fatalf("部分 Stripe 配置不应启用: %+v", cfg)
		}
	}

	localCheckout := Config{
		NodeEnv:                 "development",
		StripeSecretKey:         "sk_test_example",
		StripeLifetimeProductID: "prod_example",
	}
	if err := localCheckout.ValidateStripeConfig(); err != nil || !localCheckout.StripeEnabled() || localCheckout.StripeWebhookEnabled() {
		t.Fatalf("开发环境应允许仅启用 Checkout: err=%v cfg=%+v", err, localCheckout)
	}
}

func TestLoadPopulatesStripeConfiguration(t *testing.T) {
	chdir(t, t.TempDir())
	t.Setenv("STRIPE_SECRET_KEY", "sk_test_example")
	t.Setenv("STRIPE_WEBHOOK_SECRET", "whsec_example")
	t.Setenv("STRIPE_LIFETIME_PRODUCT_ID", "prod_example")
	t.Setenv("STRIPE_CREDITS_PRODUCT_ID", "prod_credits")

	cfg := Load()
	if cfg.StripeSecretKey != "sk_test_example" || cfg.StripeWebhookSecret != "whsec_example" ||
		cfg.StripeLifetimeProductID != "prod_example" || cfg.StripeCreditsProductID != "prod_credits" {
		t.Fatalf("Stripe 配置未完整加载: %+v", cfg)
	}
}

func TestAgentLLMConfiguration(t *testing.T) {
	complete := Config{
		NodeEnv:          "production",
		AgentLLMProtocol: "anthropic",
		AgentLLMBaseURL:  "https://api.anthropic.com",
		AgentLLMAPIKey:   "secret",
		AgentLLMModel:    "claude-sonnet-5",
	}
	if err := complete.ValidateAgentLLMConfig(); err != nil || !complete.AgentLLMEnabled() {
		t.Fatalf("完整 Agent LLM 配置未启用: err=%v cfg=%+v", err, complete)
	}
	for _, cfg := range []Config{
		{AgentLLMProtocol: "openai"},
		{AgentLLMBaseURL: "https://api.example.com"},
		{AgentLLMAPIKey: "secret"},
		{AgentLLMModel: "model"},
		{AgentLLMProtocol: "unknown", AgentLLMBaseURL: "https://api.example.com", AgentLLMAPIKey: "secret", AgentLLMModel: "model"},
		{NodeEnv: "production", AgentLLMProtocol: "openai", AgentLLMBaseURL: "http://api.example.com", AgentLLMAPIKey: "secret", AgentLLMModel: "model"},
	} {
		if err := cfg.ValidateAgentLLMConfig(); err == nil {
			t.Fatalf("不完整或不安全的 Agent LLM 配置应报错: %+v", cfg)
		}
	}
	local := Config{
		NodeEnv:          "development",
		AgentLLMProtocol: "openai",
		AgentLLMBaseURL:  "http://127.0.0.1:11434/v1",
		AgentLLMAPIKey:   "local",
		AgentLLMModel:    "qwen",
	}
	if err := local.ValidateAgentLLMConfig(); err != nil || !local.AgentLLMEnabled() {
		t.Fatalf("开发环境应允许本地 HTTP Agent LLM: err=%v", err)
	}
}

func TestLoadPopulatesAgentLLMConfiguration(t *testing.T) {
	chdir(t, t.TempDir())
	t.Setenv("LLM_CREDENTIAL_ENCRYPTION_KEY", " credential-key ")
	t.Setenv("AGENT_LLM_PROTOCOL", " Anthropic ")
	t.Setenv("AGENT_LLM_BASE_URL", " https://api.anthropic.com ")
	t.Setenv("AGENT_LLM_API_KEY", " secret ")
	t.Setenv("AGENT_LLM_MODEL", " claude-sonnet-5 ")
	cfg := Load()
	if cfg.LLMCredentialEncryptionKey != "credential-key" ||
		cfg.AgentLLMProtocol != "anthropic" ||
		cfg.AgentLLMBaseURL != "https://api.anthropic.com" ||
		cfg.AgentLLMAPIKey != "secret" || cfg.AgentLLMModel != "claude-sonnet-5" {
		t.Fatalf("Agent LLM 配置未完整加载: %+v", cfg)
	}
}

func TestFeishuConfiguration(t *testing.T) {
	complete := Config{
		NodeEnv:          "production",
		BotWebhook:       "https://open.feishu.cn/open-apis/bot/v2/hook/example",
		BotWebhookSecret: "secret",
	}
	if err := complete.ValidateFeishuConfig(); err != nil || !complete.FeishuEnabled() {
		t.Fatalf("完整飞书配置未启用: err=%v cfg=%+v", err, complete)
	}
	for _, cfg := range []Config{
		{NodeEnv: "production", BotWebhook: complete.BotWebhook},
		{NodeEnv: "production", BotWebhookSecret: "secret"},
		{NodeEnv: "production", BotWebhook: "http://example.com/hook", BotWebhookSecret: "secret"},
		{NodeEnv: "production", BotWebhook: "not-a-url", BotWebhookSecret: "secret"},
	} {
		if err := cfg.ValidateFeishuConfig(); err == nil {
			t.Fatalf("不安全或不完整的生产飞书配置应报错: %+v", cfg)
		}
		if cfg.FeishuEnabled() {
			t.Fatalf("非法飞书配置不应启用: %+v", cfg)
		}
	}
	local := Config{NodeEnv: "development", BotWebhook: "partial"}
	if err := local.ValidateFeishuConfig(); err != nil || local.FeishuEnabled() {
		t.Fatalf("开发环境不发送飞书通知: err=%v cfg=%+v", err, local)
	}
}

func TestLoadPopulatesFeishuConfiguration(t *testing.T) {
	chdir(t, t.TempDir())
	t.Setenv("NODE_ENV", "production")
	t.Setenv("BOT_WEBHOOK", " https://open.feishu.cn/open-apis/bot/v2/hook/example ")
	t.Setenv("BOT_WEBHOOK_SECRET", " secret ")
	cfg := Load()
	if cfg.BotWebhook != "https://open.feishu.cn/open-apis/bot/v2/hook/example" ||
		cfg.BotWebhookSecret != "secret" || !cfg.FeishuEnabled() {
		t.Fatalf("飞书配置未完整加载: %+v", cfg)
	}
}

func TestLoadPopulatesCloudflareAnalyticsConfiguration(t *testing.T) {
	chdir(t, t.TempDir())
	t.Setenv("APP_URL", "https://notes.example.com:8443/app")
	t.Setenv("CLOUDFLARE_ZONE_ID", "zone_example")
	t.Setenv("CLOUDFLARE_ANALYTICS_TOKEN", "analytics_example")
	t.Setenv("CLOUDFLARE_ANALYTICS_HOST", "")
	t.Setenv("TZ", "Asia/Tokyo")

	cfg := Load()
	if cfg.CloudflareZoneID != "zone_example" || cfg.CloudflareAnalyticsToken != "analytics_example" {
		t.Fatalf("Cloudflare Analytics 配置未完整加载: %+v", cfg)
	}
	if cfg.CloudflareAnalyticsHost != "notes.example.com" {
		t.Fatalf("应从 APP_URL 推导 hostname，实际 %q", cfg.CloudflareAnalyticsHost)
	}
	if cfg.TimeZone != "Asia/Tokyo" {
		t.Fatalf("时区未加载，实际 %q", cfg.TimeZone)
	}

	t.Setenv("CLOUDFLARE_ANALYTICS_HOST", "www.example.com")
	if got := Load().CloudflareAnalyticsHost; got != "www.example.com" {
		t.Fatalf("显式 hostname 应优先，实际 %q", got)
	}
}

func TestAnnouncementLLMConfiguration(t *testing.T) {
	complete := Config{
		NodeEnv:                "production",
		AnnouncementLLMBaseURL: "https://llm.example.com/",
		AnnouncementLLMAPIKey:  "secret",
		AnnouncementLLMModel:   "translation-model",
	}
	if err := complete.ValidateAnnouncementLLMConfig(); err != nil || !complete.AnnouncementTranslationEnabled() {
		t.Fatalf("完整提醒翻译配置未启用: err=%v cfg=%+v", err, complete)
	}
	for _, cfg := range []Config{
		{NodeEnv: "production", AnnouncementLLMBaseURL: complete.AnnouncementLLMBaseURL},
		{NodeEnv: "production", AnnouncementLLMAPIKey: "secret"},
		{NodeEnv: "production", AnnouncementLLMModel: "translation-model"},
		{
			NodeEnv:                "production",
			AnnouncementLLMBaseURL: "http://llm.example.com/",
			AnnouncementLLMAPIKey:  "secret",
			AnnouncementLLMModel:   "translation-model",
		},
		{
			NodeEnv:                "production",
			AnnouncementLLMBaseURL: "https://user@example.com/",
			AnnouncementLLMAPIKey:  "secret",
			AnnouncementLLMModel:   "translation-model",
		},
	} {
		if err := cfg.ValidateAnnouncementLLMConfig(); err == nil {
			t.Fatalf("不安全或不完整的提醒翻译配置应报错: %+v", cfg)
		}
	}
	local := Config{
		NodeEnv:                "development",
		AnnouncementLLMBaseURL: "http://127.0.0.1:9999/v1",
		AnnouncementLLMAPIKey:  "secret",
		AnnouncementLLMModel:   "local-model",
	}
	if err := local.ValidateAnnouncementLLMConfig(); err != nil || !local.AnnouncementTranslationEnabled() {
		t.Fatalf("开发环境应允许本地 HTTP 翻译代理: err=%v", err)
	}
}

func TestLoadPopulatesAnnouncementLLMConfiguration(t *testing.T) {
	chdir(t, t.TempDir())
	t.Setenv("ANNOUNCEMENT_LLM_BASE_URL", " https://llm.example.com/v1 ")
	t.Setenv("ANNOUNCEMENT_LLM_API_KEY", " secret ")
	t.Setenv("ANNOUNCEMENT_LLM_MODEL", " translation-model ")
	t.Setenv("RELEASE_ANNOUNCEMENT_PATH", "/tmp/release.json")
	cfg := Load()
	if cfg.AnnouncementLLMBaseURL != "https://llm.example.com/v1" ||
		cfg.AnnouncementLLMAPIKey != "secret" ||
		cfg.AnnouncementLLMModel != "translation-model" ||
		cfg.ReleaseAnnouncementPath != "/tmp/release.json" {
		t.Fatalf("提醒配置未完整加载: %+v", cfg)
	}
}

func TestValidateWechatCoverImageConfig(t *testing.T) {
	complete := Config{
		WechatCoverImageBaseURL: "https://images.example.test/v1",
		WechatCoverImageAPIKey:  "secret",
		WechatCoverImageModel:   "image-model",
	}
	if err := complete.ValidateWechatCoverImageConfig(); err != nil || !complete.WechatCoverImageEnabled() {
		t.Fatalf("complete WeChat cover config rejected: %v", err)
	}
	for _, cfg := range []Config{
		{WechatCoverImageBaseURL: "https://images.example.test/v1"},
		{WechatCoverImageBaseURL: "http://images.example.test/v1", WechatCoverImageAPIKey: "key", WechatCoverImageModel: "model"},
		{WechatCoverImageBaseURL: "https://user@images.example.test/v1", WechatCoverImageAPIKey: "key", WechatCoverImageModel: "model"},
	} {
		if err := cfg.ValidateWechatCoverImageConfig(); err == nil {
			t.Fatalf("invalid WeChat cover config accepted: %+v", cfg)
		}
	}
	if err := (Config{}).ValidateWechatCoverImageConfig(); err != nil {
		t.Fatalf("disabled WeChat cover config rejected: %v", err)
	}
}

func TestLoadPopulatesWechatConfiguration(t *testing.T) {
	chdir(t, t.TempDir())
	t.Setenv("WECHAT_CREDENTIAL_ENCRYPTION_KEY", " credential-key ")
	t.Setenv("WECHAT_COVER_IMAGE_BASE_URL", " https://images.example.test/v1 ")
	t.Setenv("WECHAT_COVER_IMAGE_API_KEY", " image-key ")
	t.Setenv("WECHAT_COVER_IMAGE_MODEL", " image-model ")
	cfg := Load()
	if cfg.WechatCredentialEncryptionKey != "credential-key" ||
		cfg.WechatCoverImageBaseURL != "https://images.example.test/v1" ||
		cfg.WechatCoverImageAPIKey != "image-key" ||
		cfg.WechatCoverImageModel != "image-model" {
		t.Fatalf("WeChat configuration was not fully loaded: %+v", cfg)
	}
}

func TestValidateWechatAPIProxyConfig(t *testing.T) {
	for _, raw := range []string{
		"http://127.0.0.1:18080",
		"http://10.77.0.1:18080",
		"http://host.docker.internal:18080",
		"https://relay.example.test:443",
	} {
		if err := (Config{WechatAPIProxyURL: raw}).ValidateWechatAPIProxyConfig(); err != nil {
			t.Fatalf("valid proxy %q rejected: %v", raw, err)
		}
	}
	if err := (Config{NodeEnv: "production", WechatAPIProxyURL: "http://host.docker.internal:18080"}).ValidateWechatAPIProxyConfig(); err == nil {
		t.Fatal("production accepted the Docker-only proxy hostname")
	}
	for _, raw := range []string{
		"http://122.51.97.242:18080",
		"http://user:pass@10.77.0.1:18080",
		"http://10.77.0.1:18080/path",
		"https://relay.example.test:18080?token=secret",
	} {
		if err := (Config{WechatAPIProxyURL: raw}).ValidateWechatAPIProxyConfig(); err == nil {
			t.Fatalf("invalid proxy %q accepted", raw)
		}
	}
}
