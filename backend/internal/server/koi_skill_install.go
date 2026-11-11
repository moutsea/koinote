package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"koinote/backend/internal/httpx"
)

type koiSkillInstallation struct {
	ID             string                `json:"id"`
	Name           string                `json:"name"`
	Description    string                `json:"description"`
	SourceKind     string                `json:"sourceKind"`
	Source         map[string]any        `json:"source"`
	VersionID      string                `json:"versionId"`
	Version        string                `json:"version"`
	ContentSHA256  string                `json:"contentSha256"`
	Enabled        bool                  `json:"enabled"`
	Revision       int64                 `json:"revision"`
	InstalledAt    time.Time             `json:"installedAt"`
	UpdatedAt      time.Time             `json:"updatedAt"`
	FileCount      int                   `json:"fileCount"`
	SizeBytes      int64                 `json:"sizeBytes"`
	Compatibility  koiSkillCompatibility `json:"compatibility"`
	MetadataFormat string                `json:"metadataFormat"`
	License        string                `json:"license"`
	EntryPath      string                `json:"entryPath"`
}

const koiInstallationColumns = `i.id::text,i.name,i.description,i.source_kind,i.source,i.enabled,i.revision,i.created_at,i.updated_at,
 v.id::text,v.content_sha256,v.entry_path,v.metadata_format,v.license,v.compatibility,v.file_count,v.size_bytes`

func scanKoiInstallation(row pgx.Row) (koiSkillInstallation, error) {
	var skill koiSkillInstallation
	var source, compatibility []byte
	var versionID, sha, entry, format, license string
	err := row.Scan(&skill.ID, &skill.Name, &skill.Description, &skill.SourceKind, &source, &skill.Enabled,
		&skill.Revision, &skill.InstalledAt, &skill.UpdatedAt, &versionID, &sha, &entry, &format, &license,
		&compatibility, &skill.FileCount, &skill.SizeBytes)
	if err != nil {
		return skill, err
	}
	skill.Source = map[string]any{}
	_ = json.Unmarshal(source, &skill.Source)
	skill.VersionID, skill.ContentSHA256, skill.EntryPath = versionID, sha, entry
	skill.MetadataFormat, skill.License = format, license
	// Use a short content hash as the installed version label.
	skill.Version = sha[:12]
	_ = json.Unmarshal(compatibility, &skill.Compatibility)
	return skill, nil
}

func koiFolderInstallationID(ctx context.Context, q agentWorkspaceQuerier, userID int, digest string) (string, error) {
	var id string
	err := q.QueryRow(ctx, `SELECT i.id::text FROM koi_skill_installations i
 JOIN koi_skill_versions v ON v.id=i.current_version_id
 WHERE i.user_id=$1 AND i.source_kind='folder' AND i.deleted_at IS NULL AND v.content_sha256=$2
 ORDER BY i.id LIMIT 1`, userID, digest).Scan(&id)
	return id, err
}

type koiSkillFileView struct {
	Position  int    `json:"position"`
	Path      string `json:"path"`
	MimeType  string `json:"mimeType"`
	SizeBytes int64  `json:"sizeBytes"`
	SHA256    string `json:"sha256"`
}

func (a *App) loadKoiInstallation(ctx context.Context, q imageUsageQuerier, userID int, id string) (koiSkillInstallation, error) {
	if !validUUID(id) {
		return koiSkillInstallation{}, errKoiSkillNotFound
	}
	return scanKoiInstallation(q.QueryRow(ctx, `SELECT `+koiInstallationColumns+` FROM koi_skill_installations i
 JOIN koi_skill_versions v ON v.id=i.current_version_id
 WHERE i.user_id=$1 AND i.id=$2 AND i.deleted_at IS NULL`, userID, id))
}

func (a *App) koiSkillsList(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireKoiSkillUser(w, r, false)
	if !ok {
		return
	}
	offset, limit, err := parseMCPPage(r.URL.Query().Get("cursor"), 20)
	if err != nil {
		httpx.ErrorCode(w, 400, "bad_request", "Invalid cursor")
		return
	}
	query, state := strings.TrimSpace(r.URL.Query().Get("q")), r.URL.Query().Get("state")
	if len(query) > 800 || (state != "" && state != "enabled" && state != "disabled" && state != "unavailable") {
		httpx.ErrorCode(w, 400, "bad_request", "Invalid Skill filter")
		return
	}
	rows, err := a.db.Query(r.Context(), `SELECT `+koiInstallationColumns+` FROM koi_skill_installations i
 JOIN koi_skill_versions v ON v.id=i.current_version_id
 WHERE i.user_id=$1 AND i.deleted_at IS NULL
 AND (strpos(lower(i.name),lower($4))>0 OR strpos(lower(i.description),lower($4))>0)
 AND ($5='' OR ($5='enabled' AND i.enabled) OR ($5='disabled' AND NOT i.enabled)
 OR ($5='unavailable' AND NOT COALESCE((v.compatibility->>'conversation')::boolean,false)))
 ORDER BY i.updated_at DESC,i.id LIMIT $2 OFFSET $3`, user.ID, limit+1, offset, query, state)
	if err != nil {
		writeKoiError(w, err)
		return
	}
	defer rows.Close()
	skills := []koiSkillInstallation{}
	for rows.Next() {
		skill, err := scanKoiInstallation(rows)
		if err != nil {
			writeKoiError(w, err)
			return
		}
		skills = append(skills, skill)
	}
	if err := rows.Err(); err != nil {
		writeKoiError(w, err)
		return
	}
	rows.Close()
	var usedBytes int64
	if err = a.db.QueryRow(r.Context(), `SELECT koi_skill_storage_bytes($1)`, user.ID).Scan(&usedBytes); err != nil {
		writeKoiError(w, err)
		return
	}
	cursor := ""
	if len(skills) > limit {
		skills = skills[:limit]
		cursor = encodeMCPCursor(offset + limit)
	}
	httpx.JSON(w, 200, map[string]any{"skills": skills, "nextCursor": cursor, "storage": map[string]any{"usedBytes": usedBytes}})
}

func (a *App) koiSkillPatch(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireKoiSkillUser(w, r, false)
	if !ok {
		return
	}
	var input struct {
		ExpectedRevision int64 `json:"expectedRevision"`
		Enabled          *bool `json:"enabled"`
	}
	if decodeJSONBody(r, &input) != nil || input.ExpectedRevision < 1 || input.Enabled == nil || !validUUID(r.PathValue("skillId")) {
		httpx.ErrorCode(w, 400, "bad_request", "expectedRevision and enabled are required")
		return
	}
	if *input.Enabled && user.MembershipTier != membershipTierLifetime {
		httpx.ErrorCode(w, http.StatusForbidden, "membership_required", "Lifetime membership required")
		return
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		writeKoiError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	if _, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock($1)`, user.ID); err != nil {
		writeKoiError(w, err)
		return
	}
	skill, err := a.loadKoiInstallation(r.Context(), tx, user.ID, r.PathValue("skillId"))
	if err != nil {
		writeKoiError(w, err)
		return
	}
	if skill.Revision != input.ExpectedRevision {
		writeKoiError(w, errKoiSkillConflict)
		return
	}
	if *input.Enabled && !skill.Compatibility.Conversation {
		httpx.ErrorCode(w, http.StatusUnprocessableEntity, "skill_incompatible", "Skill is incompatible with Koi AI")
		return
	}
	if _, err = tx.Exec(r.Context(), `UPDATE koi_skill_installations SET enabled=$3,revision=revision+1,updated_at=now()
 WHERE user_id=$1 AND id=$2`, user.ID, skill.ID, *input.Enabled); err != nil {
		writeKoiError(w, err)
		return
	}
	skill, err = a.loadKoiInstallation(r.Context(), tx, user.ID, skill.ID)
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		writeKoiError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"skill": skill})
}

func (a *App) koiSkillGet(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireKoiSkillUser(w, r, false)
	if !ok {
		return
	}
	skill, err := a.loadKoiInstallation(r.Context(), a.db, user.ID, r.PathValue("skillId"))
	if err != nil {
		writeKoiError(w, err)
		return
	}
	rows, err := a.db.Query(r.Context(), `SELECT position,path,mime_type,size_bytes,sha256 FROM koi_skill_version_files WHERE version_id=$1 ORDER BY position`, skill.VersionID)
	if err != nil {
		writeKoiError(w, err)
		return
	}
	defer rows.Close()
	files := []koiSkillFileView{}
	for rows.Next() {
		var file koiSkillFileView
		if err = rows.Scan(&file.Position, &file.Path, &file.MimeType, &file.SizeBytes, &file.SHA256); err != nil {
			writeKoiError(w, err)
			return
		}
		files = append(files, file)
	}
	if err = rows.Err(); err != nil {
		writeKoiError(w, err)
		return
	}
	rows.Close()
	var content []byte
	var objectKey *string
	var hash string
	var size int64
	if err = a.db.QueryRow(r.Context(), `SELECT content,r2_object_key,sha256,size_bytes FROM koi_skill_version_files
 WHERE version_id=$1 AND path=$2`, skill.VersionID, skill.EntryPath).Scan(&content, &objectKey, &hash, &size); err != nil {
		writeKoiError(w, err)
		return
	}
	content, err = a.readAgentRepositoryContent(r.Context(), content, objectKey, hash, size, 0, koiSkillEntryBytes)
	if err != nil {
		writeKoiError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"skill": skill, "files": files, "instructions": string(content)})
}

func (a *App) koiSkillFileGet(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireKoiSkillUser(w, r, false)
	if !ok {
		return
	}
	skill, err := a.loadKoiInstallation(r.Context(), a.db, user.ID, r.PathValue("skillId"))
	if err != nil {
		writeKoiError(w, err)
		return
	}
	versionID := strings.TrimSpace(r.URL.Query().Get("version"))
	if versionID == "" {
		versionID = skill.VersionID
	}
	if !validUUID(versionID) {
		httpx.ErrorCode(w, 400, "bad_request", "Invalid version")
		return
	}
	position, ok := koiParsePositiveID(r.PathValue("fileId"))
	if !ok {
		writeKoiError(w, errKoiSkillNotFound)
		return
	}
	var view koiSkillFileView
	var content []byte
	var objectKey *string
	err = a.db.QueryRow(r.Context(), `SELECT f.position,f.path,f.mime_type,f.size_bytes,f.sha256,f.content,f.r2_object_key
 FROM koi_skill_version_files f JOIN koi_skill_versions v ON v.id=f.version_id
 WHERE f.version_id=$1 AND f.position=$2 AND v.user_id=$3 AND v.installation_id=$4`,
		versionID, position, user.ID, skill.ID).Scan(&view.Position, &view.Path, &view.MimeType, &view.SizeBytes, &view.SHA256, &content, &objectKey)
	if errors.Is(err, pgx.ErrNoRows) {
		writeKoiError(w, errKoiSkillNotFound)
		return
	}
	if err != nil {
		writeKoiError(w, err)
		return
	}
	content, err = a.readAgentRepositoryContent(r.Context(), content, objectKey, view.SHA256, view.SizeBytes, 0, koiSkillFileBytes)
	if err != nil {
		writeKoiError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"file": view, "contentBase64": base64.StdEncoding.EncodeToString(content)})
}

func (a *App) koiSkillDelete(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireKoiSkillUser(w, r, false)
	if !ok {
		return
	}
	expected, ok := koiParsePositiveID(r.URL.Query().Get("expectedRevision"))
	if !ok || !validUUID(r.PathValue("skillId")) {
		httpx.ErrorCode(w, 400, "bad_request", "expectedRevision is required")
		return
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		writeKoiError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	if _, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock($1)`, user.ID); err != nil {
		writeKoiError(w, err)
		return
	}
	var revision int64
	var deleted bool
	err = tx.QueryRow(r.Context(), `SELECT revision,deleted_at IS NOT NULL FROM koi_skill_installations
 WHERE user_id=$1 AND id=$2 FOR UPDATE`, user.ID, r.PathValue("skillId")).Scan(&revision, &deleted)
	if errors.Is(err, pgx.ErrNoRows) {
		writeKoiError(w, errKoiSkillNotFound)
		return
	}
	if err != nil {
		writeKoiError(w, err)
		return
	}
	if !deleted && revision != expected {
		writeKoiError(w, errKoiSkillConflict)
		return
	}
	if _, err = tx.Exec(r.Context(), `UPDATE koi_skill_installations
 SET deleted_at=now(),enabled=false,revision=revision+1,updated_at=now() WHERE user_id=$1 AND id=$2 AND deleted_at IS NULL`, user.ID, r.PathValue("skillId")); err != nil {
		writeKoiError(w, err)
		return
	}
	retained, err := a.koiRetainedBytes(r.Context(), tx, user.ID, r.PathValue("skillId"))
	if err != nil {
		writeKoiError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		writeKoiError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"deleted": true, "retainedBytes": retained})
}

func (a *App) koiRetainedBytes(ctx context.Context, q imageUsageQuerier, userID int, installationID string) (int64, error) {
	var retained int64
	err := q.QueryRow(ctx, `SELECT COALESCE(sum(f.size_bytes),0) FROM koi_skill_versions v
 JOIN koi_skill_version_files f ON f.version_id=v.id
 WHERE v.user_id=$1 AND v.installation_id=$2 AND EXISTS(SELECT 1 FROM agent_task_skill_versions refs
 JOIN writing_agent_tasks t ON t.id=refs.task_id WHERE refs.version_id=v.id AND t.status NOT IN ('completed','failed','cancelled'))`,
		userID, installationID).Scan(&retained)
	return retained, err
}

func (a *App) koiWriteSkillVersion(ctx context.Context, tx pgx.Tx, userID int, installationID string, candidate koiSkillCandidate, staged map[string]string) (string, error) {
	if candidate.ContentSHA256 != koiSkillContentDigest(candidate.Files) {
		return "", errKoiSkillPackage
	}
	rawMetadata, _ := json.Marshal(candidate.RawMetadata)
	compatibility, _ := json.Marshal(candidate.Compatibility)
	versionID, err := randomUUID()
	if err != nil {
		return "", err
	}
	if _, err = tx.Exec(ctx, `INSERT INTO koi_skill_versions(id,installation_id,user_id,content_sha256,entry_path,name,description,
 raw_metadata,metadata_format,file_count,size_bytes,license,compatibility)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
		versionID, installationID, userID, candidate.ContentSHA256, candidate.EntryPath, candidate.Name, candidate.Description,
		rawMetadata, candidate.MetadataFormat, candidate.FileCount, candidate.SizeBytes,
		candidate.License, compatibility); err != nil {
		return "", err
	}
	for index, file := range candidate.Files {
		key := staged[file.SHA256]
		var content any
		var objectKey any
		if key != "" {
			objectKey = key
		} else {
			content = file.Content
		}
		if _, err = tx.Exec(ctx, `INSERT INTO koi_skill_version_files(version_id,position,path,mime_type,sha256,size_bytes,content,r2_object_key)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, versionID, index+1, file.Path, file.MimeType, file.SHA256, len(file.Content), content, objectKey); err != nil {
			return "", err
		}
	}
	return versionID, nil
}
