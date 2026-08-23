package server

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"koinote/backend/internal/migrations"
)

func TestCreditsForTokens(t *testing.T) {
	tests := []struct {
		tokens int
		want   int64
	}{
		{tokens: -1, want: 0},
		{tokens: 0, want: 0},
		{tokens: 1, want: 1},
		{tokens: 2_000, want: 1},
		{tokens: 2_001, want: 2},
		{tokens: 10_000, want: 5},
	}
	for _, test := range tests {
		t.Run(fmt.Sprintf("%d", test.tokens), func(t *testing.T) {
			if got := creditsForTokens(test.tokens); got != test.want {
				t.Fatalf("creditsForTokens(%d) = %d, want %d", test.tokens, got, test.want)
			}
		})
	}
}

func TestLifetimeCreditGrantIsIdempotent(t *testing.T) {
	pool, userID := newCreditTestUser(t)
	ctx := context.Background()

	firstBalance, firstApplied := grantLifetimeCreditsForTest(t, pool, userID)
	if !firstApplied || firstBalance.Balance != lifetimeMembershipGrantCredits {
		t.Fatalf("first grant = balance %d applied %v", firstBalance.Balance, firstApplied)
	}
	secondBalance, secondApplied := grantLifetimeCreditsForTest(t, pool, userID)
	if secondApplied || secondBalance.Balance != lifetimeMembershipGrantCredits {
		t.Fatalf("second grant = balance %d applied %v", secondBalance.Balance, secondApplied)
	}

	var transactions int
	if err := pool.QueryRow(ctx, `
		SELECT count(*)
		FROM credit_transactions
		WHERE user_id = $1 AND kind = 'membership_grant'
	`, userID).Scan(&transactions); err != nil {
		t.Fatalf("count membership grants: %v", err)
	}
	if transactions != 1 {
		t.Fatalf("membership grant transactions = %d, want 1", transactions)
	}
}

func TestConcurrentCreditReservationsCannotOverspend(t *testing.T) {
	pool, userID := newCreditTestUser(t)
	ctx := context.Background()
	app := &App{db: pool}
	grantCreditsForTest(t, pool, userID, 1, "concurrency")
	reviewIDs := []int64{
		insertCreditTestReview(t, pool, userID, "concurrency-a"),
		insertCreditTestReview(t, pool, userID, "concurrency-b"),
	}

	type result struct {
		reservation creditReservation
		err         error
	}
	start := make(chan struct{})
	results := make(chan result, len(reviewIDs))
	var workers sync.WaitGroup
	for _, reviewID := range reviewIDs {
		workers.Add(1)
		go func(reviewID int64) {
			defer workers.Done()
			<-start
			reservation, err := app.reserveCredits(ctx, userID, reviewID, 1, time.Minute)
			results <- result{reservation: reservation, err: err}
		}(reviewID)
	}
	close(start)
	workers.Wait()
	close(results)

	var succeeded, insufficient int
	for result := range results {
		switch {
		case result.err == nil:
			succeeded++
			if result.reservation.Reserved != 1 {
				t.Fatalf("reserved credits = %d, want 1", result.reservation.Reserved)
			}
		case errors.Is(result.err, errInsufficientCredits):
			insufficient++
		default:
			t.Fatalf("unexpected reservation error: %v", result.err)
		}
	}
	if succeeded != 1 || insufficient != 1 {
		t.Fatalf("reservation results = %d success, %d insufficient", succeeded, insufficient)
	}

	balance, err := app.loadCreditBalance(ctx, userID)
	if err != nil {
		t.Fatalf("load balance: %v", err)
	}
	if balance != (creditAccountBalance{Balance: 1, Reserved: 1, Available: 0}) {
		t.Fatalf("balance after concurrent reserve = %+v", balance)
	}
}

func TestStandaloneCreditReservationCommit(t *testing.T) {
	pool, userID := newCreditTestUser(t)
	ctx := context.Background()
	app := &App{db: pool}
	grantCreditsForTest(t, pool, userID, 3, "standalone")

	reservation, err := app.reserveStandaloneCredits(ctx, userID, 2, time.Minute)
	if err != nil {
		t.Fatalf("reserve standalone credits: %v", err)
	}
	var reviewID *int64
	if err := pool.QueryRow(ctx, `
		SELECT review_id FROM credit_reservations WHERE reservation_id = $1
	`, reservation.ReservationID).Scan(&reviewID); err != nil {
		t.Fatalf("load standalone reservation: %v", err)
	}
	if reviewID != nil {
		t.Fatalf("standalone reservation review_id=%d, want null", *reviewID)
	}

	balance, charged, err := app.commitCreditReservation(
		ctx,
		userID,
		reservation.ReservationID,
		1_200,
		map[string]any{"feature": "standalone-test"},
	)
	if err != nil {
		t.Fatalf("commit standalone credits: %v", err)
	}
	if charged != 1 || balance != (creditAccountBalance{Balance: 2, Reserved: 0, Available: 2}) {
		t.Fatalf("standalone commit charged=%d balance=%+v", charged, balance)
	}
}

func TestCreditReservationCommitReleaseAndExpiry(t *testing.T) {
	pool, userID := newCreditTestUser(t)
	ctx := context.Background()
	app := &App{db: pool}
	grantCreditsForTest(t, pool, userID, 5, "lifecycle")

	commitReviewID := insertCreditTestReview(t, pool, userID, "commit")
	reservation, err := app.reserveCredits(ctx, userID, commitReviewID, 3, time.Minute)
	if err != nil {
		t.Fatalf("reserve for commit: %v", err)
	}
	balance, charged, err := app.commitCreditReservation(
		ctx,
		userID,
		reservation.ReservationID,
		2_001,
		map[string]any{"review": "commit"},
	)
	if err != nil {
		t.Fatalf("commit reservation: %v", err)
	}
	if charged != 2 || balance != (creditAccountBalance{Balance: 3, Reserved: 0, Available: 3}) {
		t.Fatalf("commit result = charged %d balance %+v", charged, balance)
	}

	repeatedBalance, repeatedCharge, err := app.commitCreditReservation(
		ctx,
		userID,
		reservation.ReservationID,
		2_001,
		map[string]any{"review": "commit"},
	)
	if err != nil {
		t.Fatalf("repeat commit: %v", err)
	}
	if repeatedCharge != 2 || repeatedBalance != balance {
		t.Fatalf("repeat commit = charged %d balance %+v", repeatedCharge, repeatedBalance)
	}

	releaseReviewID := insertCreditTestReview(t, pool, userID, "release")
	releasedReservation, err := app.reserveCredits(ctx, userID, releaseReviewID, 2, time.Minute)
	if err != nil {
		t.Fatalf("reserve for release: %v", err)
	}
	releasedBalance, err := app.releaseCreditReservation(ctx, userID, releasedReservation.ReservationID)
	if err != nil {
		t.Fatalf("release reservation: %v", err)
	}
	if releasedBalance != balance {
		t.Fatalf("release balance = %+v, want %+v", releasedBalance, balance)
	}
	if _, err := app.releaseCreditReservation(ctx, userID, releasedReservation.ReservationID); err != nil {
		t.Fatalf("repeat release: %v", err)
	}

	expiryReviewID := insertCreditTestReview(t, pool, userID, "expiry")
	expiredReservation, err := app.reserveCredits(ctx, userID, expiryReviewID, 1, time.Minute)
	if err != nil {
		t.Fatalf("reserve for expiry: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE credit_reservations
		SET expires_at = now() - interval '1 second'
		WHERE reservation_id = $1
	`, expiredReservation.ReservationID); err != nil {
		t.Fatalf("expire reservation: %v", err)
	}
	afterExpiry, err := app.loadCreditBalance(ctx, userID)
	if err != nil {
		t.Fatalf("load balance after expiry: %v", err)
	}
	if afterExpiry != balance {
		t.Fatalf("balance after expiry = %+v, want %+v", afterExpiry, balance)
	}

	var status string
	if err := pool.QueryRow(ctx, `
		SELECT status FROM credit_reservations WHERE reservation_id = $1
	`, expiredReservation.ReservationID).Scan(&status); err != nil {
		t.Fatalf("load expired reservation: %v", err)
	}
	if status != "released" {
		t.Fatalf("expired reservation status = %q, want released", status)
	}

	var usageTransactions int
	if err := pool.QueryRow(ctx, `
		SELECT count(*)
		FROM credit_transactions
		WHERE user_id = $1 AND kind = 'agent_usage'
	`, userID).Scan(&usageTransactions); err != nil {
		t.Fatalf("count usage transactions: %v", err)
	}
	if usageTransactions != 1 {
		t.Fatalf("usage transactions = %d, want 1", usageTransactions)
	}
}

func TestCreditReservationCommitCanUseUnreservedBalance(t *testing.T) {
	t.Run("actual usage above reservation succeeds when balance covers it", func(t *testing.T) {
		pool, userID := newCreditTestUser(t)
		ctx := context.Background()
		app := &App{db: pool}
		grantCreditsForTest(t, pool, userID, 5, "actual-above-reserved")
		reviewID := insertCreditTestReview(t, pool, userID, "actual-above-reserved")
		reservation, err := app.reserveCredits(ctx, userID, reviewID, 2, time.Minute)
		if err != nil {
			t.Fatalf("reserve credits: %v", err)
		}
		balance, charged, err := app.commitCreditReservation(ctx, userID, reservation.ReservationID, 6_001, nil)
		if err != nil {
			t.Fatalf("commit actual usage above reservation: %v", err)
		}
		if charged != 4 || balance != (creditAccountBalance{Balance: 1, Reserved: 0, Available: 1}) {
			t.Fatalf("commit result = charged %d balance %+v", charged, balance)
		}
	})

	t.Run("actual usage above available balance is rejected", func(t *testing.T) {
		pool, userID := newCreditTestUser(t)
		ctx := context.Background()
		app := &App{db: pool}
		grantCreditsForTest(t, pool, userID, 3, "actual-over-balance")
		reviewID := insertCreditTestReview(t, pool, userID, "actual-over-balance")
		reservation, err := app.reserveCredits(ctx, userID, reviewID, 2, time.Minute)
		if err != nil {
			t.Fatalf("reserve credits: %v", err)
		}
		if _, _, err := app.commitCreditReservation(ctx, userID, reservation.ReservationID, 6_001, nil); !errors.Is(err, errInsufficientCredits) {
			t.Fatalf("commit error = %v, want insufficient credits", err)
		}
		balance, err := app.loadCreditBalance(ctx, userID)
		if err != nil {
			t.Fatalf("load balance after rejected commit: %v", err)
		}
		if balance != (creditAccountBalance{Balance: 3, Reserved: 2, Available: 1}) {
			t.Fatalf("balance after rejected commit = %+v", balance)
		}
	})
}

func newCreditTestUser(t *testing.T) (*pgxpool.Pool, int) {
	t.Helper()
	dsn := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if dsn == "" {
		t.Skip("未设 TEST_DATABASE_URL，跳过 credits 数据库集成测试")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("connect test database: %v", err)
	}
	if err := migrations.Apply(ctx, pool, "../../migrations"); err != nil {
		pool.Close()
		t.Fatalf("apply migrations: %v", err)
	}
	suffix, err := randomHex(8)
	if err != nil {
		pool.Close()
		t.Fatalf("generate test suffix: %v", err)
	}
	var userID int
	if err := pool.QueryRow(ctx, `
		INSERT INTO users (auth_user_id, email, is_verified)
		VALUES ($1, $2, true)
		RETURNING id
	`, "credits-"+suffix, "credits-"+suffix+"@example.test").Scan(&userID); err != nil {
		pool.Close()
		t.Fatalf("insert credit test user: %v", err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, userID); err != nil {
			t.Errorf("delete credit test user: %v", err)
		}
		pool.Close()
	})
	return pool, userID
}

func grantLifetimeCreditsForTest(
	t *testing.T,
	pool *pgxpool.Pool,
	userID int,
) (creditAccountBalance, bool) {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin lifetime credit grant: %v", err)
	}
	balance, applied, err := grantLifetimeMembershipCredits(ctx, tx, userID, "test")
	if err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("grant lifetime credits: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit lifetime credit grant: %v", err)
	}
	return balance, applied
}

func grantCreditsForTest(
	t *testing.T,
	pool *pgxpool.Pool,
	userID int,
	amount int64,
	reference string,
) {
	t.Helper()
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatalf("begin test credit grant: %v", err)
	}
	if _, _, err := grantCreditsTx(
		ctx,
		tx,
		userID,
		"adjustment",
		amount,
		fmt.Sprintf("test:%d:%s", userID, reference),
		map[string]any{"test": true},
	); err != nil {
		_ = tx.Rollback(ctx)
		t.Fatalf("grant test credits: %v", err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatalf("commit test credit grant: %v", err)
	}
}

func insertCreditTestReview(t *testing.T, pool *pgxpool.Pool, userID int, label string) int64 {
	t.Helper()
	ctx := context.Background()
	docID, err := randomUUID()
	if err != nil {
		t.Fatalf("generate credit test document id: %v", err)
	}
	var documentID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO documents (doc_id, user_id, title, content)
		VALUES ($1, $2, $3, '')
		RETURNING id
	`, docID, userID, label).Scan(&documentID); err != nil {
		t.Fatalf("insert credit test document: %v", err)
	}
	reviewID, err := randomUUID()
	if err != nil {
		t.Fatalf("generate credit test review id: %v", err)
	}
	var databaseID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO agent_reviews (
			review_id, user_id, document_id, base_revision, current_revision,
			provider_mode, provider_protocol, model, status
		)
		VALUES ($1, $2, $3, 1, 1, 'builtin', 'openai', 'test-model', 'running')
		RETURNING id
	`, reviewID, userID, documentID).Scan(&databaseID); err != nil {
		t.Fatalf("insert credit test review: %v", err)
	}
	return databaseID
}
