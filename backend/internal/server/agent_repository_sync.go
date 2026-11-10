package server

import (
	"context"
	"errors"
	"strings"
	"time"
)

const agentRepositorySyncLock int64 = 0x4147454e5453594e

var (
	errAgentRepositorySyncBusy               = errors.New("a system repository sync is already running")
	errAgentRepositorySyncLicense            = errors.New("upstream license changed or is unspecified")
	errAgentRepositorySyncLicenseReview      = errors.New("upstream license files require review")
	errAgentRepositorySyncPublicationLicense = errors.New("publication license differs from the upstream license")
	errAgentRepositorySyncIdentity           = errors.New("upstream repository identity changed or is unknown")
)

// ErrSystemRepositoriesNeedAttention reports a sweep that ran correctly but found
// entries whose license or recorded identity needs human review. Archived,
// disabled, unavailable or private upstreams are marked and skipped instead.
// The scheduled workflow logs review-only failures without paging someone every
// night. Transient faults are reported as ordinary failures.
var ErrSystemRepositoriesNeedAttention = errors.New("some system repositories need attention")

type SystemRepositorySyncOptions struct {
	Apply       bool
	GitHubToken string
	WorkspaceID int64 // Zero selects every live system repository.
	OnResult    func(SystemRepositorySyncResult)
}

type SystemRepositorySyncResult struct {
	WorkspaceID int64  `json:"workspaceId"`
	Repository  string `json:"repository"`
	Status      string `json:"status"`
	Code        string `json:"code,omitempty"`
	WarningCode string `json:"warningCode,omitempty"`
	PreviousSHA string `json:"previousSHA,omitempty"`
	CurrentSHA  string `json:"currentSHA,omitempty"`
}

type SystemRepositorySyncSummary struct {
	ResumedAfter int64 `json:"resumedAfter,omitempty"`
	ResumeAfter  int64 `json:"resumeAfter,omitempty"`
	Total        int   `json:"total"`
	Processed    int   `json:"processed"`
	Updated      int   `json:"updated"`
	Unchanged    int   `json:"unchanged"`
	WouldUpdate  int   `json:"wouldUpdate"`
	Skipped      int   `json:"skipped"`
	Failed       int   `json:"failed"`
	// NeedsAttention counts the subset of Failed whose upstream state is
	// permanent, so operators can tell "retry later" from "retire this entry".
	NeedsAttention int `json:"needsAttention"`
}

// This is a maintenance command, not an HTTP/Agent-token write path. The lock
// only serializes sync commands; downloads do not hold the catalog's write lock.
func (a *App) SyncSystemAgentRepositories(ctx context.Context, options SystemRepositorySyncOptions) (SystemRepositorySyncSummary, error) {
	return a.syncSystemAgentRepositories(ctx, options, 5*time.Minute)
}

// reconcileSystemRepositorySyncResult preserves a completed result when the
// per-item context expires just after syncSystemAgentRepository returns. The
// deferred staging cleanup can cross that deadline after an update transaction
// commits, but the same boundary also applies to unchanged, skipped and preview
// results. Only an unfinished result may inherit the job error.
func reconcileSystemRepositorySyncResult(result SystemRepositorySyncResult, syncErr, jobErr error) (SystemRepositorySyncResult, error, bool) {
	completed := syncErr == nil
	if completed {
		switch result.Status {
		case "updated", "unchanged", "would_update", "skipped":
		default:
			completed = false
		}
	}
	if jobErr != nil && syncErr == nil && !completed {
		syncErr = jobErr
	}
	return result, syncErr, completed
}

func (a *App) syncSystemAgentRepositories(ctx context.Context, options SystemRepositorySyncOptions, itemTimeout time.Duration) (SystemRepositorySyncSummary, error) {
	var summary SystemRepositorySyncSummary
	if options.WorkspaceID < 0 || strings.TrimSpace(options.GitHubToken) == "" {
		return summary, errors.New("a GitHub token and nonnegative workspace ID are required")
	}
	lock, err := a.db.Begin(ctx)
	if err != nil {
		return summary, err
	}
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = lock.Rollback(cleanup)
	}()
	var acquired bool
	if err = lock.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock($1)`, agentRepositorySyncLock).Scan(&acquired); err != nil {
		return summary, err
	}
	if !acquired {
		return summary, errAgentRepositorySyncBusy
	}
	// Persist progress outside the lock transaction (which is rolled back on
	// exit). Preview and targeted runs must never consume the full job's cursor.
	checkpoint := options.Apply && options.WorkspaceID == 0
	if checkpoint {
		if err = a.db.QueryRow(ctx, `SELECT last_workspace_id FROM agent_repository_sync_progress WHERE singleton`).Scan(&summary.ResumedAfter); err != nil {
			return summary, err
		}
		summary.ResumeAfter = summary.ResumedAfter
	}
	rows, err := a.db.Query(ctx, `SELECT `+agentRepositorySyncSnapshotColumns+`
 FROM agent_workspaces w LEFT JOIN agent_repository_publications p ON p.workspace_id=w.id
 WHERE w.is_system AND w.deleted_at IS NULL AND ($1::bigint=0 OR w.id=$1) AND w.id>$2 ORDER BY w.id`, options.WorkspaceID, summary.ResumedAfter)
	if err != nil {
		return summary, err
	}
	var items []agentRepositorySyncSnapshot
	for rows.Next() {
		var item agentRepositorySyncSnapshot
		if item, err = scanAgentRepositorySyncSnapshot(rows); err != nil {
			rows.Close()
			return summary, err
		}
		items = append(items, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return summary, err
	}
	if options.WorkspaceID != 0 && len(items) == 0 {
		return summary, errAgentWorkspaceNotFound
	}
	summary.Total = len(items)
	for _, item := range items {
		// A closed/expired lock transaction must stop the job, not silently leave
		// the remainder running without mutual exclusion.
		if _, err = lock.Exec(ctx, `SELECT 1`); err != nil {
			return summary, err
		}
		jobCtx, cancel := context.WithTimeout(ctx, itemTimeout)
		result, syncErr := a.syncSystemAgentRepository(jobCtx, item, options)
		// Capture the deadline before cancel(): a healthy item would otherwise
		// read Canceled after the explicit cancel and look interrupted.
		jobErr := jobCtx.Err()
		result, syncErr, _ = reconcileSystemRepositorySyncResult(result, syncErr, jobErr)
		cancel()
		summary.Processed++
		if syncErr != nil {
			result.Status, result.Code = "failed", systemRepositorySyncErrorCode(syncErr)
			summary.Failed++
			if systemRepositorySyncNeedsAttention(result.Code) {
				summary.NeedsAttention++
			}
		} else {
			switch result.Status {
			case "updated":
				summary.Updated++
			case "unchanged":
				summary.Unchanged++
			case "would_update":
				summary.WouldUpdate++
			case "skipped":
				summary.Skipped++
			}
		}
		// Retry the interrupted/rate-limited item on the next run. Ordinary
		// per-repository failures still allow later repositories to make progress;
		// they will be checked again in the next complete sweep. A per-item
		// timeout is one of them: stopping there would restart every later run at
		// the same slow repository and never reach the ones after it. The sweep's
		// end resets the checkpoint, so the timed-out item is retried next time.
		stopped := ctx.Err() != nil || errors.Is(syncErr, errAgentGitHubRateLimited) || errors.Is(syncErr, errAgentGitHubCredentialRequired)
		if checkpoint && !stopped {
			if _, err = a.db.Exec(ctx, `UPDATE agent_repository_sync_progress SET last_workspace_id=$1 WHERE singleton`, item.id); err != nil {
				return summary, err
			}
			summary.ResumeAfter = item.id
		}
		if options.OnResult != nil {
			options.OnResult(result)
		}
		if ctx.Err() != nil {
			return summary, ctx.Err()
		}
		// Avoid wasting all remaining requests when a shared token is exhausted.
		if stopped {
			return summary, syncErr
		}
	}
	if checkpoint {
		if _, err = a.db.Exec(ctx, `UPDATE agent_repository_sync_progress SET last_workspace_id=0 WHERE singleton`); err != nil {
			return summary, err
		}
		summary.ResumeAfter = 0
	}
	if summary.Failed > 0 {
		if summary.NeedsAttention == summary.Failed {
			// Nothing retryable happened: the sweep did its job and the remaining
			// entries are waiting on a person, so do not report a broken job.
			return summary, ErrSystemRepositoriesNeedAttention
		}
		return summary, errors.New("some system repositories could not be updated; see per-repository results")
	}
	return summary, nil
}

// systemRepositorySyncNeedsAttention lists the permanent states that no number
// of retries can clear and that the sweep does not already settle as a skip.
// Archived, disabled, unavailable and private upstreams are recorded as terminal
// skips with retained bytes, so they no longer page an operator. Everything else
// (rate limits, credentials, transport faults, storage faults, interruptions)
// stays a real failure so it still alerts.
func systemRepositorySyncNeedsAttention(code string) bool {
	switch code {
	case "license_changed", "license_review_required", "publication_license_mismatch", "repository_identity_mismatch":
		return true
	default:
		return false
	}
}

// SystemRepositoryErrorCode classifies a maintenance command error for logs
// without exposing the raw error, which can contain connection details.
func SystemRepositoryErrorCode(err error) string { return systemRepositorySyncErrorCode(err) }

func systemRepositorySyncErrorCode(err error) string {
	var sensitive *agentWorkspaceSensitiveError
	switch {
	case errors.As(err, &sensitive):
		return "sensitive_data_detected"
	case errors.Is(err, errAgentRepositorySyncLicense):
		return "license_changed"
	case errors.Is(err, errAgentRepositorySyncLicenseReview):
		return "license_review_required"
	case errors.Is(err, errAgentRepositorySyncPublicationLicense):
		return "publication_license_mismatch"
	case errors.Is(err, errAgentRepositorySyncIdentity):
		return "repository_identity_mismatch"
	case errors.Is(err, errAgentGitHubRateLimited):
		return "github_rate_limited"
	case errors.Is(err, errAgentGitHubCredentialRequired):
		return "github_credentials_invalid"
	case errors.Is(err, errAgentGitHubAccessDenied):
		return "github_access_denied"
	case errors.Is(err, errAgentGitHubTransient):
		return "github_transient_error"
	case errors.Is(err, errAgentGitHubResponseInvalid):
		return "github_response_invalid"
	case errors.Is(err, errAgentGitHubRequestInvalid):
		return "github_request_invalid"
	case errors.Is(err, errAgentGitHubSearchIncomplete):
		return "github_search_incomplete"
	case errors.Is(err, errAgentGitHubRepositoryMissing):
		return "github_unavailable"
	case errors.Is(err, errAgentGitHubDownloadFailed):
		return "github_download_failed"
	case errors.Is(err, errAgentGitHubRepositoryInvalid):
		return "invalid_or_private_source"
	case errors.Is(err, errAgentGitHubArchiveInvalid):
		return "archive_rejected"
	case errors.Is(err, errAgentWorkspaceConflict), errors.Is(err, errAgentWorkspaceNotFound):
		return "repository_changed"
	case errors.Is(err, errAgentRepositoryStorage):
		return "storage_unavailable"
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return "interrupted"
	default:
		return "sync_failed"
	}
}

func (a *App) syncSystemAgentRepository(ctx context.Context, item agentRepositorySyncSnapshot, options SystemRepositorySyncOptions) (SystemRepositorySyncResult, error) {
	result := SystemRepositorySyncResult{WorkspaceID: item.id}
	refresh, err := a.refreshAgentRepository(ctx, item, agentRepositoryRefreshOptions{Apply: options.Apply, GitHubToken: options.GitHubToken})
	result.Repository, result.Status, result.Code = refresh.Repository, refresh.Status, refresh.Code
	result.PreviousSHA, result.CurrentSHA = refresh.PreviousSHA, refresh.CurrentSHA
	return result, err
}
