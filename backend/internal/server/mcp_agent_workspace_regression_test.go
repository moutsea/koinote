package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"koinote/backend/internal/config"
)

func requireMCPToolError(t *testing.T, client *mcp.ClientSession, name string, input any, message string) {
	t.Helper()
	result := callMCPTool(t, client, name, input)
	if !result.IsError || !strings.Contains(mcpResultText(result), message) {
		t.Fatalf("%s: expected error containing %q, got %s", name, message, mcpResultText(result))
	}
}

func TestMCPBodyLimitPreservesFlush(t *testing.T) {
	recorder := httptest.NewRecorder()
	guard := &mcpBodyLimitWriter{ResponseWriter: recorder}
	var writer http.ResponseWriter = guard
	flusher, ok := writer.(http.Flusher)
	if !ok {
		t.Fatal("SDK streaming responses lost http.Flusher")
	}
	_, _ = writer.Write([]byte("event: message\n\n"))
	flusher.Flush()
	if !recorder.Flushed {
		t.Fatal("flush did not reach the transport")
	}
	rejected := httptest.NewRecorder()
	guard = &mcpBodyLimitWriter{ResponseWriter: rejected, rejected: true}
	guard.Flush()
	if rejected.Flushed {
		t.Fatal("SDK must not flush after rejecting the body")
	}
}

func TestMCPAgentRepositoryReviewRegressions(t *testing.T) {
	ctx := context.Background()
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "mcp-review-regression", AppURL: "http://127.0.0.1"}, pool)
	server := httptest.NewServer(app.Routes())
	t.Cleanup(server.Close)
	user := seedMCPUser(t, pool, app, membershipTierLifetime)
	if _, err := pool.Exec(ctx, `INSERT INTO agent_workspace_settings (user_id, enabled) VALUES ($1, true)`, user.ID); err != nil {
		t.Fatal(err)
	}
	cookie := mcpSessionCookie(app, user.AuthUserID)
	token := createMCPTokenForTest(t, server, cookie, "Review writer", "agent_write")
	client, err := connectMCPClient(ctx, server.URL+"/mcp", token.Secret)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	create := func(name string) agentWorkspaceView {
		t.Helper()
		view, err := app.createAgentWorkspace(ctx, user.ID, name, "", "en")
		if err != nil {
			t.Fatal(err)
		}
		return view
	}
	file := func(path, content string) map[string]any {
		return map[string]any{"path": path, "contentBase64": base64.StdEncoding.EncodeToString([]byte(content))}
	}
	patch := func(view agentWorkspaceView, path, content string) agentWorkspaceView {
		t.Helper()
		var next agentWorkspaceView
		decodeMCPStructured(t, callMCPToolOK(t, client, "update_agent_workspace", map[string]any{"comment": "Regression test change", "workspaceId": view.WorkspaceID, "expectedRevision": view.Revision, "upsert": []any{file(path, content)}}), &next)
		return next
	}
	t.Run("sensitive restore is atomic for both transports", func(t *testing.T) {
		view := create("Sensitive history")
		path := fmt.Sprintf("/api/agent/workspaces/%d", view.WorkspaceID)
		uploaded := callLLMChannelAPI(t, app, cookie, http.MethodPatch, path,
			fmt.Sprintf(`{"expectedRevision":%d,"allowSensitive":true,"upsert":[{"path":"settings.txt","contentBase64":%q}]}`, view.Revision, base64.StdEncoding.EncodeToString([]byte("api_key=sk-abcdefghijklmnopqrstuvwxyz1234567890"))))
		if uploaded.Code != http.StatusOK {
			t.Fatalf("upload: %d %s", uploaded.Code, uploaded.Body.String())
		}
		var body struct {
			Workspace agentWorkspaceView `json:"workspace"`
		}
		decodeJSONResponse(t, uploaded, &body)
		sensitiveRevision := body.Workspace.Revision
		clean := patch(body.Workspace, "settings.txt", "api_key=<REDACTED>")
		args := map[string]any{"comment": "Restore regression fixture", "workspaceId": view.WorkspaceID, "revision": sensitiveRevision, "expectedRevision": clean.Revision}
		requireMCPToolError(t, client, "restore_agent_workspace_commit", args, "sensitive data")
		restorePath := fmt.Sprintf("%s/commits/%d/restore", path, sensitiveRevision)
		payload := fmt.Sprintf(`{"comment":"Restore regression fixture","expectedRevision":%d,"allowSensitive":true}`, clean.Revision)
		req := httptest.NewRequest(http.MethodPost, restorePath, strings.NewReader(payload))
		req.Header.Set("Authorization", "Bearer "+token.Secret)
		req.Header.Set("Content-Type", "application/json")
		rec := httptest.NewRecorder()
		app.Routes().ServeHTTP(rec, req)
		if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "sensitive_data_detected") {
			t.Fatalf("token restore: %d %s", rec.Code, rec.Body.String())
		}
		browserDenied := callLLMChannelAPI(t, app, cookie, http.MethodPost, restorePath, fmt.Sprintf(`{"expectedRevision":%d}`, clean.Revision))
		if browserDenied.Code != http.StatusUnprocessableEntity {
			t.Fatalf("restore without confirmation: %d", browserDenied.Code)
		}
		unchanged, err := app.loadAgentWorkspace(ctx, user.ID, view.WorkspaceID)
		if err != nil || unchanged.Revision != clean.Revision {
			t.Fatalf("rejected restore mutated revision: %+v %v", unchanged, err)
		}
		var stored string
		if err := pool.QueryRow(ctx, `SELECT convert_from(content,'UTF8') FROM agent_workspace_files WHERE workspace_id=$1 AND path='settings.txt'`, view.WorkspaceID).Scan(&stored); err != nil || stored != "api_key=<REDACTED>" {
			t.Fatalf("rejected restore changed content: %q %v", stored, err)
		}
		var audited int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM mcp_audit_logs WHERE user_id=$1 AND workspace_id=$2 AND source_revision=$3 AND expected_revision=$4 AND resulting_revision IS NULL AND doc_id IS NULL AND result='error'`, user.ID, view.WorkspaceID, sensitiveRevision, clean.Revision).Scan(&audited); err != nil || audited != 1 {
			t.Fatalf("failed restore audit: %d %v", audited, err)
		}
		confirmed := callLLMChannelAPI(t, app, cookie, http.MethodPost, restorePath, payload)
		if confirmed.Code != http.StatusOK {
			t.Fatalf("owner confirmation: %d %s", confirmed.Code, confirmed.Body.String())
		}
		decodeJSONResponse(t, confirmed, &body)
		args["revision"], args["expectedRevision"] = clean.Revision, body.Workspace.Revision
		decodeMCPStructured(t, callMCPToolOK(t, client, "restore_agent_workspace_commit", args), &view)
		// Removing a repository must not erase the audit target or provenance.
		if _, err := app.manageAgentWorkspace(ctx, user.ID, view.WorkspaceID, view.Revision, "", "", true); err != nil {
			t.Fatal(err)
		}
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM mcp_audit_logs WHERE user_id=$1 AND workspace_id=$2 AND source_revision=$3 AND expected_revision=$4 AND resulting_revision=$5 AND result='success'`, user.ID, view.WorkspaceID, clean.Revision, body.Workspace.Revision, view.Revision).Scan(&audited); err != nil || audited != 1 {
			t.Fatalf("successful restore audit after deletion: %d %v", audited, err)
		}
	})
	t.Run("incremental batches retain earlier files", func(t *testing.T) {
		view := create("Batches")
		view = patch(view, "one.txt", "first batch")
		view = patch(view, "two.txt", "second batch")
		if len(view.Files) != 3 {
			t.Fatalf("batches lost files: %+v", view.Files)
		}
		replacement := map[string]any{"comment": "Replace regression fixture", "workspaceId": view.WorkspaceID, "expectedRevision": view.Revision, "files": []any{file("replacement.txt", "complete export")}}
		requireMCPToolError(t, client, "update_agent_workspace", replacement, "replaceAll")
		unchanged, err := app.loadAgentWorkspace(ctx, user.ID, view.WorkspaceID)
		if err != nil || unchanged.Revision != view.Revision || len(unchanged.Files) != 3 {
			t.Fatalf("implicit replacement mutated files: %+v %v", unchanged, err)
		}
		replacement["replaceAll"] = true
		replacement["upsert"] = []any{}
		requireMCPToolError(t, client, "update_agent_workspace", replacement, "cannot be combined")
		delete(replacement, "upsert")
		decodeMCPStructured(t, callMCPToolOK(t, client, "update_agent_workspace", replacement), &view)
		if len(view.Files) != 1 || view.Files[0].Path != "replacement.txt" {
			t.Fatalf("explicit replacement: %+v", view.Files)
		}
		assertUpdateAudit := func(result string, expected int64, resulting *int64, count int) {
			t.Helper()
			var got int
			if err := pool.QueryRow(ctx, `SELECT count(*) FROM mcp_audit_logs
			 WHERE user_id=$1 AND workspace_id=$2 AND tool_name='update_agent_workspace'
			 AND result=$3 AND expected_revision=$4 AND resulting_revision IS NOT DISTINCT FROM $5::bigint
			 AND doc_id IS NULL AND source_revision IS NULL`, user.ID, view.WorkspaceID, result, expected, resulting).Scan(&got); err != nil || got != count {
				t.Fatalf("update audit result=%s expected=%d: count=%d want=%d err=%v", result, expected, got, count, err)
			}
		}
		// Both refused replacements and the accepted replaceAll retain their target.
		assertUpdateAudit("error", unchanged.Revision, nil, 2)
		assertUpdateAudit("success", unchanged.Revision, &view.Revision, 1)
		// A legacy caller can omit workspaceId when there is just one repository.
		before := view.Revision
		decodeMCPStructured(t, callMCPToolOK(t, client, "update_agent_workspace", map[string]any{"comment": "Regression test change",
			"expectedRevision": before, "upsert": []any{file("incremental.txt", "audit target")},
		}), &view)
		assertUpdateAudit("success", before, &view.Revision, 1)
		requireMCPToolError(t, client, "update_agent_workspace", map[string]any{"comment": "Regression test change",
			"expectedRevision": before, "upsert": []any{file("incremental.txt", "stale update")},
		}, "revision conflict")
		assertUpdateAudit("error", before, nil, 1)
	})
	t.Run("bounded chunk reads and precise missing errors", func(t *testing.T) {
		view := create("File chunks")
		content := strings.Repeat("中文🙂\x00", 2000)
		view = patch(view, "unicode.bin", content)
		var current agentWorkspaceFileView
		for _, f := range view.Files {
			if f.Path == "unicode.bin" {
				current = f
			}
		}
		hash := sha256.Sum256([]byte(content))
		wantHash := hex.EncodeToString(hash[:])
		for _, tool := range []string{"read_agent_workspace_file", "read_agent_workspace_commit_file"} {
			input := map[string]any{"fileId": current.FileID}
			if tool == "read_agent_workspace_commit_file" {
				input = map[string]any{"workspaceId": view.WorkspaceID, "revision": view.Revision, "path": current.Path}
			}
			var assembled []byte
			for {
				result := callMCPToolOK(t, client, tool, input)
				encoded, err := json.Marshal(result)
				if err != nil || len(encoded) > 32<<10 {
					t.Fatalf("unbounded result: %d %v", len(encoded), err)
				}
				var chunk struct {
					ContentBase64 string `json:"contentBase64"`
					SHA256        string `json:"sha256"`
					mcpAgentWorkspaceChunkRange
				}
				decodeMCPStructured(t, result, &chunk)
				decoded, err := base64.StdEncoding.DecodeString(chunk.ContentBase64)
				if err != nil || len(decoded) > mcpAgentWorkspaceReadChunkBytes || chunk.Offset != int64(len(assembled)) || chunk.SHA256 != wantHash {
					t.Fatalf("invalid chunk: offset=%d size=%d hash=%s err=%v", chunk.Offset, len(decoded), chunk.SHA256, err)
				}
				assembled = append(assembled, decoded...)
				if !chunk.HasMore {
					if chunk.NextOffset != nil {
						t.Fatal("last chunk has cursor")
					}
					break
				}
				if chunk.NextOffset == nil || *chunk.NextOffset != int64(len(assembled)) {
					t.Fatal("invalid next offset")
				}
				input["offset"], input["expectedSHA256"] = *chunk.NextOffset, chunk.SHA256
			}
			if string(assembled) != content {
				t.Fatal("chunk round-trip changed bytes")
			}
		}
		oldRevision := view.Revision
		view = patch(view, current.Path, "new content")
		requireMCPToolError(t, client, "read_agent_workspace_file", map[string]any{"fileId": current.FileID, "offset": 1, "expectedSHA256": wantHash}, "file content changed")
		for _, input := range []map[string]any{
			{"fileId": current.FileID, "offset": -1}, {"fileId": current.FileID, "limit": mcpAgentWorkspaceReadChunkBytes + 1},
		} {
			requireMCPToolError(t, client, "read_agent_workspace_file", input, "offset must")
		}
		requireMCPToolError(t, client, "read_agent_workspace_file", map[string]any{"fileId": current.FileID, "offset": 1}, "expectedSHA256")
		requireMCPToolError(t, client, "read_agent_workspace_file", map[string]any{"fileId": current.FileID, "offset": 100, "expectedSHA256": view.Files[len(view.Files)-1].SHA256}, "offset exceeds")
		requireMCPToolError(t, client, "get_agent_workspace_commit", map[string]any{"workspaceId": view.WorkspaceID, "revision": view.Revision + 100}, "revision not found")
		requireMCPToolError(t, client, "read_agent_workspace_commit_file", map[string]any{"workspaceId": view.WorkspaceID, "revision": oldRevision, "path": "missing.txt"}, "file not found")
		if _, err := pool.Exec(ctx, `DELETE FROM agent_workspace_commits WHERE workspace_id=$1 AND revision=$2`, view.WorkspaceID, oldRevision); err != nil {
			t.Fatal(err)
		}
		requireMCPToolError(t, client, "read_agent_workspace_commit_file", map[string]any{"workspaceId": view.WorkspaceID, "revision": oldRevision, "path": current.Path}, "revision not found")
		requireMCPToolError(t, client, "get_agent_workspace_commit", map[string]any{"workspaceId": int64(1 << 52), "revision": 0}, "agent workspace not found")
	})
}

func TestMCPRequestBodyLimits(t *testing.T) {
	ctx := context.Background()
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "mcp-body-limits", AppURL: "http://127.0.0.1"}, pool)
	server := httptest.NewServer(app.Routes())
	t.Cleanup(server.Close)
	user := seedMCPUser(t, pool, app, membershipTierLifetime)
	if _, err := pool.Exec(ctx, `INSERT INTO agent_workspace_settings (user_id,enabled) VALUES ($1,true)`, user.ID); err != nil {
		t.Fatal(err)
	}
	cookie := mcpSessionCookie(app, user.AuthUserID)
	repoToken := createMCPTokenForTest(t, server, cookie, "Body repo", "agent_write")
	docToken := createMCPTokenForTest(t, server, cookie, "Body docs", "write")
	view, err := app.createAgentWorkspace(ctx, user.ID, "Limit target", "", "en")
	if err != nil {
		t.Fatal(err)
	}
	// Individually valid files, together exceeding the repository HTTP limit.
	files := []map[string]any{}
	for _, path := range []string{"a.txt", "b.txt"} {
		files = append(files, map[string]any{"path": path, "contentBase64": base64.StdEncoding.EncodeToString(bytes.Repeat([]byte("x"), 3<<20))})
	}
	multi, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": map[string]any{"name": "update_agent_workspace", "arguments": map[string]any{"workspaceId": view.WorkspaceID, "expectedRevision": view.Revision, "upsert": files}}})
	if err != nil || len(multi) <= mcpAgentWorkspaceMaxRequestBytes {
		t.Fatalf("invalid oversized fixture: %d %v", len(multi), err)
	}
	small := []byte(`{"jsonrpc":"2.0","id":2,"method":"tools/list"}`)
	for _, tc := range []struct {
		name, secret string
		body         []byte
		status       int
	}{
		{"multiple valid files exceed 8 MiB", repoToken.Secret, multi, http.StatusRequestEntityTooLarge},
		{"document still limited to 2 MiB", docToken.Secret, append(bytes.Clone(small), bytes.Repeat([]byte(" "), mcpMaxRequestBytes+1-len(small))...), http.StatusRequestEntityTooLarge},
		{"document exact boundary", docToken.Secret, append(bytes.Clone(small), bytes.Repeat([]byte(" "), mcpMaxRequestBytes-len(small))...), http.StatusOK},
		{"repository exact boundary", repoToken.Secret, append(bytes.Clone(small), bytes.Repeat([]byte(" "), mcpAgentWorkspaceMaxRequestBytes-len(small))...), http.StatusOK},
	} {
		for _, chunked := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/chunked=%t", tc.name, chunked), func(t *testing.T) {
				req, err := http.NewRequest(http.MethodPost, server.URL+"/mcp", bytes.NewReader(tc.body))
				if err != nil {
					t.Fatal(err)
				}
				if chunked {
					req.ContentLength = -1
				}
				req.Header.Set("Authorization", "Bearer "+tc.secret)
				req.Header.Set("Content-Type", "application/json")
				req.Header.Set("Accept", "application/json, text/event-stream")
				req.Header.Set("MCP-Protocol-Version", "2025-06-18")
				resp, err := server.Client().Do(req)
				if err != nil {
					t.Fatal(err)
				}
				defer resp.Body.Close()
				response, _ := io.ReadAll(resp.Body)
				if resp.StatusCode != tc.status {
					t.Fatalf("status=%d want=%d: %.200s", resp.StatusCode, tc.status, response)
				}
				if tc.status == http.StatusRequestEntityTooLarge && strings.Contains(string(response), "failed to read body") {
					t.Fatal("SDK replaced the 413 response")
				}
			})
		}
	}
	unchanged, err := app.loadAgentWorkspace(ctx, user.ID, view.WorkspaceID)
	if err != nil || unchanged.Revision != view.Revision || len(unchanged.Files) != len(view.Files) {
		t.Fatalf("oversized call mutated repository: %+v %v", unchanged, err)
	}
}
