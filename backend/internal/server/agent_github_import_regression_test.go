package server

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"koinote/backend/internal/config"
)

func TestGitHubRefFailuresNeverBecomeRepositoryMissing(t *testing.T) {
	for _, status := range []int{400, 404, 409, 410, 422, 502} {
		for _, ref := range []string{"", "main"} {
			t.Run(fmt.Sprintf("status=%d/ref=%q", status, ref), func(t *testing.T) {
				calls := 0
				app := &App{githubHTTPClient: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
					calls++
					code := http.StatusOK
					body := `{"id":123,"name":"demo","full_name":"Octo/demo","owner":{"login":"Octo"},"default_branch":"main","private":false}`
					if r.URL.Path == "/repos/Octo/demo/commits/main" {
						code, body = status, `{"message":"rejected"}`
					} else if r.URL.Path != "/repos/Octo/demo" {
						t.Fatalf("unexpected request: %s", r.URL.Path)
					}
					return &http.Response{StatusCode: code, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
				})}}
				_, source, err := app.resolveGitHubRepository(context.Background(), "Octo", "demo", ref, "", true)
				wantErr, wantCode := errAgentGitHubRequestInvalid, "github_request_invalid"
				if status >= 500 {
					wantErr, wantCode = errAgentGitHubTransient, "github_transient_error"
				}
				if !errors.Is(err, wantErr) || errors.Is(err, errAgentGitHubRepositoryMissing) || source != nil || calls != 2 {
					t.Fatalf("commit failure changed meaning: calls=%d source=%+v err=%v", calls, source, err)
				}
				code := systemRepositorySyncErrorCode(err)
				if code != wantCode || systemRepositorySyncNeedsAttention(code) {
					t.Fatalf("commit failure became permanent: code=%s err=%v", code, err)
				}
			})
		}
	}
}

// The test blocks only a selected real database query, with the handler's
// context controlling the wait. No three-second/90-second sleeps or globals
// are needed to prove that authentication and settings share the import budget.
type githubImportBudgetTracer struct {
	t       *testing.T
	match   string
	budget  time.Duration
	blocked bool
}

func (tracer *githubImportBudgetTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if !strings.Contains(data.SQL, tracer.match) {
		return ctx
	}
	tracer.blocked = true
	deadline, ok := ctx.Deadline()
	if !ok || time.Until(deadline) > tracer.budget {
		tracer.t.Errorf("database query outside import budget: deadline=%v hasDeadline=%v", deadline, ok)
		return ctx
	}
	select {
	case <-ctx.Done():
	case <-time.After(tracer.budget + time.Second):
		tracer.t.Error("database wait ignored import cancellation")
	}
	return ctx
}

func (*githubImportBudgetTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func TestGitHubImportBudgetIncludesAuthorizationAndSettings(t *testing.T) {
	for _, tc := range []struct {
		name   string
		system bool
		match  string
	}{
		{name: "personal authentication", match: "FROM users WHERE auth_user_id"},
		{name: "system authentication", system: true, match: "FROM users WHERE auth_user_id"},
		{name: "personal settings", match: "SELECT COALESCE((SELECT enabled FROM agent_workspace_settings"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pool := newGCTestPool(t)
			cfg := config.Config{SessionSecret: "github-import-budget-test", AppURL: "https://koinote.example"}
			seedApp := New(cfg, pool)
			user := seedMCPUser(t, pool, seedApp, membershipTierLifetime)
			if _, err := pool.Exec(context.Background(), `UPDATE users SET is_admin=true WHERE id=$1`, user.ID); err != nil {
				t.Fatal(err)
			}
			// Exercise expiry inside the selected query, even on a loaded test host.
			const budget = 2 * time.Second
			tracer := &githubImportBudgetTracer{t: t, match: tc.match, budget: budget}
			poolCfg := pool.Config()
			poolCfg.ConnConfig.Tracer = tracer
			tracedPool, err := pgxpool.NewWithConfig(context.Background(), poolCfg)
			if err != nil {
				t.Fatal(err)
			}
			defer tracedPool.Close()
			if err := tracedPool.Ping(context.Background()); err != nil {
				t.Fatal(err)
			}
			app := New(cfg, tracedPool)
			req := httptest.NewRequest(http.MethodPost, "/api/agent/workspaces/import/github", strings.NewReader(`{}`))
			req.AddCookie(mcpSessionCookie(app, user.AuthUserID))
			res := httptest.NewRecorder()
			app.agentGitHubImportWithTimeouts(res, req, tc.system, budget, time.Second)
			if !tracer.blocked || res.Code != http.StatusServiceUnavailable || !strings.Contains(res.Body.String(), `"code":"github_temporarily_unavailable"`) || res.Header().Get("Retry-After") != "30" {
				t.Fatalf("import budget missing from preflight: blocked=%v response=%d %s", tracer.blocked, res.Code, res.Body.String())
			}
			if len(res.Result().Cookies()) != 0 {
				t.Fatal("database deadline invalidated a valid login cookie")
			}
		})
	}
}

func TestGitHubImportSlowBodyReturnsRetryableTimeout(t *testing.T) {
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "github-import-slow-body-test", AppURL: "https://koinote.example"}, pool)
	user := seedMCPUser(t, pool, app, membershipTierLifetime)
	if _, err := pool.Exec(context.Background(), `INSERT INTO agent_workspace_settings(user_id,enabled) VALUES($1,true)`, user.ID); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		app.agentGitHubImportWithTimeouts(w, r, false, 2*time.Second, 30*time.Millisecond)
	}))
	defer server.Close()
	for _, prefix := range []string{"{", `{}`} {
		t.Run(fmt.Sprintf("prefix=%q", prefix), func(t *testing.T) {
			conn, err := net.DialTimeout("tcp", strings.TrimPrefix(server.URL, "http://"), time.Second)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			if err := conn.SetDeadline(time.Now().Add(3 * time.Second)); err != nil {
				t.Fatal(err)
			}
			cookie := mcpSessionCookie(app, user.AuthUserID)
			if _, err := fmt.Fprintf(conn, "POST / HTTP/1.1\r\nHost: test\r\nCookie: %s=%s\r\nContent-Length: 100\r\n\r\n%s", cookie.Name, cookie.Value, prefix); err != nil {
				t.Fatal(err)
			}
			res, err := http.ReadResponse(bufio.NewReader(conn), nil)
			if err != nil {
				t.Fatal(err)
			}
			defer res.Body.Close()
			body, err := io.ReadAll(res.Body)
			if err != nil {
				t.Fatal(err)
			}
			if res.StatusCode != http.StatusServiceUnavailable || res.Header.Get("Retry-After") != "30" || !strings.Contains(string(body), `"code":"github_temporarily_unavailable"`) {
				t.Fatalf("slow body was misclassified: status=%d body=%s", res.StatusCode, body)
			}
		})
	}
}

func TestGitHubImportAuthTimeoutDoesNotHangDrainingUnreadBody(t *testing.T) {
	pool := newGCTestPool(t)
	cfg := config.Config{SessionSecret: "github-import-auth-body-test", AppURL: "https://koinote.example"}
	seedApp := New(cfg, pool)
	user := seedMCPUser(t, pool, seedApp, membershipTierLifetime)
	tracer := &githubImportBudgetTracer{t: t, match: "FROM users WHERE auth_user_id", budget: 60 * time.Millisecond}
	poolConfig := pool.Config()
	poolConfig.ConnConfig.Tracer = tracer
	tracedPool, err := pgxpool.NewWithConfig(context.Background(), poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	defer tracedPool.Close()
	app := New(cfg, tracedPool)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		app.agentGitHubImportWithTimeouts(w, r, false, 60*time.Millisecond, 30*time.Millisecond)
	}))
	defer server.Close()
	conn, err := net.DialTimeout("tcp", strings.TrimPrefix(server.URL, "http://"), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if err := conn.SetDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	cookie := mcpSessionCookie(app, user.AuthUserID)
	if _, err := fmt.Fprintf(conn, "POST / HTTP/1.1\r\nHost: test\r\nCookie: %s=%s\r\nContent-Length: 100\r\n\r\n{", cookie.Name, cookie.Value); err != nil {
		t.Fatal(err)
	}
	res, err := http.ReadResponse(bufio.NewReader(conn), nil)
	if err != nil {
		t.Fatalf("auth timeout left the server draining an unread body: %v", err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !tracer.blocked || res.StatusCode != http.StatusServiceUnavailable || res.Header.Get("Retry-After") != "30" || !strings.Contains(string(body), `"code":"github_temporarily_unavailable"`) {
		t.Fatalf("auth timeout response: blocked=%v status=%d body=%s", tracer.blocked, res.StatusCode, body)
	}
}

func TestGitHubImportAuthorizationAndMalformedBodyRemainUnchanged(t *testing.T) {
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "github-import-auth-test", AppURL: "https://koinote.example"}, pool)
	user := seedMCPUser(t, pool, app, membershipTierLifetime)
	if _, err := pool.Exec(context.Background(), `INSERT INTO agent_workspace_settings(user_id,enabled) VALUES($1,true)`, user.ID); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, body, code string
		cookie           bool
		system           bool
		status           int
	}{
		{name: "malformed body", body: `{`, cookie: true, status: 400, code: "bad_request"},
		{name: "missing request ID", body: `{}`, cookie: true, status: 400, code: "bad_request"},
		{name: "anonymous", body: `{}`, status: 401, code: "unauthorized"},
		{name: "system requires admin", body: `{}`, cookie: true, system: true, status: 403, code: "admin_required"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/api/agent/workspaces/import/github", strings.NewReader(tc.body))
			if tc.cookie {
				req.AddCookie(mcpSessionCookie(app, user.AuthUserID))
			}
			res := httptest.NewRecorder()
			app.agentGitHubImport(res, req, tc.system)
			if res.Code != tc.status || !strings.Contains(res.Body.String(), `"code":"`+tc.code+`"`) {
				t.Fatalf("response changed: %d %s", res.Code, res.Body.String())
			}
		})
	}
}
