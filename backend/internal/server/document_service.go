package server

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"koinote/backend/internal/model"
)

const (
	webVersionSnapshotInterval  = 5 * time.Minute
	maxDocumentCoverSourceBytes = 2048
)

var (
	errDocumentNotFound          = errors.New("document not found")
	errDocumentIDConflict        = errors.New("document id conflict")
	errDocumentQuotaExceeded     = errors.New("document storage quota exceeded")
	errDocumentRevisionConflict  = errors.New("document revision conflict")
	errDocumentCoverInvalid      = errors.New("document cover invalid")
	errDocumentVersionNotFound   = errors.New("document version not found")
	errDocumentNotTrashed        = errors.New("document is not in trash")
	errDocumentPurgeConfirmation = errors.New("document purge confirmation does not match")
)

type documentMutationSource string

const (
	documentSourceWeb     documentMutationSource = "web"
	documentSourceMCP     documentMutationSource = "mcp"
	documentSourceRestore documentMutationSource = "restore"
	documentSourceAgent   documentMutationSource = "agent"
)

type createDocumentParams struct {
	User             model.User
	DocID            string
	Title            string
	Theme            *string
	Content          string
	FolderID         *string
	CoverMode        string
	CoverRatio       string
	CoverImageSource string
	CoverPrompt      string
}

type updateDocumentParams struct {
	User             model.User
	DocID            string
	Title            string
	Theme            string
	Content          string
	ExpectedRevision int64
	Source           documentMutationSource
	SourceTokenID    *int64
	ForceVersion     bool
	CoverMode        *string
	CoverRatio       *string
	CoverImageSource *string
	CoverPrompt      *string
}

type storedDocument struct {
	ID               int
	Doc              model.Document
	LastWebVersionAt *time.Time
}

type documentUpdateResult struct {
	Document                 model.Document
	PreviousContent          string
	PrunedContents           []string
	ContentChanged           bool
	PreviousCoverImageSource string
	CoverChanged             bool
}

func documentCoverValues(previous model.Document, params updateDocumentParams) (string, string, string, string) {
	mode := previous.CoverMode
	if params.CoverMode != nil {
		mode = strings.TrimSpace(*params.CoverMode)
	}
	if mode == "" {
		mode = wechatCoverModeDefault
	}
	ratio := previous.CoverRatio
	if params.CoverRatio != nil {
		ratio = strings.TrimSpace(*params.CoverRatio)
	}
	if ratio == "" {
		ratio = wechatCoverRatioWide
	}
	imageSource := previous.CoverImageSource
	if params.CoverImageSource != nil {
		imageSource = strings.TrimSpace(*params.CoverImageSource)
	}
	prompt := previous.CoverPrompt
	if params.CoverPrompt != nil {
		prompt = strings.TrimSpace(*params.CoverPrompt)
	}
	if mode != wechatCoverModeAI {
		prompt = ""
	}
	return mode, ratio, imageSource, prompt
}

func validDocumentCoverValues(mode, ratio, imageSource, prompt string) bool {
	return validWechatCoverMode(mode) && validWechatCoverRatio(ratio) &&
		len(imageSource) <= maxDocumentCoverSourceBytes &&
		!strings.HasPrefix(strings.ToLower(imageSource), "data:") &&
		utf8.RuneCountInString(prompt) <= wechatCoverPromptMaxRunes &&
		(mode != wechatCoverModeArticle || strings.TrimSpace(imageSource) != "")
}

func (a *App) createDocument(ctx context.Context, params createDocumentParams) (model.Document, error) {
	docID := strings.TrimSpace(params.DocID)
	if docID == "" {
		var err error
		docID, err = randomUUID()
		if err != nil {
			return model.Document{}, fmt.Errorf("document id: %w", err)
		}
	}
	theme := defaultDocumentTheme
	if params.Theme != nil {
		theme = normalizeDocumentTheme(*params.Theme)
	}
	coverMode := strings.TrimSpace(params.CoverMode)
	if coverMode == "" {
		coverMode = wechatCoverModeDefault
	}
	coverRatio := strings.TrimSpace(params.CoverRatio)
	if coverRatio == "" {
		coverRatio = wechatCoverRatioWide
	}
	coverImageSource := strings.TrimSpace(params.CoverImageSource)
	coverPrompt := strings.TrimSpace(params.CoverPrompt)
	if !validDocumentCoverValues(coverMode, coverRatio, coverImageSource, coverPrompt) {
		return model.Document{}, errDocumentCoverInvalid
	}
	if coverMode != wechatCoverModeAI {
		coverPrompt = ""
	}

	tx, err := a.db.Begin(ctx)
	if err != nil {
		return model.Document{}, err
	}
	defer tx.Rollback(ctx)

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, params.User.ID); err != nil {
		return model.Document{}, err
	}

	var doc model.Document
	err = tx.QueryRow(ctx, `
		WITH target_folder AS (
			SELECT CASE
				WHEN $6 = '' THEN NULL::integer
				ELSE (SELECT id FROM folders WHERE folder_id = $6 AND user_id = $2)
			END AS id
		)
		INSERT INTO documents (
			doc_id, user_id, title, theme, content, folder_id, cover_mode, cover_ratio, cover_image_source, cover_prompt, sort_order, revision, created_at, updated_at
		)
		SELECT
			$1, $2, $3::text, $4::text, $5::text,
			target_folder.id,
			$7::text, $8::text, $9::text, $10::text,
			COALESCE((
				SELECT MAX(existing.sort_order) + 1
				FROM documents existing
				WHERE existing.user_id = $2
				  AND existing.trashed_at IS NULL
				  AND existing.folder_id IS NOT DISTINCT FROM target_folder.id
		), 0),
			1, now(), now()
		FROM target_folder
		WHERE COALESCE((
			SELECT SUM(octet_length(content) + octet_length(title) + octet_length(cover_image_source) + octet_length(cover_prompt))
			FROM documents WHERE user_id = $2
		), 0) + COALESCE((
			SELECT SUM(bytes) FROM image_objects
			WHERE user_id = $2 AND purpose = 'persistent'
		), 0) + octet_length($5::text) + octet_length($3::text) + octet_length($9::text) + octet_length($10::text) <= $11
		ON CONFLICT (doc_id) DO NOTHING
		RETURNING doc_id, title, theme, content, cover_mode, cover_ratio, cover_image_source, cover_prompt, revision, created_at, updated_at
	`, docID, params.User.ID, params.Title, theme, params.Content, derefOrEmpty(params.FolderID), coverMode, coverRatio, coverImageSource, coverPrompt, a.storageQuotaFor(params.User)).Scan(
		&doc.DocID, &doc.Title, &doc.Theme, &doc.Content, &doc.CoverMode, &doc.CoverRatio, &doc.CoverImageSource, &doc.CoverPrompt, &doc.Revision, &doc.CreatedAt, &doc.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		if params.DocID != "" {
			var existing model.Document
			var folderID string
			lookupErr := tx.QueryRow(ctx, `
				SELECT d.doc_id, d.title, d.theme, d.content, d.cover_mode, d.cover_ratio, d.cover_image_source, d.cover_prompt, d.revision,
				       d.created_at, d.updated_at, COALESCE(f.folder_id, '')
				FROM documents d
				LEFT JOIN folders f ON f.id = d.folder_id
				WHERE d.doc_id = $1 AND d.user_id = $2 AND d.trashed_at IS NULL
			`, docID, params.User.ID).Scan(
				&existing.DocID, &existing.Title, &existing.Theme, &existing.Content,
				&existing.CoverMode, &existing.CoverRatio, &existing.CoverImageSource, &existing.CoverPrompt,
				&existing.Revision, &existing.CreatedAt, &existing.UpdatedAt, &folderID,
			)
			if lookupErr == nil && existing.Title == params.Title && existing.Theme == theme &&
				existing.Content == params.Content && existing.CoverMode == coverMode && existing.CoverRatio == coverRatio && existing.CoverImageSource == coverImageSource && existing.CoverPrompt == coverPrompt && folderID == derefOrEmpty(params.FolderID) {
				return existing, nil
			}
			if lookupErr == nil || errors.Is(lookupErr, pgx.ErrNoRows) {
				if lookupErr == nil {
					return model.Document{}, errDocumentIDConflict
				}
				return model.Document{}, errDocumentQuotaExceeded
			}
			return model.Document{}, lookupErr
		}
		return model.Document{}, errDocumentQuotaExceeded
	}
	if err != nil {
		return model.Document{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return model.Document{}, err
	}

	a.recordProductMilestone(ctx, params.User.ID, milestoneFirstDocument)
	a.cancelPendingImageDeletions(ctx, userRef{ID: params.User.ID, AuthUserID: params.User.AuthUserID}, params.Content)
	return doc, nil
}

func (a *App) updateDocument(ctx context.Context, params updateDocumentParams) (model.Document, error) {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return model.Document{}, err
	}
	defer tx.Rollback(ctx)

	result, err := a.updateDocumentTx(ctx, tx, params)
	if err != nil {
		return model.Document{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return model.Document{}, err
	}
	a.finishDocumentUpdate(ctx, params.User, result)
	return result.Document, nil
}

func (a *App) updateDocumentTx(ctx context.Context, tx pgx.Tx, params updateDocumentParams) (documentUpdateResult, error) {
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, params.User.ID); err != nil {
		return documentUpdateResult{}, err
	}

	var previous storedDocument
	err := tx.QueryRow(ctx, `
		SELECT id, doc_id, title, theme, content, cover_mode, cover_ratio, cover_image_source, cover_prompt, revision, created_at, updated_at,
		       last_web_version_at
		FROM documents
		WHERE doc_id = $1 AND user_id = $2 AND trashed_at IS NULL
		FOR UPDATE
	`, params.DocID, params.User.ID).Scan(
		&previous.ID, &previous.Doc.DocID, &previous.Doc.Title, &previous.Doc.Theme,
		&previous.Doc.Content, &previous.Doc.CoverMode, &previous.Doc.CoverRatio, &previous.Doc.CoverImageSource, &previous.Doc.CoverPrompt, &previous.Doc.Revision, &previous.Doc.CreatedAt,
		&previous.Doc.UpdatedAt, &previous.LastWebVersionAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return documentUpdateResult{}, errDocumentNotFound
	}
	if err != nil {
		return documentUpdateResult{}, err
	}
	coverMode, coverRatio, coverImageSource, coverPrompt := documentCoverValues(previous.Doc, params)
	if !validDocumentCoverValues(coverMode, coverRatio, coverImageSource, coverPrompt) {
		return documentUpdateResult{}, errDocumentCoverInvalid
	}
	if previous.Doc.Revision != params.ExpectedRevision {
		if previous.Doc.Title == params.Title && previous.Doc.Theme == params.Theme && previous.Doc.Content == params.Content &&
			previous.Doc.CoverMode == coverMode && previous.Doc.CoverRatio == coverRatio && previous.Doc.CoverImageSource == coverImageSource && previous.Doc.CoverPrompt == coverPrompt {
			return documentUpdateResult{Document: previous.Doc}, nil
		}
		return documentUpdateResult{}, errDocumentRevisionConflict
	}
	if previous.Doc.Title == params.Title && previous.Doc.Theme == params.Theme && previous.Doc.Content == params.Content &&
		previous.Doc.CoverMode == coverMode && previous.Doc.CoverRatio == coverRatio && previous.Doc.CoverImageSource == coverImageSource && previous.Doc.CoverPrompt == coverPrompt {
		return documentUpdateResult{Document: previous.Doc}, nil
	}

	oldBytes := len(previous.Doc.Title) + len(previous.Doc.Content) + len(previous.Doc.CoverImageSource) + len(previous.Doc.CoverPrompt)
	newBytes := len(params.Title) + len(params.Content) + len(coverImageSource) + len(coverPrompt)
	if newBytes > oldBytes {
		var fits bool
		if err := tx.QueryRow(ctx, `
			SELECT COALESCE((
				SELECT SUM(octet_length(content) + octet_length(title) + octet_length(cover_image_source) + octet_length(cover_prompt))
				FROM documents WHERE user_id = $1 AND id <> $2
			), 0) + COALESCE((
				SELECT SUM(bytes) FROM image_objects
				WHERE user_id = $1 AND purpose = 'persistent'
			), 0) + $3::bigint <= $4::bigint
		`, params.User.ID, previous.ID, newBytes, a.storageQuotaFor(params.User)).Scan(&fits); err != nil {
			return documentUpdateResult{}, err
		}
		if !fits {
			return documentUpdateResult{}, errDocumentQuotaExceeded
		}
	}

	contentChanged := previous.Doc.Title != params.Title ||
		previous.Doc.Theme != params.Theme || previous.Doc.Content != params.Content
	historySettings, err := loadDocumentHistorySettings(ctx, tx, params.User.ID, params.User.MembershipTier)
	if err != nil {
		return documentUpdateResult{}, err
	}
	versionMode := documentVersionModeForMutation(
		historySettings, params.Source, params.SourceTokenID != nil,
		previous.LastWebVersionAt, time.Now(), params.ForceVersion,
	)
	storeVersion := contentChanged && versionMode != documentVersionNone
	var prunedContents []string
	if contentChanged && (isMCPDocumentMutation(params.Source, params.SourceTokenID != nil) || versionMode == documentVersionFull) {
		rows, err := tx.Query(ctx, `
			DELETE FROM document_versions
			WHERE document_id = $1 AND safety_snapshot
			RETURNING content
		`, previous.ID)
		if err != nil {
			return documentUpdateResult{}, err
		}
		for rows.Next() {
			var content string
			if err := rows.Scan(&content); err != nil {
				rows.Close()
				return documentUpdateResult{}, err
			}
			prunedContents = append(prunedContents, content)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return documentUpdateResult{}, err
		}
		rows.Close()
	}
	if storeVersion {
		if _, err := tx.Exec(ctx, `
			INSERT INTO document_versions (
				document_id, revision, title, theme, content, source, source_token_id,
				safety_snapshot
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
			ON CONFLICT (document_id, revision) DO NOTHING
		`, previous.ID, previous.Doc.Revision, previous.Doc.Title, previous.Doc.Theme,
			previous.Doc.Content, string(params.Source), params.SourceTokenID,
			versionMode == documentVersionSafety); err != nil {
			return documentUpdateResult{}, err
		}
	}

	var doc model.Document
	err = tx.QueryRow(ctx, `
		UPDATE documents
		SET title = $3, theme = $4, content = $5,
		    cover_mode = $9, cover_ratio = $10, cover_image_source = $11, cover_prompt = $12,
		    revision = revision + 1,
		    updated_at = now(),
		    last_web_version_at = CASE
		        WHEN $6 THEN now()
		        WHEN $8 THEN NULL
		        ELSE last_web_version_at
		    END
		WHERE id = $1 AND user_id = $2 AND revision = $7 AND trashed_at IS NULL
		RETURNING doc_id, title, theme, content, cover_mode, cover_ratio, cover_image_source, cover_prompt, revision, created_at, updated_at
	`, previous.ID, params.User.ID, params.Title, params.Theme, params.Content,
		storeVersion && params.Source == documentSourceWeb, params.ExpectedRevision,
		params.Source != documentSourceWeb, coverMode, coverRatio, coverImageSource, coverPrompt).Scan(
		&doc.DocID, &doc.Title, &doc.Theme, &doc.Content, &doc.CoverMode, &doc.CoverRatio, &doc.CoverImageSource, &doc.CoverPrompt, &doc.Revision, &doc.CreatedAt, &doc.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return documentUpdateResult{}, errDocumentRevisionConflict
	}
	if err != nil {
		return documentUpdateResult{}, err
	}

	if storeVersion {
		rows, err := tx.Query(ctx, `
			DELETE FROM document_versions
			WHERE id IN (
				SELECT id FROM document_versions
				WHERE document_id = $1
				ORDER BY revision DESC
				OFFSET $2
			)
			OR id IN (
				SELECT v.id
				FROM document_versions v
				JOIN documents d ON d.id = v.document_id
				WHERE d.user_id = $3
				ORDER BY v.created_at DESC, v.id DESC
				OFFSET $4
			)
			RETURNING content
		`, previous.ID, historySettings.PerDocumentMax, params.User.ID,
			userDocumentVersionLimit)
		if err != nil {
			return documentUpdateResult{}, err
		}
		for rows.Next() {
			var content string
			if err := rows.Scan(&content); err != nil {
				rows.Close()
				return documentUpdateResult{}, err
			}
			prunedContents = append(prunedContents, content)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return documentUpdateResult{}, err
		}
		rows.Close()
	}

	return documentUpdateResult{
		Document:                 doc,
		PreviousContent:          previous.Doc.Content,
		PrunedContents:           prunedContents,
		ContentChanged:           previous.Doc.Content != params.Content,
		PreviousCoverImageSource: previous.Doc.CoverImageSource,
		CoverChanged:             previous.Doc.CoverMode != doc.CoverMode || previous.Doc.CoverRatio != doc.CoverRatio || previous.Doc.CoverImageSource != doc.CoverImageSource || previous.Doc.CoverPrompt != doc.CoverPrompt,
	}, nil
}

func (a *App) finishDocumentUpdate(ctx context.Context, user model.User, result documentUpdateResult) {
	if !result.ContentChanged && !result.CoverChanged && len(result.PrunedContents) == 0 {
		return
	}
	gcCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	ref := userRef{ID: user.ID, AuthUserID: user.AuthUserID}
	if result.ContentChanged {
		a.cancelPendingImageDeletions(gcCtx, ref, result.Document.Content)
		a.enqueueOrphanedImages(gcCtx, ref, result.PreviousContent)
	}
	if result.CoverChanged {
		a.cancelPendingImageDeletions(gcCtx, ref, result.Document.CoverImageSource)
		a.enqueueOrphanedImages(gcCtx, ref, result.PreviousCoverImageSource)
	}
	if len(result.PrunedContents) > 0 {
		a.enqueueOrphanedImages(gcCtx, ref, strings.Join(result.PrunedContents, "\n"))
	}
}

type documentVersionMode int

const (
	documentVersionNone documentVersionMode = iota
	documentVersionFull
	documentVersionSafety
)

func documentVersionModeForMutation(settings documentHistorySettings, source documentMutationSource, mcpWrite bool, lastWebVersionAt *time.Time, now time.Time, force bool) documentVersionMode {
	if !settings.Available {
		return documentVersionNone
	}
	// Applying an Agent suggestion is an explicit, user-approved commit. Always
	// retain its previous state so every accepted change remains reversible,
	// even when routine history snapshots are disabled.
	if source == documentSourceAgent {
		return documentVersionFull
	}
	if isMCPDocumentMutation(source, mcpWrite) && (!settings.Enabled || !settings.MCPEnabled) {
		return documentVersionSafety
	}
	if !settings.Enabled {
		return documentVersionNone
	}
	if force {
		return documentVersionFull
	}
	if source != documentSourceWeb {
		return documentVersionFull
	}
	if lastWebVersionAt == nil || now.Sub(*lastWebVersionAt) >= webVersionSnapshotInterval {
		return documentVersionFull
	}
	return documentVersionNone
}

func isMCPDocumentMutation(source documentMutationSource, mcpWrite bool) bool {
	return mcpWrite || source == documentSourceMCP
}
