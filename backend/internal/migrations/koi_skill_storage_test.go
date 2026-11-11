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

func TestKoiSkillStorageUpgradePreservesExistingLibrary(t *testing.T) {
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
	schema := fmt.Sprintf("koi_storage_upgrade_%d", time.Now().UnixNano())
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
	config.ConnConfig.RuntimeParams["search_path"] = schema + ",public"
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	baseline := t.TempDir()
	files, err := filepath.Glob("../../migrations/*.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		if filepath.Base(file) >= "0108_" {
			continue
		}
		content, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(baseline, filepath.Base(file)), content, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := Apply(ctx, pool, baseline); err != nil {
		t.Fatal(err)
	}
	// An account already exposing repository Skills must keep its settings and
	// files; this migration must not opt it into the future installed-library mode.
	if _, err := pool.Exec(ctx, `
 INSERT INTO users(auth_user_id,email,nickname,password_hash) VALUES('upgrade','upgrade@example.test','Upgrade','x');
 INSERT INTO agent_session_settings(user_id,permission) SELECT id,'full' FROM users;
 INSERT INTO agent_workspaces(user_id) SELECT id FROM users;
 INSERT INTO agent_workspace_files(workspace_id,path,content,mime_type,size_bytes,sha256)
 SELECT id,'SKILL.md',convert_to('# Review','UTF8'),'text/markdown',8,
 encode(sha256(convert_to('# Review','UTF8')),'hex') FROM agent_workspaces;
 `); err != nil {
		t.Fatal(err)
	}
	snapshot := func() string {
		t.Helper()
		var result string
		if err := pool.QueryRow(ctx, `SELECT jsonb_build_object(
 'users',(SELECT jsonb_agg(to_jsonb(u)) FROM users u),
 'settings',(SELECT jsonb_agg(to_jsonb(s)) FROM agent_session_settings s),
 'workspaces',(SELECT jsonb_agg(to_jsonb(w)) FROM agent_workspaces w),
 'files',(SELECT jsonb_agg(to_jsonb(f)) FROM agent_workspace_files f))::text`).Scan(&result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	before := snapshot()
	content, err := os.ReadFile("../../migrations/0108_koi_skill_storage.sql")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(baseline, "0108_koi_skill_storage.sql"), content, 0600); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := Apply(ctx, pool, baseline); err != nil {
			t.Fatal(err)
		}
		if after := snapshot(); after != before {
			t.Fatal("Skill storage migration changed existing account or repository data")
		}
	}
	var installed int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM koi_skill_installations`).Scan(&installed); err != nil || installed != 0 {
		t.Fatalf("migration created installations: %d %v", installed, err)
	}
}
