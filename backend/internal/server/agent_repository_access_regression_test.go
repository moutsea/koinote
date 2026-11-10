package server

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

func TestPublicRepositoryRefreshVisibilityRaceKeepsSavedSnapshot(t *testing.T) {
	for _, personal := range []bool{false, true} {
		for _, stage := range []string{"commit", "archive"} {
			t.Run(fmt.Sprintf("personal=%t/%s", personal, stage), func(t *testing.T) {
				var app *App
				var saved agentWorkspaceView
				var upstream *githubSyncFixture
				if personal {
					app, saved, _, upstream = seedPersonalGitHubRepository(t)
				} else {
					app, saved, _, _, upstream = seedSystemRepositorySync(t, stage == "archive")
				}
				ctx := context.Background()
				before, err := app.loadPublicAgentRepository(ctx, saved.WorkspaceID, nil)
				if err != nil {
					t.Fatal(err)
				}
				transport := app.githubHTTPClient.Transport
				var blocked int
				app.githubHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
					archive := githubArchiveTestRequest(r)
					if stage == "commit" && strings.Contains(r.URL.Path, "/commits/") || stage == "archive" && archive {
						// Metadata was public, but the resolved commit now belongs to
						// a private source that the supplied token can still read.
						upstream.private = true
						upstream.archive = githubArchive(t, githubArchiveEntry{"root/README.md", "# Private unpublished skill", 0})
					}
					if archive {
						if r.Header.Get("Authorization") != "" {
							t.Error("public snapshot downloaded bytes with a privileged token")
						} else if upstream.private {
							blocked++
							return &http.Response{StatusCode: http.StatusNotFound, Header: make(http.Header), Body: http.NoBody, Request: r}, nil
						}
					}
					return transport.RoundTrip(r)
				})}
				if !personal && stage == "archive" {
					summary, results, syncErr := runSystemRepositorySync(t, app, saved.WorkspaceID, true)
					if syncErr == nil || summary.Failed != 1 || len(results) != 1 || results[0].Code != "github_download_failed" {
						t.Fatalf("maintenance accepted private bytes: %+v %+v %v", summary, results, syncErr)
					}
				} else {
					_, _, syncErr := app.refreshPublicAgentRepository(ctx, saved.WorkspaceID, "sync-test-token", true)
					if !errors.Is(syncErr, errAgentGitHubDownloadFailed) {
						t.Fatalf("interactive refresh accepted private bytes: %v", syncErr)
					}
				}
				after, err := app.loadPublicAgentRepository(ctx, saved.WorkspaceID, nil)
				if err != nil || blocked != 1 || !reflect.DeepEqual(before, after) {
					t.Fatalf("visibility race changed the saved publication: blocked=%d err=%v", blocked, err)
				}
				live := mustSyncSnapshot(t, app, saved.WorkspaceID)
				if live.revision != saved.Revision || live.source.CommitSHA != githubTestSHA || live.source.UpstreamStatus != "" {
					t.Fatalf("visibility race changed the workspace: %+v", live)
				}
				for _, file := range after.Files {
					if file.Path == "README.md" {
						path := fmt.Sprintf("/api/agent/repositories/%d/files/%d?revision=%d", saved.WorkspaceID, file.FileID, saved.Revision)
						var response struct {
							File agentWorkspaceFileContentView `json:"file"`
						}
						decodeJSONResponse(t, callRepositoryAPI(t, app, nil, http.MethodGet, path, "", http.StatusOK), &response)
						content, decodeErr := base64.StdEncoding.DecodeString(response.File.ContentBase64)
						if decodeErr != nil || string(content) != "# Original" {
							t.Fatalf("private contents reached the public file endpoint: %q %v", content, decodeErr)
						}
					}
				}
			})
		}
	}
}

func TestPersonalRepositoryUnpublishedPrivateRefreshRetainsOwnerAccess(t *testing.T) {
	app, saved, owner, upstream := seedPersonalGitHubRepository(t)
	ctx := context.Background()
	if err := app.setAgentRepositoryPublicationForOwner(ctx, &owner, owner, saved.WorkspaceID, saved.Revision, "", true, nil); err != nil {
		t.Fatal(err)
	}
	upstream.private = true
	result, err := app.refreshAgentRepository(ctx, mustSyncSnapshot(t, app, saved.WorkspaceID), agentRepositoryRefreshOptions{Apply: true, GitHubToken: "sync-test-token"})
	if err != nil || result.Status != "updated" || upstream.archives != 1 {
		t.Fatalf("unpublished owner refresh lost private access: %+v %v", result, err)
	}
	current := mustSyncSnapshot(t, app, saved.WorkspaceID)
	if !current.source.Private || current.source.CommitSHA != personalSyncSHA || current.publishedRevision != nil {
		t.Fatalf("private refresh changed publication state: %+v", current)
	}
}

func TestSystemRepositoryDiscoveryVisibilityRaceCannotPublishPrivateBytes(t *testing.T) {
	app, _, fixture := newDiscoveryFixture(t, 1)
	transport := app.githubHTTPClient.Transport
	private, blocked := false, false
	app.githubHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if strings.Contains(r.URL.Path, "/commits/") {
			private = true
			fixture.archives[fixture.items[0].ID] = githubArchive(t,
				githubArchiveEntry{"root/LICENSE", discoveryMIT, 0},
				githubArchiveEntry{"root/SKILL.md", "# Private unpublished skill", 0})
		}
		if private && githubArchiveTestRequest(r) {
			if r.Header.Get("Authorization") != "" {
				t.Error("automatic discovery fetched potentially private bytes with a token")
			} else {
				blocked = true
				return &http.Response{StatusCode: http.StatusNotFound, Header: make(http.Header), Body: http.NoBody, Request: r}, nil
			}
		}
		return transport.RoundTrip(r)
	})}
	summary, results, err := runDiscovery(app, true)
	if !blocked || err == nil || summary.Added != 0 || summary.Failed != 1 || len(results) != 1 || results[0].Code != "github_download_failed" {
		t.Fatalf("automatic discovery accepted private bytes: blocked=%t summary=%+v results=%+v err=%v", blocked, summary, results, err)
	}
	var count int
	if err = app.db.QueryRow(context.Background(), `SELECT count(*) FROM agent_workspaces WHERE github_source->>'repositoryId'=$1`, fmt.Sprint(fixture.items[0].ID)).Scan(&count); err != nil || count != 0 {
		t.Fatalf("private discovery wrote a workspace: count=%d err=%v", count, err)
	}
}

func TestPublicRepositoryUnreadableCredentialUsesAnonymousAccess(t *testing.T) {
	for _, recheck := range []bool{false, true} {
		for _, changed := range []bool{false, true} {
			t.Run(fmt.Sprintf("recheck=%t/changed=%t", recheck, changed), func(t *testing.T) {
				app, saved, owner, _, upstream := seedSystemRepositorySync(t, false)
				ctx := context.Background()
				if !changed {
					upstream.sha = githubTestSHA
				}
				cookie := seedUnreadableRepositoryCredential(t, app, owner)
				if err := app.setAgentWorkspaceEnabled(ctx, owner, true); err != nil {
					t.Fatal(err)
				}
				transport := app.githubHTTPClient.Transport
				var requests int
				app.githubHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
					requests++
					if r.Header.Get("Authorization") != "" {
						t.Error("unreadable credential fallback was not anonymous")
					}
					request := r.Clone(r.Context())
					if request.URL.Host != githubCodeLoadHost {
						request.Header.Set("Authorization", "Bearer sync-test-token")
					}
					return transport.RoundTrip(request)
				})}
				base := fmt.Sprintf("/api/agent/repositories/%d", saved.WorkspaceID)
				var response struct {
					Repository agentRepositoryPublication `json:"repository"`
					Sync       SystemRepositorySyncResult `json:"sync"`
				}
				decodeJSONResponse(t, callRepositoryAPI(t, app, cookie, http.MethodPost, fmt.Sprintf("%s/sync?recheck=%t", base, recheck), "", http.StatusOK), &response)
				wantStatus, wantRequests := "unchanged", 2
				if changed {
					wantStatus, wantRequests = "updated", 3
				}
				if response.Sync.Status != wantStatus || response.Sync.WarningCode != "github_credential_unavailable" || requests != wantRequests {
					t.Fatalf("fallback lost refresh result or warning: %+v requests=%d", response.Sync, requests)
				}
				// Direct API actions also perform preparation without requiring the
				// client to opt out of refresh, for both Fork and Clone.
				for _, action := range []string{"clone", "fork"} {
					requestID, _ := randomUUID()
					body := fmt.Sprintf(`{"expectedRevision":%d,"expectedPublication":%q,"requestId":%q,"method":"agent"}`, response.Repository.Revision, response.Repository.PublicationID, requestID)
					status := http.StatusOK
					if action == "fork" {
						body = fmt.Sprintf(`{"expectedRevision":%d,"expectedPublication":%q,"requestId":%q}`, response.Repository.Revision, response.Repository.PublicationID, requestID)
						status = http.StatusCreated
					}
					callRepositoryAPI(t, app, cookie, http.MethodPost, base+"/"+action, body, status)
				}
				response.Sync = SystemRepositorySyncResult{}
				decodeJSONResponse(t, callRepositoryAPI(t, app, nil, http.MethodPost, base+"/sync?recheck=false", "", http.StatusOK), &response)
				if response.Sync.WarningCode != "" {
					t.Fatal("a viewer's credential warning leaked to an anonymous caller")
				}
			})
		}
	}
}

func seedUnreadableRepositoryCredential(t *testing.T, app *App, owner int) *http.Cookie {
	t.Helper()
	ctx := context.Background()
	ciphertext, err := app.encryptGitHubToken(owner, "sync-test-token")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = app.db.Exec(ctx, `INSERT INTO agent_github_credentials(user_id,token_ciphertext) VALUES($1,$2)`, owner, ciphertext); err != nil {
		t.Fatal(err)
	}
	app.cfg.MCPTokenEncryptionKey = "rotated-repository-regression-key"
	var externalID string
	if err = app.db.QueryRow(ctx, `SELECT auth_user_id FROM users WHERE id=$1`, owner).Scan(&externalID); err != nil {
		t.Fatal(err)
	}
	return mcpSessionCookie(app, externalID)
}

func TestPublicRepositoryUnreadableCredentialDoesNotRetireInaccessibleSource(t *testing.T) {
	for _, status := range []int{http.StatusNotFound, http.StatusTooManyRequests, http.StatusServiceUnavailable} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			app, saved, owner, _, _ := seedSystemRepositorySync(t, false)
			cookie := seedUnreadableRepositoryCredential(t, app, owner)
			var requests int
			app.githubHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				requests++
				if r.Header.Get("Authorization") != "" {
					t.Error("unreadable credential fallback used authentication")
				}
				return &http.Response{StatusCode: status, Header: make(http.Header), Body: http.NoBody, Request: r}, nil
			})}
			wantStatus, wantCode := http.StatusServiceUnavailable, "github_temporarily_unavailable"
			if status == http.StatusNotFound {
				wantCode = "github_credential_unavailable"
			} else if status == http.StatusTooManyRequests {
				wantStatus, wantCode = http.StatusTooManyRequests, "github_rate_limited"
			}
			for _, recheck := range []bool{false, true} {
				path := fmt.Sprintf("/api/agent/repositories/%d/sync?recheck=%t", saved.WorkspaceID, recheck)
				response := callRepositoryAPI(t, app, cookie, http.MethodPost, path, "", wantStatus)
				if !strings.Contains(response.Body.String(), `"code":"`+wantCode+`"`) {
					t.Fatalf("fallback lost actionable error: %s", response.Body.String())
				}
			}
			current := mustSyncSnapshot(t, app, saved.WorkspaceID)
			if requests != 2 || current.source.UpstreamStatus != "" || current.revision != saved.Revision {
				t.Fatalf("fallback retired or changed the saved source: requests=%d snapshot=%+v", requests, current)
			}
		})
	}
}

func TestPublicRepositoryPublicationLicenseMismatchHasSeparateReason(t *testing.T) {
	for _, personal := range []bool{false, true} {
		for _, changed := range []bool{false, true} {
			t.Run(fmt.Sprintf("personal=%t/changed=%t", personal, changed), func(t *testing.T) {
				var app *App
				var saved agentWorkspaceView
				var owner int
				var upstream *githubSyncFixture
				var ownerID *int
				if personal {
					app, saved, owner, upstream = seedPersonalGitHubRepository(t)
					ownerID = &owner
				} else {
					app, saved, owner, _, upstream = seedSystemRepositorySync(t, false)
				}
				if !changed {
					upstream.sha = githubTestSHA
				}
				ctx := context.Background()
				if err := app.setAgentRepositoryPublicationForOwner(ctx, ownerID, owner, saved.WorkspaceID, saved.Revision, "Apache-2.0", false, nil); err != nil {
					t.Fatal(err)
				}
				before, err := app.loadPublicAgentRepository(ctx, saved.WorkspaceID, nil)
				if err != nil {
					t.Fatal(err)
				}
				if !personal {
					summary, results, syncErr := runSystemRepositorySync(t, app, saved.WorkspaceID, true)
					if !errors.Is(syncErr, ErrSystemRepositoriesNeedAttention) || summary.NeedsAttention != 1 || len(results) != 1 || results[0].Code != "publication_license_mismatch" {
						t.Fatalf("maintenance blamed the upstream license: %+v %+v %v", summary, results, syncErr)
					}
				}
				allowAnonymousRepositorySyncFixture(app)
				base := fmt.Sprintf("/api/agent/repositories/%d", saved.WorkspaceID)
				wantStatus := http.StatusOK
				if !personal {
					wantStatus = http.StatusUnprocessableEntity
				}
				manual := callRepositoryAPI(t, app, nil, http.MethodPost, base+"/sync", "", wantStatus)
				if !strings.Contains(manual.Body.String(), `"code":"publication_license_mismatch"`) {
					t.Fatalf("manual sync blamed an unchanged upstream license: %s", manual.Body.String())
				}
				var prepared struct {
					Repository agentRepositoryPublication `json:"repository"`
					Sync       SystemRepositorySyncResult `json:"sync"`
				}
				decodeJSONResponse(t, callRepositoryAPI(t, app, nil, http.MethodPost, base+"/sync?recheck=false", "", http.StatusOK), &prepared)
				if prepared.Sync.Status != "skipped" || prepared.Sync.Code != "publication_license_mismatch" || !reflect.DeepEqual(before, &prepared.Repository) || upstream.archives != 0 {
					t.Fatalf("license mismatch lost saved publication or downloaded new bytes: %+v", prepared)
				}
				requestID, _ := randomUUID()
				body := fmt.Sprintf(`{"expectedRevision":%d,"expectedPublication":%q,"requestId":%q,"method":"agent"}`, saved.Revision, before.PublicationID, requestID)
				callRepositoryAPI(t, app, nil, http.MethodPost, base+"/clone", body, http.StatusOK)
			})
		}
	}
}
