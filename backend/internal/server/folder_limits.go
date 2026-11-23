package server

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"koinote/backend/internal/config"
)

var errFolderCountLimit = errors.New("folder count limit reached; delete unneeded folders and retry")

func (a *App) folderCountLimit() int {
	if a.cfg.FolderCountLimit > 0 {
		return a.cfg.FolderCountLimit
	}
	return config.DefaultFolderCountLimit
}

// Every folder insertion, including organizer/AI operations and undo, goes
// through this transaction boundary. The user lock serializes the count check.
// Existing public IDs may be replayed at the limit without spending a new slot.
func (a *App) admitFolderCreate(ctx context.Context, tx pgx.Tx, userID int, folderID string) error {
	ctx, cancel := context.WithTimeout(ctx, documentCreateTimeout)
	defer cancel()
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, userID); err != nil {
		return err
	}
	var exists bool
	if err := tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM folders WHERE user_id=$1 AND folder_id=$2)`, userID, folderID).Scan(&exists); err != nil {
		return err
	}
	if exists {
		return nil
	}
	if err := a.takeDocumentCreateAttempt(userID); err != nil {
		return err
	}
	var count int
	if err := tx.QueryRow(ctx, `SELECT count(*) FROM (SELECT 1 FROM folders WHERE user_id=$1 LIMIT $2) counted`, userID, a.folderCountLimit()).Scan(&count); err != nil {
		return err
	}
	if count >= a.folderCountLimit() {
		return errFolderCountLimit
	}
	return nil
}
