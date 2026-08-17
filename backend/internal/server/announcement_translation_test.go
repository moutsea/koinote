package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"koinote/backend/internal/config"
)

func TestAnnouncementMessagesURL(t *testing.T) {
	for input, expected := range map[string]string{
		"https://example.com":              "https://example.com/v1/messages",
		"https://example.com/":             "https://example.com/v1/messages",
		"https://example.com/v1":           "https://example.com/v1/messages",
		"https://example.com/proxy/v1":     "https://example.com/proxy/v1/messages",
		"https://example.com/v1/messages":  "https://example.com/v1/messages",
		"https://example.com/api/messages": "https://example.com/api/messages",
	} {
		got, err := announcementMessagesURL(input)
		if err != nil || got != expected {
			t.Errorf("announcementMessagesURL(%q)=%q,%v want %q", input, got, err, expected)
		}
	}
	for _, input := range []string{"", "not-a-url", "https://user@example.com"} {
		if _, err := announcementMessagesURL(input); err == nil {
			t.Errorf("invalid URL %q should fail", input)
		}
	}
}

func TestAnthropicAnnouncementTranslator(t *testing.T) {
	type observedRequest struct {
		method           string
		xAPIKey          string
		anthropicVersion string
		authorization    string
		body             announcementMessagesRequest
		err              error
	}
	observed := make(chan observedRequest, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		request := observedRequest{
			method:           r.Method,
			xAPIKey:          r.Header.Get("x-api-key"),
			anthropicVersion: r.Header.Get("anthropic-version"),
			authorization:    r.Header.Get("Authorization"),
		}
		var body announcementMessagesRequest
		request.err = json.NewDecoder(r.Body).Decode(&body)
		request.body = body
		observed <- request
		translated := `{"translations":{"en":{"title":"English title","summary":"English summary","highlights":["One","Two"]},"fr":{"title":"Titre français","summary":"Résumé français","highlights":["Un","Deux"]},"ja":{"title":"日本語タイトル","summary":"日本語の概要","highlights":["一","二"]}}}`
		_ = json.NewEncoder(w).Encode(map[string]any{
			"content": []any{map[string]any{
				"type": "text", "text": "```json\n" + translated + "\n```",
			}},
		})
	}))
	defer server.Close()
	translator := &anthropicAnnouncementTranslator{
		endpoint: server.URL,
		apiKey:   "test-secret",
		model:    "test-model",
		http:     server.Client(),
	}
	result, err := translator.Translate(context.Background(), announcementTranslationInput{
		SourceLocale: "zh",
		Targets:      []string{"en", "fr", "ja"},
		Source: announcementTranslation{
			Title: "中文标题", Summary: "中文摘要", Highlights: []string{"一", "二"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result["fr"].Title != "Titre français" || len(result["ja"].Highlights) != 2 {
		t.Fatalf("unexpected translations: %+v", result)
	}
	request := <-observed
	if request.err != nil || request.method != http.MethodPost || request.xAPIKey != "test-secret" ||
		request.anthropicVersion != announcementAnthropicVersion || request.authorization != "" {
		t.Fatalf("unexpected request: %+v", request)
	}
	if request.body.Model != "test-model" || request.body.MaxTokens != announcementTranslationMaxTokens ||
		request.body.System != announcementTranslationSystemMsg || len(request.body.Messages) != 1 ||
		request.body.Messages[0].Role != "user" {
		t.Fatalf("unexpected Anthropic request: %+v", request.body)
	}
}

func TestAnthropicAnnouncementTranslatorRejectsInvalidResponses(t *testing.T) {
	validLocales := `"en":{"title":"English","summary":"Summary","highlights":["One","Two"]},"fr":{"title":"Français","summary":"Résumé","highlights":["Un","Deux"]},"ja":{"title":"日本語","summary":"概要","highlights":["一","二"]}`
	cases := []struct {
		name    string
		content string
	}{
		{name: "malformed JSON", content: `{"translations":`},
		{name: "missing locale", content: `{"translations":{"en":{"title":"English","summary":"Summary","highlights":["One","Two"]}}}`},
		{name: "extra locale", content: `{"translations":{` + validLocales + `,"zh":{"title":"中文","summary":"摘要","highlights":["一","二"]}}}`},
		{name: "changed highlight count", content: `{"translations":{"en":{"title":"English","summary":"Summary","highlights":["One"]},"fr":{"title":"Français","summary":"Résumé","highlights":["Un","Deux"]},"ja":{"title":"日本語","summary":"概要","highlights":["一","二"]}}}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server := newAnnouncementLLMTestServer(t, tc.content)
			defer server.Close()
			translator := testAnnouncementTranslator(server)
			if _, err := translator.Translate(context.Background(), testAnnouncementTranslationInput()); err == nil {
				t.Fatal("invalid LLM response should fail")
			}
		})
	}
}

func TestAnthropicAnnouncementTranslatorRejectsOversizedResponse(t *testing.T) {
	content := strings.Repeat("x", maxAnnouncementLLMResponseBytes)
	server := newAnnouncementLLMTestServer(t, content)
	defer server.Close()
	translator := testAnnouncementTranslator(server)
	if _, err := translator.Translate(context.Background(), testAnnouncementTranslationInput()); err == nil || !strings.Contains(err.Error(), "too large") {
		t.Fatalf("oversized LLM response should fail explicitly, got %v", err)
	}
}

func TestAnnouncementTranslatorRefusesRedirects(t *testing.T) {
	destination := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer destination.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, destination.URL, http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	translator := newAnnouncementTranslator(config.Config{
		AnnouncementLLMBaseURL: redirect.URL,
		AnnouncementLLMAPIKey:  "test-secret",
		AnnouncementLLMModel:   "test-model",
	})
	if _, err := translator.Translate(context.Background(), testAnnouncementTranslationInput()); err == nil || !strings.Contains(err.Error(), "redirects are disabled") {
		t.Fatalf("redirect should be refused, got %v", err)
	}
}

func TestAnthropicAnnouncementTranslatorLive(t *testing.T) {
	apiKey := strings.TrimSpace(os.Getenv("ANNOUNCEMENT_LLM_LIVE_API_KEY"))
	if apiKey == "" {
		t.Skip("ANNOUNCEMENT_LLM_LIVE_API_KEY is not set")
	}
	translator := newAnnouncementTranslator(config.Config{
		AnnouncementLLMBaseURL: "https://cfjwlpro.com/",
		AnnouncementLLMAPIKey:  apiKey,
		AnnouncementLLMModel:   "claude-sonnet-5",
	})
	if translator == nil {
		t.Fatal("live Anthropic translator was not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	translations, err := translator.Translate(ctx, testAnnouncementTranslationInput())
	if err != nil {
		t.Fatal(err)
	}
	for _, locale := range []string{"en", "fr", "ja"} {
		translation, ok := translations[locale]
		if !ok || translation.Title == "" || translation.Summary == "" || len(translation.Highlights) != 2 {
			t.Fatalf("invalid live %s translation: %+v", locale, translation)
		}
	}
}

func newAnnouncementLLMTestServer(t *testing.T, content string) *httptest.Server {
	t.Helper()
	encodedContent, err := json.Marshal(content)
	if err != nil {
		t.Fatal(err)
	}
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"content":[{"type":"text","text":%s}]}`, encodedContent)
	}))
}

func testAnnouncementTranslator(server *httptest.Server) *anthropicAnnouncementTranslator {
	return &anthropicAnnouncementTranslator{
		endpoint: server.URL,
		apiKey:   "test-secret",
		model:    "test-model",
		http:     server.Client(),
	}
}

func testAnnouncementTranslationInput() announcementTranslationInput {
	return announcementTranslationInput{
		SourceLocale: "zh",
		Targets:      []string{"en", "fr", "ja"},
		Source: announcementTranslation{
			Title: "中文标题", Summary: "中文摘要", Highlights: []string{"一", "二"},
		},
	}
}
