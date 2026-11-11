package server

import (
	"context"
	"github.com/jackc/pgx/v5"
)

// The caller holds the account lock. A previous installed-library task or any
// installation proves this account already adopted the released library. Never
// return it to repository discovery after uninstalling its last Skill.
func (a *App) resolveKoiLibraryMode(ctx context.Context, tx pgx.Tx, userID int) (koiSkillSettings, error) {
	_, err := tx.Exec(ctx, `INSERT INTO agent_session_settings(user_id) VALUES($1) ON CONFLICT DO NOTHING`, userID)
	if err != nil {
		return koiSkillSettings{}, err
	}
	_, err = tx.Exec(ctx, `UPDATE agent_session_settings s SET library_mode=CASE
 WHEN EXISTS(SELECT 1 FROM koi_skill_installations WHERE user_id=$1)
 OR EXISTS(SELECT 1 FROM writing_agent_tasks WHERE user_id=$1 AND skill_snapshot->>'libraryMode'='installed') THEN 'installed'
 WHEN EXISTS(SELECT 1 FROM agent_workspaces w JOIN agent_workspace_files f ON f.workspace_id=w.id
 WHERE w.user_id=$1 AND w.deleted_at IS NULL AND (f.path='SKILL.md' OR f.path LIKE '%/SKILL.md')) THEN 'legacy'
 ELSE 'installed' END WHERE s.user_id=$1 AND s.library_mode IS NULL`, userID)
	if err != nil {
		return koiSkillSettings{}, err
	}
	return loadKoiSkillSettings(ctx, tx, userID)
}

func (a *App) koiSettingsForUser(ctx context.Context, userID int) (koiSkillSettings, error) {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return koiSkillSettings{}, err
	}
	defer tx.Rollback(context.WithoutCancel(ctx))
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, userID); err != nil {
		return koiSkillSettings{}, err
	}
	settings, err := a.resolveKoiLibraryMode(ctx, tx, userID)
	if err == nil {
		err = tx.Commit(ctx)
	}
	return settings, err
}
