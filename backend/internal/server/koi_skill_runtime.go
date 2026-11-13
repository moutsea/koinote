package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"

	"github.com/jackc/pgx/v5"
	"koinote/backend/internal/model"
)

// Discovery is driven by the installed library, resolved once when a task is
// accepted. Later installation, enable/disable, update or uninstall only affect
// subsequent tasks; a running task keeps its pinned versions.
type koiTaskSkill struct {
	InstallationID string
	VersionID      string
	Name           string
	Description    string
	EntryPath      string
	FileCount      int
	SizeBytes      int64
	Compatibility  koiSkillCompatibility
}

// Only new tasks on allowlisted accounts use the selected account library.
// The caller holds the account lock shared with confirmation, enable and delete.
type koiTaskSkillSnapshot struct {
	Revision           int64  `json:"revision"`
	LibraryMode        string `json:"libraryMode"`
	AutomaticDiscovery bool   `json:"automaticDiscovery"`
	Article            bool   `json:"article,omitempty"`
}

func (a *App) pinKoiTaskSkills(ctx context.Context, tx pgx.Tx, user model.User, taskID string, article bool) error {
	settings, err := a.resolveKoiLibraryMode(ctx, tx, user.ID)
	if err != nil {
		return err
	}
	snapshot := koiTaskSkillSnapshot{Revision: settings.Revision, LibraryMode: settings.LibraryMode, AutomaticDiscovery: settings.AutoSkills, Article: article}
	if article && settings.LibraryMode == "legacy" {
		snapshot.AutomaticDiscovery = false
	}
	if snapshot.AutomaticDiscovery && settings.LibraryMode == "installed" {
		if err = refreshKoiSkillEntryCompatibility(ctx, tx, user.ID); err != nil {
			return err
		}
		review, err := loadKoiRepositoryCuration(ctx, tx)
		if err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `SELECT DISTINCT ON (i.source_kind,(`+koiInstallationOriginSQL+`),v.content_sha256)
 v.id::text,v.content_sha256,v.compatibility,`+koiInstallationReviewRepositoryID+`,`+koiSkillEntryDigestSQL+`
 FROM koi_skill_installations i JOIN koi_skill_versions v ON v.id=i.current_version_id
 WHERE i.user_id=$1 AND i.deleted_at IS NULL AND i.enabled
 AND COALESCE((v.compatibility->>'conversation')::boolean,false)
 AND (NOT $2 OR COALESCE((v.compatibility->>'article')::boolean,false))
 AND `+koiInstallationReviewAllowsSQL("$3", "$2")+`
 ORDER BY i.source_kind,(`+koiInstallationOriginSQL+`),v.content_sha256,i.created_at,i.id`, user.ID, article, review.policiesJSON)
		if err != nil {
			return err
		}
		type pinnedSkill struct {
			ID            string                `json:"id"`
			Compatibility koiSkillCompatibility `json:"compatibility"`
		}
		var pinned []pinnedSkill
		for rows.Next() {
			var id, digest, repositoryID, entryDigest string
			var compatibility koiSkillCompatibility
			if err = rows.Scan(&id, &digest, &compatibility, &repositoryID, &entryDigest); err != nil {
				rows.Close()
				return err
			}
			pinned = append(pinned, pinnedSkill{id, review.compatibility(repositoryID, digest, compatibility, entryDigest)})
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		if len(pinned) > 0 {
			raw, _ := json.Marshal(pinned)
			if _, err = tx.Exec(ctx, `INSERT INTO agent_task_skill_versions(task_id,version_id,compatibility)
 SELECT $1,skill.id,skill.compatibility FROM jsonb_to_recordset($2::jsonb) AS skill(id uuid,compatibility jsonb)`, taskID, raw); err != nil {
				return err
			}
		}
	}
	raw, err := json.Marshal(snapshot)
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `UPDATE writing_agent_tasks SET skill_snapshot=$2 WHERE id=$1`, taskID, raw)
	return err
}

// Load the task's pinned skills for discovery. Only versions recorded on the
// task are visible; later library changes only affect subsequent tasks.
func (a *App) koiTaskSkills(ctx context.Context, task writingTask) ([]koiTaskSkill, error) {
	var snapshot koiTaskSkillSnapshot
	_ = json.Unmarshal(task.SkillSnapshot, &snapshot)
	rows, err := a.db.Query(ctx, `SELECT i.id::text,v.id::text,v.name,v.description,v.entry_path,v.file_count,v.size_bytes,COALESCE(refs.compatibility,v.compatibility)
 FROM agent_task_skill_versions refs
 JOIN koi_skill_versions v ON v.id=refs.version_id
 JOIN koi_skill_installations i ON i.id=v.installation_id
 WHERE refs.task_id=$1 AND i.user_id=$2
 ORDER BY v.name,v.id`, task.ID, task.UserID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	skills := []koiTaskSkill{}
	for rows.Next() {
		var skill koiTaskSkill
		var compatibility []byte
		if err = rows.Scan(&skill.InstallationID, &skill.VersionID, &skill.Name, &skill.Description,
			&skill.EntryPath, &skill.FileCount, &skill.SizeBytes, &compatibility); err != nil {
			return nil, err
		}
		_ = json.Unmarshal(compatibility, &skill.Compatibility)
		if !skill.Compatibility.Conversation || snapshot.Article && !skill.Compatibility.Article {
			continue
		}
		skills = append(skills, skill)
	}
	return skills, rows.Err()
}

// Package bytes for a pinned version, in the shape agent-gpt installs. The
// package identity is the installation id plus its immutable version id, so two
// sources with the same name never collide.
func (a *App) koiSkillPackageFor(ctx context.Context, skill koiTaskSkill) (json.RawMessage, error) {
	rows, err := a.db.Query(ctx, `SELECT path,mime_type,sha256,size_bytes,content,r2_object_key
 FROM koi_skill_version_files WHERE version_id=$1 ORDER BY position`, skill.VersionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var instructions string
	files := []map[string]string{}
	for rows.Next() {
		var file koiSkillFile
		var objectKey *string
		if err = rows.Scan(&file.Path, &file.MimeType, &file.SHA256, &file.SizeBytes, &file.Content, &objectKey); err != nil {
			return nil, err
		}
		file.Content, err = a.readAgentRepositoryContent(ctx, file.Content, objectKey, file.SHA256, file.SizeBytes, 0, koiSkillFileBytes)
		if err != nil {
			return nil, err
		}
		if file.Path == skill.EntryPath {
			instructions = string(file.Content)
			continue
		}
		if len(files) >= koiSkillMaxFiles-1 {
			return nil, errKoiSkillTooLarge
		}
		files = append(files, map[string]string{"path": file.Path, "contentBase64": base64.StdEncoding.EncodeToString(file.Content)})
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	if instructions == "" {
		return nil, errKoiSkillPackage
	}
	if strings.TrimSpace(instructions) == "" || len(instructions) > koiSkillEntryBytes {
		return nil, errKoiSkillTooLarge
	}
	raw, err := json.Marshal(map[string]any{"instructions": instructions, "files": files, "scope": "workspace"})
	if err != nil {
		return nil, err
	}
	return koiRuntimePackage(raw, skill)
}

// Record an actual load so the task view can name the Skills that ran, and
// reloads stay idempotent.
func (a *App) recordKoiSkillLoad(ctx context.Context, task writingTask, skill koiTaskSkill) error {
	_, err := a.db.Exec(ctx, `INSERT INTO koi_skill_loads(task_id,user_id,installation_id,version_id,skill_name)
 VALUES($1,$2,$3,$4,$5) ON CONFLICT(task_id,version_id) DO UPDATE SET loaded_at=now(),skill_name=EXCLUDED.skill_name`,
		task.ID, task.UserID, skill.InstallationID, skill.VersionID, skill.Name)
	return err
}

// Loaded skills for the task view. Reading the audit table never exposes
// package bytes, only which pinned version ran.
func (a *App) loadWritingLoadedSkills(ctx context.Context, taskID string) ([]writingLoadedSkill, error) {
	byTask, err := a.loadWritingLoadedSkillsForTasks(ctx, []string{taskID})
	return byTask[taskID], err
}

func (a *App) loadWritingLoadedSkillsForTasks(ctx context.Context, taskIDs []string) (map[string][]writingLoadedSkill, error) {
	rows, err := a.db.Query(ctx, `SELECT task_id::text,version_id::text,skill_name,loaded_at::text FROM koi_skill_loads
 WHERE task_id=ANY($1::uuid[]) ORDER BY loaded_at,version_id`, taskIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byTask := map[string][]writingLoadedSkill{}
	for rows.Next() {
		var taskID string
		var skill writingLoadedSkill
		if err = rows.Scan(&taskID, &skill.ID, &skill.Name, &skill.Loaded); err != nil {
			return nil, err
		}
		byTask[taskID] = append(byTask[taskID], skill)
	}
	return byTask, rows.Err()
}
