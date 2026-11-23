package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"koinote/backend/internal/config"
)

func TestImageReservationExpiryAndCompletionLease(t *testing.T) {
	pool, userID := newCreditTestUser(t)
	a := New(config.Config{InternalToken: "reservation-test"}, pool)
	user := loadAgentReviewTestUser(t, a, pool, userID)
	ctx := context.Background()
	key := "u/" + user.AuthUserID + "/" + strings.Repeat("a", 32) + ".png"
	call := func(target string, complete bool) {
		t.Helper()
		body, _ := json.Marshal(map[string]any{"key": target, "bytes": 68, "purpose": "persistent", "upload": true, "complete": complete})
		r := httptest.NewRequest("POST", "/api/images/record", strings.NewReader(string(body)))
		r.Header.Set("X-Koinote-Internal-Token", a.cfg.InternalToken)
		r.Header.Set("X-Auth-User-Id", user.AuthUserID)
		w := httptest.NewRecorder()
		a.Routes().ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("reservation: %d %s", w.Code, w.Body.String())
		}
	}
	call(key, false)
	var expires time.Time
	if err := pool.QueryRow(ctx, `SELECT next_try_at FROM pending_image_deletions WHERE object_key=$1`, key).Scan(&expires); err != nil || time.Until(expires) < 9*time.Minute || time.Until(expires) > 11*time.Minute {
		t.Fatalf("incomplete reservation not short-lived: %s %v", expires, err)
	}
	call(key, true)
	if err := pool.QueryRow(ctx, `SELECT next_try_at FROM pending_image_deletions WHERE object_key=$1`, key).Scan(&expires); err != nil || time.Until(expires) < 29*24*time.Hour {
		t.Fatalf("completed recovery lease not extended: %s %v", expires, err)
	}
	usage, err := a.storageUsageFor(ctx, userID)
	if err != nil || usage.ImageBytes != 68 {
		t.Fatalf("completion double charged: %d %v", usage.ImageBytes, err)
	}
	abandoned := "u/" + user.AuthUserID + "/" + strings.Repeat("b", 32) + ".png"
	call(abandoned, false)
	if _, err := pool.Exec(ctx, `UPDATE pending_image_deletions SET next_try_at=now()-interval '1 second' WHERE object_key=$1`, abandoned); err != nil {
		t.Fatal(err)
	}
	worker := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"deleted": []string{abandoned}, "rejected": []string{}})
	}))
	defer worker.Close()
	a.cfg.WorkerURL = worker.URL
	if err := a.runImageGCOnce(ctx); err != nil {
		t.Fatal(err)
	}
	usage, err = a.storageUsageFor(ctx, userID)
	if err != nil || usage.ImageBytes != 68 {
		t.Fatalf("abandoned reservation still occupies quota: %d %v", usage.ImageBytes, err)
	}
}
