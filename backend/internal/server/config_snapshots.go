package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"koinote/backend/internal/httpx"
)

const (
	configSnapshotMaxEnvelopeBytes = 64 << 20
	configSnapshotRequestOverhead  = 1 << 20
	configSnapshotWriteLimit       = 20
	configSnapshotMaxNameRunes     = 80
	configSnapshotFreeLimit        = 1
	// 上传整个 envelope 的读取上限；慢速滴灌的连接到点即被断开，不会长期占住写入槽位。
	configSnapshotReadTimeout = 2 * time.Minute
	// 全局槽位满时排队等待的上限，避免正常并发保存直接收到 429。
	configSnapshotSlotWait = 30 * time.Second
)

// 全局并发上限约束整体内存峰值；每个用户同一时间只能占用一个写入，避免单个账号挤占全部槽位。
var (
	configSnapshotWriteSlots   = make(chan struct{}, 4)
	configSnapshotUserWritesMu sync.Mutex
	configSnapshotUserWrites   = map[int]struct{}{}
)

func acquireConfigSnapshotUserWrite(userID int) bool {
	configSnapshotUserWritesMu.Lock()
	defer configSnapshotUserWritesMu.Unlock()
	if _, busy := configSnapshotUserWrites[userID]; busy {
		return false
	}
	configSnapshotUserWrites[userID] = struct{}{}
	return true
}

func releaseConfigSnapshotUserWrite(userID int) {
	configSnapshotUserWritesMu.Lock()
	delete(configSnapshotUserWrites, userID)
	configSnapshotUserWritesMu.Unlock()
}

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
	Version    int                      `json:"version"`
	KDF        string                   `json:"kdf"`
	Iterations int                      `json:"iterations"`
	Salt       string                   `json:"salt"`
	IV         string                   `json:"iv"`
	Ciphertext configSnapshotCiphertext `json:"ciphertext"`
}

// configSnapshotCiphertext 直接在解码缓冲区上校验 base64，不再为几十 MB 的密文额外复制一份字符串。
type configSnapshotCiphertext struct {
	valid bool
}

func (c *configSnapshotCiphertext) UnmarshalJSON(raw []byte) error {
	if len(raw) < 2 || raw[0] != '"' || raw[len(raw)-1] != '"' {
		c.valid = false
		return nil
	}
	body := raw[1 : len(raw)-1]
	if bytes.IndexByte(body, '\\') >= 0 {
		// 带转义的字符串（例如 "\/"）走标准解码，正常客户端不会产生这种输出。
		var value string
		if err := json.Unmarshal(raw, &value); err != nil {
			c.valid = false
			return nil
		}
		c.valid = validConfigSnapshotBase64(value, 16)
		return nil
	}
	c.valid = validConfigSnapshotBase64Bytes(body, 16)
	return nil
}

func validConfigSnapshotEnvelope(serialized []byte) bool {
	var header configSnapshotEnvelopeHeader
	decoder := json.NewDecoder(bytes.NewReader(serialized))
	if err := decoder.Decode(&header); err != nil {
		return false
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return false
	}
	if header.Version != 1 || header.KDF != "PBKDF2-SHA-256" || header.Iterations < 100_000 || header.Iterations > 2_000_000 {
		return false
	}
	salt, saltErr := base64.StdEncoding.DecodeString(header.Salt)
	iv, ivErr := base64.StdEncoding.DecodeString(header.IV)
	return saltErr == nil && len(salt) == 16 && ivErr == nil && len(iv) == 12 && header.Ciphertext.valid
}

func validConfigSnapshotBase64(value string, minimumDecodedBytes int) bool {
	return validConfigSnapshotBase64Bytes([]byte(value), minimumDecodedBytes)
}

func validConfigSnapshotBase64Bytes(value []byte, minimumDecodedBytes int) bool {
	if len(value) == 0 || len(value)%4 != 0 {
		return false
	}
	padding := 0
	if bytes.HasSuffix(value, []byte("=")) {
		padding++
		if bytes.HasSuffix(value, []byte("==")) {
			padding++
		}
	}
	for index, character := range value {
		valid := character >= 'A' && character <= 'Z' || character >= 'a' && character <= 'z' || character >= '0' && character <= '9' || character == '+' || character == '/' || (character == '=' && index >= len(value)-padding)
		if !valid {
			return false
		}
	}
	return base64.StdEncoding.DecodedLen(len(value))-padding >= minimumDecodedBytes
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
	if !a.rateLimit().allow("config-snapshot-write:"+strconv.Itoa(user.ID), configSnapshotWriteLimit, time.Minute) {
		tooManyAttempts(w)
		return
	}
	if !acquireConfigSnapshotUserWrite(user.ID) {
		tooManyAttempts(w)
		return
	}
	defer releaseConfigSnapshotUserWrite(user.ID)
	slotWait := time.NewTimer(configSnapshotSlotWait)
	defer slotWait.Stop()
	select {
	case configSnapshotWriteSlots <- struct{}{}:
		defer func() { <-configSnapshotWriteSlots }()
	case <-slotWait.C:
		tooManyAttempts(w)
		return
	case <-r.Context().Done():
		return
	}
	// 服务器只配置了 ReadHeaderTimeout；这里给大请求体单独设读取期限。
	_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(configSnapshotReadTimeout))
	snapshotID := strings.TrimSpace(r.PathValue("snapshotId"))
	if updating && !validUUID(snapshotID) {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_snapshot_id", "Invalid snapshot id")
		return
	}
	requestLimit := int64(configSnapshotMaxEnvelopeBytes + configSnapshotRequestOverhead)
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
	input.Envelope = ""
	if len(envelopeBytes) == 0 || len(envelopeBytes) > configSnapshotMaxEnvelopeBytes || !validConfigSnapshotEnvelope(envelopeBytes) {
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
	// 写入响应只回摘要：客户端手里已有 envelope，回传会让单个请求的内存再翻倍。
	var item configSnapshotSummary
	var row pgx.Row
	if updating {
		row = tx.QueryRow(r.Context(), `
			UPDATE config_snapshots SET name = $3, file_count = $4, bytes = $5,
			    envelope_version = $6, envelope = $7, revision = revision + 1, updated_at = now()
			WHERE snapshot_id = $1 AND user_id = $2
			RETURNING snapshot_id::text, name, file_count, bytes, envelope_version, revision, created_at, updated_at
		`, snapshotID, user.ID, input.Name, input.FileCount, len(envelopeBytes), input.EnvelopeVersion, envelopeBytes)
	} else {
		row = tx.QueryRow(r.Context(), `
		INSERT INTO config_snapshots (user_id, name, file_count, bytes, envelope_version, envelope)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING snapshot_id::text, name, file_count, bytes, envelope_version, revision, created_at, updated_at
	`, user.ID, input.Name, input.FileCount, len(envelopeBytes), input.EnvelopeVersion, envelopeBytes)
	}
	err = row.Scan(
		&item.SnapshotID, &item.Name, &item.FileCount, &item.Bytes, &item.EnvelopeVersion,
		&item.Revision, &item.CreatedAt, &item.UpdatedAt,
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
