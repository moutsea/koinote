package server

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"koinote/backend/internal/httpx"
)

const (
	defaultDocumentHistoryLimit = 20
	maxDocumentHistoryLimit     = 100
	userDocumentVersionLimit    = 100
)

type documentHistorySettings struct {
	Enabled        bool `json:"enabled"`
	PerDocumentMax int  `json:"perDocumentMax"`
	MCPEnabled     bool `json:"mcpEnabled"`
	Available      bool `json:"available"`
	AccountMax     int  `json:"accountMax"`
}

type historySettingsQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func (a *App) loadDocumentHistorySettings(ctx context.Context, userID int, membershipTier string) (documentHistorySettings, error) {
	return loadDocumentHistorySettings(ctx, a.db, userID, membershipTier)
}

func loadDocumentHistorySettings(ctx context.Context, querier historySettingsQuerier, userID int, membershipTier string) (documentHistorySettings, error) {
	settings := documentHistorySettings{
		PerDocumentMax: defaultDocumentHistoryLimit,
		Available:      membershipTier == membershipTierLifetime,
		AccountMax:     userDocumentVersionLimit,
	}
	err := querier.QueryRow(ctx, `
		SELECT document_history_enabled, document_history_limit, mcp_history_enabled
		FROM users WHERE id = $1
	`, userID).Scan(&settings.Enabled, &settings.PerDocumentMax, &settings.MCPEnabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return documentHistorySettings{}, errDocumentNotFound
	}
	if err != nil {
		return documentHistorySettings{}, err
	}
	return settings, nil
}

func (a *App) documentHistorySettingsGet(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	settings, err := a.loadDocumentHistorySettings(r.Context(), user.ID, user.MembershipTier)
	if err != nil {
		log.Printf("document history settings get: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"settings": settings})
}

func (a *App) documentHistorySettingsPut(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	var body struct {
		Enabled        bool `json:"enabled"`
		PerDocumentMax int  `json:"perDocumentMax"`
		MCPEnabled     bool `json:"mcpEnabled"`
	}
	if err := decodeJSONBody(r, &body); err != nil || body.PerDocumentMax < 1 || body.PerDocumentMax > maxDocumentHistoryLimit {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_history_settings", "Invalid document history settings")
		return
	}
	settings, err := a.updateDocumentHistorySettings(r.Context(), userRef{ID: user.ID, AuthUserID: user.AuthUserID}, body.Enabled, body.PerDocumentMax, body.MCPEnabled)
	if err != nil {
		log.Printf("document history settings update: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"settings": settings})
}

func (a *App) updateDocumentHistorySettings(ctx context.Context, user userRef, enabled bool, perDocumentMax int, mcpEnabled bool) (documentHistorySettings, error) {
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return documentHistorySettings{}, err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, user.ID); err != nil {
		return documentHistorySettings{}, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE users
		SET document_history_enabled = $2,
		    document_history_limit = $3,
		    mcp_history_enabled = $4,
		    updated_at = now()
		WHERE id = $1 AND membership_tier = 'lifetime'
	`, user.ID, enabled, perDocumentMax, mcpEnabled); err != nil {
		return documentHistorySettings{}, err
	}
	rows, err := tx.Query(ctx, `
		DELETE FROM document_versions
		WHERE id IN (
			SELECT ranked.id
			FROM (
				SELECT version.id,
				       row_number() OVER (
				           PARTITION BY version.document_id
						   ORDER BY version.revision DESC
					       ) AS retained_position
					FROM document_versions AS version
					JOIN documents AS document ON document.id = version.document_id
					WHERE document.user_id = $1
			) AS ranked
			WHERE ranked.retained_position > $2
		)
		RETURNING content
	`, user.ID, perDocumentMax)
	if err != nil {
		return documentHistorySettings{}, err
	}
	var prunedContents []string
	for rows.Next() {
		var content string
		if err := rows.Scan(&content); err != nil {
			rows.Close()
			return documentHistorySettings{}, err
		}
		prunedContents = append(prunedContents, content)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return documentHistorySettings{}, err
	}
	rows.Close()
	if err := tx.Commit(ctx); err != nil {
		return documentHistorySettings{}, err
	}

	if len(prunedContents) > 0 {
		gcCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		a.enqueueOrphanedImages(gcCtx, user, strings.Join(prunedContents, "\n"))
	}
	return documentHistorySettings{
		Enabled: enabled, PerDocumentMax: perDocumentMax, MCPEnabled: mcpEnabled,
		Available: true, AccountMax: userDocumentVersionLimit,
	}, nil
}
