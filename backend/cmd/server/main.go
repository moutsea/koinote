package main

import (
	"context"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"koinote/backend/internal/config"
	"koinote/backend/internal/db"
	"koinote/backend/internal/migrations"
	"koinote/backend/internal/server"
)

func main() {
	cfg := config.Load()

	if cfg.DotEnvPath != "" {
		log.Printf("已加载环境变量文件 %s", cfg.DotEnvPath)
	}
	// 会话密钥缺失一律拒绝启动，不分环境。
	//
	// 以前这道检查只在 NODE_ENV=production 时生效，缺失时回退到一个硬编码常量。
	// 那条路在开源之后是致命的：常量公开可见，拿它就能签出任意用户的会话。
	// 而 .env.example 里的 NODE_ENV 是 development，照 README 走一遍就绕过了检查
	// —— 三个各自合理的决定凑成一个默认不安全的部署。
	//
	// 不给开发环境留后门：生成一个密钥是十几秒的事，而"开发环境能跑、生产环境
	// 忘了配"这条缝隙的代价是全站会话可伪造。宁可让第一次 clone 的人多跑一行命令。
	if cfg.SessionSecret == "" {
		log.Fatal("必须设置 SESSION_SECRET。生成一个：openssl rand -base64 48")
	}
	if cfg.IsProduction() && cfg.EmailVerificationSecret == "" {
		log.Fatal("生产环境必须设置独立的 EMAIL_VERIFICATION_SECRET。生成一个：openssl rand -base64 48")
	}
	if err := cfg.ValidateStripeConfig(); err != nil {
		log.Fatal(err)
	}
	if err := cfg.ValidateFeishuConfig(); err != nil {
		log.Fatal(err)
	}

	// 启动时把生效的配额打出来。配错的表现是"传图突然失败"，那时再去翻配置很绕；
	// 启动日志里有这一行，一眼就能对上。
	log.Printf("云端存储配额: 每用户 %d MB（文档正文 + 图片）", cfg.ImageQuotaBytes/(1024*1024))
	if cfg.StripeEnabled() {
		log.Printf("Stripe 终生会员购买已启用")
	} else {
		log.Printf("Stripe 未配置，会员购买功能关闭")
	}
	if cfg.FeishuEnabled() {
		log.Printf("飞书付款通知已启用")
	} else {
		log.Printf("飞书付款通知未配置或当前不是生产环境")
	}
	if cfg.CloudflareZoneID != "" && cfg.CloudflareAnalyticsToken != "" && cfg.CloudflareAnalyticsHost != "" {
		log.Printf("Admin Cloudflare 流量统计已启用（host=%s）", cfg.CloudflareAnalyticsHost)
	} else {
		log.Printf("Admin Cloudflare 流量统计未配置，业务统计仍可用")
	}

	ctx := context.Background()
	pool, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("连接数据库失败: %v", err)
	}
	defer pool.Close()

	if cfg.AutoMigrate {
		if err := migrations.Apply(ctx, pool, cfg.MigrationsDir); err != nil {
			log.Fatalf("执行迁移失败: %v", err)
		}
	}

	app := server.New(cfg, pool)

	// 图片回收与付款通知重试都跟随 HTTP 服务的生命周期一起收摊。
	backgroundCtx, stopBackground := context.WithCancel(ctx)
	defer stopBackground()
	app.StartImageGC(backgroundCtx)
	app.StartPaymentNotificationRetry(backgroundCtx)

	httpServer := &http.Server{
		Addr:              cfg.Addr(),
		Handler:           app.Routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		log.Printf("koinote backend 监听 %s (env=%s)", cfg.Addr(), cfg.NodeEnv)
		if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("HTTP 服务异常: %v", err)
		}
	}()

	// 优雅关闭
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	log.Println("正在关闭服务…")
	stopBackground()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(shutdownCtx)
}
