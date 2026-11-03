package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"koinote/backend/internal/model"
)

func TestAgentIntentCompletionRequiresBoundResult(t *testing.T) {
	for _, missing := range []string{"result", "task"} {
		t.Run(missing, func(t *testing.T) {
			a, u, doc := writingTestApp(t)
			ctx := context.Background()
			s := agentTestSession(t, a, u, "review")
			task := bindIntentTaskForTest(t, a, agentTestTask(t, a, u, s, doc, "只给建议"))
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if strings.HasSuffix(r.URL.Path, "/events") {
					json.NewEncoder(w).Encode(map[string]any{"events": []any{}, "hasMore": false})
					return
				}
				body := map[string]any{"id": task.JobID, "status": "completed"}
				if missing == "task" {
					body["result"] = map[string]any{"text": "Done", "usage": map[string]int{"totalTokens": 10}}
				}
				json.NewEncoder(w).Encode(body)
			}))
			defer remote.Close()
			a.cfg.AgentGPTBaseURL = remote.URL
			if err := a.advanceWritingTask(ctx, &task); err != nil {
				t.Fatal(err)
			}
			fresh, err := a.loadWritingTask(ctx, task.ID, u.ID)
			if err != nil || fresh.Status != "failed" || fresh.BillingStatus == "reserved" || fresh.Result != "" {
				t.Fatalf("missing intent did not fail and settle: %+v %v", fresh, err)
			}
		})
	}
}

func intentBindingForTest(task writingTask) agentIntentBinding {
	return agentIntentBinding{SchemaVersion: 1, TaskID: task.SessionID, SessionID: task.SessionID, Version: task.IntentVersion, CurrentMessageID: agentUserMessageID(task.ID), WorkspaceID: task.WorkspaceID, ConversationID: "koinote-writing-" + task.ID, JobID: task.JobID, AppUserID: "isolated-app-user", TenantID: "isolated-tenant", UserID: "isolated-user", FocusSnapshots: []map[string]any{}}
}
func bindIntentTaskForTest(t *testing.T, a *App, task writingTask) writingTask {
	t.Helper()
	task.WorkspaceID = "isolated-workspace"
	task.JobID = mustAgentUUID(t)
	if _, err := a.db.Exec(context.Background(), `UPDATE writing_agent_tasks SET workspace_id=$2,job_id=$3 WHERE id=$1`, task.ID, task.WorkspaceID, task.JobID); err != nil {
		t.Fatal(err)
	}
	return task
}
func TestAgentIntentMCPProofAndAtomicReceipts(t *testing.T) {
	a, u, doc := writingTestApp(t)
	ctx := context.Background()
	s := agentTestSession(t, a, u, "full")
	task := bindIntentTaskForTest(t, a, agentTestTask(t, a, u, s, doc, "重写当前文章，并改标题"))
	agentTestRead(t, a, task, doc)
	srv := httptest.NewServer(a.Routes())
	defer srv.Close()
	client, err := connectMCPClient(ctx, srv.URL+"/api/writing-agent/mcp/"+task.ID, a.writingSecret(task.ID, "mcp"))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	list, err := client.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range list.Tools {
		if tool.Name == "propose_operations" && tool.Meta["agent-gpt/intent"] == nil {
			t.Fatal("missing trusted descriptor")
		}
	}
	inputs := []agentOperationInput{{Key: "edit", Kind: "update", Path: agentDocumentPath(doc.DocID), ExpectedRevision: doc.Revision, Title: "Changed title", Content: "A genuinely changed body."}}
	args := map[string]any{"operations": inputs}
	result, err := client.CallTool(ctx, &mcp.CallToolParams{Name: "validate_operation", Arguments: agentIntentValidateInput{ToolName: "propose_operations", Arguments: args, Task: intentBindingForTest(task)}})
	if err != nil || result.IsError {
		t.Fatalf("MCP prepare: %v %+v", err, result)
	}
	raw, _ := json.Marshal(result.StructuredContent)
	var proof agentIntentProof
	if err = json.Unmarshal(raw, &proof); err != nil || len(proof.Effects) != 2 || proof.Token == "" {
		t.Fatalf("effect diff: %s %v", raw, err)
	}
	var count int
	a.db.QueryRow(ctx, `SELECT count(*) FROM agent_operations WHERE task_id=$1`, task.ID).Scan(&count)
	if count != 0 {
		t.Fatal("preflight produced a proposal")
	}
	bad := proof
	bad.Token = "forged"
	_, err = a.proposeAgentOperations(ctx, task, inputs, agentIntentAuthorization{ToolName: "propose_operations", Proof: &bad})
	if err == nil {
		t.Fatal("forged proof accepted")
	}
	changed := append([]agentOperationInput{}, inputs...)
	changed[0].Content = "Different payload"
	_, err = a.proposeAgentOperations(ctx, task, changed, agentIntentAuthorization{ToolName: "propose_operations", Proof: &proof})
	if err == nil {
		t.Fatal("arguments not bound")
	}
	result, err = client.CallTool(ctx, &mcp.CallToolParams{Name: "propose_operations", Arguments: agentProposeInput{Operations: inputs, Proof: &proof}})
	if err != nil || result.IsError {
		t.Fatalf("MCP apply: %v %+v", err, result)
	}
	raw, _ = json.Marshal(result.StructuredContent)
	var receipt struct {
		Results []struct {
			Status string `json:"status"`
		} `json:"operationResults"`
	}
	json.Unmarshal(raw, &receipt)
	if len(receipt.Results) != 2 || receipt.Results[0].Status != "applied" || receipt.Results[1].Status != "applied" {
		t.Fatalf("receipt: %s", raw)
	}
	fresh, _ := a.loadAgentReviewDocument(ctx, u.ID, doc.DocID)
	if fresh.Title != inputs[0].Title || fresh.Content != inputs[0].Content || fresh.Revision != doc.Revision+1 {
		t.Fatal("real write mismatch")
	}
	// A retry obtains a fresh proof for the immutable prior operation and cannot apply twice.
	_, p, err := a.agentValidateOperation(context.WithValue(ctx, writingMCPContext{}, task), nil, agentIntentValidateInput{ToolName: "propose_operations", Arguments: args, Task: intentBindingForTest(task)})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.proposeAgentOperations(ctx, task, inputs, agentIntentAuthorization{ToolName: "propose_operations", Proof: p}); err != nil {
		t.Fatal(err)
	}
	again, _ := a.loadAgentReviewDocument(ctx, u.ID, doc.DocID)
	if again.Revision != fresh.Revision {
		t.Fatal("retry applied twice")
	}
}

func TestAgentIntentProofFencesChangedAuthorizationAndResources(t *testing.T) {
	for _, change := range []string{"cancel", "version", "permission", "revision", "order", "owner"} {
		t.Run(change, func(t *testing.T) {
			a, u, doc := writingTestApp(t)
			ctx := context.Background()
			s := agentTestSession(t, a, u, "full")
			task := agentTestTask(t, a, u, s, doc, "修改当前文章")
			agentTestRead(t, a, task, doc)
			in := []agentOperationInput{{Key: "edit", Kind: "update", Path: agentDocumentPath(doc.DocID), ExpectedRevision: doc.Revision, Title: doc.Title, Content: "Changed"}}
			proof, err := agentProofForTest(a, ctx, task, "propose_operations", in)
			if err != nil {
				t.Fatal(err)
			}
			switch change {
			case "cancel":
				_, err = a.db.Exec(ctx, `UPDATE writing_agent_tasks SET cancel_requested=true WHERE id=$1`, task.ID)
			case "version":
				_, err = a.db.Exec(ctx, `UPDATE agent_sessions SET intent_version=intent_version+1 WHERE id=$1`, s.ID)
			case "permission":
				_, err = a.db.Exec(ctx, `UPDATE agent_sessions SET permission='review',revision=revision+1 WHERE id=$1`, s.ID)
			case "revision":
				_, err = a.db.Exec(ctx, `UPDATE documents SET content='Concurrent edit',revision=revision+1 WHERE doc_id=$1`, doc.DocID)
			case "order":
				_, err = a.db.Exec(ctx, `UPDATE documents SET sort_order=sort_order+1 WHERE doc_id=$1`, doc.DocID)
			case "owner":
				task.UserID++
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err = a.proposeAgentOperations(ctx, task, in, agentIntentAuthorization{ToolName: "propose_operations", Proof: proof}); err == nil {
				t.Fatal("stale authority accepted")
			}
			var count int
			a.db.QueryRow(ctx, `SELECT count(*) FROM agent_operations WHERE task_id=$1`, task.ID).Scan(&count)
			if count != 0 {
				t.Fatal("partial proposal escaped rollback")
			}
		})
	}
}

func TestAgentIntentHistoryVersionsAndLateResult(t *testing.T) {
	a, u, doc := writingTestApp(t)
	ctx := context.Background()
	s := agentTestSession(t, a, u, "review")
	first := agentTestTask(t, a, u, s, doc, "只给建议，不要修改")
	first = bindIntentTaskForTest(t, a, first)
	state := func(messageID, text string) json.RawMessage {
		b, _ := json.Marshal(map[string]any{"goal": map[string]any{"text": text, "sources": []map[string]string{{"messageId": messageID, "quote": text}}}, "targets": []any{}, "constraints": []any{}, "questions": []any{}, "suggestions": []any{}})
		return b
	}
	resultFor := func(task writingTask, text string) json.RawMessage {
		b, _ := json.Marshal(agentIntentResult{TaskID: s.ID, SessionID: s.ID, InputVersion: task.IntentVersion, CurrentMessageID: agentUserMessageID(task.ID), JobID: task.JobID, State: state(agentUserMessageID(task.ID), text), StateOrigin: "model_inference", Outcome: "model_output"})
		return b
	}
	first.IntentResult = resultFor(first, first.Message)
	if err := a.finishWritingTask(ctx, first, "completed", "", json.RawMessage(`{"totalTokens":0}`), "我也可以改写文章。"); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 7; i++ {
		next := agentTestTask(t, a, u, s, model.Document{}, "继续说明")
		if err := a.finishWritingTask(ctx, next, "completed", "", json.RawMessage(`{"totalTokens":0}`), "建议说明"); err != nil {
			t.Fatal(err)
		}
	}
	current := agentTestTask(t, a, u, s, model.Document{}, "继续说明")
	if current.IntentVersion != 9 || len(current.IntentState) == 0 {
		t.Fatal("version or inherited state missing")
	}
	input := map[string]any{"policy": map[string]any{}}
	if err := a.prepareAgentConversationInput(ctx, &current, input, "skill"); err != nil {
		t.Fatal(err)
	}
	history := input["initialMessages"].([]map[string]any)
	if len(history) != 17 || history[0]["content"] != first.Message || history[16]["id"] != agentUserMessageID(current.ID) {
		t.Fatal("original constraint/history dropped")
	}
	// Same wording with different stable IDs is a new turn. Late older results
	// are retained on that task and cannot replace the current state.
	if _, err := a.db.Exec(ctx, `UPDATE agent_sessions SET intent_state=$2 WHERE id=$1`, s.ID, state(agentUserMessageID(current.ID), current.Message)); err != nil {
		t.Fatal(err)
	}
	tx, _ := a.db.Begin(ctx)
	if err := a.mergeAgentIntentResult(ctx, tx, first); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var merged []byte
	a.db.QueryRow(ctx, `SELECT intent_state FROM agent_sessions WHERE id=$1`, s.ID).Scan(&merged)
	if !strings.Contains(string(merged), agentUserMessageID(current.ID)) {
		t.Fatal("late result overwrote newer state")
	}
	stored, _ := a.loadWritingTask(ctx, first.ID, u.ID)
	if len(stored.IntentResult) == 0 {
		t.Fatal("old result facts discarded")
	}
}

func TestAgentIntentMixedReceiptsAndTransactionRollback(t *testing.T) {
	a, u, doc := writingTestApp(t)
	ctx := context.Background()
	s := agentTestSession(t, a, u, "review")
	task := agentTestTask(t, a, u, s, doc, "修改两篇文章")
	other, err := a.createDocument(ctx, createDocumentParams{User: u, Title: "Other", Content: "Original"})
	if err != nil {
		t.Fatal(err)
	}
	agentTestRead(t, a, task, doc)
	agentTestRead(t, a, task, other)
	first := agentOperationInput{Key: "first", Kind: "update", Path: agentDocumentPath(doc.DocID), ExpectedRevision: doc.Revision, Title: doc.Title, Content: "Pending body"}
	if _, err = proposeAgentOperationsForTest(a, ctx, task, []agentOperationInput{first}); err != nil {
		t.Fatal(err)
	}
	if _, err = a.db.Exec(ctx, `UPDATE agent_sessions SET permission='full',revision=revision+1 WHERE id=$1`, s.ID); err != nil {
		t.Fatal(err)
	}
	second := agentOperationInput{Key: "second", Kind: "update", Path: agentDocumentPath(other.DocID), ExpectedRevision: other.Revision, Title: other.Title, Content: "Applied body"}
	proof, err := agentProofForTest(a, ctx, task, "propose_operations", []agentOperationInput{first, second})
	if err != nil {
		t.Fatal(err)
	}
	ops, err := a.proposeAgentOperations(ctx, task, []agentOperationInput{first, second}, agentIntentAuthorization{ToolName: "propose_operations", Proof: proof})
	if err != nil {
		t.Fatal(err)
	}
	statuses := map[string]string{}
	for _, r := range agentIntentReceipts(task, ops) {
		statuses[r["resourceId"]] = r["status"]
	}
	if statuses[first.Path] != "pending_approval" || statuses[second.Path] != "applied" {
		t.Fatal("flattened mixed result", statuses)
	}
	untouched, _ := a.loadAgentReviewDocument(ctx, u.ID, doc.DocID)
	updated, _ := a.loadAgentReviewDocument(ctx, u.ID, other.DocID)
	if untouched.Revision != doc.Revision || updated.Content != "Applied body" {
		t.Fatal("mixed result differs from actual resources")
	}
	// Invalid second item must not persist a valid first create.
	invalid := []agentOperationInput{{Key: "new", Kind: "create", Title: "Must not persist", Content: "Draft"}, {Key: "bad", Kind: "move", Path: second.Path, ExpectedRevision: other.Revision}}
	if _, err = a.proposeAgentOperations(ctx, task, invalid, agentIntentAuthorization{ToolName: "propose_operations", Proof: proof}); err == nil {
		t.Fatal("invalid batch accepted")
	}
	var count int
	if err = a.db.QueryRow(ctx, `SELECT count(*) FROM agent_operations WHERE task_id=$1 AND request_key='new'`, task.ID).Scan(&count); err != nil || count != 0 {
		t.Fatal("batch partially persisted", err)
	}
}

func TestAgentIntentScopedNegativeDoesNotDisableExplicitWrite(t *testing.T) {
	for _, message := range []string{"修改 A 的正文；B 文档不要修改。", "修改上一轮的文章。当前打开的 Other 文档不要修改。"} {
		if agentAdviceOnly(message) {
			t.Fatal("scoped negative became a global advice flag", message)
		}
	}
	for _, message := range []string{"只给建议，不要修改。", "请不要修改，先解释。", "先不要改正文", "suggestions only"} {
		if !agentAdviceOnly(message) {
			t.Fatal("global advice guard removed", message)
		}
	}
}
