package server

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/jackc/pgx/v5"
)

// Shared commit for uploads and both remote sources. The caller holds the user
// lock and the preview lock, so quota, revision and receipt commit atomically.
func (a *App) commitKoiCandidate(ctx context.Context, tx pgx.Tx, userID int, view koiSkillImportView, candidate koiSkillCandidate, reviewed koiSkillImportCandidate, enabled bool, staged map[string]string) (koiSkillInstallation, error) {
	source := koiCandidateSource(view.Source, candidate)
	key := koiRemoteSourceKey(view.SourceKind, source)
	target, revision := koiSourceText(view.Source, "updateFromId"), koiSourceID(view.Source, "updateRevision")
	if target == "" && reviewed.InstalledStatus == "update" {
		target, revision = reviewed.InstalledID, reviewed.InstalledRevision
	}
	var id string
	var err error
	if target != "" {
		id = target
	} else if view.SourceKind == "folder" {
		id, err = koiFolderInstallationID(ctx, tx, userID, candidate.ContentSHA256)
	} else {
		err = tx.QueryRow(ctx, `SELECT id::text FROM koi_skill_installations WHERE user_id=$1 AND source_key=$2 AND deleted_at IS NULL`, userID, key).Scan(&id)
	}
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return koiSkillInstallation{}, err
	}
	if id != "" {
		current, loadErr := a.loadKoiInstallation(ctx, tx, userID, id)
		if loadErr != nil {
			return current, loadErr
		}
		if target != "" {
			manualMigration := view.SourceKind == "folder" && current.SourceKind == "migration"
			if revision < 1 || revision != current.Revision || current.SourceKind != view.SourceKind && !manualMigration {
				return current, errKoiSkillConflict
			}
			if view.SourceKind != "folder" && koiRemoteSourceKey(view.SourceKind, current.Source) != key {
				return current, errKoiSkillConflict
			}
			if manualMigration {
				source = current.Source
			}
		}
		if current.ContentSHA256 == candidate.ContentSHA256 {
			return current, nil
		}
		if target == "" {
			return current, errKoiSkillConflict
		}
		enabled = current.Enabled
	} else {
		id, err = randomUUID()
		if err != nil {
			return koiSkillInstallation{}, err
		}
		if view.SourceKind == "folder" {
			key = "folder:" + id
		}
		encoded, _ := json.Marshal(source)
		_, err = tx.Exec(ctx, `INSERT INTO koi_skill_installations(id,user_id,source_key,source_kind,source,name,description,enabled) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, id, userID, key, view.SourceKind, encoded, candidate.Name, candidate.Description, enabled)
		if err != nil {
			return koiSkillInstallation{}, err
		}
	}
	versionID, err := a.koiWriteSkillVersion(ctx, tx, userID, id, candidate, staged, source)
	if err != nil {
		return koiSkillInstallation{}, err
	}
	encoded, _ := json.Marshal(source)
	_, err = tx.Exec(ctx, `UPDATE koi_skill_installations SET current_version_id=$2,source=$3,name=$4,description=$5,enabled=$6,revision=revision+CASE WHEN $7 THEN 1 ELSE 0 END,updated_at=now() WHERE id=$1`, id, versionID, encoded, candidate.Name, candidate.Description, enabled, target != "")
	if err != nil {
		return koiSkillInstallation{}, err
	}
	return a.loadKoiInstallation(ctx, tx, userID, id)
}

// Lock the live publication through commit. Withdrawal, republication and
// deletion all change these same rows, so they cannot race the final copy.
func (a *App) lockKoiHubSource(ctx context.Context, tx pgx.Tx, source map[string]any) error {
	var revision int64
	var matches bool
	err := tx.QueryRow(ctx, `SELECT p.revision,p.published_at=$2::timestamptz FROM agent_repository_publications p JOIN agent_workspaces w ON w.id=p.workspace_id WHERE p.workspace_id=$1 AND w.deleted_at IS NULL FOR SHARE OF p,w`, koiSourceID(source, "workspaceId"), koiSourceText(source, "publicationId")).Scan(&revision, &matches)
	if errors.Is(err, pgx.ErrNoRows) {
		return errAgentWorkspaceNotFound
	}
	if err != nil {
		return err
	}
	if !matches || revision != koiSourceID(source, "revision") {
		return errKoiSkillConflict
	}
	return nil
}
