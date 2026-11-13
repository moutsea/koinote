package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"path"
	"strconv"
	"time"

	"github.com/jackc/pgx/v5"
	"koinote/backend/internal/httpx"
	"koinote/backend/internal/model"
)

type koiAnalysis struct {
	candidates []koiSkillCandidate
	rejected   []koiSkillRejected
	source     map[string]any
}

var errKoiSourceUnavailable = errors.New("skill source is no longer available; the installed version is unchanged")

func koiSourceID(source map[string]any, key string) int64 {
	switch value := source[key].(type) {
	case int64:
		return value
	case int:
		return int64(value)
	case float64:
		return int64(value)
	}
	return 0
}

func koiSourceText(source map[string]any, key string) string {
	value, _ := source[key].(string)
	return value
}

func koiCandidateSource(source map[string]any, candidate koiSkillCandidate) map[string]any {
	if koiSourceText(source, "kind") == "migration" {
		return koiMigrationCandidateSource(source, candidate.ID)
	}
	result := map[string]any{}
	for key, value := range source {
		result[key] = value
	}
	delete(result, "updateFromId")
	delete(result, "updateRevision")
	result["path"] = path.Join(koiSourceText(source, "path"), candidate.Directory)
	if result["path"] == "." {
		result["path"] = ""
	}
	return result
}

// Identity uses the immutable repository ID, so a renamed/replaced upstream
// cannot silently take over an existing installation. Each package owns its path.
func koiRemoteSourceKey(kind string, source map[string]any) string {
	key := "repositoryId"
	if kind == "hub" || kind == "migration" {
		key = "workspaceId"
	}
	return kind + ":" + strconv.FormatInt(koiSourceID(source, key), 10) + ":" + koiSourceText(source, "path")
}

func (a *App) koiAnalyzeSource(ctx context.Context, userID int, source map[string]any) (koiAnalysis, error) {
	kind := koiSourceText(source, "kind")
	var files []koiSkillFile
	var root, license, dir string
	var exact bool
	var indexSource *agentGitHubSource
	var indexStarted time.Time
	var repositoryID int64
	switch kind {
	case "migration":
		ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
		defer cancel()
		analysis, err := a.koiAnalyzeLegacyRepositories(ctx, userID, source)
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return koiAnalysis{}, errKoiMigrationTimeout
		}
		return analysis, err
	case "github":
		token, err := a.loadGitHubToken(ctx, userID)
		if err != nil {
			return koiAnalysis{}, err
		}
		ref := koiSourceText(source, "ref")
		pinned := koiSourceText(source, "commitSha")
		if pinned != "" {
			ref = pinned
		} else {
			// Compare check ordering on the database clock, not the application
			// host's clock. Index failures must not block a private installation.
			_ = a.db.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&indexStarted)
		}
		exact, _ = source["fileEntry"].(bool)
		result, err := a.readKoiGitHubSource(ctx, koiGitHubSourceInput{RepositoryURL: koiSourceText(source, "repositoryUrl"), Ref: ref, Path: koiSourceText(source, "path"), ExactSkill: exact}, token)
		if err != nil {
			if errors.Is(err, errAgentGitHubRepositoryMissing) {
				return koiAnalysis{}, errors.Join(errKoiSourceUnavailable, err)
			}
			return koiAnalysis{}, err
		}
		if old := koiSourceID(source, "repositoryId"); old != 0 && old != result.Source.RepositoryID {
			return koiAnalysis{}, errKoiSkillConflict
		}
		fixed := result.Source
		repositoryID = fixed.RepositoryID
		if pinned == "" && result.Target.Path == "" && !result.Target.FileEntry {
			indexSource = fixed
		}
		dir, root, license, files, exact = result.Target.Path, result.Target.Repo, fixed.License, result.Files, result.Target.FileEntry
		// Preserve the tracking ref while confirmation reads the fixed commit.
		tracking := fixed.Ref
		if pinned != "" {
			tracking = koiSourceText(source, "ref")
		}
		source = map[string]any{"kind": kind, "repositoryUrl": fixed.RepositoryURL, "repositoryId": fixed.RepositoryID, "owner": result.Target.Owner, "repo": root, "ref": tracking, "commitSha": fixed.CommitSHA, "path": dir, "fileEntry": exact, "author": fixed.Author, "authorUrl": fixed.AuthorURL, "license": license, "private": fixed.Private}
	case "hub":
		var revision *int64
		if source["revision"] != nil {
			value := koiSourceID(source, "revision")
			revision = &value
		}
		exact, _ = source["exactSkill"].(bool)
		result, err := a.readKoiHubSource(ctx, koiHubSourceInput{WorkspaceID: koiSourceID(source, "workspaceId"), PublicationID: koiSourceText(source, "publicationId"), Revision: revision, Path: koiSourceText(source, "path"), ExactSkill: exact})
		if err != nil {
			if errors.Is(err, errAgentWorkspaceNotFound) {
				return koiAnalysis{}, errors.Join(errKoiSourceUnavailable, err)
			}
			return koiAnalysis{}, err
		}
		publication := result.Publication
		dir, root, license, files = result.Path, publication.Name, publication.License, result.Files
		source = map[string]any{"kind": kind, "workspaceId": publication.WorkspaceID, "publicationId": publication.PublicationID, "revision": publication.Revision, "name": root, "path": dir, "exactSkill": exact, "license": license}
		if publication.GitHubSource != nil {
			source["author"], source["authorUrl"] = publication.GitHubSource.Author, publication.GitHubSource.AuthorURL
			repositoryID = publication.GitHubSource.RepositoryID
			source["repositoryId"] = repositoryID
		}
	default:
		return koiAnalysis{}, errKoiSkillPackage
	}
	review, err := loadKoiRepositoryCuration(ctx, a.db)
	if err != nil {
		return koiAnalysis{}, err
	}
	candidates, rejected := koiSkillCandidates(files, koiSkillSourceContext{Directory: dir, RootName: root, License: license, Review: review})
	if exact {
		selected := []koiSkillCandidate{}
		for _, candidate := range candidates {
			if candidate.Directory == "" {
				selected = append(selected, candidate)
			}
		}
		candidates = selected
		filtered := []koiSkillRejected{}
		for _, item := range rejected {
			if item.EntryPath == "SKILL.md" {
				filtered = append(filtered, item)
			}
		}
		rejected = filtered
	}
	if repositoryID != 0 {
		if _, reviewed := review.repositories[repositoryID]; reviewed {
			source["reviewedSubset"] = true
		}
		var skipped []koiSkillRejected
		candidates, skipped = review.candidates(repositoryID, candidates)
		rejected = append(rejected, skipped...)
	}
	if indexSource != nil && !indexStarted.IsZero() {
		a.rememberKoiGitHubInstallability(ctx, indexSource, indexStarted, len(candidates) > 0, review.revision, newKoiInstallabilityEvidence(files, root, license))
	}
	return koiAnalysis{candidates: candidates, rejected: rejected, source: source}, nil
}

func (a *App) koiPreviewCandidates(ctx context.Context, q koiCompatibilityQuerier, userID int, kind string, source map[string]any, candidates []koiSkillCandidate) ([]koiSkillImportCandidate, error) {
	previews := []koiSkillImportCandidate{}
	for _, group := range koiCandidateGroups(kind, source, candidates) {
		candidate := group[0]
		var id string
		var err error
		if target := koiSourceText(source, "updateFromId"); target != "" {
			id = target
		} else if kind == "folder" {
			id, err = koiFolderInstallationID(ctx, q, userID, candidate.ContentSHA256)
		} else if kind == "github" || kind == "hub" || kind == "migration" {
			var key string
			id, key, err = koiRemoteInstallationMatch(ctx, q, userID, kind, source, group)
			// Keep the installed copy's tracking directory when an upstream
			// ships identical packages for multiple clients.
			for _, alias := range group {
				if koiRemoteSourceKey(kind, koiCandidateSource(source, alias)) == key {
					candidate = alias
					break
				}
			}
		} else {
			err = q.QueryRow(ctx, `SELECT id::text FROM koi_skill_installations WHERE user_id=$1 AND source_key=$2 AND deleted_at IS NULL`, userID, koiRemoteSourceKey(kind, koiCandidateSource(source, candidate))).Scan(&id)
		}
		item := koiSkillImportCandidate{ID: candidate.ID, Name: candidate.Name, Description: candidate.Description, EntryPath: candidate.EntryPath, Directory: candidate.Directory, MetadataFormat: candidate.MetadataFormat, FileCount: candidate.FileCount, SizeBytes: candidate.SizeBytes, ContentSHA256: candidate.ContentSHA256, License: candidate.License, Instructions: candidate.Instructions, Compatibility: candidate.Compatibility}
		if errors.Is(err, pgx.ErrNoRows) {
			previews = append(previews, item)
			continue
		}
		if err != nil {
			return nil, err
		}
		installed, err := a.loadKoiInstallation(ctx, q, userID, id)
		if err != nil {
			return nil, err
		}
		item.InstalledID, item.InstalledRevision, item.PreviousVersion, item.PreviousSizeBytes = id, installed.Revision, installed.Version, installed.SizeBytes
		item.InstalledStatus = "installed"
		if installed.ContentSHA256 != candidate.ContentSHA256 {
			item.InstalledStatus = "update"
		}
		if expected := koiSourceID(source, "updateRevision"); expected != 0 && expected != installed.Revision {
			return nil, errKoiSkillConflict
		}
		previews = append(previews, item)
	}
	return previews, nil
}

func (a *App) koiRemoteImportCreate(w http.ResponseWriter, r *http.Request, user model.User, input koiImportRequest) {
	if input.UpdateFromID != "" || len(input.RepositoryURL) > 2048 || len(input.Ref) > 256 || len(input.Path) > 4096 ||
		(input.SourceKind == "github" && input.RepositoryURL == "") || (input.SourceKind == "hub" && (input.WorkspaceID <= 0 || input.Revision != nil && *input.Revision < 0)) {
		httpx.ErrorCode(w, 400, "bad_request", "Invalid Skill source")
		return
	}
	source := map[string]any{"kind": input.SourceKind, "repositoryUrl": input.RepositoryURL, "ref": input.Ref, "path": input.Path, "workspaceId": input.WorkspaceID, "publicationId": input.PublicationID}
	if input.Revision != nil {
		source["revision"] = *input.Revision
	}
	canonical := input
	canonical.RequestID = ""
	raw, _ := json.Marshal(canonical)
	encoded, _ := json.Marshal(source)
	id, err := randomUUID()
	if err == nil {
		_, err = a.db.Exec(r.Context(), `INSERT INTO koi_skill_imports(id,user_id,request_id,input_hash,source_kind,source,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+$7::interval) ON CONFLICT(user_id,request_id) DO NOTHING`, id, user.ID, input.RequestID, koiDigest(raw), input.SourceKind, encoded, koiSkillImportTTL.String())
	}
	var hash string
	if err == nil {
		err = a.db.QueryRow(r.Context(), `SELECT id::text,input_hash FROM koi_skill_imports WHERE user_id=$1 AND request_id=$2`, user.ID, input.RequestID).Scan(&id, &hash)
	}
	if err == nil && hash != koiDigest(raw) {
		err = errKoiRequestReplay
	}
	if err != nil {
		writeKoiError(w, err)
		return
	}
	view, err := a.loadKoiImport(r.Context(), a.db, user.ID, id, false)
	if err == nil {
		view, err = a.analyzeKoiRemotePreview(r.Context(), user.ID, view)
	}
	if err != nil {
		writeKoiError(w, err)
		return
	}
	httpx.JSON(w, http.StatusAccepted, map[string]any{"preview": view})
}

// Upstream reads run outside locks. Only a still-pending preview can accept the
// result; concurrent retries, cancellation and expiry cannot overwrite a receipt.
func (a *App) analyzeKoiRemotePreview(ctx context.Context, userID int, view koiSkillImportView) (koiSkillImportView, error) {
	if view.Status == "ready" || view.Status == "committed" {
		return view, nil
	}
	if view.Status == "expired" {
		return view, errKoiImportExpired
	}
	if view.Status != "pending" && view.Status != "failed" {
		return view, errKoiImportState
	}
	analysis, err := a.koiAnalyzeSource(ctx, userID, view.Source)
	if err != nil {
		return view, err
	}
	return a.storeKoiSourcePreview(ctx, userID, view, analysis)
}

func (a *App) storeKoiSourcePreview(ctx context.Context, userID int, view koiSkillImportView, analysis koiAnalysis) (koiSkillImportView, error) {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return view, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	current, err := a.loadKoiImport(ctx, tx, userID, view.ID, true)
	if err != nil {
		return view, err
	}
	if current.Status == "ready" || current.Status == "committed" {
		return current, nil
	}
	if current.Status == "expired" {
		return current, errKoiImportExpired
	}
	if current.Revision != view.Revision || (current.Status != "pending" && current.Status != "failed") {
		return current, errKoiSkillConflict
	}
	previews, err := a.koiPreviewCandidates(ctx, tx, userID, view.SourceKind, analysis.source, analysis.candidates)
	if err != nil {
		return view, err
	}
	status, code := "ready", ""
	if len(previews) == 0 {
		status, code = "failed", "no_skills"
		if len(analysis.rejected) > 0 {
			code = "validation_failed"
		}
	}
	candidates, _ := json.Marshal(previews)
	source, _ := json.Marshal(analysis.source)
	result, _ := json.Marshal(map[string]any{"rejected": analysis.rejected})
	_, err = tx.Exec(ctx, `UPDATE koi_skill_imports SET status=$2,candidates=$3,source=$4,result=$5,error_code=$6,revision=revision+1,updated_at=now() WHERE id=$1`, view.ID, status, candidates, source, result, code)
	if err == nil {
		current, err = a.loadKoiImport(ctx, tx, userID, view.ID, false)
	}
	if err == nil {
		err = tx.Commit(ctx)
	}
	return current, err
}

func (a *App) koiSkillCheckUpdate(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireKoiSkillUser(w, r, true)
	if !ok {
		return
	}
	installed, err := a.loadKoiInstallation(r.Context(), a.db, user.ID, r.PathValue("skillId"))
	if err != nil {
		writeKoiError(w, err)
		return
	}
	if installed.SourceKind == "folder" || installed.SourceKind == "migration" {
		httpx.JSON(w, 200, map[string]any{"status": "manual_only"})
		return
	}
	source := map[string]any{}
	for key, value := range installed.Source {
		source[key] = value
	}
	delete(source, "commitSha")
	delete(source, "publicationId")
	delete(source, "revision")
	source["fileEntry"], source["exactSkill"] = true, true
	analysis, err := a.koiAnalyzeSource(r.Context(), user.ID, source)
	if errors.Is(err, errAgentWorkspaceNotFound) || errors.Is(err, errAgentGitHubRepositoryMissing) {
		httpx.JSON(w, 200, map[string]any{"status": "source_unavailable"})
		return
	}
	if err != nil {
		writeKoiError(w, err)
		return
	}
	if len(analysis.candidates) == 0 && len(analysis.rejected) == 0 {
		httpx.JSON(w, 200, map[string]any{"status": "source_unavailable"})
		return
	}
	if len(analysis.candidates) == 1 && analysis.candidates[0].ContentSHA256 == installed.ContentSHA256 {
		httpx.JSON(w, 200, map[string]any{"status": "up_to_date"})
		return
	}
	analysis.source["updateFromId"], analysis.source["updateRevision"] = installed.ID, installed.Revision
	id, err := randomUUID()
	if err != nil {
		writeKoiError(w, err)
		return
	}
	encoded, _ := json.Marshal(analysis.source)
	_, err = a.db.Exec(r.Context(), `INSERT INTO koi_skill_imports(id,user_id,request_id,input_hash,source_kind,source,expires_at) VALUES($1,$2,$1,$3,$4,$5,now()+$6::interval)`, id, user.ID, koiDigest(encoded), installed.SourceKind, encoded, koiSkillImportTTL.String())
	var view koiSkillImportView
	if err == nil {
		view, err = a.loadKoiImport(r.Context(), a.db, user.ID, id, false)
	}
	if err == nil {
		view, err = a.storeKoiSourcePreview(r.Context(), user.ID, view, analysis)
	}
	if err != nil {
		writeKoiError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"status": "update_available", "preview": view})
}
