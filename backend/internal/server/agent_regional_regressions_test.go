package server

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestUndoCreatedAgentFolderProtectsSyncGrant(t *testing.T) {
	a, u, doc := writingTestApp(t)
	ctx := context.Background()
	task := bindIntentTaskForTest(t, a, agentTestTask(t, a, u, agentTestSession(t, a, u, "full"), doc, "创建文件夹"))
	ops, e := proposeAgentOperationsForTest(a, ctx, task, approvalFolderInputs()[:1])
	if e != nil {
		t.Fatal(e)
	}
	op := ops[0]
	account := mustAgentUUID(t)
	_, e = a.db.Exec(ctx, "INSERT INTO wechat_official_accounts(account_id,user_id,label,app_id,app_secret_ciphertext,app_secret_hint) VALUES($1,$2,'test',$4,$3,'test')", account, u.ID, []byte("test"), account)
	if e != nil {
		t.Fatal(e)
	}
	var token int
	e = a.db.QueryRow(ctx, "INSERT INTO mcp_tokens(token_id,user_id,name,token_hash,token_hint,scope) VALUES($1,$2,'test',$3,'test','write') RETURNING id", mustAgentUUID(t), u.ID, []byte(account)).Scan(&token)
	if e != nil {
		t.Fatal(e)
	}
	tag, e := a.db.Exec(ctx, "INSERT INTO mcp_wechat_sync_grants(token_id,account_id,folder_id) SELECT $1,$2,id FROM folders WHERE folder_id=$3", token, account, op.Result.FolderID)
	if e != nil || tag.RowsAffected() != 1 {
		t.Fatal(tag, e)
	}
	w := writingTestRequest(t, a, u, http.MethodPost, "/api/agent/operations/"+op.ID+"/undo", map[string]string{"hash": op.Hash})
	var n int
	if e = a.db.QueryRow(ctx, "SELECT count(*) FROM mcp_wechat_sync_grants WHERE token_id=$1", token).Scan(&n); e != nil {
		t.Fatal(e)
	}
	t.Logf("undo HTTP %d, existing sync grants after undo %d", w.Code, n)
	if w.Code != 409 || n != 1 || agentFolderCount(t, a, op.Result.FolderID) != 1 {
		t.Fatalf("undo discarded folder or grant: %d %s", w.Code, w.Body)
	}
}
func TestUndoDeletedAgentFoldersRestoresParentFirst(t *testing.T) {
	a, u, doc := writingTestApp(t)
	ctx := context.Background()
	parent := seedAgentEmptyFolder(t, a, u.ID, "父", "", "")
	child := seedAgentEmptyFolder(t, a, u.ID, "子", parent, "")
	task := bindIntentTaskForTest(t, a, agentTestTask(t, a, u, agentTestSession(t, a, u, "full"), doc, "请清理这两个空文件夹"))
	for _, id := range []string{child, parent} {
		_, e := proposeAgentOperationsForTest(a, ctx, task, agentFolderDeleteInputs(t, a, task, id))
		if e != nil {
			t.Fatal(e)
		}
	}
	ops, e := a.loadAgentOperations(ctx, u.ID, []string{task.ID})
	if e != nil {
		t.Fatal(e)
	}
	w := writingTestRequest(t, a, u, "POST", "/api/agent/tasks/"+task.ID+"/operations/undo", approvalBatchBody(ops))
	t.Logf("batch undo HTTP %d; restored %d of 2", w.Code, agentFolderCount(t, a, child, parent))
	if w.Code != 200 || agentFolderCount(t, a, child, parent) != 2 {
		t.Fatal(w.Body.String())
	}
	var restoredParent string
	if e = a.db.QueryRow(ctx, "SELECT p.folder_id FROM folders c JOIN folders p ON p.id=c.parent_id WHERE c.folder_id=$1", child).Scan(&restoredParent); e != nil || restoredParent != parent {
		t.Fatal(restoredParent, e)
	}
	if w = writingTestRequest(t, a, u, "POST", "/api/agent/tasks/"+task.ID+"/operations/undo", approvalBatchBody(ops)); w.Code != 200 {
		t.Fatal("retry", w.Body)
	}
}
func TestWaitingApprovalsReleaseExecutionSlots(t *testing.T) {
	a, u, doc := writingTestApp(t)
	ctx := context.Background()
	var prior []writingTask
	for i := 0; i < 2; i++ {
		task := bindIntentTaskForTest(t, a, agentTestTask(t, a, u, agentTestSession(t, a, u, "review"), doc, "创建文件夹"))
		prior = append(prior, task)
	}
	third := agentTestTask(t, a, u, agentTestSession(t, a, u, "review"), doc, "继续写作")
	ok, e := a.claimAgentDispatch(ctx, &third)
	if e != nil || ok {
		t.Fatal("executing tasks exceeded the cap", ok, e)
	}
	if time.Until(third.Deadline) < 23*time.Hour {
		t.Fatal("queued task got an execution deadline")
	}
	for _, task := range prior {
		if _, err := a.db.Exec(ctx, "UPDATE writing_agent_tasks SET status='awaiting_approval',approval_checkpoint='test-pause',deadline=now()+interval '24 hours' WHERE id=$1", task.ID); err != nil {
			t.Fatal(err)
		}
	}
	ok, e = a.claimAgentDispatch(ctx, &third)
	if e != nil || !ok {
		t.Fatal("waiting approvals held both slots", ok, e)
	}
	if remaining := time.Until(third.Deadline); remaining > 20*time.Minute || remaining < 19*time.Minute {
		t.Fatal("execution did not get a fresh deadline", remaining)
	}
	var hold time.Time
	if e = a.db.QueryRow(ctx, "SELECT expires_at FROM credit_reservations WHERE reservation_id=$1", third.ID).Scan(&hold); e != nil || !hold.Equal(third.Deadline.Add(10*time.Minute)) {
		t.Fatal("reservation", hold, e)
	}

}
func TestUndoCreatedAgentFolderProtectsConcurrentMove(t *testing.T) {
	a, u, doc := writingTestApp(t)
	ctx := context.Background()
	task := bindIntentTaskForTest(t, a, agentTestTask(t, a, u, agentTestSession(t, a, u, "full"), doc, "创建文件夹"))
	ops, e := proposeAgentOperationsForTest(a, ctx, task, approvalFolderInputs()[:1])
	if e != nil {
		t.Fatal(e)
	}
	op := ops[0]
	tx, e := a.db.Begin(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer tx.Rollback(ctx)
	if _, e = tx.Exec(ctx, "UPDATE documents SET folder_id=(SELECT id FROM folders WHERE folder_id=$1) WHERE doc_id=$2", op.Result.FolderID, doc.DocID); e != nil {
		t.Fatal(e)
	}
	done := make(chan int, 1)
	go func() {
		w := writingTestRequest(t, a, u, http.MethodPost, "/api/agent/operations/"+op.ID+"/undo", map[string]string{"hash": op.Hash})
		done <- w.Code
	}()
	blockerDeadline := time.Now().Add(4 * time.Second)
	for {
		var waiting bool
		if e = a.db.QueryRow(ctx, "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT f.id,f.folder_id%FOR UPDATE OF f')").Scan(&waiting); e != nil {
			t.Fatal(e)
		}
		if waiting {
			break
		}
		if time.Now().After(blockerDeadline) {
			t.Fatal("undo never waited for the concurrent move")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if e = tx.Commit(ctx); e != nil {
		t.Fatal(e)
	}
	status := <-done
	var root bool
	if e = a.db.QueryRow(ctx, "SELECT folder_id IS NULL FROM documents WHERE doc_id=$1", doc.DocID).Scan(&root); e != nil {
		t.Fatal(e)
	}
	if status != 409 || root || agentFolderCount(t, a, op.Result.FolderID) != 1 {
		t.Fatalf("undo discarded concurrent move: HTTP %d, root=%v", status, root)
	}
}
func TestMalformedAgentEventStoresOnlySafeProgress(t *testing.T) {
	a, u, doc := writingTestApp(t)
	ctx := context.Background()
	task := bindIntentTaskForTest(t, a, agentTestTask(t, a, u, agentTestSession(t, a, u, "review"), doc, "测试活动"))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"events":[{"seq":1,"event":{"type":"tool.completed","version":"1","input":"RAW_TOOL_ARGUMENT_FIXTURE", "error":"RAW_PRIVATE_FIXTURE"}},{"seq":2,"event":{"type":"task.model_started","stage":"interpret","input":"RAW_MODEL_FIXTURE"}}],"hasMore":false}`)
	}))
	defer srv.Close()
	a.cfg.AgentGPTBaseURL = srv.URL
	if err := a.collectWritingEvents(ctx, &task, "/review"); err != nil {
		t.Fatal(err)
	}
	w := writingTestRequest(t, a, u, "GET", "/api/writing-agent/tasks/"+task.ID, nil)
	var storedInput string
	if err := a.db.QueryRow(ctx, "SELECT event::text FROM writing_agent_events WHERE task_id=$1 AND seq=1", task.ID).Scan(&storedInput); err != nil {
		t.Fatal(err)
	}
	if storedInput != `{"type": "unknown"}` || w.Code != 200 || strings.Contains(w.Body.String(), "FIXTURE") {
		t.Fatalf("raw diagnostics leaked: stored=%s detail=%s", storedInput, w.Body)
	}
	if !strings.Contains(w.Body.String(), `"stage":"interpret"`) {
		t.Fatal("task assessment stage was lost from execution history", w.Body)
	}
	// A task from an older worker may still have the unfiltered event in storage.
	if _, err := a.db.Exec(ctx, `UPDATE writing_agent_events SET event='{"type":"tool.completed","error":"OLD_FIXTURE"}' WHERE task_id=$1`, task.ID); err != nil {
		t.Fatal(err)
	}
	w = writingTestRequest(t, a, u, "GET", "/api/writing-agent/tasks/"+task.ID, nil)
	if w.Code != 200 || strings.Contains(w.Body.String(), "OLD_FIXTURE") {
		t.Fatal(w.Body)
	}
}
