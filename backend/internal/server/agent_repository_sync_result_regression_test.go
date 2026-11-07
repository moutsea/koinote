package server

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type syncStagingCleanupDelayTracer struct {
	once    sync.Once
	delay   time.Duration
	started bool
}

func (tracer *syncStagingCleanupDelayTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	if strings.Contains(data.SQL, "UPDATE agent_repository_objects SET delete_after=") {
		tracer.once.Do(func() {
			tracer.started = true
			time.Sleep(tracer.delay)
		})
	}
	return ctx
}

func (*syncStagingCleanupDelayTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {
}

func TestSystemRepositorySyncCommittedUpdateSurvivesCleanupDeadline(t *testing.T) {
	app, before, _, _, upstream := seedSystemRepositorySync(t, true)
	ctx := context.Background()
	originalPool := app.db
	poolConfig := originalPool.Config()
	tracer := &syncStagingCleanupDelayTracer{delay: 2200 * time.Millisecond}
	poolConfig.ConnConfig.Tracer = tracer
	tracedPool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		t.Fatal(err)
	}
	app.db = tracedPool
	t.Cleanup(func() {
		app.db = originalPool
		tracedPool.Close()
	})
	var results []SystemRepositorySyncResult
	summary, err := app.syncSystemAgentRepositories(ctx, SystemRepositorySyncOptions{
		Apply: true, GitHubToken: "sync-test-token", WorkspaceID: before.WorkspaceID,
		OnResult: func(result SystemRepositorySyncResult) { results = append(results, result) },
	}, 2*time.Second)
	if !tracer.started {
		t.Fatal("sync did not reach staging cleanup after committing")
	}
	if err != nil {
		t.Fatalf("committed sync failed after cleanup crossed item deadline: %v", err)
	}
	if summary.Processed != 1 || summary.Updated != 1 || summary.Failed != 0 || len(results) != 1 {
		t.Fatalf("committed update was reported as failed: summary=%+v results=%+v", summary, results)
	}
	if results[0].Status != "updated" || results[0].Code != "" || results[0].CurrentSHA != githubSyncTestSHA {
		t.Fatalf("committed result was rewritten: %+v", results[0])
	}
	current, err := loadAgentWorkspaceForOwner(ctx, app.db, nil, before.WorkspaceID)
	if err != nil || current.GitHubSource.CommitSHA != githubSyncTestSHA || current.Revision <= before.Revision {
		t.Fatalf("sync transaction was not committed: revision=%d sha=%s err=%v", current.Revision, current.GitHubSource.CommitSHA, err)
	}
	var events int
	if err := app.db.QueryRow(ctx, `SELECT count(*) FROM agent_repository_system_events WHERE workspace_id=$1 AND action='sync' AND revision=$2`, before.WorkspaceID, current.Revision).Scan(&events); err != nil || events != 1 {
		t.Fatalf("committed sync event count=%d, err=%v", events, err)
	}
	if upstream.archives != 1 {
		t.Fatalf("expected one archive download, got %d", upstream.archives)
	}
}

func TestReconcileSystemRepositorySyncResult(t *testing.T) {
	transientErr := errors.New("upstream failed")
	for _, tc := range []struct {
		name      string
		status    string
		syncErr   error
		jobErr    error
		wantErr   error
		completed bool
	}{
		{
			name:   "committed update survives cleanup deadline",
			status: "updated", jobErr: context.DeadlineExceeded,
			completed: true,
		},
		{
			name:   "committed update survives cleanup cancellation",
			status: "updated", jobErr: context.Canceled,
			completed: true,
		},
		{
			name:   "unfinished update remains retryable",
			status: "", jobErr: context.DeadlineExceeded,
			wantErr: context.DeadlineExceeded,
		},
		{
			name:      "unchanged result survives cleanup deadline",
			status:    "unchanged",
			jobErr:    context.DeadlineExceeded,
			completed: true,
		},
		{
			name:      "preview result survives cleanup deadline",
			status:    "would_update",
			jobErr:    context.DeadlineExceeded,
			completed: true,
		},
		{
			name:      "skipped result survives cleanup deadline",
			status:    "skipped",
			jobErr:    context.DeadlineExceeded,
			completed: true,
		},
		{
			name:   "original transient error is not overwritten",
			status: "", syncErr: transientErr, jobErr: context.DeadlineExceeded,
			wantErr: transientErr,
		},
		{
			name:   "license error is not overwritten",
			status: "", syncErr: errAgentRepositorySyncLicense, jobErr: context.DeadlineExceeded,
			wantErr: errAgentRepositorySyncLicense,
		},
		{
			name:   "identity error is not overwritten",
			status: "", syncErr: errAgentRepositorySyncIdentity, jobErr: context.DeadlineExceeded,
			wantErr: errAgentRepositorySyncIdentity,
		},
		{
			name:   "successful update without deadline is committed",
			status: "updated", completed: true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			result, err, committed := reconcileSystemRepositorySyncResult(SystemRepositorySyncResult{Status: tc.status}, tc.syncErr, tc.jobErr)
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("error=%v, want=%v", err, tc.wantErr)
			}
			if committed != tc.completed {
				t.Fatalf("completed=%v, want=%v; result=%+v", committed, tc.completed, result)
			}
			if result.Status != tc.status {
				t.Fatalf("result status=%q, want=%q", result.Status, tc.status)
			}
		})
	}
}
