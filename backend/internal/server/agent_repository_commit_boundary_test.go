package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPublicForkDisabledDuringPreparationCreatesNoCopy(t *testing.T) {
	for _, stage := range []string{"metadata", "commit"} {
		t.Run(stage, func(t *testing.T) {
			app, saved, userID, _, upstream := seedSystemRepositorySync(t, false)
			ctx := context.Background()
			if err := app.setAgentWorkspaceEnabled(ctx, userID, true); err != nil {
				t.Fatal(err)
			}
			upstream.sha = githubTestSHA
			allowAnonymousRepositorySyncFixture(app)
			var externalID string
			if err := app.db.QueryRow(ctx, `SELECT auth_user_id FROM users WHERE id=$1`, userID).Scan(&externalID); err != nil {
				t.Fatal(err)
			}
			cookie := mcpSessionCookie(app, externalID)
			publication, err := app.loadPublicAgentRepository(ctx, saved.WorkspaceID, nil)
			if err != nil {
				t.Fatal(err)
			}
			transport := app.githubHTTPClient.Transport
			var disabled bool
			app.githubHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				if !disabled && (stage == "metadata" || strings.Contains(r.URL.Path, "/commits/")) {
					callRepositoryAPI(t, app, cookie, http.MethodPut, "/api/agent/workspace/settings", `{"enabled":false}`, http.StatusOK)
					disabled = true
				}
				return transport.RoundTrip(r)
			})}
			requestID, _ := randomUUID()
			path := fmt.Sprintf("/api/agent/repositories/%d/fork", saved.WorkspaceID)
			body := fmt.Sprintf(`{"expectedRevision":%d,"expectedPublication":%q,"requestId":%q}`, saved.Revision, publication.PublicationID, requestID)
			response := callRepositoryAPI(t, app, cookie, http.MethodPost, path, body, http.StatusForbidden)
			if !disabled || !strings.Contains(response.Body.String(), `"code":"agent_workspace_disabled"`) {
				t.Fatalf("completed disable did not reject the new Fork: disabled=%t response=%s", disabled, response.Body.String())
			}
			var workspaces, forks int
			var used int64
			if err := app.db.QueryRow(ctx, `SELECT (SELECT count(*) FROM agent_workspaces WHERE user_id=$1),(SELECT count(*) FROM agent_repository_forks WHERE user_id=$1),agent_workspace_storage_bytes($1)`, userID).Scan(&workspaces, &forks, &used); err != nil || workspaces != 0 || forks != 0 || used != 0 {
				t.Fatalf("rejected Fork created data: workspaces=%d forks=%d used=%d err=%v", workspaces, forks, used, err)
			}
			current, err := app.loadPublicAgentRepository(ctx, saved.WorkspaceID, nil)
			if err != nil || !reflect.DeepEqual(current, publication) {
				t.Fatalf("rejected Fork changed the source publication: %+v %v", current, err)
			}
			// The rejected request leaves no completed attempt; enabling sync permits
			// the same request ID to create exactly one copy and replay it safely.
			callRepositoryAPI(t, app, cookie, http.MethodPut, "/api/agent/workspace/settings", `{"enabled":true}`, http.StatusOK)
			for range 2 {
				callRepositoryAPI(t, app, cookie, http.MethodPost, path, body, http.StatusCreated)
			}
			if err := app.db.QueryRow(ctx, `SELECT count(*) FROM agent_repository_forks WHERE user_id=$1`, userID).Scan(&forks); err != nil || forks != 1 {
				t.Fatalf("reenabled Fork did not create one copy: forks=%d err=%v", forks, err)
			}
		})
	}
}

func TestPublicForkCurrentSettingsGuardPreservesCompletedReplay(t *testing.T) {
	for _, setting := range []string{"disabled", "missing"} {
		t.Run(setting, func(t *testing.T) {
			app, source, userID, _, _ := seedSystemRepositorySync(t, false)
			ctx := context.Background()
			if err := app.setAgentWorkspaceEnabled(ctx, userID, true); err != nil {
				t.Fatal(err)
			}
			requestID, _ := randomUUID()
			original, err := app.forkAgentRepository(ctx, userID, source.WorkspaceID, source.Revision, requestID)
			if err != nil {
				t.Fatal(err)
			}
			if setting == "disabled" {
				err = app.setAgentWorkspaceEnabled(ctx, userID, false)
			} else {
				_, err = app.db.Exec(ctx, `DELETE FROM agent_workspace_settings WHERE user_id=$1`, userID)
			}
			if err != nil {
				t.Fatal(err)
			}
			replay, err := app.forkAgentRepository(ctx, userID, source.WorkspaceID, source.Revision, requestID)
			if err != nil || !reflect.DeepEqual(replay, original) {
				t.Fatalf("settings guard changed an already completed Fork: %+v %v", replay, err)
			}
			newID, _ := randomUUID()
			if _, err := app.forkAgentRepository(ctx, userID, source.WorkspaceID, source.Revision, newID); !errors.Is(err, errAgentWorkspaceDisabled) {
				t.Fatalf("new Fork ignored current %s settings: %v", setting, err)
			}
			var count int
			if err := app.db.QueryRow(ctx, `SELECT count(*) FROM agent_workspaces WHERE user_id=$1`, userID).Scan(&count); err != nil || count != 1 {
				t.Fatalf("settings guard created another copy: count=%d err=%v", count, err)
			}
		})
	}
}

func TestPersonalRefreshDisabledDuringUpstreamReadKeepsSavedSnapshot(t *testing.T) {
	for _, scenario := range []string{"content", "source_only", "archived", "anonymous_fallback"} {
		t.Run(scenario, func(t *testing.T) {
			app, before, owner, upstream := seedPersonalGitHubRepository(t)
			ctx := context.Background()
			publication, err := app.loadPublicAgentRepository(ctx, before.WorkspaceID, nil)
			if err != nil {
				t.Fatal(err)
			}
			var externalID string
			if err = app.db.QueryRow(ctx, `SELECT auth_user_id FROM users WHERE id=$1`, owner).Scan(&externalID); err != nil {
				t.Fatal(err)
			}
			if scenario == "source_only" {
				upstream.sha = githubTestSHA
				upstream.fullName = "Octo/renamed-personal"
			}
			if scenario == "archived" {
				upstream.archived = true
			}
			transport := app.githubHTTPClient.Transport
			var disabled sync.Once
			app.githubHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				if scenario == "anonymous_fallback" && r.Header.Get("Authorization") != "" {
					return &http.Response{StatusCode: http.StatusUnauthorized, Header: make(http.Header), Body: http.NoBody, Request: r}, nil
				}
				archive := githubArchiveTestRequest(r)
				if archive || scenario == "source_only" || scenario == "archived" {
					disabled.Do(func() {
						callRepositoryAPI(t, app, mcpSessionCookie(app, externalID), http.MethodPut, "/api/agent/workspace/settings", `{"enabled":false}`, http.StatusOK)
					})
				}
				request := r.Clone(r.Context())
				if request.URL.Host != githubCodeLoadHost {
					request.Header.Set("Authorization", "Bearer sync-test-token")
				}
				return transport.RoundTrip(request)
			})}
			current, result, err := app.refreshPublicAgentRepository(ctx, before.WorkspaceID, "sync-test-token", true)
			if err != nil || result.Status != "skipped" || result.Code != "agent_workspace_disabled" {
				t.Fatalf("completed disable did not stop refresh: %+v %v", result, err)
			}
			if !reflect.DeepEqual(current.Files, publication.Files) || !reflect.DeepEqual(current.GitHubSource, publication.GitHubSource) || current.Revision != publication.Revision || current.UpdatedAt != publication.UpdatedAt {
				t.Fatalf("refresh changed the saved publication after disable: %+v", current)
			}
			live, err := loadAgentWorkspaceForOwner(ctx, app.db, &owner, before.WorkspaceID)
			if err != nil || live.Revision != before.Revision || !reflect.DeepEqual(live.Files, before.Files) || !reflect.DeepEqual(live.GitHubSource, before.GitHubSource) {
				t.Fatalf("refresh changed private files after disable: %+v %v", live, err)
			}
			if enabled, err := app.agentWorkspaceEnabled(ctx, owner); err != nil || enabled {
				t.Fatalf("disable was not persisted: enabled=%t err=%v", enabled, err)
			}
		})
	}
}

// Hold both initial lookups after PostgreSQL has returned no completed request.
// This reproduces two valid callers that begin before either Fork is committed.
type forkReplayLookupTracer struct {
	starts                      atomic.Int32
	first, second               chan struct{}
	releaseFirst, releaseSecond chan struct{}
}

func (tracer *forkReplayLookupTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if strings.Contains(data.SQL, "SELECT workspace_id,source_workspace_id,source_revision FROM agent_repository_forks") {
		return context.WithValue(ctx, tracer, tracer.starts.Add(1))
	}
	return ctx
}

func (tracer *forkReplayLookupTracer) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryEndData) {
	index, _ := ctx.Value(tracer).(int32)
	var release <-chan struct{}
	switch index {
	case 1:
		close(tracer.first)
		release = tracer.releaseFirst
	case 2:
		close(tracer.second)
		release = tracer.releaseSecond
	default:
		return
	}
	select {
	case <-release:
	case <-ctx.Done():
	}
}

func TestPublicForkConcurrentReplayReturnsOriginalAfterRefreshOutcomeChanges(t *testing.T) {
	for _, outcome := range []string{"advanced", "unavailable"} {
		t.Run(outcome, func(t *testing.T) {
			app, before, userID, _, upstream := seedSystemRepositorySync(t, false)
			ctx := context.Background()
			if _, err := app.db.Exec(ctx, `INSERT INTO agent_workspace_settings(user_id,enabled) VALUES($1,true)`, userID); err != nil {
				t.Fatal(err)
			}
			var externalID string
			if err := app.db.QueryRow(ctx, `SELECT auth_user_id FROM users WHERE id=$1`, userID).Scan(&externalID); err != nil {
				t.Fatal(err)
			}
			tracer := &forkReplayLookupTracer{first: make(chan struct{}), second: make(chan struct{}), releaseFirst: make(chan struct{}), releaseSecond: make(chan struct{})}
			var firstRelease, secondRelease sync.Once
			config := app.db.Config()
			config.ConnConfig.Tracer = tracer
			pool, err := pgxpool.NewWithConfig(ctx, config)
			if err != nil {
				t.Fatal(err)
			}
			defer pool.Close()
			defer firstRelease.Do(func() { close(tracer.releaseFirst) })
			defer secondRelease.Do(func() { close(tracer.releaseSecond) })
			app.db = pool
			upstream.sha = githubTestSHA
			allowAnonymousRepositorySyncFixture(app)
			requestID, _ := randomUUID()
			body := fmt.Sprintf(`{"expectedRevision":%d,"requestId":%q}`, before.Revision, requestID)
			path := fmt.Sprintf("/api/agent/repositories/%d/fork", before.WorkspaceID)
			call := func() <-chan *httptest.ResponseRecorder {
				responses := make(chan *httptest.ResponseRecorder, 1)
				go func() {
					request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
					request.AddCookie(mcpSessionCookie(app, externalID))
					response := httptest.NewRecorder()
					app.Routes().ServeHTTP(response, request)
					responses <- response
				}()
				return responses
			}
			first := call()
			awaitRefresh(t, tracer.first)
			second := call()
			awaitRefresh(t, tracer.second)
			firstRelease.Do(func() { close(tracer.releaseFirst) })
			firstReply := awaitRefresh(t, first)
			if outcome == "advanced" {
				upstream.sha = githubSyncTestSHA
			} else {
				upstream.status = http.StatusServiceUnavailable
			}
			secondRelease.Do(func() { close(tracer.releaseSecond) })
			secondReply := awaitRefresh(t, second)
			if firstReply.Code != http.StatusCreated || secondReply.Code != http.StatusCreated {
				t.Fatalf("same Fork request changed result: first=%d %s second=%d %s", firstReply.Code, firstReply.Body.String(), secondReply.Code, secondReply.Body.String())
			}
			var original, replay struct {
				Workspace agentWorkspaceView `json:"workspace"`
			}
			decodeJSONResponse(t, firstReply, &original)
			decodeJSONResponse(t, secondReply, &replay)
			if original.Workspace.WorkspaceID != replay.Workspace.WorkspaceID || replay.Workspace.GitHubSource.CommitSHA != githubTestSHA {
				t.Fatalf("replay returned a different Fork: original=%+v replay=%+v", original, replay)
			}
			var forks int
			if err := pool.QueryRow(ctx, `SELECT count(*) FROM agent_repository_forks WHERE user_id=$1 AND request_id=$2::uuid`, userID, requestID).Scan(&forks); err != nil || forks != 1 {
				t.Fatalf("concurrent replay duplicated Fork: count=%d err=%v", forks, err)
			}
		})
	}
}
