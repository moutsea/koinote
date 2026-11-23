package server

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"koinote/backend/internal/config"
)

func TestImportImageLeasesAndOwnership(t *testing.T) {
	pool, userID := newCreditTestUser(t)
	a := New(config.Config{SessionSecret: "import-image-test", InternalToken: "import-image-internal"}, pool)
	user := loadAgentReviewTestUser(t, a, pool, userID)
	ctx := context.Background()
	key := "u/" + user.AuthUserID + "/0123456789abcdef.png"
	missingKey := "u/" + user.AuthUserID + "/fedcba9876543210.png"
	body, _ := json.Marshal(map[string]any{"key": key, "bytes": 68, "purpose": "persistent", "import": true})
	r := httptest.NewRequest("POST", "/api/images/record", strings.NewReader(string(body)))
	r.Header.Set("X-Koinote-Internal-Token", a.cfg.InternalToken)
	r.Header.Set("X-Auth-User-Id", user.AuthUserID)
	w := httptest.NewRecorder()
	a.Routes().ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatalf("record: %d %s", w.Code, w.Body.String())
	}
	var deadline time.Time
	if err := pool.QueryRow(ctx, "SELECT next_try_at FROM pending_image_deletions WHERE object_key=$1", key).Scan(&deadline); err != nil || time.Until(deadline) < 6*24*time.Hour {
		t.Fatalf("no durable import lease: %v %v", deadline, err)
	}
	if _, err := pool.Exec(ctx, "UPDATE pending_image_deletions SET next_try_at=now()+interval '2 hours' WHERE object_key=$1", key); err != nil {
		t.Fatal(err)
	}
	retain := func(owner string, keys []string, authenticated bool) *httptest.ResponseRecorder {
		t.Helper()
		body, _ := json.Marshal(map[string]any{"keys": keys})
		r := httptest.NewRequest("POST", "/api/storage/retain-import-images", strings.NewReader(string(body)))
		r.Header.Set("X-Koinote-Import-Owner", owner)
		if authenticated {
			r.AddCookie(sessionCookieFor(t, a, user.AuthUserID, user.SessionVersion))
		}
		w := httptest.NewRecorder()
		a.Routes().ServeHTTP(w, r)
		return w
	}
	w = retain(user.AuthUserID, []string{key, missingKey}, true)
	var result struct {
		Missing    []string `json:"missingKeys"`
		Unrecorded []string `json:"unrecordedKeys"`
	}
	// A never-recorded key is reported for an object check, not as definitely missing.
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || w.Code != 200 || len(result.Missing) != 0 || len(result.Unrecorded) != 1 || result.Unrecorded[0] != missingKey {
		t.Fatalf("retain: %d %s %v", w.Code, w.Body.String(), err)
	}
	if err := pool.QueryRow(ctx, "SELECT next_try_at FROM pending_image_deletions WHERE object_key=$1", key).Scan(&deadline); err != nil || time.Until(deadline) < 6*24*time.Hour {
		t.Fatalf("lease not renewed: %v %v", deadline, err)
	}
	if _, err := pool.Exec(ctx, "UPDATE pending_image_deletions SET next_try_at=now()-interval '1 second' WHERE object_key=$1", key); err != nil {
		t.Fatal(err)
	}
	w = retain(user.AuthUserID, []string{key}, true)
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || len(result.Missing) != 1 || result.Missing[0] != key {
		t.Fatalf("a GC-eligible key was incorrectly renewed: %s", w.Body.String())
	}
	if w := retain("another-account", []string{key}, true); w.Code != 409 {
		t.Fatalf("owner mismatch: %d", w.Code)
	}
	if w := retain(user.AuthUserID, []string{key}, false); w.Code != 401 {
		t.Fatalf("owner header granted authentication: %d", w.Code)
	}
	if w := retain(user.AuthUserID, []string{"u/another-account/0123456789abcdef.png"}, true); w.Code != 400 {
		t.Fatalf("cross-owner probe accepted: %d", w.Code)
	}
	// Saving the imported image makes it durable even if a cleanup entry is due.
	if _, err := a.createDocument(ctx, createDocumentParams{User: user, Content: "![saved](/images/" + key + ")"}); err != nil {
		t.Fatal(err)
	}
	if err := a.enqueueImageDeletions(ctx, user.ID, []string{key}); err != nil {
		t.Fatal(err)
	}
	if err := a.runImageGCOnce(ctx); err != nil {
		t.Fatal(err)
	}
	var objects, queued int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM image_objects WHERE object_key=$1", key).Scan(&objects); err != nil || objects != 1 {
		t.Fatalf("saved image removed: count=%d err=%v", objects, err)
	}
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM pending_image_deletions WHERE object_key=$1", key).Scan(&queued); err != nil || queued != 0 {
		t.Fatalf("reference check did not retire cleanup: count=%d err=%v", queued, err)
	}
}

// Desktop sync asks about every image its pending documents reference. Images
// uploaded before usage was recorded (or whose record failed) have no ledger row
// yet still exist; they must not be reported as definitely missing, which made
// clients re-upload them or block the document as "local image missing".
func TestRetainSeparatesUnrecordedFromMissingImages(t *testing.T) {
	pool, userID := newCreditTestUser(t)
	a := New(config.Config{SessionSecret: "retain-states-test", InternalToken: "retain-states-internal"}, pool)
	user := loadAgentReviewTestUser(t, a, pool, userID)
	ctx := context.Background()
	key := func(c string) string { return "u/" + user.AuthUserID + "/" + strings.Repeat(c, 32) + ".png" }
	recorded, legacy, legacyQueued, legacyDue, retired, temporary := key("a"), key("b"), key("c"), key("d"), key("e"), key("f")
	// Queue rows outlive the user (ON DELETE SET NULL); a due row left behind
	// would be collected by another test's GC run.
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM pending_image_deletions WHERE object_key LIKE 'u/' || $1 || '/%'`, user.AuthUserID)
	})
	if _, err := pool.Exec(ctx, `INSERT INTO image_objects(object_key,user_id,bytes,purpose) VALUES
		($1,$3,10,'persistent'),($2,$3,10,'wechat-export')`, recorded, temporary, user.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO pending_image_deletions(object_key,user_id,next_try_at,upload_aborted_at) VALUES
		($1,$4,now()+interval '2 hours',NULL),($2,$4,now()-interval '1 second',NULL),($3,$4,now()+interval '1 hour',now())`,
		legacyQueued, legacyDue, retired, user.ID); err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]any{"keys": []string{recorded, legacy, legacyQueued, legacyDue, retired, temporary}})
	r := httptest.NewRequest("POST", "/api/storage/retain-import-images", strings.NewReader(string(body)))
	r.AddCookie(sessionCookieFor(t, a, user.AuthUserID, user.SessionVersion))
	w := httptest.NewRecorder()
	a.Routes().ServeHTTP(w, r)
	var result struct {
		Missing    []string `json:"missingKeys"`
		Unrecorded []string `json:"unrecordedKeys"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil || w.Code != 200 {
		t.Fatalf("retain: %d %s %v", w.Code, w.Body.String(), err)
	}
	if strings.Join(result.Unrecorded, ",") != legacy {
		t.Fatalf("only the unrecorded legacy image needs an object check: %v", result.Unrecorded)
	}
	if strings.Join(result.Missing, ",") != strings.Join([]string{legacyDue, retired, temporary}, ",") {
		t.Fatalf("collected, due or temporary images must be re-uploaded: %v", result.Missing)
	}
	var deadline time.Time
	if err := pool.QueryRow(ctx, `SELECT next_try_at FROM pending_image_deletions WHERE object_key=$1`, legacyQueued).Scan(&deadline); err != nil || time.Until(deadline) < 6*24*time.Hour {
		t.Fatalf("a queued legacy image still referenced by a client was not renewed: %v %v", deadline, err)
	}
}
