package server

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"koinote/backend/internal/httpx"
)

var errLLMChannelsDisabled = errors.New("personal LLM channels are disabled")

type systemLLMSetting struct {
	Kind       string     `json:"kind"`
	Enabled    bool       `json:"enabled"`
	Protocol   string     `json:"protocol"`
	BaseURL    string     `json:"baseUrl"`
	Model      string     `json:"model"`
	HasAPIKey  bool       `json:"hasApiKey"`
	APIKeyHint string     `json:"apiKeyHint"`
	Thinking   bool       `json:"thinking"`
	Version    int64      `json:"version"`
	Source     string     `json:"source"`
	UpdatedAt  *time.Time `json:"updatedAt"`
}

type systemLLMConfig struct {
	systemLLMSetting
	APIKey string `json:"-"`
}

func (a *App) environmentLLMConfig(kind string) systemLLMConfig {
	value := systemLLMConfig{systemLLMSetting: systemLLMSetting{Kind: kind, Protocol: "openai", Source: "environment"}}
	if kind == "text" {
		value.Enabled = a.cfg.AgentLLMEnabled()
		value.Protocol = a.cfg.AgentLLMProtocol
		if value.Protocol == "" {
			value.Protocol = "openai"
		}
		value.BaseURL, value.Model, value.APIKey = a.cfg.AgentLLMBaseURL, a.cfg.AgentLLMModel, a.cfg.AgentLLMAPIKey
		value.Thinking = a.cfg.AgentLLMThinking
	} else {
		value.Enabled = a.cfg.WechatCoverImageEnabled()
		value.BaseURL, value.Model, value.APIKey = a.cfg.WechatCoverImageBaseURL, a.cfg.WechatCoverImageModel, a.cfg.WechatCoverImageAPIKey
	}
	value.HasAPIKey = value.APIKey != ""
	if value.HasAPIKey {
		value.APIKeyHint = llmAPIKeyHint(value.APIKey)
	}
	return value
}

// Metadata and encrypted bytes can be read without the encryption key. This
// keeps recovery and credit-account access available when credentials are broken.
type systemLLMRecord struct {
	systemLLMSetting
	ciphertext []byte
}

func (a *App) loadSystemLLMRecord(ctx context.Context, kind string) (systemLLMRecord, error) {
	value := systemLLMRecord{systemLLMSetting: a.environmentLLMConfig(kind).systemLLMSetting}
	if a.db == nil {
		return value, nil
	}
	err := a.db.QueryRow(ctx, `
		SELECT enabled, protocol, base_url, model, api_key_ciphertext, api_key_hint,
		       thinking, version, updated_at
		FROM system_llm_settings WHERE kind = $1
	`, kind).Scan(&value.Enabled, &value.Protocol, &value.BaseURL, &value.Model, &value.ciphertext,
		&value.APIKeyHint, &value.Thinking, &value.Version, &value.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return systemLLMRecord{systemLLMSetting: a.environmentLLMConfig(kind).systemLLMSetting}, nil
	}
	if err != nil {
		return systemLLMRecord{}, err
	}
	value.Source, value.HasAPIKey = "admin", len(value.ciphertext) > 0
	return value, nil
}

// Database settings take precedence, including an explicitly disabled channel.
// Each call resolves a single immutable snapshot, without mutating shared Config.
func (a *App) resolveSystemLLMRecord(record systemLLMRecord) (systemLLMConfig, error) {
	if record.Source == "environment" {
		return a.environmentLLMConfig(record.Kind), nil
	}
	value := systemLLMConfig{systemLLMSetting: record.systemLLMSetting}
	if !value.Enabled {
		return value, nil
	}
	if !value.HasAPIKey {
		return systemLLMConfig{}, errors.New("model credential is missing")
	}
	var err error
	value.APIKey, err = a.decryptLLMCredential("system-llm:"+record.Kind, record.ciphertext)
	if err != nil {
		return systemLLMConfig{}, err
	}
	return value, nil
}

func (a *App) loadSystemLLMConfig(ctx context.Context, kind string) (systemLLMConfig, error) {
	record, err := a.loadSystemLLMRecord(ctx, kind)
	if err != nil {
		return systemLLMConfig{}, err
	}
	return a.resolveSystemLLMRecord(record)
}

func (a *App) adminLLMSettingsGet(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if _, ok := a.requireAdmin(w, r); !ok {
		return
	}
	settings := make([]systemLLMSetting, 0, 2)
	for _, kind := range []string{"text", "image"} {
		value, err := a.loadSystemLLMRecord(r.Context(), kind)
		if err != nil {
			log.Printf("admin LLM settings load: %v", err)
			httpx.ErrorCode(w, 500, "server_error", "Could not load model settings")
			return
		}
		settings = append(settings, value.systemLLMSetting)
	}
	httpx.JSON(w, 200, map[string]any{"settings": settings})
}

func (a *App) adminLLMSettingsPut(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireAdmin(w, r)
	if !ok {
		return
	}
	kind := r.PathValue("kind")
	if kind != "text" && kind != "image" {
		httpx.ErrorCode(w, 404, "not_found", "Model setting not found")
		return
	}
	var input struct {
		Enabled  bool    `json:"enabled"`
		Protocol string  `json:"protocol"`
		BaseURL  string  `json:"baseUrl"`
		Model    string  `json:"model"`
		APIKey   *string `json:"apiKey"`
		Thinking bool    `json:"thinking"`
		Version  *int64  `json:"version"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, llmChannelRequestBytes)
	if err := decodeJSONBody(r, &input); err != nil {
		httpx.ErrorCode(w, 400, "bad_request", "Invalid model settings")
		return
	}
	input.Protocol = strings.ToLower(strings.TrimSpace(input.Protocol))
	input.BaseURL, input.Model = strings.TrimSpace(input.BaseURL), strings.TrimSpace(input.Model)
	if input.Version == nil || *input.Version < 0 ||
		(input.Protocol != "openai" && input.Protocol != "anthropic") ||
		(kind == "image" && (input.Protocol != "openai" || input.Thinking)) ||
		(input.Thinking && input.Protocol != "openai") ||
		utf8.RuneCountInString(input.Model) > llmChannelMaxModelRunes {
		httpx.ErrorCode(w, 400, "invalid_llm_settings", "Invalid model settings")
		return
	}
	if input.BaseURL != "" {
		baseURL, err := normalizeLLMBaseURL(input.BaseURL)
		if err != nil {
			httpx.ErrorCode(w, 400, "invalid_llm_settings", "A public HTTPS model endpoint is required")
			return
		}
		input.BaseURL = baseURL
	}
	current, err := a.loadSystemLLMRecord(r.Context(), kind)
	if err != nil {
		httpx.ErrorCode(w, 500, "server_error", "Could not load model settings")
		return
	}
	if current.Version != *input.Version {
		httpx.ErrorCode(w, 409, "llm_settings_conflict", "Model settings changed; reload before saving")
		return
	}
	// Preserve ciphertext byte-for-byte when no replacement was supplied. In
	// particular, disabling or repairing a channel must not decrypt its old key.
	ciphertext, hint := current.ciphertext, current.APIKeyHint
	var replacement *string
	if input.APIKey != nil {
		apiKey := strings.TrimSpace(*input.APIKey)
		if apiKey == "" || len(apiKey) > llmChannelMaxAPIKeyBytes {
			httpx.ErrorCode(w, 400, "invalid_llm_settings", "A non-empty API key is required")
			return
		}
		replacement = &apiKey
	} else if current.Source == "environment" && current.HasAPIKey {
		apiKey := a.environmentLLMConfig(kind).APIKey
		replacement = &apiKey
	}
	if input.Enabled && (input.BaseURL == "" || input.Model == "" || (replacement == nil && !current.HasAPIKey)) {
		httpx.ErrorCode(w, 400, "invalid_llm_settings", "Endpoint, model and API key are required to enable a channel")
		return
	}
	if replacement != nil {
		ciphertext, err = a.encryptLLMCredential("system-llm:"+kind, *replacement)
		if err != nil {
			httpx.ErrorCode(w, 500, "server_error", "Could not protect model credentials")
			return
		}
		hint = llmAPIKeyHint(*replacement)
	} else if input.Enabled {
		if _, err := a.decryptLLMCredential("system-llm:"+kind, ciphertext); err != nil {
			httpx.ErrorCode(w, 400, "llm_credential_unavailable", "Stored credential cannot be decrypted. Enter a new API key to restore the channel")
			return
		}
	}

	args := []any{kind, input.Enabled, input.Protocol, input.BaseURL, input.Model, ciphertext, hint, input.Thinking, user.ID, *input.Version}
	var version int64
	var updatedAt time.Time
	if *input.Version == 0 {
		err = a.db.QueryRow(r.Context(), `
			INSERT INTO system_llm_settings(kind, enabled, protocol, base_url, model,
			    api_key_ciphertext, api_key_hint, thinking, updated_by, version)
			VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::bigint+1)
			ON CONFLICT(kind) DO NOTHING RETURNING version, updated_at
		`, args...).Scan(&version, &updatedAt)
	} else {
		err = a.db.QueryRow(r.Context(), `
			UPDATE system_llm_settings SET enabled=$2, protocol=$3, base_url=$4, model=$5,
			    api_key_ciphertext=$6, api_key_hint=$7, thinking=$8, updated_by=$9,
			    version=version+1, updated_at=now()
			WHERE kind=$1 AND version=$10 RETURNING version, updated_at
		`, args...).Scan(&version, &updatedAt)
	}
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.ErrorCode(w, 409, "llm_settings_conflict", "Model settings changed; reload before saving")
		return
	}
	if err != nil {
		log.Printf("admin LLM settings save: %v", err)
		httpx.ErrorCode(w, 500, "server_error", "Could not save model settings")
		return
	}
	// Return exactly the version written by this request. A subsequent SELECT
	// could observe a different administrator's edit and misattribute success.
	updated := systemLLMSetting{
		Kind: kind, Enabled: input.Enabled, Protocol: input.Protocol,
		BaseURL: input.BaseURL, Model: input.Model, HasAPIKey: len(ciphertext) > 0,
		APIKeyHint: hint, Thinking: input.Thinking, Version: version,
		Source: "admin", UpdatedAt: &updatedAt,
	}
	httpx.JSON(w, 200, map[string]any{"setting": updated})
}

func (a *App) personalLLMChannelsDisabled(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if _, ok := a.requireLifetimeMember(w, r); !ok {
		return
	}
	httpx.ErrorCode(w, http.StatusGone, "llm_channels_disabled", "AI channels are managed by the administrator")
}
