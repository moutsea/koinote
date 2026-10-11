package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"

	"koinote/backend/internal/config"
)

const githubSyncTestSHA = "abcdef1234567890abcdef1234567890abcdef12"

type githubSyncFixture struct {
	sha, license      string
	repositoryID      int64
	fullName          string
	private           bool
	status            int
	archive           []byte
	archives, commits int
	onArchive         func()
}

func (f *githubSyncFixture) client(t *testing.T) *http.Client {
	t.Helper()
	return &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "api.github.com" || r.Header.Get("Authorization") != "Bearer sync-test-token" {
			t.Error("unexpected upstream host or credential")
		}
		res := &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Request: r}
		var body []byte
		switch {
		case strings.Contains(r.URL.Path, "/zipball/"):
			f.archives++
			if !strings.HasSuffix(r.URL.Path, "/"+f.sha) {
				t.Error("archive is not pinned to resolved SHA")
			}
			if f.onArchive != nil {
				f.onArchive()
			}
			body = f.archive
		case strings.Contains(r.URL.Path, "/commits/"):
			f.commits++
			if !strings.HasSuffix(r.URL.Path, "/commits/main") {
				t.Error("sync must follow default branch, not initial import SHA")
			}
			body = []byte(f.sha)
		default:
			if f.status != 0 {
				res.StatusCode = f.status
				if f.status == 429 {
					res.Header.Set("Retry-After", "60")
				}
			}
			fullName := f.fullName
			if fullName == "" {
				fullName = "Octo/demo"
			}
			parts := strings.SplitN(fullName, "/", 2)
			body, _ = json.Marshal(map[string]any{"id": f.repositoryID, "name": parts[1], "full_name": fullName, "owner": map[string]string{"login": parts[0]}, "default_branch": "main", "private": f.private, "license": map[string]string{"spdx_id": f.license}})
		}
		res.Body = io.NopCloser(bytes.NewReader(body))
		return res, nil
	})}
}

func seedSystemRepositorySync(t *testing.T, r2 bool) (*App, agentWorkspaceView, int, *repositoryObjectFixture, *githubSyncFixture) {
	t.Helper()
	ctx := context.Background()
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "repository-sync", AppURL: "https://koinote.example"}, pool)
	var objects *repositoryObjectFixture
	if r2 {
		objects = enableRepositoryR2Fixture(t, app)
	}
	admin := seedMCPUser(t, pool, app, membershipTierLifetime)
	if _, err := pool.Exec(ctx, `UPDATE users SET is_admin=true WHERE id=$1`, admin.ID); err != nil {
		t.Fatal(err)
	}
	archive := githubArchive(t, githubArchiveEntry{"root/README.md", "# Original", 0}, githubArchiveEntry{"root/LICENSE", discoveryMIT, 0}, githubArchiveEntry{"root/removed.md", "Removed later", 0})
	files, err := readGitHubArchive(ctx, bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		t.Fatal(err)
	}
	source := &agentGitHubSource{RepositoryID: 12345, RepositoryURL: "https://github.com/Octo/demo", Author: "Octo", AuthorURL: "https://github.com/Octo", Ref: githubTestSHA, CommitSHA: githubTestSHA, License: "MIT"}
	requestID, _ := randomUUID()
	w, err := app.importGitHubRepositoryForOwner(ctx, nil, admin.ID, requestID, "seed", "Curated name", "Curated description", files, source)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM agent_repository_system_events WHERE workspace_id=$1`, w.WorkspaceID)
		_, _ = pool.Exec(context.Background(), `DELETE FROM agent_workspaces WHERE id=$1`, w.WorkspaceID)
	})
	category := "writing"
	if err = app.setAgentRepositoryPublicationForOwner(ctx, nil, admin.ID, w.WorkspaceID, w.Revision, source.License, false, &category); err != nil {
		t.Fatal(err)
	}
	upstream := &githubSyncFixture{repositoryID: source.RepositoryID, sha: githubSyncTestSHA, license: source.License, archive: githubArchive(t,
		githubArchiveEntry{"root/README.md", "# Updated", 0}, githubArchiveEntry{"root/LICENSE", discoveryMIT, 0}, githubArchiveEntry{"root/new.md", "New skill", 0})}
	app.githubHTTPClient = upstream.client(t)
	return app, w, admin.ID, objects, upstream
}

func runSystemRepositorySync(t *testing.T, app *App, id int64, apply bool) (SystemRepositorySyncSummary, []SystemRepositorySyncResult, error) {
	t.Helper()
	var results []SystemRepositorySyncResult
	summary, err := app.SyncSystemAgentRepositories(context.Background(), SystemRepositorySyncOptions{Apply: apply, GitHubToken: "sync-test-token", WorkspaceID: id, OnResult: func(r SystemRepositorySyncResult) { results = append(results, r) }})
	return summary, results, err
}

func TestSystemRepositorySyncUpdatesAtomicallyAndIsIdempotent(t *testing.T) {
	for _, r2 := range []bool{false, true} {
		t.Run(map[bool]string{false: "database", true: "r2"}[r2], func(t *testing.T) {
			app, w, admin, objects, upstream := seedSystemRepositorySync(t, r2)
			ctx := context.Background()
			if _, err := app.db.Exec(ctx, `INSERT INTO agent_workspace_settings(user_id,enabled) VALUES($1,true)`, admin); err != nil {
				t.Fatal(err)
			}
			requestID, _ := randomUUID()
			fork, err := app.forkAgentRepository(ctx, admin, w.WorkspaceID, w.Revision, requestID)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = app.db.Exec(ctx, `INSERT INTO agent_repository_stars(workspace_id,user_id) VALUES($1,$2)`, w.WorkspaceID, admin); err != nil {
				t.Fatal(err)
			}
			var puts int
			if r2 {
				objects.mu.Lock()
				puts = objects.puts
				objects.mu.Unlock()
			}
			summary, results, err := runSystemRepositorySync(t, app, w.WorkspaceID, true)
			if err != nil || summary.Updated != 1 || len(results) != 1 || results[0].CurrentSHA != githubSyncTestSHA {
				t.Fatalf("sync: %+v %+v %v", summary, results, err)
			}
			current, err := loadAgentWorkspaceForOwner(ctx, app.db, nil, w.WorkspaceID)
			if err != nil {
				t.Fatal(err)
			}
			if current.Revision != w.Revision+1 || current.GitHubSource.CommitSHA != githubSyncTestSHA || current.Name != w.Name || current.Description != w.Description || current.Category != "writing" || current.GitHubSource.Author != "Octo" {
				t.Fatalf("metadata changed incorrectly: %+v", current)
			}
			publication, err := app.loadPublicAgentRepository(ctx, w.WorkspaceID, nil)
			if err != nil || publication.Revision != current.Revision || publication.GitHubSource.CommitSHA != githubSyncTestSHA || publication.StarCount != 1 {
				t.Fatalf("publication: %+v %v", publication, err)
			}
			paths := []string{}
			for _, f := range publication.Files {
				paths = append(paths, f.Path)
			}
			if !reflect.DeepEqual(paths, []string{"LICENSE", "README.md", "new.md"}) {
				t.Fatalf("manifest: %v", paths)
			}
			if r2 {
				assertRepositoryHasNoDatabaseContent(t, app, w.WorkspaceID)
				objects.mu.Lock()
				delta := objects.puts - puts
				objects.mu.Unlock()
				if delta != 2 {
					t.Fatalf("uploaded %d objects, expected only 2 new contents", delta)
				}
			}
			oldFork, err := app.loadAgentWorkspace(ctx, admin, fork.WorkspaceID)
			if err != nil || oldFork.GitHubSource.CommitSHA != githubTestSHA || oldFork.Revision != fork.Revision {
				t.Fatalf("fork changed: %+v %v", oldFork, err)
			}
			var events, priorFiles int
			if err = app.db.QueryRow(ctx, `SELECT (SELECT count(*) FROM agent_repository_system_events WHERE workspace_id=$1 AND action='sync' AND actor_user_id IS NULL),(SELECT count(*) FROM agent_workspace_commit_files WHERE workspace_id=$1 AND revision=$2)`, w.WorkspaceID, w.Revision).Scan(&events, &priorFiles); err != nil || events != 1 || priorFiles != 3 {
				t.Fatalf("audit/history: %d %d %v", events, priorFiles, err)
			}
			var publishedAt string
			if err = app.db.QueryRow(ctx, `SELECT published_at::text FROM agent_repository_publications WHERE workspace_id=$1`, w.WorkspaceID).Scan(&publishedAt); err != nil {
				t.Fatal(err)
			}
			summary, _, err = runSystemRepositorySync(t, app, w.WorkspaceID, true)
			if err != nil || summary.Unchanged != 1 || upstream.archives != 1 {
				t.Fatalf("repeat downloaded or changed: %+v %v archives=%d", summary, err, upstream.archives)
			}
			var after string
			if err = app.db.QueryRow(ctx, `SELECT published_at::text FROM agent_repository_publications WHERE workspace_id=$1`, w.WorkspaceID).Scan(&after); err != nil || after != publishedAt {
				t.Fatalf("unchanged repository was republished: %q %v", after, err)
			}
		})
	}
}

func TestSystemRepositorySyncPreviewAndRejectionsKeepOldSnapshot(t *testing.T) {
	for _, scenario := range []string{"preview", "license", "unlicensed", "nested-license", "notice-exception", "missing-license", "unknown-license", "root-license-mismatch", "identity-changed", "identity-changed-same-sha", "missing-upstream-identity", "missing-saved-identity", "private", "missing", "sensitive-content", "sensitive-path", "invalid-archive", "r2-failure", "withdraw-during-download", "republish-during-download", "revision-race"} {
		t.Run(scenario, func(t *testing.T) {
			app, w, admin, objects, upstream := seedSystemRepositorySync(t, true)
			ctx := context.Background()
			wantCode := ""
			switch scenario {
			case "license":
				upstream.license = "Apache-2.0"
				wantCode = "license_changed"
			case "unlicensed":
				upstream.license = "NOASSERTION"
				wantCode = "license_changed"
			case "nested-license", "notice-exception", "missing-license", "unknown-license", "root-license-mismatch":
				entries := []githubArchiveEntry{{"root/README.md", "# Updated Agent instructions", 0}, {"root/LICENSE", discoveryMIT, 0}}
				switch scenario {
				case "nested-license":
					entries = append(entries, githubArchiveEntry{"root/vendor/LICENSE", "CC-BY-NC-SA-4.0 non-commercial use only", 0})
				case "notice-exception":
					entries = append(entries, githubArchiveEntry{"root/NOTICE", "Third party quotes are not covered by MIT", 0})
				case "missing-license":
					entries = entries[:1]
				case "unknown-license":
					entries = append(entries, githubArchiveEntry{"root/sub/LICENSE.txt", "Special redistribution terms", 0})
				case "root-license-mismatch":
					entries[1].name = "root/sub/LICENSE"
				}
				upstream.archive = githubArchive(t, entries...)
				wantCode = "license_review_required"
			case "identity-changed", "identity-changed-same-sha", "missing-upstream-identity":
				upstream.repositoryID++
				if scenario == "identity-changed-same-sha" {
					upstream.sha = githubTestSHA
				}
				if scenario == "missing-upstream-identity" {
					upstream.repositoryID = 0
				}
				wantCode = "repository_identity_mismatch"
			case "missing-saved-identity":
				if _, err := app.db.Exec(ctx, `UPDATE agent_workspaces SET github_source=github_source-'repositoryId' WHERE id=$1`, w.WorkspaceID); err != nil {
					t.Fatal(err)
				}
				wantCode = "repository_identity_mismatch"
			case "private":
				upstream.private = true
				wantCode = "invalid_or_private_source"
			case "missing":
				upstream.status = 404
				wantCode = "github_unavailable"
			case "sensitive-content":
				upstream.archive = githubArchive(t, githubArchiveEntry{"root/README.md", "ghp_abcdefghijklmnopqrstuvwxyz123456", 0})
				wantCode = "sensitive_data_detected"
			case "sensitive-path":
				upstream.archive = githubArchive(t, githubArchiveEntry{"root/.env", "SAFE_EXAMPLE=yes", 0})
				wantCode = "sensitive_data_detected"
			case "invalid-archive":
				upstream.archive = []byte("broken zip")
				wantCode = "archive_rejected"
			case "r2-failure":
				objects.mu.Lock()
				objects.failPut = true
				objects.mu.Unlock()
				wantCode = "storage_unavailable"
			case "withdraw-during-download", "republish-during-download":
				wantCode = "repository_changed"
				upstream.onArchive = func() {
					if err := app.setAgentRepositoryPublicationForOwner(ctx, nil, admin, w.WorkspaceID, w.Revision, "MIT", true, nil); err != nil {
						t.Fatal(err)
					}
					if scenario == "republish-during-download" {
						if err := app.setAgentRepositoryPublicationForOwner(ctx, nil, admin, w.WorkspaceID, w.Revision, "MIT", false, nil); err != nil {
							t.Fatal(err)
						}
					}
				}
			case "revision-race":
				wantCode = "repository_changed"
				upstream.onArchive = func() {
					if _, err := app.db.Exec(ctx, `UPDATE agent_workspaces SET revision=revision+1 WHERE id=$1`, w.WorkspaceID); err != nil {
						t.Fatal(err)
					}
				}
			}
			var beforeObjects int
			if err := app.db.QueryRow(ctx, `SELECT count(*) FROM agent_repository_objects`).Scan(&beforeObjects); err != nil {
				t.Fatal(err)
			}
			summary, results, err := runSystemRepositorySync(t, app, w.WorkspaceID, scenario != "preview")
			if scenario == "preview" {
				if err != nil || summary.WouldUpdate != 1 {
					t.Fatalf("preview: %+v %v", summary, err)
				}
				var after int
				if err := app.db.QueryRow(ctx, `SELECT count(*) FROM agent_repository_objects`).Scan(&after); err != nil || after != beforeObjects {
					t.Fatalf("preview wrote objects: %d %d %v", beforeObjects, after, err)
				}
			} else if err == nil || summary.Failed != 1 || len(results) != 1 || results[0].Code != wantCode {
				t.Fatalf("reject: %+v %+v %v", summary, results, err)
			}
			if scenario == "private" && (upstream.commits != 0 || upstream.archives != 0) {
				t.Fatal("read private contents")
			}
			if (scenario == "license" || scenario == "unlicensed") && upstream.archives != 0 {
				t.Fatal("downloaded license-rejected archive")
			}
			if wantCode == "repository_identity_mismatch" && upstream.archives != 0 {
				t.Fatal("downloaded a different repository's archive")
			}
			if wantCode == "license_review_required" || wantCode == "repository_identity_mismatch" {
				var afterObjects int
				if err := app.db.QueryRow(ctx, `SELECT count(*) FROM agent_repository_objects`).Scan(&afterObjects); err != nil || beforeObjects != afterObjects {
					t.Fatalf("rejected source wrote R2 objects: before=%d after=%d err=%v", beforeObjects, afterObjects, err)
				}
			}
			current, err := loadAgentWorkspaceForOwner(ctx, app.db, nil, w.WorkspaceID)
			if err != nil || !reflect.DeepEqual(w.Files, current.Files) || current.GitHubSource.CommitSHA != w.GitHubSource.CommitSHA {
				t.Fatalf("old workspace damaged: %+v %v", current, err)
			}
			pub, err := app.loadPublicAgentRepository(ctx, w.WorkspaceID, nil)
			if scenario == "withdraw-during-download" {
				if !errors.Is(err, errAgentWorkspaceNotFound) {
					t.Fatalf("withdrawal undone: %v", err)
				}
			} else if err != nil || pub.Revision != w.Revision || !reflect.DeepEqual(pub.Files, w.Files) {
				t.Fatalf("old publication damaged: %+v %v", pub, err)
			}
			var events int
			if err = app.db.QueryRow(ctx, `SELECT count(*) FROM agent_repository_system_events WHERE workspace_id=$1 AND action='sync'`, w.WorkspaceID).Scan(&events); err != nil || events != 0 {
				t.Fatalf("failed update audited as successful: %d %v", events, err)
			}
		})
	}
}

func TestSystemRepositorySyncWithdrawnStaysPrivateAndLock(t *testing.T) {
	app, w, admin, _, _ := seedSystemRepositorySync(t, false)
	ctx := context.Background()
	if err := app.setAgentRepositoryPublicationForOwner(ctx, nil, admin, w.WorkspaceID, w.Revision, "MIT", true, nil); err != nil {
		t.Fatal(err)
	}
	lock, err := app.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Rollback(ctx)
	if _, err = lock.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, agentRepositorySyncLock); err != nil {
		t.Fatal(err)
	}
	if _, _, err = runSystemRepositorySync(t, app, w.WorkspaceID, true); !errors.Is(err, errAgentRepositorySyncBusy) {
		t.Fatalf("concurrent job admitted: %v", err)
	}
	if err = lock.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	summary, _, err := runSystemRepositorySync(t, app, w.WorkspaceID, true)
	if err != nil || summary.Updated != 1 {
		t.Fatalf("sync after unlocking: %+v %v", summary, err)
	}
	if _, err = app.loadPublicAgentRepository(ctx, w.WorkspaceID, nil); !errors.Is(err, errAgentWorkspaceNotFound) {
		t.Fatalf("withdrawn repository republished: %v", err)
	}
}

func TestSystemRepositorySyncBatchContinuesAndExcludesPersonal(t *testing.T) {
	app, w, admin, _, upstream := seedSystemRepositorySync(t, false)
	_, second, _, _, _ := seedSystemRepositorySync(t, false)
	ctx := context.Background()
	if _, err := app.db.Exec(ctx, `INSERT INTO agent_workspace_settings(user_id,enabled) VALUES($1,true)`, admin); err != nil {
		t.Fatal(err)
	}
	requestID, _ := randomUUID()
	personal, err := app.forkAgentRepository(ctx, admin, w.WorkspaceID, w.Revision, requestID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = app.db.Exec(ctx, `UPDATE agent_workspaces SET github_source=jsonb_set(github_source,'{license}','"MPL-2.0"') WHERE id=$1`, w.WorkspaceID); err != nil {
		t.Fatal(err)
	}
	summary, results, err := runSystemRepositorySync(t, app, 0, true)
	if err == nil || summary.Failed != 1 || summary.Updated != 1 || summary.Total != 2 || len(results) != 2 || upstream.archives != 1 {
		t.Fatalf("batch: %+v %+v %v", summary, results, err)
	}
	current, err := loadAgentWorkspaceForOwner(ctx, app.db, nil, second.WorkspaceID)
	if err != nil || current.GitHubSource.CommitSHA != githubSyncTestSHA {
		t.Fatalf("second repository not updated: %+v %v", current, err)
	}
	if _, _, err = runSystemRepositorySync(t, app, personal.WorkspaceID, true); !errors.Is(err, errAgentWorkspaceNotFound) {
		t.Fatalf("personal repository admitted: %v", err)
	}
	unchanged, err := app.loadAgentWorkspace(ctx, admin, personal.WorkspaceID)
	if err != nil || unchanged.GitHubSource.CommitSHA != githubTestSHA {
		t.Fatalf("personal fork overwritten: %+v %v", unchanged, err)
	}
}

func TestSystemRepositorySyncMissingSourceAndRateLimit(t *testing.T) {
	app, first, _, _, upstream := seedSystemRepositorySync(t, false)
	_, second, _, _, _ := seedSystemRepositorySync(t, false)
	upstream.status = http.StatusTooManyRequests
	summary, results, err := runSystemRepositorySync(t, app, 0, true)
	if !errors.Is(err, errAgentGitHubRateLimited) || summary.Total != 2 || summary.Processed != 1 || summary.Failed != 1 || results[0].Code != "github_rate_limited" || upstream.archives != 0 {
		t.Fatalf("rate-limited job kept requesting: %+v %+v %v", summary, results, err)
	}
	ctx := context.Background()
	if _, err = app.db.Exec(ctx, `UPDATE agent_workspaces SET github_source=NULL WHERE id=$1`, first.WorkspaceID); err != nil {
		t.Fatal(err)
	}
	upstream.status = 0
	summary, results, err = runSystemRepositorySync(t, app, 0, true)
	if err != nil || summary.Total != 2 || summary.Processed != 2 || summary.Skipped != 1 || summary.Updated != 1 || results[0].Code != "no_github_source" || results[1].WorkspaceID != second.WorkspaceID {
		t.Fatalf("missing source blocks valid repository: %+v %+v %v", summary, results, err)
	}
	if _, err = app.db.Exec(ctx, `UPDATE agent_workspaces SET deleted_at=now() WHERE id=$1`, first.WorkspaceID); err != nil {
		t.Fatal(err)
	}
	summary, _, err = runSystemRepositorySync(t, app, 0, true)
	if err != nil || summary.Total != 1 || summary.Unchanged != 1 {
		t.Fatalf("deleted system repository included: %+v %v", summary, err)
	}
}

func TestSystemRepositorySyncAllowsRenameWithSameIdentity(t *testing.T) {
	app, w, _, _, upstream := seedSystemRepositorySync(t, true)
	upstream.fullName = "NewOwner/renamed"
	summary, results, err := runSystemRepositorySync(t, app, w.WorkspaceID, true)
	if err != nil || summary.Updated != 1 {
		t.Fatalf("rename: %+v %+v %v", summary, results, err)
	}
	view, err := app.loadPublicAgentRepository(context.Background(), w.WorkspaceID, nil)
	if err != nil || view.GitHubSource.RepositoryID != w.GitHubSource.RepositoryID || view.GitHubSource.RepositoryURL != "https://github.com/NewOwner/renamed" || view.GitHubSource.Author != "NewOwner" {
		t.Fatalf("rename provenance: %+v %v", view, err)
	}
}

func TestSystemRepositorySyncResumesAfterRateLimit(t *testing.T) {
	app, w, _, _, upstream := seedSystemRepositorySync(t, false)
	ctx := context.Background()
	// 501 unchanged repositories need 1,002 API requests. Reproduce the real
	// Actions token budget, rather than only testing a rate limit on item one.
	if _, err := app.db.Exec(ctx, `INSERT INTO agent_workspaces(user_id,is_system,name,github_source)
 SELECT NULL,true,'sync-quota-fixture',w.github_source FROM agent_workspaces w CROSS JOIN generate_series(1,500) WHERE w.id=$1`, w.WorkspaceID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, err := app.db.Exec(context.Background(), `DELETE FROM agent_workspaces WHERE name='sync-quota-fixture'`)
		if err != nil {
			t.Error(err)
		}
		_, err = app.db.Exec(context.Background(), `UPDATE agent_repository_sync_progress SET last_workspace_id=0 WHERE singleton`)
		if err != nil {
			t.Error(err)
		}
	})
	upstream.sha = githubTestSHA
	base := upstream.client(t).Transport
	calls := 0
	app.githubHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		if calls > 1000 {
			return &http.Response{StatusCode: 429, Header: http.Header{"Retry-After": []string{"60"}}, Request: r, Body: io.NopCloser(strings.NewReader("rate limited"))}, nil
		}
		return base.RoundTrip(r)
	})}
	summary, results, err := runSystemRepositorySync(t, app, 0, true)
	if !errors.Is(err, errAgentGitHubRateLimited) || summary.Total != 501 || summary.Unchanged != 500 || summary.Failed != 1 || summary.ResumeAfter != results[499].WorkspaceID || calls != 1001 {
		t.Fatalf("initial batch: %+v calls=%d err=%v", summary, calls, err)
	}
	cursor := summary.ResumeAfter
	pendingID := results[500].WorkspaceID
	assertCursor := func(want int64) {
		t.Helper()
		var got int64
		if err := app.db.QueryRow(ctx, `SELECT last_workspace_id FROM agent_repository_sync_progress WHERE singleton`).Scan(&got); err != nil || got != want {
			t.Fatalf("cursor=%d want=%d err=%v", got, want, err)
		}
	}
	assertCursor(cursor)
	app.githubHTTPClient = upstream.client(t)
	// A full preview and targeted retry must neither skip repositories nor move
	// the full-job checkpoint, even when a previous process left it mid-sweep.
	preview, _, err := runSystemRepositorySync(t, app, 0, false)
	if err != nil || preview.Total != 501 || preview.Unchanged != 501 {
		t.Fatalf("preview: %+v %v", preview, err)
	}
	assertCursor(cursor)
	targeted, _, err := runSystemRepositorySync(t, app, pendingID, true)
	if err != nil || targeted.Unchanged != 1 {
		t.Fatalf("targeted retry: %+v %v", targeted, err)
	}
	assertCursor(cursor)
	// A new App represents a later CLI process. Deleting the checkpoint's
	// workspace must not rewind the durable progress or lose the next item.
	if _, err := app.db.Exec(ctx, `DELETE FROM agent_workspaces WHERE id=$1`, cursor); err != nil {
		t.Fatal(err)
	}
	restarted := New(config.Config{SessionSecret: "sync-restart"}, app.db)
	restarted.githubHTTPClient = upstream.client(t)
	commitsBefore := upstream.commits
	summary, results, err = runSystemRepositorySync(t, restarted, 0, true)
	if err != nil || summary.Total != 1 || summary.Unchanged != 1 || summary.ResumedAfter != cursor || summary.ResumeAfter != 0 || len(results) != 1 || results[0].WorkspaceID != pendingID || upstream.commits-commitsBefore != 1 {
		t.Fatalf("resumed batch: %+v %+v %v", summary, results, err)
	}
	assertCursor(0)
	summary, _, err = runSystemRepositorySync(t, restarted, 0, true)
	if err != nil || summary.ResumedAfter != 0 || summary.Total != 500 || summary.Unchanged != 500 {
		t.Fatalf("new sweep: %+v %v", summary, err)
	}
}

func TestSystemRepositorySyncResumesAfterCancellation(t *testing.T) {
	app, first, _, _, upstream := seedSystemRepositorySync(t, false)
	_, second, _, _, _ := seedSystemRepositorySync(t, false)
	t.Cleanup(func() {
		_, err := app.db.Exec(context.Background(), `UPDATE agent_repository_sync_progress SET last_workspace_id=0 WHERE singleton`)
		if err != nil {
			t.Error(err)
		}
	})
	upstream.sha = githubTestSHA
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	summary, err := app.SyncSystemAgentRepositories(ctx, SystemRepositorySyncOptions{Apply: true, GitHubToken: "sync-test-token", OnResult: func(SystemRepositorySyncResult) { cancel() }})
	if !errors.Is(err, context.Canceled) || summary.Processed != 1 || summary.ResumeAfter != first.WorkspaceID {
		t.Fatalf("interrupted: %+v %v", summary, err)
	}
	summary, results, err := runSystemRepositorySync(t, app, 0, true)
	if err != nil || summary.Total != 1 || summary.Unchanged != 1 || results[0].WorkspaceID != second.WorkspaceID || summary.ResumeAfter != 0 {
		t.Fatalf("resume: %+v %+v %v", summary, results, err)
	}
}

func TestSystemRepositorySyncIdentityBackfill(t *testing.T) {
	pool := newGCTestPool(t)
	ctx := context.Background()
	var catalog struct {
		Repositories []struct {
			RequestID     string `json:"requestId"`
			RepositoryURL string `json:"repositoryUrl"`
			CommitSHA     string `json:"commitSha"`
			RepositoryID  int64  `json:"repositoryId"`
		}
	}
	data, err := os.ReadFile("../../../data/agent-repositories/catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(data, &catalog); err != nil {
		t.Fatal(err)
	}
	sql, err := os.ReadFile("../../migrations/0093_agent_repository_sync_safety.sql")
	if err != nil {
		t.Fatal(err)
	}
	start := strings.Index(string(sql), "WITH catalog(")
	if start < 0 {
		t.Fatal("missing identity backfill")
	}
	for _, scenario := range []string{"matching", "known-id", "different-commit", "different-url", "different-request", "personal"} {
		t.Run(scenario, func(t *testing.T) {
			tx, err := pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(ctx)
			var personalID int
			if err = tx.QueryRow(ctx, `INSERT INTO users(auth_user_id,email,nickname,password_hash) VALUES('sync-backfill-test','sync-backfill@example.test','test','x') RETURNING id`).Scan(&personalID); err != nil {
				t.Fatal(err)
			}
			var ids []int64
			for _, item := range catalog.Repositories {
				source := map[string]any{"repositoryUrl": item.RepositoryURL, "commitSha": item.CommitSHA, "license": "MIT"}
				requestID := item.RequestID
				var ownerID *int
				switch scenario {
				case "known-id":
					source["repositoryId"] = int64(999)
				case "different-commit":
					source["commitSha"] = githubTestSHA
				case "different-url":
					source["repositoryUrl"] = "https://github.com/Other/repository"
				case "different-request":
					requestID, err = randomUUID()
					if err != nil {
						t.Fatal(err)
					}
				case "personal":
					ownerID = &personalID
				}
				var id int64
				if err = tx.QueryRow(ctx, `INSERT INTO agent_workspaces(user_id,is_system,name,github_source,github_import_request_id) VALUES($1,$2,'backfill-test',$3,$4) RETURNING id`, ownerID, ownerID == nil, source, requestID).Scan(&id); err != nil {
					t.Fatal(err)
				}
				if _, err = tx.Exec(ctx, `INSERT INTO agent_repository_publications(workspace_id,revision,name,description,license,github_source,published_at) VALUES($1,0,'backfill-test','','MIT',$2,'2026-10-09T00:00:00Z')`, id, source); err != nil {
					t.Fatal(err)
				}
				ids = append(ids, id)
			}
			for attempt := 0; attempt < 2; attempt++ {
				if _, err = tx.Exec(ctx, string(sql[start:])); err != nil {
					t.Fatal(err)
				}
			}
			for i, id := range ids {
				var workspaceSource, publicSource *agentGitHubSource
				var unchanged bool
				if err = tx.QueryRow(ctx, `SELECT w.github_source,p.github_source,w.revision=0 AND p.revision=0 AND p.published_at='2026-10-09T00:00:00Z'::timestamptz FROM agent_workspaces w JOIN agent_repository_publications p ON p.workspace_id=w.id WHERE w.id=$1`, id).Scan(&workspaceSource, &publicSource, &unchanged); err != nil {
					t.Fatal(err)
				}
				want := int64(0)
				if scenario == "matching" {
					want = catalog.Repositories[i].RepositoryID
					if want <= 0 {
						t.Fatal("catalog missing numeric ID")
					}
				}
				if scenario == "known-id" {
					want = 999
				}
				if !unchanged || workspaceSource.RepositoryID != want || publicSource.RepositoryID != want {
					t.Fatalf("backfill %s: workspace=%+v public=%+v unchanged=%v want=%d", scenario, workspaceSource, publicSource, unchanged, want)
				}
			}
		})
	}
}
