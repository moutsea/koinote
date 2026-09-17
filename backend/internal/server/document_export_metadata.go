package server

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"koinote/backend/internal/httpx"
)

const documentExportMetadataRequestBytes = 4 << 10
const documentExportImageSourceMaxBytes = 2048

type documentWechatCoverMetadata struct {
	Source string
	Ratio  string
}

func (a *App) documentExportMetadataGet(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	metadata, err := a.loadDocumentWechatCoverMetadata(r.Context(), user.ID, r.PathValue("docId"))
	if errors.Is(err, errDocumentNotFound) {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Document not found")
		return
	}
	if err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if metadata == nil {
		httpx.JSON(w, http.StatusOK, map[string]any{"cover": nil})
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"cover": map[string]string{
			"source": metadata.Source,
			"ratio":  metadata.Ratio,
		},
	})
}

func (a *App) documentExportMetadataPut(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	var input struct {
		CoverImage string `json:"coverImage"`
		CoverRatio string `json:"coverRatio"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, documentExportMetadataRequestBytes)
	if err := decodeJSONBody(r, &input); err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid request")
		return
	}
	input.CoverImage = strings.TrimSpace(input.CoverImage)
	input.CoverRatio = strings.TrimSpace(input.CoverRatio)
	var imageKey string
	if input.CoverImage != "" {
		parsed, err := url.Parse(input.CoverImage)
		if err != nil || (parsed.Scheme != "https" || parsed.Host == "") && !strings.HasPrefix(input.CoverImage, "/images/") || parsed.User != nil ||
			len(input.CoverImage) > documentExportImageSourceMaxBytes || !validWechatCoverRatio(input.CoverRatio) {
			httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid cover metadata")
			return
		}
		imageKey = imageKeyPattern.FindString(input.CoverImage)
		owner, valid := imageKeyOwner(imageKey)
		if !valid || owner != user.AuthUserID {
			httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Cover image must belong to this user")
			return
		}
		input.CoverImage = normalizeMCPWechatImageSource("/images/"+imageKey, a.cfg.AppURL, a.cfg.WorkerURL)
	} else if input.CoverRatio != "" {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid cover metadata")
		return
	}

	tx, err := a.db.Begin(r.Context())
	if err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	defer tx.Rollback(r.Context())
	var documentID int
	err = tx.QueryRow(r.Context(), `
		SELECT id FROM documents
		WHERE doc_id = $1 AND user_id = $2 AND trashed_at IS NULL
		FOR UPDATE
	`, strings.TrimSpace(r.PathValue("docId")), user.ID).Scan(&documentID)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Document not found")
		return
	}
	if err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if imageKey != "" {
		var exists bool
		if err := tx.QueryRow(r.Context(), `
			SELECT EXISTS (SELECT 1 FROM image_objects
			WHERE object_key = $1 AND user_id = $2 AND purpose = 'persistent')
		`, imageKey, user.ID).Scan(&exists); err != nil {
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		if !exists {
			httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Cover image is not a persistent upload")
			return
		}
	}
	var previousSource string
	if err := tx.QueryRow(r.Context(), `
		SELECT COALESCE((SELECT wechat_cover_image FROM document_export_metadata WHERE document_id = $1), '')
	`, documentID).Scan(&previousSource); err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if input.CoverImage == "" {
		_, err = tx.Exec(r.Context(), `DELETE FROM document_export_metadata WHERE document_id = $1`, documentID)
	} else {
		_, err = tx.Exec(r.Context(), `
		INSERT INTO document_export_metadata (document_id, wechat_cover_image, wechat_cover_ratio, updated_at)
		VALUES ($1, $2, $3, now())
		ON CONFLICT (document_id) DO UPDATE SET
			wechat_cover_image = EXCLUDED.wechat_cover_image,
			wechat_cover_ratio = EXCLUDED.wechat_cover_ratio,
			updated_at = now()
	`, documentID, input.CoverImage, input.CoverRatio)
	}
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	gcCtx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 10*time.Second)
	defer cancel()
	owner := userRef{ID: user.ID, AuthUserID: user.AuthUserID}
	a.cancelPendingImageDeletions(gcCtx, owner, input.CoverImage)
	a.enqueueOrphanedImages(gcCtx, owner, previousSource)
	if input.CoverImage == "" {
		httpx.JSON(w, http.StatusOK, map[string]any{"cover": nil})
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"cover": map[string]string{"source": input.CoverImage, "ratio": input.CoverRatio},
	})
}

func (a *App) loadDocumentWechatCoverMetadata(ctx context.Context, userID int, docID string) (*documentWechatCoverMetadata, error) {
	var source, ratio sql.NullString
	err := a.db.QueryRow(ctx, `
		SELECT m.wechat_cover_image, m.wechat_cover_ratio
		FROM documents d
		LEFT JOIN document_export_metadata m ON m.document_id = d.id
		WHERE d.doc_id = $1 AND d.user_id = $2 AND d.trashed_at IS NULL
	`, strings.TrimSpace(docID), userID).Scan(&source, &ratio)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, errDocumentNotFound
	}
	if err != nil {
		return nil, err
	}
	if !source.Valid || strings.TrimSpace(source.String) == "" {
		return nil, nil
	}
	coverRatio := ratio.String
	if !validWechatCoverRatio(coverRatio) {
		coverRatio = wechatCoverRatioWide
	}
	return &documentWechatCoverMetadata{Source: source.String, Ratio: coverRatio}, nil
}
