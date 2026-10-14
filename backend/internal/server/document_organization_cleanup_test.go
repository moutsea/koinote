package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"koinote/backend/internal/config"
	"koinote/backend/internal/model"
)

// Leave docID out of the selected items, but include it in the prompt as either
// an example or a tag source beyond the first 20 examples. An unused source has
// only a duplicate tag and falls outside the example limit.
func organizationTestReferenceSource(t *testing.T, a *App, user model.User, docID, source string) {
	t.Helper()
	if source == "item" {
		return
	}
	ctx := context.Background()
	tags := []string{}
	if source == "tag-only" {
		tags = []string{"Private reference tag"}
	} else if source == "unused" {
		tags = []string{"Common"}
	}
	if _, err := a.db.Exec(ctx, `UPDATE documents SET organized_at=now()-interval '1 day',tags=$2 WHERE doc_id=$1`, docID, tags); err != nil {
		t.Fatal(err)
	}
	if source == "example" {
		return
	}
	for i := 0; i < 20; i++ {
		doc, err := a.createDocument(ctx, createDocumentParams{User: user, Title: fmt.Sprintf("Confirmed example %d", i), Content: "A confirmed topic"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := a.db.Exec(ctx, `UPDATE documents SET organized_at=now(),tags=ARRAY['Common'] WHERE doc_id=$1`, doc.DocID); err != nil {
			t.Fatal(err)
		}
	}
}

func TestOrganizationPurgePreservesOtherItems(t *testing.T) {
	for _, status := range []string{"ready", "applied", "undone", "failed"} {
		t.Run(status, func(t *testing.T) {
			a, db, user, doc := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-purge"})
			ctx := context.Background()
			other, err := a.createDocument(ctx, createDocumentParams{User: user, Title: "Keep this document", Content: "Keep this content"})
			if err != nil {
				t.Fatal(err)
			}
			data, _, err := a.prepareOrganization(ctx, user.ID, false, nil)
			if err != nil {
				t.Fatal(err)
			}
			var choices []organizationChoice
			for i, item := range data.Items {
				choice := organizationChoice{item.DocID, "", []string{}, []string{"Keep tag"}}
				if item.DocID == doc.DocID {
					choice.Tags = []string{"Private tag"}
					data.Items[i].Reason = "Private deletion reason"
				}
				data.Items[i].Suggested = &choice
				choices = append(choices, choice)
			}
			data.Completed = len(data.Items)
			historyID := organizationTestReady(t, a, user.ID, data)
			id := organizationTestReady(t, a, user.ID, data)
			if status == "applied" || status == "undone" {
				if err := a.applyOrganization(ctx, user.ID, id, choices, false); err != nil {
					t.Fatal(err)
				}
			}
			if status == "undone" {
				if err := a.applyOrganization(ctx, user.ID, id, nil, true); err != nil {
					t.Fatal(err)
				}
			} else if status == "failed" {
				if _, err := db.Exec(ctx, `UPDATE document_organizations SET status='failed' WHERE organization_id=$1`, id); err != nil {
					t.Fatal(err)
				}
			}
			var before time.Time
			if err := db.QueryRow(ctx, `SELECT updated_at FROM document_organizations WHERE organization_id=$1`, id).Scan(&before); err != nil {
				t.Fatal(err)
			}
			if _, err := a.trashDocument(ctx, user, doc.DocID, 0); err != nil {
				t.Fatal(err)
			}
			if err := a.purgeDocument(ctx, userRef{ID: user.ID, AuthUserID: user.AuthUserID}, doc.DocID, "wrong confirmation", true, false); err != errDocumentPurgeConfirmation {
				t.Fatalf("confirmation: %v", err)
			}
			unchanged, err := a.loadOrganization(ctx, user.ID, id)
			if err != nil || len(unchanged.Data.Items) != 2 {
				t.Fatalf("rejected deletion changed preview: %+v %v", unchanged, err)
			}
			if status == "failed" {
				if _, err := db.Exec(ctx, `UPDATE documents SET trashed_at=now()-interval '31 days' WHERE doc_id=$1`, doc.DocID); err != nil {
					t.Fatal(err)
				}
				if err := a.purgeExpiredTrashedDocuments(ctx); err != nil {
					t.Fatal(err)
				}
			} else if err := a.purgeDocument(ctx, userRef{ID: user.ID, AuthUserID: user.AuthUserID}, doc.DocID, doc.Title, true, false); err != nil {
				t.Fatal(err)
			}
			response := organizationTestRequest(t, a, user, "GET", "/api/document-organizations/"+id, "")
			historyResponse := organizationTestRequest(t, a, user, "GET", "/api/document-organizations/"+historyID, "")
			for _, removed := range []string{doc.DocID, doc.Title, "Private tag", "Private deletion reason"} {
				if strings.Contains(response.Body.String(), removed) || strings.Contains(historyResponse.Body.String(), removed) {
					t.Fatalf("deleted metadata returned: %s", response.Body.String())
				}
			}
			var result struct {
				Organization organizationView `json:"organization"`
			}
			if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &result) != nil {
				t.Fatalf("get: %s", response.Body.String())
			}
			view := result.Organization
			if view.Status != status || len(view.Data.Items) != 1 || view.Data.Items[0].DocID != other.DocID || view.Data.Completed != 1 {
				t.Fatalf("remaining preview damaged: %+v", view)
			}
			var after time.Time
			if err := db.QueryRow(ctx, `SELECT updated_at FROM document_organizations WHERE organization_id=$1`, id).Scan(&after); err != nil || !after.Equal(before) {
				t.Fatalf("purge changed undo ordering: %v %v", after, err)
			}
			if status == "applied" {
				if err := a.applyOrganization(ctx, user.ID, id, nil, true); err != nil {
					t.Fatalf("remaining document cannot be undone: %v", err)
				}
				var tags []string
				if err := db.QueryRow(ctx, `SELECT tags FROM documents WHERE doc_id=$1`, other.DocID).Scan(&tags); err != nil || len(tags) != 0 {
					t.Fatalf("remaining undo: %v %v", tags, err)
				}
			} else if status == "ready" {
				if err := a.applyOrganization(ctx, user.ID, id, []organizationChoice{*view.Data.Items[0].Suggested}, false); err != nil {
					t.Fatalf("remaining preview cannot be applied: %v", err)
				}
			}
		})
	}
}

func TestOrganizationPurgeStopsWorker(t *testing.T) {
	for _, source := range []string{"item", "example", "tag-only"} {
		for _, phase := range []string{"before-start", "in-flight"} {
			t.Run(source+"/"+phase, func(t *testing.T) {
				a, db, user, doc := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-purge-worker"})
				ctx := context.Background()
				organizationTestReferenceSource(t, a, user, doc.DocID, source)
				extra := organizationBatchSize
				if source != "item" {
					extra++
				}
				for i := 0; i < extra; i++ {
					if _, err := a.createDocument(ctx, createDocumentParams{User: user, Title: fmt.Sprintf("Extra %d", i), Content: "Another topic"}); err != nil {
						t.Fatal(err)
					}
				}
				grantCreditsForTest(t, db, user.ID, 20, "purge-worker")
				data, prompts, err := a.prepareOrganization(ctx, user.ID, false, nil)
				if err != nil {
					t.Fatal(err)
				}
				if len(prompts) != 2 || !slices.Contains(data.InputDocumentIDs, doc.DocID) {
					t.Fatalf("missing input dependency or second batch: %+v", data)
				}
				if source != "item" && slices.ContainsFunc(data.Items, func(item organizationItem) bool { return item.DocID == doc.DocID }) {
					t.Fatal("reference document was not skipped")
				}
				if source == "tag-only" && (strings.Contains(prompts[0].User, doc.DocID) || !strings.Contains(prompts[0].User, "Private reference tag")) {
					t.Fatal("expected a tag-only source beyond the confirmed examples")
				}
				deleted := organizationItem{DocID: doc.DocID, Title: doc.Title}
				remaining := len(data.Items)
				if source == "item" {
					remaining--
				}
				id := organizationTestReady(t, a, user.ID, data)
				reservation, err := a.reserveStandaloneCredits(ctx, user.ID, 10, organizationRunLimit)
				if err != nil {
					t.Fatal(err)
				}
				if _, err := db.Exec(ctx, `UPDATE document_organizations SET status='running',reservation_id=$2 WHERE organization_id=$1`, id, reservation.ReservationID); err != nil {
					t.Fatal(err)
				}
				entered := make(chan struct{}, 1)
				released := make(chan struct{})
				var releaseOnce sync.Once
				release := func() { releaseOnce.Do(func() { close(released) }) }
				var calls atomic.Int32
				provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls.Add(1)
					entered <- struct{}{}
					select {
					case <-released:
					case <-r.Context().Done():
						return
					}
					var body struct{ Messages []struct{ Content string } }
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
						return
					}
					var input struct{ Documents []organizationDocument }
					if err := json.Unmarshal([]byte(body.Messages[len(body.Messages)-1].Content), &input); err != nil {
						t.Error(err)
						return
					}
					out := organizationOutput{Items: []organizationSuggestion{}}
					for _, doc := range input.Documents {
						out.Items = append(out.Items, organizationSuggestion{organizationChoice: organizationChoice{doc.DocID, "", []string{}, []string{"Private response"}}, Reason: "Private response reason"})
					}
					raw, _ := json.Marshal(out)
					json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": string(raw)}}}, "usage": map[string]any{"prompt_tokens": 800, "completion_tokens": 200, "total_tokens": 1000}})
				}))
				defer provider.Close()
				defer release()
				a.agentLLMHTTPClient = provider.Client()
				worker := func() {
					a.runOrganization(user.ID, id, data, prompts, agentLLMProvider{Mode: "builtin", Protocol: "openai", BaseURL: provider.URL, APIKey: "test", Model: "test"}, reservation.ReservationID)
				}
				done := make(chan struct{})
				if phase == "in-flight" {
					go func() { defer close(done); worker() }()
					select {
					case <-entered:
					case <-time.After(5 * time.Second):
						t.Fatal("worker did not start")
					}
				}
				if _, err := a.trashDocument(ctx, user, deleted.DocID, 0); err != nil {
					t.Fatal(err)
				}
				if err := a.purgeDocument(ctx, userRef{ID: user.ID, AuthUserID: user.AuthUserID}, deleted.DocID, deleted.Title, true, false); err != nil {
					t.Fatal(err)
				}
				balance, err := a.loadCreditBalance(ctx, user.ID)
				if err != nil || balance.Reserved != 0 || balance.Balance != 20 {
					t.Fatalf("purge did not immediately release credits: %+v %v", balance, err)
				}
				if phase == "in-flight" {
					release()
					select {
					case <-done:
					case <-time.After(5 * time.Second):
						t.Fatal("worker did not stop")
					}
				} else {
					worker()
				}
				view, err := a.loadOrganization(ctx, user.ID, id)
				raw, _ := json.Marshal(view)
				if err != nil || view.Status != "failed" || view.ErrorCode != "organization_document_deleted" || len(view.Data.Items) != remaining || strings.Contains(string(raw), deleted.DocID) || strings.Contains(string(raw), "Private response") {
					t.Fatalf("worker repopulated deleted data: %s %v", raw, err)
				}
				wantCalls := int32(0)
				if phase == "in-flight" {
					wantCalls = 1
				}
				if calls.Load() != wantCalls {
					t.Fatalf("worker made %d calls, want %d", calls.Load(), wantCalls)
				}
				balance, err = a.loadCreditBalance(ctx, user.ID)
				if err != nil || balance.Reserved != 0 || balance.Balance != 20 {
					t.Fatalf("worker charged cancelled run: %+v %v", balance, err)
				}
			})
		}
	}
}

func TestOrganizationPurgeDuringCreation(t *testing.T) {
	for _, source := range []string{"item", "example", "tag-only"} {
		for _, phase := range []string{"before-insert", "before-reservation-attachment"} {
			t.Run(source+"/"+phase, func(t *testing.T) {
				var calls atomic.Int32
				provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); w.WriteHeader(500) }))
				defer provider.Close()
				a, db, user, doc := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-purge-create", AgentLLMProtocol: "openai", AgentLLMBaseURL: provider.URL, AgentLLMAPIKey: "test", AgentLLMModel: "test"})
				a.agentLLMHTTPClient = provider.Client()
				ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
				defer cancel()
				organizationTestReferenceSource(t, a, user, doc.DocID, source)
				if source != "item" {
					if _, err := a.createDocument(ctx, createDocumentParams{User: user, Title: "New document", Content: "Needs classification"}); err != nil {
						t.Fatal(err)
					}
				}
				grantCreditsForTest(t, db, user.ID, 20, "purge-create")
				blocker, err := db.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer blocker.Rollback(context.Background())
				if phase == "before-insert" {
					_, err = blocker.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, user.ID)
				} else {
					_, err = blocker.Exec(ctx, `SELECT user_id FROM credit_accounts WHERE user_id=$1 FOR UPDATE`, user.ID)
				}
				if err != nil {
					t.Fatal(err)
				}
				id, _ := randomUUID()
				payload := `{"requestId":"` + id + `","includeOrganized":false,"providerMode":"builtin","maxReservedCredits":100}`
				request := httptest.NewRequest("POST", "/api/document-organizations", strings.NewReader(payload)).WithContext(ctx)
				request.Header.Set("Content-Type", "application/json")
				request.AddCookie(sessionCookieFor(t, a, user.AuthUserID, user.SessionVersion))
				response := httptest.NewRecorder()
				done := make(chan struct{})
				go func() { defer close(done); a.Routes().ServeHTTP(response, request) }()
				for {
					var waiting bool
					if phase == "before-insert" {
						err = db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=$1 AND NOT granted)`, user.ID).Scan(&waiting)
					} else {
						err = db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM document_organizations WHERE organization_id=$1 AND status='running' AND reservation_id='')`, id).Scan(&waiting)
					}
					if err != nil {
						t.Fatal(err)
					}
					if waiting {
						break
					}
					select {
					case <-done:
						t.Fatalf("create did not wait: %d %s", response.Code, response.Body.String())
					case <-ctx.Done():
						t.Fatal(ctx.Err())
					case <-time.After(10 * time.Millisecond):
					}
				}
				if phase == "before-insert" {
					// The request already prepared its snapshot; delete while holding the same
					// lock used by the real purge path, before allowing insertion to continue.
					if _, err = blocker.Exec(ctx, `DELETE FROM documents WHERE user_id=$1 AND doc_id=$2`, user.ID, doc.DocID); err != nil {
						t.Fatal(err)
					}
				} else {
					if _, err := a.trashDocument(ctx, user, doc.DocID, 0); err != nil {
						t.Fatal(err)
					}
					if err := a.purgeDocument(ctx, userRef{ID: user.ID, AuthUserID: user.AuthUserID}, doc.DocID, doc.Title, true, false); err != nil {
						t.Fatal(err)
					}
				}
				if err := blocker.Commit(ctx); err != nil {
					t.Fatal(err)
				}
				select {
				case <-done:
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
				if response.Code != 409 {
					t.Fatalf("stale creation not rejected: %d %s", response.Code, response.Body.String())
				}
				var retained int
				if err := db.QueryRow(ctx, `SELECT count(*) FROM document_organizations WHERE user_id=$1 AND (data->'items' @> $2::jsonb OR data->'inputDocumentIds' ? $3::text)`, user.ID, `[{"docId":"`+doc.DocID+`"}]`, doc.DocID).Scan(&retained); err != nil || retained != 0 {
					t.Fatalf("creation restored metadata: %d %v", retained, err)
				}
				balance, err := a.loadCreditBalance(ctx, user.ID)
				if err != nil || balance.Reserved != 0 || balance.Balance != 20 || calls.Load() != 0 {
					t.Fatalf("cancelled creation used credits/provider: %+v %d %v", balance, calls.Load(), err)
				}
			})
		}
	}
}

func TestOrganizationPurgeUnusedDocumentKeepsRun(t *testing.T) {
	a, db, user, doc := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-unused-source"})
	ctx := context.Background()
	organizationTestReferenceSource(t, a, user, doc.DocID, "unused")
	if _, err := a.createDocument(ctx, createDocumentParams{User: user, Title: "New document", Content: "Needs classification"}); err != nil {
		t.Fatal(err)
	}
	data, prompts, err := a.prepareOrganization(ctx, user.ID, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(prompts) != 1 || len(data.InputDocumentIDs) != 21 || slices.Contains(data.InputDocumentIDs, doc.DocID) || strings.Contains(prompts[0].User, doc.DocID) {
		t.Fatalf("unused document treated as an input: %+v", data)
	}
	id := organizationTestReady(t, a, user.ID, data)
	if _, err := db.Exec(ctx, `UPDATE document_organizations SET status='running' WHERE organization_id=$1`, id); err != nil {
		t.Fatal(err)
	}
	if _, err := a.trashDocument(ctx, user, doc.DocID, 0); err != nil {
		t.Fatal(err)
	}
	if err := a.purgeDocument(ctx, userRef{ID: user.ID, AuthUserID: user.AuthUserID}, doc.DocID, doc.Title, true, false); err != nil {
		t.Fatal(err)
	}
	view, err := a.loadOrganization(ctx, user.ID, id)
	if err != nil || view.Status != "running" || len(view.Data.Items) != 1 || len(view.Data.InputDocumentIDs) != 21 {
		t.Fatalf("unrelated deletion stopped the run: %+v %v", view, err)
	}
}

func TestOrganizationUndoAfterPurgePreservesChangedFolders(t *testing.T) {
	for _, change := range []string{"unchanged", "rename", "move", "rename-created-ancestor", "move-created-ancestor", "rename-existing-ancestor", "move-existing-ancestor", "deleted"} {
		t.Run(change, func(t *testing.T) {
			a, db, user, doc := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-purge-undo-folder"})
			ctx := context.Background()
			other, err := a.createDocument(ctx, createDocumentParams{User: user, Title: "Keep this document", Content: "Another topic"})
			if err != nil {
				t.Fatal(err)
			}
			parent, _ := randomUUID()
			elsewhere, _ := randomUUID()
			for _, folder := range []organizationFolder{{parent, "Existing parent", ""}, {elsewhere, "Elsewhere", ""}} {
				if _, err := db.Exec(ctx, `INSERT INTO folders(folder_id,user_id,name) VALUES($1,$2,$3)`, folder.ID, user.ID, folder.Name); err != nil {
					t.Fatal(err)
				}
			}
			data, _, err := a.prepareOrganization(ctx, user.ID, false, nil)
			if err != nil {
				t.Fatal(err)
			}
			var choices []organizationChoice
			for i, item := range data.Items {
				choice := organizationChoice{item.DocID, parent, []string{"First", "Leaf"}, []string{"Topic"}}
				if item.DocID == other.DocID {
					choice.FolderID, choice.NewFolders = "", []string{"Second"}
				}
				data.Items[i].Suggested = &choice
				choices = append(choices, choice)
			}
			id := organizationTestReady(t, a, user.ID, data)
			if err := a.applyOrganization(ctx, user.ID, id, choices, false); err != nil {
				t.Fatal(err)
			}
			view, err := a.loadOrganization(ctx, user.ID, id)
			if err != nil {
				t.Fatal(err)
			}
			created := map[string]string{}
			for _, folder := range view.Data.CreatedFolders {
				created[folder.Name] = folder.ID
			}
			if len(created) != 3 {
				t.Fatalf("unexpected created folders: %+v", created)
			}
			if _, err := a.trashDocument(ctx, user, doc.DocID, 0); err != nil {
				t.Fatal(err)
			}
			if err := a.purgeDocument(ctx, userRef{ID: user.ID, AuthUserID: user.AuthUserID}, doc.DocID, doc.Title, true, false); err != nil {
				t.Fatal(err)
			}
			target := created["Leaf"]
			if strings.Contains(change, "created-ancestor") {
				target = created["First"]
			} else if strings.Contains(change, "existing-ancestor") {
				target = parent
			}
			switch {
			case strings.HasPrefix(change, "rename"):
				_, err = db.Exec(ctx, `UPDATE folders SET name='User renamed' WHERE folder_id=$1`, target)
			case strings.HasPrefix(change, "move"):
				_, err = db.Exec(ctx, `UPDATE folders SET parent_id=(SELECT id FROM folders WHERE folder_id=$2) WHERE folder_id=$1`, target, elsewhere)
			case change == "deleted":
				_, err = db.Exec(ctx, `DELETE FROM folders WHERE folder_id=$1`, target)
			}
			if err != nil {
				t.Fatal(err)
			}
			if err := a.applyOrganization(ctx, user.ID, id, nil, true); err != nil {
				t.Fatalf("unrelated document could not be undone: %v", err)
			}
			var leafExists, secondExists, restored bool
			if err := db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM folders WHERE folder_id=$1),
                EXISTS(SELECT 1 FROM folders WHERE folder_id=$2),
                EXISTS(SELECT 1 FROM documents WHERE doc_id=$3 AND folder_id IS NULL AND organized_at IS NULL AND cardinality(tags)=0)`, created["Leaf"], created["Second"], other.DocID).Scan(&leafExists, &secondExists, &restored); err != nil {
				t.Fatal(err)
			}
			wantLeaf := change != "unchanged" && change != "deleted"
			if leafExists != wantLeaf || secondExists || !restored {
				t.Fatalf("undo cleanup: leaf=%v (want %v) second=%v restored=%v", leafExists, wantLeaf, secondExists, restored)
			}
			if !wantLeaf {
				var firstExists bool
				if err := db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM folders WHERE folder_id=$1)`, created["First"]).Scan(&firstExists); err != nil || firstExists {
					t.Fatalf("unchanged empty ancestor was not cleaned up: %v %v", firstExists, err)
				}
			}
		})
	}
}
