package server

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http"
	"reflect"
	"testing"
)

func allowAnonymousRepositorySyncFixture(app *App) {
	transport := app.githubHTTPClient.Transport
	app.githubHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		request := r.Clone(r.Context())
		if request.URL.Host != githubCodeLoadHost {
			request.Header.Set("Authorization", "Bearer sync-test-token")
		}
		return transport.RoundTrip(request)
	})}
}

func TestPublicRepositoryPreparationUsesCurrentUpstreamState(t *testing.T) {
	app, before, _, _, upstream := seedSystemRepositorySync(t, false)
	allowAnonymousRepositorySyncFixture(app)
	ctx := context.Background()
	base := fmt.Sprintf("/api/agent/repositories/%d/sync", before.WorkspaceID)
	var requests int
	app.githubHTTPClient = terminalRequestCounter(app, &requests)
	var response struct {
		Repository agentRepositoryPublication `json:"repository"`
		Sync       SystemRepositorySyncResult `json:"sync"`
	}
	upstream.archived = true
	response.Repository = agentRepositoryPublication{}
	decodeJSONResponse(t, callRepositoryAPI(t, app, nil, http.MethodPost, base, "", http.StatusOK), &response)
	if response.Repository.GitHubSource.UpstreamStatus != agentUpstreamArchived {
		t.Fatal("manual sync did not persist the archived mark")
	}
	// The page may still show an active source. The server's current mark must
	// keep preparation offline, without treating it as a forced manual recheck.
	upstream.status = http.StatusServiceUnavailable
	requests = 0
	response.Repository = agentRepositoryPublication{}
	decodeJSONResponse(t, callRepositoryAPI(t, app, nil, http.MethodPost, base+"?recheck=false", "", http.StatusOK), &response)
	if requests != 0 || response.Sync.Code != agentUpstreamArchived || response.Repository.Revision != before.Revision {
		t.Fatalf("preparation ignored server mark: %+v requests=%d", response, requests)
	}
	// Another visitor clears the mark at the same revision. A page caching the
	// archived mark must not suppress a check for a later upstream commit.
	upstream.status, upstream.archived, upstream.sha = 0, false, githubTestSHA
	response.Repository = agentRepositoryPublication{}
	decodeJSONResponse(t, callRepositoryAPI(t, app, nil, http.MethodPost, base, "", http.StatusOK), &response)
	if response.Repository.GitHubSource.UpstreamStatus != "" || response.Repository.Revision != before.Revision {
		t.Fatal("same-commit recovery changed the revision or kept the archived mark")
	}
	upstream.sha = githubSyncTestSHA
	requests = 0
	response.Repository = agentRepositoryPublication{}
	decodeJSONResponse(t, callRepositoryAPI(t, app, nil, http.MethodPost, base+"?recheck=false", "", http.StatusOK), &response)
	if requests != 3 || response.Sync.Status != "updated" || response.Repository.Revision != before.Revision+1 || response.Repository.GitHubSource.CommitSHA != githubSyncTestSHA {
		t.Fatalf("recovered preparation missed the new commit: %+v requests=%d", response, requests)
	}
	// A plain shared snapshot is also prepared using its current publication.
	if _, err := app.db.Exec(ctx, `WITH cleared AS (UPDATE agent_workspaces SET github_source=NULL WHERE id=$1) UPDATE agent_repository_publications SET github_source=NULL WHERE workspace_id=$1`, before.WorkspaceID); err != nil {
		t.Fatal(err)
	}
	requests = 0
	response.Repository = agentRepositoryPublication{}
	decodeJSONResponse(t, callRepositoryAPI(t, app, nil, http.MethodPost, base+"?recheck=false", "", http.StatusOK), &response)
	if requests != 0 || response.Sync.Code != "no_github_source" || response.Repository.GitHubSource != nil {
		t.Fatalf("ordinary preparation contacted GitHub: %+v requests=%d", response, requests)
	}
	for _, query := range []string{"?recheck=invalid", "?recheck=", "?recheck=true&recheck=false"} {
		callRepositoryAPI(t, app, nil, http.MethodPost, base+query, "", http.StatusBadRequest)
	}
}

func TestPublicRepositoryExposesSyncDisabledReason(t *testing.T) {
	for _, scenario := range []string{"personal_fork", "published_edits", "unpublished_edits", "disabled_sync", "pristine_import"} {
		t.Run(scenario, func(t *testing.T) {
			app, original, owner, _ := seedPersonalGitHubRepository(t)
			ctx := context.Background()
			// A Fork can inherit an upstream mark that must be described as saved
			// provenance, without promising that the independent copy rechecks it.
			if scenario == "personal_fork" {
				if _, err := app.db.Exec(ctx, `WITH marked AS (UPDATE agent_workspaces SET github_source=github_source || '{"upstreamStatus":"archived"}'::jsonb WHERE id=$1) UPDATE agent_repository_publications SET github_source=github_source || '{"upstreamStatus":"archived"}'::jsonb WHERE workspace_id=$1`, original.WorkspaceID); err != nil {
					t.Fatal(err)
				}
			}
			saved := prepareSavedPersonalSnapshot(t, app, original, owner, scenario)
			base := fmt.Sprintf("/api/agent/repositories/%d", saved.WorkspaceID)
			var response struct {
				Repository agentRepositoryPublication `json:"repository"`
			}
			decodeJSONResponse(t, callRepositoryAPI(t, app, nil, http.MethodGet, base, "", http.StatusOK), &response)
			want := "local_changes"
			switch scenario {
			case "personal_fork":
				want = "personal_fork"
			case "disabled_sync":
				want = "agent_workspace_disabled"
			case "pristine_import":
				want = ""
			}
			if response.Repository.SyncDisabledReason != want {
				t.Fatalf("disabled reason=%q want=%q", response.Repository.SyncDisabledReason, want)
			}
			if scenario == "personal_fork" && response.Repository.GitHubSource.UpstreamStatus != agentUpstreamArchived {
				t.Fatal("fork did not retain the inherited upstream mark")
			}
		})
	}
}

func TestPublicRepositoryPreparationHasIndependentActionBudget(t *testing.T) {
	app, before, _, _, _ := seedSystemRepositorySync(t, false)
	if _, err := app.db.Exec(context.Background(), `WITH cleared AS (UPDATE agent_workspaces SET github_source=NULL WHERE id=$1) UPDATE agent_repository_publications SET github_source=NULL WHERE workspace_id=$1`, before.WorkspaceID); err != nil {
		t.Fatal(err)
	}
	base := fmt.Sprintf("/api/agent/repositories/%d", before.WorkspaceID)
	// Exhaust manual sync first. Preparing a saved snapshot still has the same
	// request allowance as Clone, without sharing the manual refresh counters.
	for range 10 {
		callRepositoryAPI(t, app, nil, http.MethodPost, base+"/sync", "", http.StatusOK)
	}
	callRepositoryAPI(t, app, nil, http.MethodPost, base+"/sync", "", http.StatusTooManyRequests)
	for range 30 {
		callRepositoryAPI(t, app, nil, http.MethodPost, base+"/sync?recheck=false", "", http.StatusOK)
		requestID, _ := randomUUID()
		body := fmt.Sprintf(`{"expectedRevision":%d,"requestId":%q,"method":"zip","refresh":false}`, before.Revision, requestID)
		callRepositoryAPI(t, app, nil, http.MethodPost, base+"/clone", body, http.StatusOK)
	}
	callRepositoryAPI(t, app, nil, http.MethodPost, base+"/sync?recheck=false", "", http.StatusTooManyRequests)
}

func TestPreparedPublicAgentRepositoryActionsReuseRefresh(t *testing.T) {
	for _, changed := range []bool{false, true} {
		t.Run(fmt.Sprintf("changed=%t", changed), func(t *testing.T) {
			app, before, userID, _, upstream := seedSystemRepositorySync(t, false)
			ctx := context.Background()
			if !changed {
				upstream.sha = githubTestSHA
			}
			if _, err := app.db.Exec(ctx, `INSERT INTO agent_workspace_settings(user_id,enabled) VALUES($1,true)`, userID); err != nil {
				t.Fatal(err)
			}
			var externalID string
			if err := app.db.QueryRow(ctx, `SELECT auth_user_id FROM users WHERE id=$1`, userID).Scan(&externalID); err != nil {
				t.Fatal(err)
			}
			cookie := mcpSessionCookie(app, externalID)
			transport := app.githubHTTPClient.Transport
			var requests int
			app.githubHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				requests++
				request := r.Clone(r.Context())
				if request.URL.Host != githubCodeLoadHost {
					request.Header.Set("Authorization", "Bearer sync-test-token")
				}
				return transport.RoundTrip(request)
			})}
			base := fmt.Sprintf("/api/agent/repositories/%d", before.WorkspaceID)
			var refreshed struct {
				Repository agentRepositoryPublication `json:"repository"`
			}
			decodeJSONResponse(t, callRepositoryAPI(t, app, cookie, http.MethodPost, base+"/sync", "", http.StatusOK), &refreshed)
			wantRequests := 2
			if changed {
				wantRequests++
			}
			if requests != wantRequests {
				t.Fatalf("refresh made %d upstream requests, want %d", requests, wantRequests)
			}
			// A later GitHub outage must not block consuming a snapshot that was
			// just prepared. All publication and revision checks still apply.
			upstream.status = http.StatusServiceUnavailable
			cloneID, _ := randomUUID()
			cloneBody := fmt.Sprintf(`{"expectedRevision":%d,"requestId":%q,"method":"zip","refresh":false}`, refreshed.Repository.Revision, cloneID)
			callRepositoryAPI(t, app, cookie, http.MethodPost, base+"/clone", cloneBody, http.StatusOK)
			forkID, _ := randomUUID()
			forkBody := fmt.Sprintf(`{"expectedRevision":%d,"requestId":%q,"refresh":false}`, refreshed.Repository.Revision, forkID)
			var forked struct {
				Workspace agentWorkspaceView `json:"workspace"`
			}
			decodeJSONResponse(t, callRepositoryAPI(t, app, cookie, http.MethodPost, base+"/fork", forkBody, http.StatusCreated), &forked)
			if forked.Workspace.GitHubSource.CommitSHA != refreshed.Repository.GitHubSource.CommitSHA || len(forked.Workspace.Files) != len(refreshed.Repository.Files) {
				t.Fatalf("Fork changed prepared snapshot: %+v", forked.Workspace)
			}
			for index, file := range forked.Workspace.Files {
				if file.SHA256 != refreshed.Repository.Files[index].SHA256 {
					t.Fatalf("Fork changed prepared bytes at %q", file.Path)
				}
			}
			if requests != wantRequests {
				t.Fatalf("prepared actions repeated upstream checks: got %d want %d", requests, wantRequests)
			}
			if _, err := app.db.Exec(ctx, `UPDATE agent_repository_publications SET revision=revision+1 WHERE workspace_id=$1`, before.WorkspaceID); err != nil {
				t.Fatal(err)
			}
			callRepositoryAPI(t, app, cookie, http.MethodPost, base+"/clone", cloneBody, http.StatusConflict)
			// A committed Fork still replays its original copy after publication
			// advances, even when a manual Sync happened between attempts.
			var replay struct {
				Workspace agentWorkspaceView `json:"workspace"`
			}
			decodeJSONResponse(t, callRepositoryAPI(t, app, cookie, http.MethodPost, base+"/fork", forkBody, http.StatusCreated), &replay)
			if !reflect.DeepEqual(forked.Workspace, replay.Workspace) {
				t.Fatalf("prepared Fork replay changed result: original=%+v replay=%+v", forked.Workspace, replay.Workspace)
			}
			newForkID, _ := randomUUID()
			callRepositoryAPI(t, app, cookie, http.MethodPost, base+"/fork", fmt.Sprintf(`{"expectedRevision":%d,"requestId":%q,"refresh":false}`, refreshed.Repository.Revision, newForkID), http.StatusConflict)
			if _, err := app.db.Exec(ctx, `DELETE FROM agent_repository_publications WHERE workspace_id=$1`, before.WorkspaceID); err != nil {
				t.Fatal(err)
			}
			newCloneID, _ := randomUUID()
			callRepositoryAPI(t, app, cookie, http.MethodPost, base+"/clone", fmt.Sprintf(`{"expectedRevision":%d,"requestId":%q,"method":"zip","refresh":false}`, refreshed.Repository.Revision, newCloneID), http.StatusNotFound)
			if requests != wantRequests {
				t.Fatalf("prepared conflicts repeated upstream checks: got %d want %d", requests, wantRequests)
			}
		})
	}
}

func TestPublicAgentRepositorySyncUpdatesSnapshotAndCloneUsesNewBytes(t *testing.T) {
	app, before, _, _, upstream := seedSystemRepositorySync(t, false)
	allowAnonymousRepositorySyncFixture(app)
	path := fmt.Sprintf("/api/agent/repositories/%d", before.WorkspaceID)
	response := callRepositoryAPI(t, app, nil, http.MethodPost, path+"/sync", "", http.StatusOK)
	var refreshed struct {
		Repository agentRepositoryPublication `json:"repository"`
		Sync       SystemRepositorySyncResult `json:"sync"`
	}
	decodeJSONResponse(t, response, &refreshed)
	if refreshed.Sync.Status != "updated" || refreshed.Repository.Revision != before.Revision+1 || refreshed.Repository.GitHubSource.CommitSHA != githubSyncTestSHA {
		t.Fatalf("refresh did not publish new commit: %+v", refreshed)
	}
	for _, file := range refreshed.Repository.Files {
		if file.Path != "README.md" {
			continue
		}
		result := callRepositoryAPI(t, app, nil, http.MethodGet, fmt.Sprintf("%s/files/%d?revision=%d", path, file.FileID, refreshed.Repository.Revision), "", http.StatusOK)
		var content struct {
			File agentWorkspaceFileContentView `json:"file"`
		}
		decodeJSONResponse(t, result, &content)
		bytes, err := base64.StdEncoding.DecodeString(content.File.ContentBase64)
		if err != nil || string(bytes) != "# Updated" {
			t.Fatalf("stale downloaded content: %q %v", bytes, err)
		}
		requestID, _ := randomUUID()
		callRepositoryAPI(t, app, nil, http.MethodPost, path+"/clone", fmt.Sprintf(`{"expectedRevision":%d,"requestId":%q,"method":"zip"}`, refreshed.Repository.Revision, requestID), http.StatusOK)
		if upstream.archives != 1 {
			t.Fatalf("unchanged clone downloaded another archive: %d", upstream.archives)
		}
		return
	}
	t.Fatal("refreshed manifest is missing README.md")
}

func TestPublicAgentRepositoryForkRefreshRejectsStaleVersionThenReplays(t *testing.T) {
	app, before, userID, _, upstream := seedSystemRepositorySync(t, false)
	allowAnonymousRepositorySyncFixture(app)
	ctx := context.Background()
	if _, err := app.db.Exec(ctx, `INSERT INTO agent_workspace_settings(user_id,enabled) VALUES($1,true)`, userID); err != nil {
		t.Fatal(err)
	}
	var externalID string
	if err := app.db.QueryRow(ctx, `SELECT auth_user_id FROM users WHERE id=$1`, userID).Scan(&externalID); err != nil {
		t.Fatal(err)
	}
	cookie := mcpSessionCookie(app, externalID)
	path := fmt.Sprintf("/api/agent/repositories/%d/fork", before.WorkspaceID)
	requestID, _ := randomUUID()
	callRepositoryAPI(t, app, cookie, http.MethodPost, path, fmt.Sprintf(`{"expectedRevision":%d,"requestId":%q}`, before.Revision, requestID), http.StatusConflict)
	current, err := app.loadPublicAgentRepository(ctx, before.WorkspaceID, nil)
	if err != nil || current.GitHubSource.CommitSHA != githubSyncTestSHA {
		t.Fatalf("Fork did not refresh upstream: %+v %v", current, err)
	}
	body := fmt.Sprintf(`{"expectedRevision":%d,"requestId":%q}`, current.Revision, requestID)
	result := callRepositoryAPI(t, app, cookie, http.MethodPost, path, body, http.StatusCreated)
	var copied struct {
		Workspace agentWorkspaceView `json:"workspace"`
	}
	decodeJSONResponse(t, result, &copied)
	upstream.status = http.StatusServiceUnavailable
	result = callRepositoryAPI(t, app, cookie, http.MethodPost, path, body, http.StatusCreated)
	var replay struct {
		Workspace agentWorkspaceView `json:"workspace"`
	}
	decodeJSONResponse(t, result, &replay)
	if copied.Workspace.WorkspaceID != replay.Workspace.WorkspaceID || replay.Workspace.GitHubSource.CommitSHA != githubSyncTestSHA {
		t.Fatalf("Fork replay changed its snapshot: %+v %+v", copied, replay)
	}
}

func TestPublicAgentRepositoryCloneRefreshesBeforeRecordingAndReplaysOffline(t *testing.T) {
	app, before, _, _, upstream := seedSystemRepositorySync(t, false)
	allowAnonymousRepositorySyncFixture(app)
	path := fmt.Sprintf("/api/agent/repositories/%d/clone", before.WorkspaceID)
	requestID, _ := randomUUID()
	callRepositoryAPI(t, app, nil, http.MethodPost, path, fmt.Sprintf(`{"expectedRevision":%d,"requestId":%q,"method":"home"}`, before.Revision, requestID), http.StatusConflict)
	current, err := app.loadPublicAgentRepository(context.Background(), before.WorkspaceID, nil)
	if err != nil || current.GitHubSource.CommitSHA != githubSyncTestSHA {
		t.Fatalf("Clone did not refresh upstream: %+v %v", current, err)
	}
	body := fmt.Sprintf(`{"expectedRevision":%d,"requestId":%q,"method":"home"}`, current.Revision, requestID)
	callRepositoryAPI(t, app, nil, http.MethodPost, path, body, http.StatusOK)
	upstream.status = http.StatusServiceUnavailable
	result := callRepositoryAPI(t, app, nil, http.MethodPost, path, body, http.StatusOK)
	var engagement agentRepositoryEngagement
	decodeJSONResponse(t, result, &engagement)
	if engagement.CloneCount != 1 {
		t.Fatalf("Clone retry duplicated initiation: %+v", engagement)
	}
	// An acknowledged initiation is not proof that its pinned snapshot is still
	// downloadable after a publication update. Replays must report that conflict.
	upstream.status = 0
	upstream.sha = personalSyncSHA
	latest, _, err := app.refreshPublicAgentRepository(context.Background(), before.WorkspaceID, "sync-test-token", true)
	if err != nil {
		t.Fatal(err)
	}
	callRepositoryAPI(t, app, nil, http.MethodPost, path, body, http.StatusConflict)
	stats, err := loadAgentRepositoryEngagement(context.Background(), app.db, before.WorkspaceID, nil)
	if err != nil || stats.CloneCount != 1 {
		t.Fatalf("stale replay changed the Clone count: %+v %v", stats, err)
	}
	newRequestID, _ := randomUUID()
	newBody := fmt.Sprintf(`{"expectedRevision":%d,"requestId":%q,"method":"home"}`, latest.Revision, newRequestID)
	for range 2 {
		response := callRepositoryAPI(t, app, nil, http.MethodPost, path, newBody, http.StatusOK)
		decodeJSONResponse(t, response, &engagement)
		if engagement.CloneCount != 2 {
			t.Fatalf("new snapshot Clone was not idempotent: %+v", engagement)
		}
	}
}
