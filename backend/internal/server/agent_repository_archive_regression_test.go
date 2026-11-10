package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strings"
	"testing"
)

func seedRepositoryArchiveCredential(t *testing.T, app *App, owner int) *http.Cookie {
	t.Helper()
	ctx := context.Background()
	ciphertext, err := app.encryptGitHubToken(owner, "sync-test-token")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = app.db.Exec(ctx, `INSERT INTO agent_github_credentials(user_id,token_ciphertext) VALUES($1,$2)`, owner, ciphertext); err != nil {
		t.Fatal(err)
	}
	var externalID string
	if err = app.db.QueryRow(ctx, `SELECT auth_user_id FROM users WHERE id=$1`, owner).Scan(&externalID); err != nil {
		t.Fatal(err)
	}
	return mcpSessionCookie(app, externalID)
}

func TestPublicRepositoryArchiveDoesNotUseAnonymousRESTQuota(t *testing.T) {
	app, saved, owner, _, _ := seedSystemRepositorySync(t, false)
	cookie := seedRepositoryArchiveCredential(t, app, owner)
	ctx := context.Background()
	if err := app.setAgentWorkspaceEnabled(ctx, owner, true); err != nil {
		t.Fatal(err)
	}
	transport := app.githubHTTPClient.Transport
	var anonymousREST, archives int
	app.githubHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host == "api.github.com" && r.Header.Get("Authorization") == "" {
			anonymousREST++
			header := make(http.Header)
			header.Set("X-RateLimit-Remaining", "0")
			return &http.Response{StatusCode: http.StatusForbidden, Header: header, Body: http.NoBody, Request: r}, nil
		}
		if r.URL.Host == githubCodeLoadHost {
			archives++
			if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" || r.URL.RawQuery != "" || !strings.HasSuffix(r.URL.Path, "/zip/"+githubSyncTestSHA) {
				t.Fatalf("public archive is not pinned and anonymous: %s", r.URL)
			}
		}
		return transport.RoundTrip(r)
	})}
	base := fmt.Sprintf("/api/agent/repositories/%d", saved.WorkspaceID)
	var prepared struct {
		Repository agentRepositoryPublication `json:"repository"`
		Sync       SystemRepositorySyncResult `json:"sync"`
	}
	decodeJSONResponse(t, callRepositoryAPI(t, app, cookie, http.MethodPost, base+"/sync?recheck=false", "", http.StatusOK), &prepared)
	if prepared.Sync.Status != "updated" || prepared.Repository.GitHubSource.CommitSHA != githubSyncTestSHA {
		t.Fatalf("anonymous REST quota blocked authenticated preparation: %+v", prepared)
	}
	for _, action := range []string{"clone", "fork"} {
		requestID, _ := randomUUID()
		body := fmt.Sprintf(`{"expectedRevision":%d,"expectedPublication":%q,"requestId":%q}`, prepared.Repository.Revision, prepared.Repository.PublicationID, requestID)
		status := http.StatusCreated
		if action == "clone" {
			status = http.StatusOK
			body = strings.TrimSuffix(body, "}") + `,"method":"agent"}`
		}
		callRepositoryAPI(t, app, cookie, http.MethodPost, base+"/"+action, body, status)
	}
	if anonymousREST != 0 || archives != 1 {
		t.Fatalf("public archive consumed anonymous REST quota or downloaded twice: REST=%d archives=%d", anonymousREST, archives)
	}
}

func TestPublicRepositoryAnonymousArchiveFailureDoesNotRetryCredentials(t *testing.T) {
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound, http.StatusTooManyRequests, http.StatusServiceUnavailable} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			app, saved, owner, _, _ := seedSystemRepositorySync(t, false)
			cookie := seedRepositoryArchiveCredential(t, app, owner)
			transport := app.githubHTTPClient.Transport
			var authenticated, archives int
			app.githubHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				if r.URL.Host == githubCodeLoadHost {
					archives++
					if r.Header.Get("Authorization") != "" {
						t.Fatal("public archive carried a credential")
					}
					return &http.Response{StatusCode: status, Header: make(http.Header), Body: http.NoBody, Request: r}, nil
				}
				if r.Header.Get("Authorization") != "Bearer sync-test-token" {
					t.Fatal("anonymous archive rejection triggered another metadata/commit resolution")
				}
				authenticated++
				return transport.RoundTrip(r)
			})}
			wantStatus, wantCode := http.StatusServiceUnavailable, "github_temporarily_unavailable"
			if status == http.StatusTooManyRequests {
				wantStatus, wantCode = http.StatusTooManyRequests, "github_rate_limited"
			}
			path := fmt.Sprintf("/api/agent/repositories/%d/sync", saved.WorkspaceID)
			response := callRepositoryAPI(t, app, cookie, http.MethodPost, path, "", wantStatus)
			if !strings.Contains(response.Body.String(), `"code":"`+wantCode+`"`) || authenticated != 2 || archives != 1 {
				t.Fatalf("anonymous failure changed token guidance or repeated requests: auth=%d archives=%d response=%s", authenticated, archives, response.Body.String())
			}
			current := mustSyncSnapshot(t, app, saved.WorkspaceID)
			if current.revision != saved.Revision || current.source.UpstreamStatus != "" {
				t.Fatalf("archive failure changed the saved snapshot: %+v", current)
			}
		})
	}
}

func TestGitHubPublicImportArchiveDenialDoesNotRetryToken(t *testing.T) {
	fixture := &githubSyncFixture{repositoryID: 123, sha: githubTestSHA, license: "MIT"}
	transport := fixture.client(t).Transport
	var requests int
	app := &App{githubHTTPClient: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		requests++
		if r.URL.Host == githubCodeLoadHost {
			return &http.Response{StatusCode: http.StatusForbidden, Header: make(http.Header), Body: http.NoBody, Request: r}, nil
		}
		return transport.RoundTrip(r)
	})}}
	_, files, _, err := app.fetchGitHubRepository(context.Background(), "Octo", "demo", "", "sync-test-token", true)
	if !errors.Is(err, errAgentGitHubDownloadFailed) || len(files) != 0 || requests != 3 {
		t.Fatalf("public import retried an anonymous archive rejection: requests=%d files=%d err=%v", requests, len(files), err)
	}
}

func TestGitHubPublicArchiveRequestRejectsCredentialsAndRedirects(t *testing.T) {
	archiveURL := "https://codeload.github.com/Octo/demo/zip/" + githubTestSHA
	jar, _ := cookiejar.New(nil)
	parsed, _ := url.Parse(archiveURL)
	jar.SetCookies(parsed, []*http.Cookie{{Name: "private_session", Value: "must-not-be-sent"}})
	var requests int
	app := &App{githubHTTPClient: &http.Client{Jar: jar, Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		requests++
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Fatal("public proof received credentials")
		}
		header := make(http.Header)
		header.Set("Location", archiveURL+"?token=must-not-follow")
		return &http.Response{StatusCode: http.StatusFound, Header: header, Body: http.NoBody, Request: r}, nil
	})}}
	for _, input := range []struct{ endpoint, token string }{
		{archiveURL, "must-not-be-sent"},
		{archiveURL + "?token=must-not-be-sent", ""},
		{archiveURL + "?", ""},
		{"https://codeload.github.com/Octo/demo/zip/main", ""},
		{"https://codeload.github.com/../demo/zip/" + githubTestSHA, ""},
		{"https://codeload.github.com.evil.example/Octo/demo/zip/" + githubTestSHA, ""},
	} {
		if _, err := app.githubRequest(context.Background(), input.endpoint, input.token, "application/zip"); !errors.Is(err, errAgentGitHubRepositoryInvalid) || requests != 0 {
			t.Fatalf("unsafe public URL accepted: %s requests=%d err=%v", input.endpoint, requests, err)
		}
	}
	response, err := app.githubRequest(context.Background(), archiveURL, "", "application/zip")
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	if err == nil || requests != 1 {
		t.Fatalf("public archive followed a signed redirect: requests=%d err=%v", requests, err)
	}
}
