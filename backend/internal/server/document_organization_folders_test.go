package server

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"koinote/backend/internal/config"
)

func TestOrganizationCalendarLabels(t *testing.T) {
	for _, name := range []string{"2026年8月", "2026-08", "第 2 周", "第 5 週", "Week 3", "Semaine 4", "August 2026", "août 2026", "Sep 14", "14 sept.", "8月14日", "日期未知", "Unknown date", "日付不明", "Date inconnue"} {
		if !organizationCalendarName.MatchString(name) {
			t.Errorf("missing calendar label %q", name)
		}
	}
	for _, name := range []string{"Research", "2026年8月项目复盘", "Week 2 notes", "SQL", "2026 planning"} {
		if organizationCalendarName.MatchString(name) {
			t.Errorf("topic classified as a calendar label %q", name)
		}
	}
}

func organizationTestFolder(t *testing.T, db *pgxpool.Pool, userID int, name, parent, kind string) string {
	t.Helper()
	id, err := randomUUID()
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(context.Background(), `INSERT INTO folders(folder_id,user_id,name,parent_id,organizer_kind)
        VALUES($1,$2,$3,(SELECT id FROM folders WHERE user_id=$2 AND folder_id=$4),NULLIF($5,''))`, id, userID, name, parent, kind)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestOrganizationTimeFolderCleanupAndUndo(t *testing.T) {
	a, db, user, doc := newAgentReviewCreateTest(t, config.Config{SessionSecret: "time-folder-cleanup"})
	ctx := context.Background()
	month := organizationTestFolder(t, db, user.ID, "2026年8月", "", "smart")
	week := organizationTestFolder(t, db, user.ID, "第 2 周", month, "smart")
	emptyWeek := organizationTestFolder(t, db, user.ID, "第 3 周", month, "smart")
	manual := organizationTestFolder(t, db, user.ID, "2026年8月", "", "")
	repurposed := organizationTestFolder(t, db, user.ID, "Research", "", "smart")
	if _, err := db.Exec(ctx, `UPDATE documents SET folder_id=(SELECT id FROM folders WHERE folder_id=$2),tags=ARRAY['Original'] WHERE doc_id=$1`, doc.DocID, week); err != nil {
		t.Fatal(err)
	}
	data, _, err := a.prepareOrganization(ctx, user.ID, false, nil)
	if err != nil || len(data.TimeFolders) != 3 {
		t.Fatalf("time folders: %+v %v", data.TimeFolders, err)
	}
	original := append([]organizationTimeFolder{}, data.TimeFolders...)
	choice := organizationChoice{DocID: doc.DocID, NewFolders: []string{"Research"}, Tags: []string{"AI"}}
	data.Items[0].Suggested = &choice
	// Old paid previews also gain cleanup metadata without regenerating them.
	data.TimeFolders = nil
	id := organizationTestReady(t, a, user.ID, data)
	view, err := a.loadOrganization(ctx, user.ID, id)
	if err != nil || len(view.Data.TimeFolders) != 3 {
		t.Fatalf("legacy preview: %+v %v", view, err)
	}
	orders := []organizationOrder{{NewFolders: []string{"Research"}, DocIDs: []string{doc.DocID}}}
	for i := 0; i < 2; i++ {
		if err := a.applyOrganization(ctx, user.ID, id, []organizationChoice{choice}, orders, false); err != nil {
			t.Fatal("apply", err)
		}
	}
	var count int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM folders WHERE folder_id=ANY($1::text[])`, []string{month, week, emptyWeek}).Scan(&count); err != nil || count != 0 {
		t.Fatalf("calendar branches remain: %d %v", count, err)
	}
	if err := db.QueryRow(ctx, `SELECT count(*) FROM folders WHERE folder_id=ANY($1::text[])`, []string{manual, repurposed}).Scan(&count); err != nil || count != 2 {
		t.Fatalf("manual/topic folders removed: %d %v", count, err)
	}
	view, err = a.loadOrganization(ctx, user.ID, id)
	if err != nil || len(view.Data.RemovedFolders) != 3 {
		t.Fatalf("undo snapshot: %+v %v", view, err)
	}
	for i := 0; i < 2; i++ {
		if err := a.applyOrganization(ctx, user.ID, id, nil, nil, true); err != nil {
			t.Fatal("undo", err)
		}
	}
	var location string
	var tags []string
	if err := db.QueryRow(ctx, `SELECT f.folder_id,d.tags FROM documents d JOIN folders f ON f.id=d.folder_id WHERE d.doc_id=$1`, doc.DocID).Scan(&location, &tags); err != nil || location != week || len(tags) != 1 || tags[0] != "Original" {
		t.Fatalf("document not restored: %s %v %v", location, tags, err)
	}
	restored, err := loadOrganizationTimeFolders(ctx, db, user.ID, data.Folders)
	if err != nil {
		t.Fatal(err)
	}
	before, _ := json.Marshal(original)
	after, _ := json.Marshal(restored)
	if string(before) != string(after) {
		t.Fatalf("folder identity/timestamps not restored:\n%s\n%s", before, after)
	}
}

func TestOrganizationTimeFolderCleanupPreservesOccupiedAndEditedFolders(t *testing.T) {
	for _, scenario := range []string{"unchecked", "skipped", "excluded", "trash", "new-document", "manual-child", "renamed"} {
		t.Run(scenario, func(t *testing.T) {
			a, db, user, doc := newAgentReviewCreateTest(t, config.Config{SessionSecret: "time-folder-preserve"})
			ctx := context.Background()
			month := organizationTestFolder(t, db, user.ID, "2026年8月", "", "smart")
			week := organizationTestFolder(t, db, user.ID, "第 2 周", month, "smart")
			if _, err := db.Exec(ctx, `UPDATE documents SET folder_id=(SELECT id FROM folders WHERE folder_id=$2) WHERE doc_id=$1`, doc.DocID, week); err != nil {
				t.Fatal(err)
			}
			var exclude []string
			var otherID string
			addDocument := func() {
				other, err := a.createDocument(ctx, createDocumentParams{User: user, Title: "Retained", Content: "Untouched"})
				if err != nil {
					t.Fatal(err)
				}
				otherID = other.DocID
				if _, err := db.Exec(ctx, `UPDATE documents SET folder_id=(SELECT id FROM folders WHERE folder_id=$2),organized_at=CASE WHEN $3='skipped' THEN now() END,trashed_at=CASE WHEN $3='trash' THEN now() END WHERE doc_id=$1`, otherID, week, scenario); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "unchecked" || scenario == "skipped" || scenario == "excluded" || scenario == "trash" {
				addDocument()
			}
			if scenario == "excluded" {
				exclude = []string{otherID}
			}
			if scenario == "manual-child" {
				organizationTestFolder(t, db, user.ID, "Notes", week, "")
			}
			data, _, err := a.prepareOrganization(ctx, user.ID, false, exclude)
			if err != nil {
				t.Fatal(err)
			}
			choice := organizationChoice{DocID: doc.DocID, NewFolders: []string{"Topics"}, Tags: []string{}}
			for i := range data.Items {
				if data.Items[i].DocID == doc.DocID {
					data.Items[i].Suggested = &choice
				}
			}
			if scenario == "new-document" {
				addDocument()
			}
			if scenario == "renamed" {
				// A now-empty sibling renamed after preview must be preserved too.
				empty := organizationTestFolder(t, db, user.ID, "第 3 周", month, "smart")
				data.Folders = append(data.Folders, organizationFolder{empty, "第 3 周", month})
				if _, err := db.Exec(ctx, `UPDATE folders SET name='Reference' WHERE folder_id=$1`, empty); err != nil {
					t.Fatal(err)
				}
			}
			id := organizationTestReady(t, a, user.ID, data)
			if err := a.applyOrganization(ctx, user.ID, id, []organizationChoice{choice}, nil, false); err != nil {
				t.Fatal(err)
			}
			var count int
			if err := db.QueryRow(ctx, `SELECT count(*) FROM folders WHERE folder_id=$1`, month).Scan(&count); err != nil || count != 1 {
				t.Fatalf("retained ancestor removed: %d %v", count, err)
			}
			if otherID != "" {
				var location string
				if err := db.QueryRow(ctx, `SELECT f.folder_id FROM documents d JOIN folders f ON f.id=d.folder_id WHERE doc_id=$1`, otherID).Scan(&location); err != nil || location != week {
					t.Fatalf("unselected document changed: %s %v", location, err)
				}
			}
		})
	}
}

func TestOrganizationTimeFolderUndoPreservesChangedAncestor(t *testing.T) {
	a, db, user, doc := newAgentReviewCreateTest(t, config.Config{SessionSecret: "time-folder-undo"})
	ctx := context.Background()
	parent := organizationTestFolder(t, db, user.ID, "Original", "", "")
	month := organizationTestFolder(t, db, user.ID, "2026年8月", parent, "smart")
	if _, err := db.Exec(ctx, `UPDATE documents SET folder_id=(SELECT id FROM folders WHERE folder_id=$2) WHERE doc_id=$1`, doc.DocID, month); err != nil {
		t.Fatal(err)
	}
	// Keep the manual ancestor occupied so apply does not remove it; the user
	// deletes it afterwards, which undo must respect.
	keeper, err := a.createDocument(ctx, createDocumentParams{User: user, Title: "Keeper", Content: "Stays"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `UPDATE documents SET folder_id=(SELECT id FROM folders WHERE folder_id=$2),organized_at=now() WHERE doc_id=$1`, keeper.DocID, parent); err != nil {
		t.Fatal(err)
	}
	data, _, err := a.prepareOrganization(ctx, user.ID, false, nil)
	if err != nil || len(data.Items) != 1 {
		t.Fatalf("prepare: %+v %v", data.Items, err)
	}
	choice := organizationChoice{DocID: doc.DocID, NewFolders: []string{"Topics"}, Tags: []string{}}
	data.Items[0].Suggested = &choice
	id := organizationTestReady(t, a, user.ID, data)
	if err := a.applyOrganization(ctx, user.ID, id, []organizationChoice{choice}, nil, false); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `DELETE FROM folders WHERE folder_id=$1`, parent); err != nil {
		t.Fatal(err)
	}
	if err := a.applyOrganization(ctx, user.ID, id, nil, nil, true); err != nil {
		t.Fatal(err)
	}
	view, err := a.loadOrganization(ctx, user.ID, id)
	if err != nil || !view.Data.Items[0].UndoSkipped {
		t.Fatalf("missing manual ancestor was recreated: %+v %v", view, err)
	}
	var count int
	if err := db.QueryRow(ctx, `SELECT count(*) FROM folders WHERE folder_id=ANY($1::text[])`, []string{parent, month}).Scan(&count); err != nil || count != 0 {
		t.Fatalf("deleted ancestor reappeared: %d %v", count, err)
	}
}
