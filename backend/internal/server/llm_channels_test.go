package server

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"

	"koinote/backend/internal/config"
)

func TestNormalizeLLMBaseURL(t *testing.T) {
	valid := map[string]string{
		"https://api.openai.com/v1/":       "https://api.openai.com/v1",
		" https://api.anthropic.com ":      "https://api.anthropic.com",
		"https://gateway.example.com:8443": "https://gateway.example.com:8443",
	}
	for input, want := range valid {
		t.Run("valid_"+input, func(t *testing.T) {
			got, err := normalizeLLMBaseURL(input)
			if err != nil {
				t.Fatalf("normalize %q: %v", input, err)
			}
			if got != want {
				t.Fatalf("normalize %q = %q, want %q", input, got, want)
			}
		})
	}

	invalid := []string{
		"http://api.openai.com/v1",
		"https://user:pass@api.openai.com/v1",
		"https://api.openai.com/v1?token=secret",
		"https://api.openai.com/v1#fragment",
		"https://localhost/v1",
		"https://service.internal/v1",
		"https://127.0.0.1/v1",
		"https://169.254.169.254/latest/meta-data",
		"https://10.0.0.1/v1",
		"https://[::1]/v1",
		"https://192.0.2.1/v1",
		"ftp://api.openai.com/v1",
	}
	for _, input := range invalid {
		t.Run("invalid_"+input, func(t *testing.T) {
			if _, err := normalizeLLMBaseURL(input); err == nil {
				t.Fatalf("normalize %q unexpectedly succeeded", input)
			}
		})
	}
}

func TestPublicLLMEndpointIP(t *testing.T) {
	for _, input := range []string{"8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"} {
		if !isPublicLLMEndpointIP(netip.MustParseAddr(input)) {
			t.Fatalf("public address %s was rejected", input)
		}
	}
	for _, input := range []string{
		"0.0.0.0",
		"127.0.0.1",
		"10.0.0.1",
		"100.64.0.1",
		"169.254.169.254",
		"192.0.2.1",
		"198.51.100.1",
		"203.0.113.1",
		"224.0.0.1",
		"::1",
		"fc00::1",
		"fe80::1",
		"2001:db8::1",
		"::ffff:127.0.0.1",
	} {
		if isPublicLLMEndpointIP(netip.MustParseAddr(input)) {
			t.Fatalf("private or reserved address %s was accepted", input)
		}
	}
}

func TestLLMCredentialEncryptionUsesChannelAAD(t *testing.T) {
	app := &App{cfg: config.Config{LLMCredentialEncryptionKey: "test-llm-credential-key"}}
	const (
		channelID = "channel-a"
		apiKey    = "sk-test-secret-value"
	)
	ciphertext, err := app.encryptLLMCredential(channelID, apiKey)
	if err != nil {
		t.Fatalf("encrypt LLM credential: %v", err)
	}
	if bytes.Contains(ciphertext, []byte(apiKey)) {
		t.Fatal("ciphertext contains plaintext API key")
	}
	plain, err := app.decryptLLMCredential(channelID, ciphertext)
	if err != nil {
		t.Fatalf("decrypt LLM credential: %v", err)
	}
	if plain != apiKey {
		t.Fatalf("decrypted API key = %q", plain)
	}
	if _, err := app.decryptLLMCredential("channel-b", ciphertext); err == nil {
		t.Fatal("credential decrypted with the wrong channel AAD")
	}
}

func TestLLMChannelCRUD(t *testing.T) {
	pool, userID := newCreditTestUser(t)
	ctx := context.Background()
	var authUserID string
	if err := pool.QueryRow(ctx, `
		UPDATE users
		SET membership_tier = 'lifetime', membership_granted_at = now()
		WHERE id = $1
		RETURNING auth_user_id
	`, userID).Scan(&authUserID); err != nil {
		t.Fatalf("make channel test user a member: %v", err)
	}
	app := &App{
		db: pool,
		cfg: config.Config{
			SessionSecret:              "channel-test-session-secret",
			LLMCredentialEncryptionKey: "channel-test-encryption-key",
		},
	}
	cookie := sessionCookieFor(t, app, authUserID, 1)

	first := callLLMChannelAPI(t, app, cookie, http.MethodPost, "/api/agent/channels", `{
		"name":"OpenAI primary",
		"protocol":"openai",
		"baseUrl":"https://api.openai.com/v1/",
		"model":"gpt-test",
		"apiKey":"sk-first-secret",
		"isDefault":false
	}`)
	if first.Code != http.StatusCreated {
		t.Fatalf("create first channel status=%d body=%s", first.Code, first.Body.String())
	}
	var firstBody struct {
		Channel llmChannelView `json:"channel"`
	}
	decodeJSONResponse(t, first, &firstBody)
	if !firstBody.Channel.IsDefault || firstBody.Channel.BaseURL != "https://api.openai.com/v1" {
		t.Fatalf("first channel = %+v", firstBody.Channel)
	}
	if strings.Contains(first.Body.String(), "sk-first-secret") {
		t.Fatal("create response leaked the plaintext API key")
	}

	updated := callLLMChannelAPI(
		t,
		app,
		cookie,
		http.MethodPut,
		"/api/agent/channels/"+firstBody.Channel.ChannelID,
		`{
			"name":"OpenAI primary",
			"protocol":"openai",
			"baseUrl":"https://api.openai.com/v1",
			"model":"gpt-test-updated",
			"isDefault":true
		}`,
	)
	if updated.Code != http.StatusOK {
		t.Fatalf("update first channel status=%d body=%s", updated.Code, updated.Body.String())
	}
	credential, err := app.loadLLMChannelCredential(ctx, userID, firstBody.Channel.ChannelID)
	if err != nil {
		t.Fatalf("load updated credential: %v", err)
	}
	if credential.APIKey != "sk-first-secret" || credential.Model != "gpt-test-updated" {
		t.Fatalf("updated credential = %+v", credential)
	}
	// A user must not be able to leave the account without a default channel.
	// Unchecking the only default is kept as a no-op; selecting another channel
	// remains possible by marking that channel as default.
	keptDefault := callLLMChannelAPI(
		t,
		app,
		cookie,
		http.MethodPut,
		"/api/agent/channels/"+firstBody.Channel.ChannelID,
		`{
			"name":"OpenAI primary",
			"protocol":"openai",
			"baseUrl":"https://api.openai.com/v1",
			"model":"gpt-test-updated",
			"isDefault":false
		}`,
	)
	if keptDefault.Code != http.StatusOK {
		t.Fatalf("unchecking only default status=%d body=%s", keptDefault.Code, keptDefault.Body.String())
	}
	defaultCredential, err := app.loadLLMChannelCredential(ctx, userID, "")
	if err != nil {
		t.Fatalf("load retained default channel: %v", err)
	}
	if defaultCredential.ChannelID != firstBody.Channel.ChannelID {
		t.Fatalf("retained default channel = %s, want %s", defaultCredential.ChannelID, firstBody.Channel.ChannelID)
	}

	second := callLLMChannelAPI(t, app, cookie, http.MethodPost, "/api/agent/channels", `{
		"name":"Anthropic backup",
		"protocol":"anthropic",
		"baseUrl":"https://api.anthropic.com",
		"model":"claude-test",
		"apiKey":"sk-ant-second-secret",
		"isDefault":true
	}`)
	if second.Code != http.StatusCreated {
		t.Fatalf("create second channel status=%d body=%s", second.Code, second.Body.String())
	}
	var secondBody struct {
		Channel llmChannelView `json:"channel"`
	}
	decodeJSONResponse(t, second, &secondBody)

	listed := callLLMChannelAPI(t, app, cookie, http.MethodGet, "/api/agent/channels", "")
	if listed.Code != http.StatusOK {
		t.Fatalf("list channels status=%d body=%s", listed.Code, listed.Body.String())
	}
	var listBody struct {
		Channels []llmChannelView `json:"channels"`
	}
	decodeJSONResponse(t, listed, &listBody)
	if len(listBody.Channels) != 2 || listBody.Channels[0].ChannelID != secondBody.Channel.ChannelID ||
		!listBody.Channels[0].IsDefault || listBody.Channels[1].IsDefault {
		t.Fatalf("channel list = %+v", listBody.Channels)
	}

	deleted := callLLMChannelAPI(
		t,
		app,
		cookie,
		http.MethodDelete,
		"/api/agent/channels/"+secondBody.Channel.ChannelID,
		"",
	)
	if deleted.Code != http.StatusOK {
		t.Fatalf("delete channel status=%d body=%s", deleted.Code, deleted.Body.String())
	}
	defaultCredential, err = app.loadLLMChannelCredential(ctx, userID, "")
	if err != nil {
		t.Fatalf("load promoted default channel: %v", err)
	}
	if defaultCredential.ChannelID != firstBody.Channel.ChannelID {
		t.Fatalf("promoted default channel = %s", defaultCredential.ChannelID)
	}

	var ciphertext []byte
	if err := pool.QueryRow(ctx, `
		SELECT api_key_ciphertext FROM llm_channels WHERE channel_id = $1
	`, firstBody.Channel.ChannelID).Scan(&ciphertext); err != nil {
		t.Fatalf("load stored credential: %v", err)
	}
	if bytes.Contains(ciphertext, []byte("sk-first-secret")) {
		t.Fatal("database ciphertext contains the plaintext API key")
	}
}

func callLLMChannelAPI(
	t *testing.T,
	app *App,
	cookie *http.Cookie,
	method string,
	path string,
	body string,
) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(cookie)
	response := httptest.NewRecorder()
	app.Routes().ServeHTTP(response, request)
	return response
}

func decodeJSONResponse(t *testing.T, response *httptest.ResponseRecorder, target any) {
	t.Helper()
	if err := json.Unmarshal(response.Body.Bytes(), target); err != nil {
		t.Fatalf("decode response %q: %v", response.Body.String(), err)
	}
}
