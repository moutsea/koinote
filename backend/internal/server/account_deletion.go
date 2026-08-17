package server

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"koinote/backend/internal/httpx"
	"koinote/backend/internal/model"
)

const (
	accountDeletionAttempts = 5
	accountDeletionWindow   = time.Hour
)

var (
	errAccountDeletionConfirmation = errors.New("account deletion confirmation does not match")
	errAccountDeletionCheckout     = errors.New("checkout payment is being processed")
	errAccountDeletionUnavailable  = errors.New("checkout could not be verified")
)

type accountDeletionQueryer interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func (a *App) accountDelete(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	if !a.rateLimit().allow("account-delete:"+fmt.Sprint(user.ID), accountDeletionAttempts, accountDeletionWindow) {
		tooManyAttempts(w)
		return
	}
	var body struct {
		Confirmation string `json:"confirmation"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4<<10)
	if err := decodeJSONBody(r, &body); err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid request")
		return
	}
	if !strings.EqualFold(strings.TrimSpace(body.Confirmation), strings.TrimSpace(user.Email)) {
		httpx.ErrorCode(w, http.StatusBadRequest, "account_deletion_confirmation_mismatch", "Confirmation does not match")
		return
	}
	if err := a.deleteAccountData(r.Context(), user, body.Confirmation); err != nil {
		if errors.Is(err, errAccountDeletionConfirmation) {
			httpx.ErrorCode(w, http.StatusBadRequest, "account_deletion_confirmation_mismatch", "Confirmation does not match")
			return
		}
		if errors.Is(err, errAccountDeletionCheckout) {
			httpx.ErrorCode(w, http.StatusConflict, "account_deletion_payment_pending", "A payment is still being processed")
			return
		}
		if errors.Is(err, errAccountDeletionUnavailable) {
			log.Printf("account deletion checkout cleanup: %v", err)
			httpx.ErrorCode(w, http.StatusServiceUnavailable, "account_deletion_unavailable", "Account deletion is temporarily unavailable")
			return
		}
		log.Printf("account deletion: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	a.clearSessionCookie(w)
	httpx.JSON(w, http.StatusOK, map[string]bool{"success": true})
}

func (a *App) expireCheckoutBeforeAccountDeletion(ctx context.Context, userID int) error {
	return a.expireCheckoutBeforeAccountDeletionWith(ctx, a.db, userID)
}

func (a *App) expireCheckoutBeforeAccountDeletionWith(
	ctx context.Context,
	queryer accountDeletionQueryer,
	userID int,
) error {
	var sessionID string
	err := queryer.QueryRow(ctx, `
		SELECT checkout_session_id
		FROM stripe_checkout_attempts
		WHERE user_id = $1
	`, userID).Scan(&sessionID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	stripeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	removable, err := a.expireCheckoutSessionForRemoval(stripeCtx, sessionID)
	if err != nil {
		return err
	}
	if !removable {
		return errAccountDeletionCheckout
	}
	return nil
}

func (a *App) deleteAccountData(ctx context.Context, user model.User, confirmation string) error {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, user.ID); err != nil {
		return err
	}
	var currentEmail string
	if err := tx.QueryRow(ctx, `SELECT email FROM users WHERE id = $1 FOR UPDATE`, user.ID).Scan(&currentEmail); err != nil {
		return err
	}
	if !strings.EqualFold(strings.TrimSpace(confirmation), strings.TrimSpace(currentEmail)) {
		return errAccountDeletionConfirmation
	}
	if err := a.expireCheckoutBeforeAccountDeletionWith(ctx, tx, user.ID); err != nil {
		if errors.Is(err, errAccountDeletionCheckout) {
			return err
		}
		return fmt.Errorf("%w: %v", errAccountDeletionUnavailable, err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO pending_image_deletions (object_key, user_id)
		SELECT object_key, user_id FROM image_objects WHERE user_id = $1
		ON CONFLICT (object_key) DO UPDATE SET
			user_id = EXCLUDED.user_id,
			attempts = 0,
			last_error = NULL,
			next_try_at = now()
	`, user.ID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		DELETE FROM invitations
		WHERE inviter_user_id = $1 OR invited_user_id = $1
	`, user.ID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE stripe_payments
		SET notified_at = COALESCE(notified_at, now()),
			notification_next_try_at = NULL,
			notification_locked_until = NULL,
			notification_last_error = NULL,
			updated_at = now()
		WHERE user_id = $1
	`, user.ID); err != nil {
		return err
	}
	result, err := tx.Exec(ctx, `DELETE FROM users WHERE id = $1`, user.ID)
	if err != nil {
		return err
	}
	if result.RowsAffected() != 1 {
		return pgx.ErrNoRows
	}
	return tx.Commit(ctx)
}

func (a *App) acknowledgeDetachedCheckout(ctx context.Context, checkout validatedLifetimeCheckout, eventID string) (bool, error) {
	result, err := a.db.Exec(ctx, `
		UPDATE stripe_payments
		SET source_event_id = COALESCE(source_event_id, NULLIF($7, '')),
		    updated_at = now()
		WHERE checkout_session_id = $1
		  AND user_id IS NULL
		  AND payment_intent_id = $2
		  AND customer_id = $3
		  AND plan_code = $4
		  AND amount = $5
		  AND currency = $6
	`, checkout.SessionID, checkout.PaymentIntentID, checkout.CustomerID,
		lifetimePlanCode, checkout.Amount, string(checkout.Currency), eventID)
	if err != nil {
		return false, err
	}
	return result.RowsAffected() == 1, nil
}
