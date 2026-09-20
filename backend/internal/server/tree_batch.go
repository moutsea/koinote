package server

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"koinote/backend/internal/httpx"
)

const maxTreeBatchItems = 1000

type treeBatchItem struct {
	Kind     string `json:"kind"`
	ID       string `json:"id"`
	Revision *int64 `json:"revision,omitempty"`
}

type treeBatchMoveRequest struct {
	Items    []treeBatchItem `json:"items"`
	FolderID *string         `json:"folderId"`
}

type treeBatchDeleteRequest struct {
	Items []treeBatchItem `json:"items"`
}

func normalizeTreeBatchItems(items []treeBatchItem) ([]treeBatchItem, error) {
	if len(items) > maxTreeBatchItems {
		return nil, errors.New("too_many_items")
	}
	seen := make(map[string]struct{}, len(items))
	result := make([]treeBatchItem, 0, len(items))
	for _, item := range items {
		item.Kind = strings.TrimSpace(item.Kind)
		item.ID = strings.TrimSpace(item.ID)
		if (item.Kind != "doc" && item.Kind != "folder") || item.ID == "" {
			return nil, errors.New("bad_request")
		}
		key := item.Kind + ":" + item.ID
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, item)
	}
	return result, nil
}

func (a *App) treeBatchMove(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	var body treeBatchMoveRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid request")
		return
	}
	items, err := normalizeTreeBatchItems(body.Items)
	if err != nil {
		status := http.StatusBadRequest
		httpx.ErrorCode(w, status, err.Error(), "Invalid request")
		return
	}
	targetExternal := ""
	if body.FolderID != nil {
		targetExternal = strings.TrimSpace(*body.FolderID)
	}
	ctx := r.Context()
	tx, err := a.db.Begin(ctx)
	if err != nil {
		log.Printf("tree batch move begin: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, user.ID); err != nil {
		log.Printf("tree batch move lock: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	folderByExternal, parentByID, err := loadTreeFolders(ctx, tx, user.ID)
	if err != nil {
		log.Printf("tree batch move folders: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	var targetID *int
	if targetExternal != "" {
		resolved, exists := folderByExternal[targetExternal]
		if !exists {
			httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Folder not found")
			return
		}
		targetID = &resolved
	}

	docByExternal, err := loadTreeDocuments(ctx, tx, user.ID, items)
	if err != nil {
		log.Printf("tree batch move documents: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	moveFolders := make([]string, 0, len(items))
	moveDocs := make([]string, 0, len(items))
	children := folderChildren(parentByID)
	for _, item := range items {
		if item.Kind == "folder" {
			folderID, exists := folderByExternal[item.ID]
			if !exists {
				httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Folder not found")
				return
			}
			if targetID != nil && *targetID == folderID {
				httpx.ErrorCode(w, http.StatusBadRequest, "invalid_move", "Cannot move a folder into itself")
				return
			}
			if targetID != nil && isFolderDescendant(parentByID, folderID, *targetID) {
				httpx.ErrorCode(w, http.StatusBadRequest, "invalid_move", "Cannot move a folder into its own subtree")
				return
			}
			parent := parentByID[folderID]
			if sameFolderID(parent, targetID) {
				continue
			}
			depth, valid := folderDepthFromMap(parentByID, targetID)
			if !valid || depth+1+folderSubtreeHeight(children, folderID) > maxFolderDepth {
				httpx.ErrorCode(w, http.StatusBadRequest, "too_deep", "Folder nesting is too deep")
				return
			}
			moveFolders = append(moveFolders, item.ID)
			continue
		}
		doc, exists := docByExternal[item.ID]
		if !exists {
			httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Document not found")
			return
		}
		if item.Revision != nil && *item.Revision > 0 && doc.revision != *item.Revision {
			httpx.ErrorCode(w, http.StatusConflict, "document_revision_conflict", "Document changed elsewhere")
			return
		}
		if !sameFolderID(doc.folderID, targetID) {
			moveDocs = append(moveDocs, item.ID)
		}
	}

	if len(moveFolders) > 0 {
		if _, err := tx.Exec(ctx, `
			UPDATE folders SET parent_id = $3, updated_at = now()
			WHERE user_id = $1 AND folder_id = ANY($2::text[])
		`, user.ID, moveFolders, targetID); err != nil {
			log.Printf("tree batch move folders update: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
	}
	if len(moveDocs) > 0 {
		if _, err := tx.Exec(ctx, `
			WITH selected AS (
				SELECT value AS doc_id, ord
				FROM unnest($3::text[]) WITH ORDINALITY AS input(value, ord)
			), base AS (
				SELECT COALESCE(MAX(existing.sort_order) + 1, 0) AS start_order
				FROM documents existing
				WHERE existing.user_id = $1
				  AND existing.trashed_at IS NULL
				  AND existing.folder_id IS NOT DISTINCT FROM $2
				  AND NOT (existing.doc_id = ANY($3::text[]))
			)
			UPDATE documents AS moving
			SET folder_id = $2,
			    sort_order = base.start_order + selected.ord - 1,
			    updated_at = now()
			FROM selected, base
			WHERE moving.doc_id = selected.doc_id
			  AND moving.user_id = $1
			  AND moving.trashed_at IS NULL
		`, user.ID, targetID, moveDocs); err != nil {
			log.Printf("tree batch move documents update: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		log.Printf("tree batch move commit: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (a *App) treeBatchDelete(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	var body treeBatchDeleteRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid request")
		return
	}
	items, err := normalizeTreeBatchItems(body.Items)
	if err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, err.Error(), "Invalid request")
		return
	}
	ctx := r.Context()
	tx, err := a.db.Begin(ctx)
	if err != nil {
		log.Printf("tree batch delete begin: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, user.ID); err != nil {
		log.Printf("tree batch delete lock: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	folderByExternal, _, err := loadTreeFolders(ctx, tx, user.ID)
	if err != nil {
		log.Printf("tree batch delete folders: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	docByExternal, err := loadTreeDocuments(ctx, tx, user.ID, items)
	if err != nil {
		log.Printf("tree batch delete documents: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	docItems := make([]treeBatchItem, 0, len(items))
	folderIDs := make([]string, 0, len(items))
	for _, item := range items {
		if item.Kind == "doc" {
			doc, exists := docByExternal[item.ID]
			if !exists {
				httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Document not found")
				return
			}
			if item.Revision != nil && *item.Revision > 0 && doc.revision != *item.Revision {
				httpx.ErrorCode(w, http.StatusConflict, "document_revision_conflict", "Document changed elsewhere")
				return
			}
			docItems = append(docItems, item)
		} else {
			if _, exists := folderByExternal[item.ID]; !exists {
				httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Folder not found")
				return
			}
			folderIDs = append(folderIDs, item.ID)
		}
	}
	for _, item := range docItems {
		expectedRevision := int64(0)
		if item.Revision != nil {
			expectedRevision = *item.Revision
		}
		if _, err := trashDocumentTx(ctx, tx, user, item.ID, expectedRevision); err != nil {
			if errors.Is(err, errDocumentRevisionConflict) {
				httpx.ErrorCode(w, http.StatusConflict, "document_revision_conflict", "Document changed elsewhere")
				return
			}
			if errors.Is(err, errDocumentNotFound) {
				httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Document not found")
				return
			}
			log.Printf("tree batch delete document: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
	}
	for _, folderID := range folderIDs {
		var internalID int
		var parentID *int
		err := tx.QueryRow(ctx,
			`SELECT id, parent_id FROM folders WHERE folder_id = $1 AND user_id = $2`,
			folderID, user.ID,
		).Scan(&internalID, &parentID)
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Folder not found")
			return
		}
		if err != nil {
			log.Printf("tree batch delete folder lookup: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		if _, err := tx.Exec(ctx,
			`UPDATE folders SET parent_id = $2, updated_at = now() WHERE parent_id = $1 AND user_id = $3`,
			internalID, parentID, user.ID,
		); err != nil {
			log.Printf("tree batch delete lift folders: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		if _, err := tx.Exec(ctx, `
			WITH moved AS (
				SELECT d.id,
				       COALESCE((
					   SELECT MAX(existing.sort_order) + 1
					   FROM documents existing
					   WHERE existing.user_id = $3
					     AND existing.trashed_at IS NULL
					     AND existing.folder_id IS NOT DISTINCT FROM $2
				       ), 0) + ROW_NUMBER() OVER (ORDER BY d.sort_order, d.id) - 1 AS next_order
				FROM documents d
				WHERE d.folder_id = $1 AND d.user_id = $3
			)
			UPDATE documents AS d
			SET folder_id = $2, sort_order = moved.next_order, updated_at = now()
			FROM moved
			WHERE d.id = moved.id
		`, internalID, parentID, user.ID); err != nil {
			log.Printf("tree batch delete lift docs: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		if _, err := tx.Exec(ctx, `DELETE FROM folders WHERE id = $1 AND user_id = $2`, internalID, user.ID); err != nil {
			log.Printf("tree batch delete folder: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		log.Printf("tree batch delete commit: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func loadTreeFolders(ctx context.Context, tx pgx.Tx, userID int) (map[string]int, map[int]*int, error) {
	rows, err := tx.Query(ctx, `SELECT id, folder_id, parent_id FROM folders WHERE user_id = $1`, userID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	byExternal := make(map[string]int)
	parents := make(map[int]*int)
	for rows.Next() {
		var id int
		var external string
		var parent *int
		if err := rows.Scan(&id, &external, &parent); err != nil {
			return nil, nil, err
		}
		byExternal[external] = id
		parents[id] = parent
	}
	return byExternal, parents, rows.Err()
}

type treeBatchDocument struct {
	folderID *int
	revision int64
}

func loadTreeDocuments(ctx context.Context, tx pgx.Tx, userID int, items []treeBatchItem) (map[string]treeBatchDocument, error) {
	ids := make([]string, 0, len(items))
	for _, item := range items {
		if item.Kind == "doc" {
			ids = append(ids, item.ID)
		}
	}
	result := make(map[string]treeBatchDocument, len(ids))
	if len(ids) == 0 {
		return result, nil
	}
	rows, err := tx.Query(ctx, `
		SELECT d.doc_id, d.folder_id, d.revision
		FROM documents d
		WHERE d.user_id = $1 AND d.doc_id = ANY($2::text[]) AND d.trashed_at IS NULL
	`, userID, ids)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var folderID *int
		var revision int64
		if err := rows.Scan(&id, &folderID, &revision); err != nil {
			return nil, err
		}
		result[id] = treeBatchDocument{folderID: folderID, revision: revision}
	}
	return result, rows.Err()
}

func sameFolderID(left, right *int) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func isFolderDescendant(parents map[int]*int, root, candidate int) bool {
	seen := make(map[int]struct{})
	for current := candidate; ; {
		if current == root {
			return true
		}
		if _, ok := seen[current]; ok {
			return false
		}
		seen[current] = struct{}{}
		parent, ok := parents[current]
		if !ok || parent == nil {
			return false
		}
		current = *parent
	}
}

func folderDepthFromMap(parents map[int]*int, id *int) (int, bool) {
	if id == nil {
		return 0, true
	}
	depth := 1
	seen := make(map[int]struct{})
	for current := *id; ; {
		if _, ok := seen[current]; ok {
			return 0, false
		}
		seen[current] = struct{}{}
		parent, ok := parents[current]
		if !ok {
			return 0, false
		}
		if parent == nil {
			return depth, true
		}
		depth++
		current = *parent
	}
}

func folderChildren(parents map[int]*int) map[int][]int {
	children := make(map[int][]int)
	for child, parent := range parents {
		if parent != nil {
			children[*parent] = append(children[*parent], child)
		}
	}
	return children
}

func folderSubtreeHeight(children map[int][]int, root int) int {
	var visit func(int, map[int]struct{}) int
	visit = func(current int, path map[int]struct{}) int {
		if _, ok := path[current]; ok {
			return 0
		}
		nextPath := make(map[int]struct{}, len(path)+1)
		for id := range path {
			nextPath[id] = struct{}{}
		}
		nextPath[current] = struct{}{}
		maxDistance := 0
		for _, child := range children[current] {
			maxDistance = maxTreeInt(maxDistance, 1+visit(child, nextPath))
		}
		return maxDistance
	}
	return visit(root, nil)
}

func maxTreeInt(left, right int) int {
	if left > right {
		return left
	}
	return right
}
