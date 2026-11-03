package server

import (
	"context"
	"encoding/json"
	"testing"

	"koinote/backend/internal/model"
)

func agentActivitySession(t *testing.T, a *App, u model.User) agentSession {
	t.Helper()
	w := writingTestRequest(t, a, u, "GET", "/api/agent/sessions", nil)
	var out struct {
		Sessions []agentSession `json:"sessions"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || w.Code != 200 || len(out.Sessions) != 1 {
		t.Fatalf("list: %d %s %v", w.Code, w.Body.String(), err)
	}
	return out.Sessions[0]
}

func TestAgentAutomaticOperationUpdatesActivity(t *testing.T) {
	for _, scenario := range []struct{ mode, kind string }{
		{"full", "folder"}, {"full", "create"}, {"full", "update"},
		{"full", "move"}, {"full", "trash"}, {"assist", "create"},
	} {
		t.Run(scenario.mode+"/"+scenario.kind, func(t *testing.T) {
			a, u, doc := writingTestApp(t)
			ctx := context.Background()
			s := agentTestSession(t, a, u, scenario.mode)
			task := agentTestTask(t, a, u, s, doc, "后台整理文章和文件夹")
			if _, err := a.db.Exec(ctx, `UPDATE writing_agent_tasks SET status='running' WHERE id=$1`, task.ID); err != nil {
				t.Fatal(err)
			}
			input := agentOperationInput{Key: "change", Kind: scenario.kind}
			switch scenario.kind {
			case "folder", "create":
				input.Title = "Background result"
			case "update", "move", "trash":
				agentTestRead(t, a, task, doc)
				input.Path, input.ExpectedRevision = agentDocumentPath(doc.DocID), doc.Revision
				if scenario.kind == "update" {
					input.Title, input.Content = "Revised title", "Revised content"
				}
				if scenario.kind == "move" {
					input.FolderID = mustAgentUUID(t)
					if _, err := a.db.Exec(ctx, `INSERT INTO folders(folder_id,user_id,name) VALUES($1,$2,'Destination')`, input.FolderID, u.ID); err != nil {
						t.Fatal(err)
					}
				}
			}
			before := agentActivitySession(t, a, u)
			ops, err := proposeAgentOperationsForTest(a, ctx, task, []agentOperationInput{input})
			if err != nil || len(ops) != 1 || ops[0].Status != "applied" {
				t.Fatal("automatic operation", ops, err)
			}
			after := agentActivitySession(t, a, u)
			if before.ActiveTasks != 1 || after.ActiveTasks != 1 || before.PendingOperations != 0 || after.PendingOperations != 0 {
				t.Fatal("must test activity while task is still running, without a pending-count change", before, after)
			}
			if !after.UpdatedAt.After(before.UpdatedAt) {
				t.Fatal("automatic operation did not publish activity before task completion", before.UpdatedAt, after.UpdatedAt)
			}
			if after.Revision != before.Revision {
				t.Fatal("operation invalidated the permission/settings revision")
			}
			if scenario.kind == "folder" {
				var exists bool
				if err = a.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM folders WHERE folder_id=$1 AND user_id=$2)`, ops[0].Result.FolderID, u.ID).Scan(&exists); err != nil || !exists {
					t.Fatal("activity was published without a committed folder", err)
				}
			}
			if _, err = proposeAgentOperationsForTest(a, ctx, task, []agentOperationInput{input}); err != nil {
				t.Fatal("identical retry", err)
			}
			if replayed := agentActivitySession(t, a, u); !replayed.UpdatedAt.Equal(after.UpdatedAt) {
				t.Fatal("identical retry generated false activity")
			}
		})
	}
}

func TestAgentFailedAutomaticBatchDoesNotPublishActivity(t *testing.T) {
	a, u, doc := writingTestApp(t)
	ctx := context.Background()
	s := agentTestSession(t, a, u, "full")
	task := agentTestTask(t, a, u, s, doc, "后台创建文件夹")
	before := agentActivitySession(t, a, u)
	// The first operation applies, but the second fails on the same folder name.
	_, err := proposeAgentOperationsForTest(a, ctx, task, []agentOperationInput{
		{Key: "first", Kind: "folder", Title: "Duplicate name"},
		{Key: "second", Kind: "folder", Title: "Duplicate name"},
	})
	if err == nil {
		t.Fatal("expected second operation to fail")
	}
	after := agentActivitySession(t, a, u)
	if !after.UpdatedAt.Equal(before.UpdatedAt) || after.PendingOperations != before.PendingOperations {
		t.Fatal("rolled-back batch published activity", before, after)
	}
	var folders, operations int
	if err = a.db.QueryRow(ctx, `SELECT (SELECT count(*) FROM folders WHERE user_id=$1), (SELECT count(*) FROM agent_operations WHERE task_id=$2)`, u.ID, task.ID).Scan(&folders, &operations); err != nil || folders != 0 || operations != 0 {
		t.Fatal("failed batch left writes behind", folders, operations, err)
	}
}
