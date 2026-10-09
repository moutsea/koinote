package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"log"
	"net/http"
	"strings"
	"time"

	"koinote/backend/internal/httpx"
	"koinote/backend/internal/model"
)

// 用 koinote 全名而不是缩写前缀：cookie 名在同一域下是全局的，
// 缩写容易和同域上跑的其他项目撞名，撞了就是互相顶掉登录态。
const sessionCookieName = "koinote_session"
const sessionTTL = 7 * 24 * time.Hour

// sessionPayload 是无状态会话令牌的载荷，签名后放进 cookie，不落库。
type sessionPayload struct {
	AuthUserID     string `json:"authUserId"`
	ExpiresAt      int64  `json:"expiresAt"`
	SessionVersion int64  `json:"sessionVersion,omitempty"`
}

// sessionSecret 会话签名密钥，只认 SESSION_SECRET。
//
// 曾经有两级回退：InternalToken，再兜底一个硬编码常量。两级都删了。
//
// 硬编码兜底在开源仓库里等于把会话签名密钥公开 —— 任何人拿那个字符串就能签出
// 任意用户的会话，不需要密码。原本有一道 main.go 的 Fatal 拦它，但那道检查挂在
// NODE_ENV=production 上，而 .env.example 里写的是 development，照 README
// 走一遍（cp .env.example .env）就把它绕过去了。
//
// 回退到 InternalToken 也删掉：那是 Worker → 后端的横向凭据，与会话签名是两种
// 用途、两种轮换周期。混用意味着轮换内部令牌会把所有人踢下线，而且任何能读到
// 内部令牌的组件都顺带获得了伪造任意会话的能力。
//
// 现在缺失即启动失败（见 main.go），所以这里到不了空串。留一个 panic 而不是
// 返回空：万一将来有人绕过 main.go 直接构造 App，用空密钥签名会让所有令牌
// 都"有效"，那是静默的灾难，不如当场炸掉。
func (a *App) sessionSecret() string {
	if a.cfg.SessionSecret == "" {
		panic("SESSION_SECRET 为空：不能用空密钥签名会话（应由 main.go 在启动时拦下）")
	}
	return a.cfg.SessionSecret
}

func (a *App) sessionSignature(encodedPayload string) string {
	mac := hmac.New(sha256.New, []byte(a.sessionSecret()))
	mac.Write([]byte(encodedPayload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func (a *App) signSession(authUserID string, sessionVersion int64) (string, time.Time) {
	expiresAt := time.Now().Add(sessionTTL)
	payload := sessionPayload{
		AuthUserID: authUserID, ExpiresAt: expiresAt.Unix(), SessionVersion: sessionVersion,
	}
	payloadBytes, _ := json.Marshal(payload)
	encoded := base64.RawURLEncoding.EncodeToString(payloadBytes)
	return encoded + "." + a.sessionSignature(encoded), expiresAt
}

func (a *App) setSessionCookie(w http.ResponseWriter, authUserID string, sessionVersion int64) {
	token, expiresAt := a.signSession(authUserID, sessionVersion)
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

// hasInternalToken 判断请求是否带了正确的内部令牌。
//
// 给「只能由 Worker 调用」的端点用。与 authUserIDFromRequest 里那段判断分开是因为
// 语义不同：那里是"如果带了令牌就信它给的身份"，这里是"没带令牌就一律拒绝"。
//
// 用 hmac.Equal 而不是 ==：字符串比较会在第一个不同的字节处返回，泄露令牌前缀。
func (a *App) hasInternalToken(r *http.Request) bool {
	if a.cfg.InternalToken == "" {
		return false
	}
	got := r.Header.Get("X-Koinote-Internal-Token")
	return hmac.Equal([]byte(got), []byte(a.cfg.InternalToken))
}

// authUserIDFromRequest 解析当前请求的用户身份：
//  1. Worker → 后端：内部令牌 + X-Auth-User-Id 头
//  2. 浏览器：koinote_session cookie
func (a *App) authUserIDFromRequest(r *http.Request) string {
	if a.hasInternalToken(r) {
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
	payload, ok := a.sessionPayloadFromCookie(r)
	if !ok {
		return "", false
	}
	return payload.AuthUserID, true
}

func (a *App) sessionPayloadFromCookie(r *http.Request) (sessionPayload, bool) {
	cookie, err := r.Cookie(sessionCookieName)
	if err != nil || cookie.Value == "" {
		return sessionPayload{}, false
	}
	parts := strings.Split(cookie.Value, ".")
	if len(parts) != 2 {
		return sessionPayload{}, false
	}
	// 常数时间比对签名，防时序旁路
	if !hmac.Equal([]byte(a.sessionSignature(parts[0])), []byte(parts[1])) {
		return sessionPayload{}, false
	}
	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return sessionPayload{}, false
	}
	var payload sessionPayload
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		return sessionPayload{}, false
	}
	if payload.AuthUserID == "" || payload.ExpiresAt <= time.Now().Unix() {
		return sessionPayload{}, false
	}
	return payload, true
}

// sessionUser resolves interactive identity for required and optional login.
// It never treats MCP/Agent tokens as browser or desktop sessions.
type sessionAuthError struct {
	status        int
	code, message string
	clearCookie   bool
}

func (e *sessionAuthError) Error() string { return e.message }

func (a *App) sessionUser(r *http.Request) (model.User, userClient, error) {
	expired := &sessionAuthError{status: http.StatusUnauthorized, code: "session_expired", message: "Session expired"}
	if a.hasInternalToken(r) {
		if authID := strings.TrimSpace(r.Header.Get("X-Auth-User-Id")); authID != "" {
			user, err := a.getUserByAuthUserID(r.Context(), authID)
			if err != nil {
				return model.User{}, "", expired
			}
			return user, "", nil
		}
	}
	if token := bearerToken(r); token != "" {
		user, ok, err := a.desktopUserFromBearer(r.Context(), token)
		if err != nil {
			return model.User{}, "", err
		}
		if !ok {
			return model.User{}, "", expired
		}
		if !desktopRequestAllowed(r) {
			return model.User{}, "", &sessionAuthError{status: http.StatusForbidden, code: "desktop_scope_forbidden", message: "Desktop app is not allowed to access this endpoint"}
		}
		return user, userClientDesktop, nil
	}
	payload, ok := a.sessionPayloadFromCookie(r)
	if !ok {
		return model.User{}, "", &sessionAuthError{status: http.StatusUnauthorized, code: "unauthorized", message: "Not logged in"}
	}
	user, err := a.getUserByAuthUserID(r.Context(), payload.AuthUserID)
	// Cookies issued before session versioning represent the initial version.
	version := payload.SessionVersion
	if version == 0 {
		version = 1
	}
	if err != nil || version != user.SessionVersion {
		expired.clearCookie = true
		return model.User{}, "", expired
	}
	return user, userClientWeb, nil
}

// requireUser writes an authentication error; optional public views can instead
// remain anonymous while sharing exactly the same session validity rules.
func (a *App) requireUser(w http.ResponseWriter, r *http.Request) (model.User, bool) {
	user, client, err := a.sessionUser(r)
	if err != nil {
		if authErr, ok := err.(*sessionAuthError); ok {
			if authErr.clearCookie {
				a.clearSessionCookie(w)
			}
			httpx.ErrorCode(w, authErr.status, authErr.code, authErr.message)
		} else {
			log.Printf("session authentication: %v", err)
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error")
		}
		return model.User{}, false
	}
	a.noteUserActivity(user.ID)
	if client != "" {
		a.noteUserClient(user.ID, client)
	}
	return user, true
}
