package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
	"koinote/backend/internal/config"
)

func TestOrganizationInvalidSuggestionIsIsolated(t *testing.T) {
	items := []organizationItem{{DocID: "bad", FolderID: "original", Tags: []string{"Keep"}}, {DocID: "good"}}
	for _, field := range []string{"too-many-tags", "long-tag", "unknown-folder", "wrong-type", "long-reason"} {
		t.Run(field, func(t *testing.T) {
			bad := map[string]any{"docId": "bad", "folderId": "", "newFolders": []string{}, "tags": []string{}, "reason": "Topic"}
			switch field {
			case "too-many-tags":
				bad["tags"] = []string{"a", "b", "c", "d", "e", "f"}
			case "long-tag":
				bad["tags"] = []string{strings.Repeat("界", 33)}
			case "unknown-folder":
				bad["folderId"] = "another-user-folder"
			case "wrong-type":
				bad["tags"] = 123
			case "long-reason":
				bad["reason"] = strings.Repeat("界", 501)
			}
			raw, _ := json.Marshal(map[string]any{"items": []any{bad, map[string]any{"docId": "good", "folderId": "", "newFolders": []string{"Topic"}, "tags": []string{"Valid"}, "reason": "Good"}}})
			got, err := decodeOrganizationOutput(raw, items, []organizationFolder{{"original", "Original", ""}})
			if err != nil || len(got) != 2 || !got[0].NeedsReview || got[0].FolderID != "original" || !slices.Equal(got[0].Tags, []string{"Keep"}) || got[1].NeedsReview || got[1].NewFolders[0] != "Topic" {
				t.Fatalf("invalid suggestion damaged usable output: %+v %v", got, err)
			}
		})
	}
}

func TestOrganizationInvalidLaterBatchKeepsPreviewAndBilling(t *testing.T) {
	a, db, user, _ := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-partial-model"})
	ctx := context.Background()
	for i := 0; i < organizationBatchSize; i++ {
		if _, err := a.createDocument(ctx, createDocumentParams{User: user, Title: fmt.Sprintf("Article %d", i), Content: "Topic"}); err != nil {
			t.Fatal(err)
		}
	}
	data, prompts, err := a.prepareOrganization(ctx, user.ID, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	grantCreditsForTest(t, db, user.ID, 20, "partial-model")
	reservation, err := a.reserveStandaloneCredits(ctx, user.ID, 10, organizationRunLimit)
	if err != nil {
		t.Fatal(err)
	}
	id := organizationTestReady(t, a, user.ID, data)
	if _, err := db.Exec(ctx, `UPDATE document_organizations SET status='running',reservation_id=$2 WHERE organization_id=$1`, id, reservation.ReservationID); err != nil {
		t.Fatal(err)
	}
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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
			tags := []string{"Topic"}
			if len(input.Documents) == 1 {
				tags = []string{"a", "b", "c", "d", "e", "f"}
			}
			out.Items = append(out.Items, organizationSuggestion{organizationChoice: organizationChoice{doc.DocID, "", []string{}, tags}, Reason: "Topic"})
		}
		raw, _ := json.Marshal(out)
		json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": string(raw)}}}, "usage": map[string]any{"prompt_tokens": 1600, "completion_tokens": 400, "total_tokens": 2000}})
	}))
	defer provider.Close()
	a.agentLLMHTTPClient = provider.Client()
	a.runOrganization(user.ID, id, data, prompts, agentLLMProvider{Mode: "builtin", Protocol: "openai", BaseURL: provider.URL, APIKey: "test", Model: "test"}, reservation.ReservationID)
	view, err := a.loadOrganization(ctx, user.ID, id)
	if err != nil || view.Status != "ready" || view.Data.Completed != 9 || view.CreditsCharged != 1 || view.Data.UnbilledBatches != 1 {
		t.Fatalf("lost completed batches: %+v %v", view, err)
	}
	for i, item := range view.Data.Items {
		if item.NeedsReview != (i == 8) || item.Suggested == nil {
			t.Fatalf("unexpected fallback at %d: %+v", i, item)
		}
	}
	balance, err := a.loadCreditBalance(ctx, user.ID)
	if err != nil || balance.Balance != 19 || balance.Reserved != 0 {
		t.Fatalf("billing: %+v %v", balance, err)
	}
	var tokens, billable int
	if err := db.QueryRow(ctx, `SELECT (metadata->>'providerTokens')::int,(metadata->>'billableTokens')::int FROM credit_transactions WHERE user_id=$1 AND kind='agent_usage'`, user.ID).Scan(&tokens, &billable); err != nil || tokens != 4000 || billable != 2000 {
		t.Fatalf("unusable batch was billed: %d/%d %v", tokens, billable, err)
	}
}

func TestOrganizationUnusableBatchBilling(t *testing.T) {
	for _, scenario := range []string{"all-invalid", "mixed-items", "byok-invalid"} {
		t.Run(scenario, func(t *testing.T) {
			a, db, user, doc := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-free-fallback"})
			ctx := context.Background()
			if scenario == "mixed-items" {
				if _, err := a.createDocument(ctx, createDocumentParams{User: user, Title: "Valid", Content: "Topic"}); err != nil {
					t.Fatal(err)
				}
			}
			data, prompts, err := a.prepareOrganization(ctx, user.ID, false, nil)
			if err != nil {
				t.Fatal(err)
			}
			mode := "builtin"
			reservationID := ""
			grantCreditsForTest(t, db, user.ID, 20, "free-fallback")
			if scenario == "byok-invalid" {
				mode = "byok"
			} else {
				reservation, err := a.reserveStandaloneCredits(ctx, user.ID, 10, organizationRunLimit)
				if err != nil {
					t.Fatal(err)
				}
				reservationID = reservation.ReservationID
			}
			data.ProviderMode = mode
			id := organizationTestReady(t, a, user.ID, data)
			if _, err := db.Exec(ctx, `UPDATE document_organizations SET status='running',reservation_id=$2 WHERE organization_id=$1`, id, reservationID); err != nil {
				t.Fatal(err)
			}
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				out := organizationOutput{Items: []organizationSuggestion{}}
				for _, item := range data.Items {
					folder := ""
					if item.DocID == doc.DocID {
						folder = "invented"
					}
					out.Items = append(out.Items, organizationSuggestion{organizationChoice: organizationChoice{item.DocID, folder, []string{}, []string{}}, Reason: "Topic"})
				}
				raw, _ := json.Marshal(out)
				json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"content": string(raw)}}}, "usage": map[string]any{"prompt_tokens": 1600, "completion_tokens": 400, "total_tokens": 2000}})
			}))
			defer provider.Close()
			a.agentLLMHTTPClient = provider.Client()
			a.runOrganization(user.ID, id, data, prompts, agentLLMProvider{Mode: mode, Protocol: "openai", BaseURL: provider.URL, APIKey: "test", Model: "test"}, reservationID)
			view, err := a.loadOrganization(ctx, user.ID, id)
			wantCharged, wantUnbilled := int64(0), 1
			if scenario == "mixed-items" {
				wantCharged, wantUnbilled = 1, 0
			}
			if err != nil || view.Status != "ready" || view.CreditsCharged != wantCharged || view.Data.UnbilledBatches != wantUnbilled {
				t.Fatalf("billing outcome: %+v %v", view, err)
			}
			var balance, reserved int64
			if err := db.QueryRow(ctx, `SELECT balance,reserved FROM credit_accounts WHERE user_id=$1`, user.ID).Scan(&balance, &reserved); err != nil || balance != 20-wantCharged || reserved != 0 {
				t.Fatalf("reservation/balance: %d/%d %v", balance, reserved, err)
			}
			if scenario == "all-invalid" {
				var status string
				if err := db.QueryRow(ctx, `SELECT status FROM credit_reservations WHERE reservation_id=$1`, reservationID).Scan(&status); err != nil || status != "released" {
					t.Fatalf("unusable batch reservation not released: %s %v", status, err)
				}
			}
		})
	}
}

func TestOrganizationUndoSkipsOnlyChangedItems(t *testing.T) {
	for _, change := range []string{"tags", "move", "folder"} {
		t.Run(change, func(t *testing.T) {
			a, db, user, doc := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-partial-undo"})
			ctx := context.Background()
			other, err := a.createDocument(ctx, createDocumentParams{User: user, Title: "Untouched", Content: "Keep content"})
			if err != nil {
				t.Fatal(err)
			}
			data, _, err := a.prepareOrganization(ctx, user.ID, false, nil)
			if err != nil {
				t.Fatal(err)
			}
			var choices []organizationChoice
			for i, item := range data.Items {
				choice := organizationChoice{item.DocID, "", []string{item.DocID}, []string{"Topic"}}
				data.Items[i].Suggested = &choice
				choices = append(choices, choice)
			}
			id := organizationTestReady(t, a, user.ID, data)
			if err := a.applyOrganization(ctx, user.ID, id, choices, false); err != nil {
				t.Fatal(err)
			}
			switch change {
			case "tags":
				_, err = db.Exec(ctx, `UPDATE documents SET tags=ARRAY['Manual'] WHERE doc_id=$1`, doc.DocID)
			case "move":
				_, err = db.Exec(ctx, `UPDATE documents SET folder_id=NULL WHERE doc_id=$1`, doc.DocID)
			case "folder":
				_, err = db.Exec(ctx, `UPDATE folders SET name='Manual folder' WHERE id=(SELECT folder_id FROM documents WHERE doc_id=$1)`, doc.DocID)
			}
			if err != nil {
				t.Fatal(err)
			}
			var before, after []byte
			// Restoring a sibling may shift ordinals to make space, but must
			// preserve every other field of the skipped document.
			if err := db.QueryRow(ctx, `SELECT to_jsonb(d)-'sort_order' FROM documents d WHERE doc_id=$1`, doc.DocID).Scan(&before); err != nil {
				t.Fatal(err)
			}
			for retry := 0; retry < 2; retry++ {
				if err := a.applyOrganization(ctx, user.ID, id, nil, true); err != nil {
					t.Fatal(err)
				}
			}
			view, err := a.loadOrganization(ctx, user.ID, id)
			if err != nil || view.Status != "undone" {
				t.Fatalf("partial undo: %+v %v", view, err)
			}
			for _, item := range view.Data.Items {
				if item.UndoSkipped != (item.DocID == doc.DocID) {
					t.Fatalf("wrong skipped document: %+v", item)
				}
			}
			if err := db.QueryRow(ctx, `SELECT to_jsonb(d)-'sort_order' FROM documents d WHERE doc_id=$1`, doc.DocID).Scan(&after); err != nil || string(before) != string(after) {
				t.Fatalf("later manual edit overwritten: %s / %s %v", before, after, err)
			}
			var restored bool
			if err := db.QueryRow(ctx, `SELECT folder_id IS NULL AND cardinality(tags)=0 AND organized_at IS NULL AND content='Keep content' FROM documents WHERE doc_id=$1`, other.DocID).Scan(&restored); err != nil || !restored {
				t.Fatalf("unrelated document was not restored: %v %v", restored, err)
			}
			var preservedFolder bool
			if err := db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM folders WHERE user_id=$1 AND name=$2)`, user.ID, doc.DocID).Scan(&preservedFolder); err != nil {
				t.Fatal(err)
			}
			if change == "tags" && !preservedFolder {
				t.Fatal("skipped document's folder was removed")
			}
		})
	}
}

func TestOrganizationRetriesSerializationWithoutRegeneration(t *testing.T) {
	a, db, user, doc := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-retry"})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	data, _, err := a.prepareOrganization(ctx, user.ID, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	choice := organizationChoice{doc.DocID, "", []string{"Topic"}, []string{}}
	data.Items[0].Suggested = &choice
	id := organizationTestReady(t, a, user.ID, data)
	blocker, err := db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback(context.Background())
	if _, err := blocker.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, user.ID); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- a.applyOrganization(ctx, user.ID, id, []organizationChoice{choice}, false) }()
	for {
		var waiting bool
		if err := db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=$1 AND NOT granted)`, user.ID).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("apply did not wait: %v", err)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(10 * time.Millisecond):
		}
	}
	// The waiting serializable transaction has an older snapshot, but neither
	// the document's content nor classification has changed.
	if _, err := blocker.Exec(ctx, `UPDATE documents SET updated_at=now() WHERE doc_id=$1`, doc.DocID); err != nil {
		t.Fatal(err)
	}
	if err := blocker.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatalf("valid preview required regeneration: %v", err)
	}
	var count int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM folders WHERE user_id=$1`, user.ID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("retry duplicated writes: %d %v", count, err)
	}
	for _, code := range []string{"40001", "40P01"} {
		err := retryOrganizationTransaction(ctx, func() error { return &pgconn.PgError{Code: code} })
		if !errors.Is(err, errOrganizationBusy) {
			t.Fatalf("retry exhaustion: %v", err)
		}
		w := httptest.NewRecorder()
		writeOrganizationError(w, err)
		if w.Code != 503 || !strings.Contains(w.Body.String(), "organization_busy") {
			t.Fatalf("temporary failure presented as stale preview: %s", w.Body.String())
		}
	}
}

func TestOrganizationTrashAndReorderDoNotBlock(t *testing.T) {
	a, db, user, doc := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-trash-order"})
	ctx := context.Background()
	other, err := a.createDocument(ctx, createDocumentParams{User: user, Title: "Other", Content: "Topic"})
	if err != nil {
		t.Fatal(err)
	}
	data, _, err := a.prepareOrganization(ctx, user.ID, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	var choices []organizationChoice
	for i, item := range data.Items {
		choice := organizationChoice{item.DocID, "", []string{}, []string{"Topic"}}
		data.Items[i].Suggested = &choice
		choices = append(choices, choice)
	}
	id := organizationTestReady(t, a, user.ID, data)
	if _, err := a.trashDocument(ctx, user, doc.DocID, 0); err != nil {
		t.Fatal(err)
	}
	if err := a.applyOrganization(ctx, user.ID, id, choices, false); err != nil {
		t.Fatal(err)
	}
	if err := a.applyOrganization(ctx, user.ID, id, choices, false); err != nil {
		t.Fatalf("retry after skipping trash: %v", err)
	}
	view, err := a.loadOrganization(ctx, user.ID, id)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range view.Data.Items {
		if item.DocID == doc.DocID && (!item.ApplySkipped || item.AppliedVersion != nil) {
			t.Fatalf("trashed document was applied: %+v", item)
		}
	}
	if _, err := db.Exec(ctx, `UPDATE documents SET sort_order=17 WHERE doc_id=$1`, other.DocID); err != nil {
		t.Fatal(err)
	}
	if _, err := a.trashDocument(ctx, user, other.DocID, 0); err != nil {
		t.Fatal(err)
	}
	if err := a.applyOrganization(ctx, user.ID, id, nil, true); err != nil {
		t.Fatalf("trash/order blocked undo: %v", err)
	}
	var preserved bool
	if err := db.QueryRow(ctx, `SELECT trashed_at IS NOT NULL AND sort_order=17 AND organized_at IS NULL AND cardinality(tags)=0 FROM documents WHERE doc_id=$1`, other.DocID).Scan(&preserved); err != nil || !preserved {
		t.Fatalf("undo changed trash or later order: %v %v", preserved, err)
	}
}

func TestOrganizationUndoInsertsWithoutOrderCollisions(t *testing.T) {
	a, db, user, doc := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-undo-order"})
	ctx := context.Background()
	other, err := a.createDocument(ctx, createDocumentParams{User: user, Title: "Stays in root", Content: "Topic"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `UPDATE documents SET sort_order=CASE WHEN doc_id=$2 THEN 0 ELSE 1 END,updated_at='2000-01-01' WHERE user_id=$1`, user.ID, doc.DocID); err != nil {
		t.Fatal(err)
	}
	data, _, err := a.prepareOrganization(ctx, user.ID, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	// Ensure the tag-only item is restored after the item inserted before it.
	slices.SortFunc(data.Items, func(a, b organizationItem) int {
		if a.DocID == b.DocID {
			return 0
		}
		if a.DocID == doc.DocID {
			return -1
		}
		return 1
	})
	var choices []organizationChoice
	for i, item := range data.Items {
		choice := organizationChoice{item.DocID, "", []string{}, []string{"Topic"}}
		if item.DocID == doc.DocID {
			choice.NewFolders = []string{"Moved"}
		}
		data.Items[i].Suggested = &choice
		choices = append(choices, choice)
	}
	id := organizationTestReady(t, a, user.ID, data)
	if err := a.applyOrganization(ctx, user.ID, id, choices, false); err != nil {
		t.Fatal(err)
	}
	var movedAt time.Time
	if err := db.QueryRow(ctx, `SELECT updated_at FROM documents WHERE doc_id=$1`, doc.DocID).Scan(&movedAt); err != nil || movedAt.Year() == 2000 {
		t.Fatalf("move did not update timestamp: %v %v", movedAt, err)
	}
	added, err := a.createDocument(ctx, createDocumentParams{User: user, Title: "New root document", Content: "New"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `UPDATE documents SET sort_order=CASE WHEN doc_id=$2 THEN 0 ELSE 1 END WHERE user_id=$1 AND folder_id IS NULL`, user.ID, other.DocID); err != nil {
		t.Fatal(err)
	}
	if err := a.applyOrganization(ctx, user.ID, id, nil, true); err != nil {
		t.Fatal(err)
	}
	var ids []string
	var count, distinct int
	if err := db.QueryRow(ctx, `SELECT array_agg(doc_id ORDER BY sort_order),count(*),count(DISTINCT sort_order) FROM documents WHERE user_id=$1 AND folder_id IS NULL`, user.ID).Scan(&ids, &count, &distinct); err != nil || count != 3 || distinct != 3 || !slices.Equal(ids, []string{doc.DocID, other.DocID, added.DocID}) {
		t.Fatalf("order collision: %v %d/%d %v", ids, count, distinct, err)
	}
	var restoredAt time.Time
	if err := db.QueryRow(ctx, `SELECT updated_at FROM documents WHERE doc_id=$1`, doc.DocID).Scan(&restoredAt); err != nil || !restoredAt.After(movedAt) {
		t.Fatalf("undo timestamp: %v %v", restoredAt, err)
	}
}

func TestOrganizationDuplicateFoldersUseExplicitIdentity(t *testing.T) {
	a, db, user, doc := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-ambiguous"})
	ctx := context.Background()
	var folders []string
	for i := 0; i < 2; i++ {
		id, _ := randomUUID()
		folders = append(folders, id)
		if _, err := db.Exec(ctx, `INSERT INTO folders(folder_id,user_id,name) VALUES($1,$2,'Same')`, id, user.ID); err != nil {
			t.Fatal(err)
		}
	}
	data, _, err := a.prepareOrganization(ctx, user.ID, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	choice := organizationChoice{doc.DocID, "", []string{"Same"}, []string{}}
	data.Items[0].Suggested = &choice
	id := organizationTestReady(t, a, user.ID, data)
	if err := a.applyOrganization(ctx, user.ID, id, []organizationChoice{choice}, false); !errors.Is(err, errOrganizationAmbiguousFolder) {
		t.Fatalf("ambiguous folder not explained: %v", err)
	}
	choice.FolderID, choice.NewFolders = folders[1], []string{}
	if err := a.applyOrganization(ctx, user.ID, id, []organizationChoice{choice}, false); err != nil {
		t.Fatalf("explicit identity blocked: %v", err)
	}
	if err := a.applyOrganization(ctx, user.ID, id, nil, true); err != nil {
		t.Fatal(err)
	}
}

func TestOrganizationExpiryReleasesActiveReservation(t *testing.T) {
	for _, action := range []string{"get", "create"} {
		t.Run(action, func(t *testing.T) {
			a, db, user, doc := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-expiry-release"})
			ctx := context.Background()
			grantCreditsForTest(t, db, user.ID, 20, "expiry-release")
			data, _, err := a.prepareOrganization(ctx, user.ID, false, nil)
			if err != nil {
				t.Fatal(err)
			}
			id := organizationTestReady(t, a, user.ID, data)
			reservation, err := a.reserveStandaloneCredits(ctx, user.ID, 10, 30*time.Minute)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := db.Exec(ctx, `UPDATE document_organizations SET status='running',created_at=now()-interval '20 minutes',reservation_id=$2 WHERE organization_id=$1`, id, reservation.ReservationID); err != nil {
				t.Fatal(err)
			}
			if action == "get" {
				w := organizationTestRequest(t, a, user, "GET", "/api/document-organizations/"+id, "")
				if w.Code != 200 {
					t.Fatal(w.Body.String())
				}
			} else {
				if _, err := db.Exec(ctx, `UPDATE documents SET organized_at=now() WHERE doc_id=$1`, doc.DocID); err != nil {
					t.Fatal(err)
				}
				next, _ := randomUUID()
				w := organizationTestRequest(t, a, user, "POST", "/api/document-organizations", `{"requestId":"`+next+`","providerMode":"builtin","maxReservedCredits":0}`)
				if w.Code != 202 {
					t.Fatal(w.Body.String())
				}
			}
			// Read directly: loadCreditBalance would itself perform TTL cleanup.
			var reserved int64
			var status string
			var unexpired bool
			if err := db.QueryRow(ctx, `SELECT a.reserved,r.status,r.expires_at>now() FROM credit_accounts a JOIN credit_reservations r ON r.user_id=a.user_id WHERE a.user_id=$1 AND r.reservation_id=$2`, user.ID, reservation.ReservationID).Scan(&reserved, &status, &unexpired); err != nil || reserved != 0 || status != "released" || !unexpired {
				t.Fatalf("expiry left credits reserved: %d %s %v %v", reserved, status, unexpired, err)
			}
		})
	}
}

func TestOrganizationExcludedConflictsNeverBecomeReferences(t *testing.T) {
	a, db, user, doc := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-exclude"})
	ctx := context.Background()
	if _, err := db.Exec(ctx, `UPDATE documents SET organized_at=now(),title='Excluded reference',tags=ARRAY['ExcludedTag'] WHERE doc_id=$1`, doc.DocID); err != nil {
		t.Fatal(err)
	}
	other, err := a.createDocument(ctx, createDocumentParams{User: user, Title: "Usable", Content: "Topic"})
	if err != nil {
		t.Fatal(err)
	}
	data, prompts, err := a.prepareOrganization(ctx, user.ID, true, []string{doc.DocID})
	if err != nil {
		t.Fatal(err)
	}
	if len(data.Items) != 1 || data.Items[0].DocID != other.DocID || slices.Contains(data.InputDocumentIDs, doc.DocID) || len(prompts) != 1 || strings.Contains(prompts[0].User, "Excluded") {
		t.Fatalf("excluded document was sent: %+v %+v", data, prompts)
	}
	w := organizationTestRequest(t, a, user, "POST", "/api/document-organizations/estimate", `{"includeOrganized":true,"excludeDocIds":["`+doc.DocID+`"]}`)
	var estimate struct{ Count int }
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &estimate) != nil || estimate.Count != 1 {
		t.Fatalf("exclusion missing from estimate: %s", w.Body.String())
	}
}
