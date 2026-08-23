package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
)

const (
	creditTokensPerCredit              = 2_000
	lifetimeMembershipGrantCredits     = int64(1_000)
	defaultCreditReservationTTL        = 10 * time.Minute
	maximumCreditReservationTTL        = 30 * time.Minute
	creditReservationCleanupBatchLimit = 100
)

var (
	errInsufficientCredits       = errors.New("insufficient credits")
	errCreditReservationNotFound = errors.New("credit reservation not found")
	errCreditReservationReleased = errors.New("credit reservation released")
)

type creditAccountBalance struct {
	Balance   int64 `json:"balance"`
	Reserved  int64 `json:"reserved"`
	Available int64 `json:"available"`
}

type creditReservation struct {
	ReservationID string
	Reserved      int64
	ExpiresAt     time.Time
}

func creditsForTokens(totalTokens int) int64 {
	if totalTokens <= 0 {
		return 0
	}
	return (int64(totalTokens) + creditTokensPerCredit - 1) / creditTokensPerCredit
}

func (a *App) loadCreditBalance(ctx context.Context, userID int) (creditAccountBalance, error) {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return creditAccountBalance{}, fmt.Errorf("begin credit balance: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck -- commit below owns the successful path

	balance, err := lockCreditAccount(ctx, tx, userID)
	if err != nil {
		return creditAccountBalance{}, err
	}
	balance, err = releaseExpiredCreditReservationsForUser(ctx, tx, userID, balance)
	if err != nil {
		return creditAccountBalance{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return creditAccountBalance{}, fmt.Errorf("commit credit balance: %w", err)
	}
	return balance, nil
}

func lockCreditAccount(ctx context.Context, tx pgx.Tx, userID int) (creditAccountBalance, error) {
	if _, err := tx.Exec(ctx, `
		INSERT INTO credit_accounts (user_id)
		SELECT id FROM users WHERE id = $1
		ON CONFLICT (user_id) DO NOTHING
	`, userID); err != nil {
		return creditAccountBalance{}, fmt.Errorf("ensure credit account: %w", err)
	}

	var balance creditAccountBalance
	if err := tx.QueryRow(ctx, `
		SELECT balance, reserved, balance - reserved
		FROM credit_accounts
		WHERE user_id = $1
		FOR UPDATE
	`, userID).Scan(&balance.Balance, &balance.Reserved, &balance.Available); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return creditAccountBalance{}, fmt.Errorf("credit account user %d: %w", userID, pgx.ErrNoRows)
		}
		return creditAccountBalance{}, fmt.Errorf("lock credit account: %w", err)
	}
	return balance, nil
}

func releaseExpiredCreditReservationsForUser(
	ctx context.Context,
	tx pgx.Tx,
	userID int,
	balance creditAccountBalance,
) (creditAccountBalance, error) {
	rows, err := tx.Query(ctx, `
		UPDATE credit_reservations
		SET status = 'released', updated_at = now()
		WHERE user_id = $1
		  AND status = 'active'
		  AND expires_at <= now()
		RETURNING reserved_credits
	`, userID)
	if err != nil {
		return creditAccountBalance{}, fmt.Errorf("release expired credit reservations: %w", err)
	}
	defer rows.Close()

	var released int64
	for rows.Next() {
		var credits int64
		if err := rows.Scan(&credits); err != nil {
			return creditAccountBalance{}, fmt.Errorf("scan expired credit reservation: %w", err)
		}
		released += credits
	}
	if err := rows.Err(); err != nil {
		return creditAccountBalance{}, fmt.Errorf("iterate expired credit reservations: %w", err)
	}
	if released == 0 {
		return balance, nil
	}
	if released > balance.Reserved {
		return creditAccountBalance{}, fmt.Errorf(
			"expired credit reservations exceed account reserve: released=%d reserved=%d",
			released,
			balance.Reserved,
		)
	}

	balance.Reserved -= released
	balance.Available = balance.Balance - balance.Reserved
	if _, err := tx.Exec(ctx, `
		UPDATE credit_accounts
		SET reserved = $2, updated_at = now()
		WHERE user_id = $1
	`, userID, balance.Reserved); err != nil {
		return creditAccountBalance{}, fmt.Errorf("update released credit reserve: %w", err)
	}
	return balance, nil
}

func grantCreditsTx(
	ctx context.Context,
	tx pgx.Tx,
	userID int,
	kind string,
	amount int64,
	referenceKey string,
	metadata map[string]any,
) (creditAccountBalance, bool, error) {
	if amount <= 0 {
		return creditAccountBalance{}, false, fmt.Errorf("credit grant amount must be positive")
	}
	if referenceKey == "" {
		return creditAccountBalance{}, false, fmt.Errorf("credit grant reference is required")
	}
	metadataJSON, err := json.Marshal(metadata)
	if err != nil {
		return creditAccountBalance{}, false, fmt.Errorf("encode credit grant metadata: %w", err)
	}

	balance, err := lockCreditAccount(ctx, tx, userID)
	if err != nil {
		return creditAccountBalance{}, false, err
	}
	balance, err = releaseExpiredCreditReservationsForUser(ctx, tx, userID, balance)
	if err != nil {
		return creditAccountBalance{}, false, err
	}

	entryID := "credit:" + referenceKey
	var inserted int
	err = tx.QueryRow(ctx, `
		INSERT INTO credit_transactions (
			entry_id, user_id, kind, amount, balance_after, reference_key, metadata
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
		ON CONFLICT (reference_key) DO NOTHING
		RETURNING 1
	`, entryID, userID, kind, amount, balance.Balance+amount, referenceKey, metadataJSON).Scan(&inserted)
	if errors.Is(err, pgx.ErrNoRows) {
		var existingUserID int
		var existingKind string
		var existingAmount int64
		if err := tx.QueryRow(ctx, `
			SELECT user_id, kind, amount
			FROM credit_transactions
			WHERE reference_key = $1
		`, referenceKey).Scan(&existingUserID, &existingKind, &existingAmount); err != nil {
			return creditAccountBalance{}, false, fmt.Errorf("load existing credit grant: %w", err)
		}
		if existingUserID != userID || existingKind != kind || existingAmount != amount {
			return creditAccountBalance{}, false, fmt.Errorf("credit reference %q conflicts with another transaction", referenceKey)
		}
		return balance, false, nil
	}
	if err != nil {
		return creditAccountBalance{}, false, fmt.Errorf("insert credit grant: %w", err)
	}

	balance.Balance += amount
	balance.Available += amount
	if _, err := tx.Exec(ctx, `
		UPDATE credit_accounts
		SET balance = $2, updated_at = now()
		WHERE user_id = $1
	`, userID, balance.Balance); err != nil {
		return creditAccountBalance{}, false, fmt.Errorf("update granted credit balance: %w", err)
	}
	return balance, true, nil
}

func grantLifetimeMembershipCredits(
	ctx context.Context,
	tx pgx.Tx,
	userID int,
	source string,
) (creditAccountBalance, bool, error) {
	return grantCreditsTx(
		ctx,
		tx,
		userID,
		"membership_grant",
		lifetimeMembershipGrantCredits,
		fmt.Sprintf("membership-grant:%d", userID),
		map[string]any{"source": source},
	)
}

func (a *App) reserveCredits(
	ctx context.Context,
	userID int,
	reviewID int64,
	credits int64,
	ttl time.Duration,
) (creditReservation, error) {
	return a.reserveCreditReservation(ctx, userID, &reviewID, credits, ttl)
}

func (a *App) reserveStandaloneCredits(
	ctx context.Context,
	userID int,
	credits int64,
	ttl time.Duration,
) (creditReservation, error) {
	return a.reserveCreditReservation(ctx, userID, nil, credits, ttl)
}

func (a *App) reserveCreditReservation(
	ctx context.Context,
	userID int,
	reviewID *int64,
	credits int64,
	ttl time.Duration,
) (creditReservation, error) {
	if credits <= 0 {
		return creditReservation{}, fmt.Errorf("credit reservation must be positive")
	}
	if ttl <= 0 || ttl > maximumCreditReservationTTL {
		return creditReservation{}, fmt.Errorf("invalid credit reservation ttl")
	}
	reservationID, err := randomUUID()
	if err != nil {
		return creditReservation{}, fmt.Errorf("generate credit reservation id: %w", err)
	}
	expiresAt := time.Now().UTC().Add(ttl)

	tx, err := a.db.Begin(ctx)
	if err != nil {
		return creditReservation{}, fmt.Errorf("begin credit reservation: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck -- commit below owns the successful path

	balance, err := lockCreditAccount(ctx, tx, userID)
	if err != nil {
		return creditReservation{}, err
	}
	balance, err = releaseExpiredCreditReservationsForUser(ctx, tx, userID, balance)
	if err != nil {
		return creditReservation{}, err
	}

	if reviewID != nil {
		var existing creditReservation
		var existingStatus string
		err = tx.QueryRow(ctx, `
			SELECT reservation_id, reserved_credits, expires_at, status
			FROM credit_reservations
			WHERE review_id = $1
		`, *reviewID).Scan(&existing.ReservationID, &existing.Reserved, &existing.ExpiresAt, &existingStatus)
		if err == nil {
			if existingStatus == "active" && existing.Reserved == credits {
				if err := tx.Commit(ctx); err != nil {
					return creditReservation{}, fmt.Errorf("commit existing credit reservation: %w", err)
				}
				return existing, nil
			}
			return creditReservation{}, fmt.Errorf("review already has a %s credit reservation", existingStatus)
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return creditReservation{}, fmt.Errorf("load review credit reservation: %w", err)
		}
	}
	if balance.Available < credits {
		return creditReservation{}, errInsufficientCredits
	}

	if _, err := tx.Exec(ctx, `
		INSERT INTO credit_reservations (
			reservation_id, user_id, review_id, reserved_credits, status, expires_at
		)
		VALUES ($1, $2, $3, $4, 'active', $5)
	`, reservationID, userID, reviewID, credits, expiresAt); err != nil {
		return creditReservation{}, fmt.Errorf("insert credit reservation: %w", err)
	}
	balance.Reserved += credits
	if _, err := tx.Exec(ctx, `
		UPDATE credit_accounts
		SET reserved = $2, updated_at = now()
		WHERE user_id = $1
	`, userID, balance.Reserved); err != nil {
		return creditReservation{}, fmt.Errorf("update credit reserve: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return creditReservation{}, fmt.Errorf("commit credit reservation: %w", err)
	}
	return creditReservation{ReservationID: reservationID, Reserved: credits, ExpiresAt: expiresAt}, nil
}

func (a *App) commitCreditReservation(
	ctx context.Context,
	userID int,
	reservationID string,
	totalTokens int,
	metadata map[string]any,
) (creditAccountBalance, int64, error) {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return creditAccountBalance{}, 0, fmt.Errorf("begin credit commit: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck -- commit below owns the successful path
	balance, credits, err := commitCreditReservationTx(
		ctx,
		tx,
		userID,
		reservationID,
		totalTokens,
		metadata,
	)
	if err != nil {
		return creditAccountBalance{}, 0, err
	}
	if err := tx.Commit(ctx); err != nil {
		return creditAccountBalance{}, 0, fmt.Errorf("commit credit usage: %w", err)
	}
	return balance, credits, nil
}

func commitCreditReservationTx(
	ctx context.Context,
	tx pgx.Tx,
	userID int,
	reservationID string,
	totalTokens int,
	metadata map[string]any,
) (creditAccountBalance, int64, error) {
	credits := creditsForTokens(totalTokens)
	if credits <= 0 {
		return creditAccountBalance{}, 0, fmt.Errorf("credit usage tokens must be positive")
	}
	metadataJSON, err := json.Marshal(metadata)
	if err != nil {
		return creditAccountBalance{}, 0, fmt.Errorf("encode credit usage metadata: %w", err)
	}
	balance, err := lockCreditAccount(ctx, tx, userID)
	if err != nil {
		return creditAccountBalance{}, 0, err
	}

	var reserved int64
	var committed *int64
	var status string
	if err := tx.QueryRow(ctx, `
		SELECT reserved_credits, committed_credits, status
		FROM credit_reservations
		WHERE reservation_id = $1 AND user_id = $2
		FOR UPDATE
	`, reservationID, userID).Scan(&reserved, &committed, &status); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return creditAccountBalance{}, 0, errCreditReservationNotFound
		}
		return creditAccountBalance{}, 0, fmt.Errorf("lock credit reservation: %w", err)
	}
	if status == "committed" {
		if committed == nil || *committed != credits {
			return creditAccountBalance{}, 0, fmt.Errorf("credit reservation was committed with different usage")
		}
		return balance, *committed, nil
	}
	if status == "released" {
		return creditAccountBalance{}, 0, errCreditReservationReleased
	}
	if reserved > balance.Reserved {
		return creditAccountBalance{}, 0, fmt.Errorf("credit account and reservation are inconsistent")
	}
	// The reservation is a floor, not a hard cap. Once the provider reports
	// actual usage, this call may spend the account's currently available
	// balance in addition to its own reservation, while preserving all other
	// active reservations.
	maxCommit := balance.Balance - (balance.Reserved - reserved)
	if credits > maxCommit {
		return creditAccountBalance{}, 0, errInsufficientCredits
	}

	balance.Balance -= credits
	balance.Reserved -= reserved
	balance.Available = balance.Balance - balance.Reserved
	referenceKey := "agent-usage:" + reservationID
	if _, err := tx.Exec(ctx, `
		INSERT INTO credit_transactions (
			entry_id, user_id, kind, amount, balance_after, reference_key, metadata
		)
		VALUES ($1, $2, 'agent_usage', $3, $4, $5, $6::jsonb)
	`, "credit:"+referenceKey, userID, -credits, balance.Balance, referenceKey, metadataJSON); err != nil {
		return creditAccountBalance{}, 0, fmt.Errorf("insert credit usage: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE credit_accounts
		SET balance = $2, reserved = $3, updated_at = now()
		WHERE user_id = $1
	`, userID, balance.Balance, balance.Reserved); err != nil {
		return creditAccountBalance{}, 0, fmt.Errorf("update committed credit balance: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE credit_reservations
		SET status = 'committed', committed_credits = $2, updated_at = now()
		WHERE reservation_id = $1
	`, reservationID, credits); err != nil {
		return creditAccountBalance{}, 0, fmt.Errorf("mark credit reservation committed: %w", err)
	}
	return balance, credits, nil
}

func (a *App) releaseCreditReservation(
	ctx context.Context,
	userID int,
	reservationID string,
) (creditAccountBalance, error) {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return creditAccountBalance{}, fmt.Errorf("begin credit release: %w", err)
	}
	defer tx.Rollback(ctx) //nolint:errcheck -- commit below owns the successful path

	balance, err := lockCreditAccount(ctx, tx, userID)
	if err != nil {
		return creditAccountBalance{}, err
	}
	var reserved int64
	var status string
	if err := tx.QueryRow(ctx, `
		SELECT reserved_credits, status
		FROM credit_reservations
		WHERE reservation_id = $1 AND user_id = $2
		FOR UPDATE
	`, reservationID, userID).Scan(&reserved, &status); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return creditAccountBalance{}, errCreditReservationNotFound
		}
		return creditAccountBalance{}, fmt.Errorf("lock released credit reservation: %w", err)
	}
	if status != "active" {
		if err := tx.Commit(ctx); err != nil {
			return creditAccountBalance{}, fmt.Errorf("commit repeated credit release: %w", err)
		}
		return balance, nil
	}
	if reserved > balance.Reserved {
		return creditAccountBalance{}, fmt.Errorf("credit account reserve is inconsistent")
	}

	balance.Reserved -= reserved
	balance.Available = balance.Balance - balance.Reserved
	if _, err := tx.Exec(ctx, `
		UPDATE credit_accounts
		SET reserved = $2, updated_at = now()
		WHERE user_id = $1
	`, userID, balance.Reserved); err != nil {
		return creditAccountBalance{}, fmt.Errorf("update released credit balance: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		UPDATE credit_reservations
		SET status = 'released', updated_at = now()
		WHERE reservation_id = $1
	`, reservationID); err != nil {
		return creditAccountBalance{}, fmt.Errorf("mark credit reservation released: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return creditAccountBalance{}, fmt.Errorf("commit credit release: %w", err)
	}
	return balance, nil
}
