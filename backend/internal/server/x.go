package server

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"

	"koinote/backend/internal/httpx"
)

const (
	xAPIBaseURL            = "https://api.x.com"
	xTrustedImageHost      = "img.koinote.app"
	xTweetPath             = "/2/tweets"
	xMediaUploadURL        = "https://upload.twitter.com/1.1/media/upload.json"
	xAccountRequestBytes   = 64 << 10
	xPublishRequestBytes   = 3 << 20
	xPublishMaxPosts       = 25
	xPublishMaxImages      = 20
	xPostMaxRunes          = 280
	xPostMaxImages         = 4
	xArticleMaxWeight      = 10_000
	xRemoteImageMaxBytes   = 10 << 20
	xUploadImageMaxBytes   = 5 << 20
	xPublishLimit          = 10
	xPublishWindow         = time.Hour
	xPublishTimeout        = 5 * time.Minute
	xArticlePublishCredits = int64(20)
	xArticleReservationTTL = xPublishTimeout + 2*time.Minute
	xRequestTimeout        = 60 * time.Second
	xProviderResponseSize  = 1 << 20
)

var (
	xAPIKeyPattern             = regexp.MustCompile(`^[A-Za-z0-9_-]{1,256}$`)
	xURLPattern                = regexp.MustCompile(`(?i)https?://[^\s<>"']+`)
	xArticleFrontmatterPattern = regexp.MustCompile(`(?s)^---[ \t]*\r?\n.*?\r?\n---[ \t]*(?:\r?\n|$)`)
	xArticleImagePattern       = regexp.MustCompile(`!\[([^\]]*)\]\([^\r\n)]*\)`)
	xArticleIDPattern          = regexp.MustCompile(`^[0-9]{1,19}$`)
	errXAccountNotBound        = errors.New("x account is not bound")
	errXOAuth2AccountNotBound  = errors.New("x oauth2 account is not bound")
	errXOAuth2NotConfigured    = errors.New("x oauth2 is not configured")
	errXOAuth2TokenInvalid     = errors.New("x oauth2 token is invalid")
	errXCredentialRequired     = errors.New("x api credentials are required")
	errXCredentialCrypto       = errors.New("x credential encryption is unavailable")
	errXProviderUnavailable    = errors.New("x provider is unavailable")
	errXPublishFailed          = errors.New("x post failed")
	errXArticleUnavailable     = errors.New("x articles are unavailable for this account")
	errXArticleDraftOnly       = errors.New("x article draft was created but not published")
	errXImageFailed            = errors.New("x image upload failed")
	errXImageSourceUnavailable = errors.New("x image source unavailable")
)

type xAccountView struct {
	APIKey     string    `json:"apiKey"`
	SecretHint string    `json:"secretHint"`
	UpdatedAt  time.Time `json:"updatedAt"`
}

type xCredential struct {
	APIKey            string
	APISecret         string
	AccessToken       string
	AccessTokenSecret string
}

type xPublishImageInput struct {
	PostIndex int    `json:"postIndex"`
	Source    string `json:"source"`
	Alt       string `json:"alt,omitempty"`
}

type xPublishInput struct {
	Mode     string               `json:"mode,omitempty"`
	Title    string               `json:"title,omitempty"`
	Markdown string               `json:"markdown,omitempty"`
	Posts    []string             `json:"posts,omitempty"`
	Images   []xPublishImageInput `json:"images,omitempty"`
}

type xPublishResult struct {
	URL         string
	PostCount   int
	PublishedID string
	DraftID     string
}

type xTweetResponse struct {
	Data struct {
		ID string `json:"id"`
	} `json:"data"`
}

type xMediaResponse struct {
	MediaIDString string `json:"media_id_string"`
}

func newXAPIHTTPClient() *http.Client {
	transport := http.DefaultTransport
	if defaultTransport, ok := http.DefaultTransport.(*http.Transport); ok {
		cloned := defaultTransport.Clone()
		cloned.Proxy = nil
		transport = cloned
	}
	return &http.Client{
		Transport: transport,
		Timeout:   xRequestTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("x API redirects are disabled")
		},
	}
}

func newTrustedXImageHTTPClient() *http.Client {
	transport := http.DefaultTransport
	if defaultTransport, ok := http.DefaultTransport.(*http.Transport); ok {
		transport = defaultTransport.Clone()
	}
	return &http.Client{
		Transport: transport,
		Timeout:   xRequestTimeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("trusted image redirects are disabled")
		},
	}
}

func (a *App) xAccountGet(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	manual, manualErr := a.loadXAccountView(r.Context(), user.ID)
	if manualErr != nil && !errors.Is(manualErr, pgx.ErrNoRows) {
		log.Printf("x account get manual: %v", manualErr)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	oauth2, oauth2Err := a.loadXOAuth2AccountView(r.Context(), user.ID)
	if oauth2Err != nil && !errors.Is(oauth2Err, pgx.ErrNoRows) {
		log.Printf("x account get oauth2: %v", oauth2Err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	var manualView *xAccountView
	if manualErr == nil {
		manualView = &manual
	}
	var oauth2View *xOAuth2AccountView
	if oauth2Err == nil {
		oauth2View = &oauth2
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"account": manualView,
		"oauth2":  oauth2View,
	})
}

func (a *App) xAccountPut(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	var input struct {
		APIKey            string `json:"apiKey"`
		APISecret         string `json:"apiSecret"`
		AccessToken       string `json:"accessToken"`
		AccessTokenSecret string `json:"accessTokenSecret"`
	}
	if !decodeXJSONBody(w, r, xAccountRequestBytes, &input) {
		return
	}
	input.APIKey = strings.TrimSpace(input.APIKey)
	input.APISecret = strings.TrimSpace(input.APISecret)
	input.AccessToken = strings.TrimSpace(input.AccessToken)
	input.AccessTokenSecret = strings.TrimSpace(input.AccessTokenSecret)
	if !xAPIKeyPattern.MatchString(input.APIKey) ||
		utf8.RuneCountInString(input.APISecret) > 8<<10 ||
		utf8.RuneCountInString(input.AccessToken) > 8<<10 ||
		utf8.RuneCountInString(input.AccessTokenSecret) > 8<<10 {
		httpx.ErrorCode(w, http.StatusBadRequest, "x_account_invalid", "Invalid X API credentials")
		return
	}

	var existingAPIKey string
	var err error
	var existingAPISecretCiphertext []byte
	var existingAccessTokenCiphertext []byte
	var existingAccessTokenSecretCiphertext []byte
	err = a.db.QueryRow(r.Context(), `
		SELECT api_key, api_secret_ciphertext, access_token_ciphertext,
		       access_token_secret_ciphertext
		FROM x_accounts
		WHERE user_id = $1
	`, user.ID).Scan(
		&existingAPIKey,
		&existingAPISecretCiphertext,
		&existingAccessTokenCiphertext,
		&existingAccessTokenSecretCiphertext,
	)
	existingAccount := err == nil
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		log.Printf("x account lookup: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if !existingAccount && (input.APISecret == "" || input.AccessToken == "" || input.AccessTokenSecret == "") {
		httpx.ErrorCode(w, http.StatusBadRequest, "x_credentials_required", "All X API credentials are required when binding")
		return
	}
	if existingAccount && input.APIKey != existingAPIKey &&
		(input.APISecret == "" || input.AccessToken == "" || input.AccessTokenSecret == "") {
		httpx.ErrorCode(w, http.StatusBadRequest, "x_credentials_required", "All X API credentials are required when changing the API key")
		return
	}

	apiSecretCiphertext := existingAPISecretCiphertext
	accessTokenCiphertext := existingAccessTokenCiphertext
	accessTokenSecretCiphertext := existingAccessTokenSecretCiphertext
	if input.APISecret != "" {
		apiSecretCiphertext, err = a.encryptXCredential(user.ID, "api-secret", input.APISecret)
		if err != nil {
			log.Printf("x api secret encrypt: %v", err)
			writeXError(w, errXCredentialCrypto)
			return
		}
	}
	if input.AccessToken != "" {
		accessTokenCiphertext, err = a.encryptXCredential(user.ID, "access-token", input.AccessToken)
		if err != nil {
			log.Printf("x access token encrypt: %v", err)
			writeXError(w, errXCredentialCrypto)
			return
		}
	}
	if input.AccessTokenSecret != "" {
		accessTokenSecretCiphertext, err = a.encryptXCredential(user.ID, "access-token-secret", input.AccessTokenSecret)
		if err != nil {
			log.Printf("x access token secret encrypt: %v", err)
			writeXError(w, errXCredentialCrypto)
			return
		}
	}

	var view xAccountView
	err = a.db.QueryRow(r.Context(), `
		INSERT INTO x_accounts (
			user_id, api_key, api_secret_ciphertext, access_token_ciphertext,
			access_token_secret_ciphertext
		)
		VALUES ($1, $2, $3, $4, $5)
		ON CONFLICT (user_id) DO UPDATE SET
			api_key = EXCLUDED.api_key,
			api_secret_ciphertext = EXCLUDED.api_secret_ciphertext,
			access_token_ciphertext = EXCLUDED.access_token_ciphertext,
			access_token_secret_ciphertext = EXCLUDED.access_token_secret_ciphertext,
			updated_at = now()
		RETURNING api_key, 'configured', updated_at
	`, user.ID, input.APIKey, apiSecretCiphertext, accessTokenCiphertext, accessTokenSecretCiphertext).Scan(
		&view.APIKey, &view.SecretHint, &view.UpdatedAt,
	)
	if err != nil {
		log.Printf("x account upsert: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"account": view})
}

func (a *App) xAccountDelete(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	if _, err := a.db.Exec(r.Context(), `DELETE FROM x_accounts WHERE user_id = $1`, user.ID); err != nil {
		log.Printf("x account delete: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"success": true})
}

func (a *App) xPublish(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	var input xPublishInput
	if !decodeXJSONBody(w, r, xPublishRequestBytes, &input) {
		return
	}
	input.Mode = strings.ToLower(strings.TrimSpace(input.Mode))
	if input.Mode == "" {
		input.Mode = "oauth1"
	}
	if input.Mode != "oauth1" && input.Mode != "oauth2" {
		httpx.ErrorCode(w, http.StatusBadRequest, "x_publish_input_invalid", "Unsupported X publishing mode")
		return
	}
	articleRequest := input.Mode == "oauth2" && (strings.TrimSpace(input.Title) != "" || strings.TrimSpace(input.Markdown) != "")
	imagesByPost := make(map[int][]xPublishImageInput)
	if articleRequest {
		input.Title = strings.TrimSpace(input.Title)
		input.Markdown = normalizeXArticleMarkdown(input.Markdown)
		if input.Title == "" || (input.Markdown == "" && len(input.Images) == 0) || len(input.Images) > xPublishMaxImages {
			httpx.ErrorCode(w, http.StatusBadRequest, "x_publish_input_invalid", "Invalid X Article")
			return
		}
		if xTextWeight(input.Markdown) > xArticleMaxWeight {
			httpx.ErrorCode(w, http.StatusBadRequest, "x_article_too_long", "X Article content exceeds the 10,000 character limit")
			return
		}
		for _, image := range input.Images {
			if strings.TrimSpace(image.Source) == "" {
				httpx.ErrorCode(w, http.StatusBadRequest, "x_publish_input_invalid", "Invalid X Article image")
				return
			}
		}
	} else {
		if len(input.Posts) == 0 || len(input.Posts) > xPublishMaxPosts || len(input.Images) > xPublishMaxImages {
			httpx.ErrorCode(w, http.StatusBadRequest, "x_publish_input_invalid", "Invalid X post thread")
			return
		}
		for _, post := range input.Posts {
			if strings.TrimSpace(post) == "" || xTextWeight(post) > xPostMaxRunes {
				httpx.ErrorCode(w, http.StatusBadRequest, "x_publish_input_invalid", "Each X post must contain 1 to 280 characters")
				return
			}
		}
		for _, image := range input.Images {
			if image.PostIndex < 0 || image.PostIndex >= len(input.Posts) || strings.TrimSpace(image.Source) == "" {
				httpx.ErrorCode(w, http.StatusBadRequest, "x_publish_input_invalid", "Invalid X image attachment")
				return
			}
			imagesByPost[image.PostIndex] = append(imagesByPost[image.PostIndex], image)
			if len(imagesByPost[image.PostIndex]) > xPostMaxImages {
				httpx.ErrorCode(w, http.StatusBadRequest, "x_publish_input_invalid", "Each X post supports at most four images")
				return
			}
		}
	}

	var owned bool
	if err := a.db.QueryRow(r.Context(), `
		SELECT EXISTS (
			SELECT 1 FROM documents
			WHERE doc_id = $1 AND user_id = $2 AND trashed_at IS NULL
		)
	`, strings.TrimSpace(r.PathValue("docId")), user.ID).Scan(&owned); err != nil {
		log.Printf("x publish document ownership: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if !owned {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Document not found")
		return
	}
	var credential xCredential
	var oauth2Credential xOAuth2Credential
	var err error
	if input.Mode == "oauth2" {
		oauth2Credential, err = a.loadXOAuth2Credential(r.Context(), user.ID)
		if errors.Is(err, pgx.ErrNoRows) {
			writeXError(w, errXOAuth2AccountNotBound)
			return
		}
		if err != nil {
			log.Printf("x publish oauth2 credential: %v", err)
			writeXError(w, err)
			return
		}
	} else {
		credential, err = a.loadXCredential(r.Context(), user.ID)
		if errors.Is(err, pgx.ErrNoRows) {
			writeXError(w, errXAccountNotBound)
			return
		}
		if err != nil {
			log.Printf("x publish credential: %v", err)
			writeXError(w, err)
			return
		}
	}
	if !a.rateLimit().allow("x-publish:"+strconv.Itoa(user.ID), xPublishLimit, xPublishWindow) {
		httpx.ErrorCode(w, http.StatusTooManyRequests, "too_many_requests", "Too many X publish requests")
		return
	}
	var articleReservation creditReservation
	articleCreditsCommitted := false
	if articleRequest {
		articleReservation, err = a.reserveStandaloneCredits(
			r.Context(),
			user.ID,
			xArticlePublishCredits,
			xArticleReservationTTL,
		)
		if errors.Is(err, errInsufficientCredits) {
			httpx.ErrorCode(w, http.StatusPaymentRequired, "insufficient_credits", "Not enough credits for X Article publishing")
			return
		}
		if err != nil {
			log.Printf("x article reserve credits: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		defer func() {
			if articleCreditsCommitted {
				return
			}
			cleanupContext, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			if _, releaseErr := a.releaseCreditReservation(cleanupContext, user.ID, articleReservation.ReservationID); releaseErr != nil &&
				!errors.Is(releaseErr, errCreditReservationNotFound) {
				log.Printf("x article release credits: %v", releaseErr)
			}
		}()
	}

	publishContext, cancelPublish := context.WithTimeout(r.Context(), xPublishTimeout)
	defer cancelPublish()
	var result xPublishResult
	if articleRequest {
		result, err = a.publishXArticleOAuth2(publishContext, oauth2Credential, input.Title, input.Markdown, input.Images)
	} else if input.Mode == "oauth2" {
		result, err = a.publishXThreadOAuth2(publishContext, oauth2Credential, input.Posts, imagesByPost)
	} else {
		result, err = a.publishXThread(publishContext, credential, input.Posts, imagesByPost)
	}
	if err != nil {
		log.Printf("x publish: %v", err)
		if result.DraftID != "" {
			if articleRequest {
				if _, _, commitErr := a.commitCreditReservation(
					r.Context(),
					user.ID,
					articleReservation.ReservationID,
					int(xArticlePublishCredits*creditTokensPerCredit),
					map[string]any{"feature": "x_article_publish", "source": "x", "result": "draft_only"},
				); commitErr != nil {
					log.Printf("x article commit credits after draft creation: %v", commitErr)
					httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Article draft was created, but usage could not be recorded")
					return
				}
				articleCreditsCommitted = true
			}
			writeXError(w, errXArticleDraftOnly)
			return
		}
		if result.PostCount > 0 {
			httpx.ErrorCode(w, http.StatusBadGateway, "x_partial_publish", "The X thread was partially published; check X before retrying")
			return
		}
		writeXError(w, err)
		return
	}
	if articleRequest {
		if _, _, commitErr := a.commitCreditReservation(
			r.Context(),
			user.ID,
			articleReservation.ReservationID,
			int(xArticlePublishCredits*creditTokensPerCredit),
			map[string]any{"feature": "x_article_publish", "source": "x", "result": "published"},
		); commitErr != nil {
			log.Printf("x article commit credits: %v", commitErr)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Article was published, but usage could not be recorded")
			return
		}
		articleCreditsCommitted = true
	}
	httpx.JSON(w, http.StatusOK, map[string]any{
		"published": true,
		"url":       result.URL,
		"postCount": result.PostCount,
		"contentType": func() string {
			if articleRequest {
				return "article"
			}
			return "thread"
		}(),
	})
}

func xTextWeight(value string) int {
	weight := 0
	last := 0
	for _, match := range xURLPattern.FindAllStringIndex(value, -1) {
		for _, runeValue := range value[last:match[0]] {
			weight += xRuneWeight(runeValue)
		}
		weight += xTransformedURLLength
		last = match[1]
	}
	for _, runeValue := range value[last:] {
		weight += xRuneWeight(runeValue)
	}
	return weight
}

func normalizeXArticleMarkdown(value string) string {
	value = strings.TrimPrefix(value, "\ufeff")
	value = xArticleFrontmatterPattern.ReplaceAllString(value, "")
	value = xArticleImagePattern.ReplaceAllString(value, "$1")
	return strings.TrimSpace(value)
}

const xTransformedURLLength = 23

func xRuneWeight(runeValue rune) int {
	if runeValue <= 0x10ff ||
		(runeValue >= 0x2000 && runeValue <= 0x200d) ||
		(runeValue >= 0x2010 && runeValue <= 0x201f) ||
		(runeValue >= 0x2032 && runeValue <= 0x2037) {
		return 1
	}
	return 2
}

func (a *App) publishXThread(ctx context.Context, credential xCredential, posts []string, imagesByPost map[int][]xPublishImageInput) (xPublishResult, error) {
	return a.publishXThreadWith(ctx, posts, imagesByPost,
		func(ctx context.Context, image []byte) (string, error) {
			return a.uploadXImage(ctx, credential, image)
		},
		func(ctx context.Context, payload map[string]any) (string, error) {
			return a.createXTweet(ctx, credential, payload)
		},
	)
}

func (a *App) publishXThreadWith(
	ctx context.Context,
	posts []string,
	imagesByPost map[int][]xPublishImageInput,
	upload func(context.Context, []byte) (string, error),
	create func(context.Context, map[string]any) (string, error),
) (xPublishResult, error) {
	mediaCache := make(map[string]string)
	previousID := ""
	firstID := ""
	publishedCount := 0
	for index, post := range posts {
		mediaIDs := make([]string, 0, len(imagesByPost[index]))
		for _, image := range imagesByPost[index] {
			source := strings.TrimSpace(image.Source)
			mediaID := mediaCache[source]
			if mediaID == "" {
				raw, err := a.readXImage(ctx, source)
				if err != nil {
					if errors.Is(err, errXImageSourceUnavailable) {
						return xPublishResult{PostCount: publishedCount}, errors.Join(errXImageSourceUnavailable, err)
					}
					return xPublishResult{PostCount: publishedCount}, errors.Join(errXImageFailed, err)
				}
				prepared, err := prepareWechatContentImage(raw)
				if err != nil || len(prepared) > xUploadImageMaxBytes {
					return xPublishResult{PostCount: publishedCount}, errors.Join(errXImageFailed, errors.New("image cannot fit X limits"))
				}
				mediaID, err = upload(ctx, prepared)
				if err != nil {
					return xPublishResult{PostCount: publishedCount}, errors.Join(errXImageFailed, err)
				}
				mediaCache[source] = mediaID
			}
			mediaIDs = append(mediaIDs, mediaID)
		}

		payload := map[string]any{"text": strings.TrimSpace(post)}
		if len(mediaIDs) > 0 {
			payload["media"] = map[string]any{"media_ids": mediaIDs}
		}
		if previousID != "" {
			payload["reply"] = map[string]string{"in_reply_to_tweet_id": previousID}
		}
		id, err := create(ctx, payload)
		if err != nil {
			return xPublishResult{PostCount: publishedCount}, errors.Join(errXPublishFailed, err)
		}
		if firstID == "" {
			firstID = id
		}
		previousID = id
		publishedCount++
	}
	return xPublishResult{
		URL:         "https://x.com/i/status/" + firstID,
		PostCount:   len(posts),
		PublishedID: firstID,
	}, nil
}

func (a *App) createXTweet(ctx context.Context, credential xCredential, payload map[string]any) (string, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, xAPIBaseURL+xTweetPath, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")
	header, err := xOAuthHeader(http.MethodPost, xAPIBaseURL+xTweetPath, credential, nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("Authorization", header)
	client := a.xAPIHTTPClient
	if client == nil {
		client = newXAPIHTTPClient()
	}
	response, err := client.Do(request)
	if err != nil {
		return "", errors.Join(errXProviderUnavailable, err)
	}
	defer response.Body.Close()
	body, err = io.ReadAll(io.LimitReader(response.Body, xProviderResponseSize+1))
	if err != nil || len(body) > xProviderResponseSize {
		return "", errors.Join(errXProviderUnavailable, err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500 {
			return "", fmt.Errorf("%w: provider HTTP %d", errXProviderUnavailable, response.StatusCode)
		}
		return "", fmt.Errorf("provider rejected request with HTTP %d", response.StatusCode)
	}
	var result xTweetResponse
	if err := json.Unmarshal(body, &result); err != nil || strings.TrimSpace(result.Data.ID) == "" {
		return "", errors.Join(errXProviderUnavailable, errors.New("provider returned an invalid post result"))
	}
	return result.Data.ID, nil
}

func (a *App) uploadXImage(ctx context.Context, credential xCredential, image []byte) (string, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	if err := writer.WriteField("media_category", "tweet_image"); err != nil {
		return "", err
	}
	part, err := writer.CreateFormFile("media", "image.jpg")
	if err != nil {
		return "", err
	}
	if _, err := part.Write(image); err != nil {
		return "", err
	}
	if err := writer.Close(); err != nil {
		return "", err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, xMediaUploadURL, &body)
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", writer.FormDataContentType())
	request.Header.Set("Accept", "application/json")
	header, err := xOAuthHeader(http.MethodPost, xMediaUploadURL, credential, nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("Authorization", header)
	client := a.xAPIHTTPClient
	if client == nil {
		client = newXAPIHTTPClient()
	}
	response, err := client.Do(request)
	if err != nil {
		return "", errors.Join(errXProviderUnavailable, err)
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, xProviderResponseSize+1))
	if err != nil || len(responseBody) > xProviderResponseSize {
		return "", errors.Join(errXProviderUnavailable, err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500 {
			return "", fmt.Errorf("%w: media provider HTTP %d", errXProviderUnavailable, response.StatusCode)
		}
		return "", fmt.Errorf("media provider rejected request with HTTP %d", response.StatusCode)
	}
	var result xMediaResponse
	if err := json.Unmarshal(responseBody, &result); err != nil || strings.TrimSpace(result.MediaIDString) == "" {
		return "", errors.Join(errXProviderUnavailable, errors.New("provider returned an invalid media result"))
	}
	return result.MediaIDString, nil
}

func (a *App) readXImage(ctx context.Context, source string) ([]byte, error) {
	value := strings.TrimSpace(source)
	if strings.HasPrefix(strings.ToLower(value), "data:") {
		comma := strings.IndexByte(value, ',')
		if comma < 0 || !strings.Contains(strings.ToLower(value[:comma]), ";base64") {
			return nil, errors.New("image data is not base64 encoded")
		}
		decoder := base64.NewDecoder(base64.StdEncoding, strings.NewReader(value[comma+1:]))
		data, err := io.ReadAll(io.LimitReader(decoder, xRemoteImageMaxBytes+1))
		if err != nil || len(data) == 0 || len(data) > xRemoteImageMaxBytes {
			return nil, errors.New("image data is too large")
		}
		return data, nil
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
		return nil, errors.New("image source must be an HTTPS URL")
	}
	parsed.Fragment = ""
	trusted := isTrustedXImageURL(parsed)
	requestURL := parsed
	if trusted {
		requestURL = trustedXImageFetchURL(parsed, a.cfg.WorkerURL, a.cfg.AppURL)
	}
	imageContext, cancel := context.WithTimeout(ctx, xRequestTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(imageContext, http.MethodGet, requestURL.String(), nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "image/webp,image/png,image/jpeg,image/gif")
	client := a.xImageHTTPClient
	if trusted {
		client = a.xTrustedImageHTTPClient
		if client == nil {
			client = a.xImageHTTPClient
		}
		if client == nil {
			client = newTrustedXImageHTTPClient()
		}
	} else if client == nil {
		client = newSafeLLMHTTPClient()
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if response.StatusCode == http.StatusNotFound || response.StatusCode == http.StatusGone {
			return nil, errors.Join(errXImageSourceUnavailable, fmt.Errorf("image returned HTTP %d", response.StatusCode))
		}
		return nil, fmt.Errorf("image returned HTTP %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, xRemoteImageMaxBytes+1))
	if err != nil || len(data) == 0 || len(data) > xRemoteImageMaxBytes {
		return nil, errors.New("image is too large")
	}
	return data, nil
}

func isTrustedXImageURL(parsed *url.URL) bool {
	if parsed == nil || !strings.EqualFold(parsed.Scheme, "https") || parsed.User != nil {
		return false
	}
	if !strings.EqualFold(strings.TrimSuffix(parsed.Hostname(), "."), xTrustedImageHost) {
		return false
	}
	if port := parsed.Port(); port != "" && port != "443" {
		return false
	}
	return isSafeImageKey(strings.TrimPrefix(parsed.Path, "/"))
}

func trustedXImageFetchURL(parsed *url.URL, workerURL, appURL string) *url.URL {
	baseValue := strings.TrimRight(strings.TrimSpace(workerURL), "/")
	if baseValue == "" {
		baseValue = strings.TrimRight(strings.TrimSpace(appURL), "/")
	}
	if baseValue == "" {
		return parsed
	}
	base, err := url.Parse(baseValue)
	if err != nil || (base.Scheme != "http" && base.Scheme != "https") || base.Host == "" || base.User != nil || base.RawQuery != "" || base.Fragment != "" {
		return parsed
	}
	rewritten := *parsed
	rewritten.Scheme = base.Scheme
	rewritten.Host = base.Host
	rewritten.Path = strings.TrimRight(base.Path, "/") + "/images" + parsed.Path
	rewritten.RawPath = ""
	rewritten.Fragment = ""
	return &rewritten
}

func (a *App) loadXAccountView(ctx context.Context, userID int) (xAccountView, error) {
	var view xAccountView
	err := a.db.QueryRow(ctx, `
		SELECT api_key, 'configured', updated_at
		FROM x_accounts
		WHERE user_id = $1
	`, userID).Scan(&view.APIKey, &view.SecretHint, &view.UpdatedAt)
	return view, err
}

func (a *App) loadXCredential(ctx context.Context, userID int) (xCredential, error) {
	var credential xCredential
	var apiSecretCiphertext []byte
	var accessTokenCiphertext []byte
	var accessTokenSecretCiphertext []byte
	if err := a.db.QueryRow(ctx, `
		SELECT api_key, api_secret_ciphertext, access_token_ciphertext,
		       access_token_secret_ciphertext
		FROM x_accounts
		WHERE user_id = $1
	`, userID).Scan(
		&credential.APIKey,
		&apiSecretCiphertext,
		&accessTokenCiphertext,
		&accessTokenSecretCiphertext,
	); err != nil {
		return xCredential{}, err
	}
	var err error
	if credential.APISecret, err = a.decryptXCredential(userID, "api-secret", apiSecretCiphertext); err != nil {
		return xCredential{}, errors.Join(errXCredentialCrypto, err)
	}
	if credential.AccessToken, err = a.decryptXCredential(userID, "access-token", accessTokenCiphertext); err != nil {
		return xCredential{}, errors.Join(errXCredentialCrypto, err)
	}
	if credential.AccessTokenSecret, err = a.decryptXCredential(userID, "access-token-secret", accessTokenSecretCiphertext); err != nil {
		return xCredential{}, errors.Join(errXCredentialCrypto, err)
	}
	return credential, nil
}

func (a *App) xCredentialCipher() (cipher.AEAD, error) {
	secret := strings.TrimSpace(a.cfg.XCredentialEncryptionKey)
	if secret == "" && !a.cfg.IsProduction() {
		secret = a.cfg.SessionSecret
	}
	if secret == "" {
		return nil, errXCredentialCrypto
	}
	key := sha256.Sum256([]byte("koinote:x-credential:v1:" + secret))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func (a *App) encryptXCredential(userID int, field, value string) ([]byte, error) {
	aead, err := a.xCredentialCipher()
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	aad := []byte(strconv.Itoa(userID) + ":" + field)
	return aead.Seal(nonce, nonce, []byte(value), aad), nil
}

func (a *App) decryptXCredential(userID int, field string, ciphertext []byte) (string, error) {
	aead, err := a.xCredentialCipher()
	if err != nil {
		return "", err
	}
	if len(ciphertext) < aead.NonceSize() {
		return "", errors.New("x credential ciphertext is truncated")
	}
	nonce := ciphertext[:aead.NonceSize()]
	aad := []byte(strconv.Itoa(userID) + ":" + field)
	plain, err := aead.Open(nil, nonce, ciphertext[aead.NonceSize():], aad)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

func xOAuthHeader(method, rawURL string, credential xCredential, extraParams map[string]string) (string, error) {
	nonceBytes := make([]byte, 16)
	if _, err := io.ReadFull(rand.Reader, nonceBytes); err != nil {
		return "", err
	}
	oauthParams := map[string]string{
		"oauth_consumer_key":     credential.APIKey,
		"oauth_nonce":            hex.EncodeToString(nonceBytes),
		"oauth_signature_method": "HMAC-SHA1",
		"oauth_timestamp":        strconv.FormatInt(time.Now().Unix(), 10),
		"oauth_token":            credential.AccessToken,
		"oauth_version":          "1.0",
	}
	parsed, err := url.Parse(rawURL)
	if err != nil {
		return "", err
	}
	baseURL := *parsed
	baseURL.RawQuery = ""
	baseURL.ForceQuery = false
	baseURL.Fragment = ""
	params := make([]string, 0, len(oauthParams)+len(extraParams)+len(parsed.Query()))
	for key, value := range oauthParams {
		params = append(params, oauthEscape(key)+"="+oauthEscape(value))
	}
	for key, value := range extraParams {
		params = append(params, oauthEscape(key)+"="+oauthEscape(value))
	}
	for key, values := range parsed.Query() {
		for _, value := range values {
			params = append(params, oauthEscape(key)+"="+oauthEscape(value))
		}
	}
	sort.Strings(params)
	baseString := strings.ToUpper(method) + "&" + oauthEscape(baseURL.String()) + "&" + oauthEscape(strings.Join(params, "&"))
	signingKey := oauthEscape(credential.APISecret) + "&" + oauthEscape(credential.AccessTokenSecret)
	hash := hmac.New(sha1.New, []byte(signingKey))
	_, _ = hash.Write([]byte(baseString))
	oauthParams["oauth_signature"] = base64.StdEncoding.EncodeToString(hash.Sum(nil))
	keys := make([]string, 0, len(oauthParams))
	for key := range oauthParams {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		parts = append(parts, oauthEscape(key)+"=\""+oauthEscape(oauthParams[key])+"\"")
	}
	return "OAuth " + strings.Join(parts, ", "), nil
}

func oauthEscape(value string) string {
	var builder strings.Builder
	for _, byteValue := range []byte(value) {
		if (byteValue >= 'A' && byteValue <= 'Z') ||
			(byteValue >= 'a' && byteValue <= 'z') ||
			(byteValue >= '0' && byteValue <= '9') ||
			byteValue == '-' || byteValue == '.' || byteValue == '_' || byteValue == '~' {
			builder.WriteByte(byteValue)
			continue
		}
		fmt.Fprintf(&builder, "%%%02X", byteValue)
	}
	return builder.String()
}

func decodeXJSONBody(w http.ResponseWriter, r *http.Request, limit int64, target any) bool {
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

func writeXError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errXOAuth2AccountNotBound):
		httpx.ErrorCode(w, http.StatusConflict, "x_oauth2_account_not_bound", "Connect an X account with OAuth 2.0 first")
	case errors.Is(err, errXOAuth2NotConfigured):
		httpx.ErrorCode(w, http.StatusServiceUnavailable, "x_oauth2_not_configured", "X OAuth 2.0 is not configured")
	case errors.Is(err, errXOAuth2TokenInvalid):
		httpx.ErrorCode(w, http.StatusUnauthorized, "x_oauth2_token_invalid", "X authorization expired; connect your account again")
	case errors.Is(err, errXAccountNotBound):
		httpx.ErrorCode(w, http.StatusConflict, "x_account_not_bound", "Bind an X account first")
	case errors.Is(err, errXCredentialRequired):
		httpx.ErrorCode(w, http.StatusBadRequest, "x_credentials_required", "All X API credentials are required")
	case errors.Is(err, errXCredentialCrypto):
		httpx.ErrorCode(w, http.StatusServiceUnavailable, "x_credential_unavailable", "X credential encryption is unavailable")
	case errors.Is(err, errXImageSourceUnavailable):
		httpx.ErrorCode(w, http.StatusUnprocessableEntity, "x_image_source_unavailable", "An article image is no longer available")
	case errors.Is(err, errXImageFailed):
		httpx.ErrorCode(w, http.StatusBadGateway, "x_image_upload_failed", "X could not accept an article image")
	case errors.Is(err, errXProviderUnavailable):
		httpx.ErrorCode(w, http.StatusBadGateway, "x_provider_unavailable", "X is temporarily unavailable")
	case errors.Is(err, errXArticleUnavailable):
		httpx.ErrorCode(w, http.StatusForbidden, "x_article_unavailable", "X Articles are unavailable for this account or developer app")
	case errors.Is(err, errXArticleDraftOnly):
		httpx.ErrorCode(w, http.StatusBadGateway, "x_article_draft_only", "The X Article draft was saved but could not be published")
	case errors.Is(err, errXPublishFailed):
		httpx.ErrorCode(w, http.StatusBadGateway, "x_publish_failed", "X rejected the post")
	default:
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
	}
}
