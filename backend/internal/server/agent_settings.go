package server

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5"

	"koinote/backend/internal/httpx"
)

type agentSettingsChannel struct {
	ChannelID string `json:"channelId"`
	Name      string `json:"name"`
	Model     string `json:"model"`
}

type agentSettingsView struct {
	ProviderMode   string                `json:"providerMode"`
	DefaultChannel *agentSettingsChannel `json:"defaultChannel"`
}

func (a *App) agentSettingsGet(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	settings, err := a.loadAgentSettings(r.Context(), user.ID)
	if err != nil {
		log.Printf("agent settings get: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"settings": settings})
}

func (a *App) agentSettingsPut(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	var input struct {
		ProviderMode string `json:"providerMode"`
	}
	if err := decodeJSONBody(r, &input); err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid request")
		return
	}
	input.ProviderMode = strings.ToLower(strings.TrimSpace(input.ProviderMode))
	if input.ProviderMode != "builtin" && input.ProviderMode != "byok" {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_agent_provider", "Provider mode must be builtin or byok")
		return
	}

	command, err := a.db.Exec(r.Context(), `
		UPDATE users
		SET agent_provider_mode = $2, updated_at = now()
		WHERE id = $1
		  AND membership_tier = 'lifetime'
		  AND (
		      $2 = 'builtin'
		      OR EXISTS (
		          SELECT 1 FROM llm_channels
		          WHERE user_id = $1 AND is_default
		      )
		  )
	`, user.ID, input.ProviderMode)
	if err != nil {
		log.Printf("agent settings update: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if command.RowsAffected() == 0 {
		httpx.ErrorCode(w, http.StatusBadRequest, "llm_channel_not_found", "Configure a default LLM channel first")
		return
	}
	settings, err := a.loadAgentSettings(r.Context(), user.ID)
	if err != nil {
		log.Printf("agent settings reload: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"settings": settings})
}

func (a *App) loadAgentSettings(ctx context.Context, userID int) (agentSettingsView, error) {
	var settings agentSettingsView
	var channelID, name, model *string
	err := a.db.QueryRow(ctx, `
		SELECT users.agent_provider_mode, channel.channel_id, channel.name, channel.model
		FROM users
		LEFT JOIN llm_channels channel
		  ON channel.user_id = users.id AND channel.is_default
		WHERE users.id = $1
	`, userID).Scan(&settings.ProviderMode, &channelID, &name, &model)
	if err != nil {
		return agentSettingsView{}, err
	}
	if channelID != nil && name != nil && model != nil {
		settings.DefaultChannel = &agentSettingsChannel{
			ChannelID: *channelID,
			Name:      *name,
			Model:     *model,
		}
	}
	return settings, nil
}

func (a *App) loadAgentProviderMode(ctx context.Context, userID int) (string, error) {
	var mode string
	err := a.db.QueryRow(ctx, `
		SELECT agent_provider_mode FROM users WHERE id = $1
	`, userID).Scan(&mode)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", err
	}
	return mode, err
}
