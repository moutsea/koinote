package server

import (
	"context"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"koinote/backend/internal/config"
)

// A task POST can reach the handler before StartWritingAgent runs; New must
// already own the channel so that first notify is kept, never dropped or blocked.
func TestWritingAgentNotifyBeforeWorkersStart(t *testing.T) {
	app := New(config.Config{}, nil)
	if app.writingWake == nil {
		t.Fatal("New did not create the writing agent wake channel")
	}
	app.notifyWritingAgent()
	app.notifyWritingAgent() // Full buffer: must return instead of blocking.
	if got := len(app.writingWake); got != 1 {
		t.Fatalf("buffered notifies = %d, want 1", got)
	}
	(&App{}).notifyWritingAgent() // App literals without New must not panic.
}

// wakeCommitTracer records whether a worker was already woken when COMMIT ran.
// A notify sent earlier lets the worker query before the update is visible.
type wakeCommitTracer struct {
	wake                <-chan struct{}
	commits, earlyWakes int
}

func (tracer *wakeCommitTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if strings.EqualFold(strings.TrimSpace(data.SQL), "commit") {
		tracer.commits++
		tracer.earlyWakes += len(tracer.wake)
	}
	return ctx
}

func (*wakeCommitTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

// Stopping a task makes it claimable at once (next_poll_at=now()), so the
// cancel must wake a worker, and only after the change is committed.
func TestCancelAgentTaskWakesWorkerAfterCommit(t *testing.T) {
	pool := newGCTestPool(t)
	app := New(config.Config{}, pool)
	poolConfig := pool.Config()
	tracer := &wakeCommitTracer{wake: app.writingWake}
	poolConfig.ConnConfig.Tracer = tracer
	traced, err := pgxpool.NewWithConfig(context.Background(), poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(traced.Close)
	app.db = traced
	id, err := randomUUID()
	if err != nil {
		t.Fatal(err)
	}
	if err = app.cancelAgentTask(context.Background(), -1, id); err != nil {
		t.Fatal(err)
	}
	if tracer.commits != 1 || tracer.earlyWakes != 0 {
		t.Fatalf("commits=%d, wakes before commit=%d; want one commit and none", tracer.commits, tracer.earlyWakes)
	}
	if got := len(app.writingWake); got != 1 {
		t.Fatalf("notifies after cancel = %d, want 1", got)
	}
}
