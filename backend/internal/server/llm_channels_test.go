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

func TestPersonalLLMChannelsDisabled(t *testing.T) {
	pool, userID := newCreditTestUser(t)
	var authID string
	if err := pool.QueryRow(context.Background(), `UPDATE users SET membership_tier='lifetime' WHERE id=$1 RETURNING auth_user_id`, userID).Scan(&authID); err != nil {
		t.Fatal(err)
	}
	app := &App{db: pool, cfg: config.Config{SessionSecret: "disabled-personal-channel"}}
	cookie := sessionCookieFor(t, app, authID, 1)
	for _, method := range []string{http.MethodGet, http.MethodPost, http.MethodPut, http.MethodDelete} {
		path := "/api/agent/channels"
		if method == http.MethodPut || method == http.MethodDelete {
			path += "/legacy-channel"
		}
		response := callLLMChannelAPI(t, app, cookie, method, path, `{}`)
		if response.Code != http.StatusGone || !strings.Contains(response.Body.String(), "llm_channels_disabled") {
			t.Fatalf("%s status=%d body=%s", method, response.Code, response.Body.String())
		}
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
