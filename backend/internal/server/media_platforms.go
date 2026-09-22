package server

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"koinote/backend/internal/httpx"
)

const (
	mediaSettingsRequestBytes       = 16 << 10
	customMediaPlatformRequestBytes = 32 << 10
	customMediaMaxHTMLBytes         = 3 << 20
	customMediaPublishRequestBytes  = 6*(maxContentBytes+customMediaMaxHTMLBytes+maxDocumentCoverSourceBytes+(maxTitleRunes*utf8.UTFMax)) + (64 << 10)
	customMediaMaxNameRunes         = 80
	customMediaMaxEndpointBytes     = 2_048
	customMediaMaxTokenBytes        = 8 << 10
	customMediaMaxResponseBytes     = 1 << 20
	customMediaPublishTimeout       = 45 * time.Second
	customMediaMaxCount             = 20
)

type mediaPlatformSettingsView struct {
	WechatEnabled bool `json:"wechatEnabled"`
	ZhihuEnabled  bool `json:"zhihuEnabled"`
	XEnabled      bool `json:"xEnabled"`
}

type customMediaPlatformView struct {
	PlatformID    string    `json:"platformId"`
	Name          string    `json:"name"`
	EndpointURL   string    `json:"endpointUrl"`
	AuthTokenHint string    `json:"authTokenHint"`
	Enabled       bool      `json:"enabled"`
	CreatedAt     time.Time `json:"createdAt"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

type mediaPlatformSettingsResponse struct {
	Settings        mediaPlatformSettingsView `json:"settings"`
	CustomPlatforms []customMediaPlatformView `json:"customPlatforms"`
}

func (a *App) mediaPlatformSettingsGet(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	response, err := a.loadMediaPlatformSettings(r.Context(), user.ID)
	if err != nil {
		log.Printf("media platform settings get: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	httpx.JSON(w, http.StatusOK, response)
}

func (a *App) mediaPlatformSettingsPut(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	var input mediaPlatformSettingsView
	if !decodeBoundedJSON(w, r, mediaSettingsRequestBytes, &input) {
		return
	}
	_, err := a.db.Exec(r.Context(), `
		INSERT INTO media_platform_settings (user_id, wechat_enabled, zhihu_enabled, x_enabled)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (user_id) DO UPDATE SET
			wechat_enabled = EXCLUDED.wechat_enabled,
			zhihu_enabled = EXCLUDED.zhihu_enabled,
			x_enabled = EXCLUDED.x_enabled,
			updated_at = now()
	`, user.ID, input.WechatEnabled, input.ZhihuEnabled, input.XEnabled)
	if err != nil {
		log.Printf("media platform settings update: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	response, err := a.loadMediaPlatformSettings(r.Context(), user.ID)
	if err != nil {
		log.Printf("media platform settings reload: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	httpx.JSON(w, http.StatusOK, response)
}

func (a *App) customMediaPlatformCreate(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	input, ok := decodeCustomMediaPlatformInput(w, r)
	if !ok {
		return
	}
	tx, err := a.db.Begin(r.Context())
	if err != nil {
		log.Printf("custom media platform transaction: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	defer tx.Rollback(r.Context())
	if _, err := tx.Exec(r.Context(), `SELECT id FROM users WHERE id = $1 FOR UPDATE`, user.ID); err != nil {
		log.Printf("custom media platform lock: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	var count int
	if err := tx.QueryRow(r.Context(), `SELECT count(*) FROM custom_media_platforms WHERE user_id = $1`, user.ID).Scan(&count); err != nil {
		log.Printf("custom media platform count: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if count >= customMediaMaxCount {
		httpx.ErrorCode(w, http.StatusConflict, "custom_media_platform_limit_reached", "Delete an existing custom platform before creating another")
		return
	}
	platformID, err := randomUUID()
	if err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	var ciphertext []byte
	if input.AuthToken != "" {
		ciphertext, err = a.encryptCustomMediaToken(platformID, input.AuthToken)
		if err != nil {
			log.Printf("custom media platform token encrypt: %v", err)
			httpx.ErrorCode(w, http.StatusServiceUnavailable, "custom_media_credential_unavailable", "Custom platform credential encryption is unavailable")
			return
		}
	}
	var view customMediaPlatformView
	err = tx.QueryRow(r.Context(), `
		INSERT INTO custom_media_platforms (platform_id, user_id, name, endpoint_url, auth_token_ciphertext, auth_token_hint, enabled)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING platform_id, name, endpoint_url, auth_token_hint, enabled, created_at, updated_at
	`, platformID, user.ID, input.Name, input.EndpointURL, nullableBytes(ciphertext), mediaTokenHint(input.AuthToken), input.Enabled).Scan(
		&view.PlatformID, &view.Name, &view.EndpointURL, &view.AuthTokenHint, &view.Enabled, &view.CreatedAt, &view.UpdatedAt,
	)
	if err != nil {
		if isUniqueViolation(err) {
			httpx.ErrorCode(w, http.StatusConflict, "custom_media_platform_name_exists", "A custom platform with this name already exists")
			return
		}
		log.Printf("custom media platform create: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		log.Printf("custom media platform commit: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"platform": view})
}

func (a *App) customMediaPlatformUpdate(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	platformID := strings.TrimSpace(r.PathValue("platformId"))
	if !validUUID(platformID) {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Custom platform not found")
		return
	}
	input, ok := decodeCustomMediaPlatformInput(w, r)
	if !ok {
		return
	}
	var existingCiphertext []byte
	err := a.db.QueryRow(r.Context(), `SELECT auth_token_ciphertext FROM custom_media_platforms WHERE platform_id = $1 AND user_id = $2`, platformID, user.ID).Scan(&existingCiphertext)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Custom platform not found")
		return
	}
	if err != nil {
		log.Printf("custom media platform lookup: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	ciphertext := existingCiphertext
	hint := mediaTokenHint("")
	if input.ClearAuthToken {
		ciphertext = nil
	} else if input.AuthToken != "" {
		ciphertext, err = a.encryptCustomMediaToken(platformID, input.AuthToken)
		if err != nil {
			log.Printf("custom media platform token encrypt: %v", err)
			httpx.ErrorCode(w, http.StatusServiceUnavailable, "custom_media_credential_unavailable", "Custom platform credential encryption is unavailable")
			return
		}
		hint = mediaTokenHint(input.AuthToken)
	}
	var view customMediaPlatformView
	setToken := input.AuthToken != "" || input.ClearAuthToken
	err = a.db.QueryRow(r.Context(), `
		UPDATE custom_media_platforms
		SET name = $3,
		    endpoint_url = $4,
		    auth_token_ciphertext = CASE WHEN $5 THEN $6::bytea ELSE auth_token_ciphertext END,
		    auth_token_hint = CASE WHEN $5 THEN $7 ELSE auth_token_hint END,
		    enabled = $8,
		    updated_at = now()
		WHERE platform_id = $1 AND user_id = $2
		RETURNING platform_id, name, endpoint_url, auth_token_hint, enabled, created_at, updated_at
	`, platformID, user.ID, input.Name, input.EndpointURL, setToken, nullableBytes(ciphertext), hint, input.Enabled).Scan(
		&view.PlatformID, &view.Name, &view.EndpointURL, &view.AuthTokenHint, &view.Enabled, &view.CreatedAt, &view.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Custom platform not found")
		return
	}
	if err != nil {
		if isUniqueViolation(err) {
			httpx.ErrorCode(w, http.StatusConflict, "custom_media_platform_name_exists", "A custom platform with this name already exists")
			return
		}
		log.Printf("custom media platform update: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"platform": view})
}

func (a *App) customMediaPlatformDelete(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	platformID := strings.TrimSpace(r.PathValue("platformId"))
	if !validUUID(platformID) {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Custom platform not found")
		return
	}
	result, err := a.db.Exec(r.Context(), `DELETE FROM custom_media_platforms WHERE platform_id = $1 AND user_id = $2`, platformID, user.ID)
	if err != nil {
		log.Printf("custom media platform delete: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if result.RowsAffected() == 0 {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Custom platform not found")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"success": true})
}

func (a *App) customMediaPlatformPublish(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	if !a.rateLimit().allow("custom-media-publish:"+strconv.Itoa(user.ID), 10, time.Hour) {
		httpx.ErrorCode(w, http.StatusTooManyRequests, "rate_limited", "Too many custom platform publishes")
		return
	}
	platformID := strings.TrimSpace(r.PathValue("platformId"))
	docID := strings.TrimSpace(r.PathValue("docId"))
	if !validUUID(platformID) || !validUUID(docID) {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Custom platform or document not found")
		return
	}
	var input struct {
		Title            string `json:"title"`
		Markdown         string `json:"markdown"`
		HTML             string `json:"html"`
		CoverImageSource string `json:"coverImageSource"`
	}
	if !decodeBoundedJSON(w, r, customMediaPublishRequestBytes, &input) {
		return
	}
	input.Title = strings.TrimSpace(input.Title)
	input.CoverImageSource = strings.TrimSpace(input.CoverImageSource)
	if input.Title == "" || utf8.RuneCountInString(input.Title) > maxTitleRunes || len(input.Markdown) > maxContentBytes || len(input.HTML) > customMediaMaxHTMLBytes || len(input.CoverImageSource) > maxDocumentCoverSourceBytes {
		httpx.ErrorCode(w, http.StatusBadRequest, "custom_media_article_invalid", "Custom platform article is invalid")
		return
	}
	var endpointURL, name string
	var ciphertext []byte
	var enabled bool
	err := a.db.QueryRow(r.Context(), `
		SELECT name, endpoint_url, auth_token_ciphertext, enabled
		FROM custom_media_platforms
		WHERE platform_id = $1 AND user_id = $2
	`, platformID, user.ID).Scan(&name, &endpointURL, &ciphertext, &enabled)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Custom platform not found")
		return
	}
	if err != nil {
		log.Printf("custom media platform publish lookup: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if !enabled {
		httpx.ErrorCode(w, http.StatusConflict, "custom_media_platform_disabled", "Custom platform is disabled")
		return
	}
	endpointURL, err = normalizeCustomMediaEndpoint(endpointURL)
	if err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_custom_media_endpoint", err.Error())
		return
	}
	var revision int64
	err = a.db.QueryRow(r.Context(), `SELECT revision FROM documents WHERE doc_id = $1 AND user_id = $2 AND trashed_at IS NULL`, docID, user.ID).Scan(&revision)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Document not found")
		return
	}
	if err != nil {
		log.Printf("custom media document lookup: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	authToken := ""
	if len(ciphertext) > 0 {
		authToken, err = a.decryptCustomMediaToken(platformID, ciphertext)
		if err != nil {
			log.Printf("custom media platform token decrypt: %v", err)
			httpx.ErrorCode(w, http.StatusServiceUnavailable, "custom_media_credential_unavailable", "Custom platform credential is unavailable")
			return
		}
	}
	payload := map[string]any{
		"version": 1,
		"event":   "article.publish",
		"source": map[string]any{
			"app":          "koinote",
			"documentId":   docID,
			"revision":     revision,
			"platformName": name,
		},
		"article": map[string]string{
			"title":            input.Title,
			"markdown":         input.Markdown,
			"html":             input.HTML,
			"coverImageSource": input.CoverImageSource,
		},
	}
	body, err := json.Marshal(payload)
	if err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Could not build custom platform request")
		return
	}
	requestContext, cancel := context.WithTimeout(r.Context(), customMediaPublishTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(requestContext, http.MethodPost, endpointURL, bytes.NewReader(body))
	if err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_custom_media_endpoint", "Custom platform endpoint is invalid")
		return
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	if authToken != "" {
		request.Header.Set("Authorization", "Bearer "+authToken)
	}
	client := a.mediaHTTPClient
	if client == nil {
		client = newSafeLLMHTTPClient()
	}
	response, err := client.Do(request)
	if err != nil {
		log.Printf("custom media platform request %s: %v", name, err)
		httpx.ErrorCode(w, http.StatusBadGateway, "custom_media_publish_failed", "Custom platform request failed")
		return
	}
	defer response.Body.Close()
	responseBody, readErr := io.ReadAll(io.LimitReader(response.Body, customMediaMaxResponseBytes+1))
	if readErr != nil || len(responseBody) > customMediaMaxResponseBytes {
		httpx.ErrorCode(w, http.StatusBadGateway, "custom_media_publish_failed", "Custom platform returned an invalid response")
		return
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		log.Printf("custom media platform %s returned HTTP %d", platformID, response.StatusCode)
		httpx.ErrorCode(w, http.StatusBadGateway, "custom_media_publish_failed", "Custom platform rejected the article")
		return
	}
	var provider struct {
		URL string `json:"url"`
	}
	_ = json.Unmarshal(responseBody, &provider)
	httpx.JSON(w, http.StatusOK, map[string]any{"published": true, "url": strings.TrimSpace(provider.URL)})
}

func (a *App) loadMediaPlatformSettings(ctx context.Context, userID int) (mediaPlatformSettingsResponse, error) {
	var response mediaPlatformSettingsResponse
	settings, err := a.loadBuiltInMediaSettings(ctx, userID)
	if err != nil {
		return mediaPlatformSettingsResponse{}, err
	}
	response.Settings = settings
	rows, err := a.db.Query(ctx, `
		SELECT platform_id, name, endpoint_url, auth_token_hint, enabled, created_at, updated_at
		FROM custom_media_platforms WHERE user_id = $1
		ORDER BY created_at ASC, platform_id ASC
	`, userID)
	if err != nil {
		return mediaPlatformSettingsResponse{}, err
	}
	defer rows.Close()
	response.CustomPlatforms = make([]customMediaPlatformView, 0)
	for rows.Next() {
		var platform customMediaPlatformView
		if err := rows.Scan(&platform.PlatformID, &platform.Name, &platform.EndpointURL, &platform.AuthTokenHint, &platform.Enabled, &platform.CreatedAt, &platform.UpdatedAt); err != nil {
			return mediaPlatformSettingsResponse{}, err
		}
		response.CustomPlatforms = append(response.CustomPlatforms, platform)
	}
	return response, rows.Err()
}

func (a *App) loadBuiltInMediaSettings(ctx context.Context, userID int) (mediaPlatformSettingsView, error) {
	settings := mediaPlatformSettingsView{WechatEnabled: true, ZhihuEnabled: true, XEnabled: true}
	err := a.db.QueryRow(ctx, `
		SELECT wechat_enabled, zhihu_enabled, x_enabled
		FROM media_platform_settings WHERE user_id = $1
	`, userID).Scan(&settings.WechatEnabled, &settings.ZhihuEnabled, &settings.XEnabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return settings, nil
	}
	return settings, err
}

func (a *App) requireMediaPlatformEnabled(w http.ResponseWriter, r *http.Request, userID int, platform string) bool {
	settings, err := a.loadBuiltInMediaSettings(r.Context(), userID)
	if err != nil {
		log.Printf("media platform setting lookup: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return false
	}
	enabled := map[string]bool{"wechat": settings.WechatEnabled, "zhihu": settings.ZhihuEnabled, "x": settings.XEnabled}[platform]
	if !enabled {
		httpx.ErrorCode(w, http.StatusConflict, "media_platform_disabled", "This publishing platform is disabled")
		return false
	}
	return true
}

type customMediaPlatformInput struct {
	Name           string `json:"name"`
	EndpointURL    string `json:"endpointUrl"`
	AuthToken      string `json:"authToken"`
	ClearAuthToken bool   `json:"clearAuthToken"`
	Enabled        bool   `json:"enabled"`
}

func decodeCustomMediaPlatformInput(w http.ResponseWriter, r *http.Request) (customMediaPlatformInput, bool) {
	var input customMediaPlatformInput
	if !decodeBoundedJSON(w, r, customMediaPlatformRequestBytes, &input) {
		return customMediaPlatformInput{}, false
	}
	input.Name = strings.TrimSpace(input.Name)
	input.EndpointURL = strings.TrimSpace(input.EndpointURL)
	input.AuthToken = strings.TrimSpace(input.AuthToken)
	if input.Name == "" || utf8.RuneCountInString(input.Name) > customMediaMaxNameRunes {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_custom_media_name", "Custom platform name is required and must be at most 80 characters")
		return customMediaPlatformInput{}, false
	}
	if len(input.AuthToken) > customMediaMaxTokenBytes || (input.ClearAuthToken && input.AuthToken != "") || strings.ContainsAny(input.AuthToken, "\r\n") {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_custom_media_token", "Custom platform token is invalid or conflicts with token removal")
		return customMediaPlatformInput{}, false
	}
	normalized, err := normalizeCustomMediaEndpoint(input.EndpointURL)
	if err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_custom_media_endpoint", err.Error())
		return customMediaPlatformInput{}, false
	}
	input.EndpointURL = normalized
	return input, true
}

func normalizeCustomMediaEndpoint(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" || len(raw) > customMediaMaxEndpointBytes {
		return "", errors.New("Custom platform endpoint is required and must be at most 2048 bytes")
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") {
		return "", errors.New("Custom platform endpoint must be an absolute HTTP(S) URL")
	}
	if parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", errors.New("Custom platform endpoint cannot contain user info, query parameters, or a fragment")
	}
	if port := parsed.Port(); port != "" {
		value, err := strconv.Atoi(port)
		if err != nil || value < 1 || value > 65_535 {
			return "", errors.New("Custom platform endpoint has an invalid port")
		}
	}
	host := strings.ToLower(strings.TrimSuffix(parsed.Hostname(), "."))
	if host == "" || host == "localhost" || strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal") {
		return "", errors.New("Custom platform endpoint must use a public host")
	}
	if parsed.Scheme == "http" {
		return "", errors.New("Custom platform endpoint must use HTTPS")
	}
	if address, err := netip.ParseAddr(host); err == nil && !isPublicLLMEndpointIP(address) {
		return "", errors.New("Custom platform endpoint cannot use a private or reserved address")
	}
	parsed.Path = strings.TrimRight(parsed.Path, "/")
	parsed.RawPath = strings.TrimRight(parsed.RawPath, "/")
	return parsed.String(), nil
}

func mediaTokenHint(token string) string {
	runes := []rune(token)
	if len(runes) < 8 {
		if token == "" {
			return ""
		}
		return "configured"
	}
	return "••••" + string(runes[len(runes)-4:])
}

func (a *App) customMediaCredentialCipher() (cipher.AEAD, error) {
	secret := strings.TrimSpace(a.cfg.CustomMediaCredentialEncryptionKey)
	if secret == "" && !a.cfg.IsProduction() {
		secret = strings.TrimSpace(a.cfg.SessionSecret)
	}
	if secret == "" {
		return nil, errors.New("custom media credential encryption key is empty")
	}
	key := sha256.Sum256([]byte("koinote:custom-media-credential:v1:" + secret))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func (a *App) encryptCustomMediaToken(platformID, token string) ([]byte, error) {
	aead, err := a.customMediaCredentialCipher()
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return aead.Seal(nonce, nonce, []byte(token), []byte(platformID)), nil
}

func (a *App) decryptCustomMediaToken(platformID string, ciphertext []byte) (string, error) {
	aead, err := a.customMediaCredentialCipher()
	if err != nil {
		return "", err
	}
	if len(ciphertext) < aead.NonceSize() {
		return "", errors.New("custom media token ciphertext is truncated")
	}
	plain, err := aead.Open(nil, ciphertext[:aead.NonceSize()], ciphertext[aead.NonceSize():], []byte(platformID))
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

func decodeBoundedJSON(w http.ResponseWriter, r *http.Request, limit int64, target any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	decoder := json.NewDecoder(r.Body)
	err := decoder.Decode(target)
	if err == nil {
		var extra any
		err = decoder.Decode(&extra)
		if err == io.EOF {
			return true
		}
		if err == nil {
			err = errors.New("multiple JSON values")
		}
	}
	if err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			httpx.ErrorCode(w, http.StatusRequestEntityTooLarge, "content_too_large", "Request body too large")
		} else {
			httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid request")
		}
		return false
	}
	return true
}
