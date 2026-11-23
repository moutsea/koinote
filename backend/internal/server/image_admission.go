package server

import (
	"context"
	"net/http"
	"strconv"
	"strings"
	"time"

	"koinote/backend/internal/httpx"
)

const (
	imageWriteUserMinuteLimit   = 120
	imageWriteGlobalMinuteLimit = 1200
	imageWriteUserDayLimit      = 2000
)

// Called by the Worker before uploading bytes or fetching an external image.
// These count attempts, including quota refusals; R2 storage quota alone
// cannot bound write-operation costs. Like our other admission limits, budgets
// are shared within this Go process and reset on restart (not a billing cap).
func (a *App) imageAdmit(w http.ResponseWriter, r *http.Request) {
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
	if retryAfter := a.takeImageWriteAttempt(user.ID); retryAfter > 0 {
		w.Header().Set("Retry-After", strconv.Itoa(int((retryAfter+time.Second-1)/time.Second)))
		w.Header().Set("Cache-Control", "private, no-store")
		httpx.ErrorCode(w, http.StatusTooManyRequests, "image_rate_limited", "Too many image uploads; retry after the indicated delay")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (a *App) takeImageWriteAttempt(userID int) time.Duration {
	actor := "image-write:user:" + strconv.Itoa(userID)
	// No global daily budget: a few accounts at their own daily limit could then
	// block every user's uploads until the window expired. The per-minute global
	// budget bounds bursts; the per-account day budget bounds each account.
	return a.rateLimit().allowBudgets(
		rateBudget{actor + ":minute", imageWriteUserMinuteLimit, time.Minute},
		rateBudget{"image-write:global:minute", imageWriteGlobalMinuteLimit, time.Minute},
		rateBudget{actor + ":day", imageWriteUserDayLimit, 24 * time.Hour},
	)
}
