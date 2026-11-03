package server

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestAgentFolderMergePreconditionRecovery(t *testing.T) {
	a, u, doc := writingTestApp(t)
	ctx := context.Background()
	source := seedAgentEmptyFolder(t, a, u.ID, "产品待办", "", "")
	destination := seedAgentEmptyFolder(t, a, u.ID, "产品文章", "", "")
	if _, err := a.db.Exec(ctx, `UPDATE documents SET folder_id=(SELECT id FROM folders WHERE folder_id=$1) WHERE doc_id=$2`, source, doc.DocID); err != nil {
		t.Fatal(err)
	}
	task := bindIntentTaskForTest(t, a, agentTestTask(t, a, u, agentTestSession(t, a, u, "review"), doc, "把产品待办和产品文章两个文件夹合并"))
	agentTestRead(t, a, task, doc)
	mcpctx := context.WithValue(ctx, writingMCPContext{}, task)
	_, listing, err := a.agentListFolders(mcpctx, nil, agentSearchInput{Limit: 100})
	if err != nil {
		t.Fatal(err)
	}
	var deletion agentOperationInput
	for _, f := range listing["folders"].([]map[string]any) {
		if f["folderId"] == source {
			if f["canDeleteEmpty"] != false {
				t.Fatal("source must be nonempty before the move")
			}
			deletion = agentOperationInput{Key: "delete-source", Kind: "delete_folder", Path: f["path"].(string), ExpectedFolderVersion: f["version"].(string)}
		}
	}
	move := agentOperationInput{Key: "move-document", Kind: "move", Path: agentDocumentPath(doc.DocID), ExpectedRevision: doc.Revision, FolderID: destination}
	srv := httptest.NewServer(a.Routes())
	defer srv.Close()
	client, err := connectMCPClient(ctx, srv.URL+"/api/writing-agent/mcp/"+task.ID, a.writingSecret(task.ID, "mcp"))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	request := agentIntentValidateInput{ToolName: "propose_operations", Task: intentBindingForTest(task), Arguments: map[string]any{"operations": []agentOperationInput{move, deletion}}}
	wire, err := client.CallTool(ctx, &mcp.CallToolParams{Name: "validate_operation", Arguments: request})
	if err != nil || wire.IsError {
		t.Fatalf("dependent batch killed the task instead of returning a diagnostic: %v %+v", err, wire)
	}
	raw, _ := json.Marshal(wire.StructuredContent)
	var diagnostic agentIntentProof
	if err = json.Unmarshal(raw, &diagnostic); err != nil || diagnostic.ValidationError == nil || diagnostic.ValidationError.Code != "precondition_not_met" || !diagnostic.ValidationError.Retryable || diagnostic.Token != "" || len(diagnostic.Effects) != 0 {
		t.Fatalf("unsafe prerequisite diagnostic: %s %v", raw, err)
	}
	if !strings.Contains(diagnostic.ValidationError.Message, "applied") {
		t.Fatal("diagnostic must wait for actual application, not a pending proposal")
	}
	if _, err = a.proposeAgentOperations(ctx, task, []agentOperationInput{move}, agentIntentAuthorization{ToolName: "propose_operations", Proof: &diagnostic}); err == nil {
		t.Fatal("prerequisite diagnostic used as proof")
	}
	var count int
	a.db.QueryRow(ctx, `SELECT count(*) FROM agent_operations WHERE task_id=$1`, task.ID).Scan(&count)
	if count != 0 {
		t.Fatal("rejected batch persisted partial proposals")
	}
	moves, err := proposeAgentOperationsForTest(a, ctx, task, []agentOperationInput{move})
	if err != nil {
		t.Fatal(err)
	}
	request.Arguments = map[string]any{"operations": []agentOperationInput{deletion}}
	_, pending, err := a.agentValidateOperation(mcpctx, nil, request)
	if err != nil || pending.ValidationError == nil || pending.ValidationError.Code != "precondition_not_met" {
		t.Fatal("pending move incorrectly satisfied deletion prerequisite", pending, err)
	}
	if w := writingTestRequest(t, a, u, "POST", "/api/agent/tasks/"+task.ID+"/operations/approve", approvalBatchBody(moves)); w.Code != 200 {
		t.Fatalf("approve move: %d %s", w.Code, w.Body.String())
	}
	deletions, err := proposeAgentOperationsForTest(a, ctx, task, agentFolderDeleteInputs(t, a, task, source))
	if err != nil {
		t.Fatal("applied move did not allow the next phase", err)
	}
	if w := writingTestRequest(t, a, u, "POST", "/api/agent/tasks/"+task.ID+"/operations/approve", approvalBatchBody(deletions)); w.Code != 200 {
		t.Fatalf("approve deletion: %d %s", w.Code, w.Body.String())
	}
	if agentFolderCount(t, a, source) != 0 {
		t.Fatal("empty source was not deleted")
	}
	var title, content, folder string
	if err = a.db.QueryRow(ctx, `SELECT d.title,d.content,f.folder_id FROM documents d JOIN folders f ON f.id=d.folder_id WHERE d.doc_id=$1`, doc.DocID).Scan(&title, &content, &folder); err != nil || title != doc.Title || content != doc.Content || folder != destination {
		t.Fatal("merge changed document content or lost destination", err)
	}
	if w := writingTestRequest(t, a, u, "POST", "/api/agent/tasks/"+task.ID+"/operations/undo", approvalBatchBody(deletions)); w.Code != 200 {
		t.Fatalf("undo deletion: %d %s", w.Code, w.Body.String())
	}
	if w := writingTestRequest(t, a, u, "POST", "/api/agent/operations/"+moves[0].ID+"/undo", map[string]string{"hash": moves[0].Hash}); w.Code != 200 {
		t.Fatalf("undo move: %d %s", w.Code, w.Body.String())
	}
	if err = a.db.QueryRow(ctx, `SELECT f.folder_id FROM documents d JOIN folders f ON f.id=d.folder_id WHERE d.doc_id=$1`, doc.DocID).Scan(&folder); err != nil || folder != source {
		t.Fatal("merge undo did not restore source membership", err)
	}
}
