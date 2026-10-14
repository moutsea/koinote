package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"slices"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"koinote/backend/internal/httpx"
)

type organizationRequest struct {
	ProviderMode       string   `json:"providerMode"`
	MaxReservedCredits *int64   `json:"maxReservedCredits"`
	RequestID          string   `json:"requestId"`
	IncludeOrganized   bool     `json:"includeOrganized"`
	ExcludeDocIDs      []string `json:"excludeDocIds"`
	// DocIDs, when present (even empty), is the exact set the user picked in
	// the document tree. Absent means the legacy organized-state filter.
	DocIDs []string `json:"docIds"`
}

// A picked document ID is ~40 JSON bytes; leave room for whole libraries.
const organizationRequestLimit = 1 << 20

func decodeOrganizationRequest(w http.ResponseWriter, r *http.Request, dest any, limit int64) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, limit))
	decoder.DisallowUnknownFields()
	err := decoder.Decode(dest)
	if err == nil {
		var extra any
		err = decoder.Decode(&extra)
		if errors.Is(err, io.EOF) {
			return true
		}
	}
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		httpx.ErrorCode(w, 413, "content_too_large", "Request too large")
	} else {
		httpx.ErrorCode(w, 400, "invalid_organization", "Invalid organization request")
	}
	return false
}
func writeOrganizationError(w http.ResponseWriter, err error) {
	var databaseError *pgconn.PgError
	if errors.As(err, &databaseError) && (databaseError.Code == "40001" || databaseError.Code == "40P01") {
		err = errOrganizationBusy
	}

	switch {
	case errors.Is(err, errOrganizationBusy):
		w.Header().Set("Retry-After", "1")
		httpx.ErrorCode(w, 503, "organization_busy", "Please retry this preview; regeneration is not needed")
	case errors.Is(err, errOrganizationAmbiguousFolder):
		httpx.ErrorCode(w, 409, "organization_ambiguous_folder", "Multiple folders have this name; select the existing destination instead of entering its name as a new folder")
	case errors.Is(err, errOrganizationNoActiveDocuments):
		httpx.ErrorCode(w, 409, "organization_no_active_documents", "All selected documents are in trash")
	case errors.Is(err, errOrganizationConflict):
		httpx.ErrorCode(w, 409, "organization_conflict", "Documents or folders changed; generate a new preview")
	case errors.Is(err, errOrganizationInput):
		httpx.ErrorCode(w, 400, "invalid_organization", "Invalid organization choices")
	case errors.Is(err, pgx.ErrNoRows):
		httpx.ErrorCode(w, 404, "not_found", "Organization not found")
	case errors.Is(err, errInsufficientCredits):
		httpx.ErrorCode(w, 402, "insufficient_credits", "Not enough credits")
	default:
		log.Printf("document organization: %v", err)
		httpx.ErrorCode(w, 500, "server_error", "Organization failed; try again later")
	}
}
func (a *App) organizationExpire(ctx context.Context, userID int) error {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, userID); err != nil {
		return err
	}
	if err = expireOrganizationsTx(ctx, tx, userID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func expireOrganizationsTx(ctx context.Context, tx pgx.Tx, userID int) error {
	rows, err := tx.Query(ctx, `UPDATE document_organizations SET status='failed',error_code='organization_timeout',updated_at=now() WHERE user_id=$1 AND status='running' AND created_at < $2 RETURNING reservation_id`, userID, time.Now().Add(-organizationRunLimit-2*time.Minute))
	if err != nil {
		return err
	}
	var reservations []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		if id != "" {
			reservations = append(reservations, id)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, id := range reservations {
		if _, err := releaseCreditReservationTx(ctx, tx, userID, id); err != nil {
			return err
		}
	}
	return nil
}

type organizationAppliedSummary struct {
	ID        string    `json:"id"`
	AppliedAt time.Time `json:"appliedAt"`
}

func loadLastOrganizationMutation(ctx context.Context, db interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}, userID int) (organizationAppliedSummary, string, error) {
	var result organizationAppliedSummary
	var status string
	err := db.QueryRow(ctx, `SELECT organization_id::text,updated_at,status FROM document_organizations WHERE user_id=$1 AND status IN ('applied','undone') ORDER BY updated_at DESC,organization_id DESC LIMIT 1`, userID).Scan(&result.ID, &result.AppliedAt, &status)
	return result, status, err
}

func (a *App) documentOrganizationLatest(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	if err := a.organizationExpire(r.Context(), user.ID); err != nil {
		writeOrganizationError(w, err)
		return
	}
	var id string
	err := a.db.QueryRow(r.Context(), `SELECT organization_id::text FROM document_organizations WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`, user.ID).Scan(&id)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.JSON(w, 200, map[string]any{"organization": nil, "lastApplied": nil})
		return
	}
	if err != nil {
		writeOrganizationError(w, err)
		return
	}
	view, err := a.loadOrganization(r.Context(), user.ID, id)
	if err != nil {
		writeOrganizationError(w, err)
		return
	}
	// Preview generation (including a failed attempt) must not hide the last
	// applied run. Undo is one level: an undone mutation does not expose an
	// older run whose version guards may no longer match.
	applied, mutationStatus, err := loadLastOrganizationMutation(r.Context(), a.db, user.ID)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		writeOrganizationError(w, err)
		return
	}
	var lastApplied *organizationAppliedSummary
	if err == nil && mutationStatus == "applied" {
		lastApplied = &applied
	}
	httpx.JSON(w, 200, map[string]any{"organization": view, "lastApplied": lastApplied})
}
func (a *App) documentOrganizationGet(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	id := r.PathValue("organizationId")
	if !validUUID(id) {
		writeOrganizationError(w, pgx.ErrNoRows)
		return
	}
	if err := a.organizationExpire(r.Context(), user.ID); err != nil {
		writeOrganizationError(w, err)
		return
	}
	view, err := a.loadOrganization(r.Context(), user.ID, id)
	if err != nil {
		writeOrganizationError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"organization": view})
}
func (a *App) documentOrganizationEstimate(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	if !a.rateLimit().allow(fmt.Sprintf("organization-estimate:%d", user.ID), 30, 5*time.Minute) {
		httpx.ErrorCode(w, 429, "rate_limited", "Try again later")
		return
	}
	var input organizationRequest
	if !decodeOrganizationRequest(w, r, &input, organizationRequestLimit) {
		return
	}
	data, _, err := a.prepareOrganizationScope(r.Context(), user.ID, input.IncludeOrganized, input.ExcludeDocIDs, input.DocIDs)
	if err != nil {
		writeOrganizationError(w, err)
		return
	}
	mode, err := a.loadAgentProviderMode(r.Context(), user.ID)
	if err != nil {
		writeOrganizationError(w, err)
		return
	}
	if mode != "builtin" {
		data.ReservedCredits = 0
	}
	httpx.JSON(w, 200, map[string]any{"count": len(data.Items), "skipped": data.Skipped, "reservedCredits": data.ReservedCredits, "providerMode": mode})
}
func (a *App) documentOrganizationCreate(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	var input organizationRequest
	if !decodeOrganizationRequest(w, r, &input, organizationRequestLimit) {
		return
	}
	if !validUUID(input.RequestID) {
		writeOrganizationError(w, errOrganizationInput)
		return
	}
	// Retrying a lost response always resumes the same job, including failed jobs.
	existing, err := a.loadOrganization(r.Context(), user.ID, input.RequestID)
	if err == nil {
		httpx.JSON(w, 200, map[string]any{"organization": existing})
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		writeOrganizationError(w, err)
		return
	}
	if !a.rateLimit().allow(fmt.Sprintf("organization-create:%d", user.ID), 6, 5*time.Minute) {
		httpx.ErrorCode(w, 429, "rate_limited", "Try again later")
		return
	}
	data, prompts, err := a.prepareOrganizationScope(r.Context(), user.ID, input.IncludeOrganized, input.ExcludeDocIDs, input.DocIDs)
	if err != nil {
		writeOrganizationError(w, err)
		return
	}
	mode, err := a.loadAgentProviderMode(r.Context(), user.ID)
	if err != nil {
		writeOrganizationError(w, err)
		return
	}
	data.ProviderMode = mode
	if input.ProviderMode != mode || (mode == "builtin" && (input.MaxReservedCredits == nil || *input.MaxReservedCredits < data.ReservedCredits)) {
		httpx.ErrorCode(w, 409, "organization_estimate_changed", "Refresh the estimate before starting")
		return
	}
	var provider agentLLMProvider
	if len(prompts) > 0 {
		provider, _, err = a.resolveAgentLLMProvider(r.Context(), user, mode, "")
		if err != nil {
			a.writeAgentProviderResolveError(w, err)
			return
		}
	}
	if mode != "builtin" {
		data.ReservedCredits = 0
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		writeOrganizationError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	if _, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock($1)`, user.ID); err != nil {
		writeOrganizationError(w, err)
		return
	}
	err = expireOrganizationsTx(r.Context(), tx, user.ID)
	if err != nil {
		writeOrganizationError(w, err)
		return
	}
	// Serialize concurrent starts across tabs. Resume an existing run instead of charging twice.
	var runningID string
	err = tx.QueryRow(r.Context(), `SELECT organization_id::text FROM document_organizations WHERE user_id=$1 AND (status='running' OR organization_id=$2::uuid) ORDER BY created_at DESC LIMIT 1`, user.ID, input.RequestID).Scan(&runningID)
	if err == nil {
		_ = tx.Rollback(r.Context())
		view, e := a.loadOrganization(r.Context(), user.ID, runningID)
		if e != nil {
			writeOrganizationError(w, e)
			return
		}
		httpx.JSON(w, 200, map[string]any{"organization": view})
		return
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		writeOrganizationError(w, err)
		return
	}
	if err := validateOrganizationDocuments(r.Context(), tx, user.ID, data); err != nil {
		writeOrganizationError(w, err)
		return
	}
	raw, _ := json.Marshal(data)
	status := "running"
	if len(prompts) == 0 {
		status = "ready"
	}
	_, err = tx.Exec(r.Context(), `INSERT INTO document_organizations(organization_id,user_id,status,data) VALUES($1::uuid,$2,$3,$4::jsonb)`, input.RequestID, user.ID, status, string(raw))
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		writeOrganizationError(w, err)
		return
	}
	reservationID := ""
	if data.ReservedCredits > 0 {
		reservation, e := a.reserveStandaloneCredits(r.Context(), user.ID, data.ReservedCredits, organizationRunLimit+2*time.Minute)
		if e != nil {
			a.failOrganization(user.ID, input.RequestID, "insufficient_credits", "")
			writeOrganizationError(w, e)
			return
		}
		reservationID = reservation.ReservationID
		var result pgconn.CommandTag
		result, err = a.db.Exec(r.Context(), `UPDATE document_organizations SET reservation_id=$2 WHERE organization_id=$1::uuid AND status='running'`, input.RequestID, reservationID)
		if err == nil && result.RowsAffected() != 1 {
			err = errOrganizationConflict
		}
		if err != nil {
			a.failOrganization(user.ID, input.RequestID, "server_error", reservationID)
			writeOrganizationError(w, err)
			return
		}
	}
	if len(prompts) > 0 {
		go a.runOrganization(user.ID, input.RequestID, data, prompts, provider, reservationID)
	}
	view, err := a.loadOrganization(r.Context(), user.ID, input.RequestID)
	if err != nil {
		writeOrganizationError(w, err)
		return
	}
	httpx.JSON(w, http.StatusAccepted, map[string]any{"organization": view})
}
func (a *App) failOrganization(userID int, id, code, reservationID string) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if reservationID != "" {
		if _, err := a.releaseCreditReservation(ctx, userID, reservationID); err != nil {
			log.Printf("organization release credits: %v", err)
		}
	}
	if _, err := a.db.Exec(ctx, `UPDATE document_organizations SET status='failed',error_code=$3,updated_at=now() WHERE user_id=$1 AND organization_id=$2::uuid AND status='running'`, userID, id, code); err != nil {
		log.Printf("organization failure: %v", err)
	}
}
func (a *App) runOrganization(userID int, id string, data organizationData, prompts []agentLLMPrompt, provider agentLLMProvider, reservationID string) {
	ctx, cancel := context.WithTimeout(context.Background(), organizationRunLimit)
	defer cancel()
	a.runOrganizationWithContext(ctx, userID, id, data, prompts, provider, reservationID)
}

func (a *App) runOrganizationWithContext(ctx context.Context, userID int, id string, data organizationData, prompts []agentLLMPrompt, provider agentLLMProvider, reservationID string) {
	var total, billable agentLLMResult
	consecutiveUnbilled := 0
	obsolete := organizationObsoleteFolderIDs(data.TimeFolders)
	for batch, prompt := range prompts {
		prompt = organizationPromptWithPrior(prompt, data.Items[:batch*organizationBatchSize])
		start := batch * organizationBatchSize
		end := min(start+organizationBatchSize, len(data.Items))
		result, err := a.generateOrganizationBatch(ctx, userID, id, prompt, data.Items[start:end], data.Folders, provider)
		suggestions := retargetOrganizationSuggestions(result.Suggestions, data.Items[start:end], data.Folders, obsolete)
		if err == nil {
			err = addAgentLLMUsage(&total, result.Usage)
		}
		if err == nil {
			if slices.ContainsFunc(suggestions, func(s organizationSuggestion) bool { return !s.NeedsReview }) {
				err = addAgentLLMUsage(&billable, result.AcceptedUsage)
				consecutiveUnbilled = 0
			} else {
				// A batch with no usable suggestions costs no platform credits.
				// BYOK provider charges are outside Koinote's billing control.
				data.UnbilledBatches++
				consecutiveUnbilled++
			}
		}
		if err != nil {
			log.Printf("organization generate id=%s reason=%s", id, organizationGenerationErrorKind(err))
			if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
				data.StopReason = "timeout"
				break
			}
			a.failOrganization(userID, id, "organization_generation_failed", reservationID)
			return
		}
		for _, s := range suggestions {
			for i := start; i < end; i++ {
				if data.Items[i].DocID == s.DocID {
					choice := s.organizationChoice
					data.Items[i].Suggested = &choice
					data.Items[i].Reason = s.Reason
					data.Items[i].NeedsReview = s.NeedsReview
					data.Items[i].FailureStatus = result.FailureStatus
				}
			}
		}
		data.Completed = end
		if consecutiveUnbilled >= organizationMaxConsecutiveUnbilledBatches && end < len(data.Items) {
			data.StopReason = "failure_limit"
			break
		}
		// A streak alone allows alternating successful and free failed batches
		// indefinitely. Give small runs a grace window, then cap failures at 50%.
		if batch+1 >= organizationFailureRatioMinBatches && data.UnbilledBatches*2 >= batch+1 && end < len(data.Items) {
			data.StopReason = "failure_ratio"
			break
		}
		raw, _ := json.Marshal(data)
		resultUpdate, err := a.db.Exec(ctx, `UPDATE document_organizations SET data=$3::jsonb,updated_at=now() WHERE user_id=$1 AND organization_id=$2::uuid AND status='running'`, userID, id, string(raw))
		if err != nil || resultUpdate.RowsAffected() != 1 {
			if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
				data.StopReason = "timeout"
				break
			}
			a.failOrganization(userID, id, "server_error", reservationID)
			return
		}
	}
	if data.StopReason != "" {
		log.Printf("organization partial id=%s completed=%d total=%d reason=%s", id, data.Completed, len(data.Items), data.StopReason)
		for i := data.Completed; i < len(data.Items); i++ {
			suggestion := organizationFallback(data.Items[i])
			data.Items[i].Suggested = &suggestion.organizationChoice
			data.Items[i].NeedsReview = true
			data.Items[i].NotAnalyzed = true
		}
	}
	// Charge and publish the usable preview in the same transaction.
	finishCtx, finishCancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer finishCancel()
	tx, err := a.db.Begin(finishCtx)
	if err != nil {
		a.failOrganization(userID, id, "server_error", reservationID)
		return
	}
	defer tx.Rollback(finishCtx)
	var status string
	err = tx.QueryRow(finishCtx, `SELECT status FROM document_organizations WHERE user_id=$1 AND organization_id=$2::uuid FOR UPDATE`, userID, id).Scan(&status)
	if err == nil && status != "running" {
		err = errOrganizationConflict
	}
	var charged int64
	if err == nil && reservationID != "" {
		if billable.TotalTokens == 0 {
			_, err = releaseCreditReservationTx(finishCtx, tx, userID, reservationID)
		} else {
			_, charged, err = commitCreditReservationTx(finishCtx, tx, userID, reservationID, billable.TotalTokens, map[string]any{
				"organizationId": id, "model": provider.Model, "providerTokens": total.TotalTokens,
				"billableTokens": billable.TotalTokens, "unbilledBatches": data.UnbilledBatches,
			})
		}
	}
	if err == nil {
		// The status lock above also prevents publishing retained in-memory
		// results after permanent deletion has scrubbed this task's data.
		raw, marshalErr := json.Marshal(data)
		err = marshalErr
		if err == nil {
			_, err = tx.Exec(finishCtx, `UPDATE document_organizations SET status='ready',credits_charged=$3,data=$4::jsonb,updated_at=now() WHERE user_id=$1 AND organization_id=$2::uuid`, userID, id, charged, string(raw))
		}
	}
	if err == nil {
		err = tx.Commit(finishCtx)
	}
	if err != nil {
		_ = tx.Rollback(finishCtx)
		log.Printf("organization finalize: %v", err)
		a.failOrganization(userID, id, "server_error", reservationID)
	}
}
