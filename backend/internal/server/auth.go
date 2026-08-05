package server

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"strings"
	"unicode/utf8"

	"golang.org/x/crypto/bcrypt"

	"koinote/backend/internal/httpx"
)

const bcryptCost = 10

// authRegister 注册新用户。MVP 简化：注册即 is_verified=true，直接可登录（邮箱验证留待后续）。
func (a *App) authRegister(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string `json:"username"`
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid request")
		return
	}

	body.Username = strings.TrimSpace(body.Username)
	body.Email = normalizeEmail(body.Email)

	if body.Username == "" || body.Email == "" || body.Password == "" {
		httpx.ErrorCode(w, http.StatusBadRequest, "missing_fields", "Username, email and password are all required")
		return
	}
	if !strings.Contains(body.Email, "@") {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_email", "Invalid email format")
		return
	}
	if utf8.RuneCountInString(body.Password) < 6 {
		httpx.ErrorCode(w, http.StatusBadRequest, "password_too_short", "Password must be at least 6 characters")
		return
	}

	exists, err := a.emailOrUsernameExists(r.Context(), body.Email, body.Username)
	if err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if exists {
		httpx.ErrorCode(w, http.StatusConflict, "conflict", "Email or username is already taken")
		return
	}

	passwordHash, err := bcrypt.GenerateFromPassword([]byte(body.Password), bcryptCost)
	if err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	authUserID, err := randomUUID()
	if err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	var newAuthUserID string
	err = a.db.QueryRow(r.Context(), `
		INSERT INTO users (auth_user_id, email, username, password_hash, is_verified, created_at, updated_at)
		VALUES ($1, $2, $3, $4, true, now(), now())
		RETURNING auth_user_id
	`, authUserID, body.Email, body.Username, string(passwordHash)).Scan(&newAuthUserID)
	if err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	user, err := a.getUserByAuthUserID(r.Context(), newAuthUserID)
	if err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	// 注册成功直接签发会话，免去再登录一次
	a.setSessionCookie(w, newAuthUserID)
	httpx.JSON(w, http.StatusOK, map[string]any{"user": user})
}

// authLogin 校验凭证并签发会话 cookie。
func (a *App) authLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username string `json:"username"`
		Email    string `json:"email"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid request")
		return
	}

	identifier := strings.TrimSpace(body.Username)
	if identifier == "" {
		identifier = strings.TrimSpace(body.Email)
	}
	if identifier == "" || body.Password == "" {
		httpx.ErrorCode(w, http.StatusBadRequest, "missing_fields", "Account and password are required")
		return
	}

	rec, found, err := a.passwordLoginRecord(r.Context(), identifier)
	if err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	// 无论是否找到都跑一次 bcrypt 比对，缓解用户枚举时序差异
	if !found || rec.PasswordHash == "" {
		_ = bcrypt.CompareHashAndPassword([]byte("$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidin"), []byte(body.Password))
		httpx.ErrorCode(w, http.StatusUnauthorized, "invalid_credentials", "Incorrect account or password")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(rec.PasswordHash), []byte(body.Password)) != nil {
		httpx.ErrorCode(w, http.StatusUnauthorized, "invalid_credentials", "Incorrect account or password")
		return
	}

	user, err := a.getUserByAuthUserID(r.Context(), rec.AuthUserID)
	if err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	a.setSessionCookie(w, rec.AuthUserID)
	httpx.JSON(w, http.StatusOK, map[string]any{"user": user})
}

func (a *App) authLogout(w http.ResponseWriter, _ *http.Request) {
	a.clearSessionCookie(w)
	httpx.JSON(w, http.StatusOK, map[string]bool{"success": true})
}

func (a *App) authSession(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	httpx.JSON(w, http.StatusOK, map[string]any{"user": user})
}

// randomUUID 生成 RFC 4122 v4 风格的 UUID 字符串。
func randomUUID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10
	return hex.EncodeToString(b[0:4]) + "-" +
		hex.EncodeToString(b[4:6]) + "-" +
		hex.EncodeToString(b[6:8]) + "-" +
		hex.EncodeToString(b[8:10]) + "-" +
		hex.EncodeToString(b[10:16]), nil
}
