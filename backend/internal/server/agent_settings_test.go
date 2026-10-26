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

	if _, err := pool.Exec(ctx, `UPDATE users SET agent_provider_mode='byok' WHERE id=$1`, userID); err != nil {
		t.Fatal(err)
	}
	legacy, err := app.loadAgentSettings(ctx, userID)
	if err != nil || legacy.ProviderMode != "builtin" || legacy.DefaultChannel != nil {
		t.Fatal("legacy preferences still active", err)
	}
	rejected := callLLMChannelAPI(t, app, cookie, http.MethodPut, "/api/agent/settings", `{"providerMode":"byok"}`)
	if rejected.Code != http.StatusGone {
		t.Fatal("BYOK selection still accepted", rejected.Code)
	}
	accepted := callLLMChannelAPI(t, app, cookie, http.MethodPut, "/api/agent/settings", `{"providerMode":"builtin"}`)
	if accepted.Code != http.StatusOK {
		t.Fatal("legacy builtin selection failed", accepted.Code)
	}
}
