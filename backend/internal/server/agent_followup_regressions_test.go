package server

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"koinote/backend/internal/model"
)

func agentUndoBatchFixture(t *testing.T, mode, variant string) (*App, model.User, model.Document, []agentOperation) {
	t.Helper()
	a, u, doc := writingTestApp(t)
	ctx := context.Background()
	s := agentTestSession(t, a, u, mode)
	task := agentTestTask(t, a, u, s, doc, "修改并移动文章")
	folderID, _ := randomUUID()
	if _, err := a.db.Exec(ctx, `INSERT INTO folders(folder_id,user_id,name) VALUES($1,$2,'Archive')`, folderID, u.ID); err != nil {
		t.Fatal(err)
	}
	agentTestRead(t, a, task, doc)
	edit := agentOperationInput{Key: "edit", Kind: "update", Path: agentDocumentPath(doc.DocID), ExpectedRevision: doc.Revision, Title: "Edited", Content: "Edited content"}
	move := agentOperationInput{Key: "move", Kind: "move", Path: edit.Path, ExpectedRevision: doc.Revision, FolderID: folderID}
	inputs := []agentOperationInput{edit, move}
	switch variant {
	case "move-update":
		inputs = []agentOperationInput{move, edit}
	case "noop-move":
		inputs[0].Title, inputs[0].Content = doc.Title, doc.Content
	case "update-noop":
		noop := edit
		noop.Key = "noop"
		inputs = []agentOperationInput{edit, noop}
	case "update-move-trash":
		inputs = append(inputs, agentOperationInput{Key: "trash", Kind: "trash", Path: edit.Path, ExpectedRevision: doc.Revision})
	}
	ops, err := proposeAgentOperationsForTest(a, ctx, task, inputs)
	if err != nil {
		t.Fatal(err)
	}
	if mode != "full" {
		for _, op := range ops {
			w := writingTestRequest(t, a, u, "POST", "/api/agent/operations/"+op.ID+"/approve", map[string]string{"hash": op.Hash})
			if w.Code != 200 {
				t.Fatalf("approve: %d %s", w.Code, w.Body.String())
			}
		}
	}
	ops, err = a.loadAgentOperations(ctx, u.ID, []string{task.ID})
	if err != nil {
		t.Fatal(err)
	}
	return a, u, doc, ops
}

func TestAgentBatchReverseUndo(t *testing.T) {
	for _, mode := range []string{"full", "review", "assist"} {
		for _, variant := range []string{"update-move", "move-update", "noop-move", "update-noop", "update-move-trash"} {
			t.Run(mode+"/"+variant, func(t *testing.T) {
				a, u, original, ops := agentUndoBatchFixture(t, mode, variant)
				ctx := context.Background()
				w := writingTestRequest(t, a, u, "POST", "/api/agent/operations/"+ops[0].ID+"/undo", map[string]string{"hash": ops[0].Hash})
				if w.Code != 409 {
					t.Fatalf("out-of-order undo: %d %s", w.Code, w.Body.String())
				}
				for i := len(ops) - 1; i >= 0; i-- {
					op := ops[i]
					w = writingTestRequest(t, a, u, "POST", "/api/agent/operations/"+op.ID+"/undo", map[string]string{"hash": op.Hash})
					if w.Code != 200 {
						t.Fatalf("undo %s: %d %s", op.Input.Kind, w.Code, w.Body.String())
					}
					var undone struct {
						Operation agentOperation `json:"operation"`
					}
					if err := json.Unmarshal(w.Body.Bytes(), &undone); err != nil {
						t.Fatal(err)
					}
					if undone.Operation.Result.Revision != op.Result.Revision {
						t.Fatal("undo rewrote the original applied revision")
					}
					current, err := a.loadAgentSnapshot(ctx, a.db, u.ID, original.DocID)
					if err != nil {
						t.Fatal(err)
					}
					if current.Document.Title != op.Before.Document.Title || current.Document.Content != op.Before.Document.Content || current.Document.Theme != op.Before.Document.Theme || current.FolderID != op.Before.FolderID {
						t.Fatalf("undo did not restore its before state: %+v", current)
					}
					w = writingTestRequest(t, a, u, "POST", "/api/agent/operations/"+op.ID+"/undo", map[string]string{"hash": op.Hash})
					if w.Code != 200 {
						t.Fatalf("undo replay: %d %s", w.Code, w.Body.String())
					}
					replayed, err := a.loadAgentSnapshot(ctx, a.db, u.ID, original.DocID)
					if err != nil || replayed.Document.Revision != current.Document.Revision {
						t.Fatal("undo replay changed the document", err)
					}
				}
			})
		}
	}
}

func TestAgentBatchUndoProtectsLaterEdits(t *testing.T) {
	for _, scenario := range []string{"before-undo", "after-child-undo", "other-session-after-child-undo"} {
		t.Run(scenario, func(t *testing.T) {
			a, u, doc, ops := agentUndoBatchFixture(t, "full", "update-move")
			ctx := context.Background()
			if scenario != "before-undo" {
				w := writingTestRequest(t, a, u, "POST", "/api/agent/operations/"+ops[1].ID+"/undo", map[string]string{"hash": ops[1].Hash})
				if w.Code != 200 {
					t.Fatal(w.Body.String())
				}
			}
			current, err := a.loadAgentReviewDocument(ctx, u.ID, doc.DocID)
			if err != nil {
				t.Fatal(err)
			}
			if scenario == "other-session-after-child-undo" {
				session := agentTestSession(t, a, u, "full")
				task := agentTestTask(t, a, u, session, doc, "另一会话修改文章")
				agentTestRead(t, a, task, doc)
				_, err = proposeAgentOperationsForTest(a, ctx, task, []agentOperationInput{{Key: "edit", Kind: "update", Path: agentDocumentPath(doc.DocID), ExpectedRevision: current.Revision, Title: doc.Title, Content: "Later edit"}})
			} else {
				_, err = a.updateDocument(ctx, updateDocumentParams{User: u, DocID: doc.DocID, Title: doc.Title, Content: "Later edit", Theme: doc.Theme, ExpectedRevision: current.Revision, Source: documentSourceWeb})
			}
			if err != nil {
				t.Fatal(err)
			}
			if scenario != "before-undo" {
				// Replaying the child's undo must not refresh the parent's undo authorization.
				w := writingTestRequest(t, a, u, "POST", "/api/agent/operations/"+ops[1].ID+"/undo", map[string]string{"hash": ops[1].Hash})
				if w.Code != 200 {
					t.Fatal(w.Body.String())
				}
			}
			index := 0
			if scenario == "before-undo" {
				index = 1
			}
			w := writingTestRequest(t, a, u, "POST", "/api/agent/operations/"+ops[index].ID+"/undo", map[string]string{"hash": ops[index].Hash})
			if w.Code != 409 {
				t.Fatalf("unsafe undo: %d %s", w.Code, w.Body.String())
			}
			final, err := a.loadAgentReviewDocument(ctx, u.ID, doc.DocID)
			if err != nil || final.Content != "Later edit" {
				t.Fatal("later edit lost", err)
			}
		})
	}
}

func TestWritingLegacyStorageReservation(t *testing.T) {
	for _, enough := range []bool{false, true} {
		name := "insufficient"
		if enough {
			name = "reserved-and-released"
		}
		t.Run(name, func(t *testing.T) {
			a, u, doc := writingTestApp(t)
			ctx := context.Background()
			usage, err := a.storageUsageFor(ctx, u.ID)
			if err != nil {
				t.Fatal(err)
			}
			free := agentTaskStorageBudget - 1024
			if enough {
				free = agentTaskStorageBudget + 1024
			}
			quota := a.storageQuotaFor(u)
			if _, err = a.recordImageObject(ctx, u.ID, "u/"+u.AuthUserID+"/fill.png", quota-usage.Total()-free, quota, imagePurposePersistent, nil); err != nil {
				t.Fatal(err)
			}
			id, _ := randomUUID()
			input := writingCreateInput{RequestID: id, DocID: doc.DocID, ExpectedRevision: doc.Revision, Message: "Review"}
			w := writingTestRequest(t, a, u, "POST", "/api/writing-agent/tasks", input)
			if !enough {
				if w.Code != 409 || !strings.Contains(w.Body.String(), "storage_quota_exceeded") {
					t.Fatalf("creation ignored output budget: %d %s", w.Code, w.Body.String())
				}
				var tasks, sessions, holds, reserved int64
				if err = a.db.QueryRow(ctx, `SELECT (SELECT count(*) FROM writing_agent_tasks WHERE user_id=$1),(SELECT count(*) FROM agent_sessions WHERE user_id=$1),(SELECT count(*) FROM credit_reservations WHERE user_id=$1),reserved FROM credit_accounts WHERE user_id=$1`, u.ID).Scan(&tasks, &sessions, &holds, &reserved); err != nil || tasks != 0 || sessions != 0 || holds != 0 || reserved != 0 {
					t.Fatal("rejected task leaked rows or credits", tasks, sessions, holds, reserved, err)
				}
				return
			}
			if w.Code != 202 {
				t.Fatalf("create: %d %s", w.Code, w.Body.String())
			}
			var created struct {
				Task writingTask `json:"task"`
			}
			if err = json.Unmarshal(w.Body.Bytes(), &created); err != nil {
				t.Fatal(err)
			}
			var budget int64
			if err = a.db.QueryRow(ctx, `SELECT storage_budget_bytes FROM writing_agent_tasks WHERE id=$1`, created.Task.ID).Scan(&budget); err != nil || budget != agentTaskStorageBudget {
				t.Fatal("missing output reservation", budget, err)
			}
			beforeReplay, err := a.storageUsageFor(ctx, u.ID)
			if err != nil {
				t.Fatal(err)
			}
			w = writingTestRequest(t, a, u, "POST", "/api/writing-agent/tasks", input)
			afterReplay, err := a.storageUsageFor(ctx, u.ID)
			if err != nil || w.Code != 200 || beforeReplay != afterReplay {
				t.Fatal("replay reserved storage twice", w.Body.String(), err)
			}
			task, err := a.loadWritingTask(ctx, created.Task.ID, u.ID)
			if err != nil {
				t.Fatal(err)
			}
			if err = a.finishWritingTask(ctx, task, "completed", "", json.RawMessage(`{"totalTokens":0}`), "Done"); err != nil {
				t.Fatal(err)
			}
			afterFinish, err := a.storageUsageFor(ctx, u.ID)
			if err != nil || afterFinish.AgentSessionBytes >= agentTaskStorageBudget || afterFinish.Total() > quota {
				t.Fatal("reservation was not released to actual storage", afterFinish, err)
			}
		})
	}
}

func TestWritingLegacyProposalQuota(t *testing.T) {
	a, u, doc := writingTestApp(t)
	task := writingTestCreate(t, a, u, doc)
	ctx := context.WithValue(context.Background(), writingMCPContext{}, task)
	// Pre-upgrade active tasks have no output reservation. Their writes still need validation.
	if _, err := a.db.Exec(ctx, `UPDATE writing_agent_tasks SET storage_budget_bytes=0 WHERE id=$1`, task.ID); err != nil {
		t.Fatal(err)
	}
	usage, err := a.storageUsageFor(ctx, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	quota := a.storageQuotaFor(u)
	key := "u/" + u.AuthUserID + "/fill.png"
	if _, err = a.recordImageObject(ctx, u.ID, key, quota-usage.Total()-1024, quota, imagePurposePersistent, nil); err != nil {
		t.Fatal(err)
	}
	input := writingProposalInput{DocID: doc.DocID, ExpectedRevision: doc.Revision, Title: doc.Title, Content: strings.Repeat("x", 10000)}
	_, _, err = a.writingProposeDocument(ctx, nil, input)
	if !errors.Is(err, errDocumentQuotaExceeded) {
		t.Fatal("over-quota proposal accepted", err)
	}
	stored, err := a.loadWritingTask(ctx, task.ID, u.ID)
	if err != nil || stored.Proposal != nil {
		t.Fatal("rejected proposal was persisted", err)
	}
	if _, err = a.db.Exec(ctx, `UPDATE image_objects SET bytes=bytes-20000 WHERE object_key=$1`, key); err != nil {
		t.Fatal(err)
	}
	_, _, err = a.writingProposeDocument(ctx, nil, input)
	if err != nil {
		t.Fatal("retry after freeing space", err)
	}
	before, err := a.storageUsageFor(ctx, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, _, err = a.writingProposeDocument(ctx, nil, input)
	if err != nil {
		t.Fatal(err)
	}
	after, err := a.storageUsageFor(ctx, u.ID)
	if err != nil || before != after || after.Total() > quota {
		t.Fatal("proposal replay changed storage", err)
	}
}

func TestWritingLegacyStorageConcurrentWriter(t *testing.T) {
	a, u, doc := writingTestApp(t)
	ctx := context.Background()
	quota := a.storageQuotaFor(u)
	usage, err := a.storageUsageFor(ctx, u.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.recordImageObject(ctx, u.ID, "u/"+u.AuthUserID+"/fill.png", quota-usage.Total()-agentTaskStorageBudget-1024, quota, imagePurposePersistent, nil); err != nil {
		t.Fatal(err)
	}
	lock, err := a.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Rollback(ctx)
	if _, err = lock.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, u.ID); err != nil {
		t.Fatal(err)
	}
	created := make(chan int, 1)
	uploaded := make(chan error, 1)
	go func() {
		id, _ := randomUUID()
		w := writingTestRequest(t, a, u, "POST", "/api/writing-agent/tasks", writingCreateInput{RequestID: id, DocID: doc.DocID, ExpectedRevision: doc.Revision, Message: "Review"})
		created <- w.Code
	}()
	go func() {
		_, err := a.recordImageObject(ctx, u.ID, "u/"+u.AuthUserID+"/concurrent.png", agentTaskStorageBudget, quota, imagePurposePersistent, nil)
		uploaded <- err
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var waiting int
		if err = a.db.QueryRow(ctx, `SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock%'`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting == 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("both storage writers must acquire the user lock")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err = lock.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	code, uploadErr := <-created, <-uploaded
	if !((code == 202 && errors.Is(uploadErr, errQuotaExceeded)) || (code == 409 && uploadErr == nil)) {
		t.Fatal("storage writers did not exclude each other", code, uploadErr)
	}
	final, err := a.storageUsageFor(ctx, u.ID)
	if err != nil || final.Total() > quota {
		t.Fatal("concurrent storage exceeded quota", final, err)
	}
}
