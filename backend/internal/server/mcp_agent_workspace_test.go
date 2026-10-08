package server

import (
	"context"
	"encoding/base64"
	"fmt"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"koinote/backend/internal/config"
	"koinote/backend/internal/model"
)

func TestMCPAgentRepositoriesEndToEnd(t *testing.T) {
	ctx := context.Background()
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "repository-mcp-test", AppURL: "http://127.0.0.1"}, pool)
	server := httptest.NewServer(app.Routes())
	t.Cleanup(server.Close)
	owner := seedMCPUser(t, pool, app, membershipTierLifetime)
	other := seedMCPUser(t, pool, app, membershipTierLifetime)
	for _, user := range []model.User{owner, other} {
		if _, err := pool.Exec(ctx, `INSERT INTO agent_workspace_settings (user_id, enabled) VALUES ($1, true)`, user.ID); err != nil {
			t.Fatal(err)
		}
	}
	ownerCookie := mcpSessionCookie(app, owner.AuthUserID)
	writerToken := createMCPTokenForTest(t, server, ownerCookie, "Repository writer", "agent_write")
	readerToken := createMCPTokenForTest(t, server, ownerCookie, "Repository reader", "agent_read")
	otherToken := createMCPTokenForTest(t, server, mcpSessionCookie(app, other.AuthUserID), "Other repository writer", "agent_write")
	docToken := createMCPTokenForTest(t, server, ownerCookie, "Documents", "write")
	connect := func(secret string) *mcp.ClientSession {
		t.Helper()
		session, err := connectMCPClient(ctx, server.URL+"/mcp", secret)
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = session.Close() })
		return session
	}
	writer, reader, stranger, documents := connect(writerToken.Secret), connect(readerToken.Secret), connect(otherToken.Secret), connect(docToken.Secret)
	readTools := []string{"list_agent_workspaces", "get_agent_workspace", "read_agent_workspace_file", "get_agent_workspace_prompt", "get_agent_workspace_storage", "list_agent_workspace_commits", "get_agent_workspace_commit", "read_agent_workspace_commit_file"}
	assertMCPToolSet(t, reader, readTools)
	assertMCPToolSet(t, writer, append(slices.Clone(readTools), "create_agent_workspace", "manage_agent_workspace", "update_agent_workspace", "restore_agent_workspace_commit"))
	if got := writer.InitializeResult().ServerInfo.Name; got != "koinote-agent" {
		t.Fatalf("repository server identity = %q", got)
	}
	if got := documents.InitializeResult().ServerInfo.Name; got != "koinote" {
		t.Fatalf("document server identity = %q", got)
	}
	assertRejected := func(session *mcp.ClientSession, name string, args any) {
		t.Helper()
		result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: name, Arguments: args})
		if err == nil && !result.IsError {
			t.Fatalf("%s unexpectedly succeeded", name)
		}
	}
	assertRejected(reader, "create_agent_workspace", map[string]any{"name": "Forbidden"})
	assertRejected(documents, "list_agent_workspaces", map[string]any{})
	assertRejected(writer, "list_documents", map[string]any{})
	assertRejected(writer, "allocate_agent_workspace_storage", map[string]any{"allocatedBytes": 1024})

	var empty mcpAgentWorkspaceListOutput
	decodeMCPStructured(t, callMCPToolOK(t, reader, "list_agent_workspaces", map[string]any{}), &empty)
	if len(empty.Workspaces) != 0 {
		t.Fatal("new account unexpectedly contains repositories")
	}
	var workspace agentWorkspaceView
	decodeMCPStructured(t, callMCPToolOK(t, writer, "create_agent_workspace", map[string]any{"name": "Writing skills", "locale": "zh"}), &workspace)
	id := workspace.WorkspaceID
	var listed mcpAgentWorkspaceListOutput
	decodeMCPStructured(t, callMCPToolOK(t, reader, "list_agent_workspaces", map[string]any{}), &listed)
	if len(listed.Workspaces) != 1 || listed.Workspaces[0].WorkspaceID != id {
		t.Fatalf("repository discovery failed: %+v", listed)
	}
	content := "# 写作 Skill\n\n保留原始格式与 Unicode。\n"
	fileInput := func(text string) map[string]any {
		return map[string]any{"path": "skills/writing/SKILL.md", "mimeType": "text/markdown", "contentBase64": base64.StdEncoding.EncodeToString([]byte(text))}
	}
	decodeMCPStructured(t, callMCPToolOK(t, writer, "update_agent_workspace", map[string]any{
		"workspaceId": id, "expectedRevision": workspace.Revision, "upsert": []any{fileInput(content)},
	}), &workspace)
	originalRevision := workspace.Revision
	var originalFile agentWorkspaceFileView
	for _, file := range workspace.Files {
		if file.Path == "skills/writing/SKILL.md" {
			originalFile = file
		}
	}
	var file agentWorkspaceFileContentView
	decodeMCPStructured(t, callMCPToolOK(t, reader, "read_agent_workspace_file", map[string]any{"fileId": originalFile.FileID}), &file)
	if file.ContentBase64 != base64.StdEncoding.EncodeToString([]byte(content)) || originalFile.FileID == 0 {
		t.Fatalf("file content did not round-trip: %+v", file)
	}
	assertRejected(reader, "update_agent_workspace", map[string]any{"workspaceId": id, "expectedRevision": workspace.Revision, "delete": []string{originalFile.Path}})
	assertRejected(writer, "update_agent_workspace", map[string]any{"workspaceId": id, "expectedRevision": workspace.Revision - 1, "delete": []string{originalFile.Path}})
	assertRejected(writer, "update_agent_workspace", map[string]any{"workspaceId": id, "upsert": []any{fileInput("Missing revision")}})
	assertRejected(writer, "update_agent_workspace", map[string]any{"workspaceId": id, "expectedRevision": workspace.Revision, "upsert": []any{fileInput("api_key=sk-abcdefghijklmnopqrstuvwxyz1234567890")}})

	decodeMCPStructured(t, callMCPToolOK(t, writer, "manage_agent_workspace", map[string]any{
		"workspaceId": id, "expectedRevision": workspace.Revision, "name": "Renamed skills", "description": "Current description",
	}), &workspace)
	decodeMCPStructured(t, callMCPToolOK(t, writer, "update_agent_workspace", map[string]any{
		"workspaceId": id, "expectedRevision": workspace.Revision, "delete": []string{originalFile.Path},
	}), &workspace)
	for _, current := range workspace.Files {
		if current.Path == originalFile.Path {
			t.Fatal("file deletion was not applied")
		}
	}
	var history agentWorkspaceCommitPage
	decodeMCPStructured(t, callMCPToolOK(t, reader, "list_agent_workspace_commits", map[string]any{"workspaceId": id}), &history)
	if len(history.Commits) < 3 || history.Commits[0].Revision != workspace.Revision || history.NextBefore != nil {
		t.Fatalf("unexpected repository history: %+v", history)
	}
	var commit agentWorkspaceCommitView
	decodeMCPStructured(t, callMCPToolOK(t, reader, "get_agent_workspace_commit", map[string]any{"workspaceId": id, "revision": originalRevision}), &commit)
	if commit.Commit.Revision != originalRevision || len(commit.Files) != 2 {
		t.Fatalf("historical manifest = %+v", commit)
	}
	var historicalFile agentWorkspaceCommitFileContent
	decodeMCPStructured(t, callMCPToolOK(t, reader, "read_agent_workspace_commit_file", map[string]any{"workspaceId": id, "revision": originalRevision, "path": originalFile.Path}), &historicalFile)
	if historicalFile.ContentBase64 != file.ContentBase64 || historicalFile.SHA256 != originalFile.SHA256 {
		t.Fatalf("historical file differs: %+v", historicalFile)
	}
	for _, bad := range []struct {
		name string
		args map[string]any
	}{
		{"get_agent_workspace", map[string]any{"workspaceId": id}},
		{"read_agent_workspace_file", map[string]any{"fileId": workspace.Files[0].FileID}},
		{"list_agent_workspace_commits", map[string]any{"workspaceId": id}},
		{"get_agent_workspace_commit", map[string]any{"workspaceId": id, "revision": originalRevision}},
		{"read_agent_workspace_commit_file", map[string]any{"workspaceId": id, "revision": originalRevision, "path": originalFile.Path}},
		{"restore_agent_workspace_commit", map[string]any{"workspaceId": id, "revision": originalRevision, "expectedRevision": workspace.Revision}},
		{"manage_agent_workspace", map[string]any{"workspaceId": id, "expectedRevision": workspace.Revision, "delete": true}},
	} {
		assertRejected(stranger, bad.name, bad.args)
	}
	for _, args := range []map[string]any{
		{"workspaceId": 0}, {"workspaceId": id, "before": -1},
	} {
		assertRejected(reader, "list_agent_workspace_commits", args)
	}
	assertRejected(reader, "get_agent_workspace_commit", map[string]any{"workspaceId": id, "revision": -1})
	assertRejected(reader, "read_agent_workspace_commit_file", map[string]any{"workspaceId": id, "revision": originalRevision, "path": "../private.txt"})
	assertRejected(reader, "get_agent_workspace_commit", map[string]any{"workspaceId": id, "revision": workspace.Revision + 100})
	assertRejected(reader, "restore_agent_workspace_commit", map[string]any{"workspaceId": id, "revision": originalRevision, "expectedRevision": workspace.Revision})
	assertRejected(writer, "restore_agent_workspace_commit", map[string]any{"workspaceId": id, "revision": originalRevision, "expectedRevision": workspace.Revision - 1})
	assertRejected(writer, "restore_agent_workspace_commit", map[string]any{"workspaceId": id, "revision": originalRevision})
	previousRevision := workspace.Revision
	decodeMCPStructured(t, callMCPToolOK(t, writer, "restore_agent_workspace_commit", map[string]any{
		"workspaceId": id, "revision": originalRevision, "expectedRevision": previousRevision,
	}), &workspace)
	if workspace.Revision != previousRevision+1 || workspace.Name != "Renamed skills" || workspace.Description != "Current description" || len(workspace.Files) != 2 {
		t.Fatalf("restore did not preserve current metadata and create a revision: %+v", workspace)
	}
	var restored agentWorkspaceCommitView
	decodeMCPStructured(t, callMCPToolOK(t, reader, "get_agent_workspace_commit", map[string]any{"workspaceId": id, "revision": workspace.Revision}), &restored)
	if restored.Commit.Action != "restore" || restored.Commit.RestoredFrom == nil || *restored.Commit.RestoredFrom != originalRevision {
		t.Fatalf("restore provenance missing: %+v", restored.Commit)
	}
	for _, current := range workspace.Files {
		if current.Path == originalFile.Path && current.SHA256 != originalFile.SHA256 {
			t.Fatal("restore changed file bytes")
		}
	}
	if _, err := app.allocateAgentWorkspaceStorage(ctx, owner, 2<<20); err != nil {
		t.Fatal(err)
	}
	var storage map[string]any
	decodeMCPStructured(t, callMCPToolOK(t, reader, "get_agent_workspace_storage", map[string]any{}), &storage)
	if len(storage) != 4 || storage["usedBytes"].(float64) <= 0 || storage["quotaBytes"] != float64(agentWorkspaceDefaultQuotaBytes+2<<20) || storage["allocatedBytes"] != float64(2<<20) {
		t.Fatalf("storage quota or privacy boundary incorrect: %v", storage)
	}
	// The same history readers back the existing web endpoints.
	response := requestMCPTokenAPI(t, server.Client(), "GET", fmt.Sprintf("%s/api/agent/workspaces/%d/commits/%d", server.URL, id, originalRevision), ownerCookie, nil)
	defer response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatalf("HTTP history regressed: %d", response.StatusCode)
	}
	callMCPToolOK(t, writer, "manage_agent_workspace", map[string]any{"workspaceId": id, "expectedRevision": workspace.Revision, "delete": true})
	assertRejected(reader, "get_agent_workspace_commit", map[string]any{"workspaceId": id, "revision": originalRevision})

	t.Run("pagination", func(t *testing.T) {
		paged, err := app.createAgentWorkspace(ctx, owner.ID, "History pages", "", "en")
		if err != nil {
			t.Fatal(err)
		}
		for i := 0; i < 28; i++ {
			paged, err = app.patchAgentWorkspace(ctx, owner.ID, paged.WorkspaceID, paged.Revision, []agentWorkspaceFile{{Path: "note.txt", Content: []byte(fmt.Sprint(i)), MimeType: "text/plain"}}, nil)
			if err != nil {
				t.Fatal(err)
			}
		}
		var first, second agentWorkspaceCommitPage
		decodeMCPStructured(t, callMCPToolOK(t, reader, "list_agent_workspace_commits", map[string]any{"workspaceId": paged.WorkspaceID}), &first)
		if len(first.Commits) != 25 || first.NextBefore == nil {
			t.Fatalf("first page: %+v", first)
		}
		decodeMCPStructured(t, callMCPToolOK(t, reader, "list_agent_workspace_commits", map[string]any{"workspaceId": paged.WorkspaceID, "before": *first.NextBefore}), &second)
		if len(second.Commits) == 0 || second.NextBefore != nil || second.Commits[0].Revision >= *first.NextBefore {
			t.Fatalf("next page: %+v", second)
		}
	})

	var audited int
	if err := pool.QueryRow(ctx, `SELECT count(DISTINCT tool_name) FROM mcp_audit_logs WHERE user_id = $1 AND result = 'success' AND tool_name IN ('list_agent_workspaces', 'get_agent_workspace_storage', 'list_agent_workspace_commits', 'get_agent_workspace_commit', 'read_agent_workspace_commit_file', 'restore_agent_workspace_commit')`, owner.ID).Scan(&audited); err != nil || audited != 6 {
		t.Fatalf("repository audit missing: count=%d err=%v", audited, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE agent_workspace_settings SET enabled = false WHERE user_id = $1`, owner.ID); err != nil {
		t.Fatal(err)
	}
	assertRejected(writer, "list_agent_workspaces", map[string]any{})
	if _, err := pool.Exec(ctx, `UPDATE agent_workspace_settings SET enabled = true WHERE user_id = $1`, owner.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE mcp_tokens SET revoked_at = now() WHERE token_id = $1`, readerToken.Token.TokenID); err != nil {
		t.Fatal(err)
	}
	assertRejected(reader, "get_agent_workspace_storage", map[string]any{})
	if _, err := pool.Exec(ctx, `UPDATE mcp_tokens SET expires_at = now() - interval '1 second' WHERE token_id = $1`, writerToken.Token.TokenID); err != nil {
		t.Fatal(err)
	}
	assertRejected(writer, "list_agent_workspaces", map[string]any{})
	if _, err := pool.Exec(ctx, `UPDATE mcp_tokens SET expires_at = NULL WHERE token_id = $1`, writerToken.Token.TokenID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE users SET membership_tier = 'free' WHERE id = $1`, owner.ID); err != nil {
		t.Fatal(err)
	}
	assertRejected(writer, "list_agent_workspaces", map[string]any{})
}

func TestMCPAgentRepositoryAcceptsMaximumFileSize(t *testing.T) {
	ctx := context.Background()
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "large-repository-mcp-test", AppURL: "http://127.0.0.1"}, pool)
	server := httptest.NewServer(app.Routes())
	t.Cleanup(server.Close)
	owner := seedMCPUser(t, pool, app, membershipTierLifetime)
	if _, err := pool.Exec(ctx, `INSERT INTO agent_workspace_settings (user_id, enabled) VALUES ($1, true)`, owner.ID); err != nil {
		t.Fatal(err)
	}
	token := createMCPTokenForTest(t, server, mcpSessionCookie(app, owner.AuthUserID), "Large repository files", "agent_write")
	client, err := connectMCPClient(ctx, server.URL+"/mcp", token.Secret)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	var workspace agentWorkspaceView
	decodeMCPStructured(t, callMCPToolOK(t, client, "create_agent_workspace", map[string]any{"name": "Large files"}), &workspace)
	encoded := base64.StdEncoding.EncodeToString([]byte(strings.Repeat("a", agentWorkspaceMaxFileBytes)))
	decodeMCPStructured(t, callMCPToolOK(t, client, "update_agent_workspace", map[string]any{
		"workspaceId": workspace.WorkspaceID, "expectedRevision": workspace.Revision,
		"upsert": []map[string]any{{"path": "large.txt", "contentBase64": encoded}},
	}), &workspace)
	for _, f := range workspace.Files {
		if f.Path != "large.txt" {
			continue
		}
		for _, tool := range []string{"read_agent_workspace_file", "read_agent_workspace_commit_file"} {
			for _, offset := range []int64{0, agentWorkspaceMaxFileBytes - 5} {
				args := map[string]any{"fileId": f.FileID, "offset": offset, "expectedSHA256": f.SHA256}
				if tool == "read_agent_workspace_commit_file" {
					args = map[string]any{"workspaceId": workspace.WorkspaceID, "revision": workspace.Revision, "path": f.Path, "offset": offset, "expectedSHA256": f.SHA256}
				}
				result := callMCPToolOK(t, client, tool, args)
				if len(mcpResultText(result)) > 16<<10 {
					t.Fatal("maximum-size file produced an unbounded response")
				}
				var chunk mcpAgentWorkspaceCommitFileChunk
				decodeMCPStructured(t, result, &chunk)
				data, err := base64.StdEncoding.DecodeString(chunk.ContentBase64)
				if err != nil || len(data) > mcpAgentWorkspaceReadChunkBytes {
					t.Fatalf("large file chunk: %d %v", len(data), err)
				}
				if offset > 0 && (string(data) != "aaaaa" || chunk.HasMore || chunk.NextOffset != nil) {
					t.Fatal("large file tail is incomplete")
				}
			}
		}
	}
	found := false
	for _, file := range workspace.Files {
		if file.Path == "large.txt" && file.SizeBytes == agentWorkspaceMaxFileBytes {
			found = true
		}
	}
	if !found {
		t.Fatal("5 MiB file was not saved through MCP")
	}
	for _, size := range []int{agentWorkspaceMaxFileBytes + 1, mcpAgentWorkspaceMaxRequestBytes * 3 / 4} {
		result, err := client.CallTool(ctx, &mcp.CallToolParams{Name: "update_agent_workspace", Arguments: map[string]any{
			"workspaceId": workspace.WorkspaceID, "expectedRevision": workspace.Revision,
			"upsert": []map[string]any{{"path": "too-large.txt", "contentBase64": base64.StdEncoding.EncodeToString([]byte(strings.Repeat("b", size)))}},
		}})
		if err == nil && !result.IsError {
			t.Fatalf("oversized file/request unexpectedly accepted: %d bytes", size)
		}
	}
	verification, err := connectMCPClient(ctx, server.URL+"/mcp", token.Secret)
	if err != nil {
		t.Fatal(err)
	}
	defer verification.Close()
	var unchanged agentWorkspaceView
	decodeMCPStructured(t, callMCPToolOK(t, verification, "get_agent_workspace", map[string]any{"workspaceId": workspace.WorkspaceID}), &unchanged)
	if unchanged.Revision != workspace.Revision || len(unchanged.Files) != len(workspace.Files) {
		t.Fatal("rejected upload changed the repository")
	}
}
