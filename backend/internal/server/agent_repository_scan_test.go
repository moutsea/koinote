package server

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"koinote/backend/internal/config"
)

type publicationReadTrace struct {
	mu             sync.Mutex
	queries, files int64
}
type publicationReadTraceKey struct{}

func (trace *publicationReadTrace) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	return context.WithValue(ctx, publicationReadTraceKey{}, strings.Contains(data.SQL, "SELECT DISTINCT ON (f.sha256) f.sha256,f.content"))
}
func (trace *publicationReadTrace) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	if scanning, _ := ctx.Value(publicationReadTraceKey{}).(bool); scanning {
		trace.mu.Lock()
		defer trace.mu.Unlock()
		trace.queries++
		trace.files += data.CommandTag.RowsAffected()
	}
}
func (trace *publicationReadTrace) expect(t *testing.T, queries, files int64) {
	t.Helper()
	trace.mu.Lock()
	defer trace.mu.Unlock()
	if trace.queries != queries || trace.files != files {
		t.Fatalf("publication content reads: %d queries/%d files, want %d/%d", trace.queries, trace.files, queries, files)
	}
	trace.queries = 0
	trace.files = 0
}

func newPublicationScanTest(t *testing.T) (*App, *pgxpool.Pool, *publicationReadTrace, int) {
	t.Helper()
	pool := newGCTestPool(t)
	trace := &publicationReadTrace{}
	poolConfig := pool.Config().Copy()
	poolConfig.ConnConfig.Tracer = trace
	traced, err := pgxpool.NewWithConfig(context.Background(), poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(traced.Close)
	app := New(config.Config{SessionSecret: "scan-cache"}, traced)
	user := seedMCPUser(t, pool, app, membershipTierLifetime)
	return app, pool, trace, user.ID
}

func TestAgentRepositoryPublicationScanCache(t *testing.T) {
	ctx := context.Background()
	app, pool, trace, userID := newPublicationScanTest(t)
	w, err := app.createAgentWorkspace(ctx, userID, "Cache", "", "en")
	if err != nil {
		t.Fatal(err)
	}
	// Duplicate paths share one content scan, including a nontrivial-size file.
	large := strings.Repeat("# Example skill instructions.\n", 70_000)
	w, err = app.patchAgentWorkspace(ctx, userID, w.WorkspaceID, w.Revision, []agentWorkspaceFile{
		repositoryTestFile("skills/a.md", large), repositoryTestFile("skills/copy.md", large), repositoryTestFile("notes.md", "Initial note"),
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	originalRevision := w.Revision
	publish := func() {
		t.Helper()
		if err := app.setAgentRepositoryPublication(ctx, userID, w.WorkspaceID, w.Revision, "MIT", false); err != nil {
			t.Fatal(err)
		}
	}
	publish()
	trace.expect(t, 1, 3) // README, duplicate skill content, note.
	var cached int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM agent_workspace_blobs WHERE workspace_id=$1 AND content_scan_policy=$2 AND content_scan_sensitive=false`, w.WorkspaceID, agentWorkspaceSensitivePolicyID()).Scan(&cached); err != nil || cached != 3 {
		t.Fatalf("cache not persisted: %d %v", cached, err)
	}
	// A new server instance also avoids all file-content queries.
	app = New(app.cfg, app.db)
	publish()
	trace.expect(t, 0, 0)
	w, err = app.patchAgentWorkspace(ctx, userID, w.WorkspaceID, w.Revision, []agentWorkspaceFile{repositoryTestFile("notes.md", "Changed note")}, nil)
	if err != nil {
		t.Fatal(err)
	}
	publish()
	trace.expect(t, 1, 1)
	w, err = app.mutateAgentWorkspaceWithHistory(ctx, userID, w.WorkspaceID, w.Revision, nil, nil, true, &originalRevision, false, "")
	if err != nil {
		t.Fatal(err)
	}
	publish()
	trace.expect(t, 0, 0) // Retained history keeps the old blob's result.
	// A policy change invalidates old results, even if all contents are unchanged.
	if _, err = pool.Exec(ctx, `UPDATE agent_workspace_blobs SET content_scan_policy=$2 WHERE workspace_id=$1`, w.WorkspaceID, strings.Repeat("0", 64)); err != nil {
		t.Fatal(err)
	}
	publish()
	trace.expect(t, 1, 3)

	// Path and metadata checks cannot be bypassed by reusing known-safe bytes.
	w, err = app.patchAgentWorkspace(ctx, userID, w.WorkspaceID, w.Revision, []agentWorkspaceFile{repositoryTestFile(".env", large)}, nil)
	if err != nil {
		t.Fatal(err)
	}
	err = app.setAgentRepositoryPublication(ctx, userID, w.WorkspaceID, w.Revision, "MIT", false)
	var sensitive *agentWorkspaceSensitiveError
	if !errors.As(err, &sensitive) || sensitive.Path != ".env" {
		t.Fatalf("cached content bypassed path check: %v", err)
	}
	trace.expect(t, 0, 0)
	w, err = app.patchAgentWorkspace(ctx, userID, w.WorkspaceID, w.Revision, nil, []string{".env"})
	if err != nil {
		t.Fatal(err)
	}
	w, err = app.manageAgentWorkspace(ctx, userID, w.WorkspaceID, w.Revision, w.Name, "api_key=abcdefghijklmnopqrst123456", false)
	if err != nil {
		t.Fatal(err)
	}
	err = app.setAgentRepositoryPublication(ctx, userID, w.WorkspaceID, w.Revision, "MIT", false)
	if !errors.As(err, &sensitive) || sensitive.Path != "repository metadata" {
		t.Fatalf("cached content bypassed metadata check: %v", err)
	}
	trace.expect(t, 0, 0)
	// Blob removal also removes its cache; no separate cache table can grow forever.
	if _, err = app.manageAgentWorkspace(ctx, userID, w.WorkspaceID, w.Revision, "", "", true); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM agent_workspace_blobs WHERE workspace_id=$1`, w.WorkspaceID).Scan(&cached); err != nil || cached != 0 {
		t.Fatal("deleted repository retained cached blobs", err)
	}
}

func TestAgentRepositorySensitiveScanCache(t *testing.T) {
	ctx := context.Background()
	app, pool, trace, userID := newPublicationScanTest(t)
	w, err := app.createAgentWorkspace(ctx, userID, "Sensitive cache", "", "en")
	if err != nil {
		t.Fatal(err)
	}
	if err = app.setAgentRepositoryPublication(ctx, userID, w.WorkspaceID, w.Revision, "MIT", false); err != nil {
		t.Fatal(err)
	}
	trace.expect(t, 1, 1)
	// Service-level insertion represents a browser-confirmed private sensitive upload.
	secret := repositoryTestFile("secret.txt", "api_key=abcdefghijklmnopqrst123456")
	w, err = app.patchAgentWorkspace(ctx, userID, w.WorkspaceID, w.Revision, []agentWorkspaceFile{secret}, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Even a stale safe result is ignored when its policy does not match.
	if _, err = pool.Exec(ctx, `UPDATE agent_workspace_blobs SET content_scan_policy=$3,content_scan_sensitive=false WHERE workspace_id=$1 AND sha256=$2`, w.WorkspaceID, secret.SHA256, strings.Repeat("0", 64)); err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 2; attempt++ {
		err = app.setAgentRepositoryPublication(ctx, userID, w.WorkspaceID, w.Revision, "MIT", false)
		var sensitive *agentWorkspaceSensitiveError
		if !errors.As(err, &sensitive) || sensitive.Path != secret.Path {
			t.Fatalf("secret publication accepted: %v", err)
		}
		if attempt == 0 {
			trace.expect(t, 1, 1)
		} else {
			trace.expect(t, 0, 0)
		}
	}
	w, err = app.patchAgentWorkspace(ctx, userID, w.WorkspaceID, w.Revision, []agentWorkspaceFile{repositoryTestFile(secret.Path, "# Redacted")}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = app.setAgentRepositoryPublication(ctx, userID, w.WorkspaceID, w.Revision, "MIT", false); err != nil {
		t.Fatal(err)
	}
	trace.expect(t, 1, 1)
}

func TestAgentRepositoryLegacyPublicationCachesFirstScan(t *testing.T) {
	ctx := context.Background()
	app, pool, trace, userID := newPublicationScanTest(t)
	var id int64
	if err := pool.QueryRow(ctx, `INSERT INTO agent_workspaces(user_id,name) VALUES($1,'Legacy') RETURNING id`, userID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	file := repositoryTestFile("SKILL.md", "# Legacy skill")
	if _, err := pool.Exec(ctx, `INSERT INTO agent_workspace_files(workspace_id,path,content,mime_type,size_bytes,sha256) VALUES($1,$2,$3,$4,$5,$6)`, id, file.Path, file.Content, file.MimeType, len(file.Content), file.SHA256); err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 2; attempt++ {
		if err := app.setAgentRepositoryPublication(ctx, userID, id, 0, "MIT", false); err != nil {
			t.Fatal(err)
		}
		if attempt == 0 {
			trace.expect(t, 1, 1)
		} else {
			trace.expect(t, 0, 0)
		}
	}
}

func TestAgentRepositoryConcurrentPublicationScanCache(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	app, pool, trace, userID := newPublicationScanTest(t)
	w, err := app.createAgentWorkspace(ctx, userID, "Concurrent scan", "", "en")
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	results := make(chan error, 2)
	for range 2 {
		go func() {
			<-start
			results <- app.setAgentRepositoryPublication(ctx, userID, w.WorkspaceID, w.Revision, "MIT", false)
		}()
	}
	close(start)
	for range 2 {
		if err := <-results; err != nil {
			t.Errorf("concurrent publication: %v", err)
		}
	}
	var complete bool
	if err = pool.QueryRow(ctx, `SELECT bool_and(content_scan_policy=$2 AND content_scan_sensitive=false) FROM agent_workspace_blobs WHERE workspace_id=$1`, w.WorkspaceID, agentWorkspaceSensitivePolicyID()).Scan(&complete); err != nil || !complete {
		t.Fatalf("incomplete concurrent cache: %v", err)
	}
	trace.mu.Lock()
	trace.queries = 0
	trace.files = 0
	trace.mu.Unlock()
	if err = app.setAgentRepositoryPublication(ctx, userID, w.WorkspaceID, w.Revision, "MIT", false); err != nil {
		t.Fatal(err)
	}
	trace.expect(t, 0, 0)
}
