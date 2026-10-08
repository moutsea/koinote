package migrations

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestApplyLegacyAgentWorkspaceMigrations(t *testing.T) {
	dsn := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is not set")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(admin.Close)
	schema := fmt.Sprintf("migration_alias_test_%d", time.Now().UnixNano())
	identifier := pgx.Identifier{schema}.Sanitize()
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+identifier); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := admin.Exec(ctx, "DROP SCHEMA "+identifier+" CASCADE"); err != nil {
			t.Error(err)
		}
	})
	config, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	config.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(ctx, `
		CREATE TABLE schema_migrations (version text PRIMARY KEY);
		CREATE TABLE migration_runs (version text PRIMARY KEY);
		INSERT INTO schema_migrations (version) VALUES
			('0058_agent_workspace_one_click_readme.sql'),
			('0059_agent_workspace_history_retention.sql'),
			('0060_agent_workspace_account_history.sql'),
			('0076_unrelated.sql');
	`); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	versions := []string{
		"0073_agent_workspace_one_click_readme.sql",
		"0074_agent_workspace_history_retention.sql",
		"0075_agent_workspace_account_history.sql",
		"0076_probe.sql",
	}
	for _, version := range versions {
		statement := fmt.Sprintf("INSERT INTO migration_runs (version) VALUES ('%s');", version)
		if err := os.WriteFile(filepath.Join(dir, version), []byte(statement), 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := Apply(ctx, pool, dir); err != nil {
		t.Fatal(err)
	}
	var runs int
	var applied string
	if err := pool.QueryRow(ctx, `SELECT count(*), min(version) FROM migration_runs`).Scan(&runs, &applied); err != nil {
		t.Fatal(err)
	}
	if runs != 1 || applied != "0076_probe.sql" {
		t.Fatalf("legacy migrations ran again or a shared numeric prefix skipped a new migration: count=%d, first=%s", runs, applied)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM schema_migrations WHERE version = ANY($1)`, []string{
		"0058_agent_workspace_one_click_readme.sql",
		"0059_agent_workspace_history_retention.sql",
		"0060_agent_workspace_account_history.sql",
	}); err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 2; attempt++ {
		if err := Apply(ctx, pool, dir); err != nil {
			t.Fatal(err)
		}
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM migration_runs`).Scan(&runs); err != nil {
		t.Fatal(err)
	}
	if runs != len(versions) {
		t.Fatalf("new migrations must run exactly once: got %d, want %d", runs, len(versions))
	}
}
