package server

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"koinote/backend/internal/model"
)

// ---------- state 签名与 cookie ----------

func (a *App) signOAuthState(payload oauthStatePayload) (string, error) {
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}
	encoded := base64.RawURLEncoding.EncodeToString(payloadBytes)
	return encoded + "." + a.sessionSignature(encoded), nil
}

func (a *App) oauthStateFromCookie(r *http.Request) (oauthStatePayload, bool) {
	cookie, err := r.Cookie(oauthStateCookieName)
	if err != nil || cookie.Value == "" {
		return oauthStatePayload{}, false
	}
	parts := strings.Split(cookie.Value, ".")
	if len(parts) != 2 {
		return oauthStatePayload{}, false
	}
	if !hmac.Equal([]byte(a.sessionSignature(parts[0])), []byte(parts[1])) {
		return oauthStatePayload{}, false
	}
	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return oauthStatePayload{}, false
	}
	var payload oauthStatePayload
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		return oauthStatePayload{}, false
	}
	return payload, true
}

func (a *App) setOAuthStateCookie(w http.ResponseWriter, value string) {
	http.SetCookie(w, &http.Cookie{
		Name:     oauthStateCookieName,
		Value:    value,
		Path:     "/api/auth/oauth",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   a.cfg.IsProduction(),
		Expires:  time.Now().Add(oauthStateTTL),
		MaxAge:   int(oauthStateTTL.Seconds()),
	})
}

func (a *App) clearOAuthStateCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     oauthStateCookieName,
		Value:    "",
		Path:     "/api/auth/oauth",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   a.cfg.IsProduction(),
		Expires:  time.Unix(0, 0),
		MaxAge:   -1,
	})
}

// ---------- code 换 token ----------

func (a *App) exchangeOAuthCode(ctx context.Context, provider oauthProviderConfig, code string) (oauthTokenResponse, error) {
	values := url.Values{}
	values.Set("client_id", provider.ClientID)
	values.Set("client_secret", provider.ClientSecret)
	values.Set("code", code)
	values.Set("redirect_uri", provider.RedirectURI)
	values.Set("grant_type", "authorization_code")

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, provider.TokenURL, strings.NewReader(values.Encode()))
	if err != nil {
		return oauthTokenResponse{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "Koinote-Go-OAuth")

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return oauthTokenResponse{}, err
	}
	defer resp.Body.Close()

	var token oauthTokenResponse
	if err := json.NewDecoder(resp.Body).Decode(&token); err != nil {
		return oauthTokenResponse{}, err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 || token.AccessToken == "" || token.Error != "" {
		return oauthTokenResponse{}, fmt.Errorf("oauth token response %d: %s %s", resp.StatusCode, token.Error, token.Description)
	}
	return token, nil
}

// ---------- 拉取用户资料 ----------

func (a *App) fetchOAuthProfile(ctx context.Context, provider, accessToken string) (oauthProfile, error) {
	switch provider {
	case "google":
		return fetchGoogleProfile(ctx, accessToken)
	case "github":
		return fetchGitHubProfile(ctx, accessToken)
	default:
		return oauthProfile{}, fmt.Errorf("unsupported oauth provider: %s", provider)
	}
}

func fetchGoogleProfile(ctx context.Context, accessToken string) (oauthProfile, error) {
	var p struct {
		Sub           string `json:"sub"`
		Email         string `json:"email"`
		EmailVerified bool   `json:"email_verified"`
		Name          string `json:"name"`
		Picture       string `json:"picture"`
	}
	if err := getOAuthJSON(ctx, "https://openidconnect.googleapis.com/v1/userinfo", accessToken, &p); err != nil {
		return oauthProfile{}, err
	}
	if p.Sub == "" || p.Email == "" || !p.EmailVerified {
		return oauthProfile{}, errors.New("google profile is missing verified email")
	}
	return oauthProfile{
		Provider:       "google",
		ProviderUserID: p.Sub,
		Email:          strings.ToLower(strings.TrimSpace(p.Email)),
		Name:           p.Name,
		AvatarURL:      p.Picture,
	}, nil
}

func fetchGitHubProfile(ctx context.Context, accessToken string) (oauthProfile, error) {
	var u struct {
		ID        int64  `json:"id"`
		Login     string `json:"login"`
		Name      string `json:"name"`
		Email     string `json:"email"`
		AvatarURL string `json:"avatar_url"`
	}
	if err := getOAuthJSON(ctx, "https://api.github.com/user", accessToken, &u); err != nil {
		return oauthProfile{}, err
	}
	// /user.email 是公开资料字段，响应本身不携带 verified 标记。即使它非空，也必须
	// 用 /user/emails 再确认，不能让未验证的公开邮箱参与本站按邮箱合并账号。
	email, err := fetchGitHubVerifiedEmail(ctx, accessToken, u.Email)
	if err != nil {
		return oauthProfile{}, err
	}
	if u.ID == 0 || email == "" {
		return oauthProfile{}, errors.New("github profile is missing id or verified email")
	}
	return oauthProfile{
		Provider:       "github",
		ProviderUserID: fmt.Sprintf("%d", u.ID),
		Email:          email,
		Name:           firstNonEmpty(u.Name, u.Login, email),
		AvatarURL:      u.AvatarURL,
	}, nil
}

type githubEmail struct {
	Email    string `json:"email"`
	Primary  bool   `json:"primary"`
	Verified bool   `json:"verified"`
}

func fetchGitHubVerifiedEmail(ctx context.Context, accessToken, preferred string) (string, error) {
	var emails []githubEmail
	if err := getOAuthJSON(ctx, "https://api.github.com/user/emails", accessToken, &emails); err != nil {
		return "", err
	}
	return selectGitHubVerifiedEmail(emails, preferred)
}

func selectGitHubVerifiedEmail(emails []githubEmail, preferred string) (string, error) {
	preferred = normalizeEmail(preferred)
	if preferred != "" {
		for _, email := range emails {
			if email.Verified && normalizeEmail(email.Email) == preferred {
				return preferred, nil
			}
		}
	}
	for _, e := range emails {
		if e.Primary && e.Verified && e.Email != "" {
			return normalizeEmail(e.Email), nil
		}
	}
	for _, e := range emails {
		if e.Verified && e.Email != "" {
			return normalizeEmail(e.Email), nil
		}
	}
	return "", errors.New("github profile has no verified email")
}

func getOAuthJSON(ctx context.Context, endpoint, accessToken string, target any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+accessToken)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "Koinote-Go-OAuth")

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("oauth profile response %d: %s", resp.StatusCode, string(body))
	}
	return json.NewDecoder(resp.Body).Decode(target)
}

// ---------- upsert 用户 ----------

// getOrCreateOAuthUser 依次按 auth_user_id、email 查找，都没有才新建。
// auth_user_id 约定为 "{provider}_{providerUserID}"，复用现有唯一约束，无需新表。
func (a *App) getOrCreateOAuthUser(
	ctx context.Context,
	profile oauthProfile,
	rawInvitationCode string,
	invalidInvitationCode bool,
) (model.User, error) {
	authUserID := profile.Provider + "_" + profile.ProviderUserID

	// 1) 已用该 provider 身份登录过
	if user, err := a.getUserByAuthUserID(ctx, authUserID); err == nil {
		_, uerr := a.db.Exec(ctx, `
			UPDATE users
			SET email = $2,
			    nickname = COALESCE(NULLIF($3, ''), nickname),
			    avatar_url = COALESCE(NULLIF($4, ''), avatar_url),
			    is_verified = true,
			    updated_at = now()
			WHERE id = $1
		`, user.ID, profile.Email, profile.Name, profile.AvatarURL)
		if uerr != nil {
			return model.User{}, uerr
		}
		return a.getUserByAuthUserID(ctx, authUserID)
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return model.User{}, err
	}

	// 2) 同邮箱的既有账号（如密码注册用户）——补齐资料并复用
	if existing, found, err := a.authUserByEmail(ctx, profile.Email); err != nil {
		return model.User{}, err
	} else if found {
		if !existing.IsVerified {
			return model.User{}, errors.New("existing email account is not verified")
		}
		_, uerr := a.db.Exec(ctx, `
			UPDATE users
			SET nickname = COALESCE(NULLIF($2, ''), nickname),
			    avatar_url = COALESCE(NULLIF($3, ''), avatar_url),
			    is_verified = true,
			    updated_at = now()
			WHERE id = $1
		`, existing.ID, profile.Name, profile.AvatarURL)
		if uerr != nil {
			return model.User{}, uerr
		}
		return a.getUserByAuthUserID(ctx, existing.AuthUserID)
	}

	// 3) 全新用户。创建账号与双方邀请奖励同一事务提交，任一步失败都不会留下半套权益。
	if invalidInvitationCode {
		return model.User{}, errInvalidInvitationCode
	}
	invitationCode, err := newInvitationCode()
	if err != nil {
		return model.User{}, err
	}
	tx, err := a.db.Begin(ctx)
	if err != nil {
		return model.User{}, err
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	var newUserID int
	if err := tx.QueryRow(ctx, `
		INSERT INTO users (
			auth_user_id, email, nickname, avatar_url, is_verified,
			invitation_code, created_at, updated_at
		)
		VALUES ($1, $2, $3, $4, true, $5, now(), now())
		RETURNING id
	`, authUserID, profile.Email, nullableString(profile.Name), nullableString(profile.AvatarURL), invitationCode).Scan(&newUserID); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			// 同一 OAuth 身份（或同邮箱的两个 provider）并发首次登录时，另一个事务
			// 可能已经创建成功。结束失败事务后回查，把唯一约束当作幂等边界。
			_ = tx.Rollback(ctx)
			return a.oauthUserAfterUniqueConflict(ctx, authUserID, profile, err)
		}
		return model.User{}, err
	}
	if err := applyInvitationReward(ctx, tx, newUserID, rawInvitationCode); err != nil {
		return model.User{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return model.User{}, err
	}
	return a.getUserByAuthUserID(ctx, authUserID)
}

func (a *App) oauthUserAfterUniqueConflict(
	ctx context.Context,
	authUserID string,
	profile oauthProfile,
	conflictErr error,
) (model.User, error) {
	if user, err := a.getUserByAuthUserID(ctx, authUserID); err == nil {
		return user, nil
	} else if !errors.Is(err, pgx.ErrNoRows) {
		return model.User{}, err
	}
	existing, found, err := a.authUserByEmail(ctx, profile.Email)
	if err != nil {
		return model.User{}, err
	}
	if found && existing.IsVerified {
		return a.getUserByAuthUserID(ctx, existing.AuthUserID)
	}
	return model.User{}, conflictErr
}

// ---------- 小工具 ----------

func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if strings.TrimSpace(v) != "" {
			return v
		}
	}
	return ""
}

func nullableString(s string) any {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	return s
}

// sanitizeRedirectPath 只允许站内单斜杠开头的相对路径，防开放重定向。
func sanitizeRedirectPath(p string) string {
	p = strings.TrimSpace(p)
	if p == "" || !strings.HasPrefix(p, "/") || strings.HasPrefix(p, "//") || strings.ContainsRune(p, '\\') {
		return "/dashboard"
	}
	return p
}
