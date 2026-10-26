package server

import (
	"context"
	"net/http"
	"strings"

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
	if _, ok := a.requireLifetimeMember(w, r); !ok {
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"settings": agentSettingsView{ProviderMode: "builtin"}})
}

func (a *App) agentSettingsPut(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if _, ok := a.requireLifetimeMember(w, r); !ok {
		return
	}
	var input struct {
		ProviderMode string `json:"providerMode"`
	}
	if err := decodeJSONBody(r, &input); err != nil {
		httpx.ErrorCode(w, 400, "bad_request", "Invalid request")
		return
	}
	if strings.TrimSpace(input.ProviderMode) != "builtin" {
		httpx.ErrorCode(w, http.StatusGone, "llm_channels_disabled", "AI channels are managed by the administrator")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"settings": agentSettingsView{ProviderMode: "builtin"}})
}

// Ignore legacy preferences for every entry point, including older clients and MCP.
func (a *App) loadAgentSettings(_ context.Context, _ int) (agentSettingsView, error) {
	return agentSettingsView{ProviderMode: "builtin"}, nil
}
func (a *App) loadAgentProviderMode(_ context.Context, _ int) (string, error) {
	return "builtin", nil
}

// A legacy client can still display BYOK and omit providerMode. Never silently
// turn that request into a credit-backed call, even after preferences migrate.
func requireManagedLLMConfirmation(w http.ResponseWriter, mode, channelID string) bool {
	mode = strings.ToLower(strings.TrimSpace(mode))
	if mode == "byok" || strings.TrimSpace(channelID) != "" {
		httpx.ErrorCode(w, http.StatusGone, "llm_channels_disabled", "AI channels are managed by the administrator")
		return false
	}
	if mode == "" {
		httpx.ErrorCode(w, http.StatusConflict, "agent_provider_confirmation_required", "AI channels now use platform credits. Refresh or update the client before starting again")
		return false
	}
	if mode != "builtin" {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_agent_provider", "Provider mode must be builtin")
		return false
	}
	return true
}
