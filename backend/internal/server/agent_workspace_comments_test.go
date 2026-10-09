package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"

	"koinote/backend/internal/config"
)

func TestAgentWorkspaceChangeComments(t *testing.T) {
	ctx := context.Background()
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "change-comments", AppURL: "https://koinote.example"}, pool)
	user := seedMCPUser(t, pool, app, membershipTierLifetime)
	if _, err := pool.Exec(ctx, `INSERT INTO agent_workspace_settings(user_id,enabled) VALUES($1,true)`, user.ID); err != nil {
		t.Fatal(err)
	}
	w, err := app.createAgentWorkspace(ctx, user.ID, "Comments", "", "en")
	if err != nil {
		t.Fatal(err)
	}
	cookie := mcpSessionCookie(app, user.AuthUserID)
	server := httptest.NewServer(app.Routes())
	defer server.Close()
	token := createMCPTokenForTest(t, server, cookie, "File changes", "agent_write")
	base := fmt.Sprintf("/api/agent/workspaces/%d", w.WorkspaceID)
	patch := map[string]any{"expectedRevision": w.Revision, "upsert": []map[string]any{{"path": "note.txt", "contentBase64": "aGk="}}}
	call := func(method, path string, input any, want int) *httptest.ResponseRecorder {
		t.Helper()
		data, _ := json.Marshal(input)
		req := httptest.NewRequest(method, path, strings.NewReader(string(data)))
		req.Header.Set("Authorization", "Bearer "+token.Secret)
		req.Header.Set("Content-Type", "application/json")
		res := httptest.NewRecorder()
		app.Routes().ServeHTTP(res, req)
		if res.Code != want {
			t.Fatalf("%s: %d %s", path, res.Code, res.Body.String())
		}
		return res
	}
	for _, comment := range []string{strings.Repeat("字", 501), "bad\x00text"} {
		patch["comment"] = comment
		call("PATCH", base, patch, 400)
	}
	patch["comment"] = "api_key=abcdefghijklmnopqrst123456"
	resSensitive := call("PATCH", base, patch, 422)
	if !strings.Contains(resSensitive.Body.String(), `"code":"sensitive_comment"`) {
		t.Fatal("comment error confused with file sensitivity")
	}
	patch["allowSensitive"] = true
	call("PATCH", base, patch, 422)
	current, err := app.loadAgentWorkspace(ctx, user.ID, w.WorkspaceID)
	if err != nil || current.Revision != w.Revision {
		t.Fatal("invalid description mutated repository", err)
	}
	// Legacy complete replacement also omits the new field.
	putResponse := call("PUT", base, map[string]any{"expectedRevision": current.Revision, "files": patch["upsert"]}, 200)
	var legacyPut struct {
		Workspace agentWorkspaceView `json:"workspace"`
	}
	decodeJSONResponse(t, putResponse, &legacyPut)
	current = legacyPut.Workspace
	// Legacy REST callers may omit or send whitespace descriptions.
	for _, comment := range []any{nil, " \t\n"} {
		patch["expectedRevision"] = current.Revision
		if comment == nil {
			delete(patch, "comment")
		} else {
			patch["comment"] = comment
		}
		response := call("PATCH", base, patch, 200)
		var legacy struct {
			Workspace agentWorkspaceView `json:"workspace"`
		}
		decodeJSONResponse(t, response, &legacy)
		current = legacy.Workspace
	}
	patch["expectedRevision"] = current.Revision
	patch["comment"] = "  更新技能说明 📝\n"
	res := call("PATCH", base, patch, 200)
	var result struct {
		Workspace agentWorkspaceView `json:"workspace"`
	}
	decodeJSONResponse(t, res, &result)
	current = result.Workspace
	page, err := app.listAgentWorkspaceCommits(ctx, user.ID, w.WorkspaceID, nil)
	if err != nil || page.Commits[0].Comment != "更新技能说明 📝" {
		t.Fatal("history lost description", err)
	}
	restore := fmt.Sprintf("%s/commits/0/restore", base)
	res = call("POST", restore, map[string]any{"expectedRevision": current.Revision}, 200)
	decodeJSONResponse(t, res, &result)
	current = result.Workspace
	res = call("POST", restore, map[string]any{"expectedRevision": current.Revision, "comment": "Restore original instructions"}, 200)
	decodeJSONResponse(t, res, &result)
	current = result.Workspace
	view, err := app.loadAgentWorkspaceCommit(ctx, user.ID, w.WorkspaceID, current.Revision)
	if err != nil || view.Commit.Comment != "Restore original instructions" {
		t.Fatal("restore comment not atomic", err)
	}
	client, err := connectMCPClient(ctx, server.URL+"/mcp", token.Secret)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	args := map[string]any{"workspaceId": w.WorkspaceID, "expectedRevision": current.Revision, "upsert": patch["upsert"]}
	decodeMCPStructured(t, callMCPToolOK(t, client, "update_agent_workspace", args), &current)
	args["expectedRevision"] = current.Revision
	args["comment"] = "MCP: add a note"
	decodeMCPStructured(t, callMCPToolOK(t, client, "update_agent_workspace", args), &current)
	page, err = app.listAgentWorkspaceCommits(ctx, user.ID, w.WorkspaceID, nil)
	if err != nil || page.Commits[0].Comment != "MCP: add a note" {
		t.Fatal("MCP history description missing", err)
	}
	restoreArgs := map[string]any{"workspaceId": w.WorkspaceID, "expectedRevision": current.Revision, "revision": 0}
	decodeMCPStructured(t, callMCPToolOK(t, client, "restore_agent_workspace_commit", restoreArgs), &current)
	restoreArgs["expectedRevision"] = current.Revision
	restoreArgs["comment"] = "MCP: restore baseline"
	decodeMCPStructured(t, callMCPToolOK(t, client, "restore_agent_workspace_commit", restoreArgs), &current)
	view, err = app.loadAgentWorkspaceCommit(ctx, user.ID, w.WorkspaceID, current.Revision)
	if err != nil || view.Commit.Comment != "MCP: restore baseline" {
		t.Fatal("MCP restore description missing", err)
	}
	// Browser writes remain backwards compatible when no description is supplied.
	callRepositoryAPI(t, app, cookie, "PATCH", base, fmt.Sprintf(`{"expectedRevision":%d,"upsert":[{"path":"note.txt","contentBase64":"aGk="}]}`, current.Revision), 200)
	if _, err = validateAgentWorkspaceComment(strings.Repeat("📝", 500)); err != nil {
		t.Fatal("Unicode limit counted bytes", err)
	}
}
