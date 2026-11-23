package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"koinote/backend/internal/httpx"
)

// A paused task may outlive its upload lease. Renew only future leases: an
// already-due object may be in a GC batch, so the client must upload it again.
func (a *App) imageRetainImport(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	if !a.rateLimit().allow(fmt.Sprintf("image-retain:user:%d", user.ID), 60, time.Minute) {
		tooManyAttempts(w)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, imageReleaseBodyMax)
	var body struct {
		Keys []string `json:"keys"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.Keys) > imageReleaseKeyMax {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid image keys")
		return
	}
	for _, key := range body.Keys {
		if owner, valid := imageKeyOwner(key); !valid || owner != user.AuthUserID {
			httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Image does not belong to this account")
			return
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	missing, unrecorded, err := a.retainImportImages(ctx, user.ID, body.Keys)
	if err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Could not retain import images")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"missingKeys": missing, "unrecordedKeys": unrecorded})
}

// retainImportImages renews cleanup leases of keys a client still references.
//
// missing: keys that are definitely unusable (being collected, due for
// collection, or temporary/foreign ledger entries). unrecorded: keys with
// neither a ledger row nor a cleanup entry. Images uploaded before usage was
// recorded, or whose record failed, look like this yet still exist; so does an
// image collected long ago. Only an object check can tell them apart, so the
// caller decides.
func (a *App) retainImportImages(ctx context.Context, userID int, keys []string) ([]string, []string, error) {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, nil, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, userID); err != nil {
		return nil, nil, err
	}
	rows, err := tx.Query(ctx, `
		SELECT DISTINCT k.key,
			i.object_key IS NOT NULL,
			COALESCE(i.user_id = $1 AND i.purpose = 'persistent', false),
			p.object_key IS NOT NULL,
			p.object_key IS NOT NULL AND (p.upload_aborted_at IS NOT NULL OR p.user_id IS DISTINCT FROM $1),
			p.next_try_at
		FROM unnest($2::text[]) AS k(key)
		LEFT JOIN image_objects i ON i.object_key = k.key
		LEFT JOIN pending_image_deletions p ON p.object_key = k.key
	`, userID, keys)
	if err != nil {
		return nil, nil, err
	}
	valid := make(map[string]bool)
	unrecordedSet := make(map[string]bool)
	renew := make([]string, 0, len(keys))
	minimumLease := time.Now().Add(time.Minute)
	for rows.Next() {
		var key string
		var recorded, usable, queued, retired bool
		var deadline *time.Time
		if err = rows.Scan(&key, &recorded, &usable, &queued, &retired, &deadline); err != nil {
			rows.Close()
			return nil, nil, err
		}
		switch {
		case retired, recorded && !usable:
			// Collected regardless of this reference: the client must upload again.
		case queued:
			// Renew only future leases: an already-due object may be in a GC batch.
			if deadline != nil && deadline.After(minimumLease) {
				valid[key] = true
				renew = append(renew, key)
			}
		case recorded:
			valid[key] = true
		default:
			unrecordedSet[key] = true
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, nil, err
	}
	if len(renew) > 0 {
		if _, err = tx.Exec(ctx, `UPDATE pending_image_deletions SET next_try_at = GREATEST(next_try_at, $3)
			WHERE user_id = $1 AND object_key = ANY($2)`, userID, renew, time.Now().Add(importImageTTL)); err != nil {
			return nil, nil, err
		}
	}
	missing := make([]string, 0)
	unrecorded := make([]string, 0)
	for _, key := range keys {
		switch {
		case valid[key]:
		case unrecordedSet[key]:
			unrecorded = append(unrecorded, key)
		default:
			missing = append(missing, key)
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, nil, err
	}
	return missing, unrecorded, nil
}
