package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"koinote/backend/internal/httpx"
	"koinote/backend/internal/model"
)

const sessionCookieName = "ka_session"
const sessionTTL = 7 * 24 * time.Hour

// sessionPayload 是无状态会话令牌的载荷，签名后放进 cookie，不落库。
type sessionPayload struct {
	AuthUserID string `json:"authUserId"`
	ExpiresAt  int64  `json:"expiresAt"`
}

// sessionSecret 会话签名密钥：优先 SESSION_SECRET，回退 InternalToken，最后开发默认值。
func (a *App) sessionSecret() string {
	if a.cfg.SessionSecret != "" {
		return a.cfg.SessionSecret
	}
	if a.cfg.InternalToken != "" {
		return a.cfg.InternalToken
	}
	return "koinote-dev-session-secret"
}

func (a *App) sessionSignature(encodedPayload string) string {
	mac := hmac.New(sha256.New, []byte(a.sessionSecret()))
	mac.Write([]byte(encodedPayload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (a *App) signSession(authUserID string) (string, time.Time) {
	expiresAt := time.Now().Add(sessionTTL)
	payload := sessionPayload{AuthUserID: authUserID, ExpiresAt: expiresAt.Unix()}
	payloadBytes, _ := json.Marshal(payload)
	encoded := base64.RawURLEncoding.EncodeToString(payloadBytes)
	return encoded + "." + a.sessionSignature(encoded), expiresAt
}

func (a *App) setSessionCookie(w http.ResponseWriter, authUserID string) {
	token, expiresAt := a.signSession(authUserID)
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   a.cfg.IsProduction(),
		Expires:  expiresAt,
		MaxAge:   int(sessionTTL.Seconds()),
	})
}

func (a *App) clearSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   a.cfg.IsProduction(),
		Expires:  time.Unix(0, 0),
		MaxAge:   -1,
	})
}

// authUserIDFromRequest 解析当前请求的用户身份：
//  1. Worker → 后端：内部令牌 + X-Auth-User-Id 头
//  2. 浏览器：ka_session cookie
func (a *App) authUserIDFromRequest(r *http.Request) string {
	if a.cfg.InternalToken != "" &&
		r.Header.Get("X-Koinote-Internal-Token") == a.cfg.InternalToken {
		if id := strings.TrimSpace(r.Header.Get("X-Auth-User-Id")); id != "" {
			return id
		}
	}
	if id, ok := a.authUserIDFromSessionCookie(r); ok {
		return id
	}
	return ""
}

func (a *App) authUserIDFromSessionCookie(r *http.Request) (string, bool) {
	cookie, err := r.Cookie(sessionCookieName)
	if err != nil || cookie.Value == "" {
		return "", false
	}
	parts := strings.Split(cookie.Value, ".")
	if len(parts) != 2 {
		return "", false
	}
	// 常数时间比对签名，防时序旁路
	if !hmac.Equal([]byte(a.sessionSignature(parts[0])), []byte(parts[1])) {
		return "", false
	}
	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return "", false
	}
	var payload sessionPayload
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		return "", false
	}
	if payload.AuthUserID == "" || payload.ExpiresAt <= time.Now().Unix() {
		return "", false
	}
	return payload.AuthUserID, true
}

// requireUser 从会话解析出当前用户，未登录时写 401 并返回 false。
func (a *App) requireUser(w http.ResponseWriter, r *http.Request) (model.User, bool) {
	authUserID := a.authUserIDFromRequest(r)
	if authUserID == "" {
		httpx.ErrorCode(w, http.StatusUnauthorized, "unauthorized", "Not logged in")
		return model.User{}, false
	}
	user, err := a.getUserByAuthUserID(r.Context(), authUserID)
	if err != nil {
		httpx.ErrorCode(w, http.StatusUnauthorized, "session_expired", "Session expired")
		return model.User{}, false
	}
	return user, true
}
