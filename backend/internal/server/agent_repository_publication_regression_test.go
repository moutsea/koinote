package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"testing"
)

func TestPublicRepositoryPreparationRetainsRejectedSnapshot(t *testing.T) {
	for _, code := range []string{"license_changed", "license_review_required", "publication_license_mismatch", "repository_identity_mismatch"} {
		t.Run(code, func(t *testing.T) {
			app, before, userID, _, upstream := seedSystemRepositorySync(t, false)
			allowAnonymousRepositorySyncFixture(app)
			ctx := context.Background()
			if err := app.setAgentWorkspaceEnabled(ctx, userID, true); err != nil {
				t.Fatal(err)
			}
			var externalID string
			if err := app.db.QueryRow(ctx, `SELECT auth_user_id FROM users WHERE id=$1`, userID).Scan(&externalID); err != nil {
				t.Fatal(err)
			}
			cookie := mcpSessionCookie(app, externalID)
			status := http.StatusUnprocessableEntity
			switch code {
			case "license_changed":
				upstream.license = "Apache-2.0"
			case "license_review_required":
				upstream.archive = githubArchive(t, githubArchiveEntry{"root/README.md", "# Updated", 0}, githubArchiveEntry{"root/LICENSE", "Custom license needs review", 0})
			case "publication_license_mismatch":
				if err := app.setAgentRepositoryPublicationForOwner(ctx, nil, userID, before.WorkspaceID, before.Revision, "Apache-2.0", false, nil); err != nil {
					t.Fatal(err)
				}
			case "repository_identity_mismatch":
				upstream.repositoryID++
				status = http.StatusConflict
			}
			saved, err := app.loadPublicAgentRepository(ctx, before.WorkspaceID, nil)
			if err != nil {
				t.Fatal(err)
			}
			base := fmt.Sprintf("/api/agent/repositories/%d", before.WorkspaceID)
			var failure struct {
				Code string `json:"code"`
			}
			decodeJSONResponse(t, callRepositoryAPI(t, app, cookie, http.MethodPost, base+"/sync", "", status), &failure)
			if failure.Code != code {
				t.Fatalf("manual sync lost its reason: %+v", failure)
			}
			for _, viewer := range []*http.Cookie{nil, cookie} {
				var prepared struct {
					Repository agentRepositoryPublication `json:"repository"`
					Sync       SystemRepositorySyncResult `json:"sync"`
				}
				decodeJSONResponse(t, callRepositoryAPI(t, app, viewer, http.MethodPost, base+"/sync?recheck=false", "", http.StatusOK), &prepared)
				if prepared.Sync.Status != "skipped" || prepared.Sync.Code != code || prepared.Repository.Revision != saved.Revision || prepared.Repository.PublicationID != saved.PublicationID || prepared.Repository.License != saved.License {
					t.Fatalf("preparation failed to preserve the rejected snapshot: %+v", prepared)
				}
				requestID, _ := randomUUID()
				body := fmt.Sprintf(`{"expectedRevision":%d,"expectedPublication":%q,"requestId":%q,"method":"agent","refresh":false}`, saved.Revision, saved.PublicationID, requestID)
				callRepositoryAPI(t, app, viewer, http.MethodPost, base+"/clone", body, http.StatusOK)
			}
			requestID, _ := randomUUID()
			body := fmt.Sprintf(`{"expectedRevision":%d,"expectedPublication":%q,"requestId":%q,"refresh":false}`, saved.Revision, saved.PublicationID, requestID)
			callRepositoryAPI(t, app, cookie, http.MethodPost, base+"/fork", body, http.StatusCreated)
			// API callers that let Fork/Clone prepare the source get the same fallback.
			requestID, _ = randomUUID()
			body = fmt.Sprintf(`{"expectedRevision":%d,"expectedPublication":%q,"requestId":%q,"method":"zip"}`, saved.Revision, saved.PublicationID, requestID)
			callRepositoryAPI(t, app, nil, http.MethodPost, base+"/clone", body, http.StatusOK)
			requestID, _ = randomUUID()
			body = fmt.Sprintf(`{"expectedRevision":%d,"expectedPublication":%q,"requestId":%q}`, saved.Revision, saved.PublicationID, requestID)
			callRepositoryAPI(t, app, cookie, http.MethodPost, base+"/fork", body, http.StatusCreated)
			if err = app.setAgentRepositoryPublicationForOwner(ctx, nil, userID, before.WorkspaceID, before.Revision, "", true, nil); err != nil {
				t.Fatal(err)
			}
			callRepositoryAPI(t, app, nil, http.MethodPost, base+"/sync?recheck=false", "", http.StatusNotFound)
		})
	}
}

func TestPreparedPublicRepositoryActionsRejectSameRevisionRepublication(t *testing.T) {
	for _, license := range []string{"MIT", "Apache-2.0"} {
		t.Run(license, func(t *testing.T) {
			app, before, userID, _, upstream := seedSystemRepositorySync(t, false)
			allowAnonymousRepositorySyncFixture(app)
			upstream.sha = githubTestSHA
			ctx := context.Background()
			if err := app.setAgentWorkspaceEnabled(ctx, userID, true); err != nil {
				t.Fatal(err)
			}
			var externalID string
			if err := app.db.QueryRow(ctx, `SELECT auth_user_id FROM users WHERE id=$1`, userID).Scan(&externalID); err != nil {
				t.Fatal(err)
			}
			cookie := mcpSessionCookie(app, externalID)
			base := fmt.Sprintf("/api/agent/repositories/%d", before.WorkspaceID)
			var prepared struct {
				Repository agentRepositoryPublication `json:"repository"`
			}
			decodeJSONResponse(t, callRepositoryAPI(t, app, nil, http.MethodPost, base+"/sync?recheck=false", "", http.StatusOK), &prepared)
			saved := prepared.Repository
			cloneID, _ := randomUUID()
			cloneBody := fmt.Sprintf(`{"expectedRevision":%d,"expectedPublication":%q,"requestId":%q,"method":"agent","refresh":false}`, saved.Revision, saved.PublicationID, cloneID)
			callRepositoryAPI(t, app, nil, http.MethodPost, base+"/clone", cloneBody, http.StatusOK)
			forkID, _ := randomUUID()
			forkBody := fmt.Sprintf(`{"expectedRevision":%d,"expectedPublication":%q,"requestId":%q,"refresh":false}`, saved.Revision, saved.PublicationID, forkID)
			var forked struct {
				Workspace agentWorkspaceView `json:"workspace"`
			}
			decodeJSONResponse(t, callRepositoryAPI(t, app, cookie, http.MethodPost, base+"/fork", forkBody, http.StatusCreated), &forked)
			if err := app.setAgentRepositoryPublicationForOwner(ctx, nil, userID, before.WorkspaceID, before.Revision, license, false, nil); err != nil {
				t.Fatal(err)
			}
			current, err := app.loadPublicAgentRepository(ctx, before.WorkspaceID, nil)
			if err != nil || current.Revision != saved.Revision || current.PublicationID == saved.PublicationID || current.PublicationID == "" {
				t.Fatalf("same-revision republication has no distinct ID: %+v %v", current, err)
			}
			// An already counted Clone must not reopen a replaced publication.
			callRepositoryAPI(t, app, nil, http.MethodPost, base+"/clone", cloneBody, http.StatusConflict)
			newCloneID, _ := randomUUID()
			callRepositoryAPI(t, app, nil, http.MethodPost, base+"/clone", fmt.Sprintf(`{"expectedRevision":%d,"expectedPublication":%q,"requestId":%q,"method":"agent","refresh":false}`, saved.Revision, saved.PublicationID, newCloneID), http.StatusConflict)
			newForkID, _ := randomUUID()
			callRepositoryAPI(t, app, cookie, http.MethodPost, base+"/fork", fmt.Sprintf(`{"expectedRevision":%d,"expectedPublication":%q,"requestId":%q,"refresh":false}`, saved.Revision, saved.PublicationID, newForkID), http.StatusConflict)
			// Exercise the transaction's own guard, independently of HTTP preflight.
			_, err = app.forkAgentRepositorySnapshot(ctx, userID, before.WorkspaceID, saved.Revision, newForkID, saved.PublicationID)
			if !errors.Is(err, errAgentWorkspaceConflict) {
				t.Fatalf("Fork transaction accepted a replaced publication: %v", err)
			}
			tx, err := app.db.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			_, err = lockPublicAgentRepository(ctx, tx, before.WorkspaceID, saved.PublicationID)
			_ = tx.Rollback(ctx)
			if !errors.Is(err, errAgentWorkspaceConflict) {
				t.Fatalf("Clone transaction accepted a replaced publication: %v", err)
			}
			// Committed Forks retain their original private copy when replayed.
			var replay struct {
				Workspace agentWorkspaceView `json:"workspace"`
			}
			decodeJSONResponse(t, callRepositoryAPI(t, app, cookie, http.MethodPost, base+"/fork", forkBody, http.StatusCreated), &replay)
			if replay.Workspace.WorkspaceID != forked.Workspace.WorkspaceID {
				t.Fatal("Fork replay created another workspace")
			}
			manifest, _ := url.Parse(saved.ManifestURL)
			callRepositoryAPI(t, app, nil, http.MethodGet, manifest.RequestURI(), "", http.StatusConflict)
			fileURL := fmt.Sprintf("%s/files/%d?revision=%d&publication=%s", base, saved.Files[0].FileID, saved.Revision, url.QueryEscape(saved.PublicationID))
			callRepositoryAPI(t, app, nil, http.MethodGet, fileURL, "", http.StatusConflict)
			manifest, _ = url.Parse(current.ManifestURL)
			callRepositoryAPI(t, app, nil, http.MethodGet, manifest.RequestURI(), "", http.StatusOK)
			fileURL = fmt.Sprintf("%s/files/%d?revision=%d&publication=%s", base, current.Files[0].FileID, current.Revision, url.QueryEscape(current.PublicationID))
			callRepositoryAPI(t, app, nil, http.MethodGet, fileURL, "", http.StatusOK)
			callRepositoryAPI(t, app, nil, http.MethodPost, base+"/clone", fmt.Sprintf(`{"expectedRevision":%d,"expectedPublication":%q,"requestId":%q,"method":"agent","refresh":false}`, current.Revision, current.PublicationID, newCloneID), http.StatusOK)
			decodeJSONResponse(t, callRepositoryAPI(t, app, cookie, http.MethodPost, base+"/fork", fmt.Sprintf(`{"expectedRevision":%d,"expectedPublication":%q,"requestId":%q,"refresh":false}`, current.Revision, current.PublicationID, newForkID), http.StatusCreated), &forked)
			var actualLicense string
			if err = app.db.QueryRow(ctx, `SELECT source_license FROM agent_repository_forks WHERE workspace_id=$1`, forked.Workspace.WorkspaceID).Scan(&actualLicense); err != nil || actualLicense != license {
				t.Fatalf("new Fork license=%q want=%q: %v", actualLicense, license, err)
			}
		})
	}
}
