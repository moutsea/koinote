package server

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestSystemRepositoryDiscoveryRecordResult(t *testing.T) {
	transientErr := fmt.Errorf("metadata unavailable: %w", errAgentGitHubTransient)
	for _, tc := range []struct {
		name                         string
		status                       string
		workspaceID                  int64
		discoverErr, jobErr, wantErr error
		wantStatus, wantCode         string
		added, wouldAdd, skipped     int
		failed, remaining            int
	}{
		{
			name: "committed addition", status: "added", workspaceID: 42,
			wantStatus: "added", added: 1,
		},
		{
			name: "committed addition survives cleanup deadline", status: "added", workspaceID: 42,
			jobErr: context.DeadlineExceeded, wantStatus: "added", added: 1,
		},
		{
			name: "committed addition survives cleanup cancellation", status: "added", workspaceID: 42,
			jobErr: context.Canceled, wantStatus: "added", added: 1,
		},
		{
			name: "addition without committed workspace times out", status: "added",
			jobErr: context.DeadlineExceeded, wantErr: context.DeadlineExceeded,
			wantStatus: "failed", wantCode: "interrupted", failed: 1, remaining: 1,
		},
		{
			name: "negative workspace is not a committed addition", status: "added", workspaceID: -1,
			jobErr: context.DeadlineExceeded, wantErr: context.DeadlineExceeded,
			wantStatus: "failed", wantCode: "interrupted", failed: 1, remaining: 1,
		},
		{
			name: "preview", status: "would_add",
			wantStatus: "would_add", wouldAdd: 1,
		},
		{
			name: "preview deadline", status: "would_add",
			jobErr: context.DeadlineExceeded, wantErr: context.DeadlineExceeded,
			wantStatus: "failed", wantCode: "interrupted", failed: 1, remaining: 1,
		},
		{
			name: "preview cancellation", status: "would_add",
			jobErr: context.Canceled, wantErr: context.Canceled,
			wantStatus: "failed", wantCode: "interrupted", failed: 1, remaining: 1,
		},
		{
			name: "workspace ID alone cannot preserve preview", status: "would_add", workspaceID: 42,
			jobErr: context.DeadlineExceeded, wantErr: context.DeadlineExceeded,
			wantStatus: "failed", wantCode: "interrupted", failed: 1, remaining: 1,
		},
		{
			name: "skipped", status: "skipped",
			wantStatus: "skipped", skipped: 1, remaining: 1,
		},
		{
			name: "skipped deadline", status: "skipped",
			jobErr: context.DeadlineExceeded, wantErr: context.DeadlineExceeded,
			wantStatus: "failed", wantCode: "interrupted", failed: 1, remaining: 1,
		},
		{
			name:   "unfinished result cancellation",
			jobErr: context.Canceled, wantErr: context.Canceled,
			wantStatus: "failed", wantCode: "interrupted", failed: 1, remaining: 1,
		},
		{
			name: "original failure survives deadline", status: "failed",
			discoverErr: transientErr, jobErr: context.DeadlineExceeded, wantErr: errAgentGitHubTransient,
			wantStatus: "failed", wantCode: "github_transient_error", failed: 1, remaining: 1,
		},
		{
			name: "publish error cannot confirm commit", status: "added", workspaceID: 42,
			discoverErr: transientErr, jobErr: context.DeadlineExceeded, wantErr: errAgentGitHubTransient,
			wantStatus: "failed", wantCode: "github_transient_error", failed: 1, remaining: 1,
		},
		{
			name: "publish cancellation cannot confirm commit", status: "added", workspaceID: 42,
			discoverErr: context.Canceled, wantErr: context.Canceled,
			wantStatus: "failed", wantCode: "interrupted", failed: 1, remaining: 1,
		},
		{
			name: "catalog capacity", discoverErr: errAgentWorkspaceLimit, wantErr: errAgentWorkspaceLimit,
			wantStatus: "failed", wantCode: "catalog_capacity_reached", failed: 1, remaining: 1,
		},
		{
			name: "daily budget", discoverErr: errAgentRepositoryDiscoveryStopped, wantErr: errAgentRepositoryDiscoveryStopped,
			jobErr:     context.DeadlineExceeded,
			wantStatus: "failed", wantCode: "daily_budget_or_day_changed", failed: 1, remaining: 1,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			// Start with the last daily slot: losing a committed addition here
			// would falsely leave capacity for another candidate in this run.
			summary := SystemRepositoryDiscoverySummary{
				Day: "2026-10-28", AlreadyAdded: agentRepositoryDiscoveryDailyLimit - 1,
				Candidates: 25, Checked: 1, Remaining: 1,
			}
			wantSummary := summary
			wantSummary.Added, wantSummary.WouldAdd, wantSummary.Skipped = tc.added, tc.wouldAdd, tc.skipped
			wantSummary.Failed, wantSummary.Remaining = tc.failed, tc.remaining
			input := SystemRepositoryDiscoveryResult{
				Repository: "https://github.com/example/skills", Stars: 1234,
				Status: tc.status, WorkspaceID: tc.workspaceID,
			}
			wantResult := input
			wantResult.Status, wantResult.Code = tc.wantStatus, tc.wantCode
			result, err := summary.recordResult(input, tc.discoverErr, tc.jobErr)
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("error = %v, want %v", err, tc.wantErr)
			}
			if tc.discoverErr != nil && err != tc.discoverErr {
				t.Fatalf("original failure was replaced: got %v, want %v", err, tc.discoverErr)
			}
			if result != wantResult {
				t.Fatalf("result = %+v, want %+v", result, wantResult)
			}
			if summary != wantSummary {
				t.Fatalf("summary = %+v, want %+v", summary, wantSummary)
			}
		})
	}
}

// Cancel precisely when the deferred staging cleanup starts, after the actual
// publication transaction has committed. No sleeps or production timeout changes
// are needed to reproduce the commit/cleanup boundary.
type discoveryCleanupTracer struct {
	once    sync.Once
	cleanup func()
}

func (tracer *discoveryCleanupTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if strings.HasPrefix(data.SQL, "UPDATE agent_repository_objects SET delete_after=") {
		tracer.once.Do(tracer.cleanup)
	}
	return ctx
}

func (*discoveryCleanupTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func TestSystemRepositoryDiscoveryCommittedAdditionSurvivesCleanupCancellation(t *testing.T) {
	app, _, f := newDiscoveryFixture(t, 2)
	day, _, err := systemRepositoryDiscoveryBudget(context.Background(), app.db)
	if err != nil {
		t.Fatal(err)
	}
	// Leave the final daily slot, including the historical rows in the
	// fixture's existing cleanup range.
	for i := int64(100); i < 119; i++ {
		if _, err := app.db.Exec(context.Background(), `INSERT INTO agent_repository_discoveries(github_id,repository_url,github_stars,code,accepted_on)
 VALUES($1,'https://github.com/test/previous',100,'added',$2::date)`, f.items[0].ID+i, day); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	cleanupStarted := false
	originalPool := app.db
	poolConfig := originalPool.Config()
	poolConfig.ConnConfig.Tracer = &discoveryCleanupTracer{cleanup: func() {
		cleanupStarted = true
		cancel()
	}}
	tracedPool, err := pgxpool.NewWithConfig(context.Background(), poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	app.db = tracedPool
	t.Cleanup(func() {
		app.db = originalPool
		tracedPool.Close()
	})
	var results []SystemRepositoryDiscoveryResult
	summary, err := app.DiscoverSystemAgentRepositories(ctx, SystemRepositoryDiscoveryOptions{
		Apply: true, GitHubToken: "discovery-test-token",
		OnResult: func(result SystemRepositoryDiscoveryResult) { results = append(results, result) },
	})
	if !cleanupStarted || !errors.Is(err, context.Canceled) {
		t.Fatalf("cleanup cancellation: started=%v, err=%v", cleanupStarted, err)
	}
	if summary.AlreadyAdded != agentRepositoryDiscoveryDailyLimit-1 || summary.Checked != 1 || summary.Added != 1 || summary.Failed != 0 || summary.Remaining != 0 {
		t.Fatalf("committed addition was lost after cleanup: %+v", summary)
	}
	if len(results) != 1 || results[0].Status != "added" || results[0].WorkspaceID <= 0 || results[0].Code != "" {
		t.Fatalf("committed result was rewritten: %+v", results)
	}
	var accepted, published bool
	if err := app.db.QueryRow(context.Background(), `SELECT EXISTS(
 SELECT 1 FROM agent_repository_discoveries WHERE github_id=$1 AND workspace_id=$2 AND accepted_on IS NOT NULL AND code='added'),
 EXISTS(SELECT 1 FROM agent_repository_publications WHERE workspace_id=$2)`, f.items[1].ID, results[0].WorkspaceID).Scan(&accepted, &published); err != nil || !accepted || !published {
		t.Fatalf("reported addition was not committed: accepted=%v published=%v err=%v", accepted, published, err)
	}
	_, count, err := systemRepositoryDiscoveryBudget(context.Background(), app.db)
	if err != nil || count != agentRepositoryDiscoveryDailyLimit {
		t.Fatalf("committed daily budget = %d, err=%v", count, err)
	}
	// A resumed run must stop at the durable daily limit rather than refunding
	// the interrupted run's committed slot and adding the remaining candidate.
	searches, archives := f.searchCalls, f.archiveCalls
	summary, _, err = runDiscovery(app, true)
	if err != nil || summary.AlreadyAdded != agentRepositoryDiscoveryDailyLimit || summary.Added != 0 || summary.Failed != 0 || summary.Remaining != 0 || summary.Outcome != "daily_target_reached" {
		t.Fatalf("retry did not retain committed daily usage: %+v %v", summary, err)
	}
	if f.searchCalls != searches || f.archiveCalls != archives {
		t.Fatal("retry did upstream work after the daily limit")
	}
}
