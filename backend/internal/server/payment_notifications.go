package server

import (
	"context"
	"errors"
	"log"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	paymentNotifyPollInterval = time.Minute
	paymentNotifyLockDuration = 30 * time.Second
	paymentNotifyBatchSize    = 20
)

type pendingPaymentNotification struct {
	CheckoutID      string
	PaymentIntentID string
	UserID          int
	Amount          int64
	Currency        string
	Attempts        int
}

func paymentNotificationBackoff(attempts int) time.Duration {
	if attempts <= 0 {
		return time.Minute
	}
	if attempts >= 8 {
		return 24 * time.Hour
	}
	return time.Duration(1<<(attempts-1)) * time.Minute
}

func (a *App) StartPaymentNotificationRetry(ctx context.Context) {
	if a.paymentNotifier == nil {
		return
	}
	go func() {
		log.Printf("付款通知重试已启动，每 %s 轮询一次", paymentNotifyPollInterval)
		ticker := time.NewTicker(paymentNotifyPollInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := a.retryPaymentNotifications(ctx); err != nil {
					log.Printf("payment notification retry: %v", err)
				}
			}
		}
	}()
}

func (a *App) deliverPaymentNotification(checkoutID string) {
	if a.paymentNotifier == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), feishuRequestTimeout)
	defer cancel()
	pending, found, err := a.claimPaymentNotification(ctx, checkoutID)
	if err != nil {
		log.Printf("claim payment notification (checkout=%s): %v", checkoutID, err)
		return
	}
	if !found {
		return
	}
	if err := a.sendClaimedPaymentNotification(ctx, pending); err != nil {
		log.Printf("Feishu payment notification failed (checkout=%s): %v", checkoutID, err)
	}
}

func (a *App) retryPaymentNotifications(ctx context.Context) error {
	rows, err := a.db.Query(ctx, `
		SELECT checkout_session_id
		FROM stripe_payments
		WHERE notified_at IS NULL
		  AND user_id IS NOT NULL
		  AND notification_next_try_at IS NOT NULL
		  AND notification_next_try_at <= now()
		  AND (notification_locked_until IS NULL OR notification_locked_until < now())
		ORDER BY notification_next_try_at
		LIMIT $1
	`, paymentNotifyBatchSize)
	if err != nil {
		return err
	}
	defer rows.Close()
	checkoutIDs := make([]string, 0, paymentNotifyBatchSize)
	for rows.Next() {
		var checkoutID string
		if err := rows.Scan(&checkoutID); err != nil {
			return err
		}
		checkoutIDs = append(checkoutIDs, checkoutID)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, checkoutID := range checkoutIDs {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		notifyCtx, cancel := context.WithTimeout(ctx, feishuRequestTimeout)
		pending, found, claimErr := a.claimPaymentNotification(notifyCtx, checkoutID)
		if claimErr == nil && found {
			claimErr = a.sendClaimedPaymentNotification(notifyCtx, pending)
		}
		cancel()
		if claimErr != nil {
			log.Printf("payment notification retry failed (checkout=%s): %v", checkoutID, claimErr)
		}
	}
	return nil
}

func (a *App) claimPaymentNotification(ctx context.Context, checkoutID string) (pendingPaymentNotification, bool, error) {
	var pending pendingPaymentNotification
	err := a.db.QueryRow(ctx, `
		UPDATE stripe_payments
		SET notification_locked_until = now() + $2::interval,
		    updated_at = now()
		WHERE checkout_session_id = $1
		  AND user_id IS NOT NULL
		  AND notified_at IS NULL
		  AND notification_next_try_at IS NOT NULL
		  AND notification_next_try_at <= now()
		  AND (notification_locked_until IS NULL OR notification_locked_until < now())
		RETURNING checkout_session_id, payment_intent_id, user_id, amount, currency,
		          notification_attempts
	`, checkoutID, paymentNotifyLockDuration.String()).Scan(
		&pending.CheckoutID, &pending.PaymentIntentID, &pending.UserID,
		&pending.Amount, &pending.Currency, &pending.Attempts,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return pendingPaymentNotification{}, false, nil
	}
	if err != nil {
		return pendingPaymentNotification{}, false, err
	}
	return pending, true, nil
}

func (a *App) sendClaimedPaymentNotification(ctx context.Context, pending pendingPaymentNotification) error {
	err := a.paymentNotifier.NotifyPayment(ctx, paymentNotification{
		UserID:          pending.UserID,
		Amount:          pending.Amount,
		Currency:        pending.Currency,
		CheckoutID:      pending.CheckoutID,
		PaymentIntentID: pending.PaymentIntentID,
	})
	if err == nil {
		updateCtx, cancel := context.WithTimeout(context.Background(), feishuRequestTimeout)
		defer cancel()
		_, updateErr := a.db.Exec(updateCtx, `
			UPDATE stripe_payments
			SET notified_at = now(), notification_next_try_at = NULL,
			    notification_locked_until = NULL, notification_last_error = NULL,
			    updated_at = now()
			WHERE checkout_session_id = $1 AND notified_at IS NULL
		`, pending.CheckoutID)
		return updateErr
	}

	attempts := pending.Attempts + 1
	nextTry := time.Now().Add(paymentNotificationBackoff(attempts))
	updateCtx, cancel := context.WithTimeout(context.Background(), feishuRequestTimeout)
	defer cancel()
	_, updateErr := a.db.Exec(updateCtx, `
		UPDATE stripe_payments
		SET notification_attempts = $2, notification_next_try_at = $3,
		    notification_locked_until = NULL, notification_last_error = left($4, 1000),
		    updated_at = now()
		WHERE checkout_session_id = $1 AND notified_at IS NULL
	`, pending.CheckoutID, attempts, nextTry, err.Error())
	if updateErr != nil {
		return updateErr
	}
	return err
}
