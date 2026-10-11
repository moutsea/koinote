// Run once from the deployed backend container. Scheduling belongs to the
// workflow, so application restarts never trigger an unexpected catalog refresh.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"koinote/backend/internal/config"
	"koinote/backend/internal/db"
	"koinote/backend/internal/server"
)

func main() { os.Exit(run()) }

func run() int {
	apply := flag.Bool("apply", false, "Apply verified upstream changes (default: read-only preview)")
	id := flag.Int64("workspace-id", 0, "Only update this system repository (default: all)")
	discover := flag.Bool("discover", false, "Find and publish up to 20 new popular Skills repositories per Shanghai calendar day")
	flag.Parse()
	if flag.NArg() != 0 || *id < 0 || (*discover && *id != 0) {
		fmt.Fprintln(os.Stderr, "Use --apply with either --discover or --workspace-id; IDs must be nonnegative")
		return 2
	}
	token := strings.TrimSpace(os.Getenv("GITHUB_TOKEN"))
	if token == "" || strings.ContainsAny(token, "\r\n\t ") {
		fmt.Fprintln(os.Stderr, "GITHUB_TOKEN is required; pass credentials through stdin/environment, never flags")
		return 2
	}
	cfg := config.Load()
	if err := cfg.ValidateAgentRepositoryStorage(); err != nil {
		fmt.Fprintln(os.Stderr, "Repository storage configuration is invalid")
		return 2
	}
	signalCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(signalCtx, time.Hour)
	defer cancel()
	pool, err := db.Connect(ctx, cfg.DatabaseURL)
	if err != nil {
		fmt.Fprintln(os.Stderr, "Cannot connect to the repository database")
		return 1
	}
	defer pool.Close()
	// Never migrate from this command: run only against the deployed schema.
	encoder := json.NewEncoder(os.Stdout)
	app := server.New(cfg, pool)
	var summary any
	if *discover {
		summary, err = app.DiscoverSystemAgentRepositories(ctx, server.SystemRepositoryDiscoveryOptions{
			Apply: *apply, GitHubToken: token,
			OnResult: func(result server.SystemRepositoryDiscoveryResult) {
				if encoder.Encode(result) != nil {
					cancel()
				}
			},
		})
	} else {
		summary, err = app.SyncSystemAgentRepositories(ctx, server.SystemRepositorySyncOptions{
			Apply: *apply, WorkspaceID: *id, GitHubToken: token,
			OnResult: func(result server.SystemRepositorySyncResult) {
				if encoder.Encode(result) != nil {
					cancel()
				}
			},
		})
	}
	if encodeErr := encoder.Encode(map[string]any{"summary": summary, "applied": *apply}); encodeErr != nil {
		return 1
	}
	if err != nil {
		// Raw database/network errors can contain connection details or credentials.
		fmt.Fprintln(os.Stderr, "System repository maintenance did not complete successfully; see the results and summary")
		return 1
	}
	return 0
}
