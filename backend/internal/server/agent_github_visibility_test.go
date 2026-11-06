package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

// Automatic publication relies on GitHub stating that a repository is public.
// A response that omits "private" must never be read as public.
func TestGitHubUnstatedVisibilityIsPrivate(t *testing.T) {
	base := `"id":123,"name":"demo","full_name":"Octo/demo","owner":{"login":"Octo"},"default_branch":"main"`
	for _, tc := range []struct {
		name    string
		field   string
		private bool
	}{
		{"unstated", "", true},
		{"null", `,"private":null`, true},
		{"public", `,"private":false`, false},
		{"private", `,"private":true`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := "{" + base + tc.field + "}"
			// Search results decode through the same type before discovery
			// filters candidates, so the default must hold there too.
			var item githubRepositoryMetadata
			if err := json.Unmarshal([]byte(body), &item); err != nil || item.Private != tc.private || item.ID != 123 || item.Owner.Login != "Octo" {
				t.Fatalf("decoded %+v err=%v", item, err)
			}
			for _, publicOnly := range []bool{true, false} {
				calls := 0
				app := &App{githubHTTPClient: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
					calls++
					data := body
					if r.URL.Path == "/repos/Octo/demo/commits/main" {
						data = githubTestSHA
					} else if r.URL.Path != "/repos/Octo/demo" {
						t.Fatalf("unexpected request: %s", r.URL.Path)
					}
					return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(data)), Request: r}, nil
				})}}
				_, source, err := app.resolveGitHubRepository(context.Background(), "Octo", "demo", "", "", publicOnly)
				if publicOnly && tc.private {
					if !errors.Is(err, errAgentGitHubRepositoryInvalid) || source != nil || calls != 1 {
						t.Fatalf("system resolve accepted unconfirmed visibility: calls=%d source=%+v err=%v", calls, source, err)
					}
					continue
				}
				if err != nil || source == nil || source.Private != tc.private || calls != 2 {
					t.Fatalf("publicOnly=%t: calls=%d source=%+v err=%v", publicOnly, calls, source, err)
				}
			}
		})
	}
}
