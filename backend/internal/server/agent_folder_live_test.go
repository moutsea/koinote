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
func TestAgentEmptyFolderLive(t *testing.T) {
	if os.Getenv("KOINOTE_AGENT_FOLDER_LIVE") != "1" {
		t.Skip("explicit live acceptance only")
	}
	a, u, doc := writingTestApp(t)
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Minute)
	defer cancel()
	ids := []string{seedAgentEmptyFolder(t, a, u.ID, "202608", "", "smart"), seedAgentEmptyFolder(t, a, u.ID, "最近 7 天", "", "activity")}
	occupied := seedAgentEmptyFolder(t, a, u.ID, "保留文档", "", "")
	if _, err := a.db.Exec(ctx, `UPDATE documents SET folder_id=(SELECT id FROM folders WHERE folder_id=$1) WHERE doc_id=$2`, occupied, doc.DocID); err != nil {
		t.Fatal(err)
	}
	task := bindIntentTaskForTest(t, a, agentTestTask(t, a, u, agentTestSession(t, a, u, "review"), doc, "帮我清理一下所有空文件夹"))
	input := map[string]any{"workspaceId": task.WorkspaceID, "conversationId": "koinote-writing-" + task.ID, "conversationTurnId": task.JobID, "tenantId": "isolated-tenant", "userId": "isolated-user", "appUserId": "isolated-app-user", "policy": map[string]any{"maxSteps": 12, "maxToolCalls": 20, "maxContextChars": 120000, "modelTimeoutMs": 300000, "toolTimeoutMs": 120000, "compactionMode": "off", "skillLearningMode": "off"}}
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
		if json.NewDecoder(r.Body).Decode(&requested) != nil || len(requested.OperationIDs) != 2 {
			http.Error(w, "expected one pair", 409)
			return
		}
		ops, err := a.loadAgentOperations(ctx, u.ID, []string{task.ID})
		if err != nil || len(ops) != 2 || agentFolderCount(t, a, ids...) != 2 {
			http.Error(w, "unexpected proposal count", 409)
			return
		}
		expected := map[string]bool{"/folders/" + ids[0]: true, "/folders/" + ids[1]: true}
		for _, op := range ops {
			if op.Status != "pending" || op.Input.Kind != "delete_folder" || !expected[op.Input.Path] || !strings.Contains("|"+strings.Join(requested.OperationIDs, "|")+"|", "|"+op.ID+"|") {
				http.Error(w, "unexpected scope", 409)
				return
			}
			delete(expected, op.Input.Path)
		}
		if len(expected) != 0 {
			http.Error(w, "incomplete scope", 409)
			return
		}
		decision := writingTestRequest(t, a, u, "POST", "/api/agent/tasks/"+task.ID+"/operations/approve", approvalBatchBody(ops))
		if decision.Code == 200 {
			approvals.Add(1)
		}
		w.WriteHeader(decision.Code)
		w.Write(decision.Body.Bytes())
	}))
	defer server.Close()
	dir := t.TempDir()
	fixturePath, outputPath := filepath.Join(dir, "fixture.json"), filepath.Join(dir, "result.json")
	fixture, _ := json.Marshal(map[string]any{"input": input, "skill": task.Skill, "mcpURL": server.URL + "/api/writing-agent/mcp/" + task.ID, "mcpSecret": secret, "approvalURL": server.URL + "/isolated-approval"})
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
		_ = os.WriteFile("/tmp/koinote-empty-folder-live-result.json", data, 0600)
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
	if approvals.Load() != 1 || agentFolderCount(t, a, ids...) != 0 || agentFolderCount(t, a, occupied) != 1 {
		t.Fatal("incorrect batch deletion", approvals.Load())
	}
	ops, err := a.loadAgentOperations(ctx, u.ID, []string{task.ID})
	if err != nil {
		t.Fatal(err)
	}
	undo := writingTestRequest(t, a, u, "POST", "/api/agent/tasks/"+task.ID+"/operations/undo", approvalBatchBody(ops))
	if undo.Code != 200 || agentFolderCount(t, a, ids...) != 2 {
		t.Fatal("undo failed", undo.Code, undo.Body.String())
	}
	t.Log("one batch approval, same-job continuation, Chinese output, occupied folder preserved and batch undo passed")
}
