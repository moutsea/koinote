package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"koinote/backend/internal/httpx"
)

const (
	xOAuth2AuthorizeURL     = "https://x.com/i/oauth2/authorize"
	xOAuth2TokenURL         = "https://api.x.com/2/oauth2/token"
	xOAuth2ProfileURL       = "https://api.x.com/2/users/me"
	xOAuth2MediaURL         = "https://api.x.com/2/media/upload"
	xOAuth2ArticleDraftPath = "/2/articles/draft"
	xOAuth2StateCookie      = "koinote_x_oauth2_state"
	xOAuth2StateTTL         = 10 * time.Minute
	xOAuth2StartLimit       = 10
	xOAuth2StartWindow      = time.Hour
	xOAuth2TokenSkew        = 2 * time.Minute
	xOAuth2Scopes           = "tweet.read tweet.write users.read media.write offline.access"
	xMediaUploadAttempts    = 3
	xMediaUploadRetryDelay  = 250 * time.Millisecond
)

type xArticleMedia struct {
	ID      string
	Caption string
	Source  string
}

type xArticleDraftResponse struct {
	Data struct {
		ID    string `json:"id"`
		Title string `json:"title"`
	} `json:"data"`
}

type xArticlePublishResponse struct {
	Data struct {
		PostID string `json:"post_id"`
	} `json:"data"`
}

type xOAuth2AccountView struct {
	UserID    string    `json:"userId"`
	Username  string    `json:"username"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type xOAuth2Credential struct {
	AccessToken  string
	RefreshToken string
	ExpiresAt    time.Time
	XUserID      string
	Username     string
	Scope        string
}

type xOAuth2Pending struct {
	UserID        int
	CodeVerifier  string
	RedirectTo    string
	Desktop       bool
	DesktopScheme string
}

type xOAuth2Refresh struct {
	done       chan struct{}
	credential xOAuth2Credential
	err        error
}

type xOAuth2TokenResponse struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	TokenType    string `json:"token_type"`
	ExpiresIn    int    `json:"expires_in"`
	Scope        string `json:"scope"`
	Error        string `json:"error"`
	Description  string `json:"error_description"`
}

type xOAuth2ProfileResponse struct {
	Data struct {
		ID       string `json:"id"`
		Username string `json:"username"`
		Name     string `json:"name"`
	} `json:"data"`
}

func (a *App) xOAuth2RedirectURI() string {
	return strings.TrimRight(a.cfg.AppURL, "/") + "/api/x/oauth2/callback"
}

func (a *App) xOAuth2Start(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	if !a.cfg.XOAuth2Enabled() {
		writeXError(w, errXOAuth2NotConfigured)
		return
	}
	if !a.rateLimit().allow("x-oauth2-start:"+strconv.Itoa(user.ID), xOAuth2StartLimit, xOAuth2StartWindow) {
		httpx.ErrorCode(w, http.StatusTooManyRequests, "too_many_requests", "Too many X authorization attempts")
		return
	}
	state, err := randomHex(32)
	if err != nil {
		log.Printf("x oauth2 state: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error")
		return
	}
	codeVerifier, err := randomHex(48)
	if err != nil {
		log.Printf("x oauth2 verifier: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error")
		return
	}
	redirectTo := sanitizeRedirectPath(r.URL.Query().Get("redirectTo"))
	client := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("client")))
	desktop := client == "desktop" || client == "desktop-local"
	desktopScheme := ""
	if client == "desktop" {
		desktopScheme = "koinote"
	}
	if client == "desktop-local" {
		desktopScheme = "koinote-local"
	}
	// Keep other active states for this user. A double click, a second tab, or a
	// browser retry must not invalidate the authorization flow that was already
	// opened. Expired rows are cheap to clean up here and are also covered by the
	// expiry predicate in consumeXOAuth2Pending.
	if _, err := a.db.Exec(r.Context(),
		`DELETE FROM x_oauth2_pending WHERE expires_at <= now()`); err != nil {
		log.Printf("x oauth2 pending cleanup: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error")
		return
	}
	if _, err := a.db.Exec(r.Context(), `
		INSERT INTO x_oauth2_pending (state, user_id, code_verifier, redirect_to, desktop, desktop_scheme, expires_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7)
	`, state, user.ID, codeVerifier, redirectTo, desktop, desktopScheme, time.Now().Add(xOAuth2StateTTL)); err != nil {
		log.Printf("x oauth2 pending insert: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error")
		return
	}
	authURL, err := a.xOAuth2AuthorizeURL(state, codeVerifier)
	if err != nil {
		log.Printf("x oauth2 authorize url: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error")
		return
	}
	if desktop {
		browserStartURL := strings.TrimRight(a.cfg.AppURL, "/") + "/api/x/oauth2/desktop-start?state=" + url.QueryEscape(state)
		httpx.JSON(w, http.StatusOK, map[string]string{"url": browserStartURL})
		return
	}
	a.setXOAuth2StateCookie(w, state)
	httpx.JSON(w, http.StatusOK, map[string]string{"url": authURL})
}

func (a *App) xOAuth2DesktopStart(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !a.cfg.XOAuth2Enabled() {
		writeXError(w, errXOAuth2NotConfigured)
		return
	}
	state := strings.TrimSpace(r.URL.Query().Get("state"))
	if state == "" || len(state) > 128 {
		http.Error(w, "Invalid authorization request", http.StatusBadRequest)
		return
	}
	pending, err := a.loadXOAuth2Pending(r.Context(), state)
	if err != nil || !pending.Desktop {
		http.Error(w, "Invalid authorization request", http.StatusBadRequest)
		return
	}
	authURL, err := a.xOAuth2AuthorizeURL(state, pending.CodeVerifier)
	if err != nil {
		log.Printf("x oauth2 desktop authorize url: %v", err)
		http.Error(w, "Server error", http.StatusInternalServerError)
		return
	}
	a.setXOAuth2StateCookie(w, state)
	http.Redirect(w, r, authURL, http.StatusFound)
}

func (a *App) xOAuth2AuthorizeURL(state, codeVerifier string) (string, error) {
	authURL, err := url.Parse(xOAuth2AuthorizeURL)
	if err != nil {
		return "", err
	}
	query := authURL.Query()
	query.Set("response_type", "code")
	query.Set("client_id", a.cfg.XOAuth2ClientID)
	query.Set("redirect_uri", a.xOAuth2RedirectURI())
	query.Set("scope", xOAuth2Scopes)
	query.Set("state", state)
	query.Set("code_challenge", xOAuth2CodeChallenge(codeVerifier))
	query.Set("code_challenge_method", "S256")
	authURL.RawQuery = query.Encode()
	return authURL.String(), nil
}

func xOAuth2CodeChallenge(verifier string) string {
	hash := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(hash[:])
}

func (a *App) xOAuth2Callback(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	state := strings.TrimSpace(r.URL.Query().Get("state"))
	cookie, cookieErr := r.Cookie(xOAuth2StateCookie)
	if state == "" {
		a.clearXOAuth2StateCookie(w)
		a.redirectXOAuth2Failure(w, r, "", "/settings?section=x", "x_oauth2_invalid_state")
		return
	}
	cookieMatches := cookieErr == nil && cookie.Value == state
	if !cookieMatches {
		pending, pendingErr := a.loadXOAuth2Pending(r.Context(), state)
		a.clearXOAuth2StateCookie(w)
		if pendingErr == nil {
			a.redirectXOAuth2Failure(w, r, pending.DesktopScheme, pending.RedirectTo, "x_oauth2_invalid_state")
		} else {
			a.redirectXOAuth2Failure(w, r, "", "/settings?section=x", "x_oauth2_invalid_state")
		}
		return
	}
	pending, err := a.consumeXOAuth2Pending(r.Context(), state)
	a.clearXOAuth2StateCookie(w)
	if err != nil {
		log.Printf("x oauth2 pending: %v", err)
		a.redirectXOAuth2Failure(w, r, "", "/settings?section=x", "x_oauth2_invalid_state")
		return
	}
	if providerError := strings.TrimSpace(r.URL.Query().Get("error")); providerError != "" {
		a.redirectXOAuth2Failure(w, r, pending.DesktopScheme, pending.RedirectTo, "x_oauth2_denied")
		return
	}
	code := strings.TrimSpace(r.URL.Query().Get("code"))
	if code == "" {
		a.redirectXOAuth2Failure(w, r, pending.DesktopScheme, pending.RedirectTo, "x_oauth2_missing_code")
		return
	}
	token, err := a.exchangeXOAuth2Code(r.Context(), code, pending.CodeVerifier)
	if err != nil {
		log.Printf("x oauth2 code exchange: %v", err)
		a.redirectXOAuth2Failure(w, r, pending.DesktopScheme, pending.RedirectTo, "x_oauth2_exchange_failed")
		return
	}
	profile, err := a.fetchXOAuth2Profile(r.Context(), token.AccessToken)
	if err != nil {
		log.Printf("x oauth2 profile: %v", err)
		a.redirectXOAuth2Failure(w, r, pending.DesktopScheme, pending.RedirectTo, "x_oauth2_profile_failed")
		return
	}
	if err := a.storeXOAuth2Credential(r.Context(), pending.UserID, token, profile); err != nil {
		log.Printf("x oauth2 credential store: %v", err)
		a.redirectXOAuth2Failure(w, r, pending.DesktopScheme, pending.RedirectTo, "x_oauth2_store_failed")
		return
	}
	a.redirectXOAuth2Success(w, r, pending.DesktopScheme, pending.RedirectTo)
}

func (a *App) consumeXOAuth2Pending(ctx context.Context, state string) (xOAuth2Pending, error) {
	var pending xOAuth2Pending
	var desktop bool
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return xOAuth2Pending{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	err = tx.QueryRow(ctx, `
		DELETE FROM x_oauth2_pending
		WHERE state = $1 AND expires_at > now()
		RETURNING user_id, code_verifier, redirect_to, desktop, desktop_scheme
	`, state).Scan(&pending.UserID, &pending.CodeVerifier, &pending.RedirectTo, &desktop, &pending.DesktopScheme)
	if err != nil {
		return xOAuth2Pending{}, err
	}
	pending.Desktop = desktop
	if err := tx.Commit(ctx); err != nil {
		return xOAuth2Pending{}, err
	}
	return pending, nil
}

func (a *App) loadXOAuth2Pending(ctx context.Context, state string) (xOAuth2Pending, error) {
	var pending xOAuth2Pending
	err := a.db.QueryRow(ctx, `
		SELECT user_id, code_verifier, redirect_to, desktop, desktop_scheme
		FROM x_oauth2_pending
		WHERE state = $1 AND expires_at > now()
	`, state).Scan(
		&pending.UserID,
		&pending.CodeVerifier,
		&pending.RedirectTo,
		&pending.Desktop,
		&pending.DesktopScheme,
	)
	return pending, err
}

func (a *App) exchangeXOAuth2Code(ctx context.Context, code, verifier string) (xOAuth2TokenResponse, error) {
	values := url.Values{}
	values.Set("grant_type", "authorization_code")
	values.Set("client_id", a.cfg.XOAuth2ClientID)
	values.Set("client_secret", a.cfg.XOAuth2ClientSecret)
	values.Set("redirect_uri", a.xOAuth2RedirectURI())
	values.Set("code", code)
	values.Set("code_verifier", verifier)
	return a.exchangeXOAuth2Token(ctx, values)
}

func (a *App) exchangeXOAuth2Refresh(ctx context.Context, refreshToken string) (xOAuth2TokenResponse, error) {
	values := url.Values{}
	values.Set("grant_type", "refresh_token")
	values.Set("client_id", a.cfg.XOAuth2ClientID)
	values.Set("client_secret", a.cfg.XOAuth2ClientSecret)
	values.Set("refresh_token", refreshToken)
	return a.exchangeXOAuth2Token(ctx, values)
}

func (a *App) exchangeXOAuth2Token(ctx context.Context, values url.Values) (xOAuth2TokenResponse, error) {
	if !a.cfg.XOAuth2Enabled() {
		return xOAuth2TokenResponse{}, errXOAuth2NotConfigured
	}
	values.Del("client_secret")
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, xOAuth2TokenURL, strings.NewReader(values.Encode()))
	if err != nil {
		return xOAuth2TokenResponse{}, err
	}
	request.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	request.Header.Set("Accept", "application/json")
	request.SetBasicAuth(a.cfg.XOAuth2ClientID, a.cfg.XOAuth2ClientSecret)
	client := a.xOAuth2HTTPClient
	if client == nil {
		client = newXAPIHTTPClient()
	}
	response, err := client.Do(request)
	if err != nil {
		return xOAuth2TokenResponse{}, errors.Join(errXProviderUnavailable, err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, xProviderResponseSize+1))
	if err != nil || len(body) > xProviderResponseSize {
		return xOAuth2TokenResponse{}, errors.Join(errXProviderUnavailable, err)
	}
	var token xOAuth2TokenResponse
	if err := json.Unmarshal(body, &token); err != nil {
		return xOAuth2TokenResponse{}, errors.Join(errXProviderUnavailable, err)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 || token.Error != "" || token.AccessToken == "" || token.ExpiresIn <= 0 {
		if token.Error != "" {
			if token.Description != "" {
				return xOAuth2TokenResponse{}, fmt.Errorf("x oauth2 token rejected: %s (%s)", token.Error, token.Description)
			}
			return xOAuth2TokenResponse{}, fmt.Errorf("x oauth2 token rejected: %s", token.Error)
		}
		return xOAuth2TokenResponse{}, fmt.Errorf("x oauth2 token response %d", response.StatusCode)
	}
	return token, nil
}

func (a *App) fetchXOAuth2Profile(ctx context.Context, accessToken string) (xOAuth2ProfileResponse, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, xOAuth2ProfileURL, nil)
	if err != nil {
		return xOAuth2ProfileResponse{}, err
	}
	request.Header.Set("Authorization", "Bearer "+accessToken)
	request.Header.Set("Accept", "application/json")
	client := a.xOAuth2HTTPClient
	if client == nil {
		client = newXAPIHTTPClient()
	}
	response, err := client.Do(request)
	if err != nil {
		return xOAuth2ProfileResponse{}, errors.Join(errXProviderUnavailable, err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, xProviderResponseSize+1))
	if err != nil || len(body) > xProviderResponseSize {
		return xOAuth2ProfileResponse{}, errors.Join(errXProviderUnavailable, err)
	}
	if response.StatusCode == http.StatusUnauthorized {
		return xOAuth2ProfileResponse{}, errXOAuth2TokenInvalid
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return xOAuth2ProfileResponse{}, fmt.Errorf("x profile response %d", response.StatusCode)
	}
	var profile xOAuth2ProfileResponse
	if err := json.Unmarshal(body, &profile); err != nil || profile.Data.ID == "" || profile.Data.Username == "" {
		return xOAuth2ProfileResponse{}, errors.Join(errXProviderUnavailable, errors.New("invalid X profile"))
	}
	return profile, nil
}

func (a *App) storeXOAuth2Credential(ctx context.Context, userID int, token xOAuth2TokenResponse, profile xOAuth2ProfileResponse) error {
	if strings.TrimSpace(token.RefreshToken) == "" {
		return errors.New("x oauth2 provider did not return a refresh token")
	}
	accessCiphertext, err := a.encryptXCredential(userID, "oauth2-access-token", token.AccessToken)
	if err != nil {
		return errors.Join(errXCredentialCrypto, err)
	}
	refreshCiphertext, err := a.encryptXCredential(userID, "oauth2-refresh-token", token.RefreshToken)
	if err != nil {
		return errors.Join(errXCredentialCrypto, err)
	}
	_, err = a.db.Exec(ctx, `
		INSERT INTO x_oauth2_accounts (
			user_id, access_token_ciphertext, refresh_token_ciphertext, expires_at,
			x_user_id, x_username, scope, updated_at
		)
		VALUES ($1, $2, $3, $4, $5, $6, $7, now())
		ON CONFLICT (user_id) DO UPDATE SET
			access_token_ciphertext = EXCLUDED.access_token_ciphertext,
			refresh_token_ciphertext = EXCLUDED.refresh_token_ciphertext,
			expires_at = EXCLUDED.expires_at,
			x_user_id = EXCLUDED.x_user_id,
			x_username = EXCLUDED.x_username,
			scope = EXCLUDED.scope,
			updated_at = now()
	`, userID, accessCiphertext, refreshCiphertext, time.Now().Add(time.Duration(token.ExpiresIn)*time.Second), profile.Data.ID, profile.Data.Username, token.Scope)
	return err
}

func (a *App) loadXOAuth2AccountView(ctx context.Context, userID int) (xOAuth2AccountView, error) {
	var view xOAuth2AccountView
	err := a.db.QueryRow(ctx, `
		SELECT x_user_id, x_username, updated_at
		FROM x_oauth2_accounts
		WHERE user_id = $1
	`, userID).Scan(&view.UserID, &view.Username, &view.UpdatedAt)
	return view, err
}

func (a *App) loadXOAuth2Credential(ctx context.Context, userID int) (xOAuth2Credential, error) {
	if !a.cfg.XOAuth2Enabled() {
		return xOAuth2Credential{}, errXOAuth2NotConfigured
	}
	credential, _, err := a.readXOAuth2Credential(ctx, userID)
	if err != nil {
		return xOAuth2Credential{}, err
	}
	if credential.ExpiresAt.After(time.Now().Add(xOAuth2TokenSkew)) {
		return credential, nil
	}
	return a.refreshXOAuth2Credential(ctx, userID)
}

func (a *App) refreshXOAuth2Credential(ctx context.Context, userID int) (xOAuth2Credential, error) {
	if err := ctx.Err(); err != nil {
		return xOAuth2Credential{}, err
	}
	for {
		a.xOAuth2TokenMu.Lock()
		if a.xOAuth2Refreshes == nil {
			a.xOAuth2Refreshes = make(map[int]*xOAuth2Refresh)
		}
		if refresh := a.xOAuth2Refreshes[userID]; refresh != nil {
			a.xOAuth2TokenMu.Unlock()
			select {
			case <-ctx.Done():
				return xOAuth2Credential{}, ctx.Err()
			case <-refresh.done:
				if refresh.err != nil {
					if ctx.Err() == nil && errors.Is(refresh.err, context.Canceled) {
						continue
					}
					return xOAuth2Credential{}, refresh.err
				}
				return refresh.credential, nil
			}
		}
		refresh := &xOAuth2Refresh{done: make(chan struct{})}
		a.xOAuth2Refreshes[userID] = refresh
		a.xOAuth2TokenMu.Unlock()

		credential, err := a.refreshXOAuth2CredentialOnce(ctx, userID)
		a.xOAuth2TokenMu.Lock()
		refresh.credential = credential
		refresh.err = err
		delete(a.xOAuth2Refreshes, userID)
		close(refresh.done)
		a.xOAuth2TokenMu.Unlock()
		return credential, err
	}
}

func (a *App) refreshXOAuth2CredentialOnce(ctx context.Context, userID int) (xOAuth2Credential, error) {
	for attempt := 0; attempt < 3; attempt++ {
		credential, oldRefreshCiphertext, err := a.readXOAuth2Credential(ctx, userID)
		if err != nil {
			return xOAuth2Credential{}, err
		}
		if credential.ExpiresAt.After(time.Now().Add(xOAuth2TokenSkew)) {
			return credential, nil
		}
		if credential.RefreshToken == "" {
			return xOAuth2Credential{}, errXOAuth2TokenInvalid
		}

		// Do not hold a database transaction while waiting on X. Another replica
		// may refresh the same row concurrently; the conditional update below
		// ensures that only the request which observed this exact refresh token
		// can commit its replacement.
		token, refreshErr := a.exchangeXOAuth2Refresh(ctx, credential.RefreshToken)
		if refreshErr != nil {
			if current, currentRefreshCiphertext, currentErr := a.readXOAuth2Credential(ctx, userID); currentErr == nil {
				if current.ExpiresAt.After(time.Now().Add(xOAuth2TokenSkew)) {
					return current, nil
				}
				if !bytes.Equal(currentRefreshCiphertext, oldRefreshCiphertext) {
					continue
				}
			}
			return xOAuth2Credential{}, errors.Join(errXOAuth2TokenInvalid, refreshErr)
		}
		newAccessCiphertext, err := a.encryptXCredential(userID, "oauth2-access-token", token.AccessToken)
		if err != nil {
			return xOAuth2Credential{}, errors.Join(errXCredentialCrypto, err)
		}
		refreshToken := credential.RefreshToken
		if token.RefreshToken != "" {
			refreshToken = token.RefreshToken
		}
		newRefreshCiphertext, err := a.encryptXCredential(userID, "oauth2-refresh-token", refreshToken)
		if err != nil {
			return xOAuth2Credential{}, errors.Join(errXCredentialCrypto, err)
		}
		expiresAt := time.Now().Add(time.Duration(token.ExpiresIn) * time.Second)
		result, err := a.db.Exec(ctx, `
			UPDATE x_oauth2_accounts
			SET access_token_ciphertext = $2, refresh_token_ciphertext = $3,
			    expires_at = $4, updated_at = now()
			WHERE user_id = $1 AND refresh_token_ciphertext = $5
		`, userID, newAccessCiphertext, newRefreshCiphertext, expiresAt, oldRefreshCiphertext)
		if err != nil {
			return xOAuth2Credential{}, err
		}
		if result.RowsAffected() == 0 {
			// Another process won the rotation. Re-read its credential instead of
			// returning the token that X may already have invalidated.
			continue
		}
		credential.AccessToken = token.AccessToken
		credential.RefreshToken = refreshToken
		credential.ExpiresAt = expiresAt
		return credential, nil
	}
	if current, _, err := a.readXOAuth2Credential(ctx, userID); err == nil &&
		current.ExpiresAt.After(time.Now().Add(xOAuth2TokenSkew)) {
		return current, nil
	}
	return xOAuth2Credential{}, errXOAuth2TokenInvalid
}

func (a *App) readXOAuth2Credential(ctx context.Context, userID int) (xOAuth2Credential, []byte, error) {
	var accessCiphertext, refreshCiphertext []byte
	var credential xOAuth2Credential
	err := a.db.QueryRow(ctx, `
		SELECT access_token_ciphertext, refresh_token_ciphertext, expires_at,
		       x_user_id, x_username, scope
		FROM x_oauth2_accounts
		WHERE user_id = $1
	`, userID).Scan(
		&accessCiphertext,
		&refreshCiphertext,
		&credential.ExpiresAt,
		&credential.XUserID,
		&credential.Username,
		&credential.Scope,
	)
	if err != nil {
		return xOAuth2Credential{}, nil, err
	}
	var decryptErr error
	if credential.AccessToken, decryptErr = a.decryptXCredential(userID, "oauth2-access-token", accessCiphertext); decryptErr != nil {
		return xOAuth2Credential{}, nil, errors.Join(errXCredentialCrypto, decryptErr)
	}
	if credential.RefreshToken, decryptErr = a.decryptXCredential(userID, "oauth2-refresh-token", refreshCiphertext); decryptErr != nil {
		return xOAuth2Credential{}, nil, errors.Join(errXCredentialCrypto, decryptErr)
	}
	return credential, refreshCiphertext, nil
}

func (a *App) xOAuth2AccountDelete(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	if _, err := a.db.Exec(r.Context(), `DELETE FROM x_oauth2_accounts WHERE user_id = $1`, user.ID); err != nil {
		log.Printf("x oauth2 account delete: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"success": true})
}

func (a *App) setXOAuth2StateCookie(w http.ResponseWriter, state string) {
	http.SetCookie(w, &http.Cookie{
		Name:     xOAuth2StateCookie,
		Value:    state,
		Path:     "/api/x/oauth2",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   a.cfg.IsProduction(),
		Expires:  time.Now().Add(xOAuth2StateTTL),
		MaxAge:   int(xOAuth2StateTTL.Seconds()),
	})
}

func (a *App) clearXOAuth2StateCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     xOAuth2StateCookie,
		Value:    "",
		Path:     "/api/x/oauth2",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   a.cfg.IsProduction(),
		Expires:  time.Unix(0, 0),
		MaxAge:   -1,
	})
}

func xOAuth2DesktopScheme(value string) string {
	if value == "koinote-local" {
		return value
	}
	return "koinote"
}

func (a *App) redirectXOAuth2Success(w http.ResponseWriter, r *http.Request, desktopScheme, redirectTo string) {
	if desktopScheme != "" {
		http.Redirect(w, r, xOAuth2DesktopScheme(desktopScheme)+"://x-oauth2?status=success", http.StatusFound)
		return
	}
	target := appendXOAuth2Query(redirectTo, "x_oauth2", "connected")
	http.Redirect(w, r, target, http.StatusFound)
}

func (a *App) redirectXOAuth2Failure(w http.ResponseWriter, r *http.Request, desktopScheme, redirectTo, code string) {
	if desktopScheme != "" {
		http.Redirect(w, r, xOAuth2DesktopScheme(desktopScheme)+"://x-oauth2?status=error&code="+url.QueryEscape(code), http.StatusFound)
		return
	}
	target := appendXOAuth2Query(redirectTo, "x_oauth2_error", code)
	http.Redirect(w, r, target, http.StatusFound)
}

func appendXOAuth2Query(raw, key, value string) string {
	parsed, err := url.Parse(sanitizeRedirectPath(raw))
	if err != nil {
		return "/settings?section=x&" + url.QueryEscape(key) + "=" + url.QueryEscape(value)
	}
	query := parsed.Query()
	query.Set(key, value)
	parsed.RawQuery = query.Encode()
	return parsed.String()
}

func (a *App) uploadXImageOAuth2(ctx context.Context, credential xOAuth2Credential, image []byte) (string, error) {
	encoded := base64.StdEncoding.EncodeToString(image)
	body, err := json.Marshal(map[string]string{
		"media":          encoded,
		"media_category": "tweet_image",
	})
	if err != nil {
		return "", err
	}
	client := a.xOAuth2HTTPClient
	if client == nil {
		client = newXAPIHTTPClient()
	}
	for attempt := 0; attempt < xMediaUploadAttempts; attempt++ {
		request, requestErr := http.NewRequestWithContext(ctx, http.MethodPost, xOAuth2MediaURL, bytes.NewReader(body))
		if requestErr != nil {
			return "", requestErr
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Authorization", "Bearer "+credential.AccessToken)
		request.Header.Set("Accept", "application/json")
		response, requestErr := client.Do(request)
		if requestErr != nil {
			if attempt+1 < xMediaUploadAttempts && retryableXMediaUploadError(requestErr) {
				if waitErr := waitForXMediaUploadRetry(ctx, attempt); waitErr != nil {
					return "", waitErr
				}
				continue
			}
			return "", errors.Join(errXProviderUnavailable, requestErr)
		}
		responseBody, readErr := io.ReadAll(io.LimitReader(response.Body, xProviderResponseSize+1))
		_ = response.Body.Close()
		if readErr != nil || len(responseBody) > xProviderResponseSize {
			if attempt+1 < xMediaUploadAttempts && retryableXMediaUploadError(readErr) {
				if waitErr := waitForXMediaUploadRetry(ctx, attempt); waitErr != nil {
					return "", waitErr
				}
				continue
			}
			return "", errors.Join(errXProviderUnavailable, readErr)
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			if response.StatusCode == http.StatusUnauthorized {
				return "", errXOAuth2TokenInvalid
			}
			if (response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500) && attempt+1 < xMediaUploadAttempts {
				if waitErr := waitForXMediaUploadRetry(ctx, attempt); waitErr != nil {
					return "", waitErr
				}
				continue
			}
			if response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500 {
				return "", fmt.Errorf("%w: media provider HTTP %d", errXProviderUnavailable, response.StatusCode)
			}
			return "", fmt.Errorf("media provider rejected request with HTTP %d", response.StatusCode)
		}
		var result struct {
			Data struct {
				ID string `json:"id"`
			} `json:"data"`
		}
		if err := json.Unmarshal(responseBody, &result); err != nil || strings.TrimSpace(result.Data.ID) == "" {
			return "", errors.Join(errXProviderUnavailable, errors.New("provider returned an invalid media result"))
		}
		return result.Data.ID, nil
	}
	return "", errors.Join(errXProviderUnavailable, errors.New("media upload attempts exhausted"))
}

func retryableXMediaUploadError(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, io.ErrUnexpectedEOF) {
		return true
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "unexpected eof") ||
		strings.Contains(message, "connection reset") ||
		strings.Contains(message, "broken pipe")
}

func waitForXMediaUploadRetry(ctx context.Context, attempt int) error {
	delay := xMediaUploadRetryDelay * time.Duration(1<<attempt)
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func (a *App) createXTweetOAuth2(ctx context.Context, credential xOAuth2Credential, payload map[string]any) (string, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, xAPIBaseURL+xTweetPath, strings.NewReader(string(body)))
	if err != nil {
		return "", err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+credential.AccessToken)
	request.Header.Set("Accept", "application/json")
	client := a.xOAuth2HTTPClient
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
	if response.StatusCode == http.StatusUnauthorized {
		return "", errXOAuth2TokenInvalid
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		if response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500 {
			return "", fmt.Errorf("%w: provider HTTP %d", errXProviderUnavailable, response.StatusCode)
		}
		return "", fmt.Errorf("provider rejected request with HTTP %d", response.StatusCode)
	}
	var result xTweetResponse
	if err := json.Unmarshal(responseBody, &result); err != nil || strings.TrimSpace(result.Data.ID) == "" {
		return "", errors.Join(errXProviderUnavailable, errors.New("provider returned an invalid post result"))
	}
	return result.Data.ID, nil
}

func (a *App) publishXThreadOAuth2(ctx context.Context, credential xOAuth2Credential, posts []string, imagesByPost map[int][]xPublishImageInput) (xPublishResult, error) {
	return a.publishXThreadWith(ctx, posts, imagesByPost,
		func(ctx context.Context, image []byte) (string, error) {
			return a.uploadXImageOAuth2(ctx, credential, image)
		},
		func(ctx context.Context, payload map[string]any) (string, error) {
			return a.createXTweetOAuth2(ctx, credential, payload)
		},
	)
}

func (a *App) publishXArticleOAuth2(
	ctx context.Context,
	credential xOAuth2Credential,
	title string,
	markdown string,
	images []xPublishImageInput,
) (xPublishResult, error) {
	media := make([]xArticleMedia, 0, len(images))
	for _, image := range images {
		raw, err := a.readXImage(ctx, strings.TrimSpace(image.Source))
		if err != nil {
			if errors.Is(err, errXImageSourceUnavailable) {
				return xPublishResult{}, errors.Join(errXImageSourceUnavailable, err)
			}
			return xPublishResult{}, errors.Join(errXImageFailed, err)
		}
		prepared, err := prepareWechatContentImage(raw)
		if err != nil || len(prepared) > xUploadImageMaxBytes {
			return xPublishResult{}, errors.Join(errXImageFailed, errors.New("image cannot fit X limits"))
		}
		mediaID, err := a.uploadXImageOAuth2(ctx, credential, prepared)
		if err != nil {
			return xPublishResult{}, errors.Join(errXImageFailed, err)
		}
		media = append(media, xArticleMedia{
			ID:      mediaID,
			Caption: strings.TrimSpace(image.Alt),
			Source:  xArticleImageSourceForMatching(image),
		})
	}

	draftRequest := map[string]any{
		"title":         title,
		"content_state": buildXArticleContentState(markdown, media),
	}
	var draft xArticleDraftResponse
	if err := a.doXOAuth2JSON(ctx, credential, xOAuth2ArticleDraftPath, draftRequest, &draft); err != nil {
		return xPublishResult{}, errors.Join(errXPublishFailed, err)
	}
	draftID := strings.TrimSpace(draft.Data.ID)
	if !xArticleIDPattern.MatchString(draftID) {
		return xPublishResult{}, errors.Join(errXProviderUnavailable, errors.New("provider returned an invalid Article draft result"))
	}

	var published xArticlePublishResponse
	publishPath := "/2/articles/" + url.PathEscape(draftID) + "/publish"
	if err := a.doXOAuth2JSON(ctx, credential, publishPath, nil, &published); err != nil {
		return xPublishResult{DraftID: draftID}, errors.Join(errXPublishFailed, err)
	}
	postID := strings.TrimSpace(published.Data.PostID)
	if !xArticleIDPattern.MatchString(postID) {
		return xPublishResult{DraftID: draftID}, errors.Join(errXProviderUnavailable, errors.New("provider returned an invalid Article publish result"))
	}
	return xPublishResult{
		URL:         "https://x.com/i/status/" + postID,
		PostCount:   1,
		PublishedID: postID,
		DraftID:     draftID,
	}, nil
}

func buildXArticleContentState(markdown string, media []xArticleMedia) map[string]any {
	blocks := make([]map[string]any, 0, len(media)+1)
	entities := make([]map[string]any, 0, len(media)+1)
	addEntity := func(entityType, mutability string, data map[string]any) {
		index := len(entities)
		entities = append(entities, map[string]any{
			"key": strconv.Itoa(index),
			"value": map[string]any{
				"type":       entityType,
				"mutability": mutability,
				"data":       data,
			},
		})
		blocks = append(blocks, map[string]any{
			"text": " ",
			"type": "atomic",
			"entity_ranges": []map[string]int{{
				"key": index, "offset": 0, "length": 1,
			}},
		})
	}
	addMarkdown := func(value string) {
		value = strings.TrimSpace(value)
		if value == "" {
			return
		}
		addEntity("markdown", "mutable", map[string]any{"markdown": value})
	}
	addImage := func(item xArticleMedia) {
		data := map[string]any{
			"media_items": []map[string]string{{
				"media_category": "tweet_image",
				"media_id":       item.ID,
			}},
		}
		if item.Caption != "" {
			data["caption"] = item.Caption
		}
		addEntity("image", "immutable", data)
	}

	markdown = strings.TrimSpace(markdown)
	articleMarkdown := markdown
	usedMedia := make([]bool, len(media))
	codeRanges := xArticleCodeRanges(articleMarkdown)
	allOccurrences := xArticleImagePattern.FindAllStringSubmatchIndex(articleMarkdown, -1)
	linkedReplacements := make([]xArticleReplacement, 0)
	for _, occurrence := range allOccurrences {
		if xArticleRangeContains(codeRanges, occurrence[0]) || !xArticleImageInLink(articleMarkdown, occurrence[0], occurrence[1]) {
			continue
		}
		destination := xArticleImageDestination(articleMarkdown[occurrence[4]:occurrence[5]])
		if mediaIndex := findXArticleMedia(media, usedMedia, destination); mediaIndex >= 0 {
			usedMedia[mediaIndex] = true
		}
		linkedReplacements = append(linkedReplacements, xArticleReplacement{
			start:       occurrence[0],
			end:         occurrence[1],
			replacement: articleMarkdown[occurrence[2]:occurrence[3]],
		})
	}
	for index := len(linkedReplacements) - 1; index >= 0; index-- {
		replacement := linkedReplacements[index]
		articleMarkdown = articleMarkdown[:replacement.start] + replacement.replacement + articleMarkdown[replacement.end:]
	}
	codeRanges = xArticleCodeRanges(articleMarkdown)
	allOccurrences = xArticleImagePattern.FindAllStringSubmatchIndex(articleMarkdown, -1)
	occurrences := make([][]int, 0, len(allOccurrences))
	for _, occurrence := range allOccurrences {
		if !xArticleRangeContains(codeRanges, occurrence[0]) {
			occurrences = append(occurrences, occurrence)
		}
	}
	cursor := 0
	for occurrenceIndex, match := range occurrences {
		start, end := match[0], match[1]
		alt := articleMarkdown[match[2]:match[3]]
		destination := xArticleImageDestination(articleMarkdown[match[4]:match[5]])
		mediaIndex := findXArticleMedia(media, usedMedia, destination)
		remainingMedia := len(media)
		for _, isUsed := range usedMedia {
			if isUsed {
				remainingMedia--
			}
		}
		if mediaIndex < 0 && len(occurrences)-occurrenceIndex == remainingMedia {
			mediaIndex = nextXArticleMedia(usedMedia)
		}
		if mediaIndex >= 0 {
			replacement := alt
			if xArticleImageIsStandalone(articleMarkdown, start, end) {
				replacement = ""
			}
			addMarkdown(articleMarkdown[cursor:start] + replacement)
			addImage(media[mediaIndex])
			usedMedia[mediaIndex] = true
		} else {
			addMarkdown(articleMarkdown[cursor:start] + alt)
		}
		cursor = end
	}
	addMarkdown(articleMarkdown[cursor:])
	for index, item := range media {
		if !usedMedia[index] {
			addImage(item)
		}
	}
	return map[string]any{"blocks": blocks, "entities": entities}
}

func xArticleImageSourceForMatching(image xPublishImageInput) string {
	if source := strings.TrimSpace(image.OriginalSource); source != "" {
		return source
	}
	return strings.TrimSpace(image.Source)
}

func xArticleImageDestination(value string) string {
	value = strings.TrimSpace(value)
	if strings.HasPrefix(value, "<") {
		if end := strings.IndexByte(value, '>'); end > 0 {
			return strings.TrimSpace(value[1:end])
		}
	}
	if fields := strings.Fields(value); len(fields) > 0 {
		return strings.Trim(fields[0], "<>")
	}
	return value
}

func xArticleImageIsStandalone(markdown string, start, end int) bool {
	lineStart := strings.LastIndexByte(markdown[:start], '\n') + 1
	lineEnd := strings.IndexByte(markdown[end:], '\n')
	if lineEnd < 0 {
		lineEnd = len(markdown)
	} else {
		lineEnd += end
	}
	return strings.TrimSpace(markdown[lineStart:lineEnd]) == markdown[start:end]
}

type xArticleReplacement struct {
	start       int
	end         int
	replacement string
}

func xArticleImageInLink(markdown string, start, end int) bool {
	if start <= 0 || markdown[start-1] != '[' {
		return false
	}
	suffix := markdown[end:]
	return strings.HasPrefix(suffix, "](") || strings.HasPrefix(suffix, "][") || strings.HasPrefix(suffix, "]")
}

func findXArticleMedia(media []xArticleMedia, used []bool, destination string) int {
	for index, item := range media {
		if !used[index] && xArticleImageSourcesEqual(item.Source, destination) {
			return index
		}
	}
	return -1
}

func nextXArticleMedia(used []bool) int {
	for index, isUsed := range used {
		if !isUsed {
			return index
		}
	}
	return -1
}

func xArticleImageSourcesEqual(left, right string) bool {
	left = strings.TrimSpace(left)
	right = strings.TrimSpace(right)
	if left == right {
		return true
	}
	leftURL, leftErr := url.Parse(left)
	rightURL, rightErr := url.Parse(right)
	if leftErr != nil || rightErr != nil || leftURL.Path == "" || rightURL.Path == "" {
		return false
	}
	if leftURL.Scheme != "" || rightURL.Scheme != "" {
		if leftURL.Scheme == "" || rightURL.Scheme == "" {
			return false
		}
		return strings.EqualFold(leftURL.Scheme, rightURL.Scheme) &&
			strings.EqualFold(leftURL.Host, rightURL.Host) &&
			leftURL.Path == rightURL.Path &&
			leftURL.RawQuery == rightURL.RawQuery
	}
	return leftURL.Path == rightURL.Path && leftURL.RawQuery == rightURL.RawQuery
}

func (a *App) doXOAuth2JSON(
	ctx context.Context,
	credential xOAuth2Credential,
	path string,
	payload any,
	result any,
) error {
	var body io.Reader
	if payload != nil {
		encoded, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, xAPIBaseURL+path, body)
	if err != nil {
		return err
	}
	request.Header.Set("Authorization", "Bearer "+credential.AccessToken)
	request.Header.Set("Accept", "application/json")
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	client := a.xOAuth2HTTPClient
	if client == nil {
		client = newXAPIHTTPClient()
	}
	response, err := client.Do(request)
	if err != nil {
		return errors.Join(errXProviderUnavailable, err)
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, xProviderResponseSize+1))
	if err != nil || len(responseBody) > xProviderResponseSize {
		return errors.Join(errXProviderUnavailable, err)
	}
	if response.StatusCode == http.StatusUnauthorized {
		return errXOAuth2TokenInvalid
	}
	if response.StatusCode == http.StatusForbidden {
		bodyPreview := responseBody
		if len(bodyPreview) > 1024 {
			bodyPreview = bodyPreview[:1024]
		}
		log.Printf("x Article API %s returned HTTP %d: body=%q", path, response.StatusCode, string(bodyPreview))
		return errXArticleUnavailable
	}
	if response.StatusCode == http.StatusTooManyRequests || response.StatusCode >= 500 {
		return fmt.Errorf("%w: Article provider HTTP %d", errXProviderUnavailable, response.StatusCode)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("Article provider rejected request with HTTP %d", response.StatusCode)
	}
	if err := json.Unmarshal(responseBody, result); err != nil {
		return errors.Join(errXProviderUnavailable, errors.New("provider returned invalid Article JSON"))
	}
	return nil
}
