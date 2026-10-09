package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"math"
	"net/http"
	"strings"

	"koinote/backend/internal/httpx"
	"koinote/backend/internal/model"
)

var errAgentSystemStorageInvalid = errors.New("invalid system repository storage grant")

// The platform catalog uses a system grant, not a reservation from personal
// storage. A minimum makes retries and partial catalog imports idempotent and
// preserves any larger grant already assigned to the managing account.
func (a *App) grantAgentRepositorySystemStorage(ctx context.Context, user model.User, minimumBonusBytes int64) (agentWorkspaceStorageView, error) {
	if !user.IsAdmin || minimumBonusBytes <= 0 {
		return agentWorkspaceStorageView{}, errAgentSystemStorageInvalid
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return agentWorkspaceStorageView{}, err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, user.ID); err != nil {
		return agentWorkspaceStorageView{}, err
	}
	view, err := a.loadAgentWorkspaceStorage(ctx, tx, user)
	if err != nil {
		return view, err
	}
	if minimumBonusBytes > math.MaxInt64-agentWorkspaceDefaultQuotaBytes-view.AllocatedBytes {
		return view, errAgentSystemStorageInvalid
	}
	previous := view.BonusBytes
	view.BonusBytes = max(previous, minimumBonusBytes)
	if view.BonusBytes != previous {
		if _, err = tx.Exec(ctx, `
			INSERT INTO agent_workspace_storage_quotas (user_id, bonus_bytes)
			VALUES ($1, $2)
			ON CONFLICT (user_id) DO UPDATE
			SET bonus_bytes = EXCLUDED.bonus_bytes, updated_at = now()
		`, user.ID, view.BonusBytes); err != nil {
			return view, err
		}
		view.QuotaBytes += view.BonusBytes - previous
	}
	if err = tx.Commit(ctx); err != nil {
		return view, err
	}
	if view.BonusBytes != previous {
		log.Printf("system repository storage grant: admin_user_id=%d previous_bonus_bytes=%d bonus_bytes=%d", user.ID, previous, view.BonusBytes)
	}
	return view, nil
}

func (a *App) agentRepositorySystemStoragePut(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	// requireAdmin accepts browser/desktop sessions, never repository/MCP tokens.
	user, ok := a.requireAdmin(w, r)
	if !ok {
		return
	}
	var input struct {
		OwnerEmail        string `json:"ownerEmail"`
		MinimumBonusBytes int64  `json:"minimumBonusBytes"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil || decoder.Decode(new(any)) != io.EOF || input.MinimumBonusBytes <= 0 {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_system_storage_grant", errAgentSystemStorageInvalid.Error())
		return
	}
	if !strings.EqualFold(strings.TrimSpace(input.OwnerEmail), user.Email) {
		httpx.ErrorCode(w, http.StatusConflict, "system_storage_owner_mismatch", "The managing account does not match the authenticated administrator")
		return
	}
	view, err := a.grantAgentRepositorySystemStorage(r.Context(), user, input.MinimumBonusBytes)
	if errors.Is(err, errAgentSystemStorageInvalid) {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_system_storage_grant", err.Error())
	} else if err != nil {
		writeAgentWorkspaceError(w, err)
	} else {
		httpx.JSON(w, http.StatusOK, map[string]any{"storage": view})
	}
}
