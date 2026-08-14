package server

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"koinote/backend/internal/model"
)

const (
	webVersionSnapshotInterval = 5 * time.Minute
)

var (
	errDocumentNotFound          = errors.New("document not found")
	errDocumentIDConflict        = errors.New("document id conflict")
	errDocumentQuotaExceeded     = errors.New("document storage quota exceeded")
	errDocumentRevisionConflict  = errors.New("document revision conflict")
	errDocumentVersionNotFound   = errors.New("document version not found")
	errDocumentNotTrashed        = errors.New("document is not in trash")
	errDocumentPurgeConfirmation = errors.New("document purge confirmation does not match")
)

type documentMutationSource string

const (
	documentSourceWeb     documentMutationSource = "web"
	documentSourceMCP     documentMutationSource = "mcp"
	documentSourceRestore documentMutationSource = "restore"
)

type createDocumentParams struct {
	User     model.User
	DocID    string
	Title    string
	Theme    *string
	Content  string
	FolderID *string
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
}

type storedDocument struct {
	ID               int
	Doc              model.Document
	LastWebVersionAt *time.Time
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
		INSERT INTO documents (
			doc_id, user_id, title, theme, content, folder_id, revision, created_at, updated_at
		)
		SELECT
			$1, $2, $3::text, $4::text, $5::text,
			CASE
				WHEN $6 = '' THEN NULL
				ELSE (SELECT id FROM folders WHERE folder_id = $6 AND user_id = $2)
			END,
			1, now(), now()
		WHERE COALESCE((
			SELECT SUM(octet_length(content) + octet_length(title))
			FROM documents WHERE user_id = $2
		), 0) + COALESCE((
			SELECT SUM(bytes) FROM image_objects
			WHERE user_id = $2 AND purpose = 'persistent'
		), 0) + octet_length($5::text) + octet_length($3::text) <= $7
		ON CONFLICT (doc_id) DO NOTHING
		RETURNING doc_id, title, theme, content, revision, created_at, updated_at
	`, docID, params.User.ID, params.Title, theme, params.Content, derefOrEmpty(params.FolderID), a.storageQuotaFor(params.User)).Scan(
		&doc.DocID, &doc.Title, &doc.Theme, &doc.Content, &doc.Revision, &doc.CreatedAt, &doc.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		if params.DocID != "" {
			var existing model.Document
			var folderID string
			lookupErr := tx.QueryRow(ctx, `
				SELECT d.doc_id, d.title, d.theme, d.content, d.revision,
				       d.created_at, d.updated_at, COALESCE(f.folder_id, '')
				FROM documents d
				LEFT JOIN folders f ON f.id = d.folder_id
				WHERE d.doc_id = $1 AND d.user_id = $2 AND d.trashed_at IS NULL
			`, docID, params.User.ID).Scan(
				&existing.DocID, &existing.Title, &existing.Theme, &existing.Content,
				&existing.Revision, &existing.CreatedAt, &existing.UpdatedAt, &folderID,
			)
			if lookupErr == nil && existing.Title == params.Title && existing.Theme == theme &&
				existing.Content == params.Content && folderID == derefOrEmpty(params.FolderID) {
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

	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, params.User.ID); err != nil {
		return model.Document{}, err
	}

	var previous storedDocument
	err = tx.QueryRow(ctx, `
		SELECT id, doc_id, title, theme, content, revision, created_at, updated_at,
		       last_web_version_at
		FROM documents
		WHERE doc_id = $1 AND user_id = $2 AND trashed_at IS NULL
		FOR UPDATE
	`, params.DocID, params.User.ID).Scan(
		&previous.ID, &previous.Doc.DocID, &previous.Doc.Title, &previous.Doc.Theme,
		&previous.Doc.Content, &previous.Doc.Revision, &previous.Doc.CreatedAt,
		&previous.Doc.UpdatedAt, &previous.LastWebVersionAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return model.Document{}, errDocumentNotFound
	}
	if err != nil {
		return model.Document{}, err
	}
	if previous.Doc.Revision != params.ExpectedRevision {
		if previous.Doc.Title == params.Title && previous.Doc.Theme == params.Theme && previous.Doc.Content == params.Content {
			return previous.Doc, nil
		}
		return model.Document{}, errDocumentRevisionConflict
	}
	if previous.Doc.Title == params.Title && previous.Doc.Theme == params.Theme && previous.Doc.Content == params.Content {
		return previous.Doc, nil
	}

	oldBytes := len(previous.Doc.Title) + len(previous.Doc.Content)
	newBytes := len(params.Title) + len(params.Content)
	if newBytes > oldBytes {
		var fits bool
		if err := tx.QueryRow(ctx, `
			SELECT COALESCE((
				SELECT SUM(octet_length(content) + octet_length(title))
				FROM documents WHERE user_id = $1 AND id <> $2
			), 0) + COALESCE((
				SELECT SUM(bytes) FROM image_objects
				WHERE user_id = $1 AND purpose = 'persistent'
			), 0) + $3::bigint <= $4::bigint
		`, params.User.ID, previous.ID, newBytes, a.storageQuotaFor(params.User)).Scan(&fits); err != nil {
			return model.Document{}, err
		}
		if !fits {
			return model.Document{}, errDocumentQuotaExceeded
		}
	}

	contentChanged := previous.Doc.Title != params.Title ||
		previous.Doc.Theme != params.Theme || previous.Doc.Content != params.Content
	historySettings, err := loadDocumentHistorySettings(ctx, tx, params.User.ID, params.User.MembershipTier)
	if err != nil {
		return model.Document{}, err
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
			return model.Document{}, err
		}
		for rows.Next() {
			var content string
			if err := rows.Scan(&content); err != nil {
				rows.Close()
				return model.Document{}, err
			}
			prunedContents = append(prunedContents, content)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return model.Document{}, err
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
			return model.Document{}, err
		}
	}

	var doc model.Document
	err = tx.QueryRow(ctx, `
		UPDATE documents
		SET title = $3, theme = $4, content = $5,
		    revision = revision + 1,
		    updated_at = now(),
		    last_web_version_at = CASE
		        WHEN $6 THEN now()
		        WHEN $8 THEN NULL
		        ELSE last_web_version_at
		    END
		WHERE id = $1 AND user_id = $2 AND revision = $7 AND trashed_at IS NULL
		RETURNING doc_id, title, theme, content, revision, created_at, updated_at
	`, previous.ID, params.User.ID, params.Title, params.Theme, params.Content,
		storeVersion && params.Source == documentSourceWeb, params.ExpectedRevision,
		params.Source != documentSourceWeb).Scan(
		&doc.DocID, &doc.Title, &doc.Theme, &doc.Content, &doc.Revision, &doc.CreatedAt, &doc.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return model.Document{}, errDocumentRevisionConflict
	}
	if err != nil {
		return model.Document{}, err
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
			return model.Document{}, err
		}
		for rows.Next() {
			var content string
			if err := rows.Scan(&content); err != nil {
				rows.Close()
				return model.Document{}, err
			}
			prunedContents = append(prunedContents, content)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return model.Document{}, err
		}
		rows.Close()
	}

	if err := tx.Commit(ctx); err != nil {
		return model.Document{}, err
	}

	if previous.Doc.Content != params.Content || len(prunedContents) > 0 {
		gcCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		ref := userRef{ID: params.User.ID, AuthUserID: params.User.AuthUserID}
		if previous.Doc.Content != params.Content {
			a.cancelPendingImageDeletions(gcCtx, ref, params.Content)
			a.enqueueOrphanedImages(gcCtx, ref, previous.Doc.Content)
		}
		if len(prunedContents) > 0 {
			a.enqueueOrphanedImages(gcCtx, ref, strings.Join(prunedContents, "\n"))
		}
	}
	return doc, nil
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
