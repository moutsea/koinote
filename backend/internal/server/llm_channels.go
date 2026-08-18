package server

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"koinote/backend/internal/httpx"
)

const (
	llmChannelMaxCount       = 10
	llmChannelMaxNameRunes   = 80
	llmChannelMaxModelRunes  = 160
	llmChannelMaxAPIKeyBytes = 8 << 10
	llmChannelRequestBytes   = 16 << 10
)

type llmChannelView struct {
	ChannelID  string    `json:"channelId"`
	Name       string    `json:"name"`
	Protocol   string    `json:"protocol"`
	BaseURL    string    `json:"baseUrl"`
	Model      string    `json:"model"`
	APIKeyHint string    `json:"apiKeyHint"`
	IsDefault  bool      `json:"isDefault"`
	CreatedAt  time.Time `json:"createdAt"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

type llmChannelCredential struct {
	DatabaseID int64
	ChannelID  string
	Protocol   string
	BaseURL    string
	Model      string
	APIKey     string
}

type llmChannelInput struct {
	Name      string  `json:"name"`
	Protocol  string  `json:"protocol"`
	BaseURL   string  `json:"baseUrl"`
	Model     string  `json:"model"`
	APIKey    *string `json:"apiKey"`
	IsDefault bool    `json:"isDefault"`
}

func (a *App) llmChannelsList(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	rows, err := a.db.Query(r.Context(), `
		SELECT channel_id, name, protocol, base_url, model, api_key_hint,
		       is_default, created_at, updated_at
		FROM llm_channels
		WHERE user_id = $1
		ORDER BY is_default DESC, created_at DESC
	`, user.ID)
	if err != nil {
		log.Printf("llm channel list: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	defer rows.Close()

	channels := make([]llmChannelView, 0)
	for rows.Next() {
		var channel llmChannelView
		if err := rows.Scan(
			&channel.ChannelID,
			&channel.Name,
			&channel.Protocol,
			&channel.BaseURL,
			&channel.Model,
			&channel.APIKeyHint,
			&channel.IsDefault,
			&channel.CreatedAt,
			&channel.UpdatedAt,
		); err != nil {
			log.Printf("llm channel list scan: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		channels = append(channels, channel)
	}
	if err := rows.Err(); err != nil {
		log.Printf("llm channel list rows: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"channels": channels})
}

func (a *App) llmChannelCreate(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	input, ok := decodeLLMChannelInput(w, r, true)
	if !ok {
		return
	}
	channelID, err := randomUUID()
	if err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	apiKey := strings.TrimSpace(*input.APIKey)
	ciphertext, err := a.encryptLLMCredential(channelID, apiKey)
	if err != nil {
		log.Printf("llm channel encrypt: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "llm_credential_unavailable", "LLM credential encryption is unavailable")
		return
	}

	tx, err := a.db.Begin(r.Context())
	if err != nil {
		log.Printf("llm channel create begin: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	defer tx.Rollback(r.Context()) //nolint:errcheck -- commit below owns the successful path
	if _, err := tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock($1)`, user.ID); err != nil {
		log.Printf("llm channel create lock: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	var channelCount int
	if err := tx.QueryRow(r.Context(), `
		SELECT count(*) FROM llm_channels WHERE user_id = $1
	`, user.ID).Scan(&channelCount); err != nil {
		log.Printf("llm channel create count: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if channelCount >= llmChannelMaxCount {
		httpx.ErrorCode(w, http.StatusConflict, "llm_channel_limit_reached", "Delete an existing channel before creating another")
		return
	}
	input.IsDefault = input.IsDefault || channelCount == 0
	if input.IsDefault {
		if _, err := tx.Exec(r.Context(), `
			UPDATE llm_channels SET is_default = false, updated_at = now()
			WHERE user_id = $1 AND is_default
		`, user.ID); err != nil {
			log.Printf("llm channel clear default: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
	}

	var view llmChannelView
	if err := tx.QueryRow(r.Context(), `
		INSERT INTO llm_channels (
			channel_id, user_id, name, protocol, base_url, model,
			api_key_ciphertext, api_key_hint, is_default
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
		RETURNING channel_id, name, protocol, base_url, model, api_key_hint,
		          is_default, created_at, updated_at
	`, channelID, user.ID, input.Name, input.Protocol, input.BaseURL, input.Model,
		ciphertext, llmAPIKeyHint(apiKey), input.IsDefault).Scan(
		&view.ChannelID,
		&view.Name,
		&view.Protocol,
		&view.BaseURL,
		&view.Model,
		&view.APIKeyHint,
		&view.IsDefault,
		&view.CreatedAt,
		&view.UpdatedAt,
	); err != nil {
		if isUniqueViolation(err) {
			httpx.ErrorCode(w, http.StatusConflict, "llm_channel_name_exists", "A channel with this name already exists")
			return
		}
		log.Printf("llm channel create: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		log.Printf("llm channel create commit: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"channel": view})
}

func (a *App) llmChannelUpdate(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	channelID := strings.TrimSpace(r.PathValue("channelId"))
	if channelID == "" {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "LLM channel not found")
		return
	}
	input, ok := decodeLLMChannelInput(w, r, false)
	if !ok {
		return
	}

	var ciphertext []byte
	var hint string
	if input.APIKey != nil {
		apiKey := strings.TrimSpace(*input.APIKey)
		var err error
		ciphertext, err = a.encryptLLMCredential(channelID, apiKey)
		if err != nil {
			log.Printf("llm channel update encrypt: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "llm_credential_unavailable", "LLM credential encryption is unavailable")
			return
		}
		hint = llmAPIKeyHint(apiKey)
	}

	tx, err := a.db.Begin(r.Context())
	if err != nil {
		log.Printf("llm channel update begin: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	defer tx.Rollback(r.Context()) //nolint:errcheck -- commit below owns the successful path
	if _, err := tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock($1)`, user.ID); err != nil {
		log.Printf("llm channel update lock: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	var wasDefault bool
	if err := tx.QueryRow(r.Context(), `
		SELECT is_default
		FROM llm_channels
		WHERE channel_id = $1 AND user_id = $2
	`, channelID, user.ID).Scan(&wasDefault); err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			httpx.ErrorCode(w, http.StatusNotFound, "not_found", "LLM channel not found")
			return
		}
		log.Printf("llm channel update exists: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	// Keep one usable default channel. Unchecking the only current default is
	// treated as a no-op; selecting another channel still promotes it below.
	effectiveDefault := input.IsDefault || wasDefault
	if effectiveDefault {
		if _, err := tx.Exec(r.Context(), `
			UPDATE llm_channels SET is_default = false, updated_at = now()
			WHERE user_id = $1 AND is_default
		`, user.ID); err != nil {
			log.Printf("llm channel update clear default: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
	}

	var view llmChannelView
	if err := tx.QueryRow(r.Context(), `
		UPDATE llm_channels
		SET name = $3,
		    protocol = $4,
		    base_url = $5,
		    model = $6,
		    api_key_ciphertext = CASE WHEN $7::bytea IS NULL THEN api_key_ciphertext ELSE $7 END,
		    api_key_hint = CASE WHEN $7::bytea IS NULL THEN api_key_hint ELSE $8 END,
		    is_default = $9,
		    updated_at = now()
		WHERE channel_id = $1 AND user_id = $2
		RETURNING channel_id, name, protocol, base_url, model, api_key_hint,
		          is_default, created_at, updated_at
	`, channelID, user.ID, input.Name, input.Protocol, input.BaseURL, input.Model,
		nullableBytes(ciphertext), hint, effectiveDefault).Scan(
		&view.ChannelID,
		&view.Name,
		&view.Protocol,
		&view.BaseURL,
		&view.Model,
		&view.APIKeyHint,
		&view.IsDefault,
		&view.CreatedAt,
		&view.UpdatedAt,
	); err != nil {
		if isUniqueViolation(err) {
			httpx.ErrorCode(w, http.StatusConflict, "llm_channel_name_exists", "A channel with this name already exists")
			return
		}
		log.Printf("llm channel update: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		log.Printf("llm channel update commit: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"channel": view})
}

func (a *App) llmChannelDelete(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	channelID := strings.TrimSpace(r.PathValue("channelId"))
	if channelID == "" {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "LLM channel not found")
		return
	}

	tx, err := a.db.Begin(r.Context())
	if err != nil {
		log.Printf("llm channel delete begin: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	defer tx.Rollback(r.Context()) //nolint:errcheck -- commit below owns the successful path
	if _, err := tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock($1)`, user.ID); err != nil {
		log.Printf("llm channel delete lock: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	var wasDefault bool
	if err := tx.QueryRow(r.Context(), `
		DELETE FROM llm_channels
		WHERE channel_id = $1 AND user_id = $2
		RETURNING is_default
	`, channelID, user.ID).Scan(&wasDefault); errors.Is(err, pgx.ErrNoRows) {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "LLM channel not found")
		return
	} else if err != nil {
		log.Printf("llm channel delete: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if wasDefault {
		if _, err := tx.Exec(r.Context(), `
			UPDATE llm_channels
			SET is_default = true, updated_at = now()
			WHERE id = (
				SELECT id FROM llm_channels
				WHERE user_id = $1
				ORDER BY created_at DESC, id DESC
				LIMIT 1
			)
		`, user.ID); err != nil {
			log.Printf("llm channel delete promote default: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
	}
	if _, err := tx.Exec(r.Context(), `
		UPDATE users
		SET agent_provider_mode = 'builtin', updated_at = now()
		WHERE id = $1
		  AND agent_provider_mode = 'byok'
		  AND NOT EXISTS (
		      SELECT 1 FROM llm_channels WHERE user_id = $1 AND is_default
		  )
	`, user.ID); err != nil {
		log.Printf("llm channel delete reset agent provider: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		log.Printf("llm channel delete commit: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"success": true})
}

func decodeLLMChannelInput(w http.ResponseWriter, r *http.Request, create bool) (llmChannelInput, bool) {
	var input llmChannelInput
	r.Body = http.MaxBytesReader(w, r.Body, llmChannelRequestBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid request")
		return llmChannelInput{}, false
	}
	input.Name = strings.TrimSpace(input.Name)
	input.Protocol = strings.ToLower(strings.TrimSpace(input.Protocol))
	input.Model = strings.TrimSpace(input.Model)
	if input.Name == "" || utf8.RuneCountInString(input.Name) > llmChannelMaxNameRunes {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_llm_channel_name", "Channel name is required and must be at most 80 characters")
		return llmChannelInput{}, false
	}
	if input.Protocol != "openai" && input.Protocol != "anthropic" {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_llm_protocol", "Protocol must be openai or anthropic")
		return llmChannelInput{}, false
	}
	normalizedBaseURL, err := normalizeLLMBaseURL(input.BaseURL)
	if err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_llm_base_url", err.Error())
		return llmChannelInput{}, false
	}
	input.BaseURL = normalizedBaseURL
	if input.Model == "" || utf8.RuneCountInString(input.Model) > llmChannelMaxModelRunes {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_llm_model", "Model is required and must be at most 160 characters")
		return llmChannelInput{}, false
	}
	if create && input.APIKey == nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_llm_api_key", "API key is required")
		return llmChannelInput{}, false
	}
	if input.APIKey != nil {
		apiKey := strings.TrimSpace(*input.APIKey)
		if apiKey == "" || len(apiKey) > llmChannelMaxAPIKeyBytes {
			httpx.ErrorCode(w, http.StatusBadRequest, "invalid_llm_api_key", "API key is required and must be at most 8192 bytes")
			return llmChannelInput{}, false
		}
		input.APIKey = &apiKey
	}
	return input, true
}

func llmAPIKeyHint(apiKey string) string {
	runes := []rune(apiKey)
	if len(runes) < 4 {
		return "configured"
	}
	return "••••" + string(runes[len(runes)-4:])
}

func nullableBytes(value []byte) any {
	if len(value) == 0 {
		return nil
	}
	return value
}

func (a *App) llmCredentialCipher() (cipher.AEAD, error) {
	secret := strings.TrimSpace(a.cfg.LLMCredentialEncryptionKey)
	if secret == "" && !a.cfg.IsProduction() {
		secret = a.cfg.SessionSecret
	}
	if secret == "" {
		return nil, errors.New("LLM credential encryption key is empty")
	}
	key := sha256.Sum256([]byte("koinote:llm-credential:v1:" + secret))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func (a *App) encryptLLMCredential(channelID, apiKey string) ([]byte, error) {
	aead, err := a.llmCredentialCipher()
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return aead.Seal(nonce, nonce, []byte(apiKey), []byte(channelID)), nil
}

func (a *App) decryptLLMCredential(channelID string, ciphertext []byte) (string, error) {
	aead, err := a.llmCredentialCipher()
	if err != nil {
		return "", err
	}
	if len(ciphertext) < aead.NonceSize() {
		return "", errors.New("LLM credential ciphertext is truncated")
	}
	nonce := ciphertext[:aead.NonceSize()]
	plain, err := aead.Open(nil, nonce, ciphertext[aead.NonceSize():], []byte(channelID))
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

func isUniqueViolation(err error) bool {
	var databaseError interface{ SQLState() string }
	return errors.As(err, &databaseError) && databaseError.SQLState() == "23505"
}

func (a *App) loadLLMChannelCredential(
	ctx context.Context,
	userID int,
	channelID string,
) (llmChannelCredential, error) {
	var channel llmChannelCredential
	var ciphertext []byte
	err := a.db.QueryRow(ctx, `
		SELECT id, channel_id, protocol, base_url, model, api_key_ciphertext
		FROM llm_channels
		WHERE user_id = $1
		  AND (($2 = '' AND is_default) OR channel_id = $2)
		ORDER BY is_default DESC, created_at DESC
		LIMIT 1
	`, userID, strings.TrimSpace(channelID)).Scan(
		&channel.DatabaseID,
		&channel.ChannelID,
		&channel.Protocol,
		&channel.BaseURL,
		&channel.Model,
		&ciphertext,
	)
	if err != nil {
		return llmChannelCredential{}, err
	}
	channel.APIKey, err = a.decryptLLMCredential(channel.ChannelID, ciphertext)
	if err != nil {
		return llmChannelCredential{}, fmt.Errorf("decrypt LLM channel credential: %w", err)
	}
	return channel, nil
}
