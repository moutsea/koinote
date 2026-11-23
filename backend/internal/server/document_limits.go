package server

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"koinote/backend/internal/config"
	"koinote/backend/internal/httpx"
)

const (
	documentCreateUserLimit   = 300
	documentCreateGlobalLimit = 3000
	documentCreateConcurrency = 4
	documentCreateWindow      = time.Minute
	documentCreateTimeout     = 5 * time.Second
)

var (
	errDocumentCountLimit        = errors.New("document count limit reached (including trash); permanently delete unneeded documents and retry")
	errDocumentCreateRateLimited = errors.New("too many document or folder creation requests; retry in one minute")
)

func (a *App) documentCountLimit() int {
	if a.cfg.DocumentCountLimit > 0 {
		return a.cfg.DocumentCountLimit
	}
	return config.DefaultDocumentCountLimit
}

func (a *App) takeDocumentCreateAttempt(userID int) error {
	limiter := a.rateLimit()
	if !limiter.allowWithGlobal("document-create:user:"+strconv.Itoa(userID), documentCreateUserLimit,
		"document-create:global", documentCreateGlobalLimit, documentCreateWindow) {
		return errDocumentCreateRateLimited
	}
	return nil
}

func writeDocumentCreateLimitError(w http.ResponseWriter, err error) bool {
	if writeImageReferenceError(w, err) {
		return true
	}
	switch {
	case errors.Is(err, errFolderCountLimit):
		httpx.ErrorCode(w, http.StatusConflict, "folder_count_limit_reached", errFolderCountLimit.Error())
	case errors.Is(err, errDocumentCountLimit):
		httpx.ErrorCode(w, http.StatusConflict, "document_count_limit_reached", errDocumentCountLimit.Error())
	case errors.Is(err, errDocumentCreateRateLimited):
		w.Header().Set("Retry-After", "60")
		httpx.ErrorCode(w, http.StatusTooManyRequests, "too_many_requests", errDocumentCreateRateLimited.Error())
	default:
		return false
	}
	return true
}
