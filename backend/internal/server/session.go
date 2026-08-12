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

// 用 koinote 全名而不是缩写前缀：cookie 名在同一域下是全局的，
// 缩写容易和同域上跑的其他项目撞名，撞了就是互相顶掉登录态。
const sessionCookieName = "koinote_session"
const sessionTTL = 7 * 24 * time.Hour

// sessionPayload 是无状态会话令牌的载荷，签名后放进 cookie，不落库。
type sessionPayload struct {
	AuthUserID string `json:"authUserId"`
	ExpiresAt  int64  `json:"expiresAt"`
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
