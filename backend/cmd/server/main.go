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
	// 会话密钥缺省时会回退到 BACKEND_INTERNAL_TOKEN 或开发默认值，生产环境必须显式配置。
	if cfg.SessionSecret == "" {
		if cfg.IsProduction() {
			log.Fatal("生产环境必须设置 SESSION_SECRET（可用 `openssl rand -base64 48` 生成）")
		}
		log.Println("警告: 未设置 SESSION_SECRET，已回退到 BACKEND_INTERNAL_TOKEN / 开发默认值")
	}

	// 启动时把生效的配额打出来。配错的表现是"传图突然失败"，那时再去翻配置很绕；
	// 启动日志里有这一行，一眼就能对上。
	log.Printf("图床配额: 每用户 %d MB", cfg.ImageQuotaBytes/(1024*1024))

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

	// 图片回收：删文档后排队删 R2 对象，由这个循环消费队列。
	// gcCtx 在收到退出信号时取消，让循环跟着 HTTP 服务一起收摊
	gcCtx, stopGC := context.WithCancel(ctx)
	defer stopGC()
	app.StartImageGC(gcCtx)

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
	stopGC()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(shutdownCtx)
}
