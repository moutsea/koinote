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

func TestRegistrationAttributionUpgradePreservesHistory(t *testing.T) {
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
	schema := fmt.Sprintf("registration_upgrade_%d", time.Now().UnixNano())
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
		if filepath.Base(file) >= "0126_" {
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
	var userID int
	if err := pool.QueryRow(ctx, `INSERT INTO users(auth_user_id,email) VALUES('legacy-registration','legacy@example.test') RETURNING id`).Scan(&userID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO product_milestones(user_id,event_name,occurred_at)
        SELECT $1,event,'2026-01-01T00:00:00Z'::timestamptz FROM unnest(ARRAY[
            'registered','first_document','first_upload','first_export','mcp_connected','checkout_started','checkout_completed']) AS event`, userID); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := Apply(ctx, pool, "../../migrations"); err != nil {
			t.Fatal(err)
		}
	}
	var events, attributions int
	var timesPreserved, notStarted bool
	if err := pool.QueryRow(ctx, `SELECT count(*),bool_and(occurred_at='2026-01-01T00:00:00Z'::timestamptz) FROM product_milestones WHERE user_id=$1`, userID).Scan(&events, &timesPreserved); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM user_registration_attribution`).Scan(&attributions); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT attribution_started_at IS NULL AND share_signup_started_at IS NULL FROM product_analytics_meta`).Scan(&notStarted); err != nil {
		t.Fatal(err)
	}
	if events != 7 || !timesPreserved || attributions != 0 || !notStarted {
		t.Fatalf("history changed: events=%d times=%v attributions=%d notStarted=%v", events, timesPreserved, attributions, notStarted)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO product_milestones(user_id,event_name,share_source_key) VALUES($1,'share_signup',$2)`, userID, strings.Repeat("a", 32)); err == nil {
		t.Fatal("accepted raw share token")
	}
	if _, err := pool.Exec(ctx, `INSERT INTO product_milestones(user_id,event_name,share_source_key) VALUES($1,'share_signup',$2)`, userID, strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, userID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM product_milestones WHERE user_id=$1`, userID).Scan(&events); err != nil || events != 0 {
		t.Fatalf("cascade events=%d err=%v", events, err)
	}
}
