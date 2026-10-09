package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type agentRepositoryContentScans struct {
	policy    string
	hashes    []string
	sensitive []bool
}

func (scans agentRepositoryContentScans) save(ctx context.Context, q interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}, workspaceID int64) error {
	if len(scans.hashes) == 0 {
		return nil
	}
	// Updating only metadata preserves PostgreSQL's existing TOAST content.
	// A concurrently pruned blob simply has no cache entry to update.
	_, err := q.Exec(ctx, `UPDATE agent_workspace_blobs b
 SET content_scan_policy=$2, content_scan_sensitive=scans.sensitive
 FROM unnest($3::text[],$4::boolean[]) AS scans(sha256,sensitive)
 WHERE b.workspace_id=$1 AND b.sha256=scans.sha256
 AND (b.content_scan_policy,b.content_scan_sensitive) IS DISTINCT FROM ($2::text,scans.sensitive)`, workspaceID, scans.policy, scans.hashes, scans.sensitive)
	return err
}

// The read-only snapshot does not lock out writes. Its revision must still be
// rechecked by the publication transaction after scanning and caching finish.
func (a *App) checkAgentRepositoryPublication(ctx context.Context, userID int, id, revision int64) (agentRepositoryContentScans, error) {
	scans := agentRepositoryContentScans{policy: agentWorkspaceSensitivePolicyID()}
	tx, err := a.db.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if err != nil {
		return scans, err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	var current int64
	var name, description string
	err = tx.QueryRow(ctx, `SELECT revision,name,description FROM agent_workspaces WHERE id=$1 AND user_id=$2 AND deleted_at IS NULL`, id, userID).Scan(&current, &name, &description)
	if errors.Is(err, pgx.ErrNoRows) {
		return scans, errAgentWorkspaceNotFound
	}
	if err != nil {
		return scans, err
	}
	if current != revision {
		return scans, errAgentWorkspaceConflict
	}
	if agentWorkspaceSensitiveContent([]byte(name + "\n" + description)) {
		return scans, &agentWorkspaceSensitiveError{Path: "repository metadata"}
	}
	// This query never fetches content, including on cache hits. Path checks are
	// deliberately separate: identical bytes can be safe at one path, unsafe at another.
	rows, err := tx.Query(ctx, `SELECT f.path,f.sha256,b.content_scan_sensitive
 FROM agent_workspace_files f LEFT JOIN agent_workspace_blobs b
 ON b.workspace_id=f.workspace_id AND b.sha256=f.sha256 AND b.content_scan_policy=$2
 WHERE f.workspace_id=$1 ORDER BY f.path`, id, scans.policy)
	if err != nil {
		return scans, err
	}
	missing := make(map[string]string)
	for rows.Next() {
		var filePath, hash string
		var sensitive *bool
		if err = rows.Scan(&filePath, &hash, &sensitive); err != nil {
			rows.Close()
			return scans, err
		}
		if agentRepositorySensitivePath(filePath) || agentWorkspaceSensitiveContent([]byte(filePath)) || (sensitive != nil && *sensitive) {
			rows.Close()
			return scans, &agentWorkspaceSensitiveError{Path: filePath}
		}
		if sensitive == nil {
			if _, exists := missing[hash]; !exists {
				missing[hash] = filePath
			}
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return scans, err
	}
	var sensitiveErr error
	if len(missing) > 0 {
		hashes := make([]string, 0, len(missing))
		for hash := range missing {
			hashes = append(hashes, hash)
		}
		// A blob shared by multiple paths is transferred and scanned only once.
		rows, err = tx.Query(ctx, `SELECT DISTINCT ON (sha256) sha256,content
 FROM agent_workspace_files WHERE workspace_id=$1 AND sha256=ANY($2::text[])
 ORDER BY sha256,id`, id, hashes)
		if err != nil {
			return scans, err
		}
		for rows.Next() {
			var hash string
			var content []byte
			if err = rows.Scan(&hash, &content); err != nil {
				rows.Close()
				return scans, err
			}
			actual := sha256.Sum256(content)
			if hex.EncodeToString(actual[:]) != hash {
				rows.Close()
				return scans, errors.New("workspace file hash mismatch")
			}
			sensitive := agentWorkspaceSensitiveContent(content)
			scans.hashes = append(scans.hashes, hash)
			scans.sensitive = append(scans.sensitive, sensitive)
			if sensitive && sensitiveErr == nil {
				sensitiveErr = &agentWorkspaceSensitiveError{Path: missing[hash]}
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return scans, err
		}
		if len(scans.hashes) != len(missing) {
			return scans, errAgentWorkspaceConflict
		}
	}
	if err = tx.Commit(ctx); err != nil {
		return scans, err
	}
	// Cache both safe and rejected contents after releasing the read snapshot.
	// Only hashes verified from actual bytes reach this server-owned metadata.
	if err = scans.save(ctx, a.db, id); err != nil {
		return scans, err
	}
	return scans, sensitiveErr
}
