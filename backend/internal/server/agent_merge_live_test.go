package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"unicode"
)

// Opt-in: real application model channel, local updated kernel, real MCP/SQL,
// synthetic account only. Durable delivery is an in-memory replay fixture.
func TestAgentFolderMergeLive(t *testing.T) {
	if os.Getenv("KOINOTE_AGENT_MERGE_LIVE") != "1" {
		t.Skip("explicit live acceptance only")
	}
	a, u, doc := writingTestApp(t)
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Minute)
	defer cancel()
	source := seedAgentEmptyFolder(t, a, u.ID, "产品待办", "", "")
	destination := seedAgentEmptyFolder(t, a, u.ID, "产品文章", "", "")
	if _, err := a.db.Exec(ctx, `UPDATE documents SET folder_id=(SELECT id FROM folders WHERE folder_id=$1) WHERE doc_id=$2`, source, doc.DocID); err != nil {
		t.Fatal(err)
	}
	task := bindIntentTaskForTest(t, a, agentTestTask(t, a, u, agentTestSession(t, a, u, "review"), doc, "把产品待办和产品文章合并，将文档统一放入产品文章，保留标题和正文，移空后删除产品待办。"))
	input := map[string]any{"workspaceId": task.WorkspaceID, "conversationId": "koinote-writing-" + task.ID, "conversationTurnId": task.JobID, "tenantId": "isolated-tenant", "userId": "isolated-user", "appUserId": "isolated-app-user", "policy": map[string]any{"maxSteps": 16, "maxToolCalls": 20, "maxContextChars": 120000, "modelTimeoutMs": 300000, "toolTimeoutMs": 120000, "compactionMode": "off", "skillLearningMode": "off"}}
	if err := a.prepareAgentConversationInput(ctx, &task, input, "selected-koinote-skill"); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(input)
	if _, err := a.db.Exec(ctx, `UPDATE writing_agent_tasks SET remote_input=$2 WHERE id=$1`, task.ID, raw); err != nil {
		t.Fatal(err)
	}
	var approvals atomic.Int32
	secret := a.writingSecret(task.ID, "mcp")
	routes := a.Routes()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/isolated-approval" {
			routes.ServeHTTP(w, r)
			return
		}
		if r.Method != "POST" || r.Header.Get("Authorization") != "Bearer "+secret {
			w.WriteHeader(403)
			return
		}
		var requested struct {
			OperationIDs []string `json:"operationIds"`
		}
		if json.NewDecoder(r.Body).Decode(&requested) != nil || len(requested.OperationIDs) != 1 {
			http.Error(w, "expected one operation in each dependent phase", 409)
			return
		}
		ops, err := a.loadAgentOperations(ctx, u.ID, []string{task.ID})
		phase := approvals.Load()
		if err != nil || len(ops) != int(phase)+1 || phase > 1 {
			http.Error(w, "unexpected operation count", 409)
			return
		}
		var batch []agentOperation
		for _, op := range ops {
			if op.ID != requested.OperationIDs[0] {
				if op.Status != "applied" {
					http.Error(w, "unapproved prerequisite", 409)
					return
				}
				continue
			}
			valid := op.Status == "pending" && ((phase == 0 && op.Input.Kind == "move" && op.Input.Path == agentDocumentPath(doc.DocID) && op.Input.FolderID == destination) || (phase == 1 && op.Input.Kind == "delete_folder" && op.Input.Path == "/folders/"+source))
			if !valid {
				http.Error(w, "unexpected fixture scope", 409)
				return
			}
			batch = append(batch, op)
		}
		if len(batch) != 1 {
			http.Error(w, "unknown operation", 409)
			return
		}
		decision := writingTestRequest(t, a, u, "POST", "/api/agent/tasks/"+task.ID+"/operations/approve", approvalBatchBody(batch))
		if decision.Code == 200 {
			approvals.Add(1)
		}
		w.WriteHeader(decision.Code)
		w.Write(decision.Body.Bytes())
	}))
	defer server.Close()
	dir := t.TempDir()
	fixturePath, outputPath := filepath.Join(dir, "fixture.json"), filepath.Join(dir, "result.json")
	fixture, _ := json.Marshal(map[string]any{"input": input, "skill": task.Skill, "mcpURL": server.URL + "/api/writing-agent/mcp/" + task.ID, "mcpSecret": secret, "approvalURL": server.URL + "/isolated-approval", "maxApprovalBatches": 2})
	if err := os.WriteFile(fixturePath, fixture, 0600); err != nil {
		t.Fatal(err)
	}
	agentRoot, err := filepath.Abs("../../../../tools/agent-gpt")
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.CommandContext(ctx, "node", "node_modules/vitest/vitest.mjs", "run", "--config", "eval/koinote-host.config.mts")
	cmd.Dir = agentRoot
	cmd.Env = append(os.Environ(), "KOINOTE_INTENT_FIXTURE="+fixturePath, "KOINOTE_INTENT_RESULT="+outputPath)
	output, runErr := cmd.CombinedOutput()
	t.Logf("isolated folder acceptance: %s", output)
	data, readErr := os.ReadFile(outputPath)
	if readErr == nil { // The envelope contains only synthetic task data and public channel metadata.
		_ = os.WriteFile("/tmp/koinote-merge-folder-live-result.json", data, 0600)
	}
	if runErr != nil {
		t.Fatal("live kernel/model/MCP", runErr)
	}
	if readErr != nil {
		t.Fatal(readErr)
	}
	var result struct {
		Result struct {
			Task struct {
				Outcome     string `json:"outcome"`
				ModelOutput string `json:"modelOutput"`
			} `json:"task"`
		} `json:"result"`
	}
	if err = json.Unmarshal(data, &result); err != nil {
		t.Fatal(err)
	}
	if result.Result.Task.Outcome != "operations_reported" || !strings.ContainsFunc(result.Result.Task.ModelOutput, func(r rune) bool { return unicode.Is(unicode.Han, r) }) {
		t.Fatal("unexpected clarification or language", result.Result.Task)
	}
	if approvals.Load() != 2 || agentFolderCount(t, a, source) != 0 || agentFolderCount(t, a, destination) != 1 {
		t.Fatal("dependent phases did not complete", approvals.Load())
	}
	var folder, title, content string
	if err = a.db.QueryRow(ctx, `SELECT f.folder_id,d.title,d.content FROM documents d JOIN folders f ON f.id=d.folder_id WHERE d.doc_id=$1`, doc.DocID).Scan(&folder, &title, &content); err != nil || folder != destination || title != doc.Title || content != doc.Content {
		t.Fatal("merge changed content or failed to move the document", err)
	}
	ops, err := a.loadAgentOperations(ctx, u.ID, []string{task.ID})
	if err != nil || len(ops) != 2 {
		t.Fatal("unexpected receipts", err)
	}
	for _, op := range ops {
		if op.Status != "applied" {
			t.Fatal("operation not applied", op.Status)
		}
		if op.Input.Kind == "delete_folder" {
			undo := writingTestRequest(t, a, u, "POST", "/api/agent/tasks/"+task.ID+"/operations/undo", approvalBatchBody([]agentOperation{op}))
			if undo.Code != 200 {
				t.Fatal("undo deletion failed", undo.Code, undo.Body.String())
			}
		}
	}
	for _, op := range ops {
		if op.Input.Kind == "move" {
			undo := writingTestRequest(t, a, u, "POST", "/api/agent/operations/"+op.ID+"/undo", map[string]string{"hash": op.Hash})
			if undo.Code != 200 {
				t.Fatal("undo move failed", undo.Code, undo.Body.String())
			}
		}
	}
	if err = a.db.QueryRow(ctx, `SELECT f.folder_id FROM documents d JOIN folders f ON f.id=d.folder_id WHERE d.doc_id=$1`, doc.DocID).Scan(&folder); err != nil || folder != source {
		t.Fatal("merge undo did not restore source", err)
	}
	t.Log("dependent move/delete approvals, same-job continuation, Chinese output, original document preserved and full undo passed")
}
