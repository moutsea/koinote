package migrations

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

const statementBreakpoint = "--> statement-breakpoint"

const migrationAdvisoryLockName = "koinote:schema-migrations"

var legacyMigrationAliases = map[string]string{
	"0061_agent_workspace.sql":                            "0049_agent_workspace.sql",
	"0062_agent_workspace_tokens.sql":                     "0050_agent_workspace_tokens.sql",
	"0063_agent_workspace_setup.sql":                      "0051_agent_workspace_setup.sql",
	"0064_agent_workspace_readme_backfill.sql":            "0052_agent_workspace_readme_backfill.sql",
	"0065_agent_workspace_human_readme.sql":               "0053_agent_workspace_human_readme.sql",
	"0066_agent_workspace_description_cleanup.sql":        "0054_agent_workspace_description_cleanup.sql",
	"0067_config_snapshots.sql":                           "0054_config_snapshots.sql",
	"0068_config_snapshot_unbounded.sql":                  "0055_config_snapshot_unbounded.sql",
	"0069_fix_agent_workspace_readme_leading_newline.sql": "0055_fix_agent_workspace_readme_leading_newline.sql",
	"0070_agent_workspace_storage_quota.sql":              "0056_agent_workspace_storage_quota.sql",
	"0071_config_snapshot_revision.sql":                   "0056_config_snapshot_revision.sql",
	"0072_agent_workspace_commits.sql":                    "0057_agent_workspace_commits.sql",
	"0073_agent_workspace_one_click_readme.sql":            "0058_agent_workspace_one_click_readme.sql",
	"0074_agent_workspace_history_retention.sql":           "0059_agent_workspace_history_retention.sql",
	"0075_agent_workspace_account_history.sql":             "0060_agent_workspace_account_history.sql",
}

// Apply 按文件名顺序执行 dir 下的 *.sql 迁移，已应用的跳过，记录在 schema_migrations 表。
func Apply(ctx context.Context, pool *pgxpool.Pool, dir string) error {
	conn, err := pool.Acquire(ctx)
	if err != nil {
		return fmt.Errorf("acquire migration connection: %w", err)
	}
	defer conn.Release()

	if _, err := conn.Exec(ctx, `SELECT pg_advisory_lock(hashtextextended($1, 0))`, migrationAdvisoryLockName); err != nil {
		return fmt.Errorf("acquire migration lock: %w", err)
	}
	defer func() {
		unlockCtx := context.Background()
		_, _ = conn.Exec(unlockCtx, `SELECT pg_advisory_unlock(hashtextextended($1, 0))`, migrationAdvisoryLockName)
	}()

	if _, err := conn.Exec(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version    text PRIMARY KEY,
			applied_at timestamptz NOT NULL DEFAULT now()
		)
	`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	files, err := filepath.Glob(filepath.Join(dir, "*.sql"))
	if err != nil {
		return fmt.Errorf("glob migrations: %w", err)
	}
	sort.Strings(files)

	for _, file := range files {
		version := filepath.Base(file)

		versions := []string{version}
		if legacy, ok := legacyMigrationAliases[version]; ok {
			versions = append(versions, legacy)
		}
		var exists bool
		for _, candidate := range versions {
			if err := conn.QueryRow(ctx,
				`SELECT EXISTS (SELECT 1 FROM schema_migrations WHERE version = $1)`,
				candidate,
			).Scan(&exists); err != nil {
				return fmt.Errorf("check migration %s: %w", version, err)
			}
			if exists {
				break
			}
		}
		if exists {
			continue
		}

		content, err := os.ReadFile(file)
		if err != nil {
			return fmt.Errorf("read migration %s: %w", version, err)
		}

		tx, err := conn.Begin(ctx)
		if err != nil {
			return fmt.Errorf("begin tx for %s: %w", version, err)
		}

		for _, statement := range splitStatements(string(content)) {
			if statement == "" {
				continue
			}
			if _, err := tx.Exec(ctx, statement); err != nil {
				_ = tx.Rollback(ctx)
				return fmt.Errorf("exec migration %s: %w", version, err)
			}
		}

		if _, err := tx.Exec(ctx,
			`INSERT INTO schema_migrations (version) VALUES ($1)`, version,
		); err != nil {
			_ = tx.Rollback(ctx)
			return fmt.Errorf("record migration %s: %w", version, err)
		}

		if err := tx.Commit(ctx); err != nil {
			return fmt.Errorf("commit migration %s: %w", version, err)
		}
		fmt.Printf("[migrations] applied %s\n", version)
	}

	return nil
}

func splitStatements(content string) []string {
	parts := strings.Split(content, statementBreakpoint)
	statements := make([]string, 0, len(parts))
	for _, p := range parts {
		statements = append(statements, strings.TrimSpace(p))
	}
	return statements
}
