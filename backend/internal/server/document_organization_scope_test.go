package server

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"testing"

	"koinote/backend/internal/config"
)

func TestOrganizationIncludesPreviouslyFiledDocuments(t *testing.T) {
	for _, kind := range []string{"root", "smart", "activity", "manual", "nested-smart"} {
		t.Run(kind, func(t *testing.T) {
			a, db, user, doc := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-scope"})
			ctx := context.Background()
			var folderID *int
			if kind != "root" {
				folder, _ := randomUUID()
				var id int
				var organizer any
				if kind == "smart" || kind == "activity" {
					organizer = kind
				} else if kind == "nested-smart" {
					organizer = "smart"
				}
				if err := db.QueryRow(ctx, `INSERT INTO folders(folder_id,user_id,name,organizer_kind) VALUES($1,$2,$3,$4) RETURNING id`, folder, user.ID, kind, organizer).Scan(&id); err != nil {
					t.Fatal(err)
				}
				if kind == "nested-smart" {
					folder, _ = randomUUID()
					if err := db.QueryRow(ctx, `INSERT INTO folders(folder_id,user_id,name,organizer_kind,parent_id) VALUES($1,$2,'Week','smart',$3) RETURNING id`, folder, user.ID, id).Scan(&id); err != nil {
						t.Fatal(err)
					}
				}
				folderID = &id
			}
			if _, err := db.Exec(ctx, `UPDATE documents SET folder_id=$2 WHERE doc_id=$1`, doc.DocID, folderID); err != nil {
				t.Fatal(err)
			}
			for _, aiApplied := range []bool{false, true} {
				if _, err := db.Exec(ctx, `UPDATE documents SET organized_at=CASE WHEN $2 THEN now() ELSE NULL END WHERE doc_id=$1`, doc.DocID, aiApplied); err != nil {
					t.Fatal(err)
				}
				for _, include := range []bool{false, true} {
					want := 1
					if aiApplied && !include {
						want = 0
					}
					data, _, err := a.prepareOrganization(ctx, user.ID, include, nil)
					if err != nil || len(data.Items) != want || data.Skipped != 1-want {
						t.Fatalf("applied=%v include=%v count=%d skipped=%d want=%d err=%v", aiApplied, include, len(data.Items), data.Skipped, want, err)
					}
					response := organizationTestRequest(t, a, user, "POST", "/api/document-organizations/estimate", fmt.Sprintf(`{"includeOrganized":%t}`, include))
					var estimate struct{ Count int }
					if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &estimate) != nil || estimate.Count != want {
						t.Fatalf("estimate status=%d body=%s", response.Code, response.Body.String())
					}
				}
			}
		})
	}
}

func TestOrganizationAutomaticFoldersAreNotTopicExamples(t *testing.T) {
	a, db, user, rootDoc := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-provenance"})
	ctx := context.Background()
	docByKind := map[string]string{}
	folderByKind := map[string]string{}
	for _, kind := range []string{"smart", "activity", "manual"} {
		folder, _ := randomUUID()
		var internalID int
		// A manual folder can have the exact same date-like name as an auto one.
		if err := db.QueryRow(ctx, `INSERT INTO folders(folder_id,user_id,name,organizer_kind) VALUES($1,$2,'2026-10',NULLIF($3,'manual')) RETURNING id`, folder, user.ID, kind).Scan(&internalID); err != nil {
			t.Fatal(err)
		}
		doc, err := a.createDocument(ctx, createDocumentParams{User: user, Title: kind, Content: "PostgreSQL query performance"})
		if err != nil {
			t.Fatal(err)
		}
		// Previously accepted AI suggestions in date buckets must not reinforce
		// the same date-based classification when explicitly reconsidered.
		if _, err := db.Exec(ctx, `UPDATE documents SET folder_id=$2,organized_at=now() WHERE doc_id=$1`, doc.DocID, internalID); err != nil {
			t.Fatal(err)
		}
		docByKind[kind], folderByKind[kind] = doc.DocID, folder
	}
	data, prompts, err := a.prepareOrganization(ctx, user.ID, true, nil)
	if err != nil || len(data.Items) != 4 || len(prompts) != 1 {
		t.Fatalf("prepare: items=%d prompts=%d err=%v", len(data.Items), len(prompts), err)
	}
	var input struct {
		Documents         []organizationDocument
		ConfirmedExamples []organizationDocument
		Folders           []struct {
			FolderID, OrganizerKind string
		}
	}
	if err := json.Unmarshal([]byte(prompts[0].User), &input); err != nil {
		t.Fatal(err)
	}
	if len(input.Documents) != 4 || !slices.ContainsFunc(input.Documents, func(d organizationDocument) bool { return d.DocID == rootDoc.DocID }) {
		t.Fatal("previous filing must not exclude documents from analysis")
	}
	if len(input.ConfirmedExamples) != 1 || input.ConfirmedExamples[0].DocID != docByKind["manual"] {
		t.Fatalf("automatic filing treated as confirmed classification: %+v", input.ConfirmedExamples)
	}
	for _, kind := range []string{"smart", "activity", "manual"} {
		i := slices.IndexFunc(input.Folders, func(f struct{ FolderID, OrganizerKind string }) bool { return f.FolderID == folderByKind[kind] })
		if kind == "smart" {
			// A generated date bucket is obsolete and never a destination.
			if i >= 0 {
				t.Fatalf("obsolete date bucket offered as a destination: %+v", input.Folders)
			}
		} else {
			// "2026-10" is not a recency label, so this activity folder counts
			// as renamed by the user and keeps its provenance marker.
			want := kind
			if kind == "manual" {
				want = ""
			}
			if i < 0 || input.Folders[i].OrganizerKind != want {
				t.Fatalf("missing folder provenance for %s: %+v", kind, input.Folders)
			}
		}
		if !slices.ContainsFunc(input.Documents, func(d organizationDocument) bool { return d.DocID == docByKind[kind] }) {
			t.Fatalf("missing candidate %s", kind)
		}
	}
	// Provenance changes model context only; moving out of a smart folder and
	// undoing it must still work with the existing folder snapshot format.
	choice := organizationChoice{DocID: docByKind["smart"], NewFolders: []string{"Databases"}, Tags: []string{"PostgreSQL"}}
	for i := range data.Items {
		if data.Items[i].DocID == choice.DocID {
			data.Items[i].Suggested = &choice
		}
	}
	id := organizationTestReady(t, a, user.ID, data)
	if err := a.applyOrganization(ctx, user.ID, id, []organizationChoice{choice}, nil, false); err != nil {
		t.Fatal(err)
	}
	var name string
	if err := db.QueryRow(ctx, `SELECT f.name FROM documents d JOIN folders f ON f.id=d.folder_id WHERE d.doc_id=$1`, choice.DocID).Scan(&name); err != nil || name != "Databases" {
		t.Fatalf("automatic folder move: name=%s err=%v", name, err)
	}
	if err := a.applyOrganization(ctx, user.ID, id, nil, nil, true); err != nil {
		t.Fatal(err)
	}
	var restored string
	if err := db.QueryRow(ctx, `SELECT f.folder_id FROM documents d JOIN folders f ON f.id=d.folder_id WHERE d.doc_id=$1`, choice.DocID).Scan(&restored); err != nil || restored != folderByKind["smart"] {
		t.Fatalf("undo automatic folder move: folder=%s err=%v", restored, err)
	}
}
