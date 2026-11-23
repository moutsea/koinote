package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"koinote/backend/internal/config"
)

func TestImageUploadRollbackMigrationPreservesExistingQueue(t *testing.T) {
	pool, userID := newCreditTestUser(t)
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `CREATE TEMP TABLE pending_image_deletions
		(LIKE public.pending_image_deletions INCLUDING ALL) ON COMMIT DROP;
		ALTER TABLE pending_image_deletions DROP COLUMN upload_aborted_at;`); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, `INSERT INTO pending_image_deletions(object_key,user_id,attempts,last_error)
		VALUES('existing-queue-item',$1,3,'retry later')`, userID); err != nil {
		t.Fatal(err)
	}
	migration, err := os.ReadFile("../../migrations/0124_image_upload_rollbacks.sql")
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if _, err = tx.Exec(ctx, string(migration)); err != nil {
			t.Fatal(err)
		}
	}
	var attempts int
	var lastError string
	var aborted *time.Time
	if err = tx.QueryRow(ctx, `SELECT attempts,last_error,upload_aborted_at FROM pending_image_deletions
		WHERE object_key='existing-queue-item' AND user_id=$1`, userID).Scan(&attempts, &lastError, &aborted); err != nil || attempts != 3 || lastError != "retry later" || aborted != nil {
		t.Fatalf("migration changed existing queue: %d %q %v %v", attempts, lastError, aborted, err)
	}
}

func TestImageUploadRollbackReleasesQuotaAndRejectsLateRecord(t *testing.T) {
	pool, userID := newCreditTestUser(t)
	a := New(config.Config{SessionSecret: "rollback-test", InternalToken: "rollback-internal"}, pool)
	user := loadAgentReviewTestUser(t, a, pool, userID)
	ctx := context.Background()
	key := "u/" + user.AuthUserID + "/0123456789abcdef.png"
	expires := time.Now().Add(importImageTTL)
	if _, err := a.recordImageObject(ctx, user.ID, key, 68, a.storageQuotaFor(user), imagePurposePersistent, &expires); err != nil {
		t.Fatal(err)
	}
	request := func(internal bool, deleted bool, target string) *httptest.ResponseRecorder {
		t.Helper()
		body, _ := json.Marshal(map[string]any{"key": target, "deleted": deleted})
		r := httptest.NewRequest("POST", "/api/images/rollback", strings.NewReader(string(body)))
		if internal {
			r.Header.Set("X-Koinote-Internal-Token", a.cfg.InternalToken)
			r.Header.Set("X-Auth-User-Id", user.AuthUserID)
		} else {
			r.Header.Set("X-Koinote-Internal-Token", a.cfg.InternalToken) // Public proxy adds this too.
			r.AddCookie(sessionCookieFor(t, a, user.AuthUserID, user.SessionVersion))
		}
		w := httptest.NewRecorder()
		a.Routes().ServeHTTP(w, r)
		return w
	}
	if w := request(false, true, key); w.Code != 401 {
		t.Fatalf("browser could clear quota: %d", w.Code)
	}
	if w := request(true, true, "u/another-account/0123456789abcdef.png"); w.Code != 400 {
		t.Fatalf("cross-account rollback: %d", w.Code)
	}
	for _, deleted := range []bool{false, false, true, true} {
		w := request(true, deleted, key)
		if w.Code != 200 || !strings.Contains(w.Body.String(), `"rollbackAllowed":true`) {
			t.Fatalf("rollback: %d %s", w.Code, w.Body.String())
		}
	}
	usage, err := a.storageUsageFor(ctx, user.ID)
	if err != nil || usage.ImageBytes != 0 {
		t.Fatalf("phantom quota: %d %v", usage.ImageBytes, err)
	}
	if _, err := a.recordImageObject(ctx, user.ID, key, 68, a.storageQuotaFor(user), imagePurposePersistent, &expires); !errors.Is(err, errImageUploadAborted) {
		t.Fatalf("late record restored rolled-back quota: %v", err)
	}
	var queued int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM pending_image_deletions WHERE object_key=$1 AND upload_aborted_at IS NOT NULL AND next_try_at>now()+interval '23 hours'`, key).Scan(&queued); err != nil || queued != 1 {
		t.Fatalf("no durable rollback guard: %d %v", queued, err)
	}
	// A new random upload can use the freed quota, and persisted references
	// veto rollback before the Worker deletes anything.
	other := "u/" + user.AuthUserID + "/fedcba9876543210.png"
	if _, err := a.recordImageObject(ctx, user.ID, other, 68, a.storageQuotaFor(user), imagePurposePersistent, &expires); err != nil {
		t.Fatal(err)
	}
	if _, err := a.createDocument(ctx, createDocumentParams{User: user, Content: "![saved](/images/" + other + ")"}); err != nil {
		t.Fatal(err)
	}
	if w := request(true, false, other); w.Code != 200 || !strings.Contains(w.Body.String(), `"rollbackAllowed":false`) {
		t.Fatalf("saved reference not protected: %d %s", w.Code, w.Body.String())
	}
}

func TestImageUploadRollbackGCRetryAndGuardExpiry(t *testing.T) {
	pool, userID := newCreditTestUser(t)
	a := New(config.Config{InternalToken: "rollback-gc"}, pool)
	user := loadAgentReviewTestUser(t, a, pool, userID)
	ctx := context.Background()
	key := "u/" + user.AuthUserID + "/0123456789abcdef.png"
	expires := time.Now().Add(importImageTTL)
	if _, err := a.recordImageObject(ctx, user.ID, key, 68, a.storageQuotaFor(user), imagePurposePersistent, &expires); err != nil {
		t.Fatal(err)
	}
	if ok, err := a.rollbackImageUpload(ctx, user.ID, key, false); err != nil || !ok {
		t.Fatalf("abort registration: %v %v", ok, err)
	}
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("x-koinote-internal-token") != a.cfg.InternalToken {
			t.Error("missing internal authentication")
		}
		json.NewEncoder(w).Encode(map[string]any{"deleted": []string{key}, "rejected": []string{}})
	}))
	defer worker.Close()
	a.cfg.WorkerURL = worker.URL
	if err := a.runImageGCOnce(ctx); err != nil {
		t.Fatal(err)
	}
	usage, err := a.storageUsageFor(ctx, user.ID)
	if err != nil || usage.ImageBytes != 0 {
		t.Fatalf("GC did not clear quota: %d %v", usage.ImageBytes, err)
	}
	if _, err := a.recordImageObject(ctx, user.ID, key, 68, a.storageQuotaFor(user), imagePurposePersistent, &expires); !errors.Is(err, errImageUploadAborted) {
		t.Fatalf("GC discarded abort guard too early: %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE pending_image_deletions SET upload_aborted_at=now()-interval '25 hours',next_try_at=now()-interval '1 second' WHERE object_key=$1`, key); err != nil {
		t.Fatal(err)
	}
	if err := a.runImageGCOnce(ctx); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM pending_image_deletions WHERE object_key=$1`, key).Scan(&count); err != nil || count != 0 {
		t.Fatalf("expired guard retained: %d %v", count, err)
	}
}

func TestImageQuotaRefusalRollbackRemainsCollectible(t *testing.T) {
	pool, userID := newCreditTestUser(t)
	a := New(config.Config{InternalToken: "quota-rollback"}, pool)
	user := loadAgentReviewTestUser(t, a, pool, userID)
	ctx := context.Background()
	key := "u/" + user.AuthUserID + "/0123456789abcdef.png"
	if _, err := a.recordImageObject(ctx, user.ID, key, 68, 1, imagePurposePersistent, nil); !errors.Is(err, errQuotaExceeded) {
		t.Fatalf("expected quota refusal: %v", err)
	}
	if allowed, err := a.rollbackImageUpload(ctx, user.ID, key, false); err != nil || !allowed {
		t.Fatalf("schedule failed: %v %v", allowed, err)
	}
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"deleted": []string{key}, "rejected": []string{}})
	}))
	defer worker.Close()
	a.cfg.WorkerURL = worker.URL
	if err := a.runImageGCOnce(ctx); err != nil {
		t.Fatal(err)
	}
	var queued int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM pending_image_deletions WHERE object_key=$1 AND upload_aborted_at IS NOT NULL AND next_try_at>now()`, key).Scan(&queued); err != nil || queued != 1 {
		t.Fatalf("GC lost guard for unrecorded object: %d %v", queued, err)
	}
}

func TestImageTemporaryQuotaRollbackRejectsLateRecord(t *testing.T) {
	pool, userID := newCreditTestUser(t)
	a := New(config.Config{}, pool)
	ctx := context.Background()
	user := loadAgentReviewTestUser(t, a, pool, userID)
	key := "u/" + user.AuthUserID + "/" + strings.Repeat("a", 64) + ".png"
	for _, deleted := range []bool{false, false, true, true} {
		if allowed, err := a.rollbackImageUploadWithPurpose(ctx, userID, key, deleted, imagePurposeWechatExport); err != nil || !allowed {
			t.Fatalf("temporary rollback: %v %v", allowed, err)
		}
	}
	expires := time.Now().Add(wechatExportImageTTL)
	if _, err := a.recordImageObject(ctx, userID, key, 68, 100, imagePurposeWechatExport, &expires); !errors.Is(err, errImageUploadAborted) {
		t.Fatalf("late temporary record was accepted: %v", err)
	}
	fresh := "u/" + user.AuthUserID + "/" + strings.Repeat("b", 32) + ".png"
	if _, err := a.recordImageObject(ctx, userID, fresh, 68, 100, imagePurposeWechatExport, &expires); err != nil {
		t.Fatalf("fresh temporary upload failed: %v", err)
	}
	var guarded bool
	if err := pool.QueryRow(ctx, `SELECT upload_aborted_at IS NOT NULL FROM pending_image_deletions WHERE object_key=$1`, key).Scan(&guarded); err != nil || !guarded {
		t.Fatalf("missing temporary abort protection: %v %v", guarded, err)
	}
}
