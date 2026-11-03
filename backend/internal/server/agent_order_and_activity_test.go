package server

import (
	"context"
	"encoding/json"
	"testing"

	"koinote/backend/internal/model"
)

func agentMoveOrderFixture(t *testing.T, mode string, chained bool) (*App, model.User, model.Document, []agentOperation) {
	t.Helper()
	a, u, doc := writingTestApp(t)
	ctx := context.Background()
	if _, err := a.createDocument(ctx, createDocumentParams{User: u, Title: "Root sibling", Content: "Sibling"}); err != nil {
		t.Fatal(err)
	}
	if _, err := a.db.Exec(ctx, `UPDATE documents SET sort_order=CASE WHEN doc_id=$2 THEN 0 ELSE 1 END WHERE user_id=$1`, u.ID, doc.DocID); err != nil {
		t.Fatal(err)
	}
	folders := []string{}
	for _, name := range []string{"First destination", "Second destination"} {
		id, _ := randomUUID()
		if _, err := a.db.Exec(ctx, `INSERT INTO folders(folder_id,user_id,name) VALUES($1,$2,$3)`, id, u.ID, name); err != nil {
			t.Fatal(err)
		}
		peer, err := a.createDocument(ctx, createDocumentParams{User: u, Title: name + " sibling", Content: "Sibling", FolderID: &id})
		if err != nil {
			t.Fatal(err)
		}
		if _, err = a.db.Exec(ctx, `UPDATE documents SET sort_order=9 WHERE doc_id=$1`, peer.DocID); err != nil {
			t.Fatal(err)
		}
		folders = append(folders, id)
	}
	s := agentTestSession(t, a, u, mode)
	task := agentTestTask(t, a, u, s, doc, "移动文章")
	agentTestRead(t, a, task, doc)
	inputs := []agentOperationInput{{Key: "move-1", Kind: "move", Path: agentDocumentPath(doc.DocID), ExpectedRevision: doc.Revision, FolderID: folders[0]}}
	if chained {
		inputs = append(inputs,
			agentOperationInput{Key: "edit", Kind: "update", Path: agentDocumentPath(doc.DocID), ExpectedRevision: doc.Revision, Title: "Edited title", Content: "Edited content"},
			agentOperationInput{Key: "move-2", Kind: "move", Path: agentDocumentPath(doc.DocID), ExpectedRevision: doc.Revision, FolderID: folders[1]},
		)
	}
	ops, err := proposeAgentOperationsForTest(a, ctx, task, inputs)
	if err != nil {
		t.Fatal(err)
	}
	if mode != "full" {
		for _, op := range ops {
			w := writingTestRequest(t, a, u, "POST", "/api/agent/operations/"+op.ID+"/approve", map[string]string{"hash": op.Hash})
			if w.Code != 200 {
				t.Fatal(w.Body.String())
			}
		}
	}
	ops, err = a.loadAgentOperations(ctx, u.ID, []string{task.ID})
	if err != nil {
		t.Fatal(err)
	}
	return a, u, doc, ops
}

func TestAgentMoveUndoRestoresOrder(t *testing.T) {
	for _, mode := range []string{"full", "review"} {
		for _, variant := range []string{"single", "chained"} {
			t.Run(mode+"/"+variant, func(t *testing.T) {
				a, u, doc, ops := agentMoveOrderFixture(t, mode, variant == "chained")
				ctx := context.Background()
				for i := len(ops) - 1; i >= 0; i-- {
					op := ops[i]
					w := writingTestRequest(t, a, u, "POST", "/api/agent/operations/"+op.ID+"/undo", map[string]string{"hash": op.Hash})
					if w.Code != 200 {
						t.Fatalf("undo %s: %d %s", op.Input.Key, w.Code, w.Body.String())
					}
					var order, revision int64
					var folder string
					if err := a.db.QueryRow(ctx, `SELECT d.sort_order,d.revision,COALESCE(f.folder_id,'') FROM documents d LEFT JOIN folders f ON f.id=d.folder_id WHERE d.doc_id=$1`, doc.DocID).Scan(&order, &revision, &folder); err != nil {
						t.Fatal(err)
					}
					wantOrder := int64(10)
					if i == 0 {
						wantOrder = 0
					}
					if order != wantOrder || folder != op.Before.FolderID {
						t.Fatalf("undo %s restored folder=%s order=%d, want folder=%s order=%d", op.Input.Key, folder, order, op.Before.FolderID, wantOrder)
					}
					w = writingTestRequest(t, a, u, "POST", "/api/agent/operations/"+op.ID+"/undo", map[string]string{"hash": op.Hash})
					if w.Code != 200 {
						t.Fatal(w.Body.String())
					}
					var replayOrder, replayRevision int64
					if err := a.db.QueryRow(ctx, `SELECT sort_order,revision FROM documents WHERE doc_id=$1`, doc.DocID).Scan(&replayOrder, &replayRevision); err != nil || replayOrder != order || replayRevision != revision {
						t.Fatal("undo replay changed order or revision", err)
					}
				}
				var first string
				if err := a.db.QueryRow(ctx, `SELECT doc_id FROM documents WHERE user_id=$1 AND folder_id IS NULL ORDER BY sort_order,updated_at DESC,id DESC LIMIT 1`, u.ID).Scan(&first); err != nil || first != doc.DocID {
					t.Fatal("original sibling order was not restored", first, err)
				}
			})
		}
	}
}

func TestAgentMoveUndoPreservesLaterManualOrder(t *testing.T) {
	a, u, doc, ops := agentMoveOrderFixture(t, "full", false)
	ctx := context.Background()
	var peer string
	if err := a.db.QueryRow(ctx, `SELECT other.doc_id FROM documents d JOIN documents other ON other.folder_id=d.folder_id AND other.id<>d.id WHERE d.doc_id=$1`, doc.DocID).Scan(&peer); err != nil {
		t.Fatal(err)
	}
	w := writingTestRequest(t, a, u, "PUT", "/api/documents/"+doc.DocID+"/order", map[string]any{"folderId": ops[0].Result.FolderID, "docIds": []string{doc.DocID, peer}})
	if w.Code != 200 {
		t.Fatal("manual order", w.Code, w.Body.String())
	}
	w = writingTestRequest(t, a, u, "POST", "/api/agent/operations/"+ops[0].ID+"/undo", map[string]string{"hash": ops[0].Hash})
	if w.Code != 409 {
		t.Fatalf("undo ignored later manual order: %d %s", w.Code, w.Body.String())
	}
	var order int64
	var folder string
	if err := a.db.QueryRow(ctx, `SELECT d.sort_order,f.folder_id FROM documents d JOIN folders f ON f.id=d.folder_id WHERE d.doc_id=$1`, doc.DocID).Scan(&order, &folder); err != nil || order != 0 || folder != ops[0].Result.FolderID {
		t.Fatal("manual order was overwritten", order, folder, err)
	}
}

func TestAgentMoveUndoUsesOrderAtApproval(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		name := "current-snapshot"
		if legacy {
			name = "legacy-snapshot"
		}
		t.Run(name, func(t *testing.T) {
			a, u, doc := writingTestApp(t)
			ctx := context.Background()
			s := agentTestSession(t, a, u, "review")
			task := agentTestTask(t, a, u, s, doc, "移动文章")
			agentTestRead(t, a, task, doc)
			folderID := mustAgentUUID(t)
			if _, err := a.db.Exec(ctx, `INSERT INTO folders(folder_id,user_id,name) VALUES($1,$2,'Destination')`, folderID, u.ID); err != nil {
				t.Fatal(err)
			}
			ops, err := proposeAgentOperationsForTest(a, ctx, task, []agentOperationInput{{Key: "move", Kind: "move", Path: agentDocumentPath(doc.DocID), ExpectedRevision: doc.Revision, FolderID: folderID}})
			if err != nil {
				t.Fatal(err)
			}
			if legacy {
				if _, err = a.db.Exec(ctx, `UPDATE agent_operations SET before_state=before_state-'sortOrder' WHERE id=$1`, ops[0].ID); err != nil {
					t.Fatal(err)
				}
			}
			// Sorting is allowed while a move awaits approval and does not bump revision.
			if _, err = a.db.Exec(ctx, `UPDATE documents SET sort_order=42 WHERE doc_id=$1`, doc.DocID); err != nil {
				t.Fatal(err)
			}
			for _, action := range []string{"approve", "undo"} {
				w := writingTestRequest(t, a, u, "POST", "/api/agent/operations/"+ops[0].ID+"/"+action, map[string]string{"hash": ops[0].Hash})
				if w.Code != 200 {
					t.Fatalf("%s: %d %s", action, w.Code, w.Body.String())
				}
			}
			var order int64
			if err = a.db.QueryRow(ctx, `SELECT sort_order FROM documents WHERE doc_id=$1 AND folder_id IS NULL`, doc.DocID).Scan(&order); err != nil || order != 42 {
				t.Fatal("undo must restore order at approval, not at proposal", order, err)
			}
		})
	}
}

func TestAgentLegacyPendingActivity(t *testing.T) {
	for _, scenario := range []string{"completed", "failed", "cancelled", "running", "cancel-requested", "applied", "deleted"} {
		t.Run(scenario, func(t *testing.T) {
			a, u, doc := writingTestApp(t)
			task := writingTestCreate(t, a, u, doc)
			ctx := context.WithValue(context.Background(), writingMCPContext{}, task)
			if _, _, err := a.writingProposeDocument(ctx, nil, writingProposalInput{DocID: doc.DocID, ExpectedRevision: doc.Revision, Title: doc.Title, Content: "Proposed content"}); err != nil {
				t.Fatal(err)
			}
			status := "completed"
			if scenario == "failed" || scenario == "cancelled" {
				status = scenario
			}
			if scenario == "running" {
				if _, err := a.db.Exec(ctx, `UPDATE writing_agent_tasks SET status='running' WHERE id=$1`, task.ID); err != nil {
					t.Fatal(err)
				}
			} else if err := a.finishWritingTask(ctx, task, status, "", json.RawMessage(`{"totalTokens":0}`), "Done"); err != nil {
				t.Fatal(err)
			}
			if scenario == "cancel-requested" {
				w := writingTestRequest(t, a, u, "POST", "/api/writing-agent/tasks/"+task.ID+"/cancel", nil)
				if w.Code != 202 {
					t.Fatal(w.Body.String())
				}
			}
			if scenario == "applied" {
				stored, err := a.loadWritingTask(ctx, task.ID, u.ID)
				if err != nil {
					t.Fatal(err)
				}
				w := writingTestRequest(t, a, u, "POST", "/api/writing-agent/tasks/"+task.ID+"/apply", map[string]any{"expectedRevision": doc.Revision, "proposalHash": stored.Proposal.Hash})
				if w.Code != 200 {
					t.Fatal(w.Body.String())
				}
			}
			if scenario == "deleted" {
				w := writingTestRequest(t, a, u, "DELETE", "/api/agent/sessions/"+task.SessionID, nil)
				if w.Code != 200 {
					t.Fatal(w.Body.String())
				}
			}
			w := writingTestRequest(t, a, u, "GET", "/api/agent/sessions", nil)
			if w.Code != 200 {
				t.Fatal(w.Body.String())
			}
			var listed struct {
				Sessions []agentSession `json:"sessions"`
				Activity struct {
					Pending int `json:"pending"`
				} `json:"activity"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &listed); err != nil {
				t.Fatal(err)
			}
			want := 0
			if scenario == "completed" {
				want = 1
			}
			if listed.Activity.Pending != want {
				t.Fatalf("global pending=%d, want %d", listed.Activity.Pending, want)
			}
			if scenario != "deleted" && (len(listed.Sessions) != 1 || listed.Sessions[0].PendingOperations != want) {
				t.Fatalf("session pending disagrees with global pending: %+v", listed.Sessions)
			}
		})
	}
}

func TestAgentFailedConversationProposalRemainsActionable(t *testing.T) {
	a, u, doc := writingTestApp(t)
	s := agentTestSession(t, a, u, "review")
	task := agentTestTask(t, a, u, s, doc, "修改文章")
	agentTestRead(t, a, task, doc)
	ops, err := proposeAgentOperationsForTest(a, context.Background(), task, []agentOperationInput{{Key: "edit", Kind: "update", Path: agentDocumentPath(doc.DocID), ExpectedRevision: doc.Revision, Title: doc.Title, Content: "Proposed content"}})
	if err != nil {
		t.Fatal(err)
	}
	if err = a.finishWritingTask(context.Background(), task, "failed", "timeout", json.RawMessage(`{"totalTokens":0}`), ""); err != nil {
		t.Fatal(err)
	}
	w := writingTestRequest(t, a, u, "GET", "/api/agent/sessions", nil)
	var listed struct {
		Activity struct {
			Pending int `json:"pending"`
		} `json:"activity"`
	}
	if err = json.Unmarshal(w.Body.Bytes(), &listed); err != nil || w.Code != 200 || listed.Activity.Pending != 1 {
		t.Fatal("actionable conversation proposal hidden", w.Body.String(), err)
	}
	w = writingTestRequest(t, a, u, "POST", "/api/agent/operations/"+ops[0].ID+"/approve", map[string]string{"hash": ops[0].Hash})
	if w.Code != 200 {
		t.Fatal("conversation proposal is no longer actionable", w.Body.String())
	}
}
