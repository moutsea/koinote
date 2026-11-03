package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestDesktopAgentSessionScopes(t *testing.T) {
	id := "550e8400-e29b-41d4-a716-446655440000"
	routes := map[string]string{
		"/api/agent/session-settings":                    "GET PUT",
		"/api/agent/sessions":                            "GET POST",
		"/api/agent/sessions/" + id:                      "GET PUT DELETE",
		"/api/agent/sessions/" + id + "/tasks":           "POST",
		"/api/agent/operations/" + id + "/approve":       "POST",
		"/api/agent/operations/" + id + "/reject":        "POST",
		"/api/agent/operations/" + id + "/undo":          "POST",
		"/api/agent/tasks/" + id + "/operations/approve": "POST",
		"/api/agent/tasks/" + id + "/operations/reject":  "POST",
		"/api/agent/tasks/" + id + "/operations/undo":    "POST",
		"/api/agent/tasks/not-a-uuid/operations/approve": "",
		"/api/agent/artifacts/" + id:                     "GET",
		"/api/agent/sessions/not-a-uuid":                 "",
		"/api/agent/sessions/" + id + "/tasks/extra":     "",
		"/api/agent/operations/" + id + "/delete":        "",
		"/api/agent/operations/not-a-uuid/approve":       "",
		"/api/agent/artifacts/" + id + "/extra":          "",
		"/api/writing-agent/mcp/" + id:                   "",
		"/api/writing-agent/callback/" + id:              "",
	}
	for path, methods := range routes {
		for _, method := range []string{"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"} {
			want := strings.Contains(" "+methods+" ", " "+method+" ")
			if got := desktopRequestAllowed(httptest.NewRequest(method, path, nil)); got != want {
				t.Errorf("%s %s: allowed=%v, want %v", method, path, got, want)
			}
		}
	}
}

func TestAgentSameDocumentBatch(t *testing.T) {
	for _, mode := range []string{"full", "review", "assist"} {
		for _, variant := range []string{"update-move", "move-update", "noop-move", "update-move-trash"} {
			t.Run(mode+"/"+variant, func(t *testing.T) {
				a, u, doc := writingTestApp(t)
				ctx := context.Background()
				s := agentTestSession(t, a, u, mode)
				task := agentTestTask(t, a, u, s, doc, "改标题并归档")
				folderID, _ := randomUUID()
				if _, err := a.db.Exec(ctx, `INSERT INTO folders(folder_id,user_id,name) VALUES($1,$2,'Archive')`, folderID, u.ID); err != nil {
					t.Fatal(err)
				}
				agentTestRead(t, a, task, doc)
				update := agentOperationInput{Key: "update", Kind: "update", Path: agentDocumentPath(doc.DocID), ExpectedRevision: doc.Revision, Title: "New title", Content: "New content"}
				move := agentOperationInput{Key: "move", Kind: "move", Path: update.Path, ExpectedRevision: doc.Revision, FolderID: folderID}
				inputs := []agentOperationInput{update, move}
				wantRevision := doc.Revision + 2
				if variant == "move-update" {
					inputs = []agentOperationInput{move, update}
				}
				if variant == "noop-move" {
					inputs[0].Title, inputs[0].Content = doc.Title, doc.Content
					wantRevision--
				}
				if variant == "update-move-trash" {
					inputs = append(inputs, agentOperationInput{Key: "trash", Kind: "trash", Path: update.Path, ExpectedRevision: doc.Revision})
					wantRevision++
				}
				ops, err := proposeAgentOperationsForTest(a, ctx, task, inputs)
				if err != nil {
					t.Fatal(err)
				}
				if ops[1].Before.DependsOn != ops[0].ID {
					t.Fatal("missing persisted dependency")
				}
				if mode != "full" {
					for _, op := range ops {
						if op.Status != "pending" {
							t.Fatal("batch auto-approved", op)
						}
					}
					w := writingTestRequest(t, a, u, "POST", "/api/agent/operations/"+ops[1].ID+"/approve", map[string]string{"hash": ops[1].Hash})
					if w.Code != 409 {
						t.Fatal("dependent approved before predecessor", w.Code)
					}
					// Reload as the UI does; the transaction's timestamp cannot determine order.
					ordered, err := a.loadAgentOperations(ctx, u.ID, []string{task.ID})
					if err != nil {
						t.Fatal(err)
					}
					for i, op := range ordered {
						if op.ID != ops[i].ID {
							t.Fatal("approval order changed")
						}
						w = writingTestRequest(t, a, u, "POST", "/api/agent/operations/"+op.ID+"/approve", map[string]string{"hash": op.Hash})
						if w.Code != 200 {
							t.Fatalf("approve %s: %d %s", op.Input.Kind, w.Code, w.Body.String())
						}
					}
				}
				var title, content, folder string
				var revision int64
				var trashed bool
				if err = a.db.QueryRow(ctx, `SELECT d.title,d.content,d.revision,f.folder_id,d.trashed_at IS NOT NULL FROM documents d JOIN folders f ON f.id=d.folder_id WHERE d.doc_id=$1`, doc.DocID).Scan(&title, &content, &revision, &folder, &trashed); err != nil {
					t.Fatal(err)
				}
				wantTitle, wantContent := update.Title, update.Content
				if variant == "noop-move" {
					wantTitle, wantContent = doc.Title, doc.Content
				}
				if title != wantTitle || content != wantContent || revision != wantRevision || folder != folderID || trashed != (variant == "update-move-trash") {
					t.Fatalf("unexpected final state: %s %s %d %s %v", title, content, revision, folder, trashed)
				}
				if _, err = proposeAgentOperationsForTest(a, ctx, task, inputs); err != nil {
					t.Fatal("identical replay", err)
				}
				var replayRevision int64
				if err = a.db.QueryRow(ctx, `SELECT revision FROM documents WHERE doc_id=$1`, doc.DocID).Scan(&replayRevision); err != nil {
					t.Fatal(err)
				}
				if replayRevision != revision {
					t.Fatal("replay mutated document")
				}
			})
		}
	}
}

func TestAgentBatchDependencyProtectsLaterEdits(t *testing.T) {
	for _, scenario := range []string{"external-edit", "rejected", "undone"} {
		t.Run(scenario, func(t *testing.T) {
			a, u, doc := writingTestApp(t)
			ctx := context.Background()
			s := agentTestSession(t, a, u, "review")
			task := agentTestTask(t, a, u, s, doc, "修改文章后移入回收站")
			agentTestRead(t, a, task, doc)
			ops, err := proposeAgentOperationsForTest(a, ctx, task, []agentOperationInput{
				{Key: "edit", Kind: "update", Path: agentDocumentPath(doc.DocID), ExpectedRevision: doc.Revision, Title: "Revised", Content: doc.Content},
				{Key: "trash", Kind: "trash", Path: agentDocumentPath(doc.DocID), ExpectedRevision: doc.Revision},
			})
			if err != nil {
				t.Fatal(err)
			}
			action := "approve"
			if scenario == "rejected" {
				action = "reject"
			}
			w := writingTestRequest(t, a, u, "POST", "/api/agent/operations/"+ops[0].ID+"/"+action, map[string]string{"hash": ops[0].Hash})
			if w.Code != 200 {
				t.Fatal(w.Body.String())
			}
			if scenario == "undone" {
				w = writingTestRequest(t, a, u, "POST", "/api/agent/operations/"+ops[0].ID+"/undo", map[string]string{"hash": ops[0].Hash})
				if w.Code != 200 {
					t.Fatal(w.Body.String())
				}
			} else {
				current, err := a.loadAgentReviewDocument(ctx, u.ID, doc.DocID)
				if err != nil {
					t.Fatal(err)
				}
				if _, err = a.updateDocument(ctx, updateDocumentParams{User: u, DocID: doc.DocID, Title: "User edit", Content: doc.Content, Theme: doc.Theme, ExpectedRevision: current.Revision, Source: documentSourceWeb}); err != nil {
					t.Fatal(err)
				}
			}
			w = writingTestRequest(t, a, u, "POST", "/api/agent/operations/"+ops[1].ID+"/approve", map[string]string{"hash": ops[1].Hash})
			if w.Code != 409 {
				t.Fatalf("unsafe dependent operation: %d %s", w.Code, w.Body.String())
			}
			if _, err = a.loadAgentReviewDocument(ctx, u.ID, doc.DocID); err != nil {
				t.Fatal("document was trashed", err)
			}
		})
	}
}

func TestAgentOperationDependencyOrder(t *testing.T) {
	first := agentOperation{ID: "z"}
	second := agentOperation{ID: "b", Before: &agentSnapshot{DependsOn: "z"}}
	third := agentOperation{ID: "a", Before: &agentSnapshot{DependsOn: "b"}}
	ordered, err := orderAgentOperations([]agentOperation{third, second, first})
	if err != nil || ordered[0].ID != "z" || ordered[1].ID != "b" || ordered[2].ID != "a" {
		t.Fatal(ordered, err)
	}
}

func TestWritingSettlementExpiredReservation(t *testing.T) {
	for _, scenario := range []string{"already-expired", "during-poll", "waiting-for-lock"} {
		t.Run(scenario, func(t *testing.T) {
			a, u, doc := writingTestApp(t)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			task := writingTestCreate(t, a, u, doc)
			task.JobID, task.WorkspaceID = "job-done", "workspace"
			var initialBalance int64
			if err := a.db.QueryRow(ctx, `SELECT balance FROM credit_accounts WHERE user_id=$1`, u.ID).Scan(&initialBalance); err != nil {
				t.Fatal(err)
			}
			expire := func() {
				t.Helper()
				if _, err := a.db.Exec(ctx, `UPDATE credit_reservations SET expires_at=clock_timestamp() WHERE reservation_id=$1`, task.ReservationID); err != nil {
					t.Fatal(err)
				}
			}
			finish := func() error {
				return a.finishWritingTask(ctx, task, "completed", "", json.RawMessage(`{"totalTokens":2000}`), "done")
			}
			if scenario == "during-poll" {
				remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					w.Header().Set("Content-Type", "application/json")
					if r.URL.Query().Get("page") == "1" {
						w.Write([]byte(`{"events":[],"hasMore":false}`))
					} else {
						if _, err := a.db.Exec(ctx, `UPDATE credit_reservations SET expires_at=clock_timestamp() WHERE reservation_id=$1`, task.ReservationID); err != nil {
							t.Error(err)
						}
						w.Write([]byte(`{"id":"job-done","status":"completed","result":{"text":"done","usage":{"totalTokens":2000}}}`))
					}
				}))
				defer remote.Close()
				a.cfg.AgentGPTBaseURL = remote.URL
				if err := a.advanceWritingTask(ctx, &task); err != nil {
					t.Fatal(err)
				}
			} else if scenario == "waiting-for-lock" {
				tx, err := a.db.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer tx.Rollback(context.Background())
				if _, err = lockCreditAccount(ctx, tx, u.ID); err != nil {
					t.Fatal(err)
				}
				done := make(chan error, 1)
				go func() { done <- finish() }()
				for {
					var waiting bool
					if err = a.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM credit_accounts%')`).Scan(&waiting); err != nil {
						t.Fatal(err)
					}
					if waiting {
						break
					}
					time.Sleep(10 * time.Millisecond)
				}
				if _, err = tx.Exec(ctx, `UPDATE credit_reservations SET expires_at=clock_timestamp() WHERE reservation_id=$1`, task.ReservationID); err != nil {
					t.Fatal(err)
				}
				if err = tx.Commit(ctx); err != nil {
					t.Fatal(err)
				}
				if err = <-done; err != nil {
					t.Fatal(err)
				}
			} else {
				expire()
				if err := finish(); err != nil {
					t.Fatal(err)
				}
			}
			// A later reconciliation must not charge again or change the audit state.
			if err := finish(); err != nil {
				t.Fatal(err)
			}
			final, err := a.loadWritingTask(ctx, task.ID, u.ID)
			if err != nil {
				t.Fatal(err)
			}
			if final.ChargedCredits != 0 || final.BillingStatus != "needs_review" || final.Status != "completed" {
				t.Fatal("expired hold settled", final)
			}
			var balance, reserved, charges int64
			var status string
			if err = a.db.QueryRow(ctx, `SELECT balance,reserved,(SELECT count(*) FROM credit_transactions WHERE user_id=$1 AND kind='agent_usage'),(SELECT status FROM credit_reservations WHERE reservation_id=$2) FROM credit_accounts WHERE user_id=$1`, u.ID, task.ReservationID).Scan(&balance, &reserved, &charges, &status); err != nil {
				t.Fatal(err)
			}
			if balance != initialBalance || reserved != 0 || charges != 0 || status != "released" {
				t.Fatalf("expired balance changed: %d %d %d %s", balance, reserved, charges, status)
			}
		})
	}
}
