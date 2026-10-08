package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"koinote/backend/internal/httpx"
	"koinote/backend/internal/model"
)

var (
	errAgentStorageAllocationInvalid = errors.New("invalid repository storage allocation")
	errAgentStorageAllocationInUse   = errors.New("repository files and history still use this allocation")
	errAgentStorageAllocationFull    = errors.New("not enough personal storage to allocate")
)

type agentWorkspaceStorageView struct {
	UsedBytes          int64 `json:"usedBytes"`
	QuotaBytes         int64 `json:"quotaBytes"`
	BonusBytes         int64 `json:"bonusBytes"`
	AllocatedBytes     int64 `json:"allocatedBytes"`
	PersonalQuotaBytes int64 `json:"personalQuotaBytes"`
	PersonalUsedBytes  int64 `json:"personalUsedBytes"`
	AvailableBytes     int64 `json:"availableBytes"`
}

// This is the single privacy boundary shared by both repository token transports.
// Do not add personal-account counters here.
type agentWorkspaceQuotaView struct {
	UsedBytes      int64 `json:"usedBytes"`
	QuotaBytes     int64 `json:"quotaBytes"`
	BonusBytes     int64 `json:"bonusBytes"`
	AllocatedBytes int64 `json:"allocatedBytes"`
}

func loadAgentWorkspaceQuota(ctx context.Context, q imageUsageQuerier, userID int) (agentWorkspaceQuotaView, error) {
	var view agentWorkspaceQuotaView
	err := q.QueryRow(ctx, `SELECT agent_workspace_storage_bytes($1), agent_workspace_quota_bytes($1),
	 COALESCE((SELECT bonus_bytes FROM agent_workspace_storage_quotas WHERE user_id = $1), 0),
	 COALESCE((SELECT allocated_bytes FROM agent_workspace_storage_quotas WHERE user_id = $1), 0)
	`, userID).Scan(&view.UsedBytes, &view.QuotaBytes, &view.BonusBytes, &view.AllocatedBytes)
	return view, err
}

func (a *App) loadAgentWorkspaceStorage(ctx context.Context, q imageUsageQuerier, user model.User) (agentWorkspaceStorageView, error) {
	var view agentWorkspaceStorageView
	var usage storageBreakdown
	// Read every counter in one statement so GET responses use a single database
	// snapshot even when another client changes the allocation during the read.
	err := q.QueryRow(ctx, `
		SELECT agent_workspace_storage_bytes($1), agent_workspace_quota_bytes($1),
		       COALESCE((SELECT bonus_bytes FROM agent_workspace_storage_quotas WHERE user_id = $1), 0),
		       COALESCE((SELECT allocated_bytes FROM agent_workspace_storage_quotas WHERE user_id = $1), 0),
		       COALESCE((
		           SELECT SUM(octet_length(content) + octet_length(title) + octet_length(cover_image_source) + octet_length(cover_prompt))
		           FROM documents WHERE user_id = $1
		       ), 0),
		       COALESCE((
		           SELECT SUM(bytes) FROM image_objects WHERE user_id = $1 AND purpose = 'persistent'
		       ), 0),
		       COALESCE((SELECT SUM(bytes) FROM config_snapshots WHERE user_id = $1), 0)
	`, user.ID).Scan(
		&view.UsedBytes, &view.QuotaBytes, &view.BonusBytes,
		&usage.AgentAllocatedBytes, &usage.DocumentBytes, &usage.ImageBytes, &usage.ConfigBytes,
	)
	if err != nil {
		return view, err
	}
	view.AllocatedBytes = usage.AgentAllocatedBytes
	view.PersonalQuotaBytes = a.storageQuotaFor(user)
	view.PersonalUsedBytes = usage.Total()
	view.AvailableBytes = max(0, view.PersonalQuotaBytes-view.PersonalUsedBytes)
	return view, nil
}

func (a *App) agentWorkspaceStorageGet(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireAgentWorkspaceUser(w, r, false)
	if !ok {
		return
	}
	if token := bearerToken(r); strings.HasPrefix(token, mcpTokenPrefix) || strings.HasPrefix(token, agentTokenPrefix) {
		view, err := loadAgentWorkspaceQuota(r.Context(), a.db, user.ID)
		if err != nil {
			writeAgentWorkspaceError(w, err)
			return
		}
		httpx.JSON(w, http.StatusOK, map[string]any{"storage": view})
		return
	}
	view, err := a.loadAgentWorkspaceStorage(r.Context(), a.db, user)
	if err != nil {
		writeAgentWorkspaceError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"storage": view})
}

func (a *App) allocateAgentWorkspaceStorage(ctx context.Context, user model.User, allocatedBytes int64) (agentWorkspaceStorageView, error) {
	if allocatedBytes < 0 {
		return agentWorkspaceStorageView{}, errAgentStorageAllocationInvalid
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return agentWorkspaceStorageView{}, err
	}
	defer tx.Rollback(ctx)
	// Share the lock used by repository writes, documents, images and encrypted snapshots.
	// Reserve the entire allocation, so concurrent writers cannot consume it a second time.
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, user.ID); err != nil {
		return agentWorkspaceStorageView{}, err
	}
	view, err := a.loadAgentWorkspaceStorage(ctx, tx, user)
	if err != nil {
		return view, err
	}
	if allocatedBytes > view.AllocatedBytes && allocatedBytes-view.AllocatedBytes > view.AvailableBytes {
		return view, errAgentStorageAllocationFull
	}
	if allocatedBytes < view.AllocatedBytes && allocatedBytes < view.UsedBytes-(view.QuotaBytes-view.AllocatedBytes) {
		return view, errAgentStorageAllocationInUse
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO agent_workspace_storage_quotas (user_id, allocated_bytes)
		VALUES ($1, $2)
		ON CONFLICT (user_id) DO UPDATE
		SET allocated_bytes = EXCLUDED.allocated_bytes, updated_at = now()
	`, user.ID, allocatedBytes); err != nil {
		return view, err
	}
	view.QuotaBytes += allocatedBytes - view.AllocatedBytes
	view.PersonalUsedBytes += allocatedBytes - view.AllocatedBytes
	view.AllocatedBytes = allocatedBytes
	view.AvailableBytes = max(0, view.PersonalQuotaBytes-view.PersonalUsedBytes)
	if err := tx.Commit(ctx); err != nil {
		return view, err
	}
	return view, nil
}

func (a *App) agentWorkspaceStoragePut(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	// Allocation is an account setting; repository tokens cannot move personal storage.
	user, ok := a.requireLifetimeMember(w, r)
	if !ok || !a.requireAgentWorkspaceEnabled(w, r, user.ID) {
		return
	}
	var input struct {
		AllocatedBytes *int64 `json:"allocatedBytes"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	if err := json.NewDecoder(r.Body).Decode(&input); err != nil || input.AllocatedBytes == nil || *input.AllocatedBytes < 0 {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_storage_allocation", "Provide a non-negative allocation in bytes")
		return
	}
	view, err := a.allocateAgentWorkspaceStorage(r.Context(), user, *input.AllocatedBytes)
	switch {
	case errors.Is(err, errAgentStorageAllocationFull):
		httpx.ErrorCode(w, http.StatusConflict, "storage_allocation_insufficient", err.Error())
	case errors.Is(err, errAgentStorageAllocationInUse):
		httpx.ErrorCode(w, http.StatusConflict, "storage_allocation_in_use", err.Error())
	case err != nil:
		writeAgentWorkspaceError(w, err)
	default:
		httpx.JSON(w, http.StatusOK, map[string]any{"storage": view})
	}
}
