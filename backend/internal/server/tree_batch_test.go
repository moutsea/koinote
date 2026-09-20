package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"koinote/backend/internal/config"
)

func TestNormalizeTreeBatchItems(t *testing.T) {
	items, err := normalizeTreeBatchItems([]treeBatchItem{
		{Kind: " doc ", ID: " one "},
		{Kind: "doc", ID: "one"},
		{Kind: "folder", ID: "folder"},
	})
	if err != nil {
		t.Fatalf("normalize failed: %v", err)
	}
	if len(items) != 2 || items[0].Kind != "doc" || items[0].ID != "one" {
		t.Fatalf("normalized items = %#v", items)
	}

	tooMany := make([]treeBatchItem, maxTreeBatchItems+1)
	for index := range tooMany {
		tooMany[index] = treeBatchItem{Kind: "doc", ID: fmt.Sprintf("doc-%d", index)}
	}
	if _, err := normalizeTreeBatchItems(tooMany); err == nil || err.Error() != "too_many_items" {
		t.Fatalf("too many items error = %v", err)
	}
}

func TestFolderSubtreeHeight(t *testing.T) {
	root, child, grandchild := 1, 2, 3
	children := folderChildren(map[int]*int{
		root:       nil,
		child:      &root,
		grandchild: &child,
	})
	if got := folderSubtreeHeight(children, root); got != 2 {
		t.Fatalf("subtree height = %d, want 2", got)
	}
}

func TestTreeBatchDeleteGuardsRevisionAndQueuesImages(t *testing.T) {
	pool := newGCTestPool(t)
	authUserID := "tree-batch-" + itoa64(time.Now().UnixNano())
	key := gcKey(authUserID, "cccccccc33333333")
	user, docID := seedGCUser(t, pool, authUserID, "![image](/images/"+key+")")
	app := New(config.Config{SessionSecret: "tree-batch-secret"}, pool)
	cookie := sessionCookieFor(t, app, authUserID, 1)

	var revision int64
	if err := pool.QueryRow(context.Background(),
		`SELECT revision FROM documents WHERE doc_id = $1`, docID).Scan(&revision); err != nil {
		t.Fatalf("load revision: %v", err)
	}

	call := func(expectedRevision int64) *httptest.ResponseRecorder {
		body, err := json.Marshal(map[string]any{
			"items": []map[string]any{{"kind": "doc", "id": docID, "revision": expectedRevision}},
		})
		if err != nil {
			t.Fatal(err)
		}
		req := httptest.NewRequest(http.MethodPost, "/api/tree/delete", strings.NewReader(string(body)))
		req.Header.Set("Content-Type", "application/json")
		req.AddCookie(cookie)
		rec := httptest.NewRecorder()
		app.Routes().ServeHTTP(rec, req)
		return rec
	}

	if rec := call(revision + 1); rec.Code != http.StatusConflict {
		t.Fatalf("stale batch delete status = %d, body = %s", rec.Code, rec.Body.String())
	}
	var trashedAt any
	if err := pool.QueryRow(context.Background(),
		`SELECT trashed_at FROM documents WHERE doc_id = $1`, docID).Scan(&trashedAt); err != nil {
		t.Fatalf("check stale delete: %v", err)
	}
	if trashedAt != nil {
		t.Fatal("stale batch delete changed the document")
	}

	if rec := call(revision); rec.Code != http.StatusOK {
		t.Fatalf("batch delete status = %d, body = %s", rec.Code, rec.Body.String())
	}
	if keys := pendingKeys(t, pool, authUserID); len(keys) != 0 {
		t.Fatalf("trash should retain image references until purge, got pending keys %#v", keys)
	}
	if err := app.purgeDocument(context.Background(), user, docID, "", false, false); err != nil {
		t.Fatalf("purge batch-deleted document: %v", err)
	}
	keys := pendingKeys(t, pool, authUserID)
	if len(keys) != 1 || keys[0] != key {
		t.Fatalf("pending image keys = %#v, want [%q]", keys, key)
	}
}
