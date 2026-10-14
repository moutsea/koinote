package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"testing"

	"github.com/jackc/pgx/v5"
	"koinote/backend/internal/config"
)

func TestOrganizationOrderMerge(t *testing.T) {
	selected := map[string]organizationChoice{"a": {}, "b": {}}
	got, err := mergeOrganizationOrder([]string{"outside", "a", "fixed", "b", "last"}, []string{"b", "fixed", "a"}, selected)
	if err != nil || !slices.Equal(got, []string{"outside", "b", "fixed", "last", "a"}) {
		t.Fatalf("merge=%v err=%v", got, err)
	}
	if _, err := mergeOrganizationOrder([]string{"fixed", "a", "last"}, []string{"last", "a", "fixed"}, selected); !errors.Is(err, errOrganizationInput) {
		t.Fatalf("unchecked anchors reordered: %v", err)
	}
}

func TestOrganizationOrderApplyUndo(t *testing.T) {
	for _, movingAll := range []bool{false, true} {
		t.Run(map[bool]string{false: "unchecked-anchors", true: "all-selected"}[movingAll], func(t *testing.T) {
			a, db, user, first := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-order"})
			ctx := context.Background()
			ids := []string{first.DocID}
			for _, title := range []string{"Second", "Third"} {
				doc, err := a.createDocument(ctx, createDocumentParams{User: user, Title: title, Content: title})
				if err != nil {
					t.Fatal(err)
				}
				ids = append(ids, doc.DocID)
			}
			for i, id := range ids {
				if _, err := db.Exec(ctx, `UPDATE documents SET sort_order=$2,updated_at='2000-01-01' WHERE doc_id=$1`, id, i); err != nil {
					t.Fatal(err)
				}
			}
			data, _, err := a.prepareOrganization(ctx, user.ID, false, nil)
			if err != nil {
				t.Fatal(err)
			}
			// Deliberately unrelated snapshot iteration order exercises ordered undo.
			slices.Reverse(data.Items)
			choices := []organizationChoice{}
			for i := range data.Items {
				item := &data.Items[i]
				choice := organizationChoice{DocID: item.DocID, Tags: []string{}, NewFolders: []string{}}
				item.Suggested = &choice
				if movingAll || item.DocID == ids[2] {
					choices = append(choices, choice)
				}
			}
			run := organizationTestReady(t, a, user.ID, data)
			order := []organizationOrder{{DocIDs: []string{ids[2], ids[0], ids[1]}, NewFolders: []string{}}}
			raw, _ := json.Marshal(map[string]any{"items": choices, "orders": order})
			response := organizationTestRequest(t, a, user, "POST", "/api/document-organizations/"+run+"/apply", string(raw))
			if response.Code != 200 {
				t.Fatalf("apply: %d %s", response.Code, response.Body.String())
			}
			readOrder := func() []string {
				rows, err := db.Query(ctx, `SELECT doc_id FROM documents WHERE user_id=$1 AND folder_id IS NULL AND trashed_at IS NULL ORDER BY sort_order,doc_id`, user.ID)
				if err != nil {
					t.Fatal(err)
				}
				got, err := pgx.CollectRows(rows, pgx.RowTo[string])
				if err != nil {
					t.Fatal(err)
				}
				return got
			}
			if got := readOrder(); !slices.Equal(got, order[0].DocIDs) {
				t.Fatalf("applied=%v", got)
			}
			if err := a.applyOrganization(ctx, user.ID, run, choices, order, false); err != nil {
				t.Fatal("retry", err)
			}
			changed := []organizationOrder{{DocIDs: ids, NewFolders: []string{}}}
			if err := a.applyOrganization(ctx, user.ID, run, choices, changed, false); !errors.Is(err, errOrganizationConflict) {
				t.Fatalf("changed retry=%v", err)
			}
			var updated bool
			if err := db.QueryRow(ctx, `SELECT updated_at='2000-01-01' AND sort_order=0 FROM documents WHERE doc_id=$1`, ids[2]).Scan(&updated); err != nil || !updated {
				t.Fatalf("sync metadata: %v %v", updated, err)
			}
			if err := a.applyOrganization(ctx, user.ID, run, nil, nil, true); err != nil {
				t.Fatal("undo", err)
			}
			if got := readOrder(); !slices.Equal(got, ids) {
				t.Fatalf("undo=%v want=%v", got, ids)
			}
			if err := db.QueryRow(ctx, `SELECT bool_and(updated_at='2000-01-01') FROM documents WHERE user_id=$1`, user.ID).Scan(&updated); err != nil || !updated {
				t.Fatalf("order-only undo changed timestamps: %v %v", updated, err)
			}
			if err := a.applyOrganization(ctx, user.ID, run, nil, nil, true); err != nil {
				t.Fatal("undo retry", err)
			}
		})
	}
}

func TestOrganizationOrderValidationAndConcurrentChanges(t *testing.T) {
	a, db, user, first := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-order-conflict"})
	ctx := context.Background()
	second, err := a.createDocument(ctx, createDocumentParams{User: user, Title: "Second", Content: "Second"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `UPDATE documents SET sort_order=CASE WHEN doc_id=$2 THEN 0 ELSE 1 END WHERE user_id=$1`, user.ID, first.DocID); err != nil {
		t.Fatal(err)
	}
	data, _, err := a.prepareOrganization(ctx, user.ID, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	for i := range data.Items {
		data.Items[i].Suggested = &organizationChoice{DocID: data.Items[i].DocID, NewFolders: []string{}, Tags: []string{}}
	}
	run := organizationTestReady(t, a, user.ID, data)
	choices := []organizationChoice{{DocID: second.DocID, NewFolders: []string{}, Tags: []string{}}}
	for _, order := range [][]organizationOrder{
		{{DocIDs: []string{"foreign-document", second.DocID}}},
		{{DocIDs: []string{second.DocID, second.DocID}}},
		{{NewFolders: []string{"Wrong"}, DocIDs: []string{second.DocID}}},
		{{DocIDs: []string{first.DocID}}},
	} {
		if err := a.applyOrganization(ctx, user.ID, run, choices, order, false); !errors.Is(err, errOrganizationInput) {
			t.Fatalf("invalid order accepted: %+v %v", order, err)
		}
		raw, _ := json.Marshal(map[string]any{"items": choices, "orders": order})
		response := organizationTestRequest(t, a, user, "POST", "/api/document-organizations/"+run+"/apply", string(raw))
		var body struct {
			Code string `json:"code"`
		}
		if json.Unmarshal(response.Body.Bytes(), &body) != nil || response.Code != 400 || body.Code != "invalid_organization" {
			t.Fatalf("malformed order must remain an HTTP input error: %d %s", response.Code, response.Body.String())
		}
	}
	if _, err := db.Exec(ctx, `UPDATE documents SET sort_order=9 WHERE doc_id=$1`, first.DocID); err != nil {
		t.Fatal(err)
	}
	order := []organizationOrder{{DocIDs: []string{second.DocID, first.DocID}}}
	if err := a.applyOrganization(ctx, user.ID, run, choices, order, false); err != nil {
		t.Fatalf("ordinal changes must not invalidate a single anchor: %v", err)
	}
}

func TestOrganizationOrderCrossFolderUndoAfterRenumbering(t *testing.T) {
	a, db, user, first := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-order-move"})
	ctx := context.Background()
	second, err := a.createDocument(ctx, createDocumentParams{User: user, Title: "Second", Content: "Second"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `UPDATE documents SET sort_order=CASE WHEN doc_id=$2 THEN 0 ELSE 1 END WHERE user_id=$1`, user.ID, first.DocID); err != nil {
		t.Fatal(err)
	}
	data, _, err := a.prepareOrganization(ctx, user.ID, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	choices := []organizationChoice{}
	for i := range data.Items {
		choice := organizationChoice{DocID: data.Items[i].DocID, NewFolders: []string{"New"}, Tags: []string{}}
		data.Items[i].Suggested = &choice
		choices = append(choices, choice)
	}
	run := organizationTestReady(t, a, user.ID, data)
	orders := []organizationOrder{{NewFolders: []string{"New"}, DocIDs: []string{second.DocID, first.DocID}}}
	if err := a.applyOrganization(ctx, user.ID, run, choices, orders, false); err != nil {
		t.Fatal(err)
	}
	var got []string
	if err := db.QueryRow(ctx, `SELECT array_agg(d.doc_id ORDER BY d.sort_order) FROM documents d JOIN folders f ON f.id=d.folder_id WHERE d.user_id=$1 AND f.name='New'`, user.ID).Scan(&got); err != nil || !slices.Equal(got, orders[0].DocIDs) {
		t.Fatalf("move order=%v %v", got, err)
	}
	if _, err := db.Exec(ctx, `UPDATE documents SET sort_order=8 WHERE doc_id=$1`, first.DocID); err != nil {
		t.Fatal(err)
	}
	if err := a.applyOrganization(ctx, user.ID, run, nil, nil, true); err != nil {
		t.Fatal(err)
	}
	view, err := a.loadOrganization(ctx, user.ID, run)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range view.Data.Items {
		if item.UndoSkipped {
			t.Fatalf("skip=%+v", item)
		}
	}
	var preserved bool
	if err := db.QueryRow(ctx, `SELECT folder_id IS NULL AND sort_order=0 FROM documents WHERE doc_id=$1`, first.DocID).Scan(&preserved); err != nil || !preserved {
		t.Fatalf("classification undo blocked by sort: %v %v", preserved, err)
	}
	if err := db.QueryRow(ctx, `SELECT folder_id IS NULL AND sort_order=1 FROM documents WHERE doc_id=$1`, second.DocID).Scan(&preserved); err != nil || !preserved {
		t.Fatalf("other undo lost: %v %v", preserved, err)
	}
}

func TestOrganizationOrderUndoAfterSidebarReorder(t *testing.T) {
	for _, moveFolder := range []bool{false, true} {
		for _, reverse := range []bool{false, true} {
			name := fmt.Sprintf("move-folder=%t/manual-order=%t", moveFolder, reverse)
			t.Run(name, func(t *testing.T) {
				a, db, user, first := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-sidebar-undo"})
				ctx := context.Background()
				ids := []string{first.DocID}
				for _, title := range []string{"Second", "Third"} {
					doc, err := a.createDocument(ctx, createDocumentParams{User: user, Title: title, Content: title})
					if err != nil {
						t.Fatal(err)
					}
					ids = append(ids, doc.DocID)
				}
				for i, id := range ids {
					if _, err := db.Exec(ctx, `UPDATE documents SET sort_order=$2 WHERE doc_id=$1`, id, i); err != nil {
						t.Fatal(err)
					}
				}
				data, _, err := a.prepareOrganization(ctx, user.ID, false, nil)
				if err != nil {
					t.Fatal(err)
				}
				choices := []organizationChoice{}
				for i := range data.Items {
					choice := organizationChoice{DocID: data.Items[i].DocID, Tags: []string{"AI"}, NewFolders: []string{}}
					if moveFolder {
						choice.NewFolders = []string{"New"}
					}
					data.Items[i].Suggested = &choice
					choices = append(choices, choice)
				}
				run := organizationTestReady(t, a, user.ID, data)
				applied := []string{ids[2], ids[0], ids[1]}
				orders := []organizationOrder{{NewFolders: choices[0].NewFolders, DocIDs: applied}}
				if err := a.applyOrganization(ctx, user.ID, run, choices, orders, false); err != nil {
					t.Fatal(err)
				}
				var folder string
				if err := db.QueryRow(ctx, `SELECT COALESCE(f.folder_id,'') FROM documents d LEFT JOIN folders f ON f.id=d.folder_id WHERE d.doc_id=$1`, first.DocID).Scan(&folder); err != nil {
					t.Fatal(err)
				}
				added, err := a.createDocument(ctx, createDocumentParams{User: user, Title: "Unrelated new article", Content: "new"})
				if err != nil {
					t.Fatal(err)
				}
				if _, err := db.Exec(ctx, `UPDATE documents SET folder_id=(SELECT id FROM folders WHERE user_id=$1 AND folder_id=$3),updated_at='2000-01-01' WHERE user_id=$1 AND doc_id=$2`, user.ID, added.DocID, folder); err != nil {
					t.Fatal(err)
				}
				manual := slices.Clone(applied)
				if reverse {
					slices.Reverse(manual)
				}
				manual = append([]string{added.DocID}, manual...)
				raw, _ := json.Marshal(map[string]any{"folderId": folder, "docIds": manual})
				response := organizationTestRequest(t, a, user, "PUT", "/api/documents/"+first.DocID+"/order", string(raw))
				if response.Code != 200 {
					t.Fatalf("sidebar reorder: %d %s", response.Code, response.Body.String())
				}
				if err := a.applyOrganization(ctx, user.ID, run, nil, nil, true); err != nil {
					t.Fatal(err)
				}
				view, err := a.loadOrganization(ctx, user.ID, run)
				if err != nil {
					t.Fatal(err)
				}
				for _, item := range view.Data.Items {
					if item.UndoSkipped {
						t.Fatalf("sorting skipped classification undo: %+v", item)
					}
					var restored bool
					if err := db.QueryRow(ctx, `SELECT folder_id IS NULL AND cardinality(tags)=0 AND organized_at IS NULL FROM documents WHERE doc_id=$1`, item.DocID).Scan(&restored); err != nil || !restored {
						t.Fatalf("classification not restored: %s %v", item.DocID, err)
					}
				}
				var unchanged bool
				if err := db.QueryRow(ctx, `SELECT updated_at='2000-01-01' FROM documents WHERE doc_id=$1`, added.DocID).Scan(&unchanged); err != nil || !unchanged {
					t.Fatalf("undo changed unrelated activity: %v %v", unchanged, err)
				}
				if !moveFolder {
					want := append([]string{added.DocID}, ids...)
					if reverse {
						want = manual
					}
					var got []string
					if err := db.QueryRow(ctx, `SELECT array_agg(doc_id ORDER BY sort_order,doc_id) FROM documents WHERE user_id=$1 AND folder_id IS NULL`, user.ID).Scan(&got); err != nil || !slices.Equal(got, want) {
						t.Fatalf("order=%v want=%v err=%v", got, want, err)
					}
				}
			})
		}
	}
}

func TestOrganizationOrderApplyAfterSidebarReorder(t *testing.T) {
	for _, selectedAll := range []bool{false, true} {
		for _, reverseAnchors := range []bool{false, true} {
			t.Run(fmt.Sprintf("selected-all=%t/reversed=%t", selectedAll, reverseAnchors), func(t *testing.T) {
				a, db, user, first := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-sidebar-apply"})
				ctx := context.Background()
				ids := []string{first.DocID}
				for _, title := range []string{"Second", "Third"} {
					doc, err := a.createDocument(ctx, createDocumentParams{User: user, Title: title, Content: title})
					if err != nil {
						t.Fatal(err)
					}
					ids = append(ids, doc.DocID)
				}
				for i, id := range ids {
					if _, err := db.Exec(ctx, `UPDATE documents SET sort_order=$2,updated_at='2000-01-01' WHERE doc_id=$1`, id, i); err != nil {
						t.Fatal(err)
					}
				}
				data, _, err := a.prepareOrganization(ctx, user.ID, false, nil)
				if err != nil {
					t.Fatal(err)
				}
				choices := []organizationChoice{}
				for i := range data.Items {
					choice := organizationChoice{DocID: data.Items[i].DocID, Tags: []string{}, NewFolders: []string{}}
					if selectedAll {
						choice.NewFolders = []string{"New"}
					}
					data.Items[i].Suggested = &choice
					if selectedAll || choice.DocID == ids[2] {
						choices = append(choices, choice)
					}
				}
				run := organizationTestReady(t, a, user.ID, data)
				manual := []string{ids[2], ids[0], ids[1]}
				if reverseAnchors {
					manual = []string{ids[2], ids[1], ids[0]}
				}
				raw, _ := json.Marshal(map[string]any{"docIds": manual})
				response := organizationTestRequest(t, a, user, "PUT", "/api/documents/"+first.DocID+"/order", string(raw))
				if response.Code != 200 {
					t.Fatalf("sidebar: %d %s", response.Code, response.Body.String())
				}
				order := []organizationOrder{{NewFolders: choices[0].NewFolders, DocIDs: []string{ids[2], ids[0], ids[1]}}}
				err = a.applyOrganization(ctx, user.ID, run, choices, order, false)
				if !selectedAll && reverseAnchors {
					if !errors.Is(err, errOrganizationConflict) {
						t.Fatalf("changed anchor order accepted: %v", err)
					}
					raw, _ := json.Marshal(map[string]any{"items": choices, "orders": order})
					response := organizationTestRequest(t, a, user, "POST", "/api/document-organizations/"+run+"/apply", string(raw))
					var body struct {
						Code string `json:"code"`
					}
					if json.Unmarshal(response.Body.Bytes(), &body) != nil || response.Code != 409 || body.Code != "organization_conflict" {
						t.Fatalf("stale order must be an HTTP conflict: %d %s", response.Code, response.Body.String())
					}
					var untouched bool
					if err := db.QueryRow(ctx, `SELECT bool_and(organized_at IS NULL) FROM documents WHERE user_id=$1`, user.ID).Scan(&untouched); err != nil || !untouched {
						t.Fatalf("partial writes: %v %v", untouched, err)
					}
				} else if err != nil {
					t.Fatalf("source sorting must not invalidate preview: %v", err)
				}
			})
		}
	}
}

func TestOrganizationOrderRelativePosition(t *testing.T) {
	for _, test := range []struct {
		current   []string
		unchanged []string
	}{
		{[]string{"new", "a", "b", "c"}, []string{"a", "b", "c"}},
		{[]string{"a", "c"}, []string{"a", "c"}},
		{[]string{"b", "a", "c"}, []string{"c"}},
		{[]string{"c", "b", "a"}, []string{}},
	} {
		got := unchangedOrganizationPositions([]string{"a", "b", "c"}, test.current)
		for _, id := range []string{"a", "b", "c"} {
			if got[id] != slices.Contains(test.unchanged, id) {
				t.Fatalf("current=%v unchanged=%v", test.current, got)
			}
		}
	}
}

func TestOrganizationOrderPurgeUnseenSnapshotSibling(t *testing.T) {
	a, db, user, first := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-order-purge"})
	ctx := context.Background()
	outside, err := a.createDocument(ctx, createDocumentParams{User: user, Title: "Outside preview", Content: "Private"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(ctx, `UPDATE documents SET updated_at='2000-01-01' WHERE user_id=$1`, user.ID); err != nil {
		t.Fatal(err)
	}
	data, _, err := a.prepareOrganization(ctx, user.ID, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	data.Items = slices.DeleteFunc(data.Items, func(item organizationItem) bool { return item.DocID == outside.DocID })
	data.InputDocumentIDs = []string{first.DocID}
	choice := organizationChoice{DocID: first.DocID, Tags: []string{}, NewFolders: []string{}}
	data.Items[0].Suggested = &choice
	run := organizationTestReady(t, a, user.ID, data)
	if err := a.applyOrganization(ctx, user.ID, run, []organizationChoice{choice}, []organizationOrder{{DocIDs: []string{first.DocID}}}, false); err != nil {
		t.Fatal(err)
	}
	var untouched bool
	if err := db.QueryRow(ctx, `SELECT bool_and(updated_at='2000-01-01') FROM documents WHERE user_id=$1`, user.ID).Scan(&untouched); err != nil || !untouched {
		t.Fatalf("order changed activity of unrelated sibling: %v %v", untouched, err)
	}
	view, err := a.loadOrganization(ctx, user.ID, run)
	if err != nil {
		t.Fatal(err)
	}
	if len(view.Data.OriginalOrders) != 1 || !slices.Contains(view.Data.OriginalOrders[0].DocIDs, outside.DocID) {
		t.Fatal("missing unseen sibling snapshot")
	}
	if _, err := a.trashDocument(ctx, user, outside.DocID, 0); err != nil {
		t.Fatal(err)
	}
	if err := a.purgeDocument(ctx, userRef{ID: user.ID, AuthUserID: user.AuthUserID}, outside.DocID, outside.Title, true, false); err != nil {
		t.Fatal(err)
	}
	view, err = a.loadOrganization(ctx, user.ID, run)
	if err != nil {
		t.Fatal(err)
	}
	for _, snapshots := range [][]organizationFolderOrder{view.Data.OriginalOrders, view.Data.ResultOrders} {
		for _, snapshot := range snapshots {
			if slices.Contains(snapshot.DocIDs, outside.DocID) {
				t.Fatalf("purged id left in snapshot: %+v", snapshot)
			}
		}
	}
	if err := a.applyOrganization(ctx, user.ID, run, nil, nil, true); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(ctx, `SELECT updated_at='2000-01-01' FROM documents WHERE doc_id=$1`, first.DocID).Scan(&untouched); err != nil || !untouched {
		t.Fatalf("order undo changed activity: %v %v", untouched, err)
	}
}

func TestOrganizationOrderUndoWithChangedOriginalAnchors(t *testing.T) {
	a, db, user, first := newAgentReviewCreateTest(t, config.Config{SessionSecret: "organization-undo-anchor-conflict"})
	ctx := context.Background()
	ids := []string{first.DocID}
	for _, title := range []string{"Second anchor", "Selected document"} {
		doc, err := a.createDocument(ctx, createDocumentParams{User: user, Title: title, Content: title})
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, doc.DocID)
	}
	for i, id := range ids {
		if _, err := db.Exec(ctx, `UPDATE documents SET sort_order=$2 WHERE doc_id=$1`, id, i); err != nil {
			t.Fatal(err)
		}
	}
	data, _, err := a.prepareOrganization(ctx, user.ID, false, nil)
	if err != nil {
		t.Fatal(err)
	}
	choice := organizationChoice{DocID: ids[2], NewFolders: []string{"New"}, Tags: []string{"AI"}}
	for i := range data.Items {
		if data.Items[i].DocID == choice.DocID {
			data.Items[i].Suggested = &choice
		}
	}
	run := organizationTestReady(t, a, user.ID, data)
	orders := []organizationOrder{{NewFolders: []string{"New"}, DocIDs: []string{choice.DocID}}}
	if err := a.applyOrganization(ctx, user.ID, run, []organizationChoice{choice}, orders, false); err != nil {
		t.Fatal(err)
	}
	// The document in New has not moved, but its two original anchors have
	// swapped places. Undo must keep that manual order and restore classification.
	raw, _ := json.Marshal(map[string]any{"docIds": []string{ids[1], ids[0]}})
	response := organizationTestRequest(t, a, user, "PUT", "/api/documents/"+first.DocID+"/order", string(raw))
	if response.Code != 200 {
		t.Fatalf("sidebar: %d %s", response.Code, response.Body.String())
	}
	response = organizationTestRequest(t, a, user, "POST", "/api/document-organizations/"+run+"/undo", "")
	if response.Code != 200 {
		t.Fatalf("undo must tolerate changed anchors: %d %s", response.Code, response.Body.String())
	}
	var got []string
	if err := db.QueryRow(ctx, `SELECT array_agg(doc_id ORDER BY sort_order,doc_id) FROM documents WHERE user_id=$1 AND folder_id IS NULL`, user.ID).Scan(&got); err != nil || !slices.Equal(got, []string{ids[1], ids[0], ids[2]}) {
		t.Fatalf("undo overwrote manual order: %v %v", got, err)
	}
	var restored bool
	if err := db.QueryRow(ctx, `SELECT folder_id IS NULL AND cardinality(tags)=0 AND organized_at IS NULL FROM documents WHERE doc_id=$1`, choice.DocID).Scan(&restored); err != nil || !restored {
		t.Fatalf("classification undo skipped: %v %v", restored, err)
	}
	view, err := a.loadOrganization(ctx, user.ID, run)
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range view.Data.Items {
		if item.UndoSkipped {
			t.Fatalf("anchor reorder skipped item: %+v", item)
		}
	}
}
