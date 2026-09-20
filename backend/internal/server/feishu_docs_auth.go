package server

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"koinote/backend/internal/httpx"
)

const feishuStateCookie = "koinote_feishu_state"
const feishuStateTTL = 10 * time.Minute
const feishuAccountConcurrency = 3

type feishuAccountView struct {
	OpenID string `json:"openId"`
	Name   string `json:"name"`
}

type feishuCredential struct {
	feishuAccountView
	AccessToken string
}

type feishuPending struct {
	UserID        int
	Verifier      string
	DesktopScheme string
}

func (a *App) lockFeishuAccount(ctx context.Context, userID int) (*pgxpool.Conn, func(), error) {
	select {
	case a.feishuAccountSlots <- struct{}{}:
	default:
		return nil, nil, errFeishuServerBusy
	}
	releaseSlot := func() { <-a.feishuAccountSlots }
	connection, err := a.db.Acquire(ctx)
	if err != nil {
		releaseSlot()
		return nil, nil, err
	}
	key := "koinote:feishu:" + strconv.Itoa(userID)
	var locked bool
	err = connection.QueryRow(ctx, `SELECT pg_try_advisory_lock(hashtextextended($1, 0))`, key).Scan(&locked)
	if err != nil || !locked {
		if err != nil {
			cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_ = connection.Conn().Close(cleanup)
			cancel()
		}
		connection.Release()
		releaseSlot()
		if err == nil {
			err = errFeishuBusy
		}
		return nil, nil, err
	}
	release := func() {
		defer releaseSlot()
		cleanup, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := connection.Exec(cleanup, `SELECT pg_advisory_unlock(hashtextextended($1, 0))`, key); err != nil {
			_ = connection.Conn().Close(cleanup)
		}
		connection.Release()
	}
	return connection, release, nil
}

func (a *App) feishuRedirectURI() string {
	return strings.TrimRight(a.cfg.AppURL, "/") + "/api/feishu/oauth/callback"
}

func (a *App) feishuAuthorizeURL(state, verifier string) string {
	hash := sha256.Sum256([]byte(verifier))
	query := url.Values{
		"client_id":             {a.cfg.FeishuClientID},
		"response_type":         {"code"},
		"redirect_uri":          {a.feishuRedirectURI()},
		"scope":                 {feishuScope},
		"state":                 {state},
		"code_challenge":        {base64.RawURLEncoding.EncodeToString(hash[:])},
		"code_challenge_method": {"S256"},
	}
	return "https://accounts.feishu.cn/open-apis/authen/v1/authorize?" + query.Encode()
}

func (a *App) feishuOAuthStart(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	if !a.cfg.FeishuDocsEnabled() {
		writeFeishuError(w, errFeishuNotConfigured)
		return
	}
	if !a.rateLimit().allow("feishu-auth:"+strconv.Itoa(user.ID), 10, time.Hour) {
		httpx.ErrorCode(w, 429, "too_many_requests", "Too many authorization attempts")
		return
	}
	state, err := randomHex(32)
	if err != nil {
		writeFeishuError(w, err)
		return
	}
	verifier, err := randomHex(48)
	if err != nil {
		writeFeishuError(w, err)
		return
	}
	scheme := ""
	switch r.URL.Query().Get("client") {
	case "desktop":
		scheme = "koinote"
	case "desktop-local":
		scheme = "koinote-local"
	}
	if _, err = a.db.Exec(r.Context(), `DELETE FROM feishu_oauth_pending WHERE expires_at <= now()`); err != nil {
		writeFeishuError(w, err)
		return
	}
	_, err = a.db.Exec(r.Context(), `INSERT INTO feishu_oauth_pending (state,user_id,app_id,code_verifier,desktop_scheme,expires_at) VALUES ($1,$2,$3,$4,$5,$6)`, state, user.ID, a.cfg.FeishuClientID, verifier, scheme, time.Now().Add(feishuStateTTL))
	if err != nil {
		writeFeishuError(w, err)
		return
	}
	authorizeURL := a.feishuAuthorizeURL(state, verifier)
	if scheme != "" {
		authorizeURL = strings.TrimRight(a.cfg.AppURL, "/") + "/api/feishu/oauth/desktop-start?state=" + url.QueryEscape(state)
	} else {
		a.setFeishuStateCookie(w, state)
	}
	httpx.JSON(w, 200, map[string]string{"url": authorizeURL})
}

func (a *App) feishuOAuthDesktopStart(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	if !a.cfg.FeishuDocsEnabled() {
		writeFeishuError(w, errFeishuNotConfigured)
		return
	}
	state := r.URL.Query().Get("state")
	if len(state) == 0 || len(state) > 128 {
		http.Error(w, "Invalid authorization request", http.StatusBadRequest)
		return
	}
	var pending feishuPending
	err := a.db.QueryRow(r.Context(), `SELECT pending.code_verifier,pending.desktop_scheme FROM feishu_oauth_pending pending JOIN users ON users.id=pending.user_id WHERE pending.state=$1 AND pending.app_id=$2 AND pending.expires_at>now() AND users.membership_tier=$3`, state, a.cfg.FeishuClientID, membershipTierLifetime).Scan(&pending.Verifier, &pending.DesktopScheme)
	if err != nil || pending.DesktopScheme == "" {
		http.Error(w, "Invalid authorization request", 400)
		return
	}
	a.setFeishuStateCookie(w, state)
	http.Redirect(w, r, a.feishuAuthorizeURL(state, pending.Verifier), http.StatusFound)
}

func (a *App) feishuOAuthCallback(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	state := r.URL.Query().Get("state")
	cookie, err := r.Cookie(feishuStateCookie)
	a.setFeishuStateCookie(w, "")
	if !a.cfg.FeishuDocsEnabled() || state == "" || err != nil || cookie.Value != state {
		if err != nil {
			log.Printf("Feishu OAuth callback rejected: state cookie: %v", err)
		} else {
			log.Printf("Feishu OAuth callback rejected: invalid state or configuration")
		}
		redirectFeishu(w, r, "", false)
		return
	}
	var pending feishuPending
	err = a.db.QueryRow(r.Context(), `SELECT user_id,code_verifier,desktop_scheme FROM feishu_oauth_pending WHERE state=$1 AND app_id=$2 AND expires_at>now()`, state, a.cfg.FeishuClientID).Scan(&pending.UserID, &pending.Verifier, &pending.DesktopScheme)
	if err != nil {
		log.Printf("Feishu OAuth callback pending lookup: %v", err)
		redirectFeishu(w, r, "", false)
		return
	}
	connection, release, err := a.lockFeishuAccount(r.Context(), pending.UserID)
	if err != nil {
		log.Printf("Feishu OAuth callback account lock: %v", err)
		redirectFeishu(w, r, pending.DesktopScheme, false)
		return
	}
	defer release()
	err = connection.QueryRow(r.Context(), `DELETE FROM feishu_oauth_pending WHERE state=$1 AND app_id=$2 AND expires_at>now() RETURNING user_id,code_verifier,desktop_scheme`, state, a.cfg.FeishuClientID).Scan(&pending.UserID, &pending.Verifier, &pending.DesktopScheme)
	code := r.URL.Query().Get("code")
	if err != nil || code == "" || r.URL.Query().Get("error") != "" {
		if err != nil {
			log.Printf("Feishu OAuth callback pending consume: %v", err)
		} else if code == "" {
			log.Printf("Feishu OAuth callback rejected: authorization code missing")
		} else {
			log.Printf("Feishu OAuth callback rejected by provider")
		}
		redirectFeishu(w, r, pending.DesktopScheme, false)
		return
	}
	var membershipTier string
	err = connection.QueryRow(r.Context(), `SELECT membership_tier FROM users WHERE id=$1`, pending.UserID).Scan(&membershipTier)
	if err != nil || membershipTier != membershipTierLifetime {
		if err != nil {
			log.Printf("Feishu OAuth callback membership lookup: %v", err)
		} else {
			log.Printf("Feishu OAuth callback rejected: membership required")
		}
		redirectFeishu(w, r, pending.DesktopScheme, false)
		return
	}
	token, err := a.feishuTokenRequest(r.Context(), map[string]string{
		"grant_type": "authorization_code", "code": code,
		"redirect_uri": a.feishuRedirectURI(), "code_verifier": pending.Verifier,
	})
	if err != nil {
		log.Printf("Feishu OAuth callback token exchange: %v", err)
		redirectFeishu(w, r, pending.DesktopScheme, false)
		return
	}
	var profileResponse struct {
		OpenID string `json:"open_id"`
		Name   string `json:"name"`
	}
	err = a.feishuJSON(r.Context(), token.AccessToken, http.MethodGet, "/authen/v1/user_info", nil, &profileResponse)
	if err != nil || profileResponse.OpenID == "" {
		if err != nil {
			log.Printf("Feishu OAuth callback profile lookup: %v", err)
		} else {
			log.Printf("Feishu OAuth callback profile missing open ID")
		}
		redirectFeishu(w, r, pending.DesktopScheme, false)
		return
	}
	if strings.TrimSpace(profileResponse.Name) == "" {
		profileResponse.Name = profileResponse.OpenID
	}
	profile := feishuAccountView{OpenID: profileResponse.OpenID, Name: profileResponse.Name}
	err = a.storeFeishuCredential(r.Context(), connection, pending.UserID, token, profile)
	if err != nil {
		log.Printf("Feishu OAuth callback credential persistence: %v", err)
	}
	redirectFeishu(w, r, pending.DesktopScheme, err == nil)
}

func redirectFeishu(w http.ResponseWriter, r *http.Request, scheme string, success bool) {
	status := "error"
	if success {
		status = "success"
	}
	target := "/settings?section=feishu&feishu=" + status
	if scheme == "koinote" || scheme == "koinote-local" {
		target = scheme + "://feishu-oauth?status=" + status
	}
	http.Redirect(w, r, target, http.StatusFound)
}

func (a *App) setFeishuStateCookie(w http.ResponseWriter, state string) {
	maxAge := int(feishuStateTTL.Seconds())
	if state == "" {
		maxAge = -1
	}
	http.SetCookie(w, &http.Cookie{Name: feishuStateCookie, Value: state, Path: "/api/feishu/oauth", HttpOnly: true, Secure: a.cfg.IsProduction(), SameSite: http.SameSiteLaxMode, MaxAge: maxAge})
}

func (a *App) feishuAccountGet(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	var account *feishuAccountView
	if a.cfg.FeishuDocsEnabled() {
		view := &feishuAccountView{}
		err := a.db.QueryRow(r.Context(), `SELECT open_id,name FROM feishu_accounts WHERE user_id=$1 AND app_id=$2`, user.ID, a.cfg.FeishuClientID).Scan(&view.OpenID, &view.Name)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			writeFeishuError(w, err)
			return
		}
		if err == nil {
			account = view
		}
	}
	httpx.JSON(w, 200, map[string]any{"account": account, "configured": a.cfg.FeishuDocsEnabled()})
}

func (a *App) feishuAccountDelete(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	connection, release, err := a.lockFeishuAccount(r.Context(), user.ID)
	if err != nil {
		writeFeishuError(w, err)
		return
	}
	defer release()
	if _, err = connection.Exec(r.Context(), `DELETE FROM feishu_oauth_pending WHERE user_id=$1`, user.ID); err == nil {
		_, err = connection.Exec(r.Context(), `DELETE FROM feishu_accounts WHERE user_id=$1`, user.ID)
	}
	if err != nil {
		writeFeishuError(w, err)
		return
	}
	httpx.JSON(w, 200, map[string]bool{"success": true})
}

func (a *App) storeFeishuCredential(ctx context.Context, connection *pgxpool.Conn, userID int, token feishuTokenResponse, profile feishuAccountView) error {
	access, err := a.encryptFeishuCredential(userID, "access", token.AccessToken)
	if err != nil {
		return err
	}
	refresh, err := a.encryptFeishuCredential(userID, "refresh", token.RefreshToken)
	if err != nil {
		return err
	}
	_, err = connection.Exec(ctx, `INSERT INTO feishu_accounts (user_id,app_id,open_id,name,access_token_ciphertext,refresh_token_ciphertext,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
		ON CONFLICT (user_id) DO UPDATE SET app_id=EXCLUDED.app_id,open_id=EXCLUDED.open_id,name=EXCLUDED.name,access_token_ciphertext=EXCLUDED.access_token_ciphertext,refresh_token_ciphertext=EXCLUDED.refresh_token_ciphertext,expires_at=EXCLUDED.expires_at,updated_at=now()`, userID, a.cfg.FeishuClientID, profile.OpenID, profile.Name, access, refresh, time.Now().Add(time.Duration(token.ExpiresIn)*time.Second))
	return err
}

func (a *App) loadFeishuCredential(ctx context.Context, connection *pgxpool.Conn, userID int) (feishuCredential, error) {
	var credential feishuCredential
	var access, refresh []byte
	var expires time.Time
	err := connection.QueryRow(ctx, `SELECT open_id,name,access_token_ciphertext,refresh_token_ciphertext,expires_at FROM feishu_accounts WHERE user_id=$1 AND app_id=$2`, userID, a.cfg.FeishuClientID).Scan(&credential.OpenID, &credential.Name, &access, &refresh, &expires)
	if errors.Is(err, pgx.ErrNoRows) {
		return credential, errFeishuNotBound
	}
	if err != nil {
		return credential, err
	}
	credential.AccessToken, err = a.decryptFeishuCredential(userID, "access", access)
	if err != nil {
		return credential, err
	}
	if expires.After(time.Now().Add(2 * time.Minute)) {
		return credential, nil
	}
	refreshToken, err := a.decryptFeishuCredential(userID, "refresh", refresh)
	if err != nil {
		return credential, err
	}
	token, err := a.feishuTokenRequest(ctx, map[string]string{"grant_type": "refresh_token", "refresh_token": refreshToken})
	if err != nil {
		return credential, err
	}
	persistCtx, persistCancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
	defer persistCancel()
	if err = a.storeFeishuCredential(persistCtx, connection, userID, token, credential.feishuAccountView); err != nil {
		return credential, errors.Join(errFeishuTokenInvalid, err)
	}
	credential.AccessToken = token.AccessToken
	return credential, nil
}

func (a *App) feishuCipher() (cipher.AEAD, error) {
	secret := a.cfg.FeishuCredentialEncryptionKey
	if secret == "" {
		return nil, errFeishuNotConfigured
	}
	key := sha256.Sum256([]byte("koinote:feishu:v1:" + secret))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func (a *App) encryptFeishuCredential(userID int, field, value string) ([]byte, error) {
	aead, err := a.feishuCipher()
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err = io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return aead.Seal(nonce, nonce, []byte(value), []byte(strconv.Itoa(userID)+":"+field)), nil
}

func (a *App) decryptFeishuCredential(userID int, field string, ciphertext []byte) (string, error) {
	aead, err := a.feishuCipher()
	if err != nil {
		return "", err
	}
	if len(ciphertext) < aead.NonceSize() {
		return "", errors.New("Feishu credential truncated")
	}
	plain, err := aead.Open(nil, ciphertext[:aead.NonceSize()], ciphertext[aead.NonceSize():], []byte(strconv.Itoa(userID)+":"+field))
	return string(plain), err
}

func writeFeishuError(w http.ResponseWriter, err error) {
	status, code := 502, "feishu_sync_failed"
	for _, known := range []error{errFeishuNotConfigured, errFeishuNotBound, errFeishuTokenInvalid, errFeishuBusy, errFeishuServerBusy, errFeishuContentLimit, errFeishuImage} {
		if errors.Is(err, known) {
			code = known.Error()
			break
		}
	}
	switch code {
	case "feishu_not_configured":
		status = 503
	case "feishu_account_not_bound", "feishu_token_invalid", "feishu_busy", "feishu_server_busy":
		status = 409
	case "feishu_content_limit", "feishu_image_failed":
		status = 422
	}
	var provider *feishuAPIError
	if errors.As(err, &provider) && (provider.Status == 403 || provider.Code == 1770032) {
		code = "feishu_permission_denied"
	}
	log.Printf("Feishu operation failed: %s: %v", code, err)
	httpx.ErrorCode(w, status, code, "Feishu operation failed")
}
