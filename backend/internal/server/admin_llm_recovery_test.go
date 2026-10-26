package server

import (
	"bytes"
	"context"
	"encoding/json"
	"koinote/backend/internal/config"
	"net/http"
	"strings"
	"testing"
)

func TestAdminLLMCredentialRecovery(t *testing.T) {
	for _, failure := range []string{"rotation", "corruption"} {
		t.Run(failure, func(t *testing.T) {
			app, pool, user, _ := newAgentReviewCreateTest(t, config.Config{SessionSecret: "recovery-session", LLMCredentialEncryptionKey: "old-encryption-key"})
			ctx := context.Background()
			t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM system_llm_settings`) })
			if _, err := pool.Exec(ctx, `UPDATE users SET is_admin=true WHERE id=$1`, user.ID); err != nil {
				t.Fatal(err)
			}
			cookie := sessionCookieFor(t, app, user.AuthUserID, user.SessionVersion)
			input := func(version int, enabled bool, key string) string {
				value := map[string]any{"version": version, "enabled": enabled, "protocol": "openai", "baseUrl": "https://models.example/v1", "model": "managed-model", "thinking": false}
				if key != "" {
					value["apiKey"] = key
				}
				data, _ := json.Marshal(value)
				return string(data)
			}
			for _, kind := range []string{"text", "image"} {
				saved := callLLMChannelAPI(t, app, cookie, http.MethodPut, "/api/admin/llm/settings/"+kind, input(0, true, "original-"+kind+"-key"))
				if saved.Code != 200 {
					t.Fatalf("setup %s: %d %s", kind, saved.Code, saved.Body.String())
				}
			}
			if failure == "rotation" {
				app.cfg.LLMCredentialEncryptionKey = "new-encryption-key"
			} else {
				if _, err := pool.Exec(ctx, `UPDATE system_llm_settings SET api_key_ciphertext=$1`, []byte("broken")); err != nil {
					t.Fatal(err)
				}
			}
			for _, path := range []string{"/api/admin/llm/settings", "/api/agent/credits"} {
				response := callLLMChannelAPI(t, app, cookie, http.MethodGet, path, "")
				if response.Code != 200 || strings.Contains(response.Body.String(), "original-text-key") {
					t.Fatalf("recovery read %s: %d %s", path, response.Code, response.Body.String())
				}
				if path == "/api/agent/credits" && !strings.Contains(response.Body.String(), `"builtinEnabled":false`) {
					t.Fatal("unreadable credential reported as available")
				}
			}
			for _, kind := range []string{"text", "image"} {
				path := "/api/admin/llm/settings/" + kind
				var oldCipher []byte
				if err := pool.QueryRow(ctx, `SELECT api_key_ciphertext FROM system_llm_settings WHERE kind=$1`, kind).Scan(&oldCipher); err != nil {
					t.Fatal(err)
				}
				preserve := callLLMChannelAPI(t, app, cookie, http.MethodPut, path, input(1, true, ""))
				if preserve.Code != 400 || !strings.Contains(preserve.Body.String(), "llm_credential_unavailable") {
					t.Fatalf("unreadable enabled key: %d %s", preserve.Code, preserve.Body.String())
				}
				disabled := callLLMChannelAPI(t, app, cookie, http.MethodPut, path, input(1, false, ""))
				if disabled.Code != 200 {
					t.Fatalf("disable: %d %s", disabled.Code, disabled.Body.String())
				}
				record, err := app.loadSystemLLMRecord(ctx, kind)
				if err != nil || !bytes.Equal(oldCipher, record.ciphertext) {
					t.Fatal("disabling changed ciphertext", err)
				}
				setting, err := app.loadSystemLLMConfig(ctx, kind)
				if err != nil || setting.Enabled || setting.APIKey != "" {
					t.Fatal("disabled config tried to decrypt", err)
				}
				// Reject a stale recovery save; never bypass optimistic locking.
				stale := callLLMChannelAPI(t, app, cookie, http.MethodPut, path, input(1, true, "replacement-"+kind+"-key"))
				if stale.Code != 409 {
					t.Fatalf("stale recovery status=%d", stale.Code)
				}
				replacement := callLLMChannelAPI(t, app, cookie, http.MethodPut, path, input(2, true, "replacement-"+kind+"-key"))
				if replacement.Code != 200 || strings.Contains(replacement.Body.String(), "replacement-"+kind+"-key") {
					t.Fatalf("replace: %d %s", replacement.Code, replacement.Body.String())
				}
				setting, err = app.loadSystemLLMConfig(ctx, kind)
				if err != nil || setting.APIKey != "replacement-"+kind+"-key" || !setting.Enabled {
					t.Fatal("replacement was not usable", err)
				}
				// Disabled rows are not a prerequisite for direct recovery.
				app.cfg.LLMCredentialEncryptionKey += "-rotated"
				replacement = callLLMChannelAPI(t, app, cookie, http.MethodPut, path, input(3, true, "direct-"+kind+"-key"))
				if replacement.Code != 200 {
					t.Fatalf("direct recovery %s: %d %s", kind, replacement.Code, replacement.Body.String())
				}
				setting, err = app.loadSystemLLMConfig(ctx, kind)
				if err != nil || setting.APIKey != "direct-"+kind+"-key" {
					t.Fatal("direct replacement was not usable", err)
				}
			}
		})
	}
}
