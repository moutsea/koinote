package server

import (
	"context"
)

// Preview bytes are temporary; committed packages have independent references.
func (a *App) cleanupKoiSkillImports(ctx context.Context) error {
	_, err := a.db.Exec(ctx, `WITH expired AS (
 UPDATE koi_skill_imports SET status='expired',candidates='[]',result=NULL,revision=revision+1,updated_at=now()
 WHERE expires_at<=now() AND status IN ('pending','analyzing','ready','failed') RETURNING id
 ), reclaimed AS (
 SELECT id FROM expired UNION SELECT id FROM koi_skill_imports WHERE status IN ('committed','cancelled','expired')
 ) DELETE FROM koi_skill_import_files WHERE import_id IN (SELECT id FROM reclaimed)`)
	return err
}

func (a *App) cleanupKoiSkillVersions(ctx context.Context) error {
	rows, err := a.db.Query(ctx, `SELECT DISTINCT v.user_id FROM koi_skill_versions v
 WHERE NOT EXISTS(SELECT 1 FROM koi_skill_installations i WHERE i.current_version_id=v.id AND i.deleted_at IS NULL)
 AND NOT EXISTS(SELECT 1 FROM agent_task_skill_versions refs JOIN writing_agent_tasks t ON t.id=refs.task_id
                WHERE refs.version_id=v.id AND t.status NOT IN ('completed','failed','cancelled'))
 ORDER BY v.user_id LIMIT 100`)
	if err != nil {
		return err
	}
	users := []int{}
	for rows.Next() {
		var id int
		if err = rows.Scan(&id); err != nil {
			break
		}
		users = append(users, id)
	}
	rowErr := rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if rowErr != nil {
		return rowErr
	}
	for _, userID := range users {
		if err = a.cleanupKoiSkillVersionsForUser(ctx, userID); err != nil {
			return err
		}
	}
	return nil
}

// Share the user lock with confirmation, uninstall and future task pinning.
// Removing an R2 reference invokes its existing 401-day backup retention trigger.
func (a *App) cleanupKoiSkillVersionsForUser(ctx context.Context, userID int) error {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, userID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM agent_task_skill_versions refs USING writing_agent_tasks t
 WHERE refs.task_id=t.id AND t.user_id=$1 AND t.status IN ('completed','failed','cancelled')`, userID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `UPDATE koi_skill_installations SET current_version_id=NULL
 WHERE user_id=$1 AND deleted_at IS NOT NULL AND current_version_id IS NOT NULL`, userID); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM koi_skill_versions v WHERE v.user_id=$1
 AND NOT EXISTS(SELECT 1 FROM koi_skill_installations i WHERE i.current_version_id=v.id)
 AND NOT EXISTS(SELECT 1 FROM agent_task_skill_versions refs WHERE refs.version_id=v.id)`, userID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
