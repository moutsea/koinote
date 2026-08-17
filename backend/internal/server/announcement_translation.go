package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"koinote/backend/internal/config"
)

const (
	announcementTranslationTimeout   = 30 * time.Second
	maxAnnouncementLLMResponseBytes  = 1 << 20
	announcementTranslationMaxTokens = 8192
	announcementAnthropicVersion     = "2023-06-01"
	announcementTranslationSystemMsg = `You translate product announcements for Koinote, a Markdown knowledge-base app. Return only valid JSON with a top-level "translations" object. Translate into every requested locale. Preserve product names, version numbers, URLs, keyboard shortcuts, and technical identifiers exactly. Keep each highlight as one plain-text item. Do not add claims, Markdown, HTML, or commentary.`
)

type announcementTranslationInput struct {
	SourceLocale string                  `json:"sourceLocale"`
	Targets      []string                `json:"targetLocales"`
	Source       announcementTranslation `json:"source"`
}

type announcementTranslator interface {
	Translate(context.Context, announcementTranslationInput) (map[string]announcementTranslation, error)
}

type anthropicAnnouncementTranslator struct {
	endpoint string
	apiKey   string
	model    string
	http     httpDoer
}

type announcementMessagesRequest struct {
	Model       string                       `json:"model"`
	MaxTokens   int                          `json:"max_tokens"`
	Temperature float64                      `json:"temperature"`
	System      string                       `json:"system"`
	Messages    []announcementRequestMessage `json:"messages"`
}

type announcementRequestMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type announcementMessagesResponse struct {
	Content []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	} `json:"content"`
}

func newAnnouncementTranslator(cfg config.Config) announcementTranslator {
	if !cfg.AnnouncementTranslationEnabled() {
		return nil
	}
	endpoint, err := announcementMessagesURL(cfg.AnnouncementLLMBaseURL)
	if err != nil {
		return nil
	}
	return &anthropicAnnouncementTranslator{
		endpoint: endpoint,
		apiKey:   cfg.AnnouncementLLMAPIKey,
		model:    cfg.AnnouncementLLMModel,
		http: &http.Client{
			Timeout: announcementTranslationTimeout,
			CheckRedirect: func(*http.Request, []*http.Request) error {
				return errors.New("announcement translation redirects are disabled")
			},
		},
	}
}

func announcementMessagesURL(baseURL string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.User != nil {
		return "", errors.New("invalid announcement translation base URL")
	}
	path := strings.TrimRight(parsed.Path, "/")
	switch {
	case strings.HasSuffix(path, "/messages"):
		parsed.Path = path
	case strings.HasSuffix(path, "/v1"):
		parsed.Path = path + "/messages"
	default:
		parsed.Path = path + "/v1/messages"
	}
	parsed.RawQuery = ""
	parsed.Fragment = ""
	return parsed.String(), nil
}

func (c *anthropicAnnouncementTranslator) Translate(
	ctx context.Context,
	input announcementTranslationInput,
) (map[string]announcementTranslation, error) {
	inputJSON, err := json.Marshal(input)
	if err != nil {
		return nil, fmt.Errorf("marshal announcement translation input: %w", err)
	}
	payload, err := json.Marshal(announcementMessagesRequest{
		Model:       c.model,
		MaxTokens:   announcementTranslationMaxTokens,
		Temperature: 0.2,
		System:      announcementTranslationSystemMsg,
		Messages: []announcementRequestMessage{
			{Role: "user", Content: string(inputJSON)},
		},
	})
	if err != nil {
		return nil, fmt.Errorf("marshal announcement translation request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("create announcement translation request: %w", err)
	}
	req.Header.Set("x-api-key", c.apiKey)
	req.Header.Set("anthropic-version", announcementAnthropicVersion)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	response, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request announcement translation: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 16<<10))
		return nil, fmt.Errorf("announcement translation returned HTTP %d", response.StatusCode)
	}
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, maxAnnouncementLLMResponseBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read announcement translation response: %w", err)
	}
	if len(responseBody) > maxAnnouncementLLMResponseBytes {
		return nil, errors.New("announcement translation response is too large")
	}
	var result announcementMessagesResponse
	if err := json.Unmarshal(responseBody, &result); err != nil {
		return nil, fmt.Errorf("decode announcement translation response: %w", err)
	}
	var textParts []string
	for _, block := range result.Content {
		if block.Type == "text" && strings.TrimSpace(block.Text) != "" {
			textParts = append(textParts, block.Text)
		}
	}
	if len(textParts) == 0 {
		return nil, errors.New("announcement translation returned empty content")
	}
	var translated struct {
		Translations map[string]announcementTranslation `json:"translations"`
	}
	content := stripJSONCodeFence(strings.Join(textParts, ""))
	if err := json.Unmarshal([]byte(content), &translated); err != nil {
		return nil, fmt.Errorf("decode announcement translation JSON: %w", err)
	}
	if len(translated.Translations) != len(input.Targets) {
		return nil, errors.New("announcement translation returned an unexpected locale set")
	}
	targets := make(map[string]struct{}, len(input.Targets))
	for _, locale := range input.Targets {
		targets[locale] = struct{}{}
		translation, ok := translated.Translations[locale]
		if !ok {
			return nil, fmt.Errorf("announcement translation missing locale %s", locale)
		}
		if err := validateAnnouncementTranslation(translation); err != nil {
			return nil, fmt.Errorf("announcement translation locale %s: %w", locale, err)
		}
		if len(translation.Highlights) != len(input.Source.Highlights) {
			return nil, fmt.Errorf("announcement translation locale %s changed highlight count", locale)
		}
	}
	for locale := range translated.Translations {
		if _, ok := targets[locale]; !ok {
			return nil, fmt.Errorf("announcement translation returned unexpected locale %s", locale)
		}
	}
	return translated.Translations, nil
}

func stripJSONCodeFence(value string) string {
	trimmed := strings.TrimSpace(value)
	if !strings.HasPrefix(trimmed, "```") {
		return trimmed
	}
	trimmed = strings.TrimPrefix(trimmed, "```")
	trimmed = strings.TrimPrefix(strings.TrimSpace(trimmed), "json")
	trimmed = strings.TrimSpace(trimmed)
	trimmed = strings.TrimSuffix(trimmed, "```")
	return strings.TrimSpace(trimmed)
}
