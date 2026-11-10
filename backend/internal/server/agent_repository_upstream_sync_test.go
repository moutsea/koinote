package server

import (
	"bytes"
	"context"
	"net/http"
	"reflect"
	"testing"

	"koinote/backend/internal/config"
)

// terminalRequestCounter counts every upstream request so a test can prove a
// terminal mark skipped work instead of merely classifying the response.
func terminalRequestCounter(app *App, count *int) *http.Client {
	original := app.githubHTTPClient
	return &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		*count = *count + 1
		return original.Transport.RoundTrip(r)
	})}
}

func TestSystemRepositorySyncTerminalUpstreamKeepsSnapshotAndPersistsMark(t *testing.T) {
	for _, scenario := range []string{"archived", "disabled", "missing", "legally-blocked", "private"} {
		t.Run(scenario, func(t *testing.T) {
			app, w, _, _, upstream := seedSystemRepositorySync(t, true)
			ctx := context.Background()
			wantCode, wantMark := agentUpstreamUnavailable, agentUpstreamUnavailable
			switch scenario {
			case "archived":
				upstream.archived = true
				wantCode, wantMark = "archived", agentUpstreamArchived
			case "disabled":
				upstream.disabled = true
				wantCode, wantMark = "disabled", agentUpstreamDisabled
			case "missing":
				upstream.status = http.StatusNotFound
			case "legally-blocked":
				// A DMCA takedown (451) is as permanent as a deleted repository.
				upstream.status = http.StatusUnavailableForLegalReasons
			case "private":
				upstream.private = true
				wantCode, wantMark = "private", agentUpstreamPrivate
			}
			before, err := loadAgentWorkspaceForOwner(ctx, app.db, nil, w.WorkspaceID)
			if err != nil {
				t.Fatal(err)
			}
			var publishedAt string
			if err = app.db.QueryRow(ctx, `SELECT published_at::text FROM agent_repository_publications WHERE workspace_id=$1`, w.WorkspaceID).Scan(&publishedAt); err != nil {
				t.Fatal(err)
			}
			summary, results, err := runSystemRepositorySync(t, app, w.WorkspaceID, true)
			if err != nil || summary.Skipped != 1 || summary.Failed != 0 || len(results) != 1 || results[0].Status != "skipped" || results[0].Code != wantCode {
				t.Fatalf("terminal upstream: %+v %+v %v", summary, results, err)
			}
			// Terminal state is settled from metadata alone: never download bytes,
			// and never spend a commit request once archived/disabled is known.
			if upstream.archives != 0 {
				t.Fatal("terminal upstream downloaded an archive")
			}
			if (scenario == "archived" || scenario == "disabled") && upstream.commits != 0 {
				t.Fatal("archived/disabled upstream resolved a commit")
			}
			current, err := loadAgentWorkspaceForOwner(ctx, app.db, nil, w.WorkspaceID)
			if err != nil || !reflect.DeepEqual(before.Files, current.Files) || current.Revision != before.Revision || current.GitHubSource.CommitSHA != before.GitHubSource.CommitSHA {
				t.Fatalf("terminal upstream changed the snapshot: %+v %v", current, err)
			}
			if current.GitHubSource.UpstreamStatus != wantMark {
				t.Fatalf("mark=%q want=%q", current.GitHubSource.UpstreamStatus, wantMark)
			}
			publication, err := app.loadPublicAgentRepository(ctx, w.WorkspaceID, nil)
			if err != nil || publication.Revision != w.Revision || publication.GitHubSource.UpstreamStatus != wantMark || !reflect.DeepEqual(publication.Files, w.Files) {
				t.Fatalf("terminal upstream changed the publication: %+v %v", publication, err)
			}
			var after string
			if err = app.db.QueryRow(ctx, `SELECT published_at::text FROM agent_repository_publications WHERE workspace_id=$1`, w.WorkspaceID).Scan(&after); err != nil || after != publishedAt {
				t.Fatalf("terminal upstream republished: %q %v", after, err)
			}
			// Repeating the sweep is idempotent and still serves the same bytes.
			summary, _, err = runSystemRepositorySync(t, app, w.WorkspaceID, true)
			if err != nil || summary.Skipped != 1 {
				t.Fatalf("terminal retry: %+v %v", summary, err)
			}
			if _, err = app.loadPublicAgentRepository(ctx, w.WorkspaceID, nil); err != nil {
				t.Fatalf("marked repository stopped serving its last good snapshot: %v", err)
			}
		})
	}
}

func TestSystemRepositorySyncTransientFaultDoesNotPersistMark(t *testing.T) {
	for _, status := range []int{http.StatusServiceUnavailable, http.StatusBadGateway, http.StatusTooManyRequests, http.StatusUnauthorized} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			app, w, _, _, upstream := seedSystemRepositorySync(t, false)
			upstream.status = status
			upstream.commitStatus = status
			summary, _, err := runSystemRepositorySync(t, app, w.WorkspaceID, true)
			if err == nil || summary.Failed != 1 {
				t.Fatalf("transient fault reported as success: %+v %v", summary, err)
			}
			current, err := loadAgentWorkspaceForOwner(context.Background(), app.db, nil, w.WorkspaceID)
			if err != nil || current.GitHubSource.UpstreamStatus != "" {
				t.Fatalf("transient fault persisted a mark: %+v %v", current.GitHubSource, err)
			}
		})
	}
}

func TestSystemRepositorySyncClearsTerminalMarkOnRecovery(t *testing.T) {
	app, w, _, _, upstream := seedSystemRepositorySync(t, false)
	ctx := context.Background()
	upstream.archived = true
	if summary, _, err := runSystemRepositorySync(t, app, w.WorkspaceID, true); err != nil || summary.Skipped != 1 {
		t.Fatalf("mark archived: %+v %v", summary, err)
	}
	// An already marked repository skips further GitHub work unless rechecked.
	if _, err := app.refreshAgentRepository(ctx, mustSyncSnapshot(t, app, w.WorkspaceID), agentRepositoryRefreshOptions{Apply: true, GitHubToken: "sync-test-token", SkipMarked: true}); err != nil {
		t.Fatal(err)
	}
	upstream.archived = false
	summary, results, err := runSystemRepositorySync(t, app, w.WorkspaceID, true)
	if err != nil || summary.Updated != 1 || len(results) != 1 || results[0].Status != "updated" {
		t.Fatalf("recovery: %+v %+v %v", summary, results, err)
	}
	current, err := loadAgentWorkspaceForOwner(ctx, app.db, nil, w.WorkspaceID)
	if err != nil || current.GitHubSource.UpstreamStatus != "" || current.GitHubSource.CommitSHA != githubSyncTestSHA {
		t.Fatalf("recovery kept the mark or old bytes: %+v %v", current, err)
	}
	publication, err := app.loadPublicAgentRepository(ctx, w.WorkspaceID, nil)
	if err != nil || publication.GitHubSource.UpstreamStatus != "" || publication.Revision != current.Revision {
		t.Fatalf("publication kept the mark: %+v %v", publication, err)
	}
}

func mustSyncSnapshot(t *testing.T, app *App, id int64) agentRepositorySyncSnapshot {
	t.Helper()
	snapshot, err := app.loadAgentRepositorySyncSnapshot(context.Background(), app.db, id)
	if err != nil {
		t.Fatal(err)
	}
	return snapshot
}

func TestSystemRepositorySyncMarkedRepositorySkipsUpstreamWork(t *testing.T) {
	app, w, _, _, upstream := seedSystemRepositorySync(t, false)
	ctx := context.Background()
	upstream.status = http.StatusNotFound
	if summary, _, err := runSystemRepositorySync(t, app, w.WorkspaceID, true); err != nil || summary.Skipped != 1 {
		t.Fatalf("mark unavailable: %+v %v", summary, err)
	}
	// Once marked, an action-triggered refresh must not spend GitHub requests,
	// so a transient outage cannot block using the last good snapshot.
	var requests int
	app.githubHTTPClient = terminalRequestCounter(app, &requests)
	publication, result, err := app.refreshPublicAgentRepository(ctx, w.WorkspaceID, "sync-test-token", false)
	if err != nil || result.Status != "skipped" || result.Code != agentUpstreamUnavailable || requests != 0 {
		t.Fatalf("marked skip: %+v requests=%d %v", result, requests, err)
	}
	if publication == nil || publication.Revision != w.Revision || len(publication.Files) != len(w.Files) {
		t.Fatalf("marked skip lost the snapshot: %+v", publication)
	}
	// A manual recheck does contact GitHub and settles the same term again.
	_, result, err = app.refreshPublicAgentRepository(ctx, w.WorkspaceID, "sync-test-token", true)
	if err != nil || result.Status != "skipped" || result.Code != agentUpstreamUnavailable || requests == 0 {
		t.Fatalf("manual recheck: %+v requests=%d %v", result, requests, err)
	}
}

const personalSyncSHA = "fedcba0987654321fedcba0987654321fedcba09"

func seedPersonalGitHubRepository(t *testing.T) (*App, agentWorkspaceView, int, *githubSyncFixture) {
	t.Helper()
	ctx := context.Background()
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "personal-upstream-sync", AppURL: "https://koinote.example"}, pool)
	owner := seedMCPUser(t, pool, app, membershipTierLifetime)
	if _, err := pool.Exec(ctx, `INSERT INTO agent_workspace_settings(user_id,enabled) VALUES($1,true)`, owner.ID); err != nil {
		t.Fatal(err)
	}
	archive := githubArchive(t,
		githubArchiveEntry{"root/README.md", "# Original", 0},
		githubArchiveEntry{"root/LICENSE", discoveryMIT, 0})
	files, err := readGitHubArchive(ctx, bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		t.Fatal(err)
	}
	source := &agentGitHubSource{RepositoryID: 54321, RepositoryURL: "https://github.com/Octo/personal-demo", Author: "Octo", AuthorURL: "https://github.com/Octo", Ref: "main", CommitSHA: githubTestSHA, License: "MIT"}
	requestID, _ := randomUUID()
	w, err := app.importGitHubRepositoryForOwner(ctx, &owner.ID, owner.ID, requestID, "personal-seed", "Personal", "Direct import", files, source)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM agent_workspaces WHERE id=$1`, w.WorkspaceID)
	})
	if err = app.setAgentRepositoryPublicationForOwner(ctx, &owner.ID, owner.ID, w.WorkspaceID, w.Revision, "MIT", false, nil); err != nil {
		t.Fatal(err)
	}
	upstream := &githubSyncFixture{repositoryID: source.RepositoryID, sha: personalSyncSHA, license: "MIT", fullName: "Octo/personal-demo",
		archive: githubArchive(t,
			githubArchiveEntry{"root/README.md", "# Updated upstream", 0},
			githubArchiveEntry{"root/LICENSE", discoveryMIT, 0})}
	app.githubHTTPClient = upstream.client(t)
	return app, w, owner.ID, upstream
}

func TestPersonalDirectGitHubImportRefreshes(t *testing.T) {
	app, w, ownerID, upstream := seedPersonalGitHubRepository(t)
	ctx := context.Background()
	publication, result, err := app.refreshPublicAgentRepository(ctx, w.WorkspaceID, "sync-test-token", true)
	if err != nil || result.Status != "updated" || upstream.archives != 1 {
		t.Fatalf("personal refresh: %+v archives=%d %v", result, upstream.archives, err)
	}
	if publication == nil || publication.GitHubSource.CommitSHA != personalSyncSHA {
		t.Fatalf("personal refresh not published: %+v", publication)
	}
	var content string
	if err = app.db.QueryRow(ctx, `SELECT convert_from(content,'UTF8') FROM agent_workspace_files WHERE workspace_id=$1 AND path='README.md'`, w.WorkspaceID).Scan(&content); err != nil || content != "# Updated upstream" {
		t.Fatalf("latest upstream bytes not applied: %q %v", content, err)
	}
	// Quota accounting still holds after an in-place refresh.
	var used, quota int64
	if err = app.db.QueryRow(ctx, `SELECT agent_workspace_storage_bytes($1),agent_workspace_quota_bytes($1)`, ownerID).Scan(&used, &quota); err != nil || used > quota {
		t.Fatalf("refresh exceeded quota: used=%d quota=%d err=%v", used, quota, err)
	}
}

func TestPersonalCopyWithLocalEditsIsNotOverwritten(t *testing.T) {
	for _, scenario := range []string{"patch", "replace", "restore", "unpublished-metadata"} {
		t.Run(scenario, func(t *testing.T) {
			app, w, owner, upstream := seedPersonalGitHubRepository(t)
			ctx := context.Background()
			switch scenario {
			case "patch":
				if _, err := app.patchAgentWorkspace(ctx, owner, w.WorkspaceID, w.Revision, nil, nil); err != nil {
					t.Fatal(err)
				}
			case "replace":
				files := []agentWorkspaceFile{repositoryTestFile("README.md", "# local replace")}
				if _, err := app.replaceAgentWorkspace(ctx, owner, w.WorkspaceID, w.Revision, files); err != nil {
					t.Fatal(err)
				}
			case "restore":
				if _, err := app.mutateAgentWorkspaceWithHistory(ctx, owner, w.WorkspaceID, w.Revision, nil, nil, true, &w.Revision, false, ""); err != nil {
					t.Fatal(err)
				}
			case "unpublished-metadata":
				if _, err := app.manageAgentWorkspace(ctx, owner, w.WorkspaceID, w.Revision, "Renamed privately", "Still private", false); err != nil {
					t.Fatal(err)
				}
			}
			current, err := loadAgentWorkspaceForOwner(ctx, app.db, &owner, w.WorkspaceID)
			if err != nil {
				t.Fatal(err)
			}
			snapshot := mustSyncSnapshot(t, app, w.WorkspaceID)
			result, err := app.refreshAgentRepository(ctx, snapshot, agentRepositoryRefreshOptions{Apply: true, GitHubToken: "sync-test-token"})
			if err != nil || result.Status != "skipped" {
				t.Fatalf("local edits refreshed: %+v %v", result, err)
			}
			if result.Code != "local_changes" {
				t.Fatalf("skip code=%q want=local_changes", result.Code)
			}
			if upstream.archives != 0 {
				t.Fatal("local edits still downloaded upstream bytes")
			}
			after, err := loadAgentWorkspaceForOwner(ctx, app.db, &owner, w.WorkspaceID)
			if err != nil || !reflect.DeepEqual(after.Files, current.Files) || after.Revision != current.Revision || after.Name != current.Name || after.GitHubSource.CommitSHA != current.GitHubSource.CommitSHA {
				t.Fatalf("local edits were overwritten: %+v %v", after, err)
			}
		})
	}
}

func TestPersonalRefreshRejectsNonGitHubAndForkContent(t *testing.T) {
	ctx := context.Background()
	app, w, owner, upstream := seedPersonalGitHubRepository(t)
	if _, err := app.db.Exec(ctx, `UPDATE agent_workspaces SET github_source=NULL WHERE id=$1`, w.WorkspaceID); err != nil {
		t.Fatal(err)
	}
	snapshot, err := app.loadAgentRepositorySyncSnapshot(ctx, app.db, w.WorkspaceID)
	if err != nil {
		t.Fatal(err)
	}
	result, err := app.refreshAgentRepository(ctx, snapshot, agentRepositoryRefreshOptions{Apply: true, GitHubToken: "sync-test-token"})
	if err != nil || result.Status != "skipped" || result.Code != "no_github_source" || upstream.archives != 0 {
		t.Fatalf("non-GitHub repository: %+v archives=%d %v", result, upstream.archives, err)
	}
	if _, err = app.loadAgentWorkspace(ctx, owner, w.WorkspaceID); err != nil {
		t.Fatal(err)
	}
}

func TestPersonalDisabledSyncIsNotRewritten(t *testing.T) {
	app, w, owner, upstream := seedPersonalGitHubRepository(t)
	ctx := context.Background()
	if _, err := app.db.Exec(ctx, `UPDATE agent_workspace_settings SET enabled=false WHERE user_id=$1`, owner); err != nil {
		t.Fatal(err)
	}
	snapshot, err := app.loadAgentRepositorySyncSnapshot(ctx, app.db, w.WorkspaceID)
	if err != nil {
		t.Fatal(err)
	}
	result, err := app.refreshAgentRepository(ctx, snapshot, agentRepositoryRefreshOptions{Apply: true, GitHubToken: "sync-test-token"})
	if err != nil || result.Status != "skipped" || result.Code != "agent_workspace_disabled" || upstream.archives != 0 {
		t.Fatalf("disabled sync: %+v archives=%d %v", result, upstream.archives, err)
	}
}
