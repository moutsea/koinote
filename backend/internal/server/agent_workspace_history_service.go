package server

import (
	"context"
	"encoding/base64"
	"errors"

	"github.com/jackc/pgx/v5"
)

const agentWorkspaceHistoryPageSize = 25

var (
	errAgentWorkspaceRevisionNotFound = errors.New("agent workspace revision not found or no longer retained; list history again")
	errAgentWorkspaceFileNotFound     = errors.New("agent workspace file not found; refresh the file manifest")
	errAgentWorkspaceFileRange        = errors.New("offset exceeds file size")
)

// Called under the same user lock and transaction as restore, before any mutation.
func checkAgentWorkspaceRestoreContent(ctx context.Context, tx pgx.Tx, workspaceID, revision int64) error {
	rows, err := tx.Query(ctx, `SELECT f.path, b.content
 FROM agent_workspace_commit_files f JOIN agent_workspace_blobs b USING (workspace_id, sha256)
 WHERE f.workspace_id = $1 AND f.revision = $2`, workspaceID, revision)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var path string
		var content []byte
		if err := rows.Scan(&path, &content); err != nil {
			return err
		}
		if agentWorkspaceSensitiveContent(content) {
			return &agentWorkspaceSensitiveError{Path: path}
		}
	}
	return rows.Err()
}

// Only disclose a missing revision after confirming ownership of a live repository.
func checkAgentWorkspaceRevision(ctx context.Context, q imageUsageQuerier, userID int, workspaceID, revision int64) error {
	var workspaceExists, revisionExists bool
	err := q.QueryRow(ctx, `SELECT
 EXISTS (SELECT 1 FROM agent_workspaces WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL),
 EXISTS (SELECT 1 FROM agent_workspace_commits WHERE workspace_id = $1 AND revision = $3)`, workspaceID, userID, revision).Scan(&workspaceExists, &revisionExists)
	if err != nil {
		return err
	}
	if !workspaceExists {
		return errAgentWorkspaceNotFound
	}
	if !revisionExists {
		return errAgentWorkspaceRevisionNotFound
	}
	return nil
}

type agentWorkspaceCommitPage struct {
	Commits    []agentWorkspaceCommit `json:"commits"`
	NextBefore *int64                 `json:"nextBefore"`
}

type agentWorkspaceCommitView struct {
	Commit agentWorkspaceCommit       `json:"commit"`
	Files  []agentWorkspaceCommitFile `json:"files"`
}

type agentWorkspaceCommitFileContent struct {
	agentWorkspaceCommitFile
	ContentBase64 string `json:"contentBase64"`
}

func (a *App) listAgentWorkspaceCommits(ctx context.Context, userID int, workspaceID int64, before *int64) (agentWorkspaceCommitPage, error) {
	var exists bool
	if err := a.db.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM agent_workspaces WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL)`, workspaceID, userID).Scan(&exists); err != nil {
		return agentWorkspaceCommitPage{}, err
	}
	if !exists {
		return agentWorkspaceCommitPage{}, errAgentWorkspaceNotFound
	}
	rows, err := a.db.Query(ctx, `
		SELECT c.commit_id, c.revision, c.parent_revision, c.action, c.restored_from,
		       c.name, c.description, c.file_count, c.size_bytes, c.created_at
		FROM agent_workspace_commits c JOIN agent_workspaces w ON w.id = c.workspace_id
		WHERE w.id = $1 AND w.user_id = $2 AND w.deleted_at IS NULL
		  AND ($3::bigint IS NULL OR c.revision < $3)
		ORDER BY c.revision DESC LIMIT $4
	`, workspaceID, userID, before, agentWorkspaceHistoryPageSize+1)
	if err != nil {
		return agentWorkspaceCommitPage{}, err
	}
	defer rows.Close()
	commits := []agentWorkspaceCommit{}
	for rows.Next() {
		commit, err := scanAgentWorkspaceCommit(rows)
		if err != nil {
			return agentWorkspaceCommitPage{}, err
		}
		commits = append(commits, commit)
	}
	if err := rows.Err(); err != nil {
		return agentWorkspaceCommitPage{}, err
	}
	var nextBefore *int64
	if len(commits) > agentWorkspaceHistoryPageSize {
		commits = commits[:agentWorkspaceHistoryPageSize]
		nextBefore = &commits[agentWorkspaceHistoryPageSize-1].Revision
	}
	return agentWorkspaceCommitPage{Commits: commits, NextBefore: nextBefore}, nil
}

func (a *App) loadAgentWorkspaceCommit(ctx context.Context, userID int, workspaceID, revision int64) (agentWorkspaceCommitView, error) {
	// Keep metadata and its file manifest in the same snapshot while another
	// client writes or prunes retained history.
	tx, err := a.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return agentWorkspaceCommitView{}, err
	}
	defer tx.Rollback(ctx)
	if err := checkAgentWorkspaceRevision(ctx, tx, userID, workspaceID, revision); err != nil {
		return agentWorkspaceCommitView{}, err
	}
	commit, err := scanAgentWorkspaceCommit(tx.QueryRow(ctx, `
		SELECT c.commit_id, c.revision, c.parent_revision, c.action, c.restored_from,
		       c.name, c.description, c.file_count, c.size_bytes, c.created_at
		FROM agent_workspace_commits c JOIN agent_workspaces w ON w.id = c.workspace_id
		WHERE w.id = $1 AND w.user_id = $2 AND c.revision = $3 AND w.deleted_at IS NULL
	`, workspaceID, userID, revision))
	if err != nil {
		return agentWorkspaceCommitView{}, err
	}
	rows, err := tx.Query(ctx, `
		SELECT path, mime_type, size_bytes, sha256 FROM agent_workspace_commit_files
		WHERE workspace_id = $1 AND revision = $2 ORDER BY path
	`, workspaceID, revision)
	if err != nil {
		return agentWorkspaceCommitView{}, err
	}
	defer rows.Close()
	files := []agentWorkspaceCommitFile{}
	for rows.Next() {
		var file agentWorkspaceCommitFile
		if err := rows.Scan(&file.Path, &file.MimeType, &file.SizeBytes, &file.SHA256); err != nil {
			return agentWorkspaceCommitView{}, err
		}
		files = append(files, file)
	}
	if err := rows.Err(); err != nil {
		return agentWorkspaceCommitView{}, err
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return agentWorkspaceCommitView{}, err
	}
	return agentWorkspaceCommitView{Commit: commit, Files: files}, nil
}

func (a *App) loadAgentWorkspaceCommitFile(ctx context.Context, userID int, workspaceID, revision int64, path string) (agentWorkspaceCommitFileContent, error) {
	return a.loadAgentWorkspaceCommitFileRange(ctx, userID, workspaceID, revision, path, 0, agentWorkspaceMaxFileBytes)
}

func (a *App) loadAgentWorkspaceCommitFileRange(ctx context.Context, userID int, workspaceID, revision int64, path string, offset int64, limit int) (agentWorkspaceCommitFileContent, error) {
	tx, err := a.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return agentWorkspaceCommitFileContent{}, err
	}
	defer tx.Rollback(ctx)
	if err := checkAgentWorkspaceRevision(ctx, tx, userID, workspaceID, revision); err != nil {
		return agentWorkspaceCommitFileContent{}, err
	}
	var file agentWorkspaceCommitFileContent
	var content []byte
	err = tx.QueryRow(ctx, `
		SELECT f.path, f.mime_type, f.size_bytes, f.sha256, substring(b.content FROM $5::int FOR $6::int)
		FROM agent_workspace_commit_files f JOIN agent_workspace_blobs b USING (workspace_id, sha256)
		JOIN agent_workspaces w ON w.id = f.workspace_id
		WHERE w.id = $1 AND w.user_id = $2 AND f.revision = $3 AND f.path = $4 AND w.deleted_at IS NULL
	`, workspaceID, userID, revision, path, offset+1, limit).Scan(&file.Path, &file.MimeType, &file.SizeBytes, &file.SHA256, &content)
	if errors.Is(err, pgx.ErrNoRows) {
		err = errAgentWorkspaceFileNotFound
	}
	if err != nil {
		return agentWorkspaceCommitFileContent{}, err
	}
	if offset > file.SizeBytes {
		return agentWorkspaceCommitFileContent{}, errAgentWorkspaceFileRange
	}
	if err := tx.Commit(ctx); err != nil {
		return agentWorkspaceCommitFileContent{}, err
	}
	file.ContentBase64 = base64.StdEncoding.EncodeToString(content)
	return file, nil
}
