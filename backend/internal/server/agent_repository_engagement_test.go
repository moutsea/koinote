package server

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"koinote/backend/internal/config"
)

func TestAgentRepositoryEngagementAndPublicationOrder(t *testing.T) {
	ctx := context.Background()
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "engagement", AppURL: "https://koinote.example"}, pool)
	owner := seedMCPUser(t, pool, app, membershipTierLifetime)
	free := seedMCPUser(t, pool, app, membershipTierFree)
	if _, err := pool.Exec(ctx, `INSERT INTO agent_workspace_settings(user_id,enabled) VALUES($1,true)`, owner.ID); err != nil {
		t.Fatal(err)
	}
	w, err := app.createAgentWorkspace(ctx, owner.ID, "Older repository", "", "en")
	if err != nil {
		t.Fatal(err)
	}
	if err = app.setAgentRepositoryPublication(ctx, owner.ID, w.WorkspaceID, w.Revision, "MIT", false); err != nil {
		t.Fatal(err)
	}
	newer, err := app.createAgentWorkspace(ctx, owner.ID, "Newer repository", "", "en")
	if err != nil {
		t.Fatal(err)
	}
	if err = app.setAgentRepositoryPublication(ctx, owner.ID, newer.WorkspaceID, newer.Revision, "MIT", false); err != nil {
		t.Fatal(err)
	}
	// Republish the older repository: public update time, not creation ID, defines order.
	if err = app.setAgentRepositoryPublication(ctx, owner.ID, w.WorkspaceID, w.Revision, "MIT", false); err != nil {
		t.Fatal(err)
	}
	var page struct {
		Repositories []agentRepositoryPublication `json:"repositories"`
	}
	decodeJSONResponse(t, callRepositoryAPI(t, app, nil, "GET", "/api/agent/repositories", "", 200), &page)
	if len(page.Repositories) != 2 || page.Repositories[0].WorkspaceID != w.WorkspaceID {
		t.Fatal("public update order is incorrect")
	}
	base := fmt.Sprintf("/api/agent/repositories/%d", w.WorkspaceID)
	cookie := mcpSessionCookie(app, free.AuthUserID)
	callRepositoryAPI(t, app, nil, "PUT", base+"/star", "", 401)
	for range 2 {
		callRepositoryAPI(t, app, cookie, "PUT", base+"/star", "", 200)
	}
	var detail struct {
		Repository agentRepositoryPublication `json:"repository"`
	}
	decodeJSONResponse(t, callRepositoryAPI(t, app, cookie, "GET", base, "", 200), &detail)
	if detail.Repository.StarCount != 1 || !detail.Repository.Starred {
		t.Fatal("repeat Star was not idempotent")
	}
	decodeJSONResponse(t, callRepositoryAPI(t, app, nil, "GET", base, "", 200), &detail)
	if detail.Repository.StarCount != 1 || detail.Repository.Starred {
		t.Fatal("anonymous view leaked starred state")
	}
	requestID, _ := randomUUID()
	body := fmt.Sprintf(`{"expectedRevision":%d,"requestId":%q,"method":"agent"}`, w.Revision, requestID)
	for range 2 {
		callRepositoryAPI(t, app, nil, "POST", base+"/clone", body, 200)
	}
	var actor *int
	var revision int64
	if err = pool.QueryRow(ctx, `SELECT user_id,revision FROM agent_repository_clones WHERE request_id=$1::uuid`, requestID).Scan(&actor, &revision); err != nil || actor != nil || revision != w.Revision {
		t.Fatal("anonymous Clone recorded identity or wrong revision", err)
	}
	callRepositoryAPI(t, app, cookie, "POST", base+"/clone", body, 409)
	callRepositoryAPI(t, app, nil, "POST", base+"/clone", strings.Replace(body, `"agent"`, `"zip"`, 1), 409)
	requestID, _ = randomUUID()
	body = fmt.Sprintf(`{"expectedRevision":%d,"requestId":%q,"method":"zip"}`, w.Revision, requestID)
	callRepositoryAPI(t, app, cookie, "POST", base+"/clone", body, 200)
	if err = pool.QueryRow(ctx, `SELECT user_id FROM agent_repository_clones WHERE request_id=$1::uuid`, requestID).Scan(&actor); err != nil || actor == nil || *actor != free.ID {
		t.Fatal("signed-in Clone lost actor", err)
	}
	decodeJSONResponse(t, callRepositoryAPI(t, app, nil, "GET", base, "", 200), &detail)
	if detail.Repository.CloneCount != 2 {
		t.Fatal("retry inflated Clone count")
	}
	callRepositoryAPI(t, app, cookie, "DELETE", base+"/star", "", 200)
	// Concurrent retries must still create a single Star and a single Clone record.
	requestID, _ = randomUUID()
	body = fmt.Sprintf(`{"expectedRevision":%d,"requestId":%q,"method":"home"}`, w.Revision, requestID)
	routes := app.Routes()
	statuses := make(chan int, 6)
	for range 3 {
		for _, endpoint := range []string{"star", "clone"} {
			go func(endpoint string) {
				method := http.MethodPost
				if endpoint == "star" {
					method = http.MethodPut
				}
				req := httptest.NewRequest(method, base+"/"+endpoint, strings.NewReader(body))
				req.Header.Set("Content-Type", "application/json")
				req.AddCookie(cookie)
				res := httptest.NewRecorder()
				routes.ServeHTTP(res, req)
				statuses <- res.Code
			}(endpoint)
		}
	}
	for range 6 {
		if code := <-statuses; code != http.StatusOK {
			t.Errorf("concurrent interaction returned %d", code)
		}
	}
	decodeJSONResponse(t, callRepositoryAPI(t, app, cookie, "GET", base, "", 200), &detail)
	if detail.Repository.StarCount != 1 || !detail.Repository.Starred || detail.Repository.CloneCount != 3 {
		t.Fatal("concurrent retries duplicated engagement")
	}
	server := httptest.NewServer(app.Routes())
	defer server.Close()
	token := createMCPTokenForTest(t, server, mcpSessionCookie(app, owner.AuthUserID), "No social writes", "agent_write")
	req := httptest.NewRequest("PUT", base+"/star", nil)
	req.Header.Set("Authorization", "Bearer "+token.Secret)
	res := httptest.NewRecorder()
	app.Routes().ServeHTTP(res, req)
	if res.Code != http.StatusUnauthorized {
		t.Fatal("Agent token could Star")
	}
	if err = app.setAgentRepositoryPublication(ctx, owner.ID, w.WorkspaceID, w.Revision, "", true); err != nil {
		t.Fatal(err)
	}
	callRepositoryAPI(t, app, cookie, "PUT", base+"/star", "", 404)
	callRepositoryAPI(t, app, cookie, "POST", base+"/clone", body, 404)
	for _, cursor := range []string{"garbage", strings.Repeat("A", 401)} {
		callRepositoryAPI(t, app, nil, "GET", "/api/agent/repositories?cursor="+cursor, "", 400)
	}
}

func TestPublicRepositoryForwardedIPRequiresTrustedProxy(t *testing.T) {
	app := New(config.Config{InternalToken: "internal-review-token"}, nil)
	req := httptest.NewRequest("POST", "/api/agent/repositories/1/clone", nil)
	req.RemoteAddr = "192.0.2.1:3456"
	req.Header.Set("X-Forwarded-For", "203.0.113.10")
	if got := app.publicRepositoryRequestIP(req); got != "192.0.2.1" {
		t.Fatal("untrusted XFF used", got)
	}
	req.Header.Set("X-Koinote-Internal-Token", "internal-review-token")
	if got := app.publicRepositoryRequestIP(req); got != "203.0.113.10" {
		t.Fatal("trusted Worker IP ignored", got)
	}
	req.Header.Set("X-Forwarded-For", "203.0.113.10, 192.0.2.2")
	if got := app.publicRepositoryRequestIP(req); got != "192.0.2.1" {
		t.Fatal("ambiguous forwarding chain trusted", got)
	}
	for i := 0; i < 31; i++ {
		req := httptest.NewRequest("POST", "/api/agent/repositories/1/clone", strings.NewReader("{}"))
		req.Header.Set("X-Forwarded-For", fmt.Sprintf("203.0.113.%d", i))
		res := httptest.NewRecorder()
		app.publicAgentRepositoryClone(res, req)
		want := 400
		if i == 30 {
			want = 429
		}
		if res.Code != want {
			t.Fatalf("request %d: %d", i, res.Code)
		}
	}
}

func TestAgentRepositoryCloneCleanupRetainsCounters(t *testing.T) {
	ctx := context.Background()
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "clone-retention"}, pool)
	owner := seedMCPUser(t, pool, app, membershipTierLifetime)
	w, err := app.createAgentWorkspace(ctx, owner.ID, "Retention", "", "en")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO agent_repository_clones(request_id,workspace_id,revision,method,created_at) VALUES(gen_random_uuid(),$1,0,'zip',now()-interval '31 days'),(gen_random_uuid(),$1,0,'home',now())`, w.WorkspaceID); err != nil {
		t.Fatal(err)
	}
	if err = app.cleanupAgentRepositoryClones(ctx); err != nil {
		t.Fatal(err)
	}
	var retained int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM agent_repository_clones WHERE workspace_id=$1`, w.WorkspaceID).Scan(&retained); err != nil || retained != 1 {
		t.Fatalf("retained=%d %v", retained, err)
	}
	stats, err := loadAgentRepositoryEngagement(ctx, pool, w.WorkspaceID, nil)
	if err != nil || stats.CloneCount != 2 {
		t.Fatalf("cleanup changed lifetime counts: %+v %v", stats, err)
	}
}
