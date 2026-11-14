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

func agentTestSession(t *testing.T, a *App, u model.User, mode string) agentSession {
	t.Helper()
	id, _ := randomUUID()
	w := writingTestRequest(t, a, u, "POST", "/api/agent/sessions", map[string]any{"id": id})
	if w.Code != 200 {
		t.Fatalf("session create: %d %s", w.Code, w.Body.String())
	}
	var out struct {
		Session agentSession `json:"session"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if mode != "review" {
		w = writingTestRequest(t, a, u, "PUT", "/api/agent/sessions/"+id, map[string]any{"permission": mode, "revision": out.Session.Revision})
		if w.Code != 200 {
			t.Fatalf("set permission: %d %s", w.Code, w.Body.String())
		}
		json.Unmarshal(w.Body.Bytes(), &out)
	}
	return out.Session
}
func agentTestTask(t *testing.T, a *App, u model.User, s agentSession, doc model.Document, message string, headers ...http.Header) writingTask {
	t.Helper()
	id, _ := randomUUID()
	in := map[string]any{"requestId": id, "message": message}
	if doc.DocID != "" {
		in["context"] = map[string]string{"title": doc.Title, "path": agentDocumentPath(doc.DocID)}
	}
	w := writingTestRequest(t, a, u, "POST", "/api/agent/sessions/"+s.ID+"/tasks", in, headers...)
	if w.Code != 202 {
		t.Fatalf("task create: %d %s", w.Code, w.Body.String())
	}
	var out struct {
		Task writingTask `json:"task"`
	}
	json.Unmarshal(w.Body.Bytes(), &out)
	task, err := a.loadWritingTask(context.Background(), out.Task.ID, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	return task
}
func agentTestRead(t *testing.T, a *App, task writingTask, doc model.Document) {
	t.Helper()
	ctx := context.WithValue(context.Background(), writingMCPContext{}, task)
	_, _, err := a.agentReadDocument(ctx, nil, agentReadInput{Path: agentDocumentPath(doc.DocID)})
	if err != nil {
		t.Fatal(err)
	}
}
func TestAgentSessionContextHistoryAndIsolation(t *testing.T) {
	a, u, doc := writingTestApp(t)
	s := agentTestSession(t, a, u, "review")
	task := agentTestTask(t, a, u, s, doc, "请阅读这篇文章")
	if task.Source.Content != "" || task.Source.Revision != 0 || task.Source.Title != doc.Title || task.Source.Path != agentDocumentPath(doc.DocID) {
		t.Fatal("initial context included content or failed to resolve title/path")
	}
	var count int
	if err := a.db.QueryRow(context.Background(), `SELECT count(*) FROM agent_document_reads WHERE task_id=$1`, task.ID).Scan(&count); err != nil || count != 0 {
		t.Fatal("eager document snapshot")
	}
	srv := httptest.NewServer(a.Routes())
	defer srv.Close()
	client, err := connectMCPClient(context.Background(), srv.URL+"/api/writing-agent/mcp/"+task.ID, a.writingSecret(task.ID, "mcp"))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	assertMCPToolSet(t, client, []string{"search_repositories", "find_skills", "load_skill", "get_document", "search_documents", "list_folders", "get_conversation", "get_operation_results", "propose_operations", "propose_document_change", "save_artifact", "validate_operation"})
	result, err := client.CallTool(context.Background(), &mcp.CallToolParams{Name: "get_document", Arguments: map[string]any{}})
	if err != nil || result.IsError {
		t.Fatalf("read: %v %v", result, err)
	}
	other := insertAgentReviewTestUser(t, a.db)
	foreign, err := a.createDocument(context.Background(), createDocumentParams{User: other, Title: "private", Content: "secret"})
	if err != nil {
		t.Fatal(err)
	}
	result, err = client.CallTool(context.Background(), &mcp.CallToolParams{Name: "get_document", Arguments: map[string]any{"path": agentDocumentPath(foreign.DocID)}})
	if err != nil || !result.IsError {
		t.Fatal("cross-account document accessible")
	}
	blocked := writingTestRequest(t, a, u, "POST", "/api/agent/sessions/"+s.ID+"/tasks", map[string]any{"requestId": mustAgentUUID(t), "message": "another"})
	if blocked.Code != 409 {
		t.Fatal("same session allowed concurrent tasks")
	}
	if err = a.finishWritingTask(context.Background(), task, "completed", "", json.RawMessage(`{"totalTokens":2001}`), "已读取原文"); err != nil {
		t.Fatal(err)
	}
	next := agentTestTask(t, a, u, s, model.Document{}, "继续刚才那篇")
	history, _, err := a.agentConversationHistory(context.Background(), next, "", 6)
	if err != nil || len(history) != 1 || history[0]["assistant"] != "已读取原文" {
		t.Fatalf("history %v %v", history, err)
	}
	page := writingTestRequest(t, a, u, "GET", "/api/agent/sessions/"+s.ID, nil)
	if page.Code != 200 || !strings.Contains(page.Body.String(), "已读取原文") {
		t.Fatal("history not persisted")
	}
}
func mustAgentUUID(t *testing.T) string {
	t.Helper()
	id, err := randomUUID()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestAgentPermissionModesAndImmutableOperations(t *testing.T) {
	for _, mode := range []string{"review", "assist", "full"} {
		t.Run(mode, func(t *testing.T) {
			a, u, _ := writingTestApp(t)
			doc, err := a.createDocument(context.Background(), createDocumentParams{User: u, Title: "文章", Content: "我发现了错别子。"})
			if err != nil {
				t.Fatal(err)
			}
			s := agentTestSession(t, a, u, mode)
			task := agentTestTask(t, a, u, s, doc, "修复错别字")
			agentTestRead(t, a, task, doc)
			input := agentOperationInput{Key: "fix", Kind: "update", Path: agentDocumentPath(doc.DocID), ExpectedRevision: doc.Revision, Title: doc.Title, Content: "我发现了错别字。", MinorEdit: true}
			ops, err := proposeAgentOperationsForTest(a, context.Background(), task, []agentOperationInput{input})
			if err != nil {
				t.Fatal(err)
			}
			want := "applied"
			if mode == "review" {
				want = "pending"
			}
			if ops[0].Status != want {
				t.Fatalf("status=%s want=%s", ops[0].Status, want)
			}
			replay, err := proposeAgentOperationsForTest(a, context.Background(), task, []agentOperationInput{input})
			if err != nil || replay[0].ID != ops[0].ID {
				t.Fatal("proposal replay failed", err)
			}
			input.Content = "覆盖内容"
			if _, err = proposeAgentOperationsForTest(a, context.Background(), task, []agentOperationInput{input}); err == nil {
				t.Fatal("mutable proposal")
			}
			for i := 0; i < 2; i++ {
				w := writingTestRequest(t, a, u, "POST", "/api/agent/operations/"+ops[0].ID+"/approve", map[string]string{"hash": ops[0].Hash})
				if w.Code != 200 {
					t.Fatalf("approve %d %s", w.Code, w.Body.String())
				}
			}
			final, err := a.loadAgentReviewDocument(context.Background(), u.ID, doc.DocID)
			if err != nil || final.Revision != doc.Revision+1 || final.Content != "我发现了错别字。" {
				t.Fatal("incorrect apply", err)
			}
			w := writingTestRequest(t, a, u, "POST", "/api/agent/operations/"+ops[0].ID+"/undo", map[string]string{"hash": ops[0].Hash})
			if w.Code != 200 {
				t.Fatalf("undo %d %s", w.Code, w.Body.String())
			}
			final, _ = a.loadAgentReviewDocument(context.Background(), u.ID, doc.DocID)
			if final.Content != doc.Content {
				t.Fatal("undo failed")
			}
		})
	}
}
func TestAgentAssistRejectsSemanticAndBatchChanges(t *testing.T) {
	a, u, doc := writingTestApp(t)
	s := agentTestSession(t, a, u, "assist")
	task := agentTestTask(t, a, u, s, doc, "修改内容")
	agentTestRead(t, a, task, doc)
	ops, err := proposeAgentOperationsForTest(a, context.Background(), task, []agentOperationInput{{Key: "important", Kind: "update", Path: agentDocumentPath(doc.DocID), ExpectedRevision: doc.Revision, Title: doc.Title, Content: "金额改成 10000，删除原有观点。", MinorEdit: true}})
	if err != nil {
		t.Fatal(err)
	}
	if ops[0].Status != "pending" {
		t.Fatal("model classification bypassed review")
	}
	w := writingTestRequest(t, a, u, "PUT", "/api/agent/sessions/"+s.ID, map[string]any{"permission": "full", "revision": s.Revision + 1})
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	persisted, _ := a.loadAgentOperations(context.Background(), u.ID, []string{task.ID})
	if persisted[0].Status != "pending" {
		t.Fatal("permission escalation applied old proposal")
	}
	if err = a.cancelAgentTask(context.Background(), u.ID, task.ID); err != nil {
		t.Fatal(err)
	}
	w = writingTestRequest(t, a, u, "POST", "/api/agent/operations/"+ops[0].ID+"/approve", map[string]string{"hash": ops[0].Hash})
	if w.Code != 409 {
		t.Fatalf("cancelled op applied: %d", w.Code)
	}
}
func TestAgentFullAuthorizationAdviceAndConflict(t *testing.T) {
	a, u, doc := writingTestApp(t)
	s := agentTestSession(t, a, u, "full")
	task := agentTestTask(t, a, u, s, doc, "先给建议，暂时别改")
	agentTestRead(t, a, task, doc)
	ops, err := proposeAgentOperationsForTest(a, context.Background(), task, []agentOperationInput{{Key: "suggestion", Kind: "update", Path: agentDocumentPath(doc.DocID), ExpectedRevision: doc.Revision, Title: doc.Title, Content: "建议内容"}})
	if err != nil {
		t.Fatal(err)
	}
	if ops[0].Status != "pending" {
		t.Fatal("advice-only instruction ignored")
	}
	_, err = a.updateDocument(context.Background(), updateDocumentParams{User: u, DocID: doc.DocID, Title: doc.Title, Content: "用户的新内容", Theme: doc.Theme, ExpectedRevision: doc.Revision, Source: documentSourceWeb})
	if err != nil {
		t.Fatal(err)
	}
	w := writingTestRequest(t, a, u, "POST", "/api/agent/operations/"+ops[0].ID+"/approve", map[string]string{"hash": ops[0].Hash})
	if w.Code != 409 {
		t.Fatalf("stale proposal applied: %d %s", w.Code, w.Body.String())
	}
}
func TestAgentSessionDeletionReleasesStorageAndPreventsResurrection(t *testing.T) {
	a, u, doc := writingTestApp(t)
	s := agentTestSession(t, a, u, "full")
	task := agentTestTask(t, a, u, s, doc, "新建草稿")
	agentTestRead(t, a, task, doc)
	ops, err := proposeAgentOperationsForTest(a, context.Background(), task, []agentOperationInput{{Key: "new", Kind: "create", Title: "新文章", Content: "草稿内容"}})
	if err != nil {
		t.Fatal(err)
	}
	if ops[0].Status != "applied" {
		t.Fatal("full create not applied")
	}
	before, err := a.storageUsageFor(context.Background(), u.ID)
	if err != nil || before.AgentSessionBytes < agentTaskStorageBudget {
		t.Fatal("space not reserved", err)
	}
	w := writingTestRequest(t, a, u, "DELETE", "/api/agent/sessions/"+s.ID, nil)
	if w.Code != 200 {
		t.Fatalf("delete %d %s", w.Code, w.Body.String())
	}
	if err = a.finishWritingTask(context.Background(), task, "completed", "", json.RawMessage(`{"totalTokens":2000}`), "late result"); err != nil {
		t.Fatal(err)
	}
	after, err := a.storageUsageFor(context.Background(), u.ID)
	if err != nil || after.AgentSessionBytes != 0 {
		t.Fatal("space not released", err)
	}
	var result string
	a.db.QueryRow(context.Background(), `SELECT result FROM writing_agent_tasks WHERE id=$1`, task.ID).Scan(&result)
	if result != "" {
		t.Fatal("late callback restored deleted content")
	}
	if _, err = a.loadAgentReviewDocument(context.Background(), u.ID, ops[0].Result.DocID); err != nil {
		t.Fatal("deleting chat deleted applied document", err)
	}
	w = writingTestRequest(t, a, u, "GET", "/api/agent/sessions/"+s.ID, nil)
	if w.Code != 404 {
		t.Fatal("deleted session visible")
	}
}
