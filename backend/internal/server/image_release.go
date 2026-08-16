package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	"koinote/backend/internal/httpx"
)

const (
	imageReleaseBodyMax = 256 << 10
	imageReleaseKeyMax  = 1_000
)

// imageReleaseUnused 把一次失败操作已经上传、但没有写进任何正文的图片排进 GC。
// 最终删除前 GC 仍会复查当前文档和历史版本；客户端即使误报已被使用的 key，也不会裂图。
func (a *App) imageReleaseUnused(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	if !a.rateLimit().allow(fmt.Sprintf("image-release:user:%d", user.ID), 10, time.Minute) {
		httpx.ErrorCode(w, http.StatusTooManyRequests, "rate_limited", "Too many requests")
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, imageReleaseBodyMax)
	var body struct {
		Keys []string `json:"keys"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			httpx.ErrorCode(w, http.StatusRequestEntityTooLarge, "bad_request", "Request body is too large")
		} else {
			httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid request")
		}
		return
	}
	if len(body.Keys) > imageReleaseKeyMax {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Too many keys")
		return
	}

	queued, err := a.enqueueOrphanedImageKeysChecked(r.Context(), userRef{
		ID:         user.ID,
		AuthUserID: user.AuthUserID,
	}, body.Keys)
	if err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Could not schedule image cleanup")
		return
	}
	httpx.JSON(w, http.StatusAccepted, map[string]any{"queued": queued})
}
