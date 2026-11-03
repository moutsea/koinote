package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"koinote/backend/internal/model"
)

// Local acceptance boundary: real Koinote HTTP/MCP/PostgreSQL, the real Agent
// kernel and the application's pinned remote model channel. Only the durable
// Job delivery transport is a fixture; no model response or document operation
// is mocked. This does not claim that these changes are deployed in production.
func TestAgentIntentLiveHost(t *testing.T) {
	if os.Getenv("KOINOTE_AGENT_INTENT_LIVE") != "1" {
		t.Skip("explicit billable acceptance only")
	}
	a, u, doc := writingTestApp(t)
	ctx, cancel := context.WithTimeout(context.Background(), 18*time.Minute)
	defer cancel()
	mcpServer := httptest.NewServer(a.Routes())
	defer mcpServer.Close()
	agentRoot, err := filepath.Abs("../../../../tools/agent-gpt")
	if err != nil {
		t.Fatal(err)
	}
	reports := []map[string]any{}
	reportPath := os.Getenv("KOINOTE_INTENT_REPORT")
	if reportPath == "" {
		reportPath = "/tmp/koinote-intent-live-report.json"
	}
	defer func() {
		raw, _ := json.MarshalIndent(map[string]any{"passed": !t.Failed(), "capturedAt": time.Now().UTC(), "boundary": "real Koinote HTTP/MCP/PostgreSQL + local Agent kernel + pinned real model channel; durable job delivery is a fixture; not production deployment", "tasks": reports}, "", "  ")
		_ = os.WriteFile(reportPath, raw, 0600)
	}()
	run := func(s agentSession, focus model.Document, message string) writingTask {
		task := bindIntentTaskForTest(t, a, agentTestTask(t, a, u, s, focus, message))
		input := map[string]any{"workspaceId": task.WorkspaceID, "conversationId": "koinote-writing-" + task.ID, "conversationTurnId": task.JobID, "tenantId": "isolated-tenant", "userId": "isolated-user", "appUserId": "isolated-app-user", "policy": map[string]any{"maxSteps": 16, "maxToolCalls": 24, "maxContextChars": 120000, "modelTimeoutMs": 360000, "toolTimeoutMs": 120000, "compactionMode": "off", "skillLearningMode": "off"}}
		if err := a.prepareAgentConversationInput(ctx, &task, input, "selected-koinote-skill"); err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(input)
		if _, err := a.db.Exec(ctx, `UPDATE writing_agent_tasks SET remote_input=$2 WHERE id=$1`, task.ID, raw); err != nil {
			t.Fatal(err)
		}
		fixture, _ := json.Marshal(map[string]any{"input": input, "skill": task.Skill, "mcpURL": mcpServer.URL + "/api/writing-agent/mcp/" + task.ID, "mcpSecret": a.writingSecret(task.ID, "mcp")})
		dir := t.TempDir()
		fixturePath := filepath.Join(dir, "input.json")
		outputPath := filepath.Join(dir, "output.json")
		if err := os.WriteFile(fixturePath, fixture, 0600); err != nil {
			t.Fatal(err)
		}
		cmd := exec.CommandContext(ctx, "node", "node_modules/vitest/vitest.mjs", "run", "--config", "eval/koinote-host.config.mts")
		cmd.Dir = agentRoot
		cmd.Env = append(os.Environ(), "KOINOTE_INTENT_FIXTURE="+fixturePath, "KOINOTE_INTENT_RESULT="+outputPath)
		output, err := cmd.CombinedOutput()
		t.Logf("kernel acceptance task=%s\n%s", task.ID, output)
		if err != nil {
			if failedRaw, readErr := os.ReadFile(outputPath); readErr == nil {
				var failed map[string]any
				if json.Unmarshal(failedRaw, &failed) == nil {
					reports = append(reports, map[string]any{"taskId": task.ID, "inputVersion": task.IntentVersion, "error": failed["error"], "channel": failed["channel"], "modelJobs": failed["jobs"], "transportEvents": failed["transportEvents"]})
				}
			}
			t.Fatal("kernel/model/MCP acceptance", err)
		}
		resultRaw, err := os.ReadFile(outputPath)
		if err != nil {
			t.Fatal(err)
		}
		var envelope struct {
			Result          json.RawMessage   `json:"result"`
			Events          []json.RawMessage `json:"events"`
			Channel         map[string]any    `json:"channel"`
			Jobs            []map[string]any  `json:"jobs"`
			TransportEvents []map[string]any  `json:"transportEvents"`
		}
		if err = json.Unmarshal(resultRaw, &envelope); err != nil {
			t.Fatal(err)
		}
		// Deliver the actual immutable kernel result through the host's ordinary
		// signed callback, event collection, job read and settlement paths.
		remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			if strings.HasSuffix(r.URL.Path, "/events") {
				after, _ := strconv.Atoi(r.URL.Query().Get("after"))
				events := []map[string]any{}
				for i, e := range envelope.Events {
					if i+1 > after {
						events = append(events, map[string]any{"seq": i + 1, "event": e})
					}
				}
				json.NewEncoder(w).Encode(map[string]any{"events": events, "hasMore": false})
				return
			}
			json.NewEncoder(w).Encode(map[string]any{"id": task.JobID, "status": "completed", "result": envelope.Result})
		}))
		defer remote.Close()
		a.cfg.AgentGPTBaseURL = remote.URL
		body, _ := json.Marshal(map[string]any{"jobId": task.JobID, "workspaceId": task.WorkspaceID, "data": map[string]string{"status": "completed"}})
		stamp := strconv.FormatInt(time.Now().Unix(), 10)
		mac := hmac.New(sha256.New, []byte(a.writingSecret(task.ID, "callback")))
		fmt.Fprint(mac, stamp+"."+string(body))
		for i := 0; i < 2; i++ {
			req := httptest.NewRequest("POST", "/api/writing-agent/callback/"+task.ID, strings.NewReader(string(body)))
			req.Header.Set("X-Agent-Timestamp", stamp)
			req.Header.Set("X-Agent-Signature", "sha256="+hex.EncodeToString(mac.Sum(nil)))
			req.Header.Set("X-Agent-Delivery", "intent-acceptance-"+task.ID)
			w := httptest.NewRecorder()
			a.Routes().ServeHTTP(w, req)
			if w.Code != 204 {
				t.Fatal("signed callback", w.Code)
			}
		}
		if err = a.advanceWritingTask(ctx, &task); err != nil {
			t.Fatal("host reconciliation", err)
		}
		task, err = a.loadWritingTask(ctx, task.ID, u.ID)
		if err != nil {
			t.Fatal(err)
		}
		if task.Status != "completed" || task.BillingStatus != "settled" || len(task.IntentResult) == 0 {
			t.Fatalf("settlement/outcome missing: %+v", task)
		}
		var ledger, deliveries int
		a.db.QueryRow(ctx, `SELECT count(*) FROM credit_transactions WHERE user_id=$1 AND kind='agent_usage' AND metadata->>'taskId'=$2`, u.ID, task.ID).Scan(&ledger)
		a.db.QueryRow(ctx, `SELECT count(*) FROM writing_agent_deliveries WHERE task_id=$1`, task.ID).Scan(&deliveries)
		if ledger != 1 {
			t.Fatalf("expected one charge ledger entry, got %d", ledger)
		}
		if deliveries != 1 {
			t.Fatal("callback not deduplicated")
		}
		// Repeating terminal reconciliation cannot charge again or replace state.
		var remoteResult writingRemoteJob
		json.Unmarshal([]byte(`{"result":`+string(envelope.Result)+`}`), &remoteResult)
		if err = a.finishWritingTask(ctx, task, "completed", "", remoteResult.Result.Usage, remoteResult.Result.Text); err != nil {
			t.Fatal(err)
		}
		var after int
		a.db.QueryRow(ctx, `SELECT count(*) FROM credit_transactions WHERE user_id=$1 AND kind='agent_usage' AND metadata->>'taskId'=$2`, u.ID, task.ID).Scan(&after)
		if ledger != after {
			t.Fatal("replayed settlement charged twice")
		}
		ops, err := a.loadAgentOperations(ctx, u.ID, []string{task.ID})
		if err != nil {
			t.Fatal(err)
		}
		reports = append(reports, map[string]any{"taskId": task.ID, "inputVersion": task.IntentVersion, "channel": envelope.Channel, "modelJobs": envelope.Jobs, "transportEvents": envelope.TransportEvents, "taskIntent": task.IntentResult, "operationCount": len(ops), "billingStatus": task.BillingStatus, "chargedCredits": task.ChargedCredits, "callbackDeliveries": deliveries})
		return task
	}
	review := agentTestSession(t, a, u, "review")
	first := run(review, doc, "读取当前文章，保持原标题，将正文替换为“这是经过确认的验收正文。”，提交修改提案等待审批。")
	ops, err := a.loadAgentOperations(ctx, u.ID, []string{first.ID})
	if err != nil || len(ops) != 1 || ops[0].Status != "pending" {
		t.Fatal("review receipt", ops, err)
	}
	unchanged, _ := a.loadAgentReviewDocument(ctx, u.ID, doc.DocID)
	if unchanged.Revision != doc.Revision {
		t.Fatal("review wrote before approval")
	}
	w := writingTestRequest(t, a, u, "POST", "/api/agent/operations/"+ops[0].ID+"/approve", map[string]string{"hash": ops[0].Hash})
	if w.Code != 200 {
		t.Fatal("approve", w.Code, w.Body.String())
	}
	updated, _ := a.loadAgentReviewDocument(ctx, u.ID, doc.DocID)
	if updated.Content != "这是经过确认的验收正文。" || updated.Title != doc.Title {
		t.Fatal("approved diff mismatch")
	}
	// User explicitly changes the goal; page focus is a different document.
	other, err := a.createDocument(ctx, createDocumentParams{User: u, Title: "Unrelated focus", Content: "Do not change this document."})
	if err != nil {
		t.Fatal(err)
	}
	review, err = a.loadAgentSession(ctx, a.db, review.ID, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	w = writingTestRequest(t, a, u, "PUT", "/api/agent/sessions/"+review.ID, map[string]any{"permission": "full", "revision": review.Revision})
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	second := run(review, other, "现在把上一轮那篇文章的正文改为“第二轮验收完成。”，标题保持不变。本轮直接应用，不再等待审批。当前打开的 Unrelated focus 文档不要修改。")
	ops, err = a.loadAgentOperations(ctx, u.ID, []string{second.ID})
	if err != nil || len(ops) != 1 || ops[0].Status != "applied" || ops[0].Input.Path != agentDocumentPath(doc.DocID) {
		t.Fatal("follow-up changed target", ops, err)
	}
	updated, _ = a.loadAgentReviewDocument(ctx, u.ID, doc.DocID)
	untouched, _ := a.loadAgentReviewDocument(ctx, u.ID, other.DocID)
	if updated.Content != "第二轮验收完成。" || untouched.Revision != other.Revision || untouched.Content != other.Content {
		t.Fatal("focus isolation diff mismatch")
	}
	advice := agentTestSession(t, a, u, "full")
	third := run(advice, other, "只给当前文章的改进建议，不要修改，也不要创建提案。")
	ops, err = a.loadAgentOperations(ctx, u.ID, []string{third.ID})
	if err != nil || len(ops) != 0 {
		t.Fatal("advice created operations")
	}
	untouched, _ = a.loadAgentReviewDocument(ctx, u.ID, other.DocID)
	if untouched.Revision != other.Revision || untouched.Content != other.Content || strings.TrimSpace(third.Result) == "" {
		t.Fatal("advice response or unchanged document assertion failed")
	}
	t.Logf("LIVE HOST PASS: review→approval, explicit follow-up with changed focus, advice-only, signed callbacks and idempotent settlement; report=%s", reportPath)
}
