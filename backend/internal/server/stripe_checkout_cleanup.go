package server

import (
	"context"
	"log"
	"time"
)

const (
	stripeCheckoutCleanupInterval = 5 * time.Minute
	stripeCheckoutCleanupBatch    = 100
	stripeCheckoutCleanupLockKey  = int64(0x4b4f494e4f544543)
)

func (a *App) StartStripeCheckoutCleanup(ctx context.Context) {
	go func() {
		if err := a.cleanupStripeCheckoutAttempts(ctx); err != nil && ctx.Err() == nil {
			log.Printf("Stripe checkout cleanup: %v", err)
		}
		ticker := time.NewTicker(stripeCheckoutCleanupInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := a.cleanupStripeCheckoutAttempts(ctx); err != nil && ctx.Err() == nil {
					log.Printf("Stripe checkout cleanup: %v", err)
				}
			}
		}
	}()
}

func (a *App) cleanupStripeCheckoutAttempts(ctx context.Context) error {
	conn, err := a.db.Acquire(ctx)
	if err != nil {
		return err
	}
	released := false
	locked := false
	release := func() {
		if released {
			return
		}
		released = true
		if locked {
			unlockCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			_, _ = conn.Exec(unlockCtx, `SELECT pg_advisory_unlock($1)`, stripeCheckoutCleanupLockKey)
			cancel()
		}
		conn.Release()
	}
	defer release()

	if err := conn.QueryRow(ctx, `SELECT pg_try_advisory_lock($1)`, stripeCheckoutCleanupLockKey).Scan(&locked); err != nil {
		return err
	}
	if !locked {
		return nil
	}

	if _, err := conn.Exec(ctx, `
		WITH expired AS (
			SELECT user_id
			FROM stripe_checkout_attempts
			WHERE expires_at <= now()
			ORDER BY expires_at
			LIMIT $1
			FOR UPDATE SKIP LOCKED
		)
		DELETE FROM stripe_checkout_attempts AS attempts
		USING expired
		WHERE attempts.user_id = expired.user_id
	`, stripeCheckoutCleanupBatch); err != nil {
		return err
	}
	if a.stripeCheckout == nil {
		release()
		return nil
	}
	rows, err := conn.Query(ctx, `
		SELECT attempts.user_id
		FROM stripe_checkout_attempts AS attempts
		JOIN users ON users.id = attempts.user_id
		WHERE users.membership_tier = 'lifetime'
		ORDER BY attempts.updated_at
		LIMIT $1
	`, stripeCheckoutCleanupBatch)
	if err != nil {
		return err
	}
	userIDs := make([]int, 0, stripeCheckoutCleanupBatch)
	for rows.Next() {
		var userID int
		if err := rows.Scan(&userID); err != nil {
			rows.Close()
			return err
		}
		userIDs = append(userIDs, userID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	release()

	for _, userID := range userIDs {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		expireCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		expireErr := a.expirePendingCheckoutForMember(expireCtx, userID, "")
		cancel()
		if expireErr != nil {
			log.Printf("Stripe checkout cleanup for member %d: %v", userID, expireErr)
		}
	}
	return nil
}
