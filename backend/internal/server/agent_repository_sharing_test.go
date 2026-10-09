package server

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"koinote/backend/internal/config"
	"koinote/backend/internal/model"
)

func callRepositoryAPI(t *testing.T, app *App, cookie *http.Cookie, method, url, body string, status int) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, url, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	if cookie != nil {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	app.Routes().ServeHTTP(w, r)
	if w.Code != status {
		t.Fatalf("%s %s: got %d, want %d: %s", method, url, w.Code, status, w.Body.String())
	}
	if w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("repository response must not be cached")
	}
	return w
}

func repositoryTestFile(path, content string) agentWorkspaceFile {
	hash := sha256.Sum256([]byte(content))
	return agentWorkspaceFile{Path: path, Content: []byte(content), MimeType: "text/plain", SHA256: hex.EncodeToString(hash[:])}
}

func TestAgentRepositoryPublicationSnapshotAndRevocation(t *testing.T) {
	ctx := context.Background()
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "repository-sharing-test", AppURL: "https://koinote.example"}, pool)
	owner := seedMCPUser(t, pool, app, membershipTierLifetime)
	other := seedMCPUser(t, pool, app, membershipTierLifetime)
	free := seedMCPUser(t, pool, app, membershipTierFree)
	for _, user := range []model.User{owner, other, free} {
		if _, err := pool.Exec(ctx, `INSERT INTO agent_workspace_settings(user_id,enabled) VALUES($1,true)`, user.ID); err != nil {
			t.Fatal(err)
		}
	}
	cookie := mcpSessionCookie(app, owner.AuthUserID)
	workspace, err := app.createAgentWorkspace(ctx, owner.ID, "Public skills", "Published description", "en")
	if err != nil {
		t.Fatal(err)
	}
	workspace, err = app.patchAgentWorkspace(ctx, owner.ID, workspace.WorkspaceID, workspace.Revision, []agentWorkspaceFile{repositoryTestFile("skills/demo/SKILL.md", "public v1")}, nil)
	if err != nil {
		t.Fatal(err)
	}
	base := fmt.Sprintf("/api/agent/repositories/%d", workspace.WorkspaceID)
	sharing := fmt.Sprintf("/api/agent/workspaces/%d/sharing", workspace.WorkspaceID)
	input := fmt.Sprintf(`{"expectedRevision":%d,"license":"MIT"}`, workspace.Revision)
	callRepositoryAPI(t, app, nil, http.MethodGet, base, "", 404)
	callRepositoryAPI(t, app, nil, http.MethodPut, sharing, input, 401)
	callRepositoryAPI(t, app, mcpSessionCookie(app, other.AuthUserID), http.MethodPut, sharing, input, 404)
	callRepositoryAPI(t, app, mcpSessionCookie(app, free.AuthUserID), http.MethodPut, sharing, input, 403)
	callRepositoryAPI(t, app, cookie, http.MethodPut, sharing, `{"expectedRevision":0,"license":"MIT"}`, 409)
	callRepositoryAPI(t, app, cookie, http.MethodPut, sharing, `{"expectedRevision":1,"license":"made-up"}`, 400)
	callRepositoryAPI(t, app, cookie, http.MethodPut, sharing, input, 200)
	response := callRepositoryAPI(t, app, nil, http.MethodGet, base, "", 200)
	var published struct {
		Repository agentRepositoryPublication `json:"repository"`
	}
	decodeJSONResponse(t, response, &published)
	if published.Repository.Revision != workspace.Revision || published.Repository.License != "MIT" || len(published.Repository.Files) != 2 {
		t.Fatalf("unexpected public metadata: %+v", published.Repository)
	}
	var fileID int64
	for _, file := range published.Repository.Files {
		if file.Path == "skills/demo/SKILL.md" {
			fileID = file.FileID
		}
	}
	fileURL := fmt.Sprintf("%s/files/%d?revision=%d", base, fileID, workspace.Revision)
	callRepositoryAPI(t, app, nil, http.MethodGet, fmt.Sprintf("%s/files/%d", base, fileID), "", 400)
	assertPublicFile := func() {
		t.Helper()
		res := callRepositoryAPI(t, app, nil, http.MethodGet, fileURL, "", 200)
		var value struct {
			File agentWorkspaceFileContentView `json:"file"`
		}
		decodeJSONResponse(t, res, &value)
		if value.File.ContentBase64 != base64.StdEncoding.EncodeToString([]byte("public v1")) {
			t.Fatal("private edit leaked into public snapshot")
		}
	}
	assertPublicFile()
	workspace, err = app.patchAgentWorkspace(ctx, owner.ID, workspace.WorkspaceID, workspace.Revision, []agentWorkspaceFile{repositoryTestFile("skills/demo/SKILL.md", "private v2"), repositoryTestFile("private.md", `api_key = "abcdefghijklmnopqrst1234"`)}, nil)
	if err != nil {
		t.Fatal(err)
	}
	input = fmt.Sprintf(`{"expectedRevision":%d,"license":"MIT","allowSensitive":true}`, workspace.Revision)
	callRepositoryAPI(t, app, cookie, http.MethodPut, sharing, input, 422)
	assertPublicFile()
	// Even after both history-retention paths remove the source commit, the
	// public blob survives and remains charged to its author's storage.
	if _, err = pool.Exec(ctx, `SELECT prune_agent_workspace_history($1,1),prune_agent_workspace_quota_history($1,1)`, workspace.WorkspaceID); err != nil {
		t.Fatal(err)
	}
	assertPublicFile()
	var oldCommits int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM agent_workspace_commits WHERE workspace_id=$1 AND revision=$2`, workspace.WorkspaceID, published.Repository.Revision).Scan(&oldCommits); err != nil {
		t.Fatal(err)
	}
	if oldCommits != 0 {
		t.Fatal("test did not actually prune the published commit")
	}
	var used, current int64
	if err = pool.QueryRow(ctx, `SELECT agent_workspace_storage_bytes($1),(SELECT sum(size_bytes) FROM agent_workspace_files WHERE workspace_id=$2)`, owner.ID, workspace.WorkspaceID).Scan(&used, &current); err != nil {
		t.Fatal(err)
	}
	if used != current+int64(len("public v1")) {
		t.Fatalf("public-only blob is not quota-accounted: %d vs %d", used, current)
	}
	// Withdraw after disabling sync and membership, so an account never loses
	// the ability to stop public access.
	if _, err = pool.Exec(ctx, `UPDATE agent_workspace_settings SET enabled=false WHERE user_id=$1`, owner.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `UPDATE users SET membership_tier='free' WHERE id=$1`, owner.ID); err != nil {
		t.Fatal(err)
	}
	ownerStatus := callRepositoryAPI(t, app, cookie, http.MethodGet, sharing, "", 200)
	var status struct {
		CurrentRevision int64 `json:"currentRevision"`
	}
	decodeJSONResponse(t, ownerStatus, &status)
	if status.CurrentRevision != workspace.Revision {
		t.Fatal("owner cannot discover the current revision for withdrawal")
	}
	callRepositoryAPI(t, app, cookie, http.MethodDelete, sharing, input, 200)
	callRepositoryAPI(t, app, nil, http.MethodGet, base, "", 404)
	callRepositoryAPI(t, app, nil, http.MethodGet, fileURL, "", 404)
	withdrawForkRequest, _ := randomUUID()
	callRepositoryAPI(t, app, mcpSessionCookie(app, other.AuthUserID), http.MethodPost, base+"/fork", fmt.Sprintf(`{"expectedRevision":%d,"requestId":%q}`, published.Repository.Revision, withdrawForkRequest), 404)
	var blobs int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM agent_workspace_blobs WHERE workspace_id=$1 AND content=$2`, workspace.WorkspaceID, []byte("public v1")).Scan(&blobs); err != nil {
		t.Fatal(err)
	}
	if blobs != 0 {
		t.Fatal("withdrawn unreferenced blob was not reclaimed")
	}
}

func TestAgentRepositoryForkIsolationIdempotencyAndQuota(t *testing.T) {
	ctx := context.Background()
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "fork-test", AppURL: "https://koinote.example"}, pool)
	owner := seedMCPUser(t, pool, app, membershipTierLifetime)
	dest := seedMCPUser(t, pool, app, membershipTierLifetime)
	free := seedMCPUser(t, pool, app, membershipTierFree)
	for _, user := range []model.User{owner, dest, free} {
		if _, err := pool.Exec(ctx, `INSERT INTO agent_workspace_settings(user_id,enabled) VALUES($1,true)`, user.ID); err != nil {
			t.Fatal(err)
		}
	}
	source, err := app.createAgentWorkspace(ctx, owner.ID, "Fork source", "From the author", "en")
	if err != nil {
		t.Fatal(err)
	}
	if err = app.setAgentRepositoryPublication(ctx, owner.ID, source.WorkspaceID, source.Revision, "MIT", false); err != nil {
		t.Fatal(err)
	}
	publishedRevision := source.Revision
	source, err = app.patchAgentWorkspace(ctx, owner.ID, source.WorkspaceID, source.Revision, []agentWorkspaceFile{repositoryTestFile("private.md", "must stay private")}, nil)
	if err != nil {
		t.Fatal(err)
	}
	requestID, _ := randomUUID()
	url := fmt.Sprintf("/api/agent/repositories/%d/fork", source.WorkspaceID)
	body := fmt.Sprintf(`{"expectedRevision":%d,"requestId":%q}`, publishedRevision, requestID)
	callRepositoryAPI(t, app, nil, http.MethodPost, url, body, 401)
	callRepositoryAPI(t, app, mcpSessionCookie(app, free.AuthUserID), http.MethodPost, url, body, 403)
	callRepositoryAPI(t, app, mcpSessionCookie(app, dest.AuthUserID), http.MethodPost, url, `{"expectedRevision":0}`, 400)
	// Two simultaneous attempts with the same key must commit exactly one copy.
	var wait sync.WaitGroup
	results := make(chan agentWorkspaceView, 2)
	failures := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			value, e := app.forkAgentRepository(ctx, dest.ID, source.WorkspaceID, publishedRevision, requestID)
			results <- value
			failures <- e
		}()
	}
	wait.Wait()
	close(results)
	close(failures)
	for failure := range failures {
		if failure != nil {
			t.Fatal(failure)
		}
	}
	var forkID int64
	for result := range results {
		if forkID != 0 && result.WorkspaceID != forkID {
			t.Fatal("retry created duplicate fork")
		}
		forkID = result.WorkspaceID
		if len(result.Files) != 1 || result.Files[0].Path != "README.md" {
			t.Fatal("fork copied private changes")
		}
	}
	var count int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM agent_workspaces WHERE user_id=$1`, dest.ID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("fork count %d: %v", count, err)
	}
	retry := callRepositoryAPI(t, app, mcpSessionCookie(app, dest.AuthUserID), http.MethodPost, url, body, 201)
	var copied struct {
		Workspace agentWorkspaceView `json:"workspace"`
	}
	decodeJSONResponse(t, retry, &copied)
	if copied.Workspace.WorkspaceID != forkID {
		t.Fatal("HTTP retry returned a different fork")
	}
	// Private destination; no public manifest, and owner cannot access its files.
	callRepositoryAPI(t, app, nil, http.MethodGet, fmt.Sprintf("/api/agent/repositories/%d", forkID), "", 404)
	callRepositoryAPI(t, app, mcpSessionCookie(app, owner.AuthUserID), http.MethodGet, fmt.Sprintf("/api/agent/workspaces/%d", forkID), "", 404)
	if err = app.setAgentRepositoryPublication(ctx, owner.ID, source.WorkspaceID, source.Revision, "MIT", false); err != nil {
		t.Fatal(err)
	}
	callRepositoryAPI(t, app, nil, http.MethodGet, fmt.Sprintf("/api/agent/repositories/%d?revision=%d", source.WorkspaceID, publishedRevision), "", 404)
	callRepositoryAPI(t, app, nil, http.MethodGet, fmt.Sprintf("/api/agent/repositories/%d/files/%d?revision=%d", source.WorkspaceID, source.Files[0].FileID, publishedRevision), "", 404)
	staleID, _ := randomUUID()
	_, err = app.forkAgentRepository(ctx, dest.ID, source.WorkspaceID, publishedRevision, staleID)
	if !errors.Is(err, errAgentWorkspaceConflict) {
		t.Fatalf("stale fork: %v", err)
	}
	// Source deletion revokes all public endpoints without deleting the fork.
	if _, err = pool.Exec(ctx, `DELETE FROM agent_workspaces WHERE id=$1`, source.WorkspaceID); err != nil {
		t.Fatal(err)
	}
	var provenance agentRepositorySource
	if err = pool.QueryRow(ctx, `SELECT source_workspace_id,source_revision,source_name,source_license FROM agent_repository_forks WHERE workspace_id=$1`, forkID).Scan(&provenance.WorkspaceID, &provenance.Revision, &provenance.Name, &provenance.License); err != nil {
		t.Fatal(err)
	}
	if provenance.WorkspaceID != nil || provenance.Name != "Fork source" || provenance.License != "MIT" || provenance.Revision != publishedRevision {
		t.Fatalf("lost provenance: %+v", provenance)
	}
	callRepositoryAPI(t, app, mcpSessionCookie(app, dest.AuthUserID), http.MethodGet, fmt.Sprintf("/api/agent/workspaces/%d", forkID), "", 200)
	callRepositoryAPI(t, app, nil, http.MethodGet, fmt.Sprintf("/api/agent/repositories/%d", source.WorkspaceID), "", 404)
	// Fill another member's quota with valid-sized files, and ensure a failed
	// fork leaves neither a destination repository nor a provenance record.
	full := seedMCPUser(t, pool, app, membershipTierLifetime)
	fullWorkspace, err := app.createAgentWorkspace(ctx, full.ID, "Full", "", "en")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `DELETE FROM agent_workspace_files WHERE workspace_id=$1`, fullWorkspace.WorkspaceID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO agent_workspace_files(workspace_id,path,content,mime_type,size_bytes,sha256) SELECT $1,n::text,convert_to(repeat('x',1000000),'UTF8'),'text/plain',1000000,encode(digest(repeat('x',1000000),'sha256'),'hex') FROM generate_series(1,100) n`, fullWorkspace.WorkspaceID); err != nil {
		t.Fatal(err)
	}
	if err = app.setAgentRepositoryPublication(ctx, dest.ID, forkID, 0, "MIT", false); err != nil {
		t.Fatal(err)
	}
	quotaRequest, _ := randomUUID()
	_, err = app.forkAgentRepository(ctx, full.ID, forkID, 0, quotaRequest)
	if !errors.Is(err, errAgentWorkspaceQuota) {
		t.Fatalf("quota overflow: %v", err)
	}
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM agent_workspaces WHERE user_id=$1`, full.ID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("quota failure left a repository: %d %v", count, err)
	}
}

func TestAgentRepositorySharingRejectsAgentTokensAndCredentialPaths(t *testing.T) {
	ctx := context.Background()
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "sharing-scope-test", AppURL: "https://koinote.example"}, pool)
	owner := seedMCPUser(t, pool, app, membershipTierLifetime)
	if _, err := pool.Exec(ctx, `INSERT INTO agent_workspace_settings(user_id,enabled) VALUES($1,true)`, owner.ID); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(app.Routes())
	defer server.Close()
	secret := createMCPTokenForTest(t, server, mcpSessionCookie(app, owner.AuthUserID), "Sharing writer", "agent_write")
	workspace, err := app.createAgentWorkspace(ctx, owner.ID, "Scope test", "", "en")
	if err != nil {
		t.Fatal(err)
	}
	for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodDelete} {
		req := httptest.NewRequest(method, fmt.Sprintf("/api/agent/workspaces/%d/sharing", workspace.WorkspaceID), strings.NewReader(`{"expectedRevision":0,"license":"MIT"}`))
		req.Header.Set("Authorization", "Bearer "+secret.Secret)
		res := httptest.NewRecorder()
		app.Routes().ServeHTTP(res, req)
		if res.Code != 401 {
			t.Fatalf("Agent token %s accepted: %d %s", method, res.Code, res.Body.String())
		}
	}
	for _, filePath := range []string{".env", ".dsh/.credentials.yaml", ".ssh/id_ed25519", ".codex/auth.json"} {
		updated, e := app.patchAgentWorkspace(ctx, owner.ID, workspace.WorkspaceID, workspace.Revision, []agentWorkspaceFile{repositoryTestFile(filePath, "innocent looking content")}, nil)
		if e != nil {
			t.Fatal(e)
		}
		workspace = updated
		err = app.setAgentRepositoryPublication(ctx, owner.ID, workspace.WorkspaceID, workspace.Revision, "MIT", false)
		var sensitive *agentWorkspaceSensitiveError
		if !errors.As(err, &sensitive) {
			t.Fatalf("credential file was published: %s %v", filePath, err)
		}
		workspace, err = app.patchAgentWorkspace(ctx, owner.ID, workspace.WorkspaceID, workspace.Revision, nil, []string{filePath})
		if err != nil {
			t.Fatal(err)
		}
	}
	for _, url := range []string{fmt.Sprintf("/api/agent/workspaces/%d/sharing", workspace.WorkspaceID), fmt.Sprintf("/api/agent/repositories/%d/fork", workspace.WorkspaceID)} {
		method := http.MethodPut
		if strings.HasSuffix(url, "/fork") {
			method = http.MethodPost
		}
		if !desktopRequestAllowed(httptest.NewRequest(method, url, nil)) {
			t.Fatalf("desktop route blocked: %s", url)
		}
		if desktopRequestAllowed(httptest.NewRequest(http.MethodPost, url+"/anything", nil)) {
			t.Fatalf("desktop route too broad: %s", url)
		}
	}
	// Published search is paginated and only searches frozen public metadata.
	for i := 0; i < publicRepositoryPageSize+1; i++ {
		w, e := app.createAgentWorkspace(ctx, owner.ID, fmt.Sprintf("Shared unique %02d", i), "", "en")
		if e != nil {
			t.Fatal(e)
		}
		if e = app.setAgentRepositoryPublication(ctx, owner.ID, w.WorkspaceID, w.Revision, "UNLICENSED", false); e != nil {
			t.Fatal(e)
		}
	}
	res := callRepositoryAPI(t, app, nil, http.MethodGet, "/api/agent/repositories?q=Shared%20unique", "", 200)
	var page struct {
		Repositories []json.RawMessage `json:"repositories"`
		NextCursor   *string           `json:"nextCursor"`
	}
	decodeJSONResponse(t, res, &page)
	if len(page.Repositories) != publicRepositoryPageSize || page.NextCursor == nil {
		t.Fatalf("bad first page: %+v", page)
	}
	res = callRepositoryAPI(t, app, nil, http.MethodGet, fmt.Sprintf("/api/agent/repositories?q=Shared%%20unique&cursor=%s", *page.NextCursor), "", 200)
	decodeJSONResponse(t, res, &page)
	if len(page.Repositories) != 1 || page.NextCursor != nil {
		t.Fatalf("bad second page: %+v", page)
	}
}

func TestAgentRepositoryScanDoesNotHoldOwnerWriteLock(t *testing.T) {
	ctx := context.Background()
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "scan-lock"}, pool)
	owner := seedMCPUser(t, pool, app, membershipTierLifetime)
	w, err := app.createAgentWorkspace(ctx, owner.ID, "Scan", "", "en")
	if err != nil {
		t.Fatal(err)
	}
	w, err = app.patchAgentWorkspace(ctx, owner.ID, w.WorkspaceID, w.Revision, []agentWorkspaceFile{repositoryTestFile(".env", "private content")}, nil)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, owner.ID); err != nil {
		t.Fatal(err)
	}
	scanCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	err = app.setAgentRepositoryPublication(scanCtx, owner.ID, w.WorkspaceID, w.Revision, "MIT", false)
	var sensitive *agentWorkspaceSensitiveError
	if !errors.As(err, &sensitive) {
		t.Fatalf("sensitive scan waited for owner write lock: %v", err)
	}
}

func TestAgentRepositoryPublicationRechecksRevisionAfterScan(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "scan-race"}, pool)
	owner := seedMCPUser(t, pool, app, membershipTierLifetime)
	w, err := app.createAgentWorkspace(ctx, owner.ID, "Scan race", "", "en")
	if err != nil {
		t.Fatal(err)
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, owner.ID); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		result <- app.setAgentRepositoryPublication(ctx, owner.ID, w.WorkspaceID, w.Revision, "MIT", false)
	}()
	// Wait until scanning is complete and publication is blocked on our write lock.
	for {
		var waiting bool
		if err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=$1::oid AND NOT granted)`, owner.ID).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case err := <-result:
			t.Fatalf("publish completed before the race: %v", err)
		case <-time.After(10 * time.Millisecond):
		}
	}
	if _, err = tx.Exec(ctx, `UPDATE agent_workspaces SET revision=revision+1 WHERE id=$1`, w.WorkspaceID); err != nil {
		t.Fatal(err)
	}
	secret := "api_key=abcdefghijklmnopqrst123456"
	if _, err = tx.Exec(ctx, `INSERT INTO agent_workspace_files(workspace_id,path,content,mime_type,sha256,size_bytes) VALUES($1,'secret.txt',convert_to($2,'UTF8'),'text/plain',encode(digest($2,'sha256'),'hex'),octet_length($2::text))`, w.WorkspaceID, secret); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err = <-result; !errors.Is(err, errAgentWorkspaceConflict) {
		t.Fatalf("unscanned revision published: %v", err)
	}
	var published bool
	if err = pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agent_repository_publications WHERE workspace_id=$1)`, w.WorkspaceID).Scan(&published); err != nil || published {
		t.Fatal("unreviewed content became public", err)
	}
}
