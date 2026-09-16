package server

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"
	"koinote/backend/internal/httpx"
)

// documentOrder updates the order of all documents in one folder atomically.
// Requiring the complete sibling list prevents a stale client from silently
// dropping a document that was created or moved by another client.
func (a *App) documentOrder(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	docID := strings.TrimSpace(r.PathValue("docId"))
	if docID == "" {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Document not found")
		return
	}
	var body struct {
		FolderID *string  `json:"folderId"`
		DocIDs   []string `json:"docIds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid request")
		return
	}
	if len(body.DocIDs) == 0 || len(body.DocIDs) > 1000 {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_order", "Invalid document order")
		return
	}
	targetFolder := derefOrEmpty(body.FolderID)
	for index := range body.DocIDs {
		body.DocIDs[index] = strings.TrimSpace(body.DocIDs[index])
		if body.DocIDs[index] == "" {
			httpx.ErrorCode(w, http.StatusBadRequest, "invalid_order", "Invalid document order")
			return
		}
	}

	ctx := r.Context()
	tx, err := a.db.Begin(ctx)
	if err != nil {
		log.Printf("document order begin: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, user.ID); err != nil {
		log.Printf("document order lock: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	var currentFolder string
	if err := tx.QueryRow(ctx, `
		SELECT COALESCE(f.folder_id, '')
		FROM documents d
		LEFT JOIN folders f ON f.id = d.folder_id
		WHERE d.doc_id = $1 AND d.user_id = $2 AND d.trashed_at IS NULL
	`, docID, user.ID).Scan(&currentFolder); errors.Is(err, pgx.ErrNoRows) {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Document not found")
		return
	} else if err != nil {
		log.Printf("document order lookup: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if currentFolder != targetFolder {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_order", "Document folder does not match order target")
		return
	}

	var siblingIDs []string
	rows, err := tx.Query(ctx, `
		SELECT d.doc_id
		FROM documents d
		LEFT JOIN folders f ON f.id = d.folder_id
		WHERE d.user_id = $1 AND d.trashed_at IS NULL
		  AND COALESCE(f.folder_id, '') = $2
		ORDER BY d.sort_order ASC, d.updated_at DESC, d.id DESC
	`, user.ID, targetFolder)
	if err != nil {
		log.Printf("document order siblings: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			log.Printf("document order scan: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		siblingIDs = append(siblingIDs, id)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		log.Printf("document order rows: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	rows.Close()
	if !sameDocumentIDs(siblingIDs, body.DocIDs) {
		httpx.ErrorCode(w, http.StatusConflict, "order_conflict", "Document order changed elsewhere")
		return
	}

	for index, id := range body.DocIDs {
		if _, err := tx.Exec(ctx, `
			UPDATE documents
			SET sort_order = $3
			WHERE doc_id = $1 AND user_id = $2 AND trashed_at IS NULL
		`, id, user.ID, index); err != nil {
			log.Printf("document order update: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		log.Printf("document order commit: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func sameDocumentIDs(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	seen := make(map[string]struct{}, len(left))
	for _, id := range left {
		if _, exists := seen[id]; exists {
			return false
		}
		seen[id] = struct{}{}
	}
	for _, id := range right {
		if _, exists := seen[id]; !exists {
			return false
		}
		delete(seen, id)
	}
	return len(seen) == 0
}
