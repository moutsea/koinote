package server

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"time"

	"github.com/jackc/pgx/v5"
)

// Persisted terminal upstream states. A repository keeps serving its last good
// snapshot; only a later successful refresh clears the mark.
const (
	agentUpstreamArchived    = "archived"
	agentUpstreamDisabled    = "disabled"
	agentUpstreamUnavailable = "unavailable"
	agentUpstreamPrivate     = "private"
)

const agentRepositorySyncSnapshotColumns = `w.id,w.user_id,w.revision,w.name,w.description,w.github_source,p.revision,p.published_at,p.license,
 EXISTS(SELECT 1 FROM agent_repository_forks f WHERE f.workspace_id=w.id)`

// agentRepositorySyncSnapshot is the exact live state a refresh decided on. The
// apply transaction re-reads it and rejects any concurrent edit, withdrawal or
// republication, even when the revision did not change.
type agentRepositorySyncSnapshot struct {
	id, revision      int64
	ownerID           *int
	personalFork      bool
	name, description string
	source            *agentGitHubSource
	publishedRevision *int64
	publishedAt       *time.Time
	license           *string
}

func scanAgentRepositorySyncSnapshot(row pgx.Row) (agentRepositorySyncSnapshot, error) {
	var item agentRepositorySyncSnapshot
	err := row.Scan(&item.id, &item.ownerID, &item.revision, &item.name, &item.description, &item.source,
		&item.publishedRevision, &item.publishedAt, &item.license, &item.personalFork)
	return item, err
}

func (a *App) loadAgentRepositorySyncSnapshot(ctx context.Context, queries agentWorkspaceQuerier, id int64) (agentRepositorySyncSnapshot, error) {
	item, err := scanAgentRepositorySyncSnapshot(queries.QueryRow(ctx, `SELECT `+agentRepositorySyncSnapshotColumns+`
 FROM agent_workspaces w LEFT JOIN agent_repository_publications p ON p.workspace_id=w.id
 WHERE w.id=$1 AND w.deleted_at IS NULL`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return item, errAgentWorkspaceNotFound
	}
	return item, err
}

type agentRepositoryRefreshOptions struct {
	Apply       bool
	GitHubToken string
	// An unreadable saved credential may use public access, but anonymous 404s
	// must retain credential guidance rather than retire a possibly private source.
	CredentialUnavailable bool
	// SkipMarked keeps a repository that already carries a terminal upstream mark
	// on its last good snapshot without spending any GitHub request. Fork and
	// Clone use it; an explicit manual refresh always rechecks.
	SkipMarked bool
	// Interactive marks a public viewer-triggered refresh. It shares the bounded
	// GitHub import admission capacity and may retry one rejected credential
	// anonymously. Maintenance sweeps leave it false: their shared token is
	// authoritative and a 401 must still stop the batch.
	Interactive bool
}

type agentRepositoryRefreshResult struct {
	Repository  string
	Status      string
	Code        string
	PreviousSHA string
	CurrentSHA  string
}

// Decide whether upstream work is needed before requiring credentials or source
// identity. Personal Forks and edited copies only serve their saved snapshot.
func agentRepositoryRefreshSkipReason(ctx context.Context, queries agentWorkspaceQuerier, before agentRepositorySyncSnapshot, skipMarked bool) (string, error) {
	if before.source == nil {
		return "no_github_source", nil
	}
	if before.source.LinkOnly {
		return "link_only", nil
	}
	if skipMarked && before.source.UpstreamStatus != "" {
		return before.source.UpstreamStatus, nil
	}
	if before.ownerID == nil {
		return "", nil
	}
	if before.personalFork {
		return "personal_fork", nil
	}
	var enabled bool
	if err := queries.QueryRow(ctx, `SELECT COALESCE((SELECT enabled FROM agent_workspace_settings WHERE user_id=$1),false)`, *before.ownerID).Scan(&enabled); err != nil {
		return "", err
	}
	if !enabled {
		return "agent_workspace_disabled", nil
	}
	if before.publishedRevision != nil && *before.publishedRevision != before.revision {
		return "local_changes", nil
	}
	var action string
	err := queries.QueryRow(ctx, `SELECT action FROM agent_workspace_commits WHERE workspace_id=$1 AND action<>'baseline' ORDER BY revision DESC LIMIT 1`, before.id).Scan(&action)
	if errors.Is(err, pgx.ErrNoRows) {
		return "local_changes", nil
	}
	if err != nil {
		return "", err
	}
	// Only the importer's own commit and this engine's sync commit leave the copy
	// exactly as upstream produced it. Every other action ('create','patch',
	// 'replace','restore','metadata','readme-update','fork',...) means the owner
	// changed their copy, so an automatic refresh would discard local work.
	switch action {
	case "import", "update":
		return "", nil
	default:
		return "local_changes", nil
	}
}

// agentGitHubTokenRejected reports whether GitHub rejected the supplied token
// itself. A rate limit (including a 403 carrying rate-limit headers) is not a
// credential failure and must never trigger an anonymous retry.
func agentGitHubTokenRejected(err error) bool {
	return errors.Is(err, errAgentGitHubCredentialRequired) || errors.Is(err, errAgentGitHubAccessDenied)
}

// agentGitHubFallbackError preserves the actionable credential failure when the
// anonymous attempt could not prove anything about a repository the token may
// legitimately access. Other anonymous failures (rate limits, transport faults)
// are more useful to the caller than a credential complaint.
func agentGitHubFallbackError(rejected, publicErr error) error {
	if rejected == nil {
		return publicErr
	}
	switch {
	case publicErr == nil:
		return nil
	case errors.Is(publicErr, errAgentGitHubRepositoryMissing),
		errors.Is(publicErr, errAgentGitHubCredentialRequired),
		errors.Is(publicErr, errAgentGitHubAccessDenied):
		return rejected
	default:
		return publicErr
	}
}

// refreshAgentRepository follows the current default branch of a GitHub-origin
// repository and applies the newest bytes when it is safe to do so. It never
// mutates a published snapshot on a transient, credential, storage or safety
// fault, and persists a terminal upstream mark only after the saved numeric
// repository identity matched.
func (a *App) refreshAgentRepository(ctx context.Context, before agentRepositorySyncSnapshot, options agentRepositoryRefreshOptions) (agentRepositoryRefreshResult, error) {
	result := agentRepositoryRefreshResult{Status: "skipped"}
	if before.source != nil {
		result.Repository, result.PreviousSHA = before.source.RepositoryURL, before.source.CommitSHA
	}
	code, err := agentRepositoryRefreshSkipReason(ctx, a.db, before, options.SkipMarked)
	if err != nil {
		return result, err
	}
	if code != "" {
		result.Code = code
		return result, nil
	}
	owner, repo, _, err := parseGitHubRepositoryURL(before.source.RepositoryURL)
	if err != nil {
		return result, errAgentGitHubRepositoryInvalid
	}
	// Never trust the current URL to establish a missing identity: deleted or
	// renamed repository names can be reused by someone else.
	if before.source.RepositoryID <= 0 {
		return result, errAgentRepositorySyncIdentity
	}
	// The shared catalog never serves private bytes. Record the terminal state
	// instead of spending any further upstream request.
	if before.ownerID == nil && before.source.Private {
		return a.settleAgentRepositoryUpstream(ctx, result, before, agentUpstreamPrivate, options)
	}
	// Interactive refreshes share the bounded GitHub work capacity with imports,
	// but only once the cheap no-network skips above have been ruled out. A
	// rejected personal token is replaced by anonymous public access below; the
	// shared maintenance token is authoritative and never falls back.
	if options.Interactive {
		if !a.acquireGitHubImportSlot() {
			return result, errAgentGitHubImportBusy
		}
		defer a.releaseGitHubImportSlot()
	}
	var rejected error
	if options.CredentialUnavailable {
		rejected = errAgentGitHubCredentialCrypto
	}
	result, err = a.refreshAgentRepositoryWithToken(ctx, before, options, owner, repo, options.GitHubToken, rejected)
	if options.Interactive && options.GitHubToken != "" && agentGitHubTokenRejected(err) {
		result, err = a.refreshAgentRepositoryWithToken(ctx, before, options, owner, repo, "", err)
	}
	if errors.Is(err, errAgentWorkspaceDisabled) {
		result.Status, result.Code = "skipped", "agent_workspace_disabled"
		return result, nil
	}
	return result, err
}

// Repeat the complete upstream resolution on fallback so anonymous access must
// independently confirm the repository's public visibility and numeric identity.
func (a *App) refreshAgentRepositoryWithToken(ctx context.Context, before agentRepositorySyncSnapshot, options agentRepositoryRefreshOptions, owner, repo, token string, rejected error) (agentRepositoryRefreshResult, error) {
	result := agentRepositoryRefreshResult{Status: "skipped", Repository: before.source.RepositoryURL, PreviousSHA: before.source.CommitSHA}
	skip := func(code string) (agentRepositoryRefreshResult, error) {
		result.Code = code
		return result, nil
	}
	metadata, err := a.resolveGitHubRepositoryMetadata(ctx, owner, repo, token, false)
	if token != "" && errors.Is(err, errAgentGitHubRepositoryMissing) {
		// GitHub also hides resources with 404 when a credential lacks access
		// (for example, an organization token without SSO authorization). Confirm
		// public visibility before persisting a mark shared by every viewer, and
		// use anonymous access for the remaining requests if it succeeds.
		token = ""
		metadata, err = a.resolveGitHubRepositoryMetadata(ctx, owner, repo, token, false)
	}
	if err != nil {
		if rejected != nil {
			return result, agentGitHubFallbackError(rejected, err)
		}
		if errors.Is(err, errAgentGitHubRepositoryMissing) {
			if before.source.Private && token == "" {
				return skip("github_token_required")
			}
			return a.settleAgentRepositoryUpstream(ctx, result, before, agentUpstreamUnavailable, options)
		}
		return result, err
	}
	// Terminal metadata is only trustworthy for the repository that actually owns
	// the saved URL.
	if metadata.ID != before.source.RepositoryID {
		if before.ownerID != nil {
			return skip("repository_identity_mismatch")
		}
		return result, errAgentRepositorySyncIdentity
	}
	// A published copy must never be republished from a private upstream, even
	// with the owner's token: the Hub only serves public repositories. Unpublished
	// personal copies may follow a private upstream with their owner's own token.
	if metadata.Private && rejected != nil {
		return result, rejected
	}
	if metadata.Private && (before.ownerID == nil || before.publishedRevision != nil) {
		return a.settleAgentRepositoryUpstream(ctx, result, before, agentUpstreamPrivate, options)
	}
	if metadata.Archived || metadata.Disabled {
		status := agentUpstreamArchived
		if metadata.Disabled {
			status = agentUpstreamDisabled
		}
		// Skip the commit and archive requests: an archived or disabled upstream
		// cannot have a newer published snapshot worth fetching.
		return a.settleAgentRepositoryUpstream(ctx, result, before, status, options)
	}
	// Seed imports pin a commit. Refreshes follow the current default branch
	// instead of resolving that permanently pinned initial ref.
	source, err := a.resolveGitHubRepositoryCommit(ctx, metadata, "", token)
	if err != nil {
		return result, agentGitHubFallbackError(rejected, err)
	}
	result.CurrentSHA = source.CommitSHA
	if source.RepositoryID != before.source.RepositoryID {
		if before.ownerID != nil {
			return skip("repository_identity_mismatch")
		}
		return result, errAgentRepositorySyncIdentity
	}
	if before.ownerID == nil {
		if source.License == "UNLICENSED" || source.License != before.source.License {
			return result, errAgentRepositorySyncLicense
		}
	} else if source.License != before.source.License {
		// A published personal copy keeps the license its owner chose; following an
		// upstream relicensing would silently republish the bytes under new terms.
		return skip("license_changed")
	}
	if before.license != nil && *before.license != source.License {
		if before.ownerID == nil {
			return result, errAgentRepositorySyncPublicationLicense
		}
		return skip("publication_license_mismatch")
	}
	locationChanged := source.RepositoryURL != before.source.RepositoryURL || source.Author != before.source.Author ||
		source.AuthorURL != before.source.AuthorURL || source.Private != before.source.Private
	markCleared := before.source.UpstreamStatus != ""
	if source.CommitSHA == before.source.CommitSHA {
		if !locationChanged && !markCleared {
			result.Status = "unchanged"
			return result, nil
		}
		result.Repository, result.Code = source.RepositoryURL, "source_updated"
		if !options.Apply {
			result.Status = "would_update"
			return result, nil
		}
		// A rename/transfer can happen without a new commit. Refresh canonical
		// location and attribution without touching files or revisions, and drop a
		// stale terminal mark now that the upstream responded normally.
		if err = a.updateAgentRepositorySource(ctx, before, source); err != nil {
			return result, err
		}
		result.Status = "updated"
		return result, nil
	}
	archiveToken := token
	if before.ownerID == nil || before.publishedRevision != nil {
		// Visibility can change after metadata or commit resolution. Only bytes
		// readable anonymously at this exact SHA may enter a public snapshot.
		archiveToken = ""
	}
	files, err := a.downloadGitHubRepository(ctx, metadata.Owner.Login, metadata.Name, source.CommitSHA, archiveToken)
	if err != nil {
		return result, agentGitHubFallbackError(rejected, err)
	}
	// Apply the same path/metadata publication boundary even for withdrawn rows;
	// bytes have already passed readGitHubArchive's content and size checks.
	if agentWorkspaceSensitiveContent([]byte(before.name + "\n" + before.description)) {
		return result, &agentWorkspaceSensitiveError{Path: "repository metadata"}
	}
	for _, file := range files {
		if agentRepositorySensitivePath(file.Path) || agentWorkspaceSensitiveContent([]byte(file.Path)) {
			return result, &agentWorkspaceSensitiveError{Path: file.Path}
		}
	}
	// Only the curated catalog constrains upstream licenses to reproducible
	// permissive ones. A personal import keeps the license its owner published.
	if before.ownerID == nil && (discoveryManualLicenseReview(metadata.FullName) || !systemRepositoryLicenseFilesAllowed(files, source.RepositoryID, source.License)) {
		return result, errAgentRepositorySyncLicenseReview
	}
	if before.ownerID == nil {
		var discovered bool
		if err = a.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agent_repository_discoveries WHERE workspace_id=$1 AND accepted_on IS NOT NULL)`, before.id).Scan(&discovered); err != nil {
			return result, err
		}
		if discovered && validateDiscoveredKoiSkills(files, source.License) != "" {
			// Retain the last usable publication, including for viewer-triggered
			// refreshes. Legacy Agent-only system repositories keep their policy.
			return skip("koi_skills_unavailable")
		}
	}
	if !options.Apply {
		result.Status = "would_update"
		return result, nil
	}
	if err = a.applyAgentRepositorySync(ctx, before, source, files); err != nil {
		return result, err
	}
	result.Status = "updated"
	return result, nil
}

// settleAgentRepositoryUpstream persists a terminal upstream mark on the live
// workspace and its current publication without touching content, revisions or
// publication timestamps.
func (a *App) settleAgentRepositoryUpstream(ctx context.Context, result agentRepositoryRefreshResult, before agentRepositorySyncSnapshot, status string, options agentRepositoryRefreshOptions) (agentRepositoryRefreshResult, error) {
	result.Status, result.Code = "skipped", status
	if !options.Apply || before.source.UpstreamStatus == status {
		return result, nil
	}
	return result, a.setAgentRepositoryUpstreamStatus(ctx, before, status)
}

func (a *App) setAgentRepositoryUpstreamStatus(ctx context.Context, before agentRepositorySyncSnapshot, status string) error {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err = lockAgentRepositorySyncSnapshot(ctx, tx, before); err != nil {
		return err
	}
	patch := map[string]string{"upstreamStatus": status}
	// Deliberately no updated_at bump: a status mark is not content and must not
	// reorder the owner's repository list or the public directory.
	if _, err = tx.Exec(ctx, `UPDATE agent_workspaces SET github_source=github_source || $2::jsonb WHERE id=$1`, before.id, patch); err != nil {
		return err
	}
	if before.publishedRevision != nil {
		if _, err = tx.Exec(ctx, `UPDATE agent_repository_publications SET github_source=github_source || $2::jsonb WHERE workspace_id=$1`, before.id, patch); err != nil {
			return err
		}
	}
	if err = recordAgentRepositorySyncEvent(ctx, tx, before, before.revision); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// Both content and source-only updates must preserve concurrent edits,
// withdrawals and republications, even when the revision is unchanged.
func lockAgentRepositorySyncSnapshot(ctx context.Context, tx pgx.Tx, before agentRepositorySyncSnapshot) error {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, agentRepositoryOwnerLock(before.ownerID)); err != nil {
		return err
	}
	if before.ownerID != nil {
		var enabled bool
		err := tx.QueryRow(ctx, `SELECT enabled FROM agent_workspace_settings WHERE user_id=$1 FOR SHARE`, *before.ownerID).Scan(&enabled)
		if errors.Is(err, pgx.ErrNoRows) || err == nil && !enabled {
			return errAgentWorkspaceDisabled
		}
		if err != nil {
			return err
		}
	}
	current, err := scanAgentRepositorySyncSnapshot(tx.QueryRow(ctx, `SELECT `+agentRepositorySyncSnapshotColumns+`
 FROM agent_workspaces w LEFT JOIN agent_repository_publications p ON p.workspace_id=w.id
 WHERE w.id=$1 AND w.deleted_at IS NULL FOR UPDATE OF w`, before.id))
	if errors.Is(err, pgx.ErrNoRows) {
		return errAgentWorkspaceNotFound
	}
	if err != nil {
		return err
	}
	// The lock is only meaningful for the owner the caller decided under.
	if (current.ownerID == nil) != (before.ownerID == nil) || (before.ownerID != nil && *current.ownerID != *before.ownerID) {
		return errAgentWorkspaceConflict
	}
	if !reflect.DeepEqual(current, before) {
		return errAgentWorkspaceConflict
	}
	return nil
}

// updateAgentRepositorySource refreshes canonical location and attribution, and
// clears a stale terminal mark. Personal Forks retain their own provenance.
func (a *App) updateAgentRepositorySource(ctx context.Context, before agentRepositorySyncSnapshot, source *agentGitHubSource) error {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if err = lockAgentRepositorySyncSnapshot(ctx, tx, before); err != nil {
		return err
	}
	location := map[string]any{"repositoryUrl": source.RepositoryURL, "author": source.Author, "authorUrl": source.AuthorURL, "private": source.Private}
	if _, err = tx.Exec(ctx, `UPDATE agent_workspaces SET github_source=(github_source || $2::jsonb) - 'upstreamStatus',updated_at=now() WHERE id=$1`, before.id, location); err != nil {
		return err
	}
	if before.publishedRevision != nil {
		if _, err = tx.Exec(ctx, `UPDATE agent_repository_publications SET github_source=((github_source || $2::jsonb) - 'upstreamStatus') - 'private' WHERE workspace_id=$1`, before.id, location); err != nil {
			return err
		}
	}
	if err = recordAgentRepositorySyncEvent(ctx, tx, before, before.revision); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func recordAgentRepositorySyncEvent(ctx context.Context, tx pgx.Tx, before agentRepositorySyncSnapshot, revision int64) error {
	if before.ownerID == nil {
		_, err := tx.Exec(ctx, `INSERT INTO agent_repository_system_events(workspace_id,actor_user_id,action,revision) VALUES($1,NULL,'sync',$2)`, before.id, revision)
		return err
	}
	_, err := tx.Exec(ctx, `INSERT INTO agent_workspace_events(user_id,workspace_id,action,revision) VALUES($1,$2,'sync',$3)`, *before.ownerID, before.id, revision)
	return err
}

func (a *App) applyAgentRepositorySync(ctx context.Context, before agentRepositorySyncSnapshot, source *agentGitHubSource, files []agentWorkspaceFile) error {
	installable := before.publishedRevision != nil && validateDiscoveredKoiSkills(files, source.License) == ""
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
	uploaded, err := a.stageAgentRepositoryFilesForOwner(ctx, before.ownerID, missing)
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
	defer func() { _ = tx.Rollback(ctx) }()
	if err = lockAgentRepositorySyncSnapshot(ctx, tx, before); err != nil {
		return err
	}
	var previousBytes int64
	if before.ownerID != nil {
		if err = tx.QueryRow(ctx, `SELECT agent_workspace_storage_bytes($1)`, *before.ownerID).Scan(&previousBytes); err != nil {
			return err
		}
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
	comment := fmt.Sprintf("GitHub sync: %s -> %s", before.source.CommitSHA, source.CommitSHA)
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
		if err = replaceAgentRepositoryPublicationFiles(ctx, tx, before.id, &installable); err != nil {
			return err
		}
	}
	if _, err = tx.Exec(ctx, `SELECT prune_agent_workspace_history($1,100000000)`, before.id); err != nil {
		return err
	}
	if err = recordAgentRepositorySyncEvent(ctx, tx, before, revision); err != nil {
		return err
	}
	if before.ownerID != nil {
		if err = checkAgentWorkspaceQuota(ctx, tx, *before.ownerID, previousBytes); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

// The coalescing entrypoint loads this snapshot only after becoming the leader;
// a caller that arrives just after a completed refresh must not use stale state.
func (a *App) refreshPublicAgentRepositoryOnce(ctx context.Context, id int64, token string, recheck, credentialUnavailable bool) (SystemRepositorySyncResult, error) {
	result := SystemRepositorySyncResult{WorkspaceID: id}
	before, err := a.loadAgentRepositorySyncSnapshot(ctx, a.db, id)
	if err != nil {
		return result, err
	}
	if before.publishedRevision == nil {
		return result, errAgentWorkspaceNotFound
	}
	refresh, err := a.refreshAgentRepository(ctx, before, agentRepositoryRefreshOptions{
		Apply: true, GitHubToken: token, SkipMarked: !recheck, Interactive: true, CredentialUnavailable: credentialUnavailable,
	})
	result.Repository, result.Status, result.Code = refresh.Repository, refresh.Status, refresh.Code
	result.PreviousSHA, result.CurrentSHA = refresh.PreviousSHA, refresh.CurrentSHA
	if err != nil {
		result.Status, result.Code = "failed", agentRepositoryRefreshErrorCode(err)
	}
	return result, err
}

// agentRepositoryRefreshErrorCode classifies a refresh failure for clients without
// exposing the raw error, which can contain connection details.
func agentRepositoryRefreshErrorCode(err error) string { return systemRepositorySyncErrorCode(err) }
