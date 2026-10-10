package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"koinote/backend/internal/config"
)

type repositoryObjectFixture struct {
	mu                               sync.Mutex
	objects                          map[string][]byte
	requested                        map[string]bool
	failPut, corruptRead, failDelete bool
	puts, reads, deletes             int
}

// Exercise the real HTTP adapter, not an in-process replacement for its methods.
func enableRepositoryR2Fixture(t *testing.T, app *App) *repositoryObjectFixture {
	t.Helper()
	f := &repositoryObjectFixture{objects: map[string][]byte{}, requested: map[string]bool{}}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		if r.Header.Get("X-Koinote-Internal-Token") != "r2-test-token" {
			w.WriteHeader(401)
			return
		}
		key := strings.TrimPrefix(r.URL.Path, "/api/internal/agent-repository-objects/")
		if !agentRepositoryObjectKey.MatchString(key) {
			w.WriteHeader(400)
			return
		}
		f.requested[key] = true
		switch r.Method {
		case "PUT":
			f.puts++
			if f.failPut {
				w.WriteHeader(502)
				return
			}
			b, err := io.ReadAll(io.LimitReader(r.Body, agentWorkspaceMaxFileBytes+1))
			hash := sha256.Sum256(b)
			if err != nil || r.ContentLength != int64(len(b)) || len(b) > agentWorkspaceMaxFileBytes || !strings.HasSuffix(key, hex.EncodeToString(hash[:])) {
				w.WriteHeader(400)
				return
			}
			if old, ok := f.objects[key]; ok && !bytes.Equal(old, b) {
				w.WriteHeader(409)
				return
			}
			f.objects[key] = b
		case "GET":
			f.reads++
			b, ok := f.objects[key]
			if !ok {
				w.WriteHeader(404)
				return
			}
			offset, e1 := strconv.Atoi(r.URL.Query().Get("offset"))
			length, e2 := strconv.Atoi(r.URL.Query().Get("length"))
			if e1 != nil || e2 != nil || offset < 0 || length < 0 || offset+length > len(b) {
				w.WriteHeader(416)
				return
			}
			w.Header().Set("X-Koinote-Object-Sha256", key[len(key)-64:])
			out := bytes.Clone(b[offset : offset+length])
			if f.corruptRead && len(out) > 0 {
				out[0] ^= 1
			}
			w.Write(out)
		case "DELETE":
			f.deletes++
			if f.failDelete {
				w.WriteHeader(502)
				return
			}
			delete(f.objects, key)
			w.WriteHeader(204)
		default:
			w.WriteHeader(405)
		}
	}))
	app.agentObjectStore = &workerAgentRepositoryObjects{baseURL: server.URL, token: "r2-test-token", client: server.Client()}
	t.Cleanup(func() {
		server.Close()
		keys := []string{}
		for k := range f.requested {
			keys = append(keys, k)
		}
		// Users and their blob FKs have already been removed by later cleanups.
		_, err := app.db.Exec(context.Background(), `DELETE FROM agent_repository_objects o WHERE object_key=ANY($1::text[]) AND NOT EXISTS(SELECT 1 FROM agent_workspace_blobs b WHERE b.r2_object_key=o.object_key)`, keys)
		if err != nil {
			t.Error(err)
		}
	})
	return f
}

func assertRepositoryHasNoDatabaseContent(t *testing.T, app *App, id int64) {
	t.Helper()
	var n int
	err := app.db.QueryRow(context.Background(), `SELECT
 (SELECT count(*) FROM agent_workspace_files WHERE workspace_id=$1 AND content IS NOT NULL)+
 (SELECT count(*) FROM agent_workspace_blobs WHERE workspace_id=$1 AND (content IS NOT NULL OR r2_object_key IS NULL))`, id).Scan(&n)
	if err != nil || n != 0 {
		t.Fatalf("database still holds %d repository payloads: %v", n, err)
	}
}

func TestRepositoryR2MigrationAndFailureRecovery(t *testing.T) {
	ctx := context.Background()
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "r2-migration"}, pool)
	f := enableRepositoryR2Fixture(t, app)
	store := app.agentObjectStore
	app.agentObjectStore = nil // Simulate pre-migration database content.
	user := seedMCPUser(t, pool, app, membershipTierLifetime)
	w, err := app.createAgentWorkspace(ctx, user.ID, "Legacy", "", "en")
	if err != nil {
		t.Fatal(err)
	}
	w, err = app.patchAgentWorkspace(ctx, user.ID, w.WorkspaceID, w.Revision, []agentWorkspaceFile{repositoryTestFile("skill.md", "version one"), repositoryTestFile("empty.txt", "")}, nil)
	if err != nil {
		t.Fatal(err)
	}
	publicRevision := w.Revision
	if err = app.setAgentRepositoryPublication(ctx, user.ID, w.WorkspaceID, w.Revision, "MIT", false); err != nil {
		t.Fatal(err)
	}
	w, err = app.patchAgentWorkspace(ctx, user.ID, w.WorkspaceID, w.Revision, []agentWorkspaceFile{repositoryTestFile("skill.md", "version two")}, nil)
	if err != nil {
		t.Fatal(err)
	}
	var before int64
	if err = pool.QueryRow(ctx, `SELECT agent_workspace_storage_bytes($1)`, user.ID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	app.agentObjectStore = store
	f.corruptRead = true
	if n, err := app.migrateAgentRepositoryObjects(ctx, 100); err == nil || n != 0 {
		t.Fatalf("corrupt migration %d %v", n, err)
	}
	var legacy int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM agent_workspace_blobs WHERE workspace_id=$1 AND content IS NOT NULL`, w.WorkspaceID).Scan(&legacy); err != nil || legacy != 4 {
		t.Fatalf("legacy bytes lost: %d %v", legacy, err)
	}
	f.mu.Lock()
	f.corruptRead = false
	f.mu.Unlock()
	if n, err := app.migrateAgentRepositoryObjects(ctx, 100); err != nil || n != 4 {
		t.Fatalf("migration %d %v", n, err)
	}
	assertRepositoryHasNoDatabaseContent(t, app, w.WorkspaceID)
	var after, revision int64
	if err = pool.QueryRow(ctx, `SELECT agent_workspace_storage_bytes($1),revision FROM agent_workspaces WHERE id=$2`, user.ID, w.WorkspaceID).Scan(&after, &revision); err != nil || before != after || revision != w.Revision {
		t.Fatalf("migration changed quota/revision: %d %d %d %v", before, after, revision, err)
	}
	if n, err := app.migrateAgentRepositoryObjects(ctx, 100); err != nil || n != 0 {
		t.Fatalf("migration retry %d %v", n, err)
	}
	historical, err := app.loadAgentWorkspaceCommitFileRange(ctx, user.ID, w.WorkspaceID, publicRevision, "skill.md", 0, 8192)
	if err != nil || historical.ContentBase64 != "dmVyc2lvbiBvbmU=" {
		t.Fatalf("historical read: %+v %v", historical, err)
	}
	if _, err = app.mutateAgentWorkspaceWithHistory(ctx, user.ID, w.WorkspaceID, w.Revision, nil, nil, false, &publicRevision, false, ""); err != nil {
		t.Fatal(err)
	}
	assertRepositoryHasNoDatabaseContent(t, app, w.WorkspaceID)
}

func TestRepositoryR2UploadFailureAndGarbageCollection(t *testing.T) {
	ctx := context.Background()
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "r2-gc"}, pool)
	f := enableRepositoryR2Fixture(t, app)
	user := seedMCPUser(t, pool, app, membershipTierLifetime)
	w, err := app.createAgentWorkspace(ctx, user.ID, "Objects", "", "en")
	if err != nil {
		t.Fatal(err)
	}
	assertRepositoryHasNoDatabaseContent(t, app, w.WorkspaceID)
	f.mu.Lock()
	f.failPut = true
	f.mu.Unlock()
	_, err = app.patchAgentWorkspace(ctx, user.ID, w.WorkspaceID, w.Revision, []agentWorkspaceFile{repositoryTestFile("new.md", "failed write")}, nil)
	if !errors.Is(err, errAgentRepositoryStorage) {
		t.Fatalf("expected storage failure, got %v", err)
	}
	current, err := app.loadAgentWorkspace(ctx, user.ID, w.WorkspaceID)
	if err != nil || current.Revision != w.Revision || len(current.Files) != len(w.Files) {
		t.Fatalf("failed write mutated workspace: %+v %v", current, err)
	}
	var failedKey string
	if err = pool.QueryRow(ctx, `SELECT object_key FROM agent_repository_objects WHERE NOT committed ORDER BY created_at DESC LIMIT 1`).Scan(&failedKey); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `UPDATE agent_repository_objects SET delete_after=now()-interval '1 second' WHERE object_key=$1`, failedKey); err != nil {
		t.Fatal(err)
	}
	f.mu.Lock()
	f.failDelete = true
	f.mu.Unlock()
	if _, err = app.collectAgentRepositoryObjects(ctx, 100); err == nil {
		t.Fatal("cleanup failure swallowed")
	}
	var exists bool
	if err = pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agent_repository_objects WHERE object_key=$1)`, failedKey).Scan(&exists); err != nil || !exists {
		t.Fatal("failed deletion lost durable retry")
	}
	f.mu.Lock()
	f.failDelete = false
	f.failPut = false
	f.mu.Unlock()
	if n, err := app.collectAgentRepositoryObjects(ctx, 100); err != nil || n != 1 {
		t.Fatalf("cleanup retry %d %v", n, err)
	}
	var key string
	var retention time.Time
	if err = pool.QueryRow(ctx, `SELECT o.object_key,o.delete_after FROM agent_repository_objects o JOIN agent_workspace_blobs b ON b.r2_object_key=o.object_key WHERE b.workspace_id=$1 LIMIT 1`, w.WorkspaceID).Scan(&key, &retention); err != nil {
		t.Fatal(err)
	}
	if time.Until(retention) < 400*24*time.Hour {
		t.Fatal("R2 bytes do not outlive database backups")
	}
	if _, err = pool.Exec(ctx, `UPDATE agent_repository_objects SET delete_after=now()-interval '1 second' WHERE object_key=$1`, key); err != nil {
		t.Fatal(err)
	}
	if n, err := app.collectAgentRepositoryObjects(ctx, 100); err != nil || n != 0 {
		t.Fatalf("live object collected %d %v", n, err)
	}
	// Account deletion releases references but must preserve bytes used by existing backups.
	if _, err = pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, user.ID); err != nil {
		t.Fatal(err)
	}
	if err = pool.QueryRow(ctx, `SELECT delete_after FROM agent_repository_objects WHERE object_key=$1`, key).Scan(&retention); err != nil || time.Until(retention) < 400*24*time.Hour {
		t.Fatalf("backup reference lost %v", err)
	}
}

func TestRepositoryR2RejectsUnauthenticatedOrRedirectedStorage(t *testing.T) {
	reached := false
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached = true; w.WriteHeader(200) }))
	defer destination.Close()
	source := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, destination.URL, 307) }))
	defer source.Close()
	app := New(config.Config{AgentRepositoryStorage: "r2", WorkerURL: source.URL, InternalToken: "secret"}, nil)
	file := repositoryTestFile("test", "hello")
	key := fmt.Sprintf("objects/%032d/%s", 0, file.SHA256)
	if err := app.agentObjectStore.Put(context.Background(), key, file.Content); !errors.Is(err, errAgentRepositoryStorage) || reached {
		t.Fatalf("redirect leaked token: %v reached=%v", err, reached)
	}
}

type blockingRepositoryRead struct {
	agentRepositoryObjectStore
	once            sync.Once
	entered, resume chan struct{}
}

func (s *blockingRepositoryRead) Read(ctx context.Context, key string, offset, length int64, hash string) ([]byte, error) {
	s.once.Do(func() {
		close(s.entered)
		select {
		case <-s.resume:
		case <-ctx.Done():
		}
	})
	return s.agentRepositoryObjectStore.Read(ctx, key, offset, length, hash)
}

func TestRepositoryR2RestoreScanDoesNotLockWritersAndRechecksRevision(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "restore-race"}, pool)
	enableRepositoryR2Fixture(t, app)
	user := seedMCPUser(t, pool, app, membershipTierLifetime)
	w, err := app.createAgentWorkspace(ctx, user.ID, "Restore race", "", "en")
	if err != nil {
		t.Fatal(err)
	}
	original := w.Revision
	w, err = app.patchAgentWorkspace(ctx, user.ID, w.WorkspaceID, w.Revision, []agentWorkspaceFile{repositoryTestFile("note.md", "latest")}, nil)
	if err != nil {
		t.Fatal(err)
	}
	store := &blockingRepositoryRead{agentRepositoryObjectStore: app.agentObjectStore, entered: make(chan struct{}), resume: make(chan struct{})}
	app.agentObjectStore = store
	result := make(chan error, 1)
	go func() {
		_, e := app.mutateAgentWorkspaceWithHistory(ctx, user.ID, w.WorkspaceID, w.Revision, nil, nil, false, &original, false, "")
		result <- e
	}()
	defer close(store.resume)
	select {
	case <-store.entered:
	case <-ctx.Done():
		t.Fatal("restore never reached R2")
	}
	// This write finishes while the historical read remains blocked.
	updated, err := app.patchAgentWorkspace(ctx, user.ID, w.WorkspaceID, w.Revision, []agentWorkspaceFile{repositoryTestFile("note.md", "concurrent write")}, nil)
	if err != nil {
		t.Fatalf("historical R2 read blocked a writer: %v", err)
	}
	select {
	case store.resume <- struct{}{}:
	case <-ctx.Done():
		t.Fatal("restore read timed out")
	}
	if err := <-result; !errors.Is(err, errAgentWorkspaceConflict) {
		t.Fatalf("stale restore accepted: %v", err)
	}
	after, err := app.loadAgentWorkspace(ctx, user.ID, w.WorkspaceID)
	if err != nil || after.Revision != updated.Revision {
		t.Fatalf("restore changed revision: %v", err)
	}
}
