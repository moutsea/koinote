package server

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

// Exercise both metadata and archive responses: the latter follows a separate
// download path and must make the same distinction between local/global errors.
func TestSystemRepositoryJobsGitHubAccessFailures(t *testing.T) {
	for _, tc := range []struct {
		name, endpoint, header, value, code string
		status                              int
		stop                                error
	}{
		{"repository forbidden", "metadata", "", "", "github_access_denied", 403, nil},
		{"commit forbidden", "commits", "", "", "github_access_denied", 403, nil},
		{"archive forbidden", "zipball", "", "", "github_access_denied", 403, nil},
		{"invalid credential", "metadata", "", "", "github_credentials_invalid", 401, errAgentGitHubCredentialRequired},
		{"archive invalid credential", "zipball", "", "", "github_credentials_invalid", 401, errAgentGitHubCredentialRequired},
		{"rate limit", "metadata", "", "", "github_rate_limited", 429, errAgentGitHubRateLimited},
		{"primary rate limit", "metadata", "X-RateLimit-Remaining", "0", "github_rate_limited", 403, errAgentGitHubRateLimited},
		{"secondary rate limit", "zipball", "Retry-After", "60", "github_rate_limited", 403, errAgentGitHubRateLimited},
	} {
		block := func(client *http.Client, prefix string) *http.Client {
			return &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				match := r.URL.Path == prefix && tc.endpoint == "metadata"
				if tc.endpoint != "metadata" {
					match = strings.HasPrefix(r.URL.Path, prefix+"/"+tc.endpoint+"/")
				}
				if !match {
					return client.Transport.RoundTrip(r)
				}
				header := make(http.Header)
				if tc.header != "" {
					header.Set(tc.header, tc.value)
				}
				return &http.Response{StatusCode: tc.status, Header: header, Request: r,
					Body: io.NopCloser(strings.NewReader(`{"message":"Resource not accessible by integration"}`))}, nil
			})}
		}
		t.Run("sync/"+tc.name, func(t *testing.T) {
			app, first, _, _, _ := seedSystemRepositorySync(t, false)
			_, second, _, _, next := seedSystemRepositorySync(t, false)
			source := *second.GitHubSource
			source.RepositoryID, source.RepositoryURL = 67890, "https://github.com/Other/demo"
			source.Author, source.AuthorURL = "Other", "https://github.com/Other"
			if _, err := app.db.Exec(context.Background(), `UPDATE agent_workspaces SET github_source=$2 WHERE id=$1`, second.WorkspaceID, source); err != nil {
				t.Fatal(err)
			}
			next.repositoryID, next.fullName = source.RepositoryID, "Other/demo"
			firstClient, nextClient := app.githubHTTPClient, next.client(t)
			routes := &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				if strings.HasPrefix(r.URL.Path, "/repos/Other/") {
					return nextClient.Transport.RoundTrip(r)
				}
				return firstClient.Transport.RoundTrip(r)
			})}
			app.githubHTTPClient = block(routes, "/repos/Octo/demo")
			// Two sweeps catch a cursor repeatedly getting stuck on the same 403.
			for run := 0; run < 2; run++ {
				summary, results, err := runSystemRepositorySync(t, app, 0, true)
				wantProcessed := 2
				if tc.stop != nil {
					wantProcessed = 1
					if !errors.Is(err, tc.stop) {
						t.Fatalf("global failure: %v", err)
					}
				}
				if err == nil || summary.Failed != 1 || summary.Processed != wantProcessed || len(results) != wantProcessed || results[0].WorkspaceID != first.WorkspaceID || results[0].Code != tc.code {
					t.Fatalf("run %d: %+v %+v %v", run, summary, results, err)
				}
				if tc.stop == nil && (results[1].WorkspaceID != second.WorkspaceID || (run == 0 && summary.Updated != 1) || (run == 1 && summary.Unchanged != 1)) {
					t.Fatalf("accessible repository blocked: %+v %+v", summary, results)
				}
				var cursor int64
				if err = app.db.QueryRow(context.Background(), `SELECT last_workspace_id FROM agent_repository_sync_progress WHERE singleton`).Scan(&cursor); err != nil || cursor != 0 || summary.ResumeAfter != 0 {
					t.Fatalf("unexpected progress: %d %+v %v", cursor, summary, err)
				}
			}
			for _, w := range []agentWorkspaceView{first, second} {
				current, err := loadAgentWorkspaceForOwner(context.Background(), app.db, nil, w.WorkspaceID)
				wantSHA := githubTestSHA
				if w.WorkspaceID == second.WorkspaceID && tc.stop == nil {
					wantSHA = githubSyncTestSHA
				}
				if err != nil || current.GitHubSource.CommitSHA != wantSHA {
					t.Fatalf("wrong persisted snapshot: %+v %v", current, err)
				}
			}
		})
		t.Run("discovery/"+tc.name, func(t *testing.T) {
			app, _, f := newDiscoveryFixture(t, 2)
			first := f.items[1] // Higher star count is processed first.
			app.githubHTTPClient = block(app.githubHTTPClient, "/repos/"+first.FullName)
			summary, results, err := runDiscovery(app, true)
			wantChecked, wantAdded := 2, 1
			if tc.stop != nil {
				wantChecked, wantAdded = 1, 0
				if !errors.Is(err, tc.stop) || summary.Outcome != tc.code {
					t.Fatalf("global failure: %+v %v", summary, err)
				}
			}
			if err == nil || summary.Failed != 1 || summary.Checked != wantChecked || summary.Added != wantAdded || len(results) != wantChecked || results[0].Code != tc.code {
				t.Fatalf("discovery: %+v %+v %v", summary, results, err)
			}
			known, err := systemRepositoryDiscoveryKnown(context.Background(), app.db, first.ID, "https://github.com/"+first.FullName)
			if err != nil || known {
				t.Fatalf("access failure must remain retryable: known=%t %v", known, err)
			}
			_, added, err := systemRepositoryDiscoveryBudget(context.Background(), app.db)
			if err != nil || added != wantAdded {
				t.Fatalf("persisted daily budget: %d %v", added, err)
			}
		})
	}
}
