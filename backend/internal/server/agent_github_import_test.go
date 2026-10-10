package server

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"koinote/backend/internal/config"
)

func TestParseGitHubRepositoryURL(t *testing.T) {
	tests := []struct {
		name      string
		input     string
		owner     string
		repo      string
		ref       string
		wantError bool
	}{
		{name: "repository", input: "https://github.com/octo/demo", owner: "octo", repo: "demo"},
		{name: "git suffix", input: "https://www.github.com/octo/demo.git", owner: "octo", repo: "demo"},
		{name: "tree ref", input: "https://github.com/octo/demo/tree/feature/import", owner: "octo", repo: "demo", ref: "feature/import"},
		{name: "wrong host", input: "https://evil.example/octo/demo", wantError: true},
		{name: "wrong scheme", input: "http://github.com/octo/demo", wantError: true},
		{name: "query", input: "https://github.com/octo/demo?tab=readme", wantError: true},
		{name: "missing tree ref", input: "https://github.com/octo/demo/tree", wantError: true},
		{name: "path traversal", input: "https://github.com/octo/demo/tree/../secret", wantError: true},
		{name: "credentials in URL", input: "https://secret@github.com/octo/demo", wantError: true},
		{name: "custom port", input: "https://github.com:8080/octo/demo", wantError: true},
		{name: "control ref", input: "https://github.com/octo/demo/tree/main%09", wantError: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			owner, repo, ref, err := parseGitHubRepositoryURL(test.input)
			if test.wantError {
				if err == nil {
					t.Fatalf("parseGitHubRepositoryURL(%q) succeeded", test.input)
				}
				return
			}
			if err != nil || owner != test.owner || repo != test.repo || ref != test.ref {
				t.Fatalf("parseGitHubRepositoryURL(%q) = %q, %q, %q, %v", test.input, owner, repo, ref, err)
			}
		})
	}
}

func TestGitHubTokenEncryption(t *testing.T) {
	app := &App{cfg: config.Config{SessionSecret: "github-token-test-secret"}}
	const token = "github_pat_example-secret-value"
	ciphertext, err := app.encryptGitHubToken(42, token)
	if err != nil {
		t.Fatalf("encryptGitHubToken: %v", err)
	}
	if bytes.Contains(ciphertext, []byte(token)) {
		t.Fatal("ciphertext contains the GitHub token")
	}
	plaintext, err := app.decryptGitHubToken(42, ciphertext)
	if err != nil || plaintext != token {
		t.Fatalf("decryptGitHubToken = %q, %v", plaintext, err)
	}
	if _, err := app.decryptGitHubToken(43, ciphertext); err == nil {
		t.Fatal("token decrypted with a different user ID")
	}
	ciphertext[len(ciphertext)-1] ^= 1
	if _, err := app.decryptGitHubToken(42, ciphertext); err == nil {
		t.Fatal("tampered token decrypted")
	}
	app.cfg.NodeEnv = "production"
	if _, err := app.encryptGitHubToken(42, token); !errors.Is(err, errAgentGitHubCredentialCrypto) {
		t.Fatalf("production accepted missing encryption key: %v", err)
	}
	app.cfg.MCPTokenEncryptionKey = "independent-github-key"
	if _, err := app.encryptGitHubToken(42, token); err != nil {
		t.Fatal(err)
	}
}

type githubArchiveEntry struct {
	name, content string
	mode          os.FileMode
}

func githubArchive(t *testing.T, entries ...githubArchiveEntry) []byte {
	t.Helper()
	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	for _, entry := range entries {
		header := &zip.FileHeader{Name: entry.name, Method: zip.Deflate}
		mode := entry.mode
		if mode == 0 {
			mode = 0600
		}
		header.SetMode(mode)
		file, err := writer.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = file.Write([]byte(entry.content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

const githubTestSHA = "1234567890abcdef1234567890abcdef12345678"

func githubImportClient(t *testing.T, archive []byte, token string, private bool) *http.Client {
	t.Helper()
	return &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		response := &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("")), Request: r}
		if r.URL.Host == githubCodeLoadHost {
			if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
				t.Error("credentials leaked to archive redirect")
			}
			response.Body = io.NopCloser(bytes.NewReader(archive))
			return response, nil
		}
		if r.URL.Host != "api.github.com" {
			t.Errorf("unexpected import host: %s", r.URL.Host)
		}
		expected := ""
		if token != "" {
			expected = "Bearer " + token
		}
		if r.Header.Get("Authorization") != expected {
			t.Error("incorrect API credential")
		}
		switch r.URL.Path {
		case "/repos/octo/demo":
			response.Body = io.NopCloser(strings.NewReader(fmt.Sprintf(`{"name":"demo","full_name":"Octo/demo","owner":{"login":"Octo","html_url":"https://evil.example/ignored"},"html_url":"https://evil.example/ignored","description":"Imported skills","default_branch":"main","private":%t,"license":{"spdx_id":"MPL-2.0"}}`, private)))
		case "/repos/Octo/demo/commits/main", "/repos/Octo/demo/commits/feature/import":
			if r.Header.Get("Accept") != "application/vnd.github.sha" {
				t.Error("commit should request bounded SHA response")
			}
			response.Body = io.NopCloser(strings.NewReader(githubTestSHA))
		case "/repos/Octo/demo/zipball/" + githubTestSHA:
			response.StatusCode = 302
			response.Header.Set("Location", "https://codeload.github.com/Octo/demo/zip/"+githubTestSHA+"?token=signed-download")
		default:
			t.Errorf("unexpected API path: %s", r.URL.Path)
			response.StatusCode = 404
		}
		return response, nil
	})}
}

func TestGitHubArchiveValidation(t *testing.T) {
	good := githubArchive(t, githubArchiveEntry{"root/", "", os.ModeDir | 0700}, githubArchiveEntry{"root/skills/demo/SKILL.md", "# Skill\nCookie = process.env.COOKIE_VALUE", 0}, githubArchiveEntry{"root/LICENSE", "MPL-2.0", 0})
	app := &App{githubHTTPClient: githubImportClient(t, good, "", false)}
	_, files, source, err := app.fetchGitHubRepository(context.Background(), "octo", "demo", "feature/import", "")
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 2 || source.Author != "Octo" || source.AuthorURL != "https://github.com/Octo" || source.RepositoryURL != "https://github.com/Octo/demo" || source.CommitSHA != githubTestSHA || source.Ref != "feature/import" || source.License != "MPL-2.0" {
		t.Fatalf("unexpected import: %+v %+v", files, source)
	}
	tests := []struct {
		name      string
		entries   []githubArchiveEntry
		sensitive bool
	}{
		{"traversal", []githubArchiveEntry{{"root/../secret", "x", 0}}, false},
		{"unsafe-directory", []githubArchiveEntry{{"root/../", "", os.ModeDir | 0700}, {"root/a", "x", 0}}, false},
		{"absolute", []githubArchiveEntry{{"/root/a", "x", 0}}, false},
		{"backslash", []githubArchiveEntry{{`root/a\b`, "x", 0}}, false},
		{"symlink", []githubArchiveEntry{{"root/a", "outside", os.ModeSymlink | 0777}}, false},
		{"duplicate", []githubArchiveEntry{{"root/a", "x", 0}, {"root/a", "y", 0}}, false},
		{"collision", []githubArchiveEntry{{"root/a/b", "x", 0}, {"root/a", "y", 0}}, false},
		{"roots", []githubArchiveEntry{{"root/a", "x", 0}, {"other/b", "y", 0}}, false},
		{"empty", nil, false},
		{"credential", []githubArchiveEntry{{"root/skill.md", `api_key="abcdefghijklmnopqrst1234"`, 0}}, true},
		{"provider-token", []githubArchiveEntry{{"root/skill.md", "ghp_abcdefghijklmnopqrstuvwxyz123456", 0}}, true},
		{"file-limit", []githubArchiveEntry{{"root/large", strings.Repeat("x", agentWorkspaceMaxFileBytes+1), 0}}, false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			data := githubArchive(t, test.entries...)
			_, err := readGitHubArchive(context.Background(), bytes.NewReader(data), int64(len(data)))
			var sensitive *agentWorkspaceSensitiveError
			if test.sensitive {
				if !errors.As(err, &sensitive) {
					t.Fatalf("sensitivity check: %v", err)
				}
			} else if !errors.Is(err, errAgentGitHubArchiveInvalid) {
				t.Fatalf("archive accepted: %v", err)
			}
		})
	}
	many := make([]githubArchiveEntry, githubImportMaxFiles+1)
	for i := range many {
		many[i] = githubArchiveEntry{fmt.Sprintf("root/%d", i), "", 0}
	}
	data := githubArchive(t, many...)
	if _, err = readGitHubArchive(context.Background(), bytes.NewReader(data), int64(len(data))); !errors.Is(err, errAgentGitHubArchiveInvalid) {
		t.Fatalf("file count limit: %v", err)
	}
	total := make([]githubArchiveEntry, 13)
	for i := range total {
		total[i] = githubArchiveEntry{fmt.Sprintf("root/%d", i), strings.Repeat("x", agentWorkspaceMaxFileBytes), 0}
	}
	data = githubArchive(t, total...)
	if _, err = readGitHubArchive(context.Background(), bytes.NewReader(data), int64(len(data))); !errors.Is(err, errAgentGitHubArchiveInvalid) {
		t.Fatalf("decompressed size limit: %v", err)
	}
}

func TestGitHubRequestsAndCredentialsAreBounded(t *testing.T) {
	for _, target := range []string{"http://codeload.github.com/o/r", "https://evil.example/o/r", "https://api.github.com.evil.example/o/r", "https://codeload.github.com:443/o/r", "https://secret@codeload.github.com/o/r"} {
		t.Run(target, func(t *testing.T) {
			calls := 0
			app := &App{githubHTTPClient: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				calls++
				return &http.Response{StatusCode: 302, Header: http.Header{"Location": []string{target}}, Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
			})}}
			if _, err := app.githubRequest(context.Background(), "https://api.github.com/repos/o/r/zipball/main", "secret-token", "application/vnd.github+json"); err == nil || calls != 1 {
				t.Fatalf("unsafe redirect followed: %v, %d calls", err, calls)
			}
		})
	}
	calls := 0
	app := &App{githubHTTPClient: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		if calls == 1 {
			return &http.Response{StatusCode: 301, Header: http.Header{"Location": []string{"https://api.github.com/repositories/123"}}, Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
		}
		if r.Header.Get("Authorization") != "Bearer read-token" {
			t.Error("same-origin redirect lost authorization")
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("{}")), Request: r}, nil
	})}}
	response, err := app.githubRequest(context.Background(), "https://api.github.com/repos/o/r", "read-token", "application/vnd.github+json")
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if _, err = app.githubRequest(context.Background(), "https://127.0.0.1/private", "secret", "application/vnd.github+json"); err == nil {
		t.Fatal("arbitrary destination accepted")
	}
	for _, token := range []string{"", "tiny", "secret\nheader: injected", strings.Repeat("x", 513)} {
		if _, _, err := validateGitHubToken(token); err == nil {
			t.Fatal("invalid token accepted")
		}
	}
	if token, hint, err := validateGitHubToken("github_pat_private_test_value"); err != nil || token != "github_pat_private_test_value" || hint != "alue" {
		t.Fatal("valid token/hint failed")
	}
	limited := &http.Response{StatusCode: 403, Header: http.Header{"X-Ratelimit-Remaining": []string{"0"}}}
	if !errors.Is(githubResponseError(limited), errAgentGitHubRateLimited) {
		t.Fatal("rate limit mistaken for credential failure")
	}
	app.githubHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{}` + strings.Repeat(" ", githubResponseMaxBytes))), Request: r}, nil
	})}
	if _, err = app.githubRead(context.Background(), "https://api.github.com/repos/o/r", "", "application/vnd.github+json"); err == nil {
		t.Fatal("oversized metadata accepted")
	}
}

func TestGitHubImportPublishesOriginalAttributionAndForkPreservesIt(t *testing.T) {
	for _, storage := range []string{"database", "r2"} {
		t.Run(storage, func(t *testing.T) { runTestGitHubImportPublishesOriginalAttributionAndForkPreservesIt(t, storage) })
	}
}

func runTestGitHubImportPublishesOriginalAttributionAndForkPreservesIt(t *testing.T, storageMode string) {
	ctx := context.Background()
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "github-import-test", AppURL: "https://koinote.example"}, pool)
	if storageMode == "r2" {
		enableRepositoryR2Fixture(t, app)
	}
	if storageMode == "r2" {
		defer func() {
			var n int
			err := pool.QueryRow(context.Background(), `SELECT count(*) FROM agent_workspace_blobs WHERE content IS NOT NULL`).Scan(&n)
			if err != nil || n != 0 {
				t.Errorf("R2 operation left %d database blobs: %v", n, err)
			}
		}()
	}
	owner := seedMCPUser(t, pool, app, membershipTierLifetime)
	recipient := seedMCPUser(t, pool, app, membershipTierLifetime)
	free := seedMCPUser(t, pool, app, membershipTierFree)
	for _, id := range []int{owner.ID, recipient.ID, free.ID} {
		if _, err := pool.Exec(ctx, `INSERT INTO agent_workspace_settings(user_id,enabled) VALUES($1,true)`, id); err != nil {
			t.Fatal(err)
		}
	}
	cookie := mcpSessionCookie(app, owner.AuthUserID)
	otherCookie := mcpSessionCookie(app, recipient.AuthUserID)
	callRepositoryAPI(t, app, nil, http.MethodPost, "/api/agent/workspaces/import/github", `{}`, 401)
	callRepositoryAPI(t, app, mcpSessionCookie(app, free.AuthUserID), http.MethodPost, "/api/agent/workspaces/import/github", `{}`, 403)
	token := "github_pat_saved_private_test_token"
	callRepositoryAPI(t, app, cookie, http.MethodPut, "/api/agent/github-credential", fmt.Sprintf(`{"token":%q}`, token), 200)
	credentials := callRepositoryAPI(t, app, cookie, http.MethodGet, "/api/agent/github-credential", "", 200)
	if strings.Contains(credentials.Body.String(), token) {
		t.Fatal("credential GET disclosed token")
	}
	var ciphertext []byte
	if err := pool.QueryRow(ctx, `SELECT token_ciphertext FROM agent_github_credentials WHERE user_id=$1`, owner.ID).Scan(&ciphertext); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(ciphertext, []byte(token)) {
		t.Fatal("token stored in plaintext")
	}
	otherCredentials := callRepositoryAPI(t, app, otherCookie, http.MethodGet, "/api/agent/github-credential", "", 200)
	if !strings.Contains(otherCredentials.Body.String(), `"configured":false`) {
		t.Fatal("credentials not isolated")
	}
	archive := githubArchive(t, githubArchiveEntry{"root/README.md", "# Demo", 0}, githubArchiveEntry{"root/LICENSE", "MPL-2.0", 0}, githubArchiveEntry{"root/skills/demo/SKILL.md", "Read me first", 0})
	app.githubHTTPClient = githubImportClient(t, archive, token, true)
	requestID, _ := randomUUID()
	body := fmt.Sprintf(`{"repositoryUrl":"https://github.com/octo/demo","requestId":%q,"author":"importer","sourceUrl":"https://evil.example"}`, requestID)
	imported := callRepositoryAPI(t, app, cookie, http.MethodPost, "/api/agent/workspaces/import/github", body, 201)
	var output struct {
		Workspace agentWorkspaceView `json:"workspace"`
	}
	decodeJSONResponse(t, imported, &output)
	workspace := output.Workspace
	if workspace.GitHubSource == nil || workspace.GitHubSource.Author != "Octo" || !workspace.GitHubSource.Private || workspace.GitHubSource.RepositoryURL != "https://github.com/Octo/demo" || workspace.GitHubSource.CommitSHA != githubTestSHA {
		t.Fatalf("bad origin %+v", workspace.GitHubSource)
	}
	// A retry must not use the network again or create another repository.
	app.githubHTTPClient = &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) {
		t.Error("completed retry refetched GitHub")
		return nil, errors.New("unexpected")
	})}
	repeated := callRepositoryAPI(t, app, cookie, http.MethodPost, "/api/agent/workspaces/import/github", body, 201)
	decodeJSONResponse(t, repeated, &output)
	if output.Workspace.WorkspaceID != workspace.WorkspaceID {
		t.Fatal("retry created duplicate import")
	}
	callRepositoryAPI(t, app, cookie, http.MethodPost, "/api/agent/workspaces/import/github", strings.Replace(body, "octo/demo", "octo/other", 1), 409)
	publicURL := fmt.Sprintf("/api/agent/repositories/%d", workspace.WorkspaceID)
	callRepositoryAPI(t, app, nil, http.MethodGet, publicURL, "", 404)
	sharing := fmt.Sprintf("/api/agent/workspaces/%d/sharing", workspace.WorkspaceID)
	callRepositoryAPI(t, app, cookie, http.MethodPut, sharing, `{"expectedRevision":0,"license":"MPL-2.0","githubSource":{"author":"forged"}}`, 200)
	published := callRepositoryAPI(t, app, nil, http.MethodGet, publicURL, "", 200)
	var detail struct {
		Repository agentRepositoryPublication `json:"repository"`
	}
	decodeJSONResponse(t, published, &detail)
	if detail.Repository.GitHubSource == nil || detail.Repository.GitHubSource.Author != "Octo" || detail.Repository.GitHubSource.Private || strings.Contains(published.Body.String(), token) || strings.Contains(published.Body.String(), "forged") || strings.Contains(published.Body.String(), `"private"`) {
		t.Fatalf("public provenance: %s", published.Body.String())
	}
	listing := callRepositoryAPI(t, app, nil, http.MethodGet, "/api/agent/repositories?q=demo", "", 200)
	if !strings.Contains(listing.Body.String(), `"author":"Octo"`) {
		t.Fatal("directory lost author")
	}
	// Editing and restoration never overwrite attribution. Publication remains frozen.
	edited, err := app.patchAgentWorkspace(ctx, owner.ID, workspace.WorkspaceID, 0, []agentWorkspaceFile{repositoryTestFile("README.md", "Edited in Koinote")}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if edited.GitHubSource == nil || edited.GitHubSource.Author != "Octo" {
		t.Fatal("edit lost original author")
	}
	restoreRevision := int64(0)
	restored, err := app.mutateAgentWorkspaceWithHistory(ctx, owner.ID, workspace.WorkspaceID, edited.Revision, nil, nil, false, &restoreRevision, false, "")
	if err != nil {
		t.Fatal(err)
	}
	if restored.GitHubSource == nil || restored.GitHubSource.Author != "Octo" {
		t.Fatal("restore lost original author")
	}
	forkRequest, _ := randomUUID()
	forked, err := app.forkAgentRepository(ctx, recipient.ID, workspace.WorkspaceID, 0, forkRequest)
	if err != nil {
		t.Fatal(err)
	}
	if forked.GitHubSource == nil || forked.GitHubSource.Author != "Octo" || forked.GitHubSource.RepositoryURL != workspace.GitHubSource.RepositoryURL {
		t.Fatal("fork lost original author/link")
	}
	if _, err = pool.Exec(ctx, `DELETE FROM agent_workspaces WHERE id=$1`, workspace.WorkspaceID); err != nil {
		t.Fatal(err)
	}
	if err = app.setAgentRepositoryPublication(ctx, recipient.ID, forked.WorkspaceID, 0, "MPL-2.0", false); err != nil {
		t.Fatal(err)
	}
	republished, err := app.loadPublicAgentRepository(ctx, forked.WorkspaceID, nil)
	if err != nil {
		t.Fatal(err)
	}
	if republished.GitHubSource.Author != "Octo" || republished.GitHubSource.CommitSHA != githubTestSHA {
		t.Fatal("republication lost provenance after deleting original import")
	}
	callRepositoryAPI(t, app, cookie, http.MethodDelete, "/api/agent/github-credential", "", 200)
	if credential, err := app.loadGitHubToken(ctx, owner.ID); err != nil || credential != "" {
		t.Fatal("token removal failed")
	}
	server := httptest.NewServer(app.Routes())
	defer server.Close()
	agent := createMCPTokenForTest(t, server, cookie, "Import scope", "agent_write")
	for _, route := range []struct{ method, path, body string }{{"POST", "/api/agent/workspaces/import/github", body}, {"PUT", "/api/agent/github-credential", fmt.Sprintf(`{"token":%q}`, token)}, {"GET", "/api/agent/github-credential", ""}} {
		req := httptest.NewRequest(route.method, route.path, strings.NewReader(route.body))
		req.Header.Set("Authorization", "Bearer "+agent.Secret)
		res := httptest.NewRecorder()
		app.Routes().ServeHTTP(res, req)
		if res.Code != 401 {
			t.Fatalf("agent token authorized %s %s: %d", route.method, route.path, res.Code)
		}
		if !desktopRequestAllowed(httptest.NewRequest(route.method, route.path, nil)) {
			t.Fatalf("desktop route blocked: %s", route.path)
		}
	}
}

func TestGitHubImportConcurrentRetryAndQuotaRollback(t *testing.T) {
	ctx := context.Background()
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "github-concurrency"}, pool)
	user := seedMCPUser(t, pool, app, membershipTierLifetime)
	if _, err := pool.Exec(ctx, `INSERT INTO agent_workspace_settings(user_id,enabled) VALUES($1,true)`, user.ID); err != nil {
		t.Fatal(err)
	}
	source := &agentGitHubSource{Author: "octo", AuthorURL: "https://github.com/octo", RepositoryURL: "https://github.com/octo/demo", CommitSHA: githubTestSHA, Ref: "main", License: "MIT"}
	requestID, _ := randomUUID()
	results := make(chan agentWorkspaceView, 2)
	failures := make(chan error, 2)
	var group sync.WaitGroup
	for i := 0; i < 2; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			w, err := app.importGitHubRepository(ctx, user.ID, requestID, "same-input", "Demo", "", []agentWorkspaceFile{repositoryTestFile("README.md", "hello")}, source)
			results <- w
			failures <- err
		}()
	}
	group.Wait()
	close(results)
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	var id int64
	for w := range results {
		if id != 0 && id != w.WorkspaceID {
			t.Fatal("concurrent retry created a second workspace")
		}
		id = w.WorkspaceID
	}
	// Valid one-megabyte files fill the quota without changing production limits.
	if _, err := pool.Exec(ctx, `INSERT INTO agent_workspace_files(workspace_id,path,content,mime_type,size_bytes,sha256) SELECT $1,n::text,convert_to(repeat('x',1000000),'UTF8'),'text/plain',1000000,encode(digest(repeat('x',1000000),'sha256'),'hex') FROM generate_series(1,100) n`, id); err != nil {
		t.Fatal(err)
	}
	requestID, _ = randomUUID()
	if _, err := app.importGitHubRepository(ctx, user.ID, requestID, "more", "Too big", "", []agentWorkspaceFile{repositoryTestFile("README.md", "hello")}, source); !errors.Is(err, errAgentWorkspaceQuota) {
		t.Fatalf("quota: %v", err)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM agent_workspaces WHERE user_id=$1`, user.ID).Scan(&count); err != nil || count != 1 {
		t.Fatal("failed import left partial repository")
	}
}

func TestGitHubImportExpiredCredentialAndExplicitMediaTypes(t *testing.T) {
	archive := githubArchive(t, githubArchiveEntry{"root/SKILL.md", "# Skill", 0})
	for _, names := range [][2]string{{"acme", "commits"}, {"commits", "demo"}} {
		t.Run(strings.Join(names[:], "/"), func(t *testing.T) {
			owner, repo := names[0], names[1]
			base := "/repos/" + owner + "/" + repo
			calls := 0
			app := &App{githubHTTPClient: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				calls++
				status, body := 200, ""
				accept := "application/vnd.github+json"
				if r.Header.Get("Authorization") != "" {
					status = 401
				} else {
					switch r.URL.Path {
					case base:
						body = fmt.Sprintf(`{"name":%q,"full_name":%q,"owner":{"login":%q},"default_branch":"main"}`, repo, owner+"/"+repo, owner)
					case base + "/commits/main":
						body = githubTestSHA
						accept = "application/vnd.github.sha"
					case base + "/zipball/" + githubTestSHA:
						body = string(archive)
					default:
						t.Fatalf("unexpected path %s", r.URL.Path)
					}
				}
				if r.Header.Get("Accept") != accept {
					t.Fatalf("wrong Accept on %s: %s", r.URL.Path, r.Header.Get("Accept"))
				}
				return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(body)), Request: r}, nil
			})}}
			_, files, source, err := app.fetchGitHubRepository(context.Background(), owner, repo, "", "expired-token")
			if err != nil || len(files) != 1 || source.Author != owner || calls != 4 {
				t.Fatalf("anonymous fallback failed: %v calls=%d", err, calls)
			}
		})
	}
	for _, status := range []int{http.StatusUnauthorized, http.StatusTooManyRequests} {
		calls := 0
		app := &App{githubHTTPClient: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			calls++
			code := status
			if r.Header.Get("Authorization") == "" {
				code = 404
			}
			return &http.Response{StatusCode: code, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
		})}}
		_, _, _, err := app.fetchGitHubRepository(context.Background(), "o", "r", "", "expired-token")
		if status == 401 && (!errors.Is(err, errAgentGitHubCredentialRequired) || calls != 2) {
			t.Fatalf("lost private repo credential guidance: %v", err)
		}
		if status == 429 && (!errors.Is(err, errAgentGitHubRateLimited) || calls != 1) {
			t.Fatalf("retried a rate limit anonymously: %v", err)
		}
	}
}
