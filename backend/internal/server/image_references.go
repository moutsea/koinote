package server

import (
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5/pgconn"
	"koinote/backend/internal/httpx"
)

func isImageReferenceUnavailable(err error) bool {
	var databaseError *pgconn.PgError
	return errors.As(err, &databaseError) && databaseError.Code == "KNI01"
}

func writeImageReferenceError(w http.ResponseWriter, err error) bool {
	if !isImageReferenceUnavailable(err) {
		return false
	}
	httpx.ErrorCode(w, http.StatusConflict, "image_unavailable", "An image has expired or is being removed; upload it again before saving")
	return true
}
