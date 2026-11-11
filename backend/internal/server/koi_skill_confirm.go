package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"sort"

	"github.com/jackc/pgx/v5"
	"koinote/backend/internal/httpx"
	"koinote/backend/internal/model"
)

type koiImportConfirmation struct {
	RequestID       string   `json:"requestId"`
	PreviewRevision int64    `json:"previewRevision"`
	CandidateIDs    []string `json:"candidateIds"`
	Enable          *bool    `json:"enable"`
}

func (a *App) koiImportConfirm(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireKoiSkillUser(w, r, true)
	if !ok {
		return
	}
	var input koiImportConfirmation
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if decodeJSONBody(r, &input) != nil || !validUUID(input.RequestID) || input.PreviewRevision < 1 ||
		len(input.CandidateIDs) == 0 || len(input.CandidateIDs) > koiSkillImportFiles {
		httpx.ErrorCode(w, 400, "bad_request", "Invalid confirmation")
		return
	}
	sort.Strings(input.CandidateIDs)
	for i, id := range input.CandidateIDs {
		if i > 0 && id == input.CandidateIDs[i-1] {
			writeKoiError(w, errKoiSkillPackage)
			return
		}
	}
	installed, err := a.confirmKoiFolder(r.Context(), user, r.PathValue("importId"), input)
	if err != nil {
		writeKoiError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"installed": installed})
}

func koiCheckConfirmation(view koiSkillImportView, input koiImportConfirmation, hash string) error {
	if view.Status == "committed" {
		if view.confirmationHash != hash {
			return errKoiRequestReplay
		}
		return nil
	}
	if view.Status == "expired" {
		return errKoiImportExpired
	}
	if view.Status != "ready" {
		return errKoiImportState
	}
	if view.Revision != input.PreviewRevision {
		return errKoiSkillConflict
	}
	return nil
}

// Stage R2 bytes before locking the account. Installation, quota checking and
// the confirmation receipt commit together, including after concurrent retries.
func (a *App) confirmKoiFolder(ctx context.Context, user model.User, id string, input koiImportConfirmation) ([]koiSkillInstallation, error) {
	raw, _ := json.Marshal(input)
	hash := koiDigest(raw)
	// Keep the preview and its uploaded bytes consistent with concurrent confirms
	// and cancellation. Release this short lock before any R2 network calls.
	previewTx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer previewTx.Rollback(context.WithoutCancel(ctx))
	view, err := a.loadKoiImport(ctx, previewTx, user.ID, id, true)
	if err != nil {
		return nil, err
	}
	if err = koiCheckConfirmation(view, input, hash); err != nil {
		return nil, err
	}
	if view.Status == "committed" {
		return view.Installed, nil
	}
	candidates, _, err := a.koiAnalyzeFolder(ctx, previewTx, view)
	if err != nil {
		return nil, err
	}
	fresh := map[string]koiSkillCandidate{}
	for _, candidate := range candidates {
		fresh[candidate.ID] = candidate
	}
	reviewed := map[string]string{}
	for _, candidate := range view.Candidates {
		reviewed[candidate.ID] = candidate.ContentSHA256
	}
	selected := []koiSkillCandidate{}
	files := []agentWorkspaceFile{}
	seen := map[string]bool{}
	for _, candidateID := range input.CandidateIDs {
		candidate, ok := fresh[candidateID]
		if !ok || reviewed[candidateID] != candidate.ContentSHA256 || !candidate.Compatibility.Conversation {
			return nil, errKoiSkillConflict
		}
		if seen[candidate.ContentSHA256] {
			continue
		}
		seen[candidate.ContentSHA256] = true
		selected = append(selected, candidate)
		for _, file := range candidate.Files {
			files = append(files, agentWorkspaceFile{Path: file.Path, Content: file.Content, MimeType: file.MimeType, SHA256: file.SHA256})
		}
	}
	if err = previewTx.Commit(ctx); err != nil {
		return nil, err
	}
	staged, err := a.stageAgentRepositoryFilesForOwner(ctx, nil, files)
	if err != nil {
		return nil, err
	}
	defer a.expireAgentRepositoryStaging(context.WithoutCancel(ctx), staged)
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, user.ID); err != nil {
		return nil, err
	}
	view, err = a.loadKoiImport(ctx, tx, user.ID, id, true)
	if err != nil {
		return nil, err
	}
	if err = koiCheckConfirmation(view, input, hash); err != nil {
		return nil, err
	}
	if view.Status == "committed" {
		return view.Installed, nil
	}
	before, err := storageUsageForQuerier(ctx, tx, user.ID)
	if err != nil {
		return nil, err
	}
	enabled := input.Enable == nil || *input.Enable
	installed := []koiSkillInstallation{}
	for _, candidate := range selected {
		installationID, err := koiFolderInstallationID(ctx, tx, user.ID, candidate.ContentSHA256)
		if errors.Is(err, pgx.ErrNoRows) {
			installationID, err = randomUUID()
			if err != nil {
				return nil, err
			}
			source := map[string]any{"kind": "folder", "directoryName": view.Source["directoryName"], "path": candidate.Directory}
			encoded, _ := json.Marshal(source)
			_, err = tx.Exec(ctx, `INSERT INTO koi_skill_installations(id,user_id,source_key,source_kind,source,name,description,enabled)
 VALUES($1,$2,$3,'folder',$4,$5,$6,$7)`, installationID, user.ID, "folder:"+installationID, encoded, candidate.Name, candidate.Description, enabled)
			if err != nil {
				return nil, err
			}
			versionID, err := a.koiWriteSkillVersion(ctx, tx, user.ID, installationID, candidate, staged)
			if err != nil {
				return nil, err
			}
			if _, err = tx.Exec(ctx, `UPDATE koi_skill_installations SET current_version_id=$2 WHERE id=$1`, installationID, versionID); err != nil {
				return nil, err
			}
		} else if err != nil {
			return nil, err
		}
		// An existing installation keeps its switch, including when disabled.
		skill, err := a.loadKoiInstallation(ctx, tx, user.ID, installationID)
		if err != nil {
			return nil, err
		}
		installed = append(installed, skill)
	}
	after, err := storageUsageForQuerier(ctx, tx, user.ID)
	if err != nil {
		return nil, err
	}
	if after.Total() > a.storageQuotaFor(user) && after.Total() > before.Total() {
		return nil, errAgentWorkspaceQuota
	}
	result, _ := json.Marshal(map[string]any{"installed": installed, "confirmationHash": hash})
	if _, err = tx.Exec(ctx, `UPDATE koi_skill_imports SET status='committed',result=$2,candidates='[]',updated_at=now() WHERE id=$1`, view.ID, result); err != nil {
		return nil, err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM koi_skill_import_files WHERE import_id=$1`, view.ID); err != nil {
		return nil, err
	}
	if err = tx.Commit(ctx); err != nil {
		return nil, err
	}
	return installed, nil
}
