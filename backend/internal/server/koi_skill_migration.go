package server

import (
	"context"
	"errors"
	"net/http"
	"strconv"

	"github.com/jackc/pgx/v5"
	"koinote/backend/internal/httpx"
)

var errKoiMigrationRequired = errors.New("review the existing repository Skills before switching libraries")

// Read only packages owned by this user. Package boundaries, sensitive-data
// checks and unsupported declarations use the same parser as every installation.
func (a *App) koiAnalyzeLegacyRepositories(ctx context.Context, userID int) (koiAnalysis, error) {
	rows, err := a.db.Query(ctx, `SELECT DISTINCT w.id FROM agent_workspaces w JOIN agent_workspace_files f ON f.workspace_id=w.id
 WHERE w.user_id=$1 AND w.deleted_at IS NULL AND (f.path='SKILL.md' OR f.path LIKE '%/SKILL.md') ORDER BY w.id`, userID)
	if err != nil {
		return koiAnalysis{}, err
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return koiAnalysis{}, err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return koiAnalysis{}, err
	}
	entries := map[string]any{}
	analysis := koiAnalysis{source: map[string]any{"kind": "migration", "entries": entries}}
	for _, id := range ids {
		view, err := a.loadAgentWorkspace(ctx, userID, id)
		if err != nil {
			return koiAnalysis{}, err
		}
		byPath := map[string]koiSkillFile{}
		for _, file := range view.Files {
			byPath[file.Path] = koiSkillFile{Path: file.Path, MimeType: file.MimeType, SHA256: file.SHA256, SizeBytes: file.SizeBytes}
		}
		needed := koiSkillNeededPaths(byPath, "", false)
		files := []koiSkillFile{}
		for _, file := range view.Files {
			if !needed[file.Path] {
				continue
			}
			member := byPath[file.Path]
			if file.SizeBytes <= koiSkillFileBytes {
				var objectKey *string
				err = a.db.QueryRow(ctx, `SELECT COALESCE(f.content,b.content),b.r2_object_key FROM agent_workspace_files f
 LEFT JOIN agent_workspace_blobs b ON b.workspace_id=f.workspace_id AND b.sha256=f.sha256
 WHERE f.id=$1 AND f.workspace_id=$2`, file.FileID, id).Scan(&member.Content, &objectKey)
				if err != nil {
					return koiAnalysis{}, err
				}
				member.Content, err = a.readAgentRepositoryContent(ctx, member.Content, objectKey, file.SHA256, file.SizeBytes, 0, koiSkillFileBytes)
				if err != nil {
					return koiAnalysis{}, err
				}
			}
			files = append(files, member)
		}
		candidates, rejected := koiSkillCandidates(files, koiSkillSourceContext{RootName: view.Name})
		for _, candidate := range candidates {
			candidate.ID = "sk-" + koiDigest([]byte(strconv.FormatInt(id, 10) + ":" + candidate.Directory))[:16]
			entries[candidate.ID] = map[string]any{"kind": "migration", "workspaceId": id, "path": candidate.Directory, "directoryName": view.Name, "revision": view.Revision}
			analysis.candidates = append(analysis.candidates, candidate)
		}
		for _, item := range rejected {
			item.EntryPath = view.Name + "/" + item.EntryPath
			analysis.rejected = append(analysis.rejected, item)
		}
		if len(analysis.candidates)+len(analysis.rejected) > koiSkillImportFiles {
			return koiAnalysis{}, errKoiSkillTooLarge
		}
	}
	return analysis, nil
}

func koiMigrationCandidateSource(source map[string]any, candidateID string) map[string]any {
	entries, _ := source["entries"].(map[string]any)
	entry, _ := entries[candidateID].(map[string]any)
	return entry
}

// Recheck the selected private snapshots under the commit transaction. A
// concurrent repository edit cannot turn reviewed bytes into an unreviewed copy.
func (a *App) lockKoiMigrationSources(ctx context.Context, tx pgx.Tx, userID int, source map[string]any, selected []koiSkillCandidate) error {
	for _, candidate := range selected {
		entry := koiMigrationCandidateSource(source, candidate.ID)
		var revision int64
		err := tx.QueryRow(ctx, `SELECT revision FROM agent_workspaces WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL FOR SHARE`, koiSourceID(entry, "workspaceId"), userID).Scan(&revision)
		if errors.Is(err, pgx.ErrNoRows) || err == nil && revision != koiSourceID(entry, "revision") {
			return errKoiSkillConflict
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// Choosing an empty library is explicit and idempotent. No package is installed,
// no repository is modified and no Credits are charged.
func (a *App) koiMigrationSkip(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireKoiSkillUser(w, r, true)
	if !ok {
		return
	}
	var input struct {
		ExpectedRevision int64 `json:"expectedRevision"`
	}
	if decodeJSONBody(r, &input) != nil || input.ExpectedRevision < 1 {
		httpx.ErrorCode(w, 400, "bad_request", "expectedRevision is required")
		return
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		writeKoiError(w, err)
		return
	}
	defer tx.Rollback(context.WithoutCancel(r.Context()))
	_, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock($1)`, user.ID)
	var settings koiSkillSettings
	if err == nil {
		settings, err = a.resolveKoiLibraryMode(r.Context(), tx, user.ID)
	}
	if err == nil && settings.LibraryMode == "legacy" {
		if settings.Revision != input.ExpectedRevision {
			err = errKoiSkillConflict
		} else {
			_, err = tx.Exec(r.Context(), `UPDATE agent_session_settings SET library_mode='installed',revision=revision+1 WHERE user_id=$1`, user.ID)
		}
	}
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		writeKoiError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"libraryMode": "installed"})
}
