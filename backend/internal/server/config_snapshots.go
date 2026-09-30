package server

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"koinote/backend/internal/httpx"
)

const (
	configSnapshotRequestOverhead = 1 << 20
	configSnapshotMaxNameRunes    = 80
	configSnapshotFreeLimit       = 1
)

type configSnapshotSummary struct {
	SnapshotID      string    `json:"id"`
	Name            string    `json:"name"`
	FileCount       int       `json:"fileCount"`
	Bytes           int64     `json:"bytes"`
	EnvelopeVersion int16     `json:"envelopeVersion"`
	Revision        int       `json:"revision"`
	CreatedAt       time.Time `json:"createdAt"`
	UpdatedAt       time.Time `json:"updatedAt"`
}

type configSnapshotPayload struct {
	configSnapshotSummary
	Envelope string `json:"envelope"`
}

type configSnapshotCreateInput struct {
	Name            string `json:"name"`
	FileCount       int    `json:"fileCount"`
	EnvelopeVersion int16  `json:"envelopeVersion"`
	Envelope        string `json:"envelope"`
	Revision        int    `json:"revision"`
}

type configSnapshotEnvelopeHeader struct {
	Version    int    `json:"version"`
	KDF        string `json:"kdf"`
	Iterations int    `json:"iterations"`
	Salt       string `json:"salt"`
	IV         string `json:"iv"`
	Ciphertext string `json:"ciphertext"`
}

func validConfigSnapshotEnvelope(serialized string) bool {
	var header configSnapshotEnvelopeHeader
	if err := json.Unmarshal([]byte(serialized), &header); err != nil {
		return false
	}
	if header.Version != 1 || header.KDF != "PBKDF2-SHA-256" || header.Iterations < 100_000 || header.Iterations > 2_000_000 {
		return false
	}
	salt, saltErr := base64.StdEncoding.DecodeString(header.Salt)
	iv, ivErr := base64.StdEncoding.DecodeString(header.IV)
	ciphertext, ciphertextErr := base64.StdEncoding.DecodeString(header.Ciphertext)
	return saltErr == nil && len(salt) == 16 && ivErr == nil && len(iv) == 12 && ciphertextErr == nil && len(ciphertext) >= 16
}

func (a *App) configSnapshotsList(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	rows, err := a.db.Query(r.Context(), `
		SELECT snapshot_id::text, name, file_count, bytes, envelope_version, revision, created_at, updated_at
		FROM config_snapshots
		WHERE user_id = $1
		ORDER BY created_at DESC, snapshot_id DESC
	`, user.ID)
	if err != nil {
		log.Printf("config snapshots list: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	defer rows.Close()
	items := make([]configSnapshotSummary, 0)
	for rows.Next() {
		var item configSnapshotSummary
		if err := rows.Scan(&item.SnapshotID, &item.Name, &item.FileCount, &item.Bytes, &item.EnvelopeVersion, &item.Revision, &item.CreatedAt, &item.UpdatedAt); err != nil {
			log.Printf("config snapshots list scan: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		log.Printf("config snapshots list rows: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"snapshots": items})
}

func (a *App) configSnapshotGet(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	snapshotID := strings.TrimSpace(r.PathValue("snapshotId"))
	if !validUUID(snapshotID) {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_snapshot_id", "Invalid snapshot id")
		return
	}
	var item configSnapshotPayload
	var envelope []byte
	err := a.db.QueryRow(r.Context(), `
		SELECT snapshot_id::text, name, file_count, bytes, envelope_version, envelope,
		       revision, created_at, updated_at
		FROM config_snapshots WHERE snapshot_id = $1 AND user_id = $2
	`, snapshotID, user.ID).Scan(
		&item.SnapshotID, &item.Name, &item.FileCount, &item.Bytes, &item.EnvelopeVersion,
		&envelope, &item.Revision, &item.CreatedAt, &item.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.ErrorCode(w, http.StatusNotFound, "snapshot_not_found", "Snapshot not found")
		return
	}
	if err != nil {
		log.Printf("config snapshot get: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	item.Envelope = string(envelope)
	httpx.JSON(w, http.StatusOK, map[string]any{"snapshot": item})
}

func (a *App) configSnapshotCreate(w http.ResponseWriter, r *http.Request) {
	a.configSnapshotWrite(w, r, false)
}

func (a *App) configSnapshotUpdate(w http.ResponseWriter, r *http.Request) {
	a.configSnapshotWrite(w, r, true)
}

func (a *App) configSnapshotWrite(w http.ResponseWriter, r *http.Request, updating bool) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	snapshotID := strings.TrimSpace(r.PathValue("snapshotId"))
	if updating && !validUUID(snapshotID) {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_snapshot_id", "Invalid snapshot id")
		return
	}
	requestLimit := a.storageQuotaFor(user) + configSnapshotRequestOverhead
	r.Body = http.MaxBytesReader(w, r.Body, requestLimit)
	var input configSnapshotCreateInput
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil {
		if errors.Is(err, io.EOF) {
			httpx.ErrorCode(w, http.StatusBadRequest, "missing_fields", "Snapshot data is required")
			return
		}
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid snapshot data")
		return
	}
	input.Name = strings.TrimSpace(input.Name)
	if updating && input.Revision < 1 {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_revision", "Snapshot revision is required")
		return
	}
	if input.Name == "" || utf8.RuneCountInString(input.Name) > configSnapshotMaxNameRunes {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_snapshot_name", "Invalid snapshot name")
		return
	}
	if input.FileCount < 1 {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_file_count", "Invalid file count")
		return
	}
	if input.EnvelopeVersion != 1 {
		httpx.ErrorCode(w, http.StatusBadRequest, "unsupported_envelope", "Unsupported snapshot format")
		return
	}
	envelopeBytes := []byte(input.Envelope)
	if len(envelopeBytes) == 0 || !validConfigSnapshotEnvelope(input.Envelope) {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_snapshot", "Invalid snapshot data")
		return
	}

	tx, err := a.db.Begin(r.Context())
	if err != nil {
		log.Printf("config snapshot begin: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	defer tx.Rollback(r.Context())
	if _, err := tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock($1)`, user.ID); err != nil {
		log.Printf("config snapshot lock: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	var previousBytes int64
	if updating {
		var revision int
		err := tx.QueryRow(r.Context(), `SELECT bytes, revision FROM config_snapshots WHERE snapshot_id = $1 AND user_id = $2 FOR UPDATE`, snapshotID, user.ID).Scan(&previousBytes, &revision)
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.ErrorCode(w, http.StatusNotFound, "snapshot_not_found", "Snapshot not found")
			return
		}
		if err != nil {
			log.Printf("config snapshot update read: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		if revision != input.Revision {
			httpx.ErrorCode(w, http.StatusConflict, "config_snapshot_conflict", "Snapshot changed; unlock the latest version and try again")
			return
		}
	}
	if !updating && user.MembershipTier != membershipTierLifetime {
		var count int
		if err := tx.QueryRow(r.Context(), `SELECT count(*) FROM config_snapshots WHERE user_id = $1`, user.ID).Scan(&count); err != nil {
			log.Printf("config snapshot count: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		if count >= configSnapshotFreeLimit {
			httpx.ErrorCode(w, http.StatusConflict, "config_snapshot_limit", "Free accounts can save one configuration snapshot")
			return
		}
	}
	used, err := storageUsageForQuerier(r.Context(), tx, user.ID)
	if err != nil {
		log.Printf("config snapshot usage: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	quota := a.storageQuotaFor(user)
	if used.Total()-previousBytes+int64(len(envelopeBytes)) > quota {
		httpx.JSON(w, http.StatusConflict, map[string]any{
			"code": "config_snapshot_quota_exceeded", "usedBytes": used.Total(),
			"documentBytes": used.DocumentBytes, "imageBytes": used.ImageBytes,
			"configBytes": used.ConfigBytes, "quotaBytes": quota,
		})
		return
	}
	var item configSnapshotPayload
	var envelopeOut []byte
	var row pgx.Row
	if updating {
		row = tx.QueryRow(r.Context(), `
			UPDATE config_snapshots SET name = $3, file_count = $4, bytes = $5,
			    envelope_version = $6, envelope = $7, revision = revision + 1, updated_at = now()
			WHERE snapshot_id = $1 AND user_id = $2
			RETURNING snapshot_id::text, name, file_count, bytes, envelope_version, envelope, revision, created_at, updated_at
		`, snapshotID, user.ID, input.Name, input.FileCount, len(envelopeBytes), input.EnvelopeVersion, envelopeBytes)
	} else {
		row = tx.QueryRow(r.Context(), `
		INSERT INTO config_snapshots (user_id, name, file_count, bytes, envelope_version, envelope)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING snapshot_id::text, name, file_count, bytes, envelope_version, envelope, revision, created_at, updated_at
	`, user.ID, input.Name, input.FileCount, len(envelopeBytes), input.EnvelopeVersion, envelopeBytes)
	}
	err = row.Scan(
		&item.SnapshotID, &item.Name, &item.FileCount, &item.Bytes, &item.EnvelopeVersion,
		&envelopeOut, &item.Revision, &item.CreatedAt, &item.UpdatedAt,
	)
	if err != nil {
		log.Printf("config snapshot write: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		log.Printf("config snapshot commit: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	item.Envelope = string(envelopeOut)
	status := http.StatusCreated
	if updating {
		status = http.StatusOK
	}
	httpx.JSON(w, status, map[string]any{"snapshot": item})
}

func (a *App) configSnapshotDelete(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	snapshotID := strings.TrimSpace(r.PathValue("snapshotId"))
	if !validUUID(snapshotID) {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_snapshot_id", "Invalid snapshot id")
		return
	}
	revisionText := strings.TrimSpace(r.URL.Query().Get("revision"))
	revision := 0
	if revisionText != "" {
		parsed, err := strconv.Atoi(revisionText)
		if err != nil || parsed < 1 {
			httpx.ErrorCode(w, http.StatusBadRequest, "invalid_revision", "Invalid snapshot revision")
			return
		}
		revision = parsed
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		log.Printf("config snapshot delete begin: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	defer tx.Rollback(r.Context())
	if _, err := tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock($1)`, user.ID); err != nil {
		log.Printf("config snapshot delete lock: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	var result pgconn.CommandTag
	if revision > 0 {
		result, err = tx.Exec(r.Context(), `
			DELETE FROM config_snapshots WHERE snapshot_id = $1 AND user_id = $2 AND revision = $3
		`, snapshotID, user.ID, revision)
	} else {
		result, err = tx.Exec(r.Context(), `
			DELETE FROM config_snapshots WHERE snapshot_id = $1 AND user_id = $2
		`, snapshotID, user.ID)
	}
	if err != nil {
		log.Printf("config snapshot delete: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if result.RowsAffected() == 0 {
		if revision > 0 {
			var exists bool
			if err := tx.QueryRow(r.Context(), `
				SELECT EXISTS(SELECT 1 FROM config_snapshots WHERE snapshot_id = $1 AND user_id = $2)
			`, snapshotID, user.ID).Scan(&exists); err != nil {
				log.Printf("config snapshot delete existence check: %v", err)
				httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
				return
			}
			if exists {
				httpx.ErrorCode(w, http.StatusConflict, "config_snapshot_conflict", "Snapshot changed; unlock the latest version and try again")
				return
			}
		}
		httpx.ErrorCode(w, http.StatusNotFound, "snapshot_not_found", "Snapshot not found")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		log.Printf("config snapshot delete commit: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"success": true})
}
