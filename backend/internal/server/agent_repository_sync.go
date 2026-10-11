package server

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

const agentRepositorySyncLock int64 = 0x4147454e5453594e

var (
	errAgentRepositorySyncBusy          = errors.New("a system repository sync is already running")
	errAgentRepositorySyncLicense       = errors.New("upstream license changed or is unspecified")
	errAgentRepositorySyncLicenseReview = errors.New("upstream license files require review")
	errAgentRepositorySyncIdentity      = errors.New("upstream repository identity changed or is unknown")
)

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
}

type systemRepositorySyncSnapshot struct {
	id, revision      int64
	name, description string
	source            *agentGitHubSource
	publishedRevision *int64
	publishedAt       *time.Time
	license           *string
}

// This is a maintenance command, not an HTTP/Agent-token write path. The lock
// only serializes sync commands; downloads do not hold the catalog's write lock.
func (a *App) SyncSystemAgentRepositories(ctx context.Context, options SystemRepositorySyncOptions) (SystemRepositorySyncSummary, error) {
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
	rows, err := a.db.Query(ctx, `SELECT w.id,w.revision,w.name,w.description,w.github_source,p.revision,p.published_at,p.license
 FROM agent_workspaces w LEFT JOIN agent_repository_publications p ON p.workspace_id=w.id
 WHERE w.is_system AND w.deleted_at IS NULL AND ($1::bigint=0 OR w.id=$1) AND w.id>$2 ORDER BY w.id`, options.WorkspaceID, summary.ResumedAfter)
	if err != nil {
		return summary, err
	}
	var items []systemRepositorySyncSnapshot
	for rows.Next() {
		var item systemRepositorySyncSnapshot
		if err = rows.Scan(&item.id, &item.revision, &item.name, &item.description, &item.source, &item.publishedRevision, &item.publishedAt, &item.license); err != nil {
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
		jobCtx, cancel := context.WithTimeout(ctx, 5*time.Minute)
		result, syncErr := a.syncSystemAgentRepository(jobCtx, item, options)
		if jobCtx.Err() != nil {
			syncErr = jobCtx.Err()
		}
		cancel()
		summary.Processed++
		if syncErr != nil {
			result.Status, result.Code = "failed", systemRepositorySyncErrorCode(syncErr)
			summary.Failed++
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
		// they will be checked again in the next complete sweep.
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
		return summary, errors.New("some system repositories could not be updated; see per-repository results")
	}
	return summary, nil
}

func systemRepositorySyncErrorCode(err error) string {
	var sensitive *agentWorkspaceSensitiveError
	switch {
	case errors.As(err, &sensitive):
		return "sensitive_data_detected"
	case errors.Is(err, errAgentRepositorySyncLicense):
		return "license_changed"
	case errors.Is(err, errAgentRepositorySyncLicenseReview):
		return "license_review_required"
	case errors.Is(err, errAgentRepositorySyncIdentity):
		return "repository_identity_mismatch"
	case errors.Is(err, errAgentGitHubRateLimited):
		return "github_rate_limited"
	case errors.Is(err, errAgentGitHubCredentialRequired):
		return "github_credentials_invalid"
	case errors.Is(err, errAgentGitHubAccessDenied):
		return "github_access_denied"
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

func (a *App) syncSystemAgentRepository(ctx context.Context, item systemRepositorySyncSnapshot, options SystemRepositorySyncOptions) (SystemRepositorySyncResult, error) {
	result := SystemRepositorySyncResult{WorkspaceID: item.id}
	if item.source == nil {
		result.Status, result.Code = "skipped", "no_github_source"
		return result, nil
	}
	result.Repository, result.PreviousSHA = item.source.RepositoryURL, item.source.CommitSHA
	owner, repo, _, err := parseGitHubRepositoryURL(item.source.RepositoryURL)
	if err != nil || item.source.Private {
		return result, errAgentGitHubRepositoryInvalid
	}
	// Legacy launch entries are backfilled from their original saved GitHub
	// metadata by the safety migration. Never trust the current URL to establish
	// a missing identity: deleted/renamed repository names can be reused.
	if item.source.RepositoryID <= 0 {
		return result, errAgentRepositorySyncIdentity
	}
	// Seed imports pin a commit. Daily refreshes deliberately follow the current
	// default branch instead of resolving that permanently pinned initial ref.
	metadata, source, err := a.resolveGitHubRepository(ctx, owner, repo, "", options.GitHubToken, true)
	if err != nil {
		return result, err
	}
	result.CurrentSHA = source.CommitSHA
	if source.RepositoryID != item.source.RepositoryID {
		return result, errAgentRepositorySyncIdentity
	}
	if source.License == "UNLICENSED" || source.License != item.source.License || (item.license != nil && *item.license != source.License) {
		return result, errAgentRepositorySyncLicense
	}
	if source.CommitSHA == item.source.CommitSHA {
		if source.RepositoryURL != item.source.RepositoryURL || source.Author != item.source.Author || source.AuthorURL != item.source.AuthorURL {
			result.Repository, result.Code = source.RepositoryURL, "source_updated"
			if !options.Apply {
				result.Status = "would_update"
				return result, nil
			}
			if err = a.updateSystemRepositorySource(ctx, item, source); err != nil {
				return result, err
			}
			result.Status = "updated"
			return result, nil
		}
		result.Status = "unchanged"
		return result, nil
	}
	files, err := a.downloadGitHubRepository(ctx, metadata.Owner.Login, metadata.Name, source.CommitSHA, options.GitHubToken)
	if err != nil {
		return result, err
	}
	// Apply the same path/metadata publication boundary even for withdrawn rows;
	// bytes have already passed readGitHubArchive's content and size checks.
	if agentWorkspaceSensitiveContent([]byte(item.name + "\n" + item.description)) {
		return result, &agentWorkspaceSensitiveError{Path: "repository metadata"}
	}
	for _, file := range files {
		if agentRepositorySensitivePath(file.Path) || agentWorkspaceSensitiveContent([]byte(file.Path)) {
			return result, &agentWorkspaceSensitiveError{Path: file.Path}
		}
	}
	if discoveryManualLicenseReview(metadata.FullName) || !systemRepositoryLicenseFilesAllowed(files, source.RepositoryID, source.License) {
		return result, errAgentRepositorySyncLicenseReview
	}
	if !options.Apply {
		result.Status = "would_update"
		return result, nil
	}
	if err = a.applySystemRepositorySync(ctx, item, source, files); err != nil {
		return result, err
	}
	result.Status = "updated"
	return result, nil
}

// A rename/transfer can happen without a new commit. Refresh canonical location
// and attribution without touching files, revisions, pinned refs or publication
// timestamps. Personal Forks retain their own provenance.
func (a *App) updateSystemRepositorySource(ctx context.Context, before systemRepositorySyncSnapshot, source *agentGitHubSource) error {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = lockSystemRepositorySyncSnapshot(ctx, tx, before); err != nil {
		return err
	}
	location := map[string]string{"repositoryUrl": source.RepositoryURL, "author": source.Author, "authorUrl": source.AuthorURL}
	if _, err = tx.Exec(ctx, `UPDATE agent_workspaces SET github_source=github_source || $2::jsonb,updated_at=now() WHERE id=$1`, before.id, location); err != nil {
		return err
	}
	if before.publishedRevision != nil {
		if _, err = tx.Exec(ctx, `UPDATE agent_repository_publications SET github_source=github_source || $2::jsonb WHERE workspace_id=$1`, before.id, location); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(ctx, `INSERT INTO agent_repository_system_events(workspace_id,actor_user_id,action,revision) VALUES($1,NULL,'sync',$2)`, before.id, before.revision); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Both content and source-only updates must preserve concurrent administrator
// edits, withdrawals and republications, even when the revision is unchanged.
func lockSystemRepositorySyncSnapshot(ctx context.Context, tx pgx.Tx, before systemRepositorySyncSnapshot) error {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, agentRepositoryOwnerLock(nil)); err != nil {
		return err
	}
	var current systemRepositorySyncSnapshot
	err := tx.QueryRow(ctx, `SELECT w.id,w.revision,w.name,w.description,w.github_source,p.revision,p.published_at,p.license
 FROM agent_workspaces w LEFT JOIN agent_repository_publications p ON p.workspace_id=w.id
 WHERE w.id=$1 AND w.is_system AND w.deleted_at IS NULL FOR UPDATE OF w`, before.id).Scan(&current.id, &current.revision, &current.name, &current.description, &current.source, &current.publishedRevision, &current.publishedAt, &current.license)
	if errors.Is(err, pgx.ErrNoRows) {
		return errAgentWorkspaceNotFound
	}
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(current, before) {
		return errAgentWorkspaceConflict
	}
	return nil
}

func (a *App) applySystemRepositorySync(ctx context.Context, before systemRepositorySyncSnapshot, source *agentGitHubSource, files []agentWorkspaceFile) error {
	// Reuse immutable R2 blobs; a one-file upstream edit should not upload every
	// other file again. Missing/new blobs are staged before taking write locks.
	keys := map[string]string{}
	missing := files
	if a.agentObjectStore != nil {
		rows, err := a.db.Query(ctx, `SELECT sha256,r2_object_key FROM agent_workspace_blobs WHERE workspace_id=$1 AND r2_object_key IS NOT NULL`, before.id)
		if err != nil {
			return err
		}
		for rows.Next() {
			var hash, key string
			if err = rows.Scan(&hash, &key); err != nil {
				rows.Close()
				return err
			}
			keys[hash] = key
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		missing = make([]agentWorkspaceFile, 0, len(files))
		for _, file := range files {
			if keys[file.SHA256] == "" {
				missing = append(missing, file)
			}
		}
	}
	uploaded, err := a.stageAgentRepositoryFilesForOwner(ctx, nil, missing)
	if err != nil {
		return err
	}
	defer a.expireAgentRepositoryStaging(ctx, uploaded)
	for hash, key := range uploaded {
		keys[hash] = key
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if err = lockSystemRepositorySyncSnapshot(ctx, tx, before); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `SELECT record_agent_workspace_commit($1,'baseline')`, before.id); err != nil {
		return err
	}
	paths := make([]string, 0, len(files))
	scans := agentRepositoryContentScans{policy: agentWorkspaceSensitivePolicyID()}
	for _, file := range files {
		if err = insertAgentRepositoryFile(ctx, tx, before.id, file, keys); err != nil {
			return err
		}
		paths = append(paths, file.Path)
		scans.hashes = append(scans.hashes, file.SHA256)
		scans.sensitive = append(scans.sensitive, false)
	}
	if _, err = tx.Exec(ctx, `DELETE FROM agent_workspace_files WHERE workspace_id=$1 AND NOT (path=ANY($2::text[]))`, before.id, paths); err != nil {
		return err
	}
	var revision int64
	if err = tx.QueryRow(ctx, `UPDATE agent_workspaces SET revision=revision+1,updated_at=now(),github_source=$2 WHERE id=$1 RETURNING revision`, before.id, source).Scan(&revision); err != nil {
		return err
	}
	comment := fmt.Sprintf("Daily GitHub sync: %s -> %s", before.source.CommitSHA, source.CommitSHA)
	if _, err = tx.Exec(ctx, `SELECT record_agent_workspace_commit($1,'update',NULL,$2)`, before.id, comment); err != nil {
		return err
	}
	if err = scans.save(ctx, tx, before.id); err != nil {
		return err
	}
	if before.publishedRevision != nil {
		if _, err = tx.Exec(ctx, `UPDATE agent_repository_publications SET revision=$2,github_source=(SELECT github_source-'private' FROM agent_workspaces WHERE id=$1),published_at=now() WHERE workspace_id=$1`, before.id, revision); err != nil {
			return err
		}
		if err = replaceAgentRepositoryPublicationFiles(ctx, tx, before.id); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(ctx, `SELECT prune_agent_workspace_history($1,100000000)`, before.id); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO agent_repository_system_events(workspace_id,actor_user_id,action,revision) VALUES($1,NULL,'sync',$2)`, before.id, revision); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
