package server

import (
	"context"
	"errors"
	"net/http"

	"github.com/jackc/pgx/v5"
	"koinote/backend/internal/httpx"
)

type koiSkillSettings struct {
	AutoSkills bool  `json:"autoSkills"`
	Revision   int64 `json:"revision"`
}

func loadKoiSkillSettings(ctx context.Context, q imageUsageQuerier, userID int) (koiSkillSettings, error) {
	settings := koiSkillSettings{AutoSkills: true, Revision: 1}
	err := q.QueryRow(ctx, `SELECT auto_skills,revision FROM agent_session_settings WHERE user_id=$1`, userID).
		Scan(&settings.AutoSkills, &settings.Revision)
	if errors.Is(err, pgx.ErrNoRows) {
		return settings, nil
	}
	return settings, err
}

func (a *App) koiSettingsGet(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	allowed := a.koiSkillAccountAllowed(user.AuthUserID)
	settings, err := loadKoiSkillSettings(r.Context(), a.db, user.ID)
	if err != nil {
		writeKoiError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{
		"managementAvailable": allowed,
		"canInstall":          allowed && user.MembershipTier == membershipTierLifetime,
		"settings":            settings,
	})
}

func (a *App) koiSettingsPut(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireKoiSkillUser(w, r, true)
	if !ok {
		return
	}
	var input struct {
		ExpectedRevision int64 `json:"expectedRevision"`
		AutoSkills       *bool `json:"autoSkills"`
	}
	if decodeJSONBody(r, &input) != nil || input.ExpectedRevision < 1 || input.AutoSkills == nil {
		httpx.ErrorCode(w, 400, "bad_request", "expectedRevision and autoSkills are required")
		return
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		writeKoiError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	if _, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock($1)`, user.ID); err != nil {
		writeKoiError(w, err)
		return
	}
	// Establish the default row before the compare-and-swap, including accounts
	// that have never changed their default permission.
	if _, err = tx.Exec(r.Context(), `INSERT INTO agent_session_settings(user_id) VALUES($1) ON CONFLICT DO NOTHING`, user.ID); err != nil {
		writeKoiError(w, err)
		return
	}
	var settings koiSkillSettings
	err = tx.QueryRow(r.Context(), `UPDATE agent_session_settings SET auto_skills=$2,revision=revision+1
 WHERE user_id=$1 AND revision=$3 RETURNING auto_skills,revision`, user.ID, *input.AutoSkills, input.ExpectedRevision).
		Scan(&settings.AutoSkills, &settings.Revision)
	if errors.Is(err, pgx.ErrNoRows) {
		err = errKoiSkillConflict
	}
	if err == nil {
		err = tx.Commit(r.Context())
	}
	if err != nil {
		writeKoiError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]any{"settings": settings})
}
