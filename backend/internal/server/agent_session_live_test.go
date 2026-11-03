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
	"koinote/backend/internal/model"
)

// Explicitly opt-in: invokes the deployed service and consumes real model/tool
// usage. The public tunnel only exposes task-scoped MCP and signed callbacks.
func TestAgentConversationLive(t *testing.T) {
	if os.Getenv("KOINOTE_AGENT_LIVE") != "1" {
		t.Skip("set KOINOTE_AGENT_LIVE=1 for billable integration")
	}
	publicURL := os.Getenv("AGENT_GPT_PUBLIC_URL")
	if !strings.HasPrefix(publicURL, "https://") {
		t.Fatal("missing test tunnel")
	}
	cfg := config.Config{SessionSecret: "isolated-agent-session-live", AgentGPTBaseURL: os.Getenv("AGENT_GPT_BASE_URL"), AgentGPTAPIKey: os.Getenv("AGENT_GPT_API_KEY"), AgentGPTSigningSecret: os.Getenv("AGENT_GPT_SIGNING_SECRET"), AgentGPTSignRequests: os.Getenv("AGENT_GPT_SIGN_REQUESTS") == "true", AgentGPTAppID: os.Getenv("AGENT_GPT_APP_ID"), AgentGPTPublicURL: publicURL, AgentGPTModel: os.Getenv("AGENT_GPT_MODEL")}
	if cfg.AgentGPTBaseURL == "" {
		cfg.AgentGPTBaseURL = "https://agent.coderliang.com"
	}
	organizationCase := os.Getenv("KOINOTE_AGENT_LIVE_CASE") == "organization" || os.Getenv("KOINOTE_AGENT_LIVE_CASE") == "organization-followup"
	if organizationCase {
		cfg.AgentGPTModelTimeoutMS = 300000
	}
	a, pool, user, doc := newAgentReviewCreateTest(t, cfg)
	a.agentGPTTestExternalID = sharedLiveAgentUser
	initial, _ := grantLifetimeCreditsForTest(t, pool, user.ID)
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
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Minute)
	defer cancel()
	tasks := []writingTask{}
	defer func() {
		for _, task := range tasks {
			latest, e := a.loadWritingTask(context.Background(), task.ID, user.ID)
			if e != nil {
				continue
			}
			cleanup, stop := context.WithTimeout(context.Background(), 30*time.Second)
			if latest.JobID != "" && !writingTerminal(latest.Status) {
				_ = a.agentGPTRequest(cleanup, "POST", "/api/agent/"+latest.WorkspaceID+"/jobs/"+latest.JobID+"/cancel", a.writingExternalID(user.ID), "", map[string]any{}, nil)
			}
			if latest.WorkspaceID != "" {
				if e = a.agentGPTRequest(cleanup, "DELETE", "/api/workspaces/"+latest.WorkspaceID+"/mcp/koinote", "", "", nil, nil); e != nil {
					t.Log("temporary MCP cleanup:", e)
				}
			}
			stop()
		}
	}()
	run := func(session agentSession, current model.Document, message string) writingTask {
		task := agentTestTask(t, a, user, session, current, message)
		tasks = append(tasks, task)
		t.Logf("live session=%s task=%s", session.ID, task.ID)
		if task.Source.Content != "" {
			t.Fatal("eager article content")
		}
		for !writingTerminal(task.Status) {
			oldStatus, oldCursor := task.Status, task.Cursor
			if err = a.advanceWritingTask(ctx, &task); err != nil && !errors.Is(err, errWritingEventBacklog) {
				t.Fatal("remote chain:", err)
			}
			task, err = a.loadWritingTask(ctx, task.ID, user.ID)
			if err != nil {
				t.Fatal(err)
			}
			if task.Status != oldStatus || task.Cursor != oldCursor {
				t.Logf("status=%s cursor=%d", task.Status, task.Cursor)
			}
			if task.Status == "awaiting_approval" {
				t.Fatal("cloud tool unexpectedly requires approval")
			}
			if !writingTerminal(task.Status) {
				select {
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				case <-time.After(3 * time.Second):
				}
			}
		}
		if task.Status != "completed" {
			t.Fatalf("task failed: %s %s", task.Status, task.Error)
		}
		tokens, complete := writingUsageTokens(task.Usage)
		expectedCharge := creditsForTokens(tokens)
		if expectedCharge > task.ReservedCredits {
			expectedCharge = task.ReservedCredits
		}
		if !complete || task.BillingStatus != "settled" || task.ChargedCredits != expectedCharge {
			t.Fatal("usage settlement mismatch")
		}
		t.Logf("job=%s credits=%d usage=%s", task.JobID, task.ChargedCredits, task.Usage)
		return task
	}
	s := agentTestSession(t, a, user, "review")
	if os.Getenv("KOINOTE_AGENT_LIVE_CASE") == "auto-skills" {
		repo := agentSkillRepositoryForTest(t, a, user.ID, map[string]string{
			"structure/SKILL.md":                "---\nname: article-structure-review\ndescription: 按团队约定检查文章结构和表达，仅提出建议，不改写原文。\n---\nBefore reviewing, read references/checklist.md with skill_view (filePath: references/checklist.md). Apply that checklist to the supplied text and include its review marker in the Chinese answer. Do not ask the user to select or enable a Skill. Do not write documents.",
			"structure/references/checklist.md": "先检查是否提出问题，再检查是否说明理由。输出一句具体修改建议，最后附上审校标记：KOI-AUTO-SKILL-VERIFIED。",
		})
		if _, e := pool.Exec(ctx, `UPDATE agent_workspaces SET name='文章结构检查方法',description='团队保存的文章结构检查与审校约定' WHERE id=$1`, repo); e != nil {
			t.Fatal(e)
		}
		task := run(s, model.Document{}, "按照我保存的文章结构检查方法，检查这段话：我们准备优化首页。因为用户反馈找不到最近打开的文档。只给建议，不修改文档。")
		if !strings.Contains(task.Result, "KOI-AUTO-SKILL-VERIFIED") {
			t.Fatalf("reference file was not used: %s", task.Result)
		}
		var events string
		if e := pool.QueryRow(ctx, `SELECT COALESCE(string_agg(event::text,' '),'') FROM writing_agent_events WHERE task_id=$1 AND event->>'type'='tool.completed'`, task.ID).Scan(&events); e != nil {
			t.Fatal(e)
		}
		for _, tool := range []string{"find_skills", "load_skill", "skill_view"} {
			if !strings.Contains(events, tool) {
				t.Fatalf("missing automatic tool: %s", tool)
			}
		}
		ops, e := a.loadAgentOperations(ctx, user.ID, []string{task.ID})
		if e != nil || len(ops) != 0 {
			t.Fatal("advice-only task wrote documents", e)
		}
		t.Logf("LIVE AUTO SKILLS PASS: job=%s credits=%d; discovered, installed and read reference without a selector or approval", task.JobID, task.ChargedCredits)
		return
	}
	if organizationCase {
		checkAgentOrganizationLive(t, a, user, doc, run)
		return
	}
	// Allow a transient model timeout to be rechecked in isolation without
	// replaying the already verified, billable browser/sandbox rounds.
	if os.Getenv("KOINOTE_AGENT_LIVE_CASE") == "assist" {
		w := writingTestRequest(t, a, user, "PUT", "/api/agent/sessions/"+s.ID, map[string]any{"permission": "assist", "revision": s.Revision})
		if w.Code != 200 {
			t.Fatal(w.Body.String())
		}
		typo, e := a.createDocument(ctx, createDocumentParams{User: user, Title: "自动审批验证", Content: "这篇文章有一个错别子。"})
		if e != nil {
			t.Fatal(e)
		}
		task := run(s, typo, "加载选定的 Skill，读取当前文档，只把“错别子”修正为“错别字”，保持标题和其余内容不变。使用 propose_operations 提交一个 update，确认属于轻微错字修正后将 minorEdit 设为 true，并根据返回状态报告结果。")
		ops, e := a.loadAgentOperations(ctx, user.ID, []string{task.ID})
		if e != nil || len(ops) != 1 || ops[0].Status != "applied" || ops[0].Approval != "agent" {
			t.Fatal("assist auto approval failed", ops, e)
		}
		updated, e := a.loadAgentReviewDocument(ctx, user.ID, typo.DocID)
		if e != nil || updated.Revision != typo.Revision+1 || updated.Content != "这篇文章有一个错别字。" {
			t.Fatal("assist document result mismatch", e)
		}
		var balance, reserved, entries int64
		if e = pool.QueryRow(ctx, `SELECT balance,reserved,(SELECT count(*) FROM credit_transactions WHERE user_id=$1 AND kind='agent_usage') FROM credit_accounts WHERE user_id=$1`, user.ID).Scan(&balance, &reserved, &entries); e != nil || reserved != 0 || entries != 1 || balance != initial.Balance-task.ChargedCredits {
			t.Fatal("assist settlement mismatch", e)
		}
		t.Logf("LIVE ASSIST PASS: job=%s credits=%d, one application and one ledger entry", task.JobID, task.ChargedCredits)
		return
	}
	first := run(s, doc, "请真实验证完整写作链路：先用 skill_view 加载 Skill；用 get_document 读取当前文章；必须用 browser_markdown 浏览 https://example.com，确认 Example Domain；必须用 sandbox_compute 执行 python3 -c 'print(sum(range(1, 11)))'，得到 55；用 save_artifact 保存 verification.txt，内容包含真实计算结果。随后用 propose_operations 提交一个 update 操作，保持原标题，把正文改成简短中文说明，包含 Example Domain 和 55。不需要再次询问目标，当前文档就是目标。等待 Koinote 用户审批，不要声称已应用。")
	ops, err := a.loadAgentOperations(ctx, user.ID, []string{first.ID})
	if err != nil || len(ops) != 1 || ops[0].Status != "pending" {
		t.Fatalf("review proposal missing: %v %v", ops, err)
	}
	unchanged, _ := a.loadAgentReviewDocument(ctx, user.ID, doc.DocID)
	if unchanged.Revision != doc.Revision {
		t.Fatal("review mode wrote before approval")
	}
	used := map[string]bool{}
	rows, err := pool.Query(ctx, `SELECT event FROM writing_agent_events WHERE task_id=$1 AND event->>'type'='tool.completed'`, first.ID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var raw []byte
		rows.Scan(&raw)
		var e struct {
			ToolCall struct {
				Name string `json:"name"`
			} `json:"toolCall"`
			ToolName string `json:"toolName"`
		}
		json.Unmarshal(raw, &e)
		used[e.ToolCall.Name] = true
		used[e.ToolName] = true
	}
	rows.Close()
	for _, name := range []string{"skill_view", "koinote.get_document", "browser_markdown", "sandbox_compute", "koinote.save_artifact", "koinote.propose_operations"} {
		if !used[name] {
			t.Errorf("required tool missing: %s", name)
		}
	}
	// The product retains compact summaries, so verify actual tool results
	// directly from the authenticated remote ledger instead of trusting names
	// or the assistant's report of a successful calculation.
	outputs := map[string]string{}
	after := int64(0)
	for pageNumber := 0; pageNumber < 30; pageNumber++ {
		var page struct {
			Events []struct {
				Seq   int64 `json:"seq"`
				Event struct {
					Type     string `json:"type"`
					ToolCall struct {
						Name string `json:"name"`
					} `json:"toolCall"`
					Output string `json:"output"`
				} `json:"event"`
			} `json:"events"`
			HasMore bool `json:"hasMore"`
		}
		path := fmt.Sprintf("/api/agent/%s/jobs/%s/events?after=%d&limit=100&page=1", first.WorkspaceID, first.JobID, after)
		if err = a.agentGPTRequest(ctx, "GET", path, a.writingExternalID(user.ID), "", nil, &page); err != nil {
			t.Fatal(err)
		}
		for _, e := range page.Events {
			if e.Seq > after {
				after = e.Seq
			}
			if e.Event.Type == "tool.completed" {
				outputs[e.Event.ToolCall.Name] = e.Event.Output
			}
		}
		if !page.HasMore {
			break
		}
	}
	var compute struct {
		ExitCode *int   `json:"exitCode"`
		Stdout   string `json:"stdout"`
	}
	if !strings.Contains(outputs["browser_markdown"], "Example Domain") || json.Unmarshal([]byte(outputs["sandbox_compute"]), &compute) != nil || compute.ExitCode == nil || *compute.ExitCode != 0 || strings.TrimSpace(compute.Stdout) != "55" {
		t.Fatal("remote browser/sandbox output verification failed")
	}
	var artifactID string
	var artifact []byte
	if err = pool.QueryRow(ctx, `SELECT id::text,data FROM agent_artifacts WHERE task_id=$1 AND name='verification.txt'`, first.ID).Scan(&artifactID, &artifact); err != nil || !strings.Contains(string(artifact), "55") {
		t.Fatal("generated artifact missing", err)
	}
	download := writingTestRequest(t, a, user, "GET", "/api/agent/artifacts/"+artifactID, nil)
	if download.Code != 200 || !strings.Contains(download.Body.String(), "55") {
		t.Fatal("artifact download failed")
	}
	for i := 0; i < 2; i++ {
		w := writingTestRequest(t, a, user, "POST", "/api/agent/operations/"+ops[0].ID+"/approve", map[string]string{"hash": ops[0].Hash})
		if w.Code != 200 {
			t.Fatalf("approve %d %s", w.Code, w.Body.String())
		}
	}
	updated, err := a.loadAgentReviewDocument(ctx, user.ID, doc.DocID)
	if err != nil || updated.Revision != doc.Revision+1 || !strings.Contains(updated.Content, "55") {
		t.Fatal("approved result mismatch", err)
	}
	s, err = a.loadAgentSession(ctx, pool, s.ID, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	w := writingTestRequest(t, a, user, "PUT", "/api/agent/sessions/"+s.ID, map[string]any{"permission": "full", "revision": s.Revision})
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	second := run(s, doc, "先调用 get_conversation 查看上一轮记录，然后读取当前文章。在保留全文和标题的基础上，只在末尾追加一段“多轮会话自动应用验证通过。”。使用 propose_operations 完成修改，按工具返回状态报告结果。")
	ops, err = a.loadAgentOperations(ctx, user.ID, []string{second.ID})
	if err != nil || len(ops) != 1 || ops[0].Status != "applied" {
		t.Fatalf("full authorization did not apply: %v %v", ops, err)
	}
	final, _ := a.loadAgentReviewDocument(ctx, user.ID, doc.DocID)
	if final.Revision != updated.Revision+1 || !strings.Contains(final.Content, "多轮会话自动应用验证通过") {
		t.Fatal("continuation modified wrong target or content")
	}
	typo, err := a.createDocument(ctx, createDocumentParams{User: user, Title: "自动审批验证", Content: "这篇文章有一个错别子。"})
	if err != nil {
		t.Fatal(err)
	}
	s, _ = a.loadAgentSession(ctx, pool, s.ID, user.ID)
	w = writingTestRequest(t, a, user, "PUT", "/api/agent/sessions/"+s.ID, map[string]any{"permission": "assist", "revision": s.Revision})
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	third := run(s, typo, "读取当前文档，只把“错别子”修正为“错别字”，保持标题和其余内容不变。使用 propose_operations 提交一个 update，确认属于轻微错字修正后将 minorEdit 设为 true，并根据返回状态报告结果。")
	ops, err = a.loadAgentOperations(ctx, user.ID, []string{third.ID})
	if err != nil || len(ops) != 1 || ops[0].Status != "applied" || ops[0].Approval != "agent" {
		t.Fatalf("assist did not apply verified minor edit: %v %v", ops, err)
	}
	var balance, reserved, entries int64
	if err = pool.QueryRow(ctx, `SELECT balance,reserved,(SELECT count(*) FROM credit_transactions WHERE user_id=$1 AND kind='agent_usage') FROM credit_accounts WHERE user_id=$1`, user.ID).Scan(&balance, &reserved, &entries); err != nil || reserved != 0 || entries != 3 || balance != initial.Balance-first.ChargedCredits-second.ChargedCredits-third.ChargedCredits {
		t.Fatal("multi-turn ledger mismatch", err)
	}
	usage, err := a.storageUsageFor(ctx, user.ID)
	if err != nil || usage.AgentSessionBytes <= int64(len(artifact)) || usage.AgentSessionBytes >= agentTaskStorageBudget {
		t.Fatal("session storage not settled", err)
	}
	t.Logf("LIVE PASS: 3 rounds; review, full, assist; artifact=%s; credits=%d; sessionBytes=%d", artifactID, first.ChargedCredits+second.ChargedCredits+third.ChargedCredits, usage.AgentSessionBytes)
}
