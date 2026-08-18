package server

import (
	"context"
	"net/http"
	"testing"

	"koinote/backend/internal/config"
)

func TestAgentSettings(t *testing.T) {
	pool, userID := newCreditTestUser(t)
	ctx := context.Background()
	var authUserID string
	if err := pool.QueryRow(ctx, `
		UPDATE users
		SET membership_tier = 'lifetime', membership_granted_at = now()
		WHERE id = $1
		RETURNING auth_user_id
	`, userID).Scan(&authUserID); err != nil {
		t.Fatalf("make settings test user a member: %v", err)
	}
	app := &App{
		db: pool,
		cfg: config.Config{
			SessionSecret:              "agent-settings-session-secret",
			LLMCredentialEncryptionKey: "agent-settings-encryption-key",
		},
	}
	cookie := sessionCookieFor(t, app, authUserID, 1)

	initial := callLLMChannelAPI(t, app, cookie, http.MethodGet, "/api/agent/settings", "")
	if initial.Code != http.StatusOK {
		t.Fatalf("get initial settings status=%d body=%s", initial.Code, initial.Body.String())
	}
	var initialBody struct {
		Settings agentSettingsView `json:"settings"`
	}
	decodeJSONResponse(t, initial, &initialBody)
	if initialBody.Settings.ProviderMode != "builtin" || initialBody.Settings.DefaultChannel != nil {
		t.Fatalf("initial settings = %+v", initialBody.Settings)
	}

	missingChannel := callLLMChannelAPI(
		t, app, cookie, http.MethodPut, "/api/agent/settings", `{"providerMode":"byok"}`,
	)
	if missingChannel.Code != http.StatusBadRequest {
		t.Fatalf("select BYOK without channel status=%d body=%s", missingChannel.Code, missingChannel.Body.String())
	}

	created := callLLMChannelAPI(t, app, cookie, http.MethodPost, "/api/agent/channels", `{
		"name":"Settings channel",
		"protocol":"anthropic",
		"baseUrl":"https://api.anthropic.com",
		"model":"claude-settings-test",
		"apiKey":"sk-agent-settings",
		"isDefault":true
	}`)
	if created.Code != http.StatusCreated {
		t.Fatalf("create settings channel status=%d body=%s", created.Code, created.Body.String())
	}
	var createdBody struct {
		Channel llmChannelView `json:"channel"`
	}
	decodeJSONResponse(t, created, &createdBody)

	selected := callLLMChannelAPI(
		t, app, cookie, http.MethodPut, "/api/agent/settings", `{"providerMode":"byok"}`,
	)
	if selected.Code != http.StatusOK {
		t.Fatalf("select BYOK status=%d body=%s", selected.Code, selected.Body.String())
	}
	var selectedBody struct {
		Settings agentSettingsView `json:"settings"`
	}
	decodeJSONResponse(t, selected, &selectedBody)
	if selectedBody.Settings.ProviderMode != "byok" || selectedBody.Settings.DefaultChannel == nil ||
		selectedBody.Settings.DefaultChannel.ChannelID != createdBody.Channel.ChannelID {
		t.Fatalf("selected settings = %+v", selectedBody.Settings)
	}

	deleted := callLLMChannelAPI(
		t, app, cookie, http.MethodDelete, "/api/agent/channels/"+createdBody.Channel.ChannelID, "",
	)
	if deleted.Code != http.StatusOK {
		t.Fatalf("delete selected channel status=%d body=%s", deleted.Code, deleted.Body.String())
	}
	reset, err := app.loadAgentSettings(ctx, userID)
	if err != nil {
		t.Fatal(err)
	}
	if reset.ProviderMode != "builtin" || reset.DefaultChannel != nil {
		t.Fatalf("settings after deleting last channel = %+v", reset)
	}
}
