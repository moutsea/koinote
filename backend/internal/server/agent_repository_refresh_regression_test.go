package server

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type refreshReply struct {
	repository *agentRepositoryPublication
	result     SystemRepositorySyncResult
	err        error
}

type refreshWaitContext struct {
	context.Context
	waiting chan struct{}
	once    sync.Once
}

func (c *refreshWaitContext) Done() <-chan struct{} {
	c.once.Do(func() { close(c.waiting) })
	return c.Context.Done()
}

func awaitRefresh[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case value := <-ch:
		return value
	case <-time.After(5 * time.Second):
		t.Fatal("refresh did not reach the expected transition")
		var zero T
		return zero
	}
}

func blockedRefreshFixture(app *App) (<-chan struct{}, func(), *atomic.Int32) {
	transport := app.githubHTTPClient.Transport
	entered := make(chan struct{}, 8)
	release := make(chan struct{})
	var once sync.Once
	var archives atomic.Int32
	var mu sync.Mutex
	app.githubHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if githubArchiveTestRequest(r) {
			archives.Add(1)
			entered <- struct{}{}
			select {
			case <-release:
			case <-r.Context().Done():
				return nil, r.Context().Err()
			}
		}
		request := r.Clone(r.Context())
		if request.URL.Host != githubCodeLoadHost {
			request.Header.Set("Authorization", "Bearer sync-test-token")
		}
		mu.Lock()
		defer mu.Unlock()
		return transport.RoundTrip(request)
	})}
	return entered, func() { once.Do(func() { close(release) }) }, &archives
}

func startViewerRefresh(app *App, ctx context.Context, id int64, viewer *int) <-chan refreshReply {
	result := make(chan refreshReply, 1)
	go func() {
		repository, status, err := app.refreshPublicAgentRepositoryForViewer(ctx, id, viewer, true)
		result <- refreshReply{repository, status, err}
	}()
	return result
}

func TestPublicRepositoryRefreshCoalescesAndIsolatesViewers(t *testing.T) {
	app, before, owner, _, _ := seedSystemRepositorySync(t, false)
	ctx := context.Background()
	if _, err := app.db.Exec(ctx, `INSERT INTO agent_repository_stars(workspace_id,user_id) VALUES($1,$2)`, before.WorkspaceID, owner); err != nil {
		t.Fatal(err)
	}
	entered, release, archives := blockedRefreshFixture(app)
	defer release()
	first := startViewerRefresh(app, ctx, before.WorkspaceID, &owner)
	awaitRefresh(t, entered)
	anonymousContext := &refreshWaitContext{Context: ctx, waiting: make(chan struct{})}
	anonymous := startViewerRefresh(app, anonymousContext, before.WorkspaceID, nil)
	awaitRefresh(t, anonymousContext.waiting)
	cancelContext, cancel := context.WithCancel(ctx)
	defer cancel()
	cancelledContext := &refreshWaitContext{Context: cancelContext, waiting: make(chan struct{})}
	cancelled := startViewerRefresh(app, cancelledContext, before.WorkspaceID, nil)
	awaitRefresh(t, cancelledContext.waiting)
	cancel()
	if result := awaitRefresh(t, cancelled); !errors.Is(result.err, context.Canceled) {
		t.Fatalf("cancelled waiter: %v", result.err)
	}
	release()
	ownerResult, anonymousResult := awaitRefresh(t, first), awaitRefresh(t, anonymous)
	for _, result := range []refreshReply{ownerResult, anonymousResult} {
		if result.err != nil || result.result.Status != "updated" || result.repository.Revision != before.Revision+1 || result.repository.GitHubSource.CommitSHA != githubSyncTestSHA {
			t.Fatalf("joined refresh did not return the latest publication: %+v %v", result.result, result.err)
		}
	}
	if !ownerResult.repository.Starred || anonymousResult.repository.Starred || ownerResult.repository.StarCount != 1 || anonymousResult.repository.StarCount != 1 {
		t.Fatalf("shared refresh leaked per-viewer engagement: owner=%+v anonymous=%+v", ownerResult.repository.agentRepositoryEngagement, anonymousResult.repository.agentRepositoryEngagement)
	}
	if archives.Load() != 1 {
		t.Fatalf("overlapping refreshes downloaded %d archives", archives.Load())
	}
	_, result, err := app.refreshPublicAgentRepository(ctx, before.WorkspaceID, "", true)
	if err != nil || result.Status != "unchanged" {
		t.Fatalf("completed flight was not released: %+v %v", result, err)
	}
}

func TestPublicRepositoryRefreshLeaderCancellationDoesNotCancelWaiter(t *testing.T) {
	app, before, _, _, _ := seedSystemRepositorySync(t, false)
	entered, release, _ := blockedRefreshFixture(app)
	defer release()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	leader := startViewerRefresh(app, ctx, before.WorkspaceID, nil)
	awaitRefresh(t, entered)
	waiterContext := &refreshWaitContext{Context: context.Background(), waiting: make(chan struct{})}
	waiter := startViewerRefresh(app, waiterContext, before.WorkspaceID, nil)
	awaitRefresh(t, waiterContext.waiting)
	cancel()
	release()
	if result := awaitRefresh(t, leader); !errors.Is(result.err, context.Canceled) {
		t.Fatalf("leader ignored caller cancellation: %v", result.err)
	}
	if result := awaitRefresh(t, waiter); result.err != nil || result.repository.GitHubSource.CommitSHA != githubSyncTestSHA {
		t.Fatalf("leader cancellation poisoned waiter: %+v", result)
	}
}

func TestPublicRepositoryRefreshAdmissionIsBoundedAndSharedWithImports(t *testing.T) {
	app, first, _, _, _ := seedSystemRepositorySync(t, false)
	_, second, _, _, _ := seedSystemRepositorySync(t, false)
	_, third, _, _, _ := seedSystemRepositorySync(t, false)
	entered, release, archives := blockedRefreshFixture(app)
	defer release()
	one := startViewerRefresh(app, context.Background(), first.WorkspaceID, nil)
	awaitRefresh(t, entered)
	two := startViewerRefresh(app, context.Background(), second.WorkspaceID, nil)
	awaitRefresh(t, entered)
	if app.acquireGitHubImportSlot() {
		app.releaseGitHubImportSlot()
		t.Fatal("an import bypassed active refresh capacity")
	}
	_, _, err := app.refreshPublicAgentRepository(context.Background(), third.WorkspaceID, "", true)
	if !errors.Is(err, errAgentGitHubImportBusy) || archives.Load() != 2 {
		t.Fatalf("third repository bypassed admission: archives=%d err=%v", archives.Load(), err)
	}
	release()
	for _, reply := range []refreshReply{awaitRefresh(t, one), awaitRefresh(t, two)} {
		if reply.err != nil || reply.result.Status != "updated" {
			t.Fatalf("admitted refresh failed: %+v", reply)
		}
	}
	// Import admission is the same capacity; a saturated import pool also blocks
	// refreshes, but never prevents use of an already-retired saved snapshot.
	if !app.acquireGitHubImportSlot() {
		t.Fatal("first released import slot unavailable")
	}
	defer app.releaseGitHubImportSlot()
	if !app.acquireGitHubImportSlot() {
		t.Fatal("second released import slot unavailable")
	}
	defer app.releaseGitHubImportSlot()
	_, _, err = app.refreshPublicAgentRepository(context.Background(), third.WorkspaceID, "", true)
	if !errors.Is(err, errAgentGitHubImportBusy) {
		t.Fatalf("refresh ignored import admission: %v", err)
	}
	if _, err = app.db.Exec(context.Background(), `UPDATE agent_workspaces SET github_source=github_source || '{"upstreamStatus":"archived"}'::jsonb WHERE id=$1`, third.WorkspaceID); err != nil {
		t.Fatal(err)
	}
	repository, result, err := app.refreshPublicAgentRepository(context.Background(), third.WorkspaceID, "", false)
	if err != nil || result.Code != "archived" || repository.Revision != third.Revision {
		t.Fatalf("busy imports blocked saved retired snapshot: %+v %v", result, err)
	}
}

func TestPublicRepositoryRefreshRejectedTokenFallsBackBeforeAnonymousArchive(t *testing.T) {
	for _, test := range []struct {
		stage  string
		status int
	}{{"metadata", 401}, {"metadata", 403}, {"commit", 401}, {"archive", 403}} {
		t.Run(fmt.Sprintf("%s-%d", test.stage, test.status), func(t *testing.T) {
			app, before, _, _, _ := seedSystemRepositorySync(t, false)
			transport := app.githubHTTPClient.Transport
			var anonymous int
			app.githubHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				stage := "metadata"
				if strings.Contains(r.URL.Path, "/commits/") {
					stage = "commit"
				} else if githubArchiveTestRequest(r) {
					stage = "archive"
					if r.Header.Get("Authorization") != "" {
						t.Fatal("public archive used a saved credential")
					}
				}
				if r.Header.Get("Authorization") == "Bearer rejected-token" && stage == test.stage {
					return &http.Response{StatusCode: test.status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("token rejected")), Request: r}, nil
				}
				if r.Header.Get("Authorization") == "" {
					anonymous++
				}
				request := r.Clone(r.Context())
				if request.URL.Host != githubCodeLoadHost {
					request.Header.Set("Authorization", "Bearer sync-test-token")
				}
				return transport.RoundTrip(request)
			})}
			repository, result, err := app.refreshPublicAgentRepository(context.Background(), before.WorkspaceID, "rejected-token", true)
			wantAnonymous := 3
			if test.stage == "archive" {
				wantAnonymous = 1 // The token cannot be rejected by an anonymous archive request.
			}
			if err != nil || result.Status != "updated" || repository.GitHubSource.CommitSHA != githubSyncTestSHA || repository.GitHubSource.UpstreamStatus != "" || anonymous != wantAnonymous {
				t.Fatalf("public fallback failed: %+v %v", result, err)
			}
		})
	}
}

func TestPublicRepositoryRefreshFallbackDoesNotRetireInaccessibleUpstream(t *testing.T) {
	for _, private := range []bool{false, true} {
		t.Run(fmt.Sprintf("private=%t", private), func(t *testing.T) {
			app, before, _, _, upstream := seedSystemRepositorySync(t, false)
			transport := app.githubHTTPClient.Transport
			upstream.private = private
			app.githubHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				if r.Header.Get("Authorization") != "" {
					return &http.Response{StatusCode: 401, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("token rejected")), Request: r}, nil
				}
				if !private {
					return &http.Response{StatusCode: 404, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("not accessible")), Request: r}, nil
				}
				request := r.Clone(r.Context())
				if request.URL.Host != githubCodeLoadHost {
					request.Header.Set("Authorization", "Bearer sync-test-token")
				}
				return transport.RoundTrip(request)
			})}
			_, _, err := app.refreshPublicAgentRepository(context.Background(), before.WorkspaceID, "rejected-token", true)
			if !errors.Is(err, errAgentGitHubCredentialRequired) {
				t.Fatalf("lost actionable credential failure: %v", err)
			}
			current, err := app.loadPublicAgentRepository(context.Background(), before.WorkspaceID, nil)
			if err != nil || current.Revision != before.Revision || current.GitHubSource.UpstreamStatus != "" || upstream.archives != 0 {
				t.Fatalf("fallback falsely retired or updated snapshot: %+v %v", current, err)
			}
		})
	}
}

func TestPublicRepositoryRefreshRateLimitsNeverRetryAnonymously(t *testing.T) {
	for _, status := range []int{429, 403} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			app, before, _, _, _ := seedSystemRepositorySync(t, false)
			calls := 0
			app.githubHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				calls++
				headers := make(http.Header)
				headers.Set("X-RateLimit-Remaining", "0")
				return &http.Response{StatusCode: status, Header: headers, Body: io.NopCloser(strings.NewReader("rate limited")), Request: r}, nil
			})}
			_, _, err := app.refreshPublicAgentRepository(context.Background(), before.WorkspaceID, "saved-token", true)
			if !errors.Is(err, errAgentGitHubRateLimited) || calls != 1 {
				t.Fatalf("rate limit was retried: calls=%d err=%v", calls, err)
			}
		})
	}
}

func TestRepositoryRefreshAuthenticated404ConfirmsPublicVisibility(t *testing.T) {
	for _, interactive := range []bool{false, true} {
		for _, publicStatus := range []int{http.StatusOK, http.StatusNotFound, http.StatusServiceUnavailable, http.StatusTooManyRequests} {
			t.Run(fmt.Sprintf("interactive=%t/public=%d", interactive, publicStatus), func(t *testing.T) {
				app, before, _, _, _ := seedSystemRepositorySync(t, false)
				transport := app.githubHTTPClient.Transport
				var authenticated, anonymous int
				app.githubHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
					if r.Header.Get("Authorization") != "" {
						authenticated++
						return &http.Response{StatusCode: http.StatusNotFound, Header: make(http.Header), Body: http.NoBody, Request: r}, nil
					}
					anonymous++
					if publicStatus != http.StatusOK {
						return &http.Response{StatusCode: publicStatus, Header: make(http.Header), Body: http.NoBody, Request: r}, nil
					}
					request := r.Clone(r.Context())
					if request.URL.Host != githubCodeLoadHost {
						request.Header.Set("Authorization", "Bearer sync-test-token")
					}
					return transport.RoundTrip(request)
				})}
				result, err := app.refreshAgentRepository(context.Background(), mustSyncSnapshot(t, app, before.WorkspaceID), agentRepositoryRefreshOptions{
					Apply: true, GitHubToken: "restricted-token", Interactive: interactive,
				})
				current, loadErr := app.loadPublicAgentRepository(context.Background(), before.WorkspaceID, nil)
				if loadErr != nil {
					t.Fatal(loadErr)
				}
				if authenticated != 1 || anonymous == 0 {
					t.Fatalf("missing anonymous confirmation: authenticated=%d anonymous=%d", authenticated, anonymous)
				}
				switch publicStatus {
				case http.StatusOK:
					if err != nil || result.Status != "updated" || current.GitHubSource.CommitSHA != githubSyncTestSHA || current.GitHubSource.UpstreamStatus != "" {
						t.Fatalf("public repository falsely retired: result=%+v source=%+v err=%v", result, current.GitHubSource, err)
					}
				case http.StatusNotFound:
					if err != nil || result.Code != agentUpstreamUnavailable || current.GitHubSource.UpstreamStatus != agentUpstreamUnavailable {
						t.Fatalf("confirmed missing repository not marked: %+v %v", result, err)
					}
				default:
					want := errAgentGitHubTransient
					if publicStatus == http.StatusTooManyRequests {
						want = errAgentGitHubRateLimited
					}
					if !errors.Is(err, want) || current.GitHubSource.UpstreamStatus != "" || current.Revision != before.Revision {
						t.Fatalf("failed confirmation changed snapshot: result=%+v source=%+v err=%v", result, current.GitHubSource, err)
					}
				}
			})
		}
	}
}

func TestPublicRepositoryRefreshSavedTokenDoesNotBlockForkClone(t *testing.T) {
	app, before, userID, _, _ := seedSystemRepositorySync(t, false)
	ctx := context.Background()
	transport := app.githubHTTPClient.Transport
	app.githubHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.Header.Get("Authorization") == "Bearer revoked-saved-token" {
			return &http.Response{StatusCode: 401, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("revoked token")), Request: r}, nil
		}
		request := r.Clone(r.Context())
		if request.URL.Host != githubCodeLoadHost {
			request.Header.Set("Authorization", "Bearer sync-test-token")
		}
		return transport.RoundTrip(request)
	})}
	ciphertext, err := app.encryptGitHubToken(userID, "revoked-saved-token")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = app.db.Exec(ctx, `INSERT INTO agent_github_credentials(user_id,token_ciphertext) VALUES($1,$2)`, userID, ciphertext); err != nil {
		t.Fatal(err)
	}
	if _, err = app.db.Exec(ctx, `INSERT INTO agent_workspace_settings(user_id,enabled) VALUES($1,true)`, userID); err != nil {
		t.Fatal(err)
	}
	var externalID string
	if err = app.db.QueryRow(ctx, `SELECT auth_user_id FROM users WHERE id=$1`, userID).Scan(&externalID); err != nil {
		t.Fatal(err)
	}
	cookie := mcpSessionCookie(app, externalID)
	base := fmt.Sprintf("/api/agent/repositories/%d", before.WorkspaceID)
	response := callRepositoryAPI(t, app, cookie, http.MethodPost, base+"/sync", "", http.StatusOK)
	var refreshed struct {
		Repository agentRepositoryPublication `json:"repository"`
	}
	decodeJSONResponse(t, response, &refreshed)
	if refreshed.Repository.GitHubSource.CommitSHA != githubSyncTestSHA {
		t.Fatalf("signed-in sync returned stale content: %+v", refreshed.Repository)
	}
	cloneID, _ := randomUUID()
	callRepositoryAPI(t, app, cookie, http.MethodPost, base+"/clone", fmt.Sprintf(`{"expectedRevision":%d,"requestId":%q,"method":"zip"}`, refreshed.Repository.Revision, cloneID), http.StatusOK)
	forkID, _ := randomUUID()
	response = callRepositoryAPI(t, app, cookie, http.MethodPost, base+"/fork", fmt.Sprintf(`{"expectedRevision":%d,"requestId":%q}`, refreshed.Repository.Revision, forkID), http.StatusCreated)
	var forked struct {
		Workspace agentWorkspaceView `json:"workspace"`
	}
	decodeJSONResponse(t, response, &forked)
	if forked.Workspace.GitHubSource.CommitSHA != githubSyncTestSHA {
		t.Fatalf("signed-in Fork returned stale content: %+v", forked.Workspace)
	}
}
