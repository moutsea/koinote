package server

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"

	"koinote/backend/internal/httpx"
	"koinote/backend/internal/model"
)

const (
	mcpTokenPrefix       = "knt_mcp_"
	mcpTokenMaxNameRunes = 80
	mcpTokenMaxDays      = 365
	defaultMCPTokenDays  = 90
	mcpTokenMaxActive    = 20
	mcpTokenRequestBytes = 4 << 10
	mcpTokenRevealLimit  = 30
	mcpTokenRevealWindow = time.Minute
)

var errMCPTokenUnauthorized = errors.New("invalid MCP bearer token")

type mcpTokenView struct {
	TokenID    string     `json:"tokenId"`
	Name       string     `json:"name"`
	Hint       string     `json:"hint"`
	Scope      string     `json:"scope"`
	ExpiresAt  *time.Time `json:"expiresAt"`
	LastUsedAt *time.Time `json:"lastUsedAt"`
	CreatedAt  *time.Time `json:"createdAt"`
	Revealable bool       `json:"revealable"`
}

type mcpPrincipal struct {
	User    model.User
	TokenID int64
	Scope   string
}

type mcpTokenExpiryInput struct {
	ExpiresInDays int  `json:"expiresInDays"`
	NeverExpires  bool `json:"neverExpires"`
}

func (p mcpPrincipal) canWrite() bool {
	return p.Scope == "write"
}

func (a *App) requireLifetimeMember(w http.ResponseWriter, r *http.Request) (model.User, bool) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return model.User{}, false
	}
	if user.MembershipTier != membershipTierLifetime {
		httpx.ErrorCode(w, http.StatusForbidden, "membership_required", "Lifetime membership is required")
		return model.User{}, false
	}
	return user, true
}

func (a *App) mcpTokensList(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	rows, err := a.db.Query(r.Context(), `
		SELECT token_id, name, token_hint, scope, expires_at, last_used_at, created_at,
		       token_ciphertext IS NOT NULL
		FROM mcp_tokens
		WHERE user_id = $1 AND revoked_at IS NULL
		  AND (expires_at IS NULL OR expires_at > now())
		ORDER BY created_at DESC
	`, user.ID)
	if err != nil {
		log.Printf("mcp token list: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	defer rows.Close()

	tokens := make([]mcpTokenView, 0)
	for rows.Next() {
		var token mcpTokenView
		if err := rows.Scan(&token.TokenID, &token.Name, &token.Hint, &token.Scope,
			&token.ExpiresAt, &token.LastUsedAt, &token.CreatedAt, &token.Revealable); err != nil {
			log.Printf("mcp token scan: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		tokens = append(tokens, token)
	}
	if rows.Err() != nil {
		log.Printf("mcp token rows: %v", rows.Err())
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"tokens": tokens})
}

func (a *App) mcpTokenCreate(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	var body struct {
		Name          string `json:"name"`
		Scope         string `json:"scope"`
		ExpiresInDays int    `json:"expiresInDays"`
		NeverExpires  bool   `json:"neverExpires"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, mcpTokenRequestBytes)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid request")
		return
	}
	body.Name = strings.TrimSpace(body.Name)
	if body.Name == "" || len([]rune(body.Name)) > mcpTokenMaxNameRunes {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_token_name", "Token name is required and must be at most 80 characters")
		return
	}
	body.Scope = strings.ToLower(strings.TrimSpace(body.Scope))
	if body.Scope != "read" && body.Scope != "write" {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_token_scope", "Token scope must be read or write")
		return
	}
	expiresAt, valid := mcpTokenExpiry(mcpTokenExpiryInput{
		ExpiresInDays: body.ExpiresInDays,
		NeverExpires:  body.NeverExpires,
	}, true)
	if !valid {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_token_expiry", "Token expiry must be permanent or between 1 and 365 days")
		return
	}

	secret, err := randomHex(32)
	if err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	plainToken := mcpTokenPrefix + secret
	hash := sha256.Sum256([]byte(plainToken))
	tokenID, err := randomUUID()
	if err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	ciphertext, err := a.encryptMCPToken(tokenID, plainToken)
	if err != nil {
		log.Printf("mcp token encrypt: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	hint := "…" + secret[len(secret)-8:]

	tx, err := a.db.Begin(r.Context())
	if err != nil {
		log.Printf("mcp token create begin: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	defer tx.Rollback(r.Context())
	if _, err := tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock($1)`, user.ID); err != nil {
		log.Printf("mcp token create lock: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	var activeCount int
	if err := tx.QueryRow(r.Context(), `
		SELECT count(*) FROM mcp_tokens
		WHERE user_id = $1 AND revoked_at IS NULL
		  AND (expires_at IS NULL OR expires_at > now())
	`, user.ID).Scan(&activeCount); err != nil {
		log.Printf("mcp token create count: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if activeCount >= mcpTokenMaxActive {
		httpx.ErrorCode(w, http.StatusConflict, "mcp_token_limit_reached", "Revoke an existing token before creating another")
		return
	}

	var view mcpTokenView
	err = tx.QueryRow(r.Context(), `
		INSERT INTO mcp_tokens (
			token_id, user_id, name, token_hash, token_ciphertext, token_hint, scope, expires_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
		RETURNING token_id, name, token_hint, scope, expires_at, last_used_at, created_at,
		          token_ciphertext IS NOT NULL
	`, tokenID, user.ID, body.Name, hash[:], ciphertext, hint, body.Scope, expiresAt).Scan(
		&view.TokenID, &view.Name, &view.Hint, &view.Scope, &view.ExpiresAt,
		&view.LastUsedAt, &view.CreatedAt, &view.Revealable,
	)
	if err != nil {
		log.Printf("mcp token create: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		log.Printf("mcp token create commit: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	httpx.JSON(w, http.StatusCreated, map[string]any{"token": view, "secret": plainToken})
}

func (a *App) mcpTokenUpdateExpiry(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	tokenID := strings.TrimSpace(r.PathValue("tokenId"))
	if tokenID == "" {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Token not found")
		return
	}

	var body mcpTokenExpiryInput
	r.Body = http.MaxBytesReader(w, r.Body, mcpTokenRequestBytes)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid request")
		return
	}
	expiresAt, valid := mcpTokenExpiry(body, false)
	if !valid {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_token_expiry", "Token expiry must be permanent or between 1 and 365 days")
		return
	}

	var view mcpTokenView
	err := a.db.QueryRow(r.Context(), `
		UPDATE mcp_tokens
		SET expires_at = $1
		WHERE token_id = $2 AND user_id = $3 AND revoked_at IS NULL
		  AND (expires_at IS NULL OR expires_at > now())
		RETURNING token_id, name, token_hint, scope, expires_at, last_used_at, created_at,
		          token_ciphertext IS NOT NULL
	`, expiresAt, tokenID, user.ID).Scan(
		&view.TokenID, &view.Name, &view.Hint, &view.Scope, &view.ExpiresAt,
		&view.LastUsedAt, &view.CreatedAt, &view.Revealable,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Token not found")
		return
	}
	if err != nil {
		log.Printf("mcp token update expiry: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"token": view})
}

func mcpTokenExpiry(input mcpTokenExpiryInput, useDefault bool) (*time.Time, bool) {
	if input.NeverExpires {
		if input.ExpiresInDays != 0 {
			return nil, false
		}
		return nil, true
	}
	days := input.ExpiresInDays
	if days == 0 && useDefault {
		days = defaultMCPTokenDays
	}
	if days < 1 || days > mcpTokenMaxDays {
		return nil, false
	}
	expiresAt := time.Now().Add(time.Duration(days) * 24 * time.Hour)
	return &expiresAt, true
}

func (a *App) mcpTokenReveal(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	if !a.rateLimit().allow(fmt.Sprintf("mcp-token-reveal:user:%d", user.ID), mcpTokenRevealLimit, mcpTokenRevealWindow) {
		tooManyAttempts(w)
		return
	}
	tokenID := strings.TrimSpace(r.PathValue("tokenId"))
	if tokenID == "" {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Token not found")
		return
	}

	var ciphertext, storedHash []byte
	err := a.db.QueryRow(r.Context(), `
		SELECT token_ciphertext, token_hash
		FROM mcp_tokens
		WHERE token_id = $1 AND user_id = $2 AND revoked_at IS NULL
		  AND (expires_at IS NULL OR expires_at > now())
	`, tokenID, user.ID).Scan(&ciphertext, &storedHash)
	if errors.Is(err, pgx.ErrNoRows) {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Token not found")
		return
	}
	if err != nil {
		log.Printf("mcp token reveal query: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if len(ciphertext) == 0 {
		httpx.ErrorCode(w, http.StatusConflict, "mcp_token_not_revealable", "This legacy token cannot be revealed; create a new token")
		return
	}
	plainToken, err := a.decryptMCPToken(tokenID, ciphertext)
	if err != nil {
		log.Printf("mcp token reveal decrypt token_id=%s: %v", tokenID, err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "mcp_token_decryption_failed", "Token cannot be decrypted; create a new token")
		return
	}
	hash := sha256.Sum256([]byte(plainToken))
	if subtle.ConstantTimeCompare(hash[:], storedHash) != 1 {
		log.Printf("mcp token reveal hash mismatch token_id=%s", tokenID)
		httpx.ErrorCode(w, http.StatusInternalServerError, "mcp_token_decryption_failed", "Token cannot be decrypted; create a new token")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]string{"secret": plainToken})
}

func (a *App) mcpTokenRevoke(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	user, ok := a.requireLifetimeMember(w, r)
	if !ok {
		return
	}
	tokenID := strings.TrimSpace(r.PathValue("tokenId"))
	if tokenID == "" {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Token not found")
		return
	}
	tag, err := a.db.Exec(r.Context(), `
		UPDATE mcp_tokens SET revoked_at = now()
		WHERE token_id = $1 AND user_id = $2 AND revoked_at IS NULL
	`, tokenID, user.ID)
	if err != nil {
		log.Printf("mcp token revoke: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if tag.RowsAffected() == 0 {
		httpx.ErrorCode(w, http.StatusNotFound, "not_found", "Token not found")
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]bool{"success": true})
}

func (a *App) authenticateMCPToken(r *http.Request) (mcpPrincipal, error) {
	authorization := strings.TrimSpace(r.Header.Get("Authorization"))
	if len(authorization) <= len("Bearer ") || !strings.EqualFold(authorization[:len("Bearer ")], "Bearer ") {
		return mcpPrincipal{}, errMCPTokenUnauthorized
	}
	plainToken := strings.TrimSpace(authorization[len("Bearer "):])
	if !strings.HasPrefix(plainToken, mcpTokenPrefix) || len(plainToken) > 128 {
		return mcpPrincipal{}, errMCPTokenUnauthorized
	}
	hash := sha256.Sum256([]byte(plainToken))

	var principal mcpPrincipal
	err := a.db.QueryRow(r.Context(), `
		SELECT u.id, u.auth_user_id, u.email, u.username, u.nickname, u.avatar_url,
		       u.is_verified, u.is_admin, u.membership_tier, u.membership_granted_at,
		       u.bonus_storage_bytes, u.stripe_customer_id, u.created_at, u.updated_at,
		       t.id, t.scope
		FROM mcp_tokens t
		JOIN users u ON u.id = t.user_id
		WHERE t.token_hash = $1
		  AND t.revoked_at IS NULL
		  AND (t.expires_at IS NULL OR t.expires_at > now())
		  AND u.membership_tier = 'lifetime'
		LIMIT 1
	`, hash[:]).Scan(
		&principal.User.ID, &principal.User.AuthUserID, &principal.User.Email,
		&principal.User.Username, &principal.User.Nickname, &principal.User.AvatarURL,
		&principal.User.IsVerified, &principal.User.IsAdmin, &principal.User.MembershipTier,
		&principal.User.MembershipGrantedAt, &principal.User.BonusStorageBytes,
		&principal.User.StripeCustomerID, &principal.User.CreatedAt, &principal.User.UpdatedAt,
		&principal.TokenID, &principal.Scope,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return mcpPrincipal{}, errMCPTokenUnauthorized
	}
	if err != nil {
		return mcpPrincipal{}, err
	}
	_, _ = a.db.Exec(r.Context(), `
		UPDATE mcp_tokens SET last_used_at = now()
		WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 hour')
	`, principal.TokenID)
	return principal, nil
}

func (a *App) mcpTokenCipher() (cipher.AEAD, error) {
	secret := strings.TrimSpace(a.cfg.MCPTokenEncryptionKey)
	if secret == "" && !a.cfg.IsProduction() {
		secret = a.cfg.SessionSecret
	}
	if secret == "" {
		return nil, errors.New("MCP token encryption key is empty")
	}
	key := sha256.Sum256([]byte("koinote:mcp-token:v1:" + secret))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func (a *App) encryptMCPToken(tokenID, plainToken string) ([]byte, error) {
	aead, err := a.mcpTokenCipher()
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, err
	}
	return aead.Seal(nonce, nonce, []byte(plainToken), []byte(tokenID)), nil
}

func (a *App) decryptMCPToken(tokenID string, ciphertext []byte) (string, error) {
	aead, err := a.mcpTokenCipher()
	if err != nil {
		return "", err
	}
	if len(ciphertext) < aead.NonceSize() {
		return "", errors.New("MCP token ciphertext is truncated")
	}
	nonce := ciphertext[:aead.NonceSize()]
	plain, err := aead.Open(nil, nonce, ciphertext[aead.NonceSize():], []byte(tokenID))
	if err != nil {
		return "", err
	}
	return string(plain), nil
}
