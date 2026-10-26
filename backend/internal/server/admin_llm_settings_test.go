package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"koinote/backend/internal/config"
)

func TestAdminLLMSettingsAuthorizationEncryptionAndRouting(t *testing.T) {
	app, pool, user, _ := newAgentReviewCreateTest(t, config.Config{
		SessionSecret: "admin-model-session", LLMCredentialEncryptionKey: "admin-model-encryption",
		AgentLLMProtocol: "openai", AgentLLMBaseURL: "https://environment.example/v1",
		AgentLLMModel: "environment-model", AgentLLMAPIKey: "environment-secret",
		WechatCoverImageBaseURL: "https://environment-images.example/v1",
		WechatCoverImageModel:   "environment-image", WechatCoverImageAPIKey: "environment-image-secret",
	})
	ctx := context.Background()
	t.Cleanup(func() { _, _ = pool.Exec(ctx, `DELETE FROM system_llm_settings`) })
	cookie := sessionCookieFor(t, app, user.AuthUserID, user.SessionVersion)
	request := func(method, kind, body string) *httptest.ResponseRecorder {
		path := "/api/admin/llm/settings"
		if kind != "" {
			path += "/" + kind
		}
		response := callLLMChannelAPI(t, app, cookie, method, path, body)
		if method == http.MethodPut && response.Code == http.StatusOK {
			var input struct {
				Version int64  `json:"version"`
				Model   string `json:"model"`
			}
			var result struct {
				Setting systemLLMSetting `json:"setting"`
			}
			if err := json.Unmarshal([]byte(body), &input); err != nil {
				t.Error(err)
			}
			if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
				t.Error(err)
			}
			if result.Setting.Version != input.Version+1 || result.Setting.Model != input.Model || result.Setting.UpdatedAt == nil {
				t.Errorf("save response does not match its own write: version=%d want=%d model=%q want=%q", result.Setting.Version, input.Version+1, result.Setting.Model, input.Model)
			}
		}
		return response
	}
	for _, method := range []string{http.MethodGet, http.MethodPut} {
		kind := ""
		if method == http.MethodPut {
			kind = "text"
		}
		if response := request(method, kind, `{}`); response.Code != http.StatusForbidden {
			t.Fatalf("non-admin %s status=%d", method, response.Code)
		}
	}
	if _, err := pool.Exec(ctx, `UPDATE users SET is_admin=true WHERE id=$1`, user.ID); err != nil {
		t.Fatal(err)
	}
	response := request(http.MethodGet, "", "")
	if response.Code != 200 || strings.Contains(response.Body.String(), "environment-secret") {
		t.Fatal("invalid or leaking admin settings response", response.Code)
	}
	var initial struct {
		Settings []systemLLMSetting `json:"settings"`
	}
	decodeJSONResponse(t, response, &initial)
	if len(initial.Settings) != 2 || initial.Settings[0].Source != "environment" || !initial.Settings[0].HasAPIKey {
		t.Fatal("missing environment fallback")
	}
	input := func(version int64, enabled bool, protocol, endpoint, model, key string) string {
		value := map[string]any{"version": version, "enabled": enabled, "protocol": protocol, "baseUrl": endpoint, "model": model, "thinking": false}
		if key != "" {
			value["apiKey"] = key
		}
		body, _ := json.Marshal(value)
		return string(body)
	}
	for _, endpoint := range []string{"http://models.example/v1", "https://127.0.0.1/v1", "https://user:secret@models.example/v1", "https://models.example/v1?secret=value"} {
		if r := request(http.MethodPut, "text", input(0, true, "openai", endpoint, "model", "key")); r.Code != 400 {
			t.Fatalf("unsafe endpoint accepted: %d", r.Code)
		}
	}
	if r := request(http.MethodPut, "image", input(0, true, "anthropic", "https://images.example/v1", "image-model", "image-secret")); r.Code != 400 {
		t.Fatal("image accepted non-image protocol")
	}
	response = request(http.MethodPut, "text", input(0, true, "openai", "https://models.example/v1/", "managed-text", "managed-text-secret"))
	if response.Code != 200 || strings.Contains(response.Body.String(), "managed-text-secret") {
		t.Fatalf("save text status=%d body=%s", response.Code, response.Body.String())
	}
	var ciphertext []byte
	if err := pool.QueryRow(ctx, `SELECT api_key_ciphertext FROM system_llm_settings WHERE kind='text'`).Scan(&ciphertext); err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(ciphertext, []byte("managed-text-secret")) {
		t.Fatal("plaintext stored in database")
	}
	if _, err := app.decryptLLMCredential("system-llm:image", ciphertext); err == nil {
		t.Fatal("credential not bound to channel kind")
	}
	response = request(http.MethodPut, "text", input(1, true, "openai", "https://models.example/v1", "managed-text-updated", ""))
	if response.Code != 200 {
		t.Fatalf("preserve key status=%d body=%s", response.Code, response.Body.String())
	}
	// A new App instance sees the persisted configuration without any restart/import.
	other := &App{db: pool, cfg: app.cfg}
	provider, channelID, err := other.resolveAgentLLMProvider(ctx, user, "builtin", "")
	if err != nil || provider.Model != "managed-text-updated" || provider.APIKey != "managed-text-secret" || !provider.SafeEndpoint || channelID != nil {
		t.Fatal("managed routing was not applied", err)
	}
	if _, _, err := other.resolveAgentLLMProvider(ctx, user, "byok", ""); err != errLLMChannelsDisabled {
		t.Fatal("BYOK resolver remains available")
	}
	textClient := &http.Client{Transport: wechatRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.String() != "https://models.example/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer managed-text-secret" {
			t.Error("wrong managed text routing")
		}
		var payload struct {
			Model string `json:"model"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || payload.Model != "managed-text-updated" {
			t.Error("wrong text model", err)
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"choices":[{"message":{"content":"{\"ok\":true}"},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150}}`))}, nil
	})}
	result, err := callAgentLLM(ctx, textClient, provider, agentLLMPrompt{System: "Return JSON", User: "Synthetic test"})
	if err != nil || string(result.JSON) != `{"ok":true}` || result.TotalTokens != 150 {
		t.Fatal("managed text request failed", err)
	}
	responses := make(chan int, 2)
	for _, model := range []string{"concurrent-a", "concurrent-b"} {
		go func(model string) {
			responses <- request(http.MethodPut, "text", input(2, true, "openai", "https://models.example/v1", model, "")).Code
		}(model)
	}
	first, second := <-responses, <-responses
	if !((first == 200 && second == 409) || (first == 409 && second == 200)) {
		t.Fatalf("concurrent writes=%d,%d", first, second)
	}
	response = request(http.MethodPut, "text", input(3, true, "anthropic", "https://anthropic.example", "managed-anthropic", "anthropic-secret"))
	if response.Code != 200 {
		t.Fatal("Anthropic settings rejected", response.Code, response.Body.String())
	}
	provider, _, err = other.resolveAgentLLMProvider(ctx, user, "builtin", "")
	if err != nil || provider.Protocol != "anthropic" || provider.Model != "managed-anthropic" || provider.APIKey != "anthropic-secret" {
		t.Fatal("protocol and key update not applied", err)
	}
	response = request(http.MethodPut, "image", input(0, true, "openai", "https://images.example/v1", "managed-image", "managed-image-secret"))
	if response.Code != 200 {
		t.Fatalf("image save status=%d body=%s", response.Code, response.Body.String())
	}
	raw := testWechatCoverJPEG(t)
	calls := 0
	app.wechatCoverHTTPClient = &http.Client{Transport: wechatRoundTripFunc(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.String() != "https://images.example/v1/images/generations" || r.Header.Get("Authorization") != "Bearer managed-image-secret" {
			t.Error("wrong managed image routing")
		}
		var payload struct {
			Model string `json:"model"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || payload.Model != "managed-image" {
			t.Error("wrong image model", err)
		}
		return &http.Response{StatusCode: 200, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`{"data":[{"b64_json":"` + base64.StdEncoding.EncodeToString(raw) + `"}]}`))}, nil
	})}
	cover, err := app.generateWechatCover(ctx, "A writing desk", "1:1")
	if err != nil || cover.Model != "managed-image" || calls != 1 {
		t.Fatal("managed image generation failed", err)
	}
	response = request(http.MethodPut, "text", input(4, false, "openai", "https://models.example/v1", "disabled", ""))
	if response.Code != 200 {
		t.Fatal("disable text failed", response.Code, response.Body.String())
	}
	if _, _, err := app.resolveAgentLLMProvider(ctx, user, "builtin", ""); err == nil {
		t.Fatal("disabled config fell back to environment")
	}
	credits := callLLMChannelAPI(t, app, cookie, http.MethodGet, "/api/agent/credits", "")
	var balance struct {
		Credits struct {
			BuiltinEnabled bool `json:"builtinEnabled"`
		} `json:"credits"`
	}
	decodeJSONResponse(t, credits, &balance)
	if credits.Code != 200 || balance.Credits.BuiltinEnabled {
		t.Fatal("availability ignored disabled config")
	}
	response = request(http.MethodPut, "image", input(1, false, "openai", "https://images.example/v1", "managed-image", ""))
	if response.Code != 200 {
		t.Fatal("disable image failed")
	}
	if _, err := app.generateWechatCover(ctx, "Desk", "1:1"); err != errWechatCoverModelUnavailable || calls != 1 {
		t.Fatal("disabled image still called provider")
	}
	// Unknown fields cannot be used to smuggle plaintext credentials into responses.
	encoded, _ := json.Marshal(systemLLMConfig{APIKey: "secret-never-serialize"})
	if strings.Contains(string(encoded), "secret-never-serialize") {
		t.Fatal(fmt.Sprintf("private config serialized: %s", encoded))
	}
}
