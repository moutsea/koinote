package server

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

type githubArchiveReadFailure struct{ err error }

func (r githubArchiveReadFailure) Read([]byte) (int, error) { return 0, r.err }

func TestGitHubArchiveReadErrorsRemainRetryable(t *testing.T) {
	for _, failure := range []error{io.ErrUnexpectedEOF, context.DeadlineExceeded, errors.New("connection reset: https://example.test/zip?token=fixture-secret")} {
		t.Run(failure.Error(), func(t *testing.T) {
			app := &App{githubHTTPClient: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: 200, Header: make(http.Header), Request: r,
					Body: io.NopCloser(io.MultiReader(strings.NewReader("PK"), githubArchiveReadFailure{failure}))}, nil
			})}}
			_, err := app.downloadGitHubRepository(context.Background(), "Octo", "demo", githubTestSHA, "test-token")
			if !errors.Is(err, errAgentGitHubDownloadFailed) || errors.Is(err, errAgentGitHubArchiveInvalid) || systemRepositorySyncErrorCode(err) != "github_download_failed" {
				t.Fatalf("transport error lost its retryable classification: %v", err)
			}
			response := httptest.NewRecorder()
			writeAgentWorkspaceError(response, err)
			if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), `"code":"github_repository_unavailable"`) || strings.Contains(response.Body.String(), "fixture-secret") {
				t.Fatalf("unexpected user-facing download error: %d %s", response.Code, response.Body.String())
			}
		})
	}
}

func TestSystemRepositoryDiscoveryRetriesInterruptedDownloads(t *testing.T) {
	for _, scenario := range []string{"connection reset", "short response", "timeout", "invalid archive"} {
		t.Run(scenario, func(t *testing.T) {
			app, _, f := newDiscoveryFixture(t, 2)
			first := f.items[1] // Most stars; ensure a failure doesn't block the next item.
			original := app.githubHTTPClient
			app.githubHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				res, err := original.Transport.RoundTrip(r)
				if err == nil && strings.HasPrefix(r.URL.Path, "/repos/"+first.FullName+"/zipball/") {
					res.Body.Close()
					failure := errors.New("connection reset by peer")
					if scenario == "short response" {
						failure = io.ErrUnexpectedEOF
					} else if scenario == "timeout" {
						failure = context.DeadlineExceeded
					}
					res.Body = io.NopCloser(io.MultiReader(strings.NewReader("PK"), githubArchiveReadFailure{failure}))
					if scenario == "invalid archive" {
						res.Body = io.NopCloser(strings.NewReader("not a zip file"))
					}
				}
				return res, err
			})}
			summary, results, err := runDiscovery(app, true)
			invalid := scenario == "invalid archive"
			if summary.Added != 1 || len(results) != 2 || (err == nil) != invalid {
				t.Fatalf("batch didn't continue correctly: %+v %+v %v", summary, results, err)
			}
			if invalid {
				if summary.Skipped != 1 || results[0].Code != "archive_rejected" {
					t.Fatalf("invalid archive lost its policy rejection: %+v %+v", summary, results)
				}
			} else if summary.Failed != 1 || results[0].Status != "failed" || results[0].Code != "github_download_failed" {
				t.Fatalf("network failure reported as success: %+v %+v", summary, results)
			}
			var delayed bool
			if err = app.db.QueryRow(context.Background(), `SELECT EXISTS(SELECT 1 FROM agent_repository_discoveries WHERE github_id=$1 AND retry_after>now()+interval '6 days')`, first.ID).Scan(&delayed); err != nil || delayed != invalid {
				t.Fatalf("incorrect cooldown: delayed=%t %v", delayed, err)
			}
			app.githubHTTPClient = original
			summary, _, err = runDiscovery(app, true)
			wantAdded := 1
			if invalid {
				wantAdded = 0
			}
			if err != nil || summary.Added != wantAdded || summary.AlreadyAdded != 1 {
				t.Fatalf("retry after network recovery: %+v %v", summary, err)
			}
		})
	}
}

func TestSystemRepositorySyncSourceOnlyChange(t *testing.T) {
	for _, scenario := range []string{"published", "preview", "withdrawn"} {
		t.Run(scenario, func(t *testing.T) {
			app, w, admin, objects, upstream := seedSystemRepositorySync(t, true)
			ctx := context.Background()
			if scenario == "withdrawn" {
				if err := app.setAgentRepositoryPublicationForOwner(ctx, nil, admin, w.WorkspaceID, w.Revision, "MIT", true, nil); err != nil {
					t.Fatal(err)
				}
			}
			before, err := loadAgentWorkspaceForOwner(ctx, app.db, nil, w.WorkspaceID)
			if err != nil {
				t.Fatal(err)
			}
			var publishedAt, publicFiles, commits string
			if err = app.db.QueryRow(ctx, `SELECT
 COALESCE((SELECT published_at::text FROM agent_repository_publications WHERE workspace_id=$1),''),
 (SELECT COALESCE(jsonb_agg(f ORDER BY path),'[]')::text FROM agent_repository_publication_files f WHERE workspace_id=$1),
 (SELECT COALESCE(jsonb_agg(c ORDER BY revision),'[]')::text FROM agent_workspace_commits c WHERE workspace_id=$1)`, w.WorkspaceID).Scan(&publishedAt, &publicFiles, &commits); err != nil {
				t.Fatal(err)
			}
			objects.mu.Lock()
			puts, reads := objects.puts, objects.reads
			objects.mu.Unlock()
			upstream.fullName, upstream.sha = "NewOwner/renamed", githubTestSHA
			summary, results, err := runSystemRepositorySync(t, app, w.WorkspaceID, scenario != "preview")
			if err != nil || len(results) != 1 || results[0].Code != "source_updated" || (scenario == "preview" && summary.WouldUpdate != 1) || (scenario != "preview" && summary.Updated != 1) {
				t.Fatalf("source update: %+v %+v %v", summary, results, err)
			}
			current, err := loadAgentWorkspaceForOwner(ctx, app.db, nil, w.WorkspaceID)
			if err != nil {
				t.Fatal(err)
			}
			wantSource := *before.GitHubSource
			wantEvents := 0
			if scenario != "preview" {
				wantSource.RepositoryURL, wantSource.Author, wantSource.AuthorURL = "https://github.com/NewOwner/renamed", "NewOwner", "https://github.com/NewOwner"
				wantEvents = 1
			}
			if !reflect.DeepEqual(current.GitHubSource, &wantSource) || current.Revision != before.Revision || !reflect.DeepEqual(current.Files, before.Files) || current.Name != before.Name || current.Description != before.Description || current.Category != before.Category {
				t.Fatalf("source update altered snapshot/metadata: before=%+v after=%+v", before, current)
			}
			var afterPublishedAt, afterPublicFiles, afterCommits string
			var events int
			if err = app.db.QueryRow(ctx, `SELECT
 COALESCE((SELECT published_at::text FROM agent_repository_publications WHERE workspace_id=$1),''),
 (SELECT COALESCE(jsonb_agg(f ORDER BY path),'[]')::text FROM agent_repository_publication_files f WHERE workspace_id=$1),
 (SELECT COALESCE(jsonb_agg(c ORDER BY revision),'[]')::text FROM agent_workspace_commits c WHERE workspace_id=$1),
 (SELECT count(*) FROM agent_repository_system_events WHERE workspace_id=$1 AND action='sync' AND actor_user_id IS NULL)`, w.WorkspaceID).Scan(&afterPublishedAt, &afterPublicFiles, &afterCommits, &events); err != nil || afterPublishedAt != publishedAt || afterPublicFiles != publicFiles || afterCommits != commits || events != wantEvents {
				t.Fatalf("unexpected publication/history/audit change: events=%d %v", events, err)
			}
			objects.mu.Lock()
			transferred := objects.puts != puts || objects.reads != reads
			objects.mu.Unlock()
			if upstream.archives != 0 || transferred {
				t.Fatal("source-only update transferred repository contents")
			}
			public, err := app.loadPublicAgentRepository(ctx, w.WorkspaceID, nil)
			if scenario == "withdrawn" {
				if !errors.Is(err, errAgentWorkspaceNotFound) {
					t.Fatal("source update republished a withdrawn repository")
				}
			} else if err != nil || !reflect.DeepEqual(public.GitHubSource, &wantSource) || public.Revision != w.Revision {
				t.Fatalf("public provenance not preserved/updated: %+v %v", public, err)
			}
			if scenario == "preview" {
				return
			}
			summary, _, err = runSystemRepositorySync(t, app, w.WorkspaceID, true)
			if err != nil || summary.Unchanged != 1 {
				t.Fatalf("rename retry wasn't idempotent: %+v %v", summary, err)
			}
			// The old URL is now reused by a different GitHub repository. A new
			// upstream commit must still be fetched from the saved canonical URL.
			upstream.sha = githubSyncTestSHA
			original := app.githubHTTPClient
			old := *upstream
			old.repositoryID++
			old.fullName = "Octo/demo"
			oldClient, oldRequests := old.client(t), 0
			app.githubHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				if strings.HasPrefix(r.URL.Path, "/repos/Octo/") {
					oldRequests++
					return oldClient.Transport.RoundTrip(r)
				}
				return original.Transport.RoundTrip(r)
			})}
			summary, _, err = runSystemRepositorySync(t, app, w.WorkspaceID, true)
			if err != nil || summary.Updated != 1 || oldRequests != 0 {
				t.Fatalf("old URL reuse blocked the next content update: %+v oldRequests=%d %v", summary, oldRequests, err)
			}
		})
	}
}

func TestSystemRepositorySyncSourceChangePreservesAdminActions(t *testing.T) {
	for _, scenario := range []string{"withdraw", "republish", "revision"} {
		t.Run(scenario, func(t *testing.T) {
			app, w, admin, _, upstream := seedSystemRepositorySync(t, true)
			upstream.fullName, upstream.sha = "NewOwner/renamed", githubTestSHA
			ctx := context.Background()
			original, changed := app.githubHTTPClient, false
			app.githubHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				response, err := original.Transport.RoundTrip(r)
				if !changed && strings.Contains(r.URL.Path, "/commits/") {
					changed = true
					if scenario == "revision" {
						if _, err := app.db.Exec(ctx, `UPDATE agent_workspaces SET revision=revision+1 WHERE id=$1`, w.WorkspaceID); err != nil {
							t.Fatal(err)
						}
					} else {
						if err := app.setAgentRepositoryPublicationForOwner(ctx, nil, admin, w.WorkspaceID, w.Revision, "MIT", true, nil); err != nil {
							t.Fatal(err)
						}
						if scenario == "republish" {
							if err := app.setAgentRepositoryPublicationForOwner(ctx, nil, admin, w.WorkspaceID, w.Revision, "MIT", false, nil); err != nil {
								t.Fatal(err)
							}
						}
					}
				}
				return response, err
			})}
			summary, results, err := runSystemRepositorySync(t, app, w.WorkspaceID, true)
			if err == nil || summary.Failed != 1 || len(results) != 1 || results[0].Code != "repository_changed" {
				t.Fatalf("concurrent admin decision ignored: %+v %+v %v", summary, results, err)
			}
			current, err := loadAgentWorkspaceForOwner(ctx, app.db, nil, w.WorkspaceID)
			if err != nil || !reflect.DeepEqual(current.GitHubSource, w.GitHubSource) || upstream.archives != 0 {
				t.Fatalf("failed source update was partially committed: %+v %v", current, err)
			}
			var events int
			if err = app.db.QueryRow(ctx, `SELECT count(*) FROM agent_repository_system_events WHERE workspace_id=$1 AND action='sync'`, w.WorkspaceID).Scan(&events); err != nil || events != 0 {
				t.Fatalf("failed update left an audit event: %d %v", events, err)
			}
		})
	}
}
