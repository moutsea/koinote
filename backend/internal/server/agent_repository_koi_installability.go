package server

import (
	"context"
	"errors"
	"fmt"
	"log"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
)

// The application can reapply review edits to saved evidence without GitHub I/O.
// Downloading new or changed links remains token-authenticated maintenance work.
func (a *App) backfillAgentRepositoryKoiInstallability(ctx context.Context, limit int) (int, error) {
	return a.checkAgentRepositoryKoiInstallability(ctx, limit, "")
}

// ErrKoiInstallabilityDeferred reports retryable upstream failures only. Saved
// results remain intact; credentials, storage and database failures stay fatal.
var ErrKoiInstallabilityDeferred = errors.New("some compatibility checks were deferred for retry")

// The existing maintenance jobs supply their short-lived GitHub token for API
// requests. Archives remain anonymous and are only inspected, never mirrored.
func (a *App) RefreshAgentRepositoryKoiInstallability(ctx context.Context, token string) (int, error) {
	if strings.TrimSpace(token) == "" || strings.ContainsAny(token, "\r\n\t ") {
		return 0, errors.New("a GitHub token is required for compatibility maintenance")
	}
	total := 0
	var firstErr error
	for total < 512 {
		checked, err := a.checkAgentRepositoryKoiInstallability(ctx, 8, token)
		total += checked
		if err != nil && !errors.Is(err, ErrKoiInstallabilityDeferred) {
			return total, err
		}
		if ctx.Err() != nil {
			return total, ctx.Err()
		}
		if err != nil && firstErr == nil {
			firstErr = err
		}
		if checked < 8 || errors.Is(err, errAgentGitHubRateLimited) {
			break
		}
	}
	return total, firstErr
}

// Attempts throttle retries independently of the last definitive result.
// A failed recheck must neither erase that result nor delay retry for a day.
var agentRepositoryKoiCheckDue = `(NOT ` + agentRepositoryKoiCacheCurrentSQL("") + `
 OR (github_source->>'linkOnly'='true' AND
 (koi_installability_checked_at IS NULL OR koi_installability_checked_at<now()-interval '24 hours')))
 AND (koi_installability_attempted_at IS NULL OR koi_installability_attempted_at<now()-interval '5 minutes'
 OR (koi_installability_curation_revision<>(SELECT revision FROM agent_repository_curation_state WHERE singleton)
 AND koi_installability_checked_at>=koi_installability_attempted_at))`

// Use the same cache validity for maintenance, directory badges, filters and
// pending counts. A definitive result from an older scanner still needs review.
func agentRepositoryKoiCacheCurrentSQL(alias string) string {
	if alias != "" {
		alias += "."
	}
	return `(` + alias + `koi_installable IS NOT NULL
 AND COALESCE(` + alias + `koi_installability_evidence->>'rulesVersion'='` + strconv.Itoa(koiSkillEntryRulesVersion) + `',false)
 AND ` + alias + `koi_installability_curation_revision=(SELECT revision FROM agent_repository_curation_state WHERE singleton))`
}

type koiInstallabilityEvidence struct {
	RulesVersion int               `json:"rulesVersion"`
	Digests      []string          `json:"digests"`
	EntryDigests map[string]string `json:"entryDigests,omitempty"`
}

func newKoiInstallabilityEvidence(files []koiSkillFile, root, license string) *koiInstallabilityEvidence {
	candidates, _ := koiSkillCandidates(files, koiSkillSourceContext{RootName: root, License: license})
	evidence := &koiInstallabilityEvidence{RulesVersion: koiSkillEntryRulesVersion, Digests: []string{}, EntryDigests: map[string]string{}}
	for _, candidate := range candidates {
		evidence.Digests = append(evidence.Digests, candidate.ContentSHA256)
		evidence.EntryDigests[candidate.ContentSHA256] = koiSkillEntryDigest(candidate.Instructions)
	}
	return evidence
}

func (review koiRepositoryCuration) evidenceInstallable(repositoryID int64, evidence *koiInstallabilityEvidence) bool {
	for _, digest := range evidence.Digests {
		if review.compatibility(strconv.FormatInt(repositoryID, 10), digest, koiSkillCompatibility{Conversation: true}, evidence.EntryDigests[digest]).Conversation {
			return true
		}
	}
	return false
}

func (a *App) checkAgentRepositoryKoiInstallability(ctx context.Context, limit int, token string) (int, error) {
	rows, err := a.db.Query(ctx, `SELECT p.workspace_id,p.revision,p.published_at,p.github_source,p.koi_installability_curation_revision,p.koi_installability_evidence FROM agent_repository_publications p
 WHERE EXISTS(SELECT 1 FROM agent_workspaces w WHERE w.id=p.workspace_id AND w.deleted_at IS NULL) AND `+agentRepositoryKoiCheckDue+`
 AND ($2::boolean OR COALESCE(p.github_source->>'linkOnly','false')<>'true'
 OR (p.koi_installability_curation_revision<>(SELECT revision FROM agent_repository_curation_state WHERE singleton)
 AND p.koi_installability_evidence->>'rulesVersion'=$3))
 ORDER BY p.koi_installability_attempted_at NULLS FIRST,p.workspace_id LIMIT $1`, limit, token != "", strconv.Itoa(koiSkillEntryRulesVersion))
	if err != nil {
		return 0, err
	}
	type publication struct {
		id, revision   int64
		publishedAt    time.Time
		source         *agentGitHubSource
		reviewRevision int64
		evidence       *koiInstallabilityEvidence
	}
	var batch []publication
	for rows.Next() {
		var item publication
		if err = rows.Scan(&item.id, &item.revision, &item.publishedAt, &item.source, &item.reviewRevision, &item.evidence); err != nil {
			rows.Close()
			return 0, err
		}
		batch = append(batch, item)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return 0, err
	}
	review, err := loadKoiRepositoryCuration(ctx, a.db)
	if err != nil {
		return 0, err
	}
	checked := 0
	var firstErr error
	for _, item := range batch {
		var claim time.Time
		err := a.db.QueryRow(ctx, `UPDATE agent_repository_publications SET koi_installability_attempted_at=clock_timestamp()
 WHERE workspace_id=$1 AND revision=$2 AND published_at=$3 AND github_source IS NOT DISTINCT FROM $4::jsonb
 AND `+agentRepositoryKoiCheckDue+` RETURNING koi_installability_attempted_at`, item.id, item.revision, item.publishedAt, item.source).Scan(&claim)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return checked, err
		}
		checked++
		work, cancel := context.WithTimeout(ctx, 30*time.Second)
		var files []koiSkillFile
		var root, license string
		var repositoryID int64
		var readErr error
		local := item.evidence != nil && item.evidence.RulesVersion == koiSkillEntryRulesVersion && item.reviewRevision != review.revision
		if local {
			if item.source != nil {
				repositoryID = item.source.RepositoryID
			}
		} else if item.source != nil && item.source.LinkOnly {
			var source koiGitHubSource
			source, readErr = a.readKoiGitHubSource(work, koiGitHubSourceInput{RepositoryURL: item.source.RepositoryURL, Ref: item.source.Ref, PublicOnly: true}, token)
			if readErr == nil {
				if item.source.RepositoryID <= 0 || source.Source.RepositoryID != item.source.RepositoryID {
					readErr = errAgentGitHubRepositoryInvalid
				} else {
					files, root, license = source.Files, source.Target.Repo, source.Source.License
					repositoryID = source.Source.RepositoryID
				}
			}
		} else {
			var source koiHubSource
			source, readErr = a.readKoiHubSource(work, koiHubSourceInput{WorkspaceID: item.id, Revision: &item.revision, PublicationID: item.publishedAt.UTC().Format(time.RFC3339Nano)})
			if readErr == nil {
				files, root, license = source.Files, source.Publication.Name, source.Publication.License
				if source.Publication.GitHubSource != nil {
					repositoryID = source.Publication.GitHubSource.RepositoryID
				}
			}
		}
		cancel()
		installable := false
		var sensitive *agentWorkspaceSensitiveError
		switch {
		case readErr == nil:
			if !local {
				item.evidence = newKoiInstallabilityEvidence(files, root, license)
			}
			installable = review.evidenceInstallable(repositoryID, item.evidence)
		case errors.Is(readErr, errKoiSkillTooLarge), errors.Is(readErr, errAgentGitHubArchiveInvalid), errors.As(readErr, &sensitive):
			// These are installation-policy failures, not transient reads.
		case errors.Is(readErr, errAgentGitHubRepositoryInvalid), errors.Is(readErr, errAgentGitHubRepositoryMissing):
			// Recheck unavailable, private or replaced links the following day.
		case errors.Is(readErr, errAgentWorkspaceConflict), errors.Is(readErr, errAgentWorkspaceNotFound):
			continue
		default:
			if ctx.Err() != nil {
				return checked, ctx.Err()
			}
			// Only known upstream read failures are safe to defer. In particular,
			// a prior transient error must not mask a later database/storage fault.
			if item.source == nil || !item.source.LinkOnly ||
				!(errors.Is(readErr, errAgentGitHubTransient) || errors.Is(readErr, errAgentGitHubRateLimited) || errors.Is(readErr, errAgentGitHubDownloadFailed)) {
				return checked, readErr
			}
			deferred := fmt.Errorf("%w: %w", ErrKoiInstallabilityDeferred, readErr)
			if firstErr == nil {
				firstErr = deferred
			}
			if errors.Is(readErr, errAgentGitHubRateLimited) {
				return checked, deferred
			}
			continue
		}
		if readErr != nil {
			item.evidence = &koiInstallabilityEvidence{RulesVersion: koiSkillEntryRulesVersion, Digests: []string{}}
		}
		// A delayed check must not mark a newly published version with old results.
		if _, err = a.db.Exec(ctx, `UPDATE agent_repository_publications SET koi_installable=$4,
 koi_installability_checked_at=CASE WHEN $9 THEN koi_installability_checked_at ELSE clock_timestamp() END,
 koi_installability_attempted_at=NULL,koi_installability_evidence=$8,
 koi_installability_curation_revision=$7,
 koi_installability_xid=CASE WHEN koi_installable IS NOT DISTINCT FROM $4::boolean AND `+agentRepositoryKoiCacheCurrentSQL("")+`
 THEN koi_installability_xid ELSE pg_current_xact_id() END
 WHERE workspace_id=$1 AND revision=$2 AND published_at=$3 AND koi_installability_attempted_at=$5
 AND github_source IS NOT DISTINCT FROM $6::jsonb
 AND $7=(SELECT revision FROM agent_repository_curation_state WHERE singleton)`, item.id, item.revision, item.publishedAt, installable, claim, item.source, review.revision, item.evidence, local); err != nil {
			return checked, err
		}
	}
	return checked, firstErr
}

// A full, unpinned public preview has already run the same installation checks.
// Reuse it without another download. Private repositories, historical commits,
// individual packages and alternate refs cannot certify the public Hub target.
func (a *App) rememberKoiGitHubInstallability(ctx context.Context, source *agentGitHubSource, started time.Time, installable bool, reviewRevision int64, evidence *koiInstallabilityEvidence) {
	if source == nil || source.Private {
		return
	}
	_, err := a.db.Exec(ctx, `UPDATE agent_repository_publications p SET koi_installable=$4,
 koi_installability_checked_at=clock_timestamp(),koi_installability_attempted_at=NULL,
 koi_installability_curation_revision=$6,koi_installability_evidence=$7,
 koi_installability_xid=CASE WHEN koi_installable IS NOT DISTINCT FROM $4::boolean AND `+agentRepositoryKoiCacheCurrentSQL("p")+`
 THEN koi_installability_xid ELSE pg_current_xact_id() END
 FROM agent_workspaces w WHERE w.id=p.workspace_id AND w.deleted_at IS NULL
 AND p.github_source->>'linkOnly'='true' AND p.github_source->>'repositoryId'=$1
 AND lower(p.github_source->>'repositoryUrl')=lower($2) AND p.github_source->>'ref'=$3
 AND p.published_at<=$5 AND (p.koi_installability_checked_at IS NULL OR p.koi_installability_checked_at<$5)
 AND (p.koi_installability_attempted_at IS NULL OR p.koi_installability_attempted_at<$5)
 AND $6=(SELECT revision FROM agent_repository_curation_state WHERE singleton)`,
		fmt.Sprint(source.RepositoryID), source.RepositoryURL, source.Ref, installable, started, reviewRevision, evidence)
	if err != nil && ctx.Err() == nil {
		log.Printf("repository preview compatibility index: code=%s", SystemRepositoryErrorCode(err))
	}
}

func (a *App) StartAgentRepositoryKoiInstallability(ctx context.Context) {
	go func() {
		for ctx.Err() == nil {
			work, cancel := context.WithTimeout(ctx, 3*time.Minute)
			checked, err := a.backfillAgentRepositoryKoiInstallability(work, 8)
			cancel()
			if err != nil && ctx.Err() == nil {
				log.Printf("repository Koi installation checks: code=%s", SystemRepositoryErrorCode(err))
			}
			delay := time.Minute
			if checked == 8 {
				delay = time.Second
			}
			timer := time.NewTimer(delay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
		}
	}()
}
