package server

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"time"

	"koinote/backend/internal/httpx"
)

const (
	shareReadIPLimit = 120
	// The global budget only bounds limiter memory and total work; the slots
	// below protect the database pool. Keep it far above organic traffic (each
	// visit spends two reads: edge metadata and the SPA document request).
	shareReadGlobalLimit = 12000
	shareReadConcurrency = 4 // The main pool has 10 connections; leave room for authenticated work.
	shareReadWindow      = time.Minute
	shareReadTimeout     = 3 * time.Second
)

var shareTokenPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)

// All public share reads, including metadata and password verification, share
// one budget. No token-dependent limiter keys: random tokens must not grow memory.
func (a *App) beginShareRead(w http.ResponseWriter, r *http.Request) (*http.Request, func(), bool) {
	setShareResponseHeaders(w)
	if !shareTokenPattern.MatchString(r.PathValue("token")) {
		httpx.ErrorCode(w, http.StatusNotFound, "share_not_found", "Share link not found")
		return r, nil, false
	}
	limiter := a.rateLimit()
	if !limiter.allowWithGlobal("share-read:ip:"+a.publicRepositoryRequestIP(r), shareReadIPLimit,
		"share-read:global", shareReadGlobalLimit, shareReadWindow) {
		w.Header().Set("Retry-After", "60")
		tooManyAttempts(w)
		return r, nil, false
	}
	a.shareReadOnce.Do(func() { a.shareReadSlots = make(chan struct{}, shareReadConcurrency) })
	select {
	case a.shareReadSlots <- struct{}{}:
	default:
		w.Header().Set("Retry-After", "1")
		tooManyAttempts(w)
		return r, nil, false
	}
	ctx, cancel := context.WithTimeout(r.Context(), shareReadTimeout)
	if r.Method == http.MethodPost {
		// A context deadline alone cannot interrupt a slow request-body Read.
		deadline, _ := ctx.Deadline()
		_ = http.NewResponseController(w).SetReadDeadline(deadline)
	}
	return r.WithContext(ctx), func() { cancel(); <-a.shareReadSlots }, true
}

func writeShareReadError(w http.ResponseWriter, err error) {
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		w.Header().Set("Retry-After", "1")
		httpx.ErrorCode(w, http.StatusServiceUnavailable, "share_unavailable", "Share is temporarily busy; please retry shortly")
		return
	}
	httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
}
