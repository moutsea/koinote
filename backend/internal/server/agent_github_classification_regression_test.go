package server

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestSystemRepositoryDiscoveryCommitRejectionDoesNotCoolDownCandidate(t *testing.T) {
	for _, status := range []int{400, 404, 410, 422} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			app, _, fixture := newDiscoveryFixture(t, 1)
			original := app.githubHTTPClient.Transport
			app.githubHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				if strings.Contains(r.URL.Path, "/commits/") {
					return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"message":"request rejected"}`)), Request: r}, nil
				}
				return original.RoundTrip(r)
			})}
			summary, results, err := runDiscovery(app, true)
			if err == nil || summary.Failed != 1 || summary.Added != 0 || summary.Skipped != 0 || len(results) != 1 || results[0].Code != "github_request_invalid" {
				t.Fatalf("commit rejection became a permanent skip: summary=%+v results=%+v err=%v", summary, results, err)
			}
			var count int
			if err := app.db.QueryRow(context.Background(), `SELECT count(*) FROM agent_repository_discoveries WHERE github_id=$1`, fixture.items[0].ID).Scan(&count); err != nil || count != 0 {
				t.Fatalf("commit rejection wrote a cooldown: count=%d err=%v", count, err)
			}
			app.githubHTTPClient = &http.Client{Transport: original}
			summary, _, err = runDiscovery(app, true)
			if err != nil || summary.Added != 1 || summary.Failed != 0 {
				t.Fatalf("candidate could not recover on next run: summary=%+v err=%v", summary, err)
			}
		})
	}
}
