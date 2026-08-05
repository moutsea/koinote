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
	email := strings.ToLower(strings.TrimSpace(u.Email))
	if email == "" {
		// GitHub 的 /user 常不返回 email，补拉 /user/emails
		resolved, err := fetchGitHubPrimaryEmail(ctx, accessToken)
		if err != nil {
			return oauthProfile{}, err
		}
		email = resolved
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

func fetchGitHubPrimaryEmail(ctx context.Context, accessToken string) (string, error) {
	var emails []struct {
		Email    string `json:"email"`
		Primary  bool   `json:"primary"`
		Verified bool   `json:"verified"`
	}
	if err := getOAuthJSON(ctx, "https://api.github.com/user/emails", accessToken, &emails); err != nil {
		return "", err
	}
	for _, e := range emails {
		if e.Primary && e.Verified && e.Email != "" {
			return strings.ToLower(strings.TrimSpace(e.Email)), nil
		}
	}
	for _, e := range emails {
		if e.Verified && e.Email != "" {
			return strings.ToLower(strings.TrimSpace(e.Email)), nil
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
func (a *App) getOrCreateOAuthUser(ctx context.Context, profile oauthProfile) (model.User, error) {
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

	// 3) 全新用户
	if _, err := a.db.Exec(ctx, `
		INSERT INTO users (auth_user_id, email, nickname, avatar_url, is_verified, created_at, updated_at)
		VALUES ($1, $2, $3, $4, true, now(), now())
	`, authUserID, profile.Email, nullableString(profile.Name), nullableString(profile.AvatarURL)); err != nil {
		return model.User{}, err
	}
	return a.getUserByAuthUserID(ctx, authUserID)
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
	if p == "" || !strings.HasPrefix(p, "/") || strings.HasPrefix(p, "//") {
		return "/dashboard"
	}
	return p
}
