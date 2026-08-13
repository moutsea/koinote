package server

import (
	"context"
	"errors"
	"log"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"koinote/backend/internal/model"
)

const (
	documentTrashRetention       = 30 * 24 * time.Hour
	documentTrashCleanupInterval = time.Hour
	documentTrashCleanupBatch    = 50
)

type trashedDocument struct {
	DocID     string
	Title     string
	Revision  int64
	TrashedAt time.Time
}

func (a *App) trashDocument(ctx context.Context, user model.User, docID string, expectedRevision int64) (trashedDocument, error) {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return trashedDocument{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, user.ID); err != nil {
		return trashedDocument{}, err
	}
	var out trashedDocument
	err = tx.QueryRow(ctx, `
		UPDATE documents
		SET trashed_at = now(), revision = revision + 1, updated_at = now()
		WHERE doc_id = $1 AND user_id = $2 AND trashed_at IS NULL
		  AND ($3::bigint <= 0 OR revision = $3)
		RETURNING doc_id, title, revision, trashed_at
	`, strings.TrimSpace(docID), user.ID, expectedRevision).Scan(
		&out.DocID, &out.Title, &out.Revision, &out.TrashedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		if expectedRevision > 0 {
			var exists bool
			if lookupErr := tx.QueryRow(ctx, `
				SELECT EXISTS (
					SELECT 1 FROM documents
					WHERE doc_id = $1 AND user_id = $2 AND trashed_at IS NULL
				)
			`, strings.TrimSpace(docID), user.ID).Scan(&exists); lookupErr != nil {
				return trashedDocument{}, lookupErr
			}
			if exists {
				return trashedDocument{}, errDocumentRevisionConflict
			}
		}
		return trashedDocument{}, errDocumentNotFound
	}
	if err != nil {
		return trashedDocument{}, err
	}
	if _, err := tx.Exec(ctx, `DELETE FROM editor_tabs WHERE user_id = $1 AND doc_id = $2`, user.ID, out.DocID); err != nil {
		return trashedDocument{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return trashedDocument{}, err
	}
	return out, nil
}

func (a *App) restoreTrashedDocument(ctx context.Context, user model.User, docID string, expectedRevision int64) (model.Document, error) {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return model.Document{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, user.ID); err != nil {
		return model.Document{}, err
	}
	var doc model.Document
	err = tx.QueryRow(ctx, `
		UPDATE documents
		SET trashed_at = NULL, revision = revision + 1, updated_at = now()
		WHERE doc_id = $1 AND user_id = $2 AND trashed_at IS NOT NULL
		  AND ($3::bigint <= 0 OR revision = $3)
		RETURNING doc_id, title, theme, content, revision, created_at, updated_at
	`, strings.TrimSpace(docID), user.ID, expectedRevision).Scan(
		&doc.DocID, &doc.Title, &doc.Theme, &doc.Content, &doc.Revision,
		&doc.CreatedAt, &doc.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		if expectedRevision > 0 {
			var trashed bool
			if lookupErr := tx.QueryRow(ctx, `
				SELECT EXISTS (
					SELECT 1 FROM documents
					WHERE doc_id = $1 AND user_id = $2 AND trashed_at IS NOT NULL
				)
			`, strings.TrimSpace(docID), user.ID).Scan(&trashed); lookupErr != nil {
				return model.Document{}, lookupErr
			}
			if trashed {
				return model.Document{}, errDocumentRevisionConflict
			}
		}
		return model.Document{}, errDocumentNotTrashed
	}
	if err != nil {
		return model.Document{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return model.Document{}, err
	}
	return doc, nil
}

func (a *App) purgeDocument(ctx context.Context, user userRef, docID, confirmation string, requireConfirmation, requireExpired bool) error {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, user.ID); err != nil {
		return err
	}

	var documentID int
	var title string
	err = tx.QueryRow(ctx, `
		SELECT id, title
		FROM documents
		WHERE doc_id = $1 AND user_id = $2 AND trashed_at IS NOT NULL
		  AND (NOT $3::boolean OR trashed_at < now() - interval '30 days')
		FOR UPDATE
	`, strings.TrimSpace(docID), user.ID, requireExpired).Scan(&documentID, &title)
	if errors.Is(err, pgx.ErrNoRows) {
		return errDocumentNotTrashed
	}
	if err != nil {
		return err
	}
	if requireConfirmation {
		expected := title
		if expected == "" {
			expected = "DELETE"
		}
		if confirmation != expected {
			return errDocumentPurgeConfirmation
		}
	}

	rows, err := tx.Query(ctx, `
		WITH document_contents AS (
			SELECT content FROM documents WHERE id = $1
			UNION ALL
			SELECT content FROM document_versions WHERE document_id = $1
		)
		SELECT DISTINCT 'u/' || matches[1] || '/' || matches[2] || '.' || matches[3]
		FROM document_contents
		CROSS JOIN LATERAL regexp_matches(content, $2, 'g') AS matches
		WHERE matches[1] = $3
	`, documentID, imageKeyPattern.String(), user.AuthUserID)
	if err != nil {
		return err
	}
	imageKeys := make([]string, 0)
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			rows.Close()
			return err
		}
		imageKeys = append(imageKeys, key)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	if _, err := tx.Exec(ctx, `DELETE FROM documents WHERE id = $1`, documentID); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return err
	}

	gcCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	a.enqueueOrphanedImageKeys(gcCtx, user, imageKeys)
	return nil
}

func (a *App) purgeExpiredTrashedDocuments(ctx context.Context) error {
	rows, err := a.db.Query(ctx, `
		SELECT d.doc_id, u.id, u.auth_user_id
		FROM documents d
		JOIN users u ON u.id = d.user_id
		WHERE d.trashed_at < now() - interval '30 days'
		ORDER BY d.trashed_at
		LIMIT $1
	`, documentTrashCleanupBatch)
	if err != nil {
		return err
	}
	type expiredDocument struct {
		docID      string
		userID     int
		authUserID string
	}
	items := make([]expiredDocument, 0, documentTrashCleanupBatch)
	for rows.Next() {
		var item expiredDocument
		if err := rows.Scan(&item.docID, &item.userID, &item.authUserID); err != nil {
			rows.Close()
			return err
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()

	for _, item := range items {
		err := a.purgeDocument(ctx, userRef{ID: item.userID, AuthUserID: item.authUserID}, item.docID, "", false, true)
		if err != nil && !errors.Is(err, errDocumentNotTrashed) {
			log.Printf("document trash cleanup %s: %v", item.docID, err)
		}
	}
	return nil
}

func (a *App) StartDocumentTrashCleanup(ctx context.Context) {
	go func() {
		if err := a.purgeExpiredTrashedDocuments(ctx); err != nil && ctx.Err() == nil {
			log.Printf("document trash cleanup: %v", err)
		}
		ticker := time.NewTicker(documentTrashCleanupInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := a.purgeExpiredTrashedDocuments(ctx); err != nil && ctx.Err() == nil {
					log.Printf("document trash cleanup: %v", err)
				}
			}
		}
	}()
}
