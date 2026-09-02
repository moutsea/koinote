package server

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"koinote/backend/internal/httpx"
)

const (
	zhihuOpenAPIBaseURL       = "https://openapi.zhihu.com"
	zhihuPublishPath          = "/openapi/publish"
	zhihuAccountRequestBytes  = 16 << 10
	zhihuPublishRequestBytes  = 3 << 20
	zhihuPublishHTMLMaxBytes  = 2 << 20
	zhihuTitleMaxRunes        = 200
	zhihuPublishLimit         = 10
	zhihuPublishWindow        = time.Hour
	zhihuRequestTimeout       = 45 * time.Second
	zhihuProviderResponseSize = 1 << 20
)

var (
	zhihuAppKeyPattern          = regexp.MustCompile(`^[A-Za-z0-9_-]{1,160}$`)
	zhihuImageTagPattern        = regexp.MustCompile(`(?i)<img(?:\s|/?>)`)
	errZhihuAccountNotBound     = errors.New("zhihu account is not bound")
	errZhihuCredentialCrypto    = errors.New("zhihu credential encryption is unavailable")
	errZhihuProviderUnavailable = errors.New("zhihu provider is unavailable")
	errZhihuPublishFailed       = errors.New("zhihu article publish failed")
	errZhihuImagesUnsupported   = errors.New("zhihu article images are unsupported")
)

type zhihuAccountView struct {
	AppKey     string    `json:"appKey"`
	SecretHint string    `json:"secretHint"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

type zhihuCredential struct {
	AppKey    string
	AppSecret string
}

type zhihuPublishResponse struct {
	Status *int   `json:"status"`
	Msg    string `json:"msg"`
	Data   struct {
		ContentToken string `json:"content_token"`
		URL          string `json:"url"`
	} `json:"data"`
}

func newZhihuAPIHTTPClient() *http.Client {
	transport := http.DefaultTransport
	if defaultTransport, ok := http.DefaultTransport.(*http.Transport); ok {
		cloned := defaultTransport.Clone()
		cloned.Proxy = nil
		transport = cloned
	}
	return &http.Client{
		Transport: transport,
		Timeout:   zhihuRequestTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("zhihu API redirects are disabled")
		},
	}
}

func (a *App) zhihuAccountGet(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	view, err := a.loadZhihuAccountView(r.Context(), user.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.JSON(w, http.StatusOK, map[string]any{"account": nil})
		return
	}
	if err != nil {
		log.Printf("zhihu account get: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"account": view})
}

func (a *App) zhihuAccountPut(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	var input struct {
		AppKey    string `json:"appKey"`
		AppSecret string `json:"appSecret"`
	}
	if !decodeZhihuJSONBody(w, r, zhihuAccountRequestBytes, &input) {
		return
	}
	input.AppKey = strings.TrimSpace(input.AppKey)
	input.AppSecret = strings.TrimSpace(input.AppSecret)
	if !zhihuAppKeyPattern.MatchString(input.AppKey) || utf8.RuneCountInString(input.AppSecret) > 8<<10 {
		httpx.ErrorCode(w, http.StatusBadRequest, "zhihu_account_invalid", "Invalid Zhihu OpenAPI credentials")
		return
	}

	var existingAppKey string
	var existingCiphertext []byte
	err := a.db.QueryRow(r.Context(), `
		SELECT app_key, app_secret_ciphertext
		FROM zhihu_accounts
		WHERE user_id = $1
	`, user.ID).Scan(&existingAppKey, &existingCiphertext)
	existing := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		log.Printf("zhihu account lookup: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if !existing && input.AppSecret == "" {
		httpx.ErrorCode(w, http.StatusBadRequest, "zhihu_app_secret_required", "AppSecret is required when binding a Zhihu account")
		return
	}
	if existing && input.AppSecret == "" && input.AppKey != existingAppKey {
		httpx.ErrorCode(w, http.StatusBadRequest, "zhihu_app_secret_required", "AppSecret is required when changing App Key")
		return
	}

	ciphertext := existingCiphertext
	secretHint := "configured"
	if input.AppSecret != "" {
		ciphertext, err = a.encryptZhihuCredential(user.ID, input.AppSecret)
		if err != nil {
			log.Printf("zhihu account encrypt: %v", err)
			httpx.ErrorCode(w, http.StatusServiceUnavailable, "zhihu_credential_unavailable", "Zhihu credential encryption is unavailable")
			return
		}
	}

	var view zhihuAccountView
	err = a.db.QueryRow(r.Context(), `
		INSERT INTO zhihu_accounts (user_id, app_key, app_secret_ciphertext, app_secret_hint)
		VALUES ($1, $2, $3, $4)
		ON CONFLICT (user_id) DO UPDATE SET
			app_key = EXCLUDED.app_key,
			app_secret_ciphertext = EXCLUDED.app_secret_ciphertext,
			app_secret_hint = EXCLUDED.app_secret_hint,
			updated_at = now()
		RETURNING app_key, app_secret_hint, updated_at
	`, user.ID, input.AppKey, ciphertext, secretHint).Scan(
		&view.AppKey, &view.SecretHint, &view.UpdatedAt,
	)
	if err != nil {
		if isUniqueViolation(err) {
			httpx.ErrorCode(w, http.StatusConflict, "zhihu_app_key_already_bound", "This Zhihu account is already bound")
			return
		}
		log.Printf("zhihu account upsert: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"account": view})
}

func (a *App) zhihuAccountDelete(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	if _, err := a.db.Exec(r.Context(), `DELETE FROM zhihu_accounts WHERE user_id = $1`, user.ID); err != nil {
		log.Printf("zhihu account delete: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"success": true})
}

func (a *App) zhihuPublish(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	var input struct {
		Title string `json:"title"`
		HTML  string `json:"html"`
	}
	if !decodeZhihuJSONBody(w, r, zhihuPublishRequestBytes, &input) {
		return
	}
	input.Title = strings.TrimSpace(input.Title)
	input.HTML = strings.TrimSpace(input.HTML)
	if input.Title == "" || utf8.RuneCountInString(input.Title) > zhihuTitleMaxRunes || input.HTML == "" || len(input.HTML) > zhihuPublishHTMLMaxBytes {
		httpx.ErrorCode(w, http.StatusBadRequest, "zhihu_publish_input_invalid", "Invalid Zhihu article title or content")
		return
	}
	if zhihuImageTagPattern.MatchString(input.HTML) {
		writeZhihuError(w, errZhihuImagesUnsupported)
		return
	}
	var owned bool
	if err := a.db.QueryRow(r.Context(), `
		SELECT EXISTS (
			SELECT 1 FROM documents
			WHERE doc_id = $1 AND user_id = $2 AND trashed_at IS NULL
		)
	`, strings.TrimSpace(r.PathValue("docId")), user.ID).Scan(&owned); err != nil {
		log.Printf("zhihu publish document ownership: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if !owned {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Document not found")
		return
	}
	credential, err := a.loadZhihuCredential(r.Context(), user.ID)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.ErrorCode(w, http.StatusConflict, "zhihu_account_not_bound", "Bind a Zhihu account first")
		return
	}
	if err != nil {
		log.Printf("zhihu publish credential: %v", err)
		writeZhihuError(w, err)
		return
	}
	if !a.rateLimit().allow("zhihu-publish:"+strconv.Itoa(user.ID), zhihuPublishLimit, zhihuPublishWindow) {
		httpx.ErrorCode(w, http.StatusTooManyRequests, "too_many_requests", "Too many Zhihu publish requests")
		return
	}

	result, err := a.publishZhihuArticle(r.Context(), credential, input.Title, input.HTML)
	if err != nil {
		log.Printf("zhihu publish: %v", err)
		writeZhihuError(w, err)
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"published":    true,
		"contentToken": result.Data.ContentToken,
		"url":          result.Data.URL,
	})
}

func (a *App) publishZhihuArticle(ctx context.Context, credential zhihuCredential, title, htmlContent string) (zhihuPublishResponse, error) {
	baseURL := strings.TrimRight(strings.TrimSpace(a.zhihuAPIBaseURL), "/")
	if baseURL == "" {
		baseURL = zhihuOpenAPIBaseURL
	}
	logID, err := randomUUID()
	if err != nil {
		return zhihuPublishResponse{}, errors.Join(errZhihuPublishFailed, err)
	}
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	extraInfo := ""
	signature := zhihuOpenAPISignature(credential.AppKey, timestamp, logID, extraInfo, credential.AppSecret)
	payload, err := json.Marshal(map[string]any{
		"type":         "article",
		"confirmed":    true,
		"confirm_note": "confirmed by user before direct publish",
		"content": map[string]any{
			"title":                     title,
			"html":                      htmlContent,
			"comment_permission":        "all",
			"table_of_contents_enabled": false,
		},
	})
	if err != nil {
		return zhihuPublishResponse{}, errors.Join(errZhihuPublishFailed, err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+zhihuPublishPath, bytes.NewReader(payload))
	if err != nil {
		return zhihuPublishResponse{}, errors.Join(errZhihuPublishFailed, err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-App-Key", credential.AppKey)
	request.Header.Set("X-Timestamp", timestamp)
	request.Header.Set("X-Log-Id", logID)
	request.Header.Set("X-Extra-Info", extraInfo)
	request.Header.Set("X-Sign", signature)
	client := a.zhihuAPIHTTPClient
	if client == nil {
		client = newZhihuAPIHTTPClient()
	}
	response, err := client.Do(request)
	if err != nil {
		return zhihuPublishResponse{}, errors.Join(errZhihuProviderUnavailable, err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, zhihuProviderResponseSize+1))
	if err != nil || len(body) > zhihuProviderResponseSize {
		return zhihuPublishResponse{}, errors.Join(errZhihuProviderUnavailable, err)
	}
	var result zhihuPublishResponse
	if err := json.Unmarshal(body, &result); err != nil {
		return zhihuPublishResponse{}, errors.Join(errZhihuProviderUnavailable, err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return result, fmt.Errorf("%w: provider HTTP %d", errZhihuProviderUnavailable, response.StatusCode)
	}
	if result.Status == nil || *result.Status != 0 {
		return result, fmt.Errorf("%w: %s", errZhihuPublishFailed, strings.TrimSpace(result.Msg))
	}
	if strings.TrimSpace(result.Data.ContentToken) == "" || !validZhihuPublishedURL(result.Data.URL) {
		return result, errors.Join(errZhihuPublishFailed, errors.New("provider returned an invalid article result"))
	}
	return result, nil
}

func validZhihuPublishedURL(raw string) bool {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.Hostname() == "" {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	return host == "zhihu.com" || strings.HasSuffix(host, ".zhihu.com")
}

func zhihuOpenAPISignature(appKey, timestamp, logID, extraInfo, appSecret string) string {
	signString := "app_key:" + appKey + "|ts:" + timestamp + "|logid:" + logID + "|extra_info:" + extraInfo
	hash := hmac.New(sha256.New, []byte(appSecret))
	_, _ = hash.Write([]byte(signString))
	return base64.StdEncoding.EncodeToString(hash.Sum(nil))
}

func (a *App) loadZhihuAccountView(ctx context.Context, userID int) (zhihuAccountView, error) {
	var view zhihuAccountView
	err := a.db.QueryRow(ctx, `
		SELECT app_key, 'configured', updated_at
		FROM zhihu_accounts
		WHERE user_id = $1
	`, userID).Scan(&view.AppKey, &view.SecretHint, &view.UpdatedAt)
	return view, err
}

func (a *App) loadZhihuCredential(ctx context.Context, userID int) (zhihuCredential, error) {
	var credential zhihuCredential
	var ciphertext []byte
	if err := a.db.QueryRow(ctx, `
		SELECT app_key, app_secret_ciphertext
		FROM zhihu_accounts
		WHERE user_id = $1
	`, userID).Scan(&credential.AppKey, &ciphertext); err != nil {
		return zhihuCredential{}, err
	}
	secret, err := a.decryptZhihuCredential(userID, ciphertext)
	if err != nil {
		return zhihuCredential{}, errors.Join(errZhihuCredentialCrypto, err)
	}
	credential.AppSecret = secret
	return credential, nil
}

func (a *App) zhihuCredentialCipher() (cipher.AEAD, error) {
	secret := strings.TrimSpace(a.cfg.ZhihuCredentialEncryptionKey)
	if secret == "" && !a.cfg.IsProduction() {
		secret = a.cfg.SessionSecret
	}
	if secret == "" {
		return nil, errZhihuCredentialCrypto
	}
	key := sha256.Sum256([]byte("koinote:zhihu-credential:v1:" + secret))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func (a *App) encryptZhihuCredential(userID int, secret string) ([]byte, error) {
	aead, err := a.zhihuCredentialCipher()
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return aead.Seal(nonce, nonce, []byte(secret), []byte(strconv.Itoa(userID))), nil
}

func (a *App) decryptZhihuCredential(userID int, ciphertext []byte) (string, error) {
	aead, err := a.zhihuCredentialCipher()
	if err != nil {
		return "", err
	}
	if len(ciphertext) < aead.NonceSize() {
		return "", errors.New("zhihu credential ciphertext is truncated")
	}
	nonce := ciphertext[:aead.NonceSize()]
	plain, err := aead.Open(nil, nonce, ciphertext[aead.NonceSize():], []byte(strconv.Itoa(userID)))
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

func decodeZhihuJSONBody(w http.ResponseWriter, r *http.Request, limit int64, target any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	decoder := json.NewDecoder(r.Body)
	if err := decoder.Decode(target); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			httpx.ErrorCode(w, http.StatusRequestEntityTooLarge, "bad_request", "Request body is too large")
			return false
		}
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid request")
		return false
	}
	return true
}

func writeZhihuError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errZhihuAccountNotBound):
		httpx.ErrorCode(w, http.StatusConflict, "zhihu_account_not_bound", "Bind a Zhihu account first")
	case errors.Is(err, errZhihuCredentialCrypto):
		httpx.ErrorCode(w, http.StatusServiceUnavailable, "zhihu_credential_unavailable", "Zhihu credential encryption is unavailable")
	case errors.Is(err, errZhihuProviderUnavailable):
		httpx.ErrorCode(w, http.StatusBadGateway, "zhihu_provider_unavailable", "Zhihu is temporarily unavailable")
	case errors.Is(err, errZhihuPublishFailed):
		httpx.ErrorCode(w, http.StatusBadGateway, "zhihu_publish_failed", "Zhihu rejected the article")
	case errors.Is(err, errZhihuImagesUnsupported):
		httpx.ErrorCode(w, http.StatusBadRequest, "zhihu_images_unsupported", "Zhihu publishing currently does not support article images")
	default:
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
	}
}
