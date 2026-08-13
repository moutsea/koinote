package server

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"

	"koinote/backend/internal/httpx"
	"koinote/backend/internal/model"
)

func (a *App) documentVersionsList(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	docID := strings.TrimSpace(r.PathValue("docId"))
	rows, err := a.db.Query(r.Context(), `
		SELECT v.revision, v.title, v.theme, v.source, v.safety_snapshot, v.created_at
		FROM document_versions v
		JOIN documents d ON d.id = v.document_id
		WHERE d.doc_id = $1 AND d.user_id = $2 AND d.trashed_at IS NULL
		ORDER BY v.revision DESC
	`, docID, user.ID)
	if err != nil {
		log.Printf("document versions list: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	defer rows.Close()
	versions := make([]model.DocumentVersion, 0)
	for rows.Next() {
		var version model.DocumentVersion
		if err := rows.Scan(&version.Revision, &version.Title, &version.Theme,
			&version.Source, &version.SafetySnapshot, &version.CreatedAt); err != nil {
			log.Printf("document versions scan: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		versions = append(versions, version)
	}
	if rows.Err() != nil {
		log.Printf("document versions rows: %v", rows.Err())
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"versions": versions})
}

func (a *App) documentVersionGet(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	revision, err := parseDocumentRevision(r.PathValue("revision"))
	if err != nil {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Document version not found")
		return
	}
	version, err := a.loadMCPDocumentVersion(r.Context(), user.ID, r.PathValue("docId"), revision)
	if err != nil {
		if errors.Is(err, errDocumentVersionNotFound) {
			httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Document version not found")
			return
		}
		log.Printf("document version get: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"version": version})
}

func (a *App) documentVersionRestore(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	revision, err := parseDocumentRevision(r.PathValue("revision"))
	if err != nil {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Document version not found")
		return
	}
	var body struct {
		ExpectedRevision int64 `json:"expectedRevision"`
	}
	if err := decodeJSONBody(r, &body); err != nil || body.ExpectedRevision <= 0 {
		httpx.ErrorCode(w, http.StatusBadRequest, "revision_required", "expectedRevision is required")
		return
	}
	version, err := a.loadMCPDocumentVersion(r.Context(), user.ID, r.PathValue("docId"), revision)
	if err != nil {
		if errors.Is(err, errDocumentVersionNotFound) {
			httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Document version not found")
			return
		}
		log.Printf("document version restore load: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	doc, err := a.updateDocument(r.Context(), updateDocumentParams{
		User: user, DocID: strings.TrimSpace(r.PathValue("docId")), Title: version.Title,
		Theme: version.Theme, Content: version.Content, ExpectedRevision: body.ExpectedRevision,
		Source: documentSourceRestore,
	})
	if errors.Is(err, errDocumentNotFound) {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Document not found")
		return
	}
	if errors.Is(err, errDocumentRevisionConflict) {
		httpx.ErrorCode(w, http.StatusConflict, "document_revision_conflict", "Document changed elsewhere")
		return
	}
	if errors.Is(err, errDocumentQuotaExceeded) {
		httpx.ErrorCode(w, http.StatusConflict, "storage_quota_exceeded", "Cloud storage quota exceeded")
		return
	}
	if err != nil {
		log.Printf("document version restore: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"document": doc})
}

func parseDocumentRevision(raw string) (int64, error) {
	revision, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil || revision <= 0 {
		return 0, errors.New("invalid revision")
	}
	return revision, nil
}

func decodeJSONBody(r *http.Request, target any) error {
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	return decoder.Decode(target)
}
