package server

import (
	"context"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"koinote/backend/internal/httpx"
)

const (
	documentSearchDefaultLimit = 20
	documentSearchMaxLimit     = 50
)

type documentSearchResult struct {
	DocID          string     `json:"docId"`
	Title          string     `json:"title"`
	FolderID       string     `json:"folderId,omitempty"`
	Snippet        string     `json:"snippet"`
	TitleMatched   bool       `json:"titleMatched"`
	ContentMatched bool       `json:"contentMatched"`
	Revision       int64      `json:"revision"`
	UpdatedAt      *time.Time `json:"updatedAt"`
}

func (a *App) searchDocuments(
	ctx context.Context,
	userID int,
	query string,
	limit int,
	offset int,
	folderID *string,
) ([]documentSearchResult, error) {
	var requestedFolderID *string
	if folderID != nil {
		requestedFolderID = folderID
	}
	rows, err := a.db.Query(ctx, `
		WITH matched AS (
			SELECT
				d.doc_id, d.title, d.content, d.revision, d.updated_at, d.id,
				COALESCE(f.folder_id, '') AS folder_id,
				position(lower($2::text) in lower(title)) AS title_pos,
				position(lower($2::text) in lower(content)) AS content_pos
			FROM documents d
			LEFT JOIN folders f ON f.id = d.folder_id AND f.user_id = d.user_id
			WHERE d.user_id = $1 AND d.trashed_at IS NULL
			  AND ($5::text IS NULL OR ($5 = '' AND d.folder_id IS NULL) OR f.folder_id = $5)
		)
		SELECT
			doc_id,
			title,
			folder_id,
			CASE
				WHEN content_pos = 0 THEN ''
				ELSE
					CASE WHEN content_pos > 81 THEN '…' ELSE '' END ||
					substring(content FROM GREATEST(1, content_pos - 80) FOR 240) ||
					CASE WHEN char_length(content) > GREATEST(1, content_pos - 80) + 239 THEN '…' ELSE '' END
			END AS snippet,
			title_pos > 0,
			content_pos > 0,
			revision,
			updated_at
		FROM matched
		WHERE title_pos > 0 OR content_pos > 0
		ORDER BY (title_pos > 0) DESC, updated_at DESC, id DESC
		LIMIT $3 OFFSET $4
	`, userID, query, limit, offset, requestedFolderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	results := make([]documentSearchResult, 0, limit)
	for rows.Next() {
		var item documentSearchResult
		if err := rows.Scan(
			&item.DocID,
			&item.Title,
			&item.FolderID,
			&item.Snippet,
			&item.TitleMatched,
			&item.ContentMatched,
			&item.Revision,
			&item.UpdatedAt,
		); err != nil {
			return nil, err
		}
		results = append(results, item)
	}
	return results, rows.Err()
}

func (a *App) documentsSearch(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if query == "" || utf8.RuneCountInString(query) > 200 {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_search_query", "Search query must contain 1 to 200 characters")
		return
	}
	limit := documentSearchDefaultLimit
	if raw := strings.TrimSpace(r.URL.Query().Get("limit")); raw != "" {
		parsed, err := strconv.Atoi(raw)
		if err != nil || parsed < 1 || parsed > documentSearchMaxLimit {
			httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Search limit must be between 1 and 50")
			return
		}
		limit = parsed
	}
	results, err := a.searchDocuments(r.Context(), user.ID, query, limit, 0, nil)
	if err != nil {
		log.Printf("documents search: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"results": results})
}
