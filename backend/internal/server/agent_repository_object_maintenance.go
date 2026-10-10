package server

import (
	"context"
	"errors"
	"log"
	"time"

	"github.com/jackc/pgx/v5"
)

// Each successful conversion removes bytes only after an R2 upload AND a
// verified read-back. It does not alter revisions, manifests or logical quotas.
func (a *App) migrateAgentRepositoryObjects(ctx context.Context, limit int) (int, error) {
	if a.agentObjectStore == nil {
		return 0, nil
	}
	rows, err := a.db.Query(ctx, `SELECT b.workspace_id,b.sha256,w.user_id FROM agent_workspace_blobs b
 JOIN agent_workspaces w ON w.id=b.workspace_id WHERE b.content IS NOT NULL
 ORDER BY b.workspace_id,b.sha256 LIMIT $1`, limit)
	if err != nil {
		return 0, err
	}
	type legacyBlob struct {
		workspace int64
		hash      string
		user      int
	}
	var batch []legacyBlob
	for rows.Next() {
		var b legacyBlob
		if err = rows.Scan(&b.workspace, &b.hash, &b.user); err != nil {
			rows.Close()
			return 0, err
		}
		batch = append(batch, b)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return 0, err
	}
	migrated := 0
	for _, b := range batch {
		var content []byte
		err = a.db.QueryRow(ctx, `SELECT content FROM agent_workspace_blobs WHERE workspace_id=$1 AND sha256=$2 AND content IS NOT NULL`, b.workspace, b.hash).Scan(&content)
		if errors.Is(err, pgx.ErrNoRows) {
			continue
		}
		if err != nil {
			return migrated, err
		}
		staged, err := a.stageAgentRepositoryFiles(ctx, b.user, []agentWorkspaceFile{{Content: content, SHA256: b.hash}})
		if err != nil {
			return migrated, err
		}
		key := staged[b.hash]
		if _, err = a.readAgentRepositoryContent(ctx, nil, &key, b.hash, int64(len(content)), 0, agentWorkspaceMaxFileBytes); err != nil {
			a.expireAgentRepositoryStaging(ctx, staged)
			return migrated, err
		}
		err = func() error {
			defer a.expireAgentRepositoryStaging(ctx, staged)
			tx, err := a.db.Begin(ctx)
			if err != nil {
				return err
			}
			defer tx.Rollback(ctx)
			if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, b.user); err != nil {
				return err
			}
			result, err := tx.Exec(ctx, `UPDATE agent_workspace_blobs SET content=NULL,r2_object_key=$3
    WHERE workspace_id=$1 AND sha256=$2 AND content IS NOT NULL`, b.workspace, b.hash, key)
			if err != nil {
				return err
			}
			if result.RowsAffected() > 0 {
				if _, err = tx.Exec(ctx, `UPDATE agent_workspace_files SET content=NULL WHERE workspace_id=$1 AND sha256=$2`, b.workspace, b.hash); err != nil {
					return err
				}
			}
			if err = tx.Commit(ctx); err != nil {
				return err
			}
			migrated += int(result.RowsAffected())
			return nil
		}()
		if err != nil {
			return migrated, err
		}
	}
	// A previous application instance can finish a legacy write during rollout.
	// Remove that duplicate only when its immutable blob already has an R2 reference.
	_, err = a.db.Exec(ctx, `UPDATE agent_workspace_files f SET content=NULL FROM agent_workspace_blobs b
 WHERE f.workspace_id=b.workspace_id AND f.sha256=b.sha256 AND f.content IS NOT NULL AND b.r2_object_key IS NOT NULL`)
	return migrated, err
}

func (a *App) collectAgentRepositoryObjects(ctx context.Context, limit int) (int, error) {
	if a.agentObjectStore == nil {
		return 0, nil
	}
	removed := 0
	for range limit {
		tx, err := a.db.Begin(ctx)
		if err != nil {
			return removed, err
		}
		var key string
		err = tx.QueryRow(ctx, `SELECT o.object_key FROM agent_repository_objects o
 WHERE o.delete_after<=now() AND NOT EXISTS(SELECT 1 FROM agent_workspace_blobs b WHERE b.r2_object_key=o.object_key)
 ORDER BY o.delete_after,o.object_key LIMIT 1 FOR UPDATE OF o SKIP LOCKED`).Scan(&key)
		if errors.Is(err, pgx.ErrNoRows) {
			tx.Rollback(ctx)
			break
		}
		if err != nil {
			tx.Rollback(ctx)
			return removed, err
		}
		// Recheck after acquiring the row lock using a fresh READ COMMITTED snapshot.
		// FK locks prevent another transaction from adopting this object during deletion.
		var referenced bool
		err = tx.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agent_workspace_blobs WHERE r2_object_key=$1)`, key).Scan(&referenced)
		if err != nil {
			tx.Rollback(ctx)
			return removed, err
		}
		if referenced {
			tx.Rollback(ctx)
			continue
		}
		if err = a.agentObjectStore.Delete(ctx, key); err != nil {
			tx.Rollback(ctx)
			return removed, err
		}
		if _, err = tx.Exec(ctx, `DELETE FROM agent_repository_objects WHERE object_key=$1`, key); err != nil {
			tx.Rollback(ctx)
			return removed, err
		}
		if err = tx.Commit(ctx); err != nil {
			return removed, err
		}
		removed++
	}
	return removed, nil
}

func (a *App) StartAgentRepositoryObjectMaintenance(ctx context.Context) {
	if a.agentObjectStore == nil {
		return
	}
	go func() {
		for ctx.Err() == nil {
			batchCtx, cancel := context.WithTimeout(ctx, 3*time.Minute)
			migrated, err := a.migrateAgentRepositoryObjects(batchCtx, 32)
			if err != nil && ctx.Err() == nil {
				log.Printf("repository R2 migration: %v (legacy data retained)", err)
			}
			if migrated > 0 {
				log.Printf("repository R2 migration: verified and migrated %d blobs", migrated)
			}
			collected, gcErr := a.collectAgentRepositoryObjects(batchCtx, 32)
			if gcErr != nil && ctx.Err() == nil {
				log.Printf("repository R2 cleanup: %v", gcErr)
			}
			cancel()
			delay := time.Minute
			if err == nil && gcErr == nil && (migrated == 32 || collected == 32) {
				delay = time.Second
			}
			timer := time.NewTimer(delay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
		}
	}()
}
