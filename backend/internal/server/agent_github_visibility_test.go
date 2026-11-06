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
// A response that omits "private", or whose "visibility" is anything but
// "public", must never be read as public.
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
		{"public visibility", `,"private":false,"visibility":"public"`, false},
		{"internal visibility", `,"private":false,"visibility":"internal"`, true},
		{"private visibility", `,"private":false,"visibility":"private"`, true},
		{"null visibility", `,"private":false,"visibility":null`, true},
		{"unknown visibility", `,"private":false,"visibility":"Public"`, true},
		{"private with public visibility", `,"private":true,"visibility":"public"`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			body := "{" + base + tc.field + "}"
			// Search results decode through the same type before discovery
			// filters candidates, so the default must hold there too.
			var page struct {
				Items []githubRepositoryMetadata `json:"items"`
			}
			if err := json.Unmarshal([]byte(`{"items":[`+body+`]}`), &page); err != nil || len(page.Items) != 1 || page.Items[0].Private != tc.private || page.Items[0].ID != 123 || page.Items[0].Owner.Login != "Octo" {
				t.Fatalf("decoded %+v err=%v", page.Items, err)
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
