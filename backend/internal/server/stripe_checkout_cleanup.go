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

	if a.stripeCheckout == nil {
		release()
		return nil
	}
	rows, err := conn.Query(ctx, `
		SELECT attempts.user_id, attempts.checkout_session_id
		FROM stripe_checkout_attempts AS attempts
		JOIN users ON users.id = attempts.user_id
		WHERE attempts.expires_at <= now()
		   OR users.membership_tier = 'lifetime'
		ORDER BY attempts.expires_at
		LIMIT $1
	`, stripeCheckoutCleanupBatch)
	if err != nil {
		return err
	}
	type cleanupCandidate struct {
		userID    int
		sessionID string
	}
	candidates := make([]cleanupCandidate, 0, stripeCheckoutCleanupBatch)
	for rows.Next() {
		var candidate cleanupCandidate
		if err := rows.Scan(&candidate.userID, &candidate.sessionID); err != nil {
			rows.Close()
			return err
		}
		candidates = append(candidates, candidate)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	release()

	for _, candidate := range candidates {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		expireCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		removable, expireErr := a.expireCheckoutSessionForRemoval(expireCtx, candidate.sessionID)
		cancel()
		if expireErr != nil {
			log.Printf("Stripe checkout cleanup for user %d session %s: %v", candidate.userID, candidate.sessionID, expireErr)
			continue
		}
		if !removable {
			continue
		}
		if _, err := a.db.Exec(ctx, `
			DELETE FROM stripe_checkout_attempts
			WHERE user_id = $1 AND checkout_session_id = $2
		`, candidate.userID, candidate.sessionID); err != nil {
			return err
		}
	}
	return nil
}
