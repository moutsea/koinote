package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf16"

	"koinote/backend/internal/model"
)

// The paired agent-gpt test consumes the actual host request bodies. Without
// the export option these assertions still run in the normal backend suite.
func exportAgentContract(t *testing.T, name string, body any) {
	t.Helper()
	if dir := os.Getenv("KOINOTE_TEST_CONTRACT_DIR"); dir != "" {
		data, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(dir, name+".json"), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestAgentWireContextAndHistory(t *testing.T) {
	a, u, doc := writingTestApp(t)
	ctx := context.Background()
	blank, err := a.createDocument(ctx, createDocumentParams{User: u, Title: "", Content: "手稿"})
	if err != nil {
		t.Fatal(err)
	}
	session := agentTestSession(t, a, u, "full")
	first := agentTestTask(t, a, u, session, blank, "请看这篇无标题文档")
	input := map[string]any{}
	if err = a.prepareAgentIntentInput(ctx, &first, input, ""); err != nil {
		t.Fatal(err)
	}
	focus := input["taskContext"].(map[string]any)["focusSnapshots"].([]map[string]any)[0]["resources"].([]map[string]any)[0]
	if _, exists := focus["title"]; exists || focus["id"] != agentDocumentPath(blank.DocID) {
		t.Fatalf("blank focus: %v", focus)
	}
	exportAgentContract(t, "blank", input)
	if err = a.finishWritingTask(ctx, first, "failed", "old failure", nil, ""); err != nil {
		t.Fatal(err)
	}
	var historicalID string
	for n := 0; n < 4; n++ {
		task := agentTestTask(t, a, u, session, doc, "创建二十个主题文件夹："+strings.Repeat("主题", 2500))
		historicalID = task.ID
		inputs := make([]agentOperationInput, 0, 20)
		for i := 0; i < 20; i++ {
			inputs = append(inputs, agentOperationInput{Key: fmt.Sprintf("key-%d", i), Kind: "folder", Title: fmt.Sprintf("%d-%d-%s", n, i, strings.Repeat("📚", 20)), Explanation: "按主题分类"})
		}
		if _, err := proposeAgentOperationsForTest(a, ctx, task, inputs); err != nil {
			t.Fatal(err)
		}
		if err := a.finishWritingTask(ctx, task, "completed", "", json.RawMessage(`{"totalTokens":0}`), "目录已创建"); err != nil {
			t.Fatal(err)
		}
	}
	next := agentTestTask(t, a, u, session, model.Document{}, "不带文档，继续整理")
	input = map[string]any{}
	if err = a.prepareAgentIntentInput(ctx, &next, input, ""); err != nil {
		t.Fatal(err)
	}
	prompt := input["systemPrompt"].(string)
	if len(utf16.Encode([]rune(prompt))) > 20000 || !strings.Contains(prompt, "via get_conversation") {
		t.Fatal("history was not bounded")
	}
	var count int
	cursor := ""
	mcpCtx := context.WithValue(ctx, writingMCPContext{}, next)
	for {
		_, page, err := a.agentReadConversation(mcpCtx, nil, agentConversationInput{Cursor: cursor, Limit: 10})
		if err != nil {
			t.Fatal(err)
		}
		for _, row := range page["historyNewestFirst"].([]map[string]any) {
			count += len(row["operations"].([]map[string]any))
		}
		nextCursor := page["nextCursor"].(string)
		if nextCursor == "" {
			break
		}
		if cursor == nextCursor {
			t.Fatal("history cursor did not advance")
		}
		cursor = nextCursor
	}
	if count != 80 {
		t.Fatalf("only %d receipts reachable", count)
	}
	cursor = ""
	unique := map[string]bool{}
	for {
		_, page, err := a.agentReadConversation(mcpCtx, nil, agentConversationInput{TaskID: historicalID, Cursor: cursor, Limit: 7})
		if err != nil {
			t.Fatal(err)
		}
		for _, op := range page["operations"].([]map[string]any) {
			unique[op["id"].(string)] = true
		}
		cursor = page["nextCursor"].(string)
		if cursor == "" {
			break
		}
	}
	if len(unique) != 20 {
		t.Fatal("per-task receipt pages lost operations", len(unique))
	}
	other := agentTestTask(t, a, u, agentTestSession(t, a, u, "review"), doc, "另一个会话")
	if _, _, err = a.agentReadConversation(mcpCtx, nil, agentConversationInput{TaskID: other.ID}); err == nil {
		t.Fatal("cross-session receipts exposed")
	}
	body, err := json.Marshal(input)
	if err != nil || len(body) <= 64<<10 {
		t.Fatalf("fixture must exceed the default HTTP envelope: %d bytes, %v", len(body), err)
	}
	exportAgentContract(t, "history", input)
}

func TestAgentWireWorkspaceAvoidsTenantList(t *testing.T) {
	a, u, doc := writingTestApp(t)
	ctx := context.Background()
	task := agentTestTask(t, a, u, agentTestSession(t, a, u, "review"), doc, "整理")
	posts := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/workspaces" {
			t.Error("unexpected tenant-wide workspace request")
		}
		if r.URL.Path != "/api/workspaces/ensure" {
			w.Write([]byte("{}"))
			return
		}
		if r.Method != "POST" {
			t.Error("unbounded tenant listing")
			w.WriteHeader(500)
			return
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body["name"] != "koinote-writing-"+task.ID || body["accessMode"] != "restricted" {
			t.Error("workspace identity", body)
		}
		exportAgentContract(t, "workspace", body)
		posts++
		if posts == 1 {
			w.WriteHeader(503)
			return
		}
		w.Write([]byte(`{"workspace":{"id":"existing-workspace"}}`))
	}))
	defer srv.Close()
	a.cfg.AgentGPTBaseURL = srv.URL
	if err := a.prepareWritingWorkspace(ctx, &task); err == nil {
		t.Fatal("lost response accepted")
	}
	if err := a.prepareWritingWorkspace(ctx, &task); err != nil || task.WorkspaceID != "existing-workspace" || posts != 2 {
		t.Fatal(err, task.WorkspaceID, posts)
	}
}

func TestAgentWireMixedReceipts(t *testing.T) {
	a, u, doc := writingTestApp(t)
	ctx := context.Background()
	task := agentTestTask(t, a, u, agentTestSession(t, a, u, "full"), doc, "调整标题和正文")
	agentTestRead(t, a, task, doc)
	first, err := proposeAgentOperationsForTest(a, ctx, task, []agentOperationInput{{Key: "first", Kind: "update", Path: agentDocumentPath(doc.DocID), ExpectedRevision: doc.Revision, Title: "第一版标题", Content: doc.Content}})
	if err != nil {
		t.Fatal(err)
	}
	resp := writingTestRequest(t, a, u, "POST", "/api/agent/operations/"+first[0].ID+"/undo", map[string]string{"hash": first[0].Hash})
	if resp.Code != 200 {
		t.Fatal(resp.Code, resp.Body.String())
	}
	restored, err := a.loadAgentReviewDocument(ctx, u.ID, doc.DocID)
	if err != nil {
		t.Fatal(err)
	}
	doc.Revision, doc.Title, doc.Content = restored.Revision, restored.Title, restored.Content
	agentTestRead(t, a, task, doc)
	second, err := proposeAgentOperationsForTest(a, ctx, task, []agentOperationInput{{Key: "second", Kind: "update", Path: agentDocumentPath(doc.DocID), ExpectedRevision: restored.Revision, Title: "最终标题", Content: "最终正文"}})
	if err != nil {
		t.Fatal(err)
	}
	_, res, err := a.agentOperationResults(context.WithValue(ctx, writingMCPContext{}, task), nil, agentApprovalInput{OperationIDs: []string{first[0].ID, second[0].ID}})
	if err != nil {
		t.Fatal(err)
	}
	fresh, err := a.loadAgentReviewDocument(ctx, u.ID, doc.DocID)
	if err != nil {
		t.Fatal(err)
	}
	if fresh.Content != "最终正文" {
		t.Fatal("unexpected body")
	}
	for _, r := range res["operationResults"].([]map[string]string) {
		if r["kind"] == "update_content" && r["status"] == "applied" {
			return
		}
	}
	t.Fatal("applied body missing from authoritative receipts", res["operationResults"])
}

func TestAgentWireRepairsPersistedHistoryOnlyAfterDefinitiveRejection(t *testing.T) {
	a, u, doc := writingTestApp(t)
	ctx := context.Background()
	task := agentTestTask(t, a, u, agentTestSession(t, a, u, "review"), doc, "继续")
	input := map[string]any{}
	if err := a.prepareAgentIntentInput(ctx, &task, input, ""); err != nil {
		t.Fatal(err)
	}
	base := input["systemPrompt"].(string)
	oversized := base + agentReceiptMarker + strings.Repeat("📁", 12000)
	input["systemPrompt"] = oversized
	raw, _ := json.Marshal(input)
	if err := a.db.QueryRow(ctx, `UPDATE writing_agent_tasks SET remote_input=$2,workspace_id='fixture-workspace' WHERE id=$1 RETURNING remote_input,workspace_id`, task.ID, raw).Scan(&task.RemoteInput, &task.WorkspaceID); err != nil {
		t.Fatal(err)
	}
	posts := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		posts++
		var sent map[string]any
		if r.URL.Path != "/api/agent/jobs" || r.Header.Get("Idempotency-Key") != "koinote-writing-"+task.ID {
			t.Error("retry changed task identity")
		}
		if err := json.NewDecoder(r.Body).Decode(&sent); err != nil {
			t.Error(err)
		}
		if posts < 3 && sent["systemPrompt"] != oversized {
			t.Error("ambiguous request was rewritten")
		}
		if posts == 2 {
			w.WriteHeader(400)
			fmt.Fprint(w, `{"error":"Invalid systemPrompt"}`)
			return
		}
		if posts == 3 && sent["systemPrompt"] != base+agentReceiptLookup {
			t.Error("legacy receipt not repaired")
		}
		w.WriteHeader(503)
	}))
	defer upstream.Close()
	a.cfg.AgentGPTBaseURL = upstream.URL
	if err := a.advanceWritingTask(ctx, &task); err == nil {
		t.Fatal("expected retry after 503")
	}
	if err := a.advanceWritingTask(ctx, &task); err != nil {
		t.Fatal(err)
	}
	saved, err := a.loadWritingTask(ctx, task.ID, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = a.advanceWritingTask(ctx, &saved); err == nil || posts != 3 {
		t.Fatal("corrected request was not retried", posts, err)
	}
}

func TestAgentWireStateSizeAcrossSettlementAndReplay(t *testing.T) {
	for _, tc := range []struct {
		name, char string
		length     int
		accepted   bool
	}{
		{"unicode", "文", 1500, true}, {"envelope", "a", 3885, true}, {"oversized", "文", 3999, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a, u, doc := writingTestApp(t)
			ctx := context.Background()
			session := agentTestSession(t, a, u, "full")
			first := bindIntentTaskForTest(t, a, agentTestTask(t, a, u, session, doc, "draft"))
			source := []map[string]string{{"messageId": agentUserMessageID(first.ID), "quote": "draft"}}
			targets := []map[string]any{}
			for i := 0; i < 16; i++ {
				targets = append(targets, map[string]any{"unresolved": strings.Repeat(tc.char, tc.length), "sources": source})
			}
			state := map[string]any{"goal": map[string]any{"text": "draft", "sources": source}, "targets": targets, "constraints": []any{}, "questions": []any{}, "suggestions": []any{}}
			first.IntentResult, _ = json.Marshal(map[string]any{"taskId": session.ID, "sessionId": session.ID, "inputVersion": first.IntentVersion, "currentMessageId": agentUserMessageID(first.ID), "jobId": first.JobID, "state": state, "stateOrigin": "model_inference", "outcome": "model_output"})
			if err := a.finishWritingTask(ctx, first, "completed", "", json.RawMessage(`{"totalTokens":1}`), "done"); err != nil {
				t.Fatal(err)
			}
			saved, err := a.loadWritingTask(ctx, first.ID, u.ID)
			if err != nil {
				t.Fatal(err)
			}
			if saved.BillingStatus == "reserved" || (saved.Status == "completed") != tc.accepted {
				t.Fatal(saved.Status, saved.BillingStatus)
			}
			next := agentTestTask(t, a, u, session, model.Document{}, "continue")
			input := map[string]any{}
			if err = a.prepareAgentIntentInput(ctx, &next, input, ""); err != nil {
				t.Fatal(err)
			}
			if tc.accepted {
				if _, ok := input["taskContext"].(map[string]any)["state"]; !ok {
					t.Fatal("lost accepted state")
				}
				exportAgentContract(t, "state_"+tc.name, input)
			} else if saved.Status != "failed" {
				t.Fatal("invalid result kept the session busy")
			}
		})
	}
}

func TestAgentWireSettleAndContinue(t *testing.T) {
	longAnswer := strings.Repeat("文", 45000) + "保留到最后"
	for _, tc := range []struct {
		name, outcome, reply, modelOutput string
		invalid                           bool
	}{
		{"long-answer", "model_output", strings.Repeat("a", 32000), strings.Repeat("a", 32000), false},
		{"long-chinese", "model_output", longAnswer, longAnswer, false},
		{"legacy-chinese", "model_output", longAnswer, longAnswer, false},
		{"legacy-redacted", "model_output", longAnswer + " token: [redacted]", longAnswer + " token: private-test-value", false},
		{"distinct-draft", "operations_reported", "宿主操作已完成", "模型草稿", false},
		{"invalid-state", "model_output", "reply", "reply", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a, u, doc := writingTestApp(t)
			ctx := context.Background()
			session := agentTestSession(t, a, u, "full")
			first := bindIntentTaskForTest(t, a, agentTestTask(t, a, u, session, doc, "draft"))
			goal := "draft"
			if tc.invalid {
				goal += "\x00"
			}
			source := map[string]string{"messageId": agentUserMessageID(first.ID), "quote": "draft"}
			state := map[string]any{"goal": map[string]any{"text": goal, "sources": []any{source}}, "targets": []any{}, "constraints": []any{}, "questions": []any{}, "suggestions": []any{}}
			outcome := map[string]any{"taskId": session.ID, "sessionId": session.ID, "inputVersion": first.IntentVersion, "currentMessageId": agentUserMessageID(first.ID), "jobId": first.JobID, "state": state, "stateOrigin": "model_inference", "outcome": tc.outcome, "modelOutput": tc.modelOutput}
			path := "/api/agent/" + first.WorkspaceID + "/jobs/" + first.JobID
			summaryQueries := make(chan string, 8)
			host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case path:
					if r.Header.Get("X-App-User") != a.writingExternalID(u.ID) || r.URL.Query().Get("view") != "settlement" {
						http.Error(w, "expected owner settlement", 403)
						return
					}
					summaryQueries <- r.URL.RawQuery
					json.NewEncoder(w).Encode(map[string]any{"id": first.JobID, "status": "completed", "result": map[string]any{"text": tc.reply, "usage": map[string]int{"totalTokens": 1}, "task": outcome}})
				case path + "/events":
					json.NewEncoder(w).Encode(map[string]any{"events": []any{}, "hasMore": false})
				default:
					http.NotFound(w, r)
				}
			}))
			defer host.Close()
			a.cfg.AgentGPTBaseURL = host.URL
			if err := a.advanceWritingTask(ctx, &first); err != nil {
				t.Fatal(err)
			}
			saved, err := a.loadWritingTask(ctx, first.ID, u.ID)
			if err != nil || !writingTerminal(saved.Status) || saved.BillingStatus == "reserved" || (saved.Status == "completed") == tc.invalid {
				t.Fatal(saved.Status, saved.BillingStatus, err)
			}
			if err = a.advanceWritingTask(ctx, &first); err != nil {
				t.Fatal(err)
			}
			replayed, err := a.loadWritingTask(ctx, first.ID, u.ID)
			if err != nil || saved.ChargedCredits != replayed.ChargedCredits || replayed.Status != saved.Status {
				t.Fatal("settlement changed on retry", err)
			}
			public, err := json.Marshal(saved)
			if err != nil || strings.Contains(string(public), `"modelOutput"`) || strings.Contains(string(public), `"stateOrigin"`) {
				t.Fatal("private continuation in public task", err)
			}
			if !tc.invalid && (saved.TaskIntent == nil || saved.TaskIntent.Outcome != tc.outcome) {
				t.Fatal("public result omitted the outcome")
			}
			if strings.Contains(tc.name, "chinese") || tc.name == "legacy-redacted" {
				if saved.Result != writingDisplayResult(tc.reply) || saved.Result == tc.reply {
					t.Fatal("display unexpectedly lost its limit")
				}
			}
			if strings.HasPrefix(tc.name, "legacy-") {
				if _, err := a.db.Exec(ctx, "UPDATE writing_agent_tasks SET result=$2 WHERE id=$1", first.ID, saved.Result); err != nil {
					t.Fatal(err)
				}
			}
			next := agentTestTask(t, a, u, session, model.Document{}, "continue")
			input := map[string]any{}
			if err = a.prepareAgentIntentInput(ctx, &next, input, ""); err != nil {
				t.Fatal(err)
			}
			if tc.invalid {
				if string(next.IntentState) != "" && string(next.IntentState) != "null" {
					t.Fatal("invalid state was persisted")
				}
				return
			}
			found := false
			for _, message := range input["initialMessages"].([]map[string]any) {
				if message["id"] != "assistant:"+first.ID {
					continue
				}
				found = true
				answer := message["content"].(string)
				if (tc.outcome == "model_output" && answer != tc.reply) || (tc.outcome != "model_output" && (strings.Count(answer, tc.modelOutput) != 1 || !strings.Contains(answer, tc.reply))) {
					t.Fatal("incorrect historical answer", len(answer))
				}
			}
			if !found {
				t.Fatal("missing assistant history")
			}
			if tc.name == "long-answer" {
				exportAgentContract(t, "settlement", map[string]string{"query": <-summaryQueries})
			}
		})
	}
}

func TestAgentWireLegacyHistoryRequiresMatchingSettlement(t *testing.T) {
	a, u, _ := writingTestApp(t)
	long := strings.Repeat("文", 45000) + "已脱敏"
	display := writingDisplayResult(long)
	for _, tc := range []struct {
		name, id, text string
		status         int
		permanent      bool
	}{
		{"other-job", "other", long, 200, true},
		{"clipped", "job", display, 200, true},
		{"mismatch", "job", "其他回答", 200, true},
		{"forbidden", "", "", 403, true},
		{"unavailable", "", "", 503, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			host := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/api/agent/ws/jobs/job" || r.URL.Query().Get("view") != "settlement" || r.Header.Get("X-App-User") != a.writingExternalID(u.ID) {
					t.Error("incorrect historical job identity")
				}
				w.WriteHeader(tc.status)
				_ = json.NewEncoder(w).Encode(map[string]any{"id": tc.id, "status": "completed", "result": map[string]string{"text": tc.text}})
			}))
			defer host.Close()
			a.cfg.AgentGPTBaseURL = host.URL
			content, err := a.restoreWritingHistory(context.Background(), u.ID, "ws", "job", display, long+" token:fixture")
			if content != "" || err == nil || errors.Is(err, errAgentInput) != tc.permanent {
				t.Fatal("unverified history was returned or error misclassified", err)
			}
		})
	}
}

func TestAgentWirePostgresUnicode(t *testing.T) {
	for _, value := range []string{`"\\u0000"`, `"\ud83d\ude03"`, `{"🌏":"ok"}`} {
		if !postgresWireJSON([]byte(value)) {
			t.Errorf("rejected %s", value)
		}
	}
	for _, value := range []string{`{"\u0000":1}`, `"\ud800"`, `"\ude01"`, `"\ud800\u0000"`} {
		if postgresWireJSON([]byte(value)) {
			t.Errorf("accepted %s", value)
		}
	}
}
