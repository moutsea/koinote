package server

import (
	"context"
	"crypto/hmac"
	cryptorand "crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"koinote/backend/internal/httpx"
	"koinote/backend/internal/model"
)

const (
	desktopClientID             = "koinote-desktop"
	desktopRedirectURI          = "koinote://auth"
	desktopAuthorizationCodeTTL = 5 * time.Minute
	desktopAccessTokenTTL       = 15 * time.Minute
	desktopRefreshTokenTTL      = 30 * 24 * time.Hour
	desktopAuthorizationPrefix  = "knt_app_code_"
	desktopAccessTokenPrefix    = "knt_app_at_"
	desktopRefreshTokenPrefix   = "knt_app_rt_"
)

var pkceValuePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{43,128}$`)

type desktopTokenResponse struct {
	AccessToken      string     `json:"accessToken"`
	RefreshToken     string     `json:"refreshToken"`
	TokenType        string     `json:"tokenType"`
	ExpiresInSeconds int        `json:"expiresInSeconds"`
	User             model.User `json:"user"`
}

func (a *App) desktopAuthorize(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	var body struct {
		ClientID      string `json:"clientId"`
		CodeChallenge string `json:"codeChallenge"`
		State         string `json:"state"`
	}
	if !decodeAuthBody(w, r, &body) {
		return
	}
	body.ClientID = strings.TrimSpace(body.ClientID)
	body.CodeChallenge = strings.TrimSpace(body.CodeChallenge)
	body.State = strings.TrimSpace(body.State)
	if body.ClientID != desktopClientID || !pkceValuePattern.MatchString(body.CodeChallenge) ||
		body.State == "" || len(body.State) > 512 {
		httpx.ErrorCode(w, http.StatusBadRequest, "desktop_authorization_invalid", "Invalid desktop authorization request")
		return
	}
	if !a.rateLimit().allow("desktop-authorize:"+strconv.Itoa(user.ID), 12, time.Minute) {
		httpx.ErrorCode(w, http.StatusTooManyRequests, "rate_limited", "Too many authorization attempts")
		return
	}
	code, err := randomPrefixedToken(desktopAuthorizationPrefix, 32)
	if err != nil {
		log.Printf("desktop authorization code: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error")
		return
	}
	codeHash := sha256.Sum256([]byte(code))
	if _, err := a.db.Exec(r.Context(), `
		WITH expired AS (
			DELETE FROM desktop_authorization_codes WHERE expires_at <= now()
		)
		INSERT INTO desktop_authorization_codes (code_hash, user_id, code_challenge, expires_at)
		VALUES ($1, $2, $3, now() + $4::interval)
	`, codeHash[:], user.ID, body.CodeChallenge, durationInterval(desktopAuthorizationCodeTTL)); err != nil {
		log.Printf("desktop authorization insert: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error")
		return
	}
	callback, _ := url.Parse(desktopRedirectURI)
	query := callback.Query()
	query.Set("code", code)
	query.Set("state", body.State)
	callback.RawQuery = query.Encode()
	httpx.JSON(w, http.StatusOK, map[string]string{"redirectUri": callback.String()})
}

func (a *App) desktopToken(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Pragma", "no-cache")
	if !a.rateLimit().allow("desktop-token:"+requestIP(r), 30, time.Minute) {
		httpx.ErrorCode(w, http.StatusTooManyRequests, "rate_limited", "Too many token requests")
		return
	}
	var body struct {
		GrantType    string `json:"grantType"`
		ClientID     string `json:"clientId"`
		Code         string `json:"code"`
		CodeVerifier string `json:"codeVerifier"`
		RefreshToken string `json:"refreshToken"`
	}
	if !decodeAuthBody(w, r, &body) {
		return
	}
	if strings.TrimSpace(body.ClientID) != desktopClientID {
		desktopTokenError(w)
		return
	}

	var response desktopTokenResponse
	var err error
	switch strings.TrimSpace(body.GrantType) {
	case "authorization_code":
		response, err = a.exchangeDesktopAuthorizationCode(r.Context(), strings.TrimSpace(body.Code), strings.TrimSpace(body.CodeVerifier))
	case "refresh_token":
		response, err = a.rotateDesktopRefreshToken(r.Context(), strings.TrimSpace(body.RefreshToken))
	default:
		desktopTokenError(w)
		return
	}
	if errors.Is(err, errDesktopTokenInvalid) {
		desktopTokenError(w)
		return
	}
	if err != nil {
		log.Printf("desktop token exchange: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error")
		return
	}
	httpx.JSON(w, http.StatusOK, response)
}

func (a *App) desktopRevoke(w http.ResponseWriter, r *http.Request) {
	token := bearerToken(r)
	if !strings.HasPrefix(token, desktopAccessTokenPrefix) {
		httpx.ErrorCode(w, http.StatusUnauthorized, "unauthorized", "Not logged in")
		return
	}
	hash := sha256.Sum256([]byte(token))
	command, err := a.db.Exec(r.Context(), `
		WITH target AS (
			SELECT refresh_token_id FROM desktop_access_tokens
			WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
		), revoked_refresh AS (
			UPDATE desktop_refresh_tokens
			SET revoked_at = COALESCE(revoked_at, now())
			WHERE id IN (SELECT refresh_token_id FROM target)
			RETURNING family_id
		)
		UPDATE desktop_access_tokens
		SET revoked_at = COALESCE(revoked_at, now())
		WHERE refresh_token_id IN (
			SELECT id FROM desktop_refresh_tokens
			WHERE family_id IN (SELECT family_id FROM revoked_refresh)
		)
	`, hash[:])
	if err != nil {
		log.Printf("desktop revoke: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error")
		return
	}
	if command.RowsAffected() == 0 {
		httpx.ErrorCode(w, http.StatusUnauthorized, "unauthorized", "Not logged in")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"success": true})
}

var errDesktopTokenInvalid = errors.New("desktop token invalid")

func (a *App) exchangeDesktopAuthorizationCode(ctx context.Context, code, verifier string) (desktopTokenResponse, error) {
	if !strings.HasPrefix(code, desktopAuthorizationPrefix) || !pkceValuePattern.MatchString(verifier) {
		return desktopTokenResponse{}, errDesktopTokenInvalid
	}
	verifierHash := sha256.Sum256([]byte(verifier))
	challenge := base64.RawURLEncoding.EncodeToString(verifierHash[:])
	codeHash := sha256.Sum256([]byte(code))

	tx, err := a.db.Begin(ctx)
	if err != nil {
		return desktopTokenResponse{}, err
	}
	defer tx.Rollback(ctx)
	var userID int
	var storedChallenge string
	err = tx.QueryRow(ctx, `
		DELETE FROM desktop_authorization_codes
		WHERE code_hash = $1 AND expires_at > now()
		RETURNING user_id, code_challenge
	`, codeHash[:]).Scan(&userID, &storedChallenge)
	if errors.Is(err, pgx.ErrNoRows) {
		return desktopTokenResponse{}, errDesktopTokenInvalid
	}
	if err != nil {
		return desktopTokenResponse{}, err
	}
	if !constantTimeStringEqual(storedChallenge, challenge) {
		return desktopTokenResponse{}, errDesktopTokenInvalid
	}
	response, err := a.issueDesktopTokenPair(ctx, tx, userID, "")
	if err != nil {
		return desktopTokenResponse{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return desktopTokenResponse{}, err
	}
	return response, nil
}

func (a *App) rotateDesktopRefreshToken(ctx context.Context, refreshToken string) (desktopTokenResponse, error) {
	if !strings.HasPrefix(refreshToken, desktopRefreshTokenPrefix) {
		return desktopTokenResponse{}, errDesktopTokenInvalid
	}
	hash := sha256.Sum256([]byte(refreshToken))
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return desktopTokenResponse{}, err
	}
	defer tx.Rollback(ctx)
	var tokenID int64
	var userID int
	var familyID string
	var revoked, expired, sessionInvalid bool
	err = tx.QueryRow(ctx, `
		SELECT token.id, token.user_id, token.family_id,
		       token.revoked_at IS NOT NULL,
		       token.expires_at <= now(),
		       token.session_version <> u.session_version
		FROM desktop_refresh_tokens token
		JOIN users u ON u.id = token.user_id
		WHERE token.token_hash = $1
		FOR UPDATE OF token
	`, hash[:]).Scan(&tokenID, &userID, &familyID, &revoked, &expired, &sessionInvalid)
	if errors.Is(err, pgx.ErrNoRows) {
		return desktopTokenResponse{}, errDesktopTokenInvalid
	}
	if err != nil {
		return desktopTokenResponse{}, err
	}
	if revoked || expired || sessionInvalid {
		if err := revokeDesktopTokenFamily(ctx, tx, familyID); err != nil {
			return desktopTokenResponse{}, err
		}
		if err := tx.Commit(ctx); err != nil {
			return desktopTokenResponse{}, err
		}
		return desktopTokenResponse{}, errDesktopTokenInvalid
	}
	if _, err := tx.Exec(ctx, `
		UPDATE desktop_refresh_tokens SET revoked_at = now(), last_used_at = now() WHERE id = $1
	`, tokenID); err != nil {
		return desktopTokenResponse{}, err
	}
	if _, err := tx.Exec(ctx, `
		UPDATE desktop_access_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE refresh_token_id = $1
	`, tokenID); err != nil {
		return desktopTokenResponse{}, err
	}
	response, err := a.issueDesktopTokenPair(ctx, tx, userID, familyID)
	if err != nil {
		return desktopTokenResponse{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return desktopTokenResponse{}, err
	}
	return response, nil
}

type desktopTokenTx interface {
	QueryRow(context.Context, string, ...any) pgx.Row
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

func revokeDesktopTokenFamily(ctx context.Context, tx desktopTokenTx, familyID string) error {
	if _, err := tx.Exec(ctx, `
		UPDATE desktop_refresh_tokens
		SET revoked_at = COALESCE(revoked_at, now())
		WHERE family_id = $1
	`, familyID); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `
		UPDATE desktop_access_tokens
		SET revoked_at = COALESCE(revoked_at, now())
		WHERE refresh_token_id IN (
			SELECT id FROM desktop_refresh_tokens WHERE family_id = $1
		)
	`, familyID)
	return err
}

func (a *App) issueDesktopTokenPair(ctx context.Context, tx desktopTokenTx, userID int, familyID string) (desktopTokenResponse, error) {
	if _, err := tx.Exec(ctx, `
		DELETE FROM desktop_refresh_tokens
		WHERE id IN (
			SELECT id FROM desktop_refresh_tokens
			WHERE expires_at <= now()
			ORDER BY expires_at
			LIMIT 500
		)
	`); err != nil {
		return desktopTokenResponse{}, err
	}
	if familyID == "" {
		var err error
		familyID, err = randomUUID()
		if err != nil {
			return desktopTokenResponse{}, err
		}
	}
	refreshToken, err := randomPrefixedToken(desktopRefreshTokenPrefix, 32)
	if err != nil {
		return desktopTokenResponse{}, err
	}
	accessToken, err := randomPrefixedToken(desktopAccessTokenPrefix, 32)
	if err != nil {
		return desktopTokenResponse{}, err
	}
	tokenID, err := randomUUID()
	if err != nil {
		return desktopTokenResponse{}, err
	}
	refreshHash := sha256.Sum256([]byte(refreshToken))
	accessHash := sha256.Sum256([]byte(accessToken))
	var refreshID int64
	var authUserID string
	err = tx.QueryRow(ctx, `
		WITH selected AS (
			SELECT auth_user_id, session_version FROM users WHERE id = $1
		), inserted AS (
			INSERT INTO desktop_refresh_tokens (
				token_id, family_id, user_id, token_hash, session_version, expires_at
			)
			SELECT $2, $3, $1, $4, session_version, now() + $5::interval FROM selected
			RETURNING id
		)
		SELECT inserted.id, selected.auth_user_id FROM inserted CROSS JOIN selected
	`, userID, tokenID, familyID, refreshHash[:], durationInterval(desktopRefreshTokenTTL)).Scan(&refreshID, &authUserID)
	if err != nil {
		return desktopTokenResponse{}, err
	}
	if err := tx.QueryRow(ctx, `
		INSERT INTO desktop_access_tokens (
			token_hash, refresh_token_id, user_id, session_version, expires_at
		)
		SELECT $1, $2, $3, session_version, now() + $4::interval FROM users WHERE id = $3
		RETURNING id
	`, accessHash[:], refreshID, userID, durationInterval(desktopAccessTokenTTL)).Scan(new(int64)); err != nil {
		return desktopTokenResponse{}, err
	}
	user, err := a.getUserByAuthUserID(ctx, authUserID)
	if err != nil {
		return desktopTokenResponse{}, err
	}
	return desktopTokenResponse{
		AccessToken: accessToken, RefreshToken: refreshToken, TokenType: "Bearer",
		ExpiresInSeconds: int(desktopAccessTokenTTL.Seconds()), User: user,
	}, nil
}

func (a *App) desktopUserFromBearer(ctx context.Context, token string) (model.User, bool, error) {
	if !strings.HasPrefix(token, desktopAccessTokenPrefix) {
		return model.User{}, false, nil
	}
	hash := sha256.Sum256([]byte(token))
	var authUserID string
	err := a.db.QueryRow(ctx, `
		UPDATE desktop_access_tokens token
		SET last_used_at = now()
		FROM users u
		WHERE token.token_hash = $1
		  AND token.user_id = u.id
		  AND token.revoked_at IS NULL
		  AND token.expires_at > now()
		  AND token.session_version = u.session_version
		RETURNING u.auth_user_id
	`, hash[:]).Scan(&authUserID)
	if errors.Is(err, pgx.ErrNoRows) {
		return model.User{}, false, nil
	}
	if err != nil {
		return model.User{}, false, err
	}
	user, err := a.getUserByAuthUserID(ctx, authUserID)
	if errors.Is(err, pgx.ErrNoRows) {
		return model.User{}, false, nil
	}
	if err != nil {
		return model.User{}, false, err
	}
	return user, true, nil
}

func bearerToken(r *http.Request) string {
	header := strings.TrimSpace(r.Header.Get("Authorization"))
	parts := strings.Fields(header)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return ""
	}
	return parts[1]
}

func desktopRequestAllowed(r *http.Request) bool {
	path := r.URL.Path
	method := r.Method
	switch path {
	case "/api/auth/session":
		return method == http.MethodGet
	case "/api/account":
		return method == http.MethodDelete
	case "/api/billing/status", "/api/invitations", "/api/storage/usage":
		return method == http.MethodGet
	case "/api/billing/checkout", "/api/billing/checkout/confirm":
		return method == http.MethodPost
	case "/api/admin/stats":
		return method == http.MethodGet
	case "/api/mcp/tokens":
		return method == http.MethodGet || method == http.MethodPost
	case "/api/mcp/activity":
		return method == http.MethodGet
	case "/api/analytics/events":
		return method == http.MethodPost
	case "/api/settings/document-history":
		return method == http.MethodGet || method == http.MethodPut
	case "/api/editor/tabs":
		return method == http.MethodGet || method == http.MethodPut
	case "/api/folders":
		return method == http.MethodGet || method == http.MethodPost
	case "/api/documents":
		return method == http.MethodGet || method == http.MethodPost
	case "/api/documents/search", "/api/documents/trash":
		return method == http.MethodGet
	}
	if rest, found := strings.CutPrefix(path, "/api/folders/"); found {
		parts := strings.Split(rest, "/")
		if len(parts) == 1 && parts[0] != "" {
			return method == http.MethodPut || method == http.MethodDelete
		}
		return len(parts) == 2 && parts[0] != "" && parts[1] == "parent" && method == http.MethodPut
	}
	if rest, found := strings.CutPrefix(path, "/api/mcp/tokens/"); found {
		parts := strings.Split(rest, "/")
		if len(parts) == 1 && parts[0] != "" {
			return method == http.MethodPatch || method == http.MethodDelete
		}
		return len(parts) == 2 && parts[0] != "" && parts[1] == "reveal" && method == http.MethodPost
	}
	if rest, found := strings.CutPrefix(path, "/api/documents/"); found {
		parts := strings.Split(rest, "/")
		if len(parts) == 1 && parts[0] != "" {
			return method == http.MethodGet || method == http.MethodPut || method == http.MethodDelete
		}
		if len(parts) == 2 && parts[0] != "" {
			switch parts[1] {
			case "folder":
				return method == http.MethodPut
			case "permanent":
				return method == http.MethodDelete
			case "restore":
				return method == http.MethodPost
			case "share":
				return method == http.MethodPost || method == http.MethodDelete
			case "versions":
				return method == http.MethodGet
			}
		}
		if len(parts) == 3 && parts[0] != "" && parts[1] == "versions" && parts[2] != "" {
			return method == http.MethodGet
		}
		return len(parts) == 4 && parts[0] != "" && parts[1] == "versions" &&
			parts[2] != "" && parts[3] == "restore" && method == http.MethodPost
	}
	return false
}

func desktopTokenError(w http.ResponseWriter) {
	httpx.ErrorCode(w, http.StatusUnauthorized, "desktop_token_invalid", "Desktop authorization is invalid or expired")
}

func randomPrefixedToken(prefix string, byteCount int) (string, error) {
	raw := make([]byte, byteCount)
	if _, err := cryptorand.Read(raw); err != nil {
		return "", err
	}
	return prefix + hex.EncodeToString(raw), nil
}

func durationInterval(value time.Duration) string {
	return strconv.FormatInt(int64(value.Seconds()), 10) + " seconds"
}

func constantTimeStringEqual(left, right string) bool {
	return hmac.Equal([]byte(left), []byte(right))
}
