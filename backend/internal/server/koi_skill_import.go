package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"sort"
	"strings"
	"time"

	"koinote/backend/internal/httpx"
)

const koiSkillImportTTL = 24 * time.Hour

type koiImportRequest struct {
	RequestID        string   `json:"requestId"`
	SourceKind       string   `json:"source"`
	DeclaredPaths    []string `json:"declaredPaths"`
	DirectoryName    string   `json:"directoryName"`
	RepositoryURL    string   `json:"repositoryUrl"`
	Ref              string   `json:"ref"`
	Path             string   `json:"path"`
	WorkspaceID      int64    `json:"workspaceId"`
	PublicationID    string   `json:"publicationId"`
	Revision         *int64   `json:"revision"`
	UpdateFromID     string   `json:"updateFromId"`
	ExpectedRevision int64    `json:"expectedRevision"`
}

type koiSkillImportCandidate struct {
	ID                string                `json:"id"`
	Name              string                `json:"name"`
	Description       string                `json:"description"`
	EntryPath         string                `json:"entryPath"`
	Directory         string                `json:"directory"`
	MetadataFormat    string                `json:"metadataFormat"`
	FileCount         int                   `json:"fileCount"`
	SizeBytes         int64                 `json:"sizeBytes"`
	ContentSHA256     string                `json:"contentSha256"`
	License           string                `json:"license"`
	Instructions      string                `json:"instructions"`
	Compatibility     koiSkillCompatibility `json:"compatibility"`
	InstalledID       string                `json:"installedId,omitempty"`
	InstalledStatus   string                `json:"installedStatus,omitempty"`
	InstalledRevision int64                 `json:"installedRevision,omitempty"`
	PreviousVersion   string                `json:"previousVersion,omitempty"`
	PreviousSizeBytes int64                 `json:"previousSizeBytes,omitempty"`
}

type koiSkillImportView struct {
	ID               string                    `json:"id"`
	Status           string                    `json:"status"`
	Revision         int64                     `json:"revision"`
	SourceKind       string                    `json:"sourceKind"`
	Source           map[string]any            `json:"source"`
	Candidates       []koiSkillImportCandidate `json:"candidates"`
	Rejected         []koiSkillRejected        `json:"rejected"`
	ErrorCode        string                    `json:"errorCode,omitempty"`
	ExpiresAt        time.Time                 `json:"expiresAt"`
	UploadedFiles    int                       `json:"uploadedFiles"`
	RejectedFiles    int                       `json:"rejectedFiles"`
	DeclaredFiles    int                       `json:"declaredFiles"`
	DeclaredPaths    []string                  `json:"-"`
	Installed        []koiSkillInstallation    `json:"installed,omitempty"`
	confirmationHash string
}

// All preview mutations lock this row. Ready previews are immutable, so the
// content reviewed here is also the content revalidated during confirmation.
func (a *App) loadKoiImport(ctx context.Context, q imageUsageQuerier, userID int, id string, lock bool) (koiSkillImportView, error) {
	var view koiSkillImportView
	if !validUUID(id) {
		return view, errKoiSkillNotFound
	}
	query := `SELECT id::text,status,revision,source_kind,source,candidates,declared_paths,error_code,expires_at,result,
 (SELECT count(*) FROM koi_skill_import_files WHERE import_id=i.id AND error_code=''),
 (SELECT count(*) FROM koi_skill_import_files WHERE import_id=i.id AND error_code<>''),expires_at<=clock_timestamp()
 FROM koi_skill_imports i WHERE id=$1 AND user_id=$2`
	if lock {
		query += " FOR UPDATE"
	}
	var source, candidates, result []byte
	var expired bool
	err := q.QueryRow(ctx, query, id, userID).Scan(&view.ID, &view.Status, &view.Revision, &view.SourceKind,
		&source, &candidates, &view.DeclaredPaths, &view.ErrorCode, &view.ExpiresAt, &result, &view.UploadedFiles, &view.RejectedFiles, &expired)
	if err != nil {
		return view, err
	}
	if err = json.Unmarshal(source, &view.Source); err != nil {
		return view, err
	}
	if err = json.Unmarshal(candidates, &view.Candidates); err != nil {
		return view, err
	}
	view.Rejected = []koiSkillRejected{}
	if len(result) > 0 {
		var stored struct {
			Rejected  []koiSkillRejected     `json:"rejected"`
			Installed []koiSkillInstallation `json:"installed"`
			Hash      string                 `json:"confirmationHash"`
		}
		if err = json.Unmarshal(result, &stored); err != nil {
			return view, err
		}
		if stored.Rejected != nil {
			view.Rejected = stored.Rejected
		}
		view.Installed, view.confirmationHash = stored.Installed, stored.Hash
	}
	view.DeclaredFiles = len(view.DeclaredPaths)
	if expired && (view.Status == "pending" || view.Status == "analyzing" || view.Status == "ready" || view.Status == "failed") {
		view.Status, view.Candidates, view.Rejected = "expired", []koiSkillImportCandidate{}, []koiSkillRejected{}
	}
	return view, nil
}

func (a *App) koiImportGet(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireKoiSkillUser(w, r, false)
	if !ok {
		return
	}
	view, err := a.loadKoiImport(r.Context(), a.db, user.ID, r.PathValue("importId"), false)
	if err != nil {
		writeKoiError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"preview": view})
}

func (a *App) koiImportCreate(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireKoiSkillUser(w, r, true)
	if !ok {
		return
	}
	var input koiImportRequest
	r.Body = http.MaxBytesReader(w, r.Body, 256<<10)
	if decodeJSONBody(r, &input) != nil || !validUUID(input.RequestID) {
		httpx.ErrorCode(w, 400, "bad_request", "Invalid import request")
		return
	}
	if input.SourceKind == "migration" && (len(input.DeclaredPaths) != 0 || input.DirectoryName != "" || input.RepositoryURL != "" || input.Ref != "" || input.Path != "" || input.WorkspaceID != 0 || input.PublicationID != "" || input.Revision != nil || input.UpdateFromID != "" || input.ExpectedRevision != 0) {
		httpx.ErrorCode(w, 400, "bad_request", "Migration does not accept a separate source")
		return
	}
	settings, err := a.koiSettingsForUser(r.Context(), user.ID)
	if err != nil {
		writeKoiError(w, err)
		return
	}
	if settings.LibraryMode == "legacy" && input.SourceKind != "migration" {
		writeKoiError(w, errKoiMigrationRequired)
		return
	}
	if input.SourceKind == "migration" && settings.LibraryMode != "legacy" {
		var committed bool
		err = a.db.QueryRow(r.Context(), `SELECT EXISTS(SELECT 1 FROM koi_skill_imports WHERE user_id=$1 AND request_id=$2 AND source_kind='migration' AND status='committed')`, user.ID, input.RequestID).Scan(&committed)
		if err != nil {
			writeKoiError(w, err)
			return
		}
		if !committed {
			writeKoiError(w, errKoiImportState)
			return
		}
	}
	if input.SourceKind == "github" || input.SourceKind == "hub" || input.SourceKind == "migration" {
		a.koiRemoteImportCreate(w, r, user, input)
		return
	}
	if input.SourceKind != "folder" ||
		len(input.DeclaredPaths) == 0 || len(input.DeclaredPaths) > koiSkillImportFiles ||
		len(input.DirectoryName) > 512 || strings.ContainsAny(input.DirectoryName, "/\\\x00") {
		httpx.ErrorCode(w, 400, "bad_request", "Declare a folder with 1 to 512 relative file paths")
		return
	}
	seen := map[string]bool{}
	for i, raw := range input.DeclaredPaths {
		clean, err := normalizeAgentWorkspacePath(raw)
		if err != nil || seen[clean] {
			httpx.ErrorCode(w, 400, "bad_request", "Invalid or duplicate file path")
			return
		}
		seen[clean], input.DeclaredPaths[i] = true, clean
	}
	sort.Strings(input.DeclaredPaths)
	id, err := randomUUID()
	if err != nil {
		writeKoiError(w, err)
		return
	}
	canonical := input
	canonical.RequestID = ""
	raw, _ := json.Marshal(canonical)
	hash := koiDigest(raw)
	sourceData := map[string]any{"kind": "folder", "directoryName": input.DirectoryName}
	if input.UpdateFromID != "" {
		target, err := a.loadKoiInstallation(r.Context(), a.db, user.ID, input.UpdateFromID)
		if err != nil {
			writeKoiError(w, err)
			return
		}
		if (target.SourceKind != "folder" && target.SourceKind != "migration") || input.ExpectedRevision != target.Revision {
			writeKoiError(w, errKoiSkillConflict)
			return
		}
		sourceData["updateFromId"], sourceData["updateRevision"] = target.ID, target.Revision
	}
	source, _ := json.Marshal(sourceData)
	// Concurrent retries share a receipt; a reused key with different input is a conflict.
	_, err = a.db.Exec(r.Context(), `INSERT INTO koi_skill_imports(id,user_id,request_id,input_hash,source_kind,source,declared_paths,expires_at)
 VALUES($1,$2,$3,$4,'folder',$5,$6,now()+$7::interval) ON CONFLICT(user_id,request_id) DO NOTHING`,
		id, user.ID, input.RequestID, hash, source, input.DeclaredPaths, koiSkillImportTTL.String())
	if err != nil {
		writeKoiError(w, err)
		return
	}
	var existingHash string
	if err = a.db.QueryRow(r.Context(), `SELECT id::text,input_hash FROM koi_skill_imports WHERE user_id=$1 AND request_id=$2`,
		user.ID, input.RequestID).Scan(&id, &existingHash); err != nil {
		writeKoiError(w, err)
		return
	}
	if existingHash != hash {
		writeKoiError(w, errKoiRequestReplay)
		return
	}
	view, err := a.loadKoiImport(r.Context(), a.db, user.ID, id, false)
	if err != nil {
		writeKoiError(w, err)
		return
	}
	httpx.JSON(w, http.StatusAccepted, map[string]any{"preview": view})
}

func (a *App) koiImportFilePut(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireKoiSkillUser(w, r, true)
	if !ok {
		return
	}
	var input struct {
		ContentBase64 string `json:"contentBase64"`
	}
	// The URL identifies the member even when its body exceeds the read limit.
	clean, err := normalizeAgentWorkspacePath(r.URL.Query().Get("path"))
	if err != nil {
		httpx.ErrorCode(w, 400, "bad_request", "Invalid file path")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 2*koiSkillFileBytes)
	var content []byte
	rejection := ""
	if err = decodeJSONBody(r, &input); err != nil {
		var tooLarge *http.MaxBytesError
		if !errors.As(err, &tooLarge) {
			httpx.ErrorCode(w, 400, "bad_request", "Invalid file upload")
			return
		}
		rejection = "file_too_large"
	} else {
		content, err = base64.StdEncoding.DecodeString(input.ContentBase64)
		if err != nil {
			httpx.ErrorCode(w, 400, "bad_request", "Invalid base64 content")
			return
		}
		if len(content) > koiSkillFileBytes {
			rejection = "file_too_large"
		} else if agentWorkspaceSensitiveContent(content) {
			rejection = "sensitive_data_detected"
		}
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		writeKoiError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	view, err := a.loadKoiImport(r.Context(), tx, user.ID, r.PathValue("importId"), true)
	if err != nil {
		writeKoiError(w, err)
		return
	}
	if view.Status == "expired" {
		writeKoiError(w, errKoiImportExpired)
		return
	}
	if view.Status != "pending" && view.Status != "failed" {
		writeKoiError(w, errKoiImportState)
		return
	}
	if !slices.Contains(view.DeclaredPaths, clean) {
		writeKoiError(w, errKoiUploadMissing)
		return
	}
	var hash, size, storedContent any
	if rejection == "" {
		hash, size, storedContent = koiDigest(content), len(content), content
	}
	_, err = tx.Exec(r.Context(), `INSERT INTO koi_skill_import_files(import_id,path,sha256,size_bytes,content,error_code)
 VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(import_id,path) DO UPDATE
 SET sha256=EXCLUDED.sha256,size_bytes=EXCLUDED.size_bytes,content=EXCLUDED.content,error_code=EXCLUDED.error_code`,
		view.ID, clean, hash, size, storedContent, rejection)
	if err != nil {
		writeKoiError(w, err)
		return
	}
	var uploaded, total int64
	if err = tx.QueryRow(r.Context(), `SELECT count(*) FILTER (WHERE error_code=''),COALESCE(sum(size_bytes),0) FROM koi_skill_import_files WHERE import_id=$1`, view.ID).Scan(&uploaded, &total); err != nil {
		writeKoiError(w, err)
		return
	}
	if total > koiSkillImportBytes {
		writeKoiError(w, errKoiSkillTooLarge)
		return
	}
	// A missing or invalid file can be replaced after a failed analysis.
	if view.Status == "failed" {
		if _, err = tx.Exec(r.Context(), `UPDATE koi_skill_imports SET status='pending',error_code='',result=NULL,candidates='[]',revision=revision+1,updated_at=now() WHERE id=$1`, view.ID); err != nil {
			writeKoiError(w, err)
			return
		}
	}
	if err = tx.Commit(r.Context()); err != nil {
		writeKoiError(w, err)
		return
	}
	if rejection == "file_too_large" {
		httpx.ErrorCode(w, 413, "file_too_large", "Each file must be at most 128 KiB")
		return
	}
	if rejection == "sensitive_data_detected" {
		writeKoiError(w, &agentWorkspaceSensitiveError{Path: clean})
		return
	}
	httpx.JSON(w, 200, map[string]any{"uploadedFiles": uploaded, "bytes": total, "path": clean})
}

// Remote reads happen outside locks; folder analysis keeps uploaded bytes and
// the saved preview consistent in one short transaction.
func (a *App) koiImportAnalyze(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireKoiSkillUser(w, r, true)
	if !ok {
		return
	}
	view, err := a.loadKoiImport(r.Context(), a.db, user.ID, r.PathValue("importId"), false)
	if err != nil {
		writeKoiError(w, err)
		return
	}
	if view.SourceKind != "folder" {
		view, err = a.analyzeKoiRemotePreview(r.Context(), user.ID, view)
		if err != nil {
			writeKoiError(w, err)
			return
		}
		httpx.JSON(w, 200, map[string]any{"preview": view})
		return
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		writeKoiError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	view, err = a.loadKoiImport(r.Context(), tx, user.ID, r.PathValue("importId"), true)
	if err != nil {
		writeKoiError(w, err)
		return
	}
	if view.Status == "expired" {
		writeKoiError(w, errKoiImportExpired)
		return
	}
	if view.Status == "ready" {
		httpx.JSON(w, 200, map[string]any{"preview": view})
		return
	}
	if view.Status != "pending" && view.Status != "failed" {
		writeKoiError(w, errKoiImportState)
		return
	}
	candidates, rejected, err := a.koiAnalyzeFolder(r.Context(), tx, view)
	if err != nil {
		writeKoiError(w, err)
		return
	}
	previews, err := a.koiPreviewCandidates(r.Context(), tx, user.ID, view.SourceKind, view.Source, candidates)
	if err != nil {
		writeKoiError(w, err)
		return
	}
	status, code := "ready", ""
	if len(previews) == 0 {
		status, code = "failed", "no_skills"
		if len(rejected) > 0 {
			code = "validation_failed"
		}
	}
	encoded, _ := json.Marshal(previews)
	result, _ := json.Marshal(map[string]any{"rejected": rejected})
	_, err = tx.Exec(r.Context(), `UPDATE koi_skill_imports SET status=$2,candidates=$3,result=$4,error_code=$5,revision=revision+1,updated_at=now() WHERE id=$1`, view.ID, status, encoded, result, code)
	if err != nil {
		writeKoiError(w, err)
		return
	}
	view, err = a.loadKoiImport(r.Context(), tx, user.ID, view.ID, false)
	if err != nil {
		writeKoiError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		writeKoiError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"preview": view})
}

func (a *App) koiAnalyzeFolder(ctx context.Context, q agentWorkspaceQuerier, view koiSkillImportView) ([]koiSkillCandidate, []koiSkillRejected, error) {
	if view.SourceKind != "folder" {
		return nil, nil, errKoiImportState
	}
	rows, err := q.Query(ctx, `SELECT path,COALESCE(sha256,''),COALESCE(size_bytes,0),content,error_code
 FROM koi_skill_import_files WHERE import_id=$1 ORDER BY path`, view.ID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	files := []koiSkillFile{}
	var total int64
	for rows.Next() {
		var file koiSkillFile
		if err = rows.Scan(&file.Path, &file.SHA256, &file.SizeBytes, &file.Content, &file.RejectionCode); err != nil {
			return nil, nil, err
		}
		if file.RejectionCode != "" {
			files = append(files, file)
			continue
		}
		if file.SizeBytes != int64(len(file.Content)) || koiDigest(file.Content) != file.SHA256 {
			return nil, nil, errKoiSkillPackage
		}
		if file.SizeBytes > koiSkillFileBytes {
			return nil, nil, errKoiSkillTooLarge
		}
		if agentWorkspaceSensitiveContent(file.Content) {
			return nil, nil, &agentWorkspaceSensitiveError{Path: file.Path}
		}
		total += file.SizeBytes
		files = append(files, file)
	}
	if err = rows.Err(); err != nil {
		return nil, nil, err
	}
	if len(files) != view.DeclaredFiles {
		return nil, nil, errKoiUploadMissing
	}
	if total > koiSkillImportBytes {
		return nil, nil, errKoiSkillTooLarge
	}
	name, _ := view.Source["directoryName"].(string)
	candidates, rejected := koiSkillCandidates(files, koiSkillSourceContext{RootName: name})
	return candidates, rejected, nil
}

func (a *App) koiImportDelete(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireKoiSkillUser(w, r, false)
	if !ok {
		return
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		writeKoiError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	view, err := a.loadKoiImport(r.Context(), tx, user.ID, r.PathValue("importId"), true)
	if err != nil {
		writeKoiError(w, err)
		return
	}
	if view.Status != "committed" {
		_, err = tx.Exec(r.Context(), `UPDATE koi_skill_imports SET status='cancelled',candidates='[]',result=NULL,revision=revision+1,updated_at=now() WHERE id=$1 AND status NOT IN ('cancelled','expired')`, view.ID)
		if err != nil {
			writeKoiError(w, err)
			return
		}
		view.Status = "cancelled"
	}
	if _, err = tx.Exec(r.Context(), `DELETE FROM koi_skill_import_files WHERE import_id=$1`, view.ID); err != nil {
		writeKoiError(w, err)
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		writeKoiError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"status": view.Status})
}
