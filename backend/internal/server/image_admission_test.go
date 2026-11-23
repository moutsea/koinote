package server

import (
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"koinote/backend/internal/config"
)

func TestImageWriteAdmissionBudgets(t *testing.T) {
	a := New(config.Config{}, nil)
	for i := 0; i < imageWriteUserMinuteLimit; i++ {
		if delay := a.takeImageWriteAttempt(1); delay != 0 {
			t.Fatalf("normal upload %d rejected: %s", i, delay)
		}
	}
	for i := 0; i < 100; i++ {
		if delay := a.takeImageWriteAttempt(1); delay <= 0 || delay > time.Minute {
			t.Fatalf("missing actor minute limit: %s", delay)
		}
	}
	limiter := a.rateLimit()
	if got := limiter.entries["image-write:global:minute"].count; got != imageWriteUserMinuteLimit {
		t.Fatalf("refused actor spent global budget: %d", got)
	}
	if delay := a.takeImageWriteAttempt(2); delay != 0 {
		t.Fatalf("other account rejected: %s", delay)
	}
	limiter.entries["image-write:user:1:minute"].expiresAt = time.Now().Add(-time.Second)
	limiter.entries["image-write:user:1:day"].count = imageWriteUserDayLimit
	if delay := a.takeImageWriteAttempt(1); delay <= time.Hour {
		t.Fatalf("day budget not enforced: %s", delay)
	}
	before := len(limiter.entries)
	limiter.entries["image-write:global:minute"].count = imageWriteGlobalMinuteLimit
	for i := 10; i < 1000; i++ {
		if delay := a.takeImageWriteAttempt(i); delay <= 0 {
			t.Fatal("global budget bypassed")
		}
	}
	if len(limiter.entries) != before {
		t.Fatal("global refusal allocated actor buckets")
	}
}

func TestImageWriteAdmissionRequiresWorkerIdentity(t *testing.T) {
	pool, userID := newCreditTestUser(t)
	a := New(config.Config{SessionSecret: "admission-test", InternalToken: "admission-internal"}, pool)
	user := loadAgentReviewTestUser(t, a, pool, userID)
	call := func(canonical bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/api/images/admit", nil)
		r.Header.Set("X-Koinote-Internal-Token", a.cfg.InternalToken)
		if canonical {
			r.Header.Set("X-Auth-User-Id", user.AuthUserID)
		} else {
			r.AddCookie(sessionCookieFor(t, a, user.AuthUserID, user.SessionVersion))
		}
		w := httptest.NewRecorder()
		a.Routes().ServeHTTP(w, r)
		return w
	}
	if w := call(false); w.Code != 401 {
		t.Fatalf("browser minted admission: %d", w.Code)
	}
	for i := 0; i < imageWriteUserMinuteLimit; i++ {
		if w := call(true); w.Code != 204 {
			t.Fatalf("admission %d: %d %s", i, w.Code, w.Body.String())
		}
	}
	w := call(true)
	seconds, err := strconv.Atoi(w.Header().Get("Retry-After"))
	if w.Code != 429 || err != nil || seconds < 1 || seconds > 60 {
		t.Fatalf("bad retry contract: %d %q %s", w.Code, w.Header().Get("Retry-After"), w.Body.String())
	}
}
