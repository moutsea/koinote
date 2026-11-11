package server

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"
	"koinote/backend/internal/httpx"
	"koinote/backend/internal/model"
)

var (
	errKoiSkillConflict = errors.New("skill or preview changed; refresh and try again")
	errKoiSkillNotFound = errors.New("skill or preview not found")
	errKoiImportExpired = errors.New("preview expired; upload the folder again")
	errKoiImportState   = errors.New("preview is not ready for this action")
	errKoiUploadMissing = errors.New("a declared file was not uploaded")
	errKoiRequestReplay = errors.New("request id was used with different input")
)

// A server-side allowlist gates Skill management and new installed-library tasks.
// Owners may still inspect and remove data after their membership expires.
func (a *App) requireKoiSkillUser(w http.ResponseWriter, r *http.Request, write bool) (model.User, bool) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireUser(w, r)
	if !ok {
		return user, false
	}
	allowed := a.koiSkillAccountAllowed(user.AuthUserID)
	if !allowed {
		httpx.ErrorCode(w, http.StatusForbidden, "koi_unavailable", "Skill management is not available for this account")
		return user, false
	}
	if write && user.MembershipTier != membershipTierLifetime {
		httpx.ErrorCode(w, http.StatusForbidden, "membership_required", "Lifetime membership required")
		return user, false
	}
	return user, true
}

func writeKoiError(w http.ResponseWriter, err error) {
	var sensitive *agentWorkspaceSensitiveError
	switch {
	case errors.Is(err, errKoiSkillConflict):
		httpx.ErrorCode(w, http.StatusConflict, "revision_conflict", err.Error())
	case errors.Is(err, errKoiImportExpired):
		httpx.ErrorCode(w, http.StatusGone, "preview_expired", err.Error())
	case errors.Is(err, errKoiImportState):
		httpx.ErrorCode(w, http.StatusConflict, "preview_not_ready", err.Error())
	case errors.Is(err, errKoiRequestReplay):
		httpx.ErrorCode(w, http.StatusConflict, "idempotency_conflict", err.Error())
	case errors.Is(err, errKoiUploadMissing):
		httpx.ErrorCode(w, http.StatusBadRequest, "upload_incomplete", err.Error())
	case errors.Is(err, errKoiSkillPackage), errors.Is(err, errKoiSkillTooLarge):
		httpx.ErrorCode(w, http.StatusUnprocessableEntity, "skill_invalid", err.Error())
	case errors.Is(err, errKoiSkillNotFound), errors.Is(err, pgx.ErrNoRows):
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", errKoiSkillNotFound.Error())
	case errors.Is(err, errAgentWorkspaceQuota), errors.Is(err, errDocumentQuotaExceeded):
		httpx.ErrorCode(w, http.StatusConflict, "storage_quota_exceeded", "Cloud storage is full; free space and try again")
	case errors.As(err, &sensitive):
		httpx.ErrorCode(w, http.StatusUnprocessableEntity, "sensitive_data_detected", err.Error())
	default:
		writeAgentWorkspaceError(w, err)
	}
}

func koiParsePositiveID(raw string) (int64, bool) {
	value, err := strconv.ParseInt(raw, 10, 64)
	return value, err == nil && value > 0
}

func (a *App) koiSkillAccountAllowed(authID string) bool {
	for _, id := range a.cfg.KoiSkillTestAccounts {
		if strings.TrimSpace(id) != "" && strings.TrimSpace(id) == authID {
			return true
		}
	}
	return false
}
