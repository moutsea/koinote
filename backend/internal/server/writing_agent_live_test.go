package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"

	"koinote/backend/internal/config"
)

// Local fixtures keep distinct database users and task workspaces. Only remote
// usage attribution is shared across live evaluations and integration tests.
const sharedLiveAgentUser = "koinote-test:shared"

func TestWritingExternalIdentityIsolation(t *testing.T) {
	live := &App{agentGPTTestExternalID: sharedLiveAgentUser}
	app := &App{}
	for _, userID := range []int{31, 32} {
		if got := live.writingExternalID(userID); got != "koinote-test:shared" {
			t.Fatalf("live fixture %d registered as %q", userID, got)
		}
		if got, want := app.writingExternalID(userID), fmt.Sprintf("koinote:%d", userID); got != want {
			t.Fatalf("Koinote user %d registered as %q", userID, got)
		}
	}
}

// Opt-in: uses real remote model/tools. TEST_DATABASE_URL must be an isolated
// database; expose only port 8098 through a temporary tunnel before running.
func TestWritingAgentLive(t *testing.T) {
	if os.Getenv("KOINOTE_AGENT_LIVE") != "1" {
		t.Skip("set KOINOTE_AGENT_LIVE=1 for the billable remote smoke test")
	}
	publicURL := os.Getenv("AGENT_GPT_PUBLIC_URL")
	if !strings.HasPrefix(publicURL, "https://") {
		t.Fatal("AGENT_GPT_PUBLIC_URL must expose the test server at port 8098")
	}
	cfg := config.Config{SessionSecret: "isolated-writing-live-test", AgentGPTBaseURL: os.Getenv("AGENT_GPT_BASE_URL"), AgentGPTAPIKey: os.Getenv("AGENT_GPT_API_KEY"), AgentGPTSigningSecret: os.Getenv("AGENT_GPT_SIGNING_SECRET"), AgentGPTSignRequests: os.Getenv("AGENT_GPT_SIGN_REQUESTS") == "true", AgentGPTAppID: os.Getenv("AGENT_GPT_APP_ID"), AgentGPTPublicURL: publicURL, AgentGPTModel: os.Getenv("AGENT_GPT_MODEL")}
	if cfg.AgentGPTBaseURL == "" {
		cfg.AgentGPTBaseURL = "https://agent.coderliang.com"
	}
	a, pool, user, doc := newAgentReviewCreateTest(t, cfg)
	a.agentGPTTestExternalID = sharedLiveAgentUser
	initialBalance, _ := grantLifetimeCreditsForTest(t, pool, user.ID)
	// Only authenticated task callbacks/MCP are exposed to the temporary public URL.
	mux := http.NewServeMux()
	mux.Handle("/api/writing-agent/mcp/{taskId}", a.writingMCP())
	mux.HandleFunc("POST /api/writing-agent/callback/{taskId}", a.writingWebhook)
	listener, err := net.Listen("tcp", "127.0.0.1:8098")
	if err != nil {
		t.Fatal(err)
	}
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 10 * time.Second}
	go server.Serve(listener)
	defer server.Close()
	id, _ := randomUUID()
	input := writingCreateInput{RequestID: id, DocID: doc.DocID, ExpectedRevision: doc.Revision, Message: "请实际执行以下步骤验证写作能力：1. 用 skill_view 加载所选 Skill；2. 读取当前文章；3. 用 browser_markdown 浏览 https://example.com，引用其中 Example Domain 的说明；4. 用 sandbox_compute 执行固定命令 python3 -c 'print(sum(range(1, 11)))'，确认退出码为 0 且 stdout 为 55；不要增加其他打印或诊断日志；5. 将这些真实工具结果写进一篇简短中文 Markdown 文章，调用 koinote.propose_document_change 提交完整替换提案。必须真的执行 browser_markdown 和 sandbox_compute，不能用文字代替工具调用。不要直接应用文章。"}
	response := writingTestRequest(t, a, user, "POST", "/api/writing-agent/tasks", input)
	if response.Code != 202 {
		t.Fatalf("create %d: %s", response.Code, response.Body.String())
	}
	var created struct {
		Task writingTask `json:"task"`
	}
	if err = json.Unmarshal(response.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	task, err := a.loadWritingTask(context.Background(), created.Task.ID, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("live task %s created", task.ID)
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Minute)
	defer cancel()
	defer func() {
		latest, e := a.loadWritingTask(context.Background(), task.ID, user.ID)
		if e != nil {
			return
		}
		cleanup, stop := context.WithTimeout(context.Background(), 45*time.Second)
		defer stop()
		if latest.JobID != "" && !writingTerminal(latest.Status) {
			_ = a.agentGPTRequest(cleanup, "POST", "/api/agent/"+latest.WorkspaceID+"/jobs/"+latest.JobID+"/cancel", a.writingExternalID(user.ID), "", map[string]any{}, nil)
		}
		// Remove the temporary bridge so the remote SDK stops reconnecting to a
		// tunnel whose fixture and server are about to disappear.
		if latest.WorkspaceID != "" {
			if e = a.agentGPTRequest(cleanup, "DELETE", "/api/workspaces/"+latest.WorkspaceID+"/mcp/koinote", "", "", nil, nil); e != nil {
				t.Logf("temporary MCP cleanup: %v", e)
			}
		}
	}()
	for !writingTerminal(task.Status) {
		previousStatus, previousCursor := task.Status, task.Cursor
		if err = a.advanceWritingTask(ctx, &task); err != nil && !errors.Is(err, errWritingEventBacklog) {
			t.Fatalf("remote chain: %v", err)
		}
		task, err = a.loadWritingTask(ctx, task.ID, user.ID)
		if err != nil {
			t.Fatal(err)
		}
		if task.Status != previousStatus || task.Cursor != previousCursor {
			t.Logf("status=%s cursor=%d proposal=%t", task.Status, task.Cursor, task.Proposal != nil)
		}
		if task.Status == "awaiting_approval" {
			t.Fatal("allowlisted cloud tool unexpectedly requires approval")
		}
		if !writingTerminal(task.Status) {
			select {
			case <-ctx.Done():
				t.Fatal(ctx.Err())
			case <-time.After(3 * time.Second):
			}
		}
	}
	rows, err := pool.Query(ctx, `SELECT event FROM writing_agent_events WHERE task_id=$1 ORDER BY seq`, task.ID)
	if err != nil {
		t.Fatal(err)
	}
	used := map[string]bool{}
	outputs := map[string]string{}
	for rows.Next() {
		var raw []byte
		if err = rows.Scan(&raw); err != nil {
			t.Fatal(err)
		}
		var event struct {
			Type     string `json:"type"`
			ToolCall struct {
				Name string `json:"name"`
			} `json:"toolCall"`
			Output string `json:"output"`
			Error  string `json:"error"`
		}
		if json.Unmarshal(raw, &event) != nil {
			continue
		}
		if event.Type == "tool.completed" {
			used[event.ToolCall.Name] = true
			outputs[event.ToolCall.Name] = event.Output
			t.Logf("tool completed: %s", event.ToolCall.Name)
		}
		if event.Type == "tool.failed" || event.Type == "run.failed" {
			t.Logf("remote failure: %s %s", event.ToolCall.Name, event.Error)
		}
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	if task.Status != "completed" || task.Proposal == nil {
		t.Fatalf("remote task did not produce proposal: status=%s", task.Status)
	}
	for _, tool := range []string{"skill_view", "koinote.get_document", "browser_markdown", "sandbox_compute", "koinote.propose_document_change"} {
		if !used[tool] {
			t.Errorf("required tool was not completed: %s", tool)
		}
	}
	browserOK := strings.Contains(outputs["browser_markdown"], "Example Domain")
	if !browserOK {
		t.Error("browser result did not contain the expected page")
	}
	var compute struct {
		ExitCode *int   `json:"exitCode"`
		Stdout   string `json:"stdout"`
	}
	computeOK := json.Unmarshal([]byte(outputs["sandbox_compute"]), &compute) == nil && compute.ExitCode != nil && *compute.ExitCode == 0 && strings.TrimSpace(compute.Stdout) == "55"
	if !computeOK {
		t.Error("sandbox did not successfully compute 55")
	}
	if browserOK && computeOK {
		t.Logf("verified browser result and sandbox stdout=%q", strings.TrimSpace(compute.Stdout))
	}
	if task.BillingStatus != "settled" || task.ChargedCredits < 1 {
		t.Fatalf("live usage was not settled: %s %d", task.BillingStatus, task.ChargedCredits)
	}
	tokens, complete := writingUsageTokens(task.Usage)
	expectedCredits := int64((tokens + 1999) / 2000)
	if expectedCredits > task.ReservedCredits {
		expectedCredits = task.ReservedCredits
	}
	if !complete || task.ChargedCredits != expectedCredits {
		t.Fatal("settled credits do not match the remote token usage")
	}
	var balance, reserved int64
	if err = pool.QueryRow(ctx, `SELECT balance,reserved FROM credit_accounts WHERE user_id=$1`, user.ID).Scan(&balance, &reserved); err != nil || reserved != 0 || balance != initialBalance.Balance-task.ChargedCredits {
		t.Fatal("settled credit balance or released hold does not match the ledger")
	}
	before, err := a.loadAgentReviewDocument(ctx, user.ID, doc.DocID)
	if err != nil || before.Revision != doc.Revision {
		t.Fatal("document changed before confirmation")
	}
	for i := 0; i < 2; i++ {
		applied := writingTestRequest(t, a, user, "POST", "/api/writing-agent/tasks/"+task.ID+"/apply", map[string]any{"expectedRevision": doc.Revision, "proposalHash": task.Proposal.Hash})
		if applied.Code != 200 {
			t.Fatalf("apply %d: %s", applied.Code, applied.Body.String())
		}
	}
	after, err := a.loadAgentReviewDocument(ctx, user.ID, doc.DocID)
	if err != nil || after.Revision != doc.Revision+1 || after.Content != task.Proposal.Content {
		t.Fatal("proposal apply mismatch")
	}
	var entries int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM credit_transactions WHERE user_id=$1 AND kind='agent_usage'`, user.ID).Scan(&entries); err != nil || entries != 1 {
		t.Fatal("duplicate or missing debit")
	}
	if !t.Failed() {
		t.Logf("LIVE PASS: workspace=%s job=%s revision=%d->%d chargedCredits=%d usage=%s", task.WorkspaceID, task.JobID, doc.Revision, after.Revision, task.ChargedCredits, task.Usage)
	}
}
