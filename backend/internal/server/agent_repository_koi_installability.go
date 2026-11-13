package server

import (
	"context"
	"errors"
	"log"
	"time"
)

// Inspect saved publications in bounded batches, outside directory requests and
// write transactions. Retry temporary storage failures without calling them
// incompatible or letting one failing entry block the rest of the directory.
func (a *App) backfillAgentRepositoryKoiInstallability(ctx context.Context, limit int) (int, error) {
	rows, err := a.db.Query(ctx, `SELECT p.workspace_id,p.revision,p.published_at FROM agent_repository_publications p
 JOIN agent_workspaces w ON w.id=p.workspace_id WHERE w.deleted_at IS NULL AND p.koi_installable IS NULL
 AND COALESCE(p.github_source->>'linkOnly','false')<>'true'
 AND (p.koi_installability_checked_at IS NULL OR p.koi_installability_checked_at<now()-interval '5 minutes')
 ORDER BY p.workspace_id LIMIT $1`, limit)
	if err != nil {
		return 0, err
	}
	type publication struct {
		id, revision int64
		publishedAt  time.Time
	}
	var batch []publication
	for rows.Next() {
		var item publication
		if err = rows.Scan(&item.id, &item.revision, &item.publishedAt); err != nil {
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
	checked := 0
	var firstErr error
	for _, item := range batch {
		claim, err := a.db.Exec(ctx, `UPDATE agent_repository_publications SET koi_installability_checked_at=now()
 WHERE workspace_id=$1 AND revision=$2 AND published_at=$3 AND koi_installable IS NULL
 AND (koi_installability_checked_at IS NULL OR koi_installability_checked_at<now()-interval '5 minutes')`, item.id, item.revision, item.publishedAt)
		if err != nil {
			return checked, err
		}
		if claim.RowsAffected() == 0 {
			continue
		}
		checked++
		work, cancel := context.WithTimeout(ctx, 30*time.Second)
		source, readErr := a.readKoiHubSource(work, koiHubSourceInput{WorkspaceID: item.id, Revision: &item.revision, PublicationID: item.publishedAt.UTC().Format(time.RFC3339Nano)})
		cancel()
		installable := false
		var sensitive *agentWorkspaceSensitiveError
		switch {
		case readErr == nil:
			candidates, _ := koiSkillCandidates(source.Files, koiSkillSourceContext{RootName: source.Publication.Name, License: source.Publication.License})
			installable = len(candidates) > 0
		case errors.Is(readErr, errKoiSkillTooLarge), errors.As(readErr, &sensitive):
			// These are installation-policy failures, not transient reads.
		case errors.Is(readErr, errAgentWorkspaceConflict), errors.Is(readErr, errAgentWorkspaceNotFound):
			continue
		default:
			if firstErr == nil {
				firstErr = readErr
			}
			continue
		}
		// A delayed check must not mark a newly published version with old results.
		if _, err = a.db.Exec(ctx, `UPDATE agent_repository_publications SET koi_installable=$4,koi_installability_xid=pg_current_xact_id()
 WHERE workspace_id=$1 AND revision=$2 AND published_at=$3 AND koi_installable IS NULL`, item.id, item.revision, item.publishedAt, installable); err != nil {
			return checked, err
		}
	}
	return checked, firstErr
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
