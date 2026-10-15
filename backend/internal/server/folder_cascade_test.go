package server

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"koinote/backend/internal/config"
)

func TestFolderDeleteCascadeTrashesSubtree(t *testing.T) {
	for _, route := range []string{"single", "batch"} {
		t.Run(route, func(t *testing.T) {
			a, db, user, doc := newAgentReviewCreateTest(t, config.Config{SessionSecret: "folder-cascade"})
			ctx := context.Background()
			outer := organizationTestFolder(t, db, user.ID, "Outer", "", "")
			parent := organizationTestFolder(t, db, user.ID, "Parent", outer, "")
			child := organizationTestFolder(t, db, user.ID, "Child", parent, "")
			grandchild := organizationTestFolder(t, db, user.ID, "Grandchild", child, "")
			sibling := organizationTestFolder(t, db, user.ID, "Sibling", "", "")
			nested, err := a.createDocument(ctx, createDocumentParams{User: user, Title: "Nested", Content: "Nested"})
			if err != nil {
				t.Fatal(err)
			}
			kept, err := a.createDocument(ctx, createDocumentParams{User: user, Title: "Kept", Content: "Kept"})
			if err != nil {
				t.Fatal(err)
			}
			for docID, folder := range map[string]string{doc.DocID: parent, nested.DocID: grandchild, kept.DocID: sibling} {
				if _, err := db.Exec(ctx, `UPDATE documents SET folder_id=(SELECT id FROM folders WHERE folder_id=$2) WHERE doc_id=$1`, docID, folder); err != nil {
					t.Fatal(err)
				}
			}
			var response int
			if route == "single" {
				response = organizationTestRequest(t, a, user, http.MethodDelete, "/api/folders/"+parent+"?cascade=1", "").Code
			} else {
				// A selected descendant of a selected folder is already gone.
				body, _ := json.Marshal(map[string]any{"cascade": true, "items": []map[string]string{{"kind": "folder", "id": parent}, {"kind": "folder", "id": child}}})
				response = organizationTestRequest(t, a, user, http.MethodPost, "/api/tree/delete", string(body)).Code
			}
			if response != http.StatusOK {
				t.Fatalf("delete status %d", response)
			}
			var folders int
			if err := db.QueryRow(ctx, `SELECT count(*) FROM folders WHERE user_id=$1`, user.ID).Scan(&folders); err != nil || folders != 2 {
				t.Fatalf("subtree must be deleted with its parent: %d %v", folders, err)
			}
			var trashed int
			if err := db.QueryRow(ctx, `SELECT count(*) FROM documents d JOIN folders f ON f.id=d.folder_id
                WHERE d.user_id=$1 AND d.trashed_at IS NOT NULL AND f.folder_id=$3 AND d.doc_id=ANY($2::text[])`, user.ID, []string{doc.DocID, nested.DocID}, outer).Scan(&trashed); err != nil || trashed != 2 {
				t.Fatalf("subtree documents must be trashed under the deleted folder's parent: %d %v", trashed, err)
			}
			var keptTrashed bool
			if err := db.QueryRow(ctx, `SELECT trashed_at IS NOT NULL FROM documents WHERE doc_id=$1`, kept.DocID).Scan(&keptTrashed); err != nil || keptTrashed {
				t.Fatalf("unrelated document trashed: %v %v", keptTrashed, err)
			}
		})
	}
}

// Older desktop clients lift children locally before pushing the delete, so a
// delete without cascade must keep lifting instead of trashing documents.
func TestFolderDeleteWithoutCascadeLiftsChildren(t *testing.T) {
	a, db, user, doc := newAgentReviewCreateTest(t, config.Config{SessionSecret: "folder-lift"})
	ctx := context.Background()
	parent := organizationTestFolder(t, db, user.ID, "Parent", "", "")
	child := organizationTestFolder(t, db, user.ID, "Child", parent, "")
	if _, err := db.Exec(ctx, `UPDATE documents SET folder_id=(SELECT id FROM folders WHERE folder_id=$2) WHERE doc_id=$1`, doc.DocID, parent); err != nil {
		t.Fatal(err)
	}
	if code := organizationTestRequest(t, a, user, http.MethodDelete, "/api/folders/"+parent, "").Code; code != http.StatusOK {
		t.Fatalf("delete status %d", code)
	}
	var childParent *int
	var trashed bool
	if err := db.QueryRow(ctx, `SELECT parent_id FROM folders WHERE folder_id=$1`, child).Scan(&childParent); err != nil || childParent != nil {
		t.Fatalf("child must be lifted to root: %v %v", childParent, err)
	}
	if err := db.QueryRow(ctx, `SELECT trashed_at IS NOT NULL FROM documents WHERE doc_id=$1`, doc.DocID).Scan(&trashed); err != nil || trashed {
		t.Fatalf("legacy delete must not trash documents: %v %v", trashed, err)
	}
}
