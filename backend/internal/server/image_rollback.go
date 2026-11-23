package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"koinote/backend/internal/httpx"
)

const imageRollbackRetention = 24 * time.Hour

var errImageUploadAborted = errors.New("image upload was rolled back")

// Only the Worker can attest that R2 deletion succeeded. Register the abort
// before deleting, then release quota in the confirmation transaction. Both
// phases are idempotent and serialize with the original image record.
func (a *App) imageRollback(w http.ResponseWriter, r *http.Request) {
	if !a.hasInternalToken(r) || strings.TrimSpace(r.Header.Get("X-Auth-User-Id")) == "" {
		httpx.ErrorCode(w, http.StatusUnauthorized, "unauthorized", "Internal authentication required")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	var body struct {
		Key     string `json:"key"`
		Deleted bool   `json:"deleted"`
		Purpose string `json:"purpose"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid rollback")
		return
	}
	if owner, valid := imageKeyOwner(body.Key); !valid || owner != user.AuthUserID {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Image does not belong to this account")
		return
	}
	if body.Purpose == "" {
		body.Purpose = imagePurposePersistent
	}
	if body.Purpose != imagePurposePersistent && body.Purpose != imagePurposeWechatExport {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid image purpose")
		return
	}
	allowed, err := a.rollbackImageUploadWithPurpose(ctx, user.ID, body.Key, body.Deleted, body.Purpose)
	if err != nil {
		httpx.ErrorCode(w, http.StatusServiceUnavailable, "image_rollback_failed", "Could not reconcile image upload")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"rollbackAllowed": allowed})
}

func (a *App) rollbackImageUpload(ctx context.Context, userID int, key string, deleted bool) (bool, error) {
	return a.rollbackImageUploadWithPurpose(ctx, userID, key, deleted, imagePurposePersistent)
}

func (a *App) rollbackImageUploadWithPurpose(ctx context.Context, userID int, key string, deleted bool, purpose string) (bool, error) {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return false, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, userID); err != nil {
		return false, err
	}
	references, err := referencedImageKeysForQuerier(ctx, tx, []int64{int64(userID)}, []string{key})
	if err != nil {
		return false, err
	}
	if _, referenced := references[key]; referenced {
		return false, nil
	}
	if _, err = tx.Exec(ctx, `
		INSERT INTO pending_image_deletions (object_key, user_id, upload_aborted_at, next_try_at)
		VALUES ($1, $2, now(), now())
		ON CONFLICT (object_key) DO UPDATE SET
		  upload_aborted_at=COALESCE(pending_image_deletions.upload_aborted_at,EXCLUDED.upload_aborted_at),
		  next_try_at=now(), attempts=0, last_error=NULL
	`, key, userID); err != nil {
		return false, err
	}
	if deleted {
		if _, err = tx.Exec(ctx, `DELETE FROM image_objects WHERE object_key=$1 AND user_id=$2`, key, userID); err != nil {
			return false, err
		}
		// All new uploads have unique keys; temporary images need the same late
		// record protection. A retry obtains a fresh key rather than reviving one.
		if _, err = tx.Exec(ctx, `UPDATE pending_image_deletions SET next_try_at=
			CASE WHEN upload_aborted_at IS NOT NULL THEN upload_aborted_at+$2::interval
			ELSE now()+$3::interval END WHERE object_key=$1`, key, imageRollbackRetention.String(), wechatExportImageTTL.String()); err != nil {
			return false, err
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return false, err
	}
	return true, nil
}
