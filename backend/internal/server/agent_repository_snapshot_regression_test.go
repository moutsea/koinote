package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"sync/atomic"
	"testing"
)

func snapshotTestViewer(t *testing.T, app *App) (int, *http.Cookie) {
	t.Helper()
	viewer := seedMCPUser(t, app.db, app, membershipTierLifetime)
	if _, err := app.db.Exec(context.Background(), `INSERT INTO agent_workspace_settings(user_id,enabled) VALUES($1,true)`, viewer.ID); err != nil {
		t.Fatal(err)
	}
	return viewer.ID, mcpSessionCookie(app, viewer.AuthUserID)
}

func prepareSavedPersonalSnapshot(t *testing.T, app *App, original agentWorkspaceView, owner int, scenario string) agentWorkspaceView {
	t.Helper()
	ctx := context.Background()
	var err error
	copy := original
	switch scenario {
	case "personal_fork":
		requestID, _ := randomUUID()
		copy, err = app.forkAgentRepository(ctx, owner, original.WorkspaceID, original.Revision, requestID)
	case "published_edits", "unpublished_edits":
		copy, err = app.patchAgentWorkspace(ctx, owner, original.WorkspaceID, original.Revision, []agentWorkspaceFile{repositoryTestFile("README.md", "# Personal revision")}, nil)
	case "disabled_sync":
		_, err = app.db.Exec(ctx, `UPDATE agent_workspace_settings SET enabled=false WHERE user_id=$1`, owner)
	}
	if err != nil {
		t.Fatal(err)
	}
	if scenario == "personal_fork" || scenario == "published_edits" {
		if err = app.setAgentRepositoryPublication(ctx, owner, copy.WorkspaceID, copy.Revision, "MIT", false); err != nil {
			t.Fatal(err)
		}
	}
	return copy
}

func assertSavedSnapshotActions(t *testing.T, app *App, id int64, cookie *http.Cookie, skip string) {
	t.Helper()
	ctx := context.Background()
	before, err := app.loadPublicAgentRepository(ctx, id, nil)
	if err != nil {
		t.Fatal(err)
	}
	base := fmt.Sprintf("/api/agent/repositories/%d", id)
	var synced struct {
		Repository agentRepositoryPublication `json:"repository"`
		Sync       SystemRepositorySyncResult `json:"sync"`
	}
	decodeJSONResponse(t, callRepositoryAPI(t, app, cookie, http.MethodPost, base+"/sync", "", http.StatusOK), &synced)
	if synced.Sync.Status != "skipped" || synced.Sync.Code != skip || synced.Repository.Revision != before.Revision || !reflect.DeepEqual(synced.Repository.Files, before.Files) || !reflect.DeepEqual(synced.Repository.GitHubSource, before.GitHubSource) {
		t.Fatalf("saved snapshot was not preserved: sync=%+v repository=%+v", synced.Sync, synced.Repository)
	}
	cloneID, _ := randomUUID()
	callRepositoryAPI(t, app, cookie, http.MethodPost, base+"/clone", fmt.Sprintf(`{"expectedRevision":%d,"requestId":%q,"method":"zip"}`, before.Revision, cloneID), http.StatusOK)
	forkID, _ := randomUUID()
	var forked struct {
		Workspace agentWorkspaceView `json:"workspace"`
	}
	decodeJSONResponse(t, callRepositoryAPI(t, app, cookie, http.MethodPost, base+"/fork", fmt.Sprintf(`{"expectedRevision":%d,"requestId":%q}`, before.Revision, forkID), http.StatusCreated), &forked)
	if !reflect.DeepEqual(forked.Workspace.GitHubSource, before.GitHubSource) {
		t.Fatalf("Fork changed the saved source: %+v", forked.Workspace.GitHubSource)
	}
	files := make(map[string]string, len(before.Files))
	for _, file := range before.Files {
		files[file.Path] = file.SHA256
	}
	for _, file := range forked.Workspace.Files {
		if files[file.Path] != file.SHA256 {
			t.Fatalf("Fork copied different bytes at %q", file.Path)
		}
		delete(files, file.Path)
	}
	if len(files) != 0 {
		t.Fatalf("Fork omitted saved files: %v", files)
	}
}

func TestPublicRepositorySavedSnapshotIgnoresUnusedBrokenCredential(t *testing.T) {
	for _, scenario := range []string{"personal_fork", "published_edits", "unpublished_edits", "disabled_sync"} {
		t.Run(scenario, func(t *testing.T) {
			app, original, owner, _ := seedPersonalGitHubRepository(t)
			saved := prepareSavedPersonalSnapshot(t, app, original, owner, scenario)
			viewer, cookie := snapshotTestViewer(t, app)
			ciphertext, err := app.encryptGitHubToken(viewer, "saved-snapshot-test-token")
			if err != nil {
				t.Fatal(err)
			}
			if _, err = app.db.Exec(context.Background(), `INSERT INTO agent_github_credentials(user_id,token_ciphertext) VALUES($1,$2)`, viewer, ciphertext); err != nil {
				t.Fatal(err)
			}
			app.cfg.MCPTokenEncryptionKey = "rotated-snapshot-encryption-key"
			var requests atomic.Int32
			app.githubHTTPClient = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				requests.Add(1)
				return nil, errors.New("saved snapshot must not contact GitHub")
			})}
			skip := "local_changes"
			if scenario == "personal_fork" {
				skip = "personal_fork"
			} else if scenario == "disabled_sync" {
				skip = "agent_workspace_disabled"
			}
			assertSavedSnapshotActions(t, app, saved.WorkspaceID, cookie, skip)
			if requests.Load() != 0 {
				t.Fatalf("saved snapshot made %d unnecessary upstream requests", requests.Load())
			}
		})
	}
}

func TestPublicRepositoryLegacySnapshotSkipsIdentityOnlyWhenNoRefreshNeeded(t *testing.T) {
	for _, scenario := range []string{"personal_fork", "published_edits", "disabled_sync", "pristine_import"} {
		t.Run(scenario, func(t *testing.T) {
			app, original, owner, _ := seedPersonalGitHubRepository(t)
			saved := prepareSavedPersonalSnapshot(t, app, original, owner, scenario)
			_, cookie := snapshotTestViewer(t, app)
			if _, err := app.db.Exec(context.Background(), `WITH legacy AS (UPDATE agent_workspaces SET github_source=github_source-'repositoryId' WHERE id=$1 RETURNING github_source) UPDATE agent_repository_publications SET github_source=(SELECT github_source FROM legacy) WHERE workspace_id=$1`, saved.WorkspaceID); err != nil {
				t.Fatal(err)
			}
			var requests atomic.Int32
			app.githubHTTPClient = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
				requests.Add(1)
				return nil, errors.New("unverified legacy source must not contact GitHub")
			})}
			if scenario == "pristine_import" {
				base := fmt.Sprintf("/api/agent/repositories/%d", saved.WorkspaceID)
				callRepositoryAPI(t, app, nil, http.MethodPost, base+"/sync", "", http.StatusConflict)
			} else {
				skip := "local_changes"
				if scenario == "personal_fork" {
					skip = "personal_fork"
				} else if scenario == "disabled_sync" {
					skip = "agent_workspace_disabled"
				}
				assertSavedSnapshotActions(t, app, saved.WorkspaceID, cookie, skip)
				requestID, _ := randomUUID()
				base := fmt.Sprintf("/api/agent/repositories/%d/clone", saved.WorkspaceID)
				callRepositoryAPI(t, app, nil, http.MethodPost, base, fmt.Sprintf(`{"expectedRevision":%d,"requestId":%q,"method":"home"}`, saved.Revision, requestID), http.StatusOK)
			}
			if requests.Load() != 0 {
				t.Fatalf("legacy snapshot made %d upstream requests", requests.Load())
			}
		})
	}
}
