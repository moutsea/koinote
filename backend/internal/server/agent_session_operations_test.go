package server

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
)

func TestAgentArtifactRetentionAndQuota(t *testing.T) {
	a, u, doc := writingTestApp(t)
	s := agentTestSession(t, a, u, "review")
	task := agentTestTask(t, a, u, s, doc, "生成文件")
	ctx := context.WithValue(context.Background(), writingMCPContext{}, task)
	_, file, err := a.agentSaveArtifact(ctx, nil, agentArtifactInput{Name: "result.csv", MimeType: "text/csv", Content: "name,value\n总计,55\n"})
	if err != nil {
		t.Fatal(err)
	}
	_, same, err := a.agentSaveArtifact(ctx, nil, agentArtifactInput{Name: "result.csv", MimeType: "text/csv", Content: "name,value\n总计,55\n"})
	if err != nil || same.ID != file.ID {
		t.Fatal("artifact retry", err)
	}
	if _, _, err = a.agentSaveArtifact(ctx, nil, agentArtifactInput{Name: "result.csv", Content: "different"}); !errors.Is(err, errAgentSessionConflict) {
		t.Fatal("artifact was overwritten", err)
	}
	w := writingTestRequest(t, a, u, "GET", "/api/agent/artifacts/"+file.ID, nil)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "55") || !strings.Contains(w.Header().Get("Content-Disposition"), "attachment") {
		t.Fatalf("download %d %s", w.Code, w.Body.String())
	}
	if err = a.finishWritingTask(ctx, task, "completed", "", json.RawMessage(`{"totalTokens":0}`), "生成完成"); err != nil {
		t.Fatal(err)
	}
	usage, err := a.storageUsageFor(ctx, u.ID)
	if err != nil || usage.AgentSessionBytes <= file.Bytes || usage.AgentSessionBytes >= agentTaskStorageBudget {
		t.Fatal("actual storage not settled", usage, err)
	}
	w = writingTestRequest(t, a, u, "DELETE", "/api/agent/sessions/"+s.ID, nil)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	w = writingTestRequest(t, a, u, "GET", "/api/agent/artifacts/"+file.ID, nil)
	if w.Code != 404 {
		t.Fatal("deleted artifact readable")
	}
	if _, _, err = a.agentSaveArtifact(ctx, nil, agentArtifactInput{Name: "late.txt", Content: "late"}); err == nil {
		t.Fatal("late tool recreated deleted data")
	}
}

func TestAgentFullFolderMoveTrashAndUndo(t *testing.T) {
	a, u, doc := writingTestApp(t)
	s := agentTestSession(t, a, u, "full")
	task := agentTestTask(t, a, u, s, doc, "整理文章")
	ctx := context.Background()
	folders, err := proposeAgentOperationsForTest(a, ctx, task, []agentOperationInput{{Key: "folder", Kind: "folder", Title: "整理后的资料"}})
	if err != nil {
		t.Fatal(err)
	}
	folder := folders[0].Result.FolderID
	agentTestRead(t, a, task, doc)
	moved, err := proposeAgentOperationsForTest(a, ctx, task, []agentOperationInput{{Key: "move", Kind: "move", Path: agentDocumentPath(doc.DocID), ExpectedRevision: doc.Revision, FolderID: folder}})
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := a.loadAgentSnapshot(ctx, a.db, u.ID, doc.DocID)
	if err != nil || snapshot.FolderID != folder || snapshot.Document.Revision != doc.Revision+1 {
		t.Fatal("move failed", err)
	}
	w := writingTestRequest(t, a, u, "POST", "/api/agent/operations/"+moved[0].ID+"/undo", map[string]string{"hash": moved[0].Hash})
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	snapshot, _ = a.loadAgentSnapshot(ctx, a.db, u.ID, doc.DocID)
	if snapshot.FolderID != "" {
		t.Fatal("move undo failed")
	}
	agentTestRead(t, a, task, snapshot.Document)
	trashed, err := proposeAgentOperationsForTest(a, ctx, task, []agentOperationInput{{Key: "trash", Kind: "trash", Path: agentDocumentPath(doc.DocID), ExpectedRevision: snapshot.Document.Revision}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.loadAgentReviewDocument(ctx, u.ID, doc.DocID); err == nil {
		t.Fatal("trash did not hide document")
	}
	w = writingTestRequest(t, a, u, "POST", "/api/agent/operations/"+trashed[0].ID+"/undo", map[string]string{"hash": trashed[0].Hash})
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if _, err = a.loadAgentReviewDocument(ctx, u.ID, doc.DocID); err != nil {
		t.Fatal("trash undo", err)
	}
	w = writingTestRequest(t, a, u, "POST", "/api/agent/operations/"+folders[0].ID+"/undo", map[string]string{"hash": folders[0].Hash})
	if w.Code != 200 {
		t.Fatal("folder undo", w.Body.String())
	}
}

func TestAgentConcurrentApprovalAndPermissionDowngrade(t *testing.T) {
	a, u, doc := writingTestApp(t)
	s := agentTestSession(t, a, u, "full")
	task := agentTestTask(t, a, u, s, doc, "修改文章")
	agentTestRead(t, a, task, doc)
	w := writingTestRequest(t, a, u, "PUT", "/api/agent/sessions/"+s.ID, map[string]any{"permission": "review", "revision": s.Revision + 1})
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	ops, err := proposeAgentOperationsForTest(a, context.Background(), task, []agentOperationInput{{Key: "change", Kind: "update", Path: agentDocumentPath(doc.DocID), ExpectedRevision: doc.Revision, Title: doc.Title, Content: "新的正文"}})
	if err != nil {
		t.Fatal(err)
	}
	if ops[0].Status != "pending" {
		t.Fatal("permission downgrade ignored")
	}
	var group sync.WaitGroup
	codes := make(chan int, 2)
	for i := 0; i < 2; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			response := writingTestRequest(t, a, u, "POST", "/api/agent/operations/"+ops[0].ID+"/approve", map[string]string{"hash": ops[0].Hash})
			codes <- response.Code
		}()
	}
	group.Wait()
	close(codes)
	for code := range codes {
		if code != 200 {
			t.Fatalf("concurrent approval %d", code)
		}
	}
	final, _ := a.loadAgentReviewDocument(context.Background(), u.ID, doc.DocID)
	if final.Revision != doc.Revision+1 {
		t.Fatal("duplicate revision")
	}
	_, err = a.updateDocument(context.Background(), updateDocumentParams{User: u, DocID: doc.DocID, Title: doc.Title, Content: "用户后续编辑", Theme: doc.Theme, ExpectedRevision: final.Revision, Source: documentSourceWeb})
	if err != nil {
		t.Fatal(err)
	}
	w = writingTestRequest(t, a, u, "POST", "/api/agent/operations/"+ops[0].ID+"/undo", map[string]string{"hash": ops[0].Hash})
	if w.Code != 409 {
		t.Fatal("undo overwrote newer edit")
	}
}

func TestAgentSessionStorageBlocksOtherWritersAndDispatchQueues(t *testing.T) {
	a, u, doc := writingTestApp(t)
	ctx := context.Background()
	s := agentTestSession(t, a, u, "review")
	first := agentTestTask(t, a, u, s, doc, "读文档")
	secondSession := agentTestSession(t, a, u, "review")
	second := agentTestTask(t, a, u, secondSession, doc, "读文档")
	thirdSession := agentTestSession(t, a, u, "review")
	third := agentTestTask(t, a, u, thirdSession, doc, "读文档")
	for _, task := range []*writingTask{&first, &second} {
		ok, err := a.claimAgentDispatch(ctx, task)
		if err != nil || !ok {
			t.Fatal("dispatch claim", err)
		}
	}
	if ok, err := a.claimAgentDispatch(ctx, &third); err != nil || ok {
		t.Fatal("user concurrency limit ignored", err)
	}
	if err := a.finishWritingTask(ctx, first, "completed", "", json.RawMessage(`{"totalTokens":0}`), "done"); err != nil {
		t.Fatal(err)
	}
	if ok, err := a.claimAgentDispatch(ctx, &third); err != nil || !ok {
		t.Fatal("queue did not advance", err)
	}
	if _, err := a.db.Exec(ctx, `UPDATE writing_agent_tasks SET storage_budget_bytes=$2 WHERE id=$1`, third.ID, a.storageQuotaFor(u)); err != nil {
		t.Fatal(err)
	}
	if _, err := a.createDocument(ctx, createDocumentParams{User: u, Title: "超额", Content: "x"}); !errors.Is(err, errDocumentQuotaExceeded) {
		t.Fatal("document writer ignored Agent reservation", err)
	}
	if _, err := a.recordImageObject(ctx, u.ID, "u/"+u.AuthUserID+"/quota.png", 1, a.storageQuotaFor(u), imagePurposePersistent, nil); !errors.Is(err, errQuotaExceeded) {
		t.Fatal("image writer ignored Agent reservation", err)
	}
	w := writingTestRequest(t, a, u, "DELETE", "/api/agent/sessions/"+thirdSession.ID, nil)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if _, err := a.createDocument(ctx, createDocumentParams{User: u, Title: "清理后", Content: "x"}); err != nil {
		t.Fatal("space not released", err)
	}
}
