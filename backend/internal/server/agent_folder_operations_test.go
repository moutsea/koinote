package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func seedAgentEmptyFolder(t *testing.T, a *App, userID int, name, parent, kind string) string {
	t.Helper()
	id := mustAgentUUID(t)
	_, err := a.db.Exec(context.Background(), `INSERT INTO folders(folder_id,user_id,name,parent_id,organizer_kind) VALUES($1,$2,$3,(SELECT id FROM folders WHERE folder_id=NULLIF($4,'')),NULLIF($5,''))`, id, userID, name, parent, kind)
	if err != nil {
		t.Fatal(err)
	}
	return id
}
func agentFolderDeleteInputs(t *testing.T, a *App, task writingTask, ids ...string) []agentOperationInput {
	t.Helper()
	_, result, err := a.agentListFolders(context.WithValue(context.Background(), writingMCPContext{}, task), nil, agentSearchInput{Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	inputs := []agentOperationInput{}
	for _, id := range ids {
		found := false
		for _, f := range result["folders"].([]map[string]any) {
			if f["folderId"] != id {
				continue
			}
			found = true
			if f["canDeleteEmpty"] != true {
				t.Fatalf("folder is not eligible: %v", f)
			}
			inputs = append(inputs, agentOperationInput{Key: "delete-" + id, Kind: "delete_folder", Path: f["path"].(string), ExpectedFolderVersion: f["version"].(string), Explanation: "删除空文件夹"})
		}
		if !found {
			t.Fatal("missing folder", id)
		}
	}
	return inputs
}
func agentFolderCount(t *testing.T, a *App, ids ...string) int {
	t.Helper()
	var count int
	if err := a.db.QueryRow(context.Background(), `SELECT count(*) FROM folders WHERE folder_id=ANY($1)`, ids).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func TestAgentEmptyFolderBatchDeleteResumeAndUndo(t *testing.T) {
	a, u, doc := writingTestApp(t)
	ctx := context.Background()
	parent := seedAgentEmptyFolder(t, a, u.ID, "归档", "", "")
	ids := []string{seedAgentEmptyFolder(t, a, u.ID, "202608", parent, "smart"), seedAgentEmptyFolder(t, a, u.ID, "最近 7 天", "", "activity")}
	task := bindIntentTaskForTest(t, a, agentTestTask(t, a, u, agentTestSession(t, a, u, "review"), doc, "清理所有空文件夹"))
	inputs := agentFolderDeleteInputs(t, a, task, ids...)
	ops, err := proposeAgentOperationsForTest(a, ctx, task, inputs)
	if err != nil {
		t.Fatal(err)
	}
	if len(ops) != 2 || agentFolderCount(t, a, ids...) != 2 {
		t.Fatal("proposal executed before approval")
	}
	// Retries preserve the same proposal IDs and snapshots.
	retried, err := proposeAgentOperationsForTest(a, ctx, task, inputs)
	if err != nil || retried[0].ID != ops[0].ID {
		t.Fatal("retry duplicated proposals", err)
	}
	operationIDs := []string{ops[0].ID, ops[1].ID}
	checkpoint, _ := json.Marshal(map[string]any{"version": 1, "operationIds": operationIDs})
	job := writingRemoteJob{ID: task.JobID, Status: "awaiting_approval", Approval: &agentRemoteApproval{ToolName: "host_operations", CheckpointID: "folder-gate", ToolCallID: "host-operations:1", Input: checkpoint, ExpiresAt: time.Now().Add(time.Hour)}}
	wakeups := 0
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "/jobs/"+task.JobID+"/approve-checkpoint") {
			t.Errorf("resumed another job: %s", r.URL.Path)
		}
		wakeups++
		fmt.Fprint(w, `{"approved":true}`)
	}))
	defer remote.Close()
	a.cfg.AgentGPTBaseURL = remote.URL
	remotePath := "/api/agent/" + task.WorkspaceID + "/jobs/" + task.JobID
	if err = a.advanceAgentApproval(ctx, &task, job, remotePath); err != nil {
		t.Fatal(err)
	}
	if wakeups != 0 {
		t.Fatal("resumed before approval")
	}
	path := "/api/agent/tasks/" + task.ID + "/operations/"
	for i := 0; i < 2; i++ {
		if w := writingTestRequest(t, a, u, "POST", path+"approve", approvalBatchBody(ops)); w.Code != 200 {
			t.Fatalf("approve: %d %s", w.Code, w.Body.String())
		}
	}
	if agentFolderCount(t, a, ids...) != 0 || agentFolderCount(t, a, parent) != 1 {
		t.Fatal("incorrect deletion scope")
	}
	paused, _ := a.loadWritingTask(ctx, task.ID, u.ID)
	if err = a.advanceAgentApproval(ctx, &paused, job, remotePath); err != nil {
		t.Fatal(err)
	}
	resumed, _ := a.loadWritingTask(ctx, task.ID, u.ID)
	if wakeups != 1 || resumed.Status != "queued" || resumed.ReservationID != task.ReservationID || resumed.JobID != task.JobID {
		t.Fatal("lost same-job continuation", resumed.Status, wakeups)
	}
	_, receipt, err := a.agentOperationResults(context.WithValue(ctx, writingMCPContext{}, resumed), nil, agentApprovalInput{OperationIDs: operationIDs})
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range receipt["operations"].([]map[string]any) {
		if row["status"] != "applied" {
			t.Fatal("stale receipt", row)
		}
	}
	// Same names are legal in Koinote. Undo restores identity without overwriting
	// a newly created same-name folder.
	replacement := seedAgentEmptyFolder(t, a, u.ID, "最近 7 天", "", "")
	for i := 0; i < 2; i++ {
		if w := writingTestRequest(t, a, u, "POST", path+"undo", approvalBatchBody(ops)); w.Code != 200 {
			t.Fatalf("undo: %d %s", w.Code, w.Body.String())
		}
	}
	if agentFolderCount(t, a, append(ids, replacement)...) != 3 {
		t.Fatal("undo did not restore exactly once")
	}
	for _, op := range ops {
		var f agentFolderSnapshot
		err = a.db.QueryRow(ctx, `SELECT f.folder_id,f.name,COALESCE(p.folder_id,''),COALESCE(f.organizer_kind,''),f.created_at,f.updated_at FROM folders f LEFT JOIN folders p ON p.id=f.parent_id WHERE f.folder_id=$1`, op.Before.Folder.ID).Scan(&f.ID, &f.Name, &f.ParentID, &f.OrganizerKind, &f.CreatedAt, &f.UpdatedAt)
		old := op.Before.Folder
		if err != nil || f.Name != old.Name || f.ParentID != old.ParentID || f.OrganizerKind != old.OrganizerKind || !f.CreatedAt.Equal(old.CreatedAt) {
			t.Fatal("undo lost metadata", f, old, err)
		}
	}
}

func TestAgentEmptyFolderApprovalRechecksFactsAtomically(t *testing.T) {
	for _, change := range []string{"document", "trashed_document", "child", "rename", "move", "sync_grant"} {
		t.Run(change, func(t *testing.T) {
			a, u, doc := writingTestApp(t)
			ctx := context.Background()
			ids := []string{seedAgentEmptyFolder(t, a, u.ID, "one", "", ""), seedAgentEmptyFolder(t, a, u.ID, "two", "", "")}
			task := agentTestTask(t, a, u, agentTestSession(t, a, u, "review"), doc, "删除空文件夹")
			inputs := agentFolderDeleteInputs(t, a, task, ids...)
			ops, err := proposeAgentOperationsForTest(a, ctx, task, inputs)
			if err != nil {
				t.Fatal(err)
			}
			switch change {
			case "document", "trashed_document":
				_, err = a.db.Exec(ctx, `UPDATE documents SET folder_id=(SELECT id FROM folders WHERE folder_id=$1),trashed_at=CASE WHEN $3 THEN now() ELSE NULL END WHERE doc_id=$2`, ids[1], doc.DocID, change == "trashed_document")
			case "child":
				seedAgentEmptyFolder(t, a, u.ID, "child", ids[1], "")
			case "rename":
				_, err = a.db.Exec(ctx, `UPDATE folders SET name='changed' WHERE folder_id=$1`, ids[1])
			case "move":
				parent := seedAgentEmptyFolder(t, a, u.ID, "parent", "", "")
				_, err = a.db.Exec(ctx, `UPDATE folders SET parent_id=(SELECT id FROM folders WHERE folder_id=$2) WHERE folder_id=$1`, ids[1], parent)
			case "sync_grant":
				// The FK resource is a persisted sync authorization; never cascade-delete it.
				account := mustAgentUUID(t)
				_, err = a.db.Exec(ctx, `INSERT INTO wechat_official_accounts(account_id,user_id,label,app_id,app_secret_ciphertext,app_secret_hint) VALUES($1,$2,'test',$4,$3,'test')`, account, u.ID, []byte("test"), account)
				if err != nil {
					t.Fatal(err)
				}
				var tokenID int64
				if err = a.db.QueryRow(ctx, `INSERT INTO mcp_tokens(token_id,user_id,name,token_hash,token_hint,scope) VALUES($1,$2,'test',$3,'test','write') RETURNING id`, mustAgentUUID(t), u.ID, []byte(account)).Scan(&tokenID); err != nil {
					t.Fatal(err)
				}
				_, err = a.db.Exec(ctx, `INSERT INTO mcp_wechat_sync_grants(token_id,account_id,folder_id) SELECT $1,$2,id FROM folders WHERE folder_id=$3`, tokenID, account, ids[1])
			}
			if err != nil {
				t.Fatal(err)
			}
			if w := writingTestRequest(t, a, u, "POST", "/api/agent/tasks/"+task.ID+"/operations/approve", approvalBatchBody(ops)); w.Code != 409 {
				t.Fatalf("changed folder accepted: %d %s", w.Code, w.Body.String())
			}
			if agentFolderCount(t, a, ids...) != 2 {
				t.Fatal("partial batch deletion")
			}
			var pending int
			if err = a.db.QueryRow(ctx, `SELECT count(*) FROM agent_operations WHERE task_id=$1 AND status='pending'`, task.ID).Scan(&pending); err != nil || pending != 2 {
				t.Fatal("partial approval", pending, err)
			}
			if _, err = proposeAgentOperationsForTest(a, ctx, task, []agentOperationInput{{Key: "new", Kind: "delete_folder", Path: inputs[1].Path, ExpectedFolderVersion: inputs[1].ExpectedFolderVersion}}); err == nil {
				t.Fatal("stale or nonempty folder proposed")
			}
		})
	}
}

func TestAgentFolderUndoMissingParentIsAtomic(t *testing.T) {
	a, u, doc := writingTestApp(t)
	ctx := context.Background()
	parent := seedAgentEmptyFolder(t, a, u.ID, "parent", "", "")
	ids := []string{seedAgentEmptyFolder(t, a, u.ID, "one", "", ""), seedAgentEmptyFolder(t, a, u.ID, "two", parent, "")}
	task := agentTestTask(t, a, u, agentTestSession(t, a, u, "full"), doc, "删除空文件夹")
	ops, err := proposeAgentOperationsForTest(a, ctx, task, agentFolderDeleteInputs(t, a, task, ids...))
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.db.Exec(ctx, `DELETE FROM folders WHERE folder_id=$1`, parent); err != nil {
		t.Fatal(err)
	}
	w := writingTestRequest(t, a, u, "POST", "/api/agent/tasks/"+task.ID+"/operations/undo", approvalBatchBody(ops))
	if w.Code != 409 || agentFolderCount(t, a, ids...) != 0 {
		t.Fatal("partial or mis-parented restore", w.Code, w.Body.String())
	}
}

func TestAgentFolderValidationRecoveryIsNotAuthorization(t *testing.T) {
	a, u, doc := writingTestApp(t)
	ctx := context.Background()
	id := seedAgentEmptyFolder(t, a, u.ID, "empty", "", "")
	task := bindIntentTaskForTest(t, a, agentTestTask(t, a, u, agentTestSession(t, a, u, "review"), doc, "删除空文件夹"))
	mcpctx := context.WithValue(ctx, writingMCPContext{}, task)
	invalid := agentIntentValidateInput{ToolName: "propose_operations", Task: intentBindingForTest(task), Arguments: map[string]any{"operations": []agentOperationInput{{Key: "bad", Kind: "trash", Path: "/folders/" + id}}}}
	_, diagnostic, err := a.agentValidateOperation(mcpctx, nil, invalid)
	if err != nil || diagnostic.ValidationError == nil || !diagnostic.ValidationError.Retryable || diagnostic.Token != "" || len(diagnostic.Effects) != 0 {
		t.Fatal("missing safe parameter diagnostic", diagnostic, err)
	}
	// Exercise MCP serialization/schema validation, not only the Go helper.
	srv := httptest.NewServer(a.Routes())
	defer srv.Close()
	client, e := connectMCPClient(ctx, srv.URL+"/api/writing-agent/mcp/"+task.ID, a.writingSecret(task.ID, "mcp"))
	if e != nil {
		t.Fatal(e)
	}
	defer client.Close()
	invalid.Task.ResponseChecks = true
	wire, e := client.CallTool(ctx, &mcp.CallToolParams{Name: "validate_operation", Arguments: invalid})
	if e != nil || wire.IsError {
		t.Fatalf("diagnostic lost over MCP: %v %+v", e, wire)
	}
	raw, _ := json.Marshal(wire.StructuredContent)
	var decoded agentIntentProof
	if e = json.Unmarshal(raw, &decoded); e != nil || decoded.ValidationError == nil || decoded.ValidationError.Code != "invalid_arguments" {
		t.Fatalf("invalid wire diagnostic: %s %v", raw, e)
	}
	inputs := agentFolderDeleteInputs(t, a, task, id)
	if _, err = a.proposeAgentOperations(ctx, task, inputs, agentIntentAuthorization{ToolName: "propose_operations", Proof: diagnostic}); err == nil {
		t.Fatal("diagnostic used as authorization")
	}
	for _, bad := range []map[string]any{
		{"operations": "not an array"},
		{"operations": []agentOperationInput{{Kind: "delete_folder", Path: "/folders/" + id}}},
		{"operations": []agentOperationInput{{Key: "draft", Kind: "create"}}},
	} {
		request := invalid
		request.Arguments = bad
		_, diagnostic, e := a.agentValidateOperation(mcpctx, nil, request)
		if e != nil || diagnostic.ValidationError == nil || diagnostic.Token != "" {
			t.Fatalf("shape error did not recover safely: %+v %v", diagnostic, e)
		}
	}
	invalid.Task.Version++
	if _, _, err = a.agentValidateOperation(mcpctx, nil, invalid); err == nil {
		t.Fatal("task conflict downgraded to retryable input error")
	}
	dup := append(append([]agentOperationInput{}, inputs...), inputs[0])
	dup[1].Key = "second"
	if _, err = proposeAgentOperationsForTest(a, ctx, task, dup); err == nil {
		t.Fatal("duplicate folder accepted")
	}
	if _, err = proposeAgentOperationsForTest(a, ctx, task, inputs); err != nil {
		t.Fatal("corrected request did not recover", err)
	}
	if agentFolderCount(t, a, id) != 1 {
		t.Fatal("validation or proposal deleted folder")
	}
}

func TestAgentEmptyFolderDeletionWaitsForConcurrentInsert(t *testing.T) {
	a, u, doc := writingTestApp(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	id := seedAgentEmptyFolder(t, a, u.ID, "empty", "", "")
	task := agentTestTask(t, a, u, agentTestSession(t, a, u, "review"), doc, "删除空文件夹")
	ops, err := proposeAgentOperationsForTest(a, ctx, task, agentFolderDeleteInputs(t, a, task, id))
	if err != nil {
		t.Fatal(err)
	}
	writer, err := a.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Rollback(context.Background())
	// The uncommitted FK write holds KEY SHARE on the folder. Approval must wait
	// for it, then see its committed contents instead of a stale empty snapshot.
	if _, err = writer.Exec(ctx, `UPDATE documents SET folder_id=(SELECT id FROM folders WHERE folder_id=$1) WHERE doc_id=$2`, id, doc.DocID); err != nil {
		t.Fatal(err)
	}
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		done <- writingTestRequest(t, a, u, "POST", "/api/agent/tasks/"+task.ID+"/operations/approve", approvalBatchBody(ops))
	}()
	for {
		var blocked bool
		if err = a.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FOR UPDATE OF f%')`).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		select {
		case early := <-done:
			t.Fatalf("approval did not wait for concurrent content: %d %s", early.Code, early.Body.String())
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(10 * time.Millisecond):
		}
	}
	if err = writer.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case response := <-done:
		if response.Code != 409 {
			t.Fatalf("stale deletion committed: %d %s", response.Code, response.Body.String())
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	var folder string
	if err = a.db.QueryRow(ctx, `SELECT COALESCE(f.folder_id,'') FROM documents d LEFT JOIN folders f ON f.id=d.folder_id WHERE d.doc_id=$1`, doc.DocID).Scan(&folder); err != nil || folder != id {
		t.Fatal("concurrent document was displaced", folder, err)
	}
	if agentFolderCount(t, a, id) != 1 {
		t.Fatal("concurrently populated folder deleted")
	}
}
