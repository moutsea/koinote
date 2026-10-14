package server

import (
	"context"
	"encoding/json"
	"testing"

	"koinote/backend/internal/config"
)

func TestOrganizationRequiredOutputFields(t *testing.T) {
	valid := map[string]any{"docId": "doc", "folderId": "", "newFolders": []string{}, "tags": []string{}, "reason": ""}
	items := []organizationItem{{DocID: "doc", FolderID: "original", Tags: []string{"Keep"}}}
	decode := func(item map[string]any) ([]organizationSuggestion, error) {
		raw, err := json.Marshal(map[string]any{"items": []any{item}})
		if err != nil {
			t.Fatal(err)
		}
		return decodeOrganizationOutput(raw, items, nil)
	}
	if got, err := decode(valid); err != nil || got[0].NeedsReview {
		t.Fatalf("explicit root and empty arrays must remain valid: %v", err)
	}
	for _, field := range []string{"docId", "folderId", "newFolders", "tags", "reason"} {
		for _, null := range []bool{false, true} {
			t.Run(field+map[bool]string{false: "/missing", true: "/null"}[null], func(t *testing.T) {
				item := map[string]any{}
				for key, value := range valid {
					if key != field {
						item[key] = value
					}
				}
				if null {
					item[field] = nil
				}
				got, err := decode(item)
				if field == "docId" {
					if err == nil {
						t.Fatal("unidentifiable item accepted")
					}
				} else if err != nil || len(got) != 1 || !got[0].NeedsReview || got[0].FolderID != "original" || len(got[0].Tags) != 1 || got[0].Tags[0] != "Keep" {
					t.Fatalf("incomplete suggestion must preserve the original: %+v %v", got, err)
				}
			})
		}
	}
}

func TestOrganizationLatestRetainsUndoAfterPreview(t *testing.T) {
	a, db, user, doc := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-undo-entry"})
	ctx := context.Background()
	data, _, err := a.prepareOrganization(ctx, user.ID, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	choice := organizationChoice{doc.DocID, "", []string{}, []string{"Topic"}}
	data.Items[0].Suggested = &choice
	first := organizationTestReady(t, a, user.ID, data)
	if err := a.applyOrganization(ctx, user.ID, first, []organizationChoice{choice}, nil, false); err != nil {
		t.Fatal(err)
	}
	second := organizationTestReady(t, a, user.ID, data)
	check := func(wantUndo string) {
		t.Helper()
		response := organizationTestRequest(t, a, user, "GET", "/api/document-organizations/latest", "")
		var result struct {
			Organization organizationView            `json:"organization"`
			LastApplied  *organizationAppliedSummary `json:"lastApplied"`
		}
		if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &result) != nil {
			t.Fatalf("latest: %d %s", response.Code, response.Body.String())
		}
		if result.Organization.ID != second {
			t.Fatal("undo lookup replaced the latest preview")
		}
		if wantUndo == "" {
			if result.LastApplied != nil {
				t.Fatal("undo should not expose older applied runs")
			}
		} else if result.LastApplied == nil || result.LastApplied.ID != wantUndo || result.LastApplied.AppliedAt.IsZero() {
			t.Fatalf("lost undo target: %+v", result.LastApplied)
		}
	}
	for _, status := range []string{"ready", "running", "failed"} {
		if _, err := db.Exec(ctx, `UPDATE document_organizations SET status=$2 WHERE organization_id=$1`, second, status); err != nil {
			t.Fatal(err)
		}
		check(first)
	}
	response := organizationTestRequest(t, a, user, "POST", "/api/document-organizations/"+first+"/undo", "")
	if response.Code != 200 {
		t.Fatalf("undo old run: %d %s", response.Code, response.Body.String())
	}
	check("")
	// An unrelated account cannot discover the applied run.
	_, _, other, _ := newAgentReviewCreateTest(t, config.Config{SessionSecret: "other"})
	response = organizationTestRequest(t, a, other, "GET", "/api/document-organizations/latest", "")
	var empty map[string]any
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &empty) != nil || empty["organization"] != nil || empty["lastApplied"] != nil {
		t.Fatalf("another account's history leaked: %d %s", response.Code, response.Body.String())
	}
}

func TestOrganizationUnrelatedFolderChanges(t *testing.T) {
	a, db, user, doc := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-folder-scope"})
	ctx := context.Background()
	unrelated, _ := randomUUID()
	if _, err := db.Exec(ctx, `INSERT INTO folders(folder_id,user_id,name) VALUES($1,$2,'Unrelated')`, unrelated, user.ID); err != nil {
		t.Fatal(err)
	}
	data, _, err := a.prepareOrganization(ctx, user.ID, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	choice := organizationChoice{doc.DocID, "", []string{"Organized", "Topic"}, []string{"Tag"}}
	data.Items[0].Suggested = &choice
	id := organizationTestReady(t, a, user.ID, data)
	if _, err := db.Exec(ctx, `UPDATE folders SET name='Renamed' WHERE folder_id=$1`, unrelated); err != nil {
		t.Fatal(err)
	}
	extra, _ := randomUUID()
	if _, err := db.Exec(ctx, `INSERT INTO folders(folder_id,user_id,name) VALUES($1,$2,'Extra')`, extra, user.ID); err != nil {
		t.Fatal(err)
	}
	if err := a.applyOrganization(ctx, user.ID, id, []organizationChoice{choice}, nil, false); err != nil {
		t.Fatalf("unrelated rename/create blocked apply: %v", err)
	}
	if _, err := db.Exec(ctx, `DELETE FROM folders WHERE folder_id=$1`, unrelated); err != nil {
		t.Fatal(err)
	}
	if err := a.applyOrganization(ctx, user.ID, id, nil, nil, true); err != nil {
		t.Fatalf("unrelated deletion blocked undo: %v", err)
	}
	var folders, organized int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM folders WHERE user_id=$1`, user.ID).Scan(&folders); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(ctx, `SELECT count(*) FROM documents WHERE user_id=$1 AND (organized_at IS NOT NULL OR folder_id IS NOT NULL OR cardinality(tags)>0)`, user.ID).Scan(&organized); err != nil {
		t.Fatal(err)
	}
	if folders != 1 || organized != 0 {
		t.Fatalf("undo did not restore documents/preserve unrelated folder: folders=%d organized=%d", folders, organized)
	}
}

func TestOrganizationUndoRejectsStaleEntry(t *testing.T) {
	a, _, user, doc := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-stale-undo"})
	ctx := context.Background()
	var ids []string
	for i := 0; i < 2; i++ {
		if i == 1 {
			var err error
			doc, err = a.createDocument(ctx, createDocumentParams{User: user, Title: "New document", Content: "A different topic"})
			if err != nil {
				t.Fatal(err)
			}
		}
		data, _, err := a.prepareOrganization(ctx, user.ID, false, nil)
		if err != nil {
			t.Fatal(err)
		}
		choice := organizationChoice{doc.DocID, "", []string{}, []string{"Topic"}}
		data.Items[0].Suggested = &choice
		id := organizationTestReady(t, a, user.ID, data)
		if err := a.applyOrganization(ctx, user.ID, id, []organizationChoice{choice}, nil, false); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	if err := a.applyOrganization(ctx, user.ID, ids[0], nil, nil, true); err != errOrganizationConflict {
		t.Fatalf("an old tab undid an earlier run: %v", err)
	}
	if err := a.applyOrganization(ctx, user.ID, ids[1], nil, nil, true); err != nil {
		t.Fatalf("latest undo blocked: %v", err)
	}
	response := organizationTestRequest(t, a, user, "GET", "/api/document-organizations/latest", "")
	var result struct {
		LastApplied *organizationAppliedSummary `json:"lastApplied"`
	}
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &result) != nil || result.LastApplied != nil {
		t.Fatalf("single-step undo exposed old runs: %s", response.Body.String())
	}
}

func TestOrganizationRelevantFolderChangesStillConflict(t *testing.T) {
	for _, phase := range []string{"apply", "undo"} {
		for _, change := range []string{"source", "ancestor", "destination", "matching-child"} {
			t.Run(phase+"/"+change, func(t *testing.T) {
				a, db, user, doc := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-relevant-path"})
				ctx := context.Background()
				source, _ := randomUUID()
				destination, _ := randomUUID()
				child, _ := randomUUID()
				for _, folder := range []organizationFolder{{source, "Source", ""}, {destination, "Destination", ""}, {child, "Child", destination}} {
					if _, err := db.Exec(ctx, `INSERT INTO folders(folder_id,user_id,name,parent_id) VALUES($1,$2,$3,(SELECT id FROM folders WHERE folder_id=$4 AND user_id=$2))`, folder.ID, user.ID, folder.Name, folder.ParentID); err != nil {
						t.Fatal(err)
					}
				}
				if _, err := db.Exec(ctx, `UPDATE documents SET folder_id=(SELECT id FROM folders WHERE folder_id=$2) WHERE doc_id=$1`, doc.DocID, source); err != nil {
					t.Fatal(err)
				}
				data, _, err := a.prepareOrganization(ctx, user.ID, false, nil)
				if err != nil {
					t.Fatal(err)
				}
				choice := organizationChoice{doc.DocID, destination, []string{"Child", "New"}, []string{"Topic"}}
				data.Items[0].Suggested = &choice
				id := organizationTestReady(t, a, user.ID, data)
				if phase == "undo" {
					if err := a.applyOrganization(ctx, user.ID, id, []organizationChoice{choice}, nil, false); err != nil {
						t.Fatal(err)
					}
				}
				switch change {
				case "source", "ancestor", "destination":
					folderID := map[string]string{"source": source, "ancestor": destination, "destination": child}[change]
					_, err = db.Exec(ctx, `UPDATE folders SET name=name||' changed' WHERE folder_id=$1`, folderID)
				case "matching-child":
					if phase == "undo" {
						_, err = db.Exec(ctx, `UPDATE folders SET name='Changed new folder' WHERE user_id=$1 AND name='New'`, user.ID)
					} else {
						collision, _ := randomUUID()
						_, err = db.Exec(ctx, `INSERT INTO folders(folder_id,user_id,name,parent_id) VALUES($1,$2,'New',(SELECT id FROM folders WHERE folder_id=$3))`, collision, user.ID, child)
					}
				}
				if err != nil {
					t.Fatal(err)
				}
				err = a.applyOrganization(ctx, user.ID, id, []organizationChoice{choice}, nil, phase == "undo")
				if (phase == "apply" && err != errOrganizationConflict) || (phase == "undo" && err != nil) {
					t.Fatalf("unexpected relevant-path outcome: %v", err)
				}
				view, err := a.loadOrganization(ctx, user.ID, id)
				if err != nil {
					t.Fatal(err)
				}
				wantStatus := map[string]string{"apply": "ready", "undo": "undone"}[phase]
				if view.Status != wantStatus {
					t.Fatalf("conflict changed job status: %s", view.Status)
				}
				if phase == "undo" && !view.Data.Items[0].UndoSkipped {
					t.Fatal("changed path was not marked as skipped")
				}
			})
		}
	}
}
