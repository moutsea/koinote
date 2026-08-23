package server

import (
	"errors"
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"koinote/backend/internal/httpx"
)

const oauthStateCookieName = "koinote_oauth_state"
const oauthStateTTL = 10 * time.Minute

type oauthProviderConfig struct {
	Name         string
	ClientID     string
	ClientSecret string
	AuthURL      string
	TokenURL     string
	Scope        string
	RedirectURI  string
}

// state 载荷：签名后放进 koinote_oauth_state cookie，callback 时校验。
type oauthStatePayload struct {
	Provider              string `json:"provider"`
	RedirectTo            string `json:"redirectTo"`
	InvitationCode        string `json:"invitationCode,omitempty"`
	InvitationCodeInvalid bool   `json:"invitationCodeInvalid,omitempty"`
	Nonce                 string `json:"nonce"`
	ExpiresAt             int64  `json:"expiresAt"`
}

type oauthTokenResponse struct {
	AccessToken string `json:"access_token"`
	TokenType   string `json:"token_type"`
	Error       string `json:"error"`
	Description string `json:"error_description"`
}

type oauthProfile struct {
	Provider       string
	ProviderUserID string
	Email          string
	Name           string
	AvatarURL      string
}

// oauthProvider 按名字返回 provider 配置，回调地址由 AppURL 动态拼。
func (a *App) oauthProvider(name string) (oauthProviderConfig, bool) {
	base := strings.TrimRight(a.cfg.AppURL, "/")
	switch name {
	case "google":
		return oauthProviderConfig{
			Name:         "google",
			ClientID:     a.cfg.GoogleOAuthID,
			ClientSecret: a.cfg.GoogleOAuthSecret,
			AuthURL:      "https://accounts.google.com/o/oauth2/v2/auth",
			TokenURL:     "https://oauth2.googleapis.com/token",
			Scope:        "openid email profile",
			RedirectURI:  base + "/api/auth/oauth/google/callback",
		}, true
	case "github":
		return oauthProviderConfig{
			Name:         "github",
			ClientID:     a.cfg.GitHubOAuthID,
			ClientSecret: a.cfg.GitHubOAuthSecret,
			AuthURL:      "https://github.com/login/oauth/authorize",
			TokenURL:     "https://github.com/login/oauth/access_token",
			Scope:        "read:user user:email",
			RedirectURI:  base + "/api/auth/oauth/github/callback",
		}, true
	default:
		return oauthProviderConfig{}, false
	}
}

// oauthStart 生成签名 state，写 cookie，重定向到 provider 授权页。
func (a *App) oauthStart(w http.ResponseWriter, r *http.Request) {
	name := strings.ToLower(strings.TrimSpace(r.PathValue("provider")))
	provider, ok := a.oauthProvider(name)
	if !ok {
		httpx.ErrorCode(w, http.StatusNotFound, "oauth_unsupported", "Unsupported OAuth provider")
		return
	}
	if provider.ClientID == "" || provider.ClientSecret == "" {
		httpx.ErrorCode(w, http.StatusNotImplemented, "oauth_not_configured", "OAuth provider is not configured")
		return
	}

	nonce, err := randomHex(16)
	if err != nil {
		log.Printf("oauth nonce: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error")
		return
	}

	invitationCode := normalizeInvitationCode(r.URL.Query().Get("invite"))
	invitationCodeInvalid := invitationCode != "" && !validInvitationCode(invitationCode)
	if invitationCodeInvalid {
		// 无效状态用独立字段表达，不让任何字符串兼任哨兵值；同时避免把任意长度
		// 的查询参数塞进 cookie。既有账号仍会忽略它，只有新账号注册会报错。
		invitationCode = ""
	}
	statePayload := oauthStatePayload{
		Provider:              provider.Name,
		RedirectTo:            sanitizeRedirectPath(r.URL.Query().Get("redirectTo")),
		InvitationCode:        invitationCode,
		InvitationCodeInvalid: invitationCodeInvalid,
		Nonce:                 nonce,
		ExpiresAt:             time.Now().Add(oauthStateTTL).Unix(),
	}
	stateToken, err := a.signOAuthState(statePayload)
	if err != nil {
		log.Printf("oauth state sign: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error")
		return
	}
	a.setOAuthStateCookie(w, stateToken)

	authURL, err := url.Parse(provider.AuthURL)
	if err != nil {
		log.Printf("oauth auth url: %v", err)
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error")
		return
	}
	q := authURL.Query()
	q.Set("client_id", provider.ClientID)
	q.Set("redirect_uri", provider.RedirectURI)
	q.Set("response_type", "code")
	q.Set("scope", provider.Scope)
	q.Set("state", nonce) // 仅传 nonce，其余载荷在签名 cookie 里
	authURL.RawQuery = q.Encode()

	http.Redirect(w, r, authURL.String(), http.StatusFound)
}

// oauthCallback 校验 state → 换 token → 拉 profile → upsert 用户 → 签发会话 → 跳回前端。
func (a *App) oauthCallback(w http.ResponseWriter, r *http.Request) {
	name := strings.ToLower(strings.TrimSpace(r.PathValue("provider")))
	provider, ok := a.oauthProvider(name)
	if !ok {
		http.Redirect(w, r, a.oauthFailureRedirect("oauth_unsupported"), http.StatusFound)
		return
	}
	a.clearOAuthStateCookie(w)

	if e := r.URL.Query().Get("error"); e != "" {
		http.Redirect(w, r, a.oauthFailureRedirect("oauth_denied"), http.StatusFound)
		return
	}

	code := strings.TrimSpace(r.URL.Query().Get("code"))
	state := strings.TrimSpace(r.URL.Query().Get("state"))
	if code == "" || state == "" {
		http.Redirect(w, r, a.oauthFailureRedirect("oauth_missing_params"), http.StatusFound)
		return
	}

	statePayload, ok := a.oauthStateFromCookie(r)
	if !ok || statePayload.Provider != provider.Name ||
		statePayload.Nonce != state || statePayload.ExpiresAt <= time.Now().Unix() {
		http.Redirect(w, r, a.oauthFailureRedirect("oauth_invalid_state"), http.StatusFound)
		return
	}

	token, err := a.exchangeOAuthCode(r.Context(), provider, code)
	if err != nil {
		log.Printf("oauth token exchange: %v", err)
		http.Redirect(w, r, a.oauthFailureRedirect("oauth_exchange_failed"), http.StatusFound)
		return
	}

	profile, err := a.fetchOAuthProfile(r.Context(), provider.Name, token.AccessToken)
	if err != nil {
		log.Printf("oauth profile: %v", err)
		http.Redirect(w, r, a.oauthFailureRedirect("oauth_profile_failed"), http.StatusFound)
		return
	}

	user, err := a.getOrCreateOAuthUser(
		r.Context(),
		profile,
		statePayload.InvitationCode,
		statePayload.InvitationCodeInvalid,
	)
	if err != nil {
		if errors.Is(err, errInvalidInvitationCode) {
			http.Redirect(w, r, a.oauthRegistrationFailureRedirect("invalid_invitation_code"), http.StatusFound)
			return
		}
		log.Printf("oauth user sync: %v", err)
		http.Redirect(w, r, a.oauthFailureRedirect("oauth_sync_failed"), http.StatusFound)
		return
	}
	a.noteUserActivity(user.ID)
	a.noteUserClient(user.ID, userClientWeb)

	a.setSessionCookie(w, user.AuthUserID, user.SessionVersion)
	http.Redirect(w, r, sanitizeRedirectPath(statePayload.RedirectTo), http.StatusFound)
}

func (a *App) oauthRegistrationFailureRedirect(code string) string {
	return "/register?error=" + url.QueryEscape(code)
}

// oauthFailureRedirect 拼一个带 error code 的前端登录页地址，前端读 query 翻译展示。
func (a *App) oauthFailureRedirect(code string) string {
	return "/login?error=" + url.QueryEscape(code)
}
