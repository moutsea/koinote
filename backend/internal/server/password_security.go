package server

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"

	"koinote/backend/internal/httpx"
)

const (
	passwordResetEmailHourMax = 5
	passwordResetIPHourMax    = 20
)

func (a *App) passwordResetCodeHash(email, code string) string {
	mac := hmac.New(sha256.New, a.verificationSecret())
	_, _ = mac.Write([]byte("password-reset-code:" + normalizeEmail(email) + ":" + code))
	return hex.EncodeToString(mac.Sum(nil))
}

func (a *App) passwordResetEmailHash(email string) string {
	mac := hmac.New(sha256.New, a.verificationSecret())
	_, _ = mac.Write([]byte("password-reset-email:" + normalizeEmail(email)))
	return hex.EncodeToString(mac.Sum(nil))
}

func passwordResetCodeResponse(w http.ResponseWriter, devCode string) {
	payload := map[string]any{
		"ok":                true,
		"expiresInSeconds":  int(verificationCodeTTL.Seconds()),
		"retryAfterSeconds": int(verificationResendDelay.Seconds()),
	}
	if devCode != "" {
		payload["devCode"] = devCode
	}
	httpx.JSON(w, http.StatusOK, payload)
}

// authPasswordResetCode 对存在、不存在和仅 OAuth 的邮箱返回相同响应，避免把账号目录
// 暴露给匿名请求。只有已验证且设置过密码的账号才会真正保存验证码并发信。
func (a *App) authPasswordResetCode(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email  string `json:"email"`
		Locale string `json:"locale"`
	}
	if !decodeAuthBody(w, r, &body) {
		return
	}
	email := normalizeEmail(body.Email)
	if !validRegistrationEmail(email) {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_email", "Invalid email format")
		return
	}

	code, err := generateVerificationCode()
	if err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	codeHash := a.passwordResetCodeHash(email, code)
	emailHash := a.passwordResetEmailHash(email)
	ipHash := a.verificationIPHash(requestIP(r))

	tx, err := a.db.Begin(r.Context())
	if err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	if _, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "password-reset-email:"+emailHash); err == nil {
		_, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "password-reset-ip:"+ipHash)
	}
	if err == nil {
		_, err = tx.Exec(r.Context(), `DELETE FROM password_reset_sends WHERE created_at < now() - interval '24 hours'`)
	}
	if err == nil {
		_, err = tx.Exec(r.Context(), `DELETE FROM password_reset_codes WHERE expires_at < now() - interval '24 hours'`)
	}
	if err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	var recent bool
	if err = tx.QueryRow(r.Context(), `
		SELECT EXISTS (
			SELECT 1 FROM password_reset_sends
			WHERE email_hash = $1 AND created_at > now() - interval '60 seconds'
		)
	`, emailHash).Scan(&recent); err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if recent {
		httpx.ErrorCode(w, http.StatusTooManyRequests, "verification_rate_limited", "Please wait before requesting another code")
		return
	}

	var emailCount, ipCount int64
	if err = tx.QueryRow(r.Context(), `
		SELECT
			count(*) FILTER (WHERE email_hash = $1),
			count(*) FILTER (WHERE ip_hash = $2)
		FROM password_reset_sends
		WHERE created_at > now() - interval '1 hour'
	`, emailHash, ipHash).Scan(&emailCount, &ipCount); err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if emailCount >= passwordResetEmailHourMax || ipCount >= passwordResetIPHourMax {
		httpx.ErrorCode(w, http.StatusTooManyRequests, "verification_rate_limited", "Too many verification requests")
		return
	}

	var eligible bool
	if err = tx.QueryRow(r.Context(), `
		SELECT EXISTS (
			SELECT 1 FROM users
			WHERE lower(email) = lower($1)
			  AND is_verified = true
			  AND password_hash IS NOT NULL
		)
	`, email).Scan(&eligible); err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	if _, err = tx.Exec(r.Context(), `
		INSERT INTO password_reset_sends (email_hash, ip_hash, created_at)
		VALUES ($1, $2, now())
	`, emailHash, ipHash); err == nil && eligible {
		_, err = tx.Exec(r.Context(), `
			INSERT INTO password_reset_codes (email, code_hash, attempts, expires_at, last_sent_at)
			VALUES ($1, $2, 0, now() + interval '10 minutes', now())
			ON CONFLICT (email) DO UPDATE SET
				code_hash = excluded.code_hash,
				attempts = 0,
				expires_at = excluded.expires_at,
				last_sent_at = excluded.last_sent_at
		`, email, codeHash)
	}
	if err != nil || tx.Commit(r.Context()) != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	if !eligible {
		passwordResetCodeResponse(w, "")
		return
	}
	if a.cfg.EnableMockEmail {
		passwordResetCodeResponse(w, code)
		return
	}

	deliveryCtx, cancelDelivery := context.WithTimeout(context.Background(), verificationDeliveryLimit)
	defer cancelDelivery()
	if a.emailSender == nil || a.emailSender.SendPasswordResetEmail(deliveryCtx, email, code, normalizeLocale(body.Locale)) != nil {
		cleanupCtx, cancelCleanup := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancelCleanup()
		_, _ = a.db.Exec(cleanupCtx, `DELETE FROM password_reset_codes WHERE email = $1 AND code_hash = $2`, email, codeHash)
		log.Printf("password reset email delivery failed for hash %s", emailHash[:12])
	}
	// 发信失败也保持相同的匿名响应；否则 503 与未知邮箱的 200 会直接泄露账号是否存在。
	passwordResetCodeResponse(w, "")
}

func (a *App) verifyPasswordResetCode(ctx context.Context, tx pgx.Tx, email, code string) (verificationStatus, error) {
	var codeHash string
	var attempts int
	var expiresAt time.Time
	err := tx.QueryRow(ctx, `
		SELECT code_hash, attempts, expires_at
		FROM password_reset_codes
		WHERE email = $1
		FOR UPDATE
	`, normalizeEmail(email)).Scan(&codeHash, &attempts, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return verificationInvalid, nil
	}
	if err != nil {
		return verificationInvalid, err
	}
	if !expiresAt.After(time.Now()) {
		_, err = tx.Exec(ctx, `DELETE FROM password_reset_codes WHERE email = $1`, normalizeEmail(email))
		return verificationExpired, err
	}
	if attempts >= verificationAttemptMax {
		_, err = tx.Exec(ctx, `DELETE FROM password_reset_codes WHERE email = $1`, normalizeEmail(email))
		return verificationAttemptsExceeded, err
	}
	if !hmac.Equal([]byte(codeHash), []byte(a.passwordResetCodeHash(email, strings.TrimSpace(code)))) {
		nextAttempts := attempts + 1
		if nextAttempts >= verificationAttemptMax {
			_, err = tx.Exec(ctx, `DELETE FROM password_reset_codes WHERE email = $1`, normalizeEmail(email))
			return verificationAttemptsExceeded, err
		}
		_, err = tx.Exec(ctx, `UPDATE password_reset_codes SET attempts = $2 WHERE email = $1`, normalizeEmail(email), nextAttempts)
		return verificationInvalid, err
	}
	return verificationValid, nil
}

func (a *App) authPasswordReset(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email            string `json:"email"`
		VerificationCode string `json:"verificationCode"`
		NewPassword      string `json:"newPassword"`
	}
	if !decodeAuthBody(w, r, &body) {
		return
	}
	body.Email = normalizeEmail(body.Email)
	if body.Email == "" || body.VerificationCode == "" || body.NewPassword == "" {
		httpx.ErrorCode(w, http.StatusBadRequest, "missing_fields", "Email, verification code and new password are required")
		return
	}
	if !validRegistrationEmail(body.Email) {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_email", "Invalid email format")
		return
	}
	if utf8.RuneCountInString(body.NewPassword) < 6 {
		httpx.ErrorCode(w, http.StatusBadRequest, "password_too_short", "Password must be at least 6 characters")
		return
	}
	limiter, ipKey, accountKey, allowed := a.takeLoginAttempt(w, r, body.Email)
	if !allowed {
		return
	}
	passwordHash, err := bcrypt.GenerateFromPassword([]byte(body.NewPassword), bcryptCost)
	if err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	tx, err := a.db.Begin(r.Context())
	if err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	var userID int
	var eligible bool
	err = tx.QueryRow(r.Context(), `
		SELECT id, is_verified AND password_hash IS NOT NULL
		FROM users WHERE lower(email) = lower($1)
		LIMIT 1 FOR UPDATE
	`, body.Email).Scan(&userID, &eligible)
	if errors.Is(err, pgx.ErrNoRows) {
		eligible = false
	} else if err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	verification, verifyErr := a.verifyPasswordResetCode(r.Context(), tx, body.Email, body.VerificationCode)
	if verifyErr != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if verification != verificationValid || !eligible {
		if verification == verificationValid {
			_, _ = tx.Exec(r.Context(), `DELETE FROM password_reset_codes WHERE email = $1`, body.Email)
			verification = verificationInvalid
		}
		if err = tx.Commit(r.Context()); err != nil {
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		verificationError(w, verification)
		return
	}

	if _, err = tx.Exec(r.Context(), `
		UPDATE users
		SET password_hash = $2,
		    session_version = session_version + 1,
		    updated_at = now()
		WHERE id = $1
	`, userID, string(passwordHash)); err == nil {
		_, err = tx.Exec(r.Context(), `DELETE FROM password_reset_codes WHERE email = $1`, body.Email)
	}
	if err != nil || tx.Commit(r.Context()) != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	a.clearSessionCookie(w)
	limiter.reset(ipKey)
	limiter.reset(accountKey)
	httpx.JSON(w, http.StatusOK, map[string]bool{"success": true})
}

func (a *App) authPasswordChange(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	var body struct {
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
	}
	if !decodeAuthBody(w, r, &body) {
		return
	}
	if body.CurrentPassword == "" || body.NewPassword == "" {
		httpx.ErrorCode(w, http.StatusBadRequest, "missing_fields", "Current and new passwords are required")
		return
	}
	if utf8.RuneCountInString(body.NewPassword) < 6 {
		httpx.ErrorCode(w, http.StatusBadRequest, "password_too_short", "Password must be at least 6 characters")
		return
	}
	newHash, err := bcrypt.GenerateFromPassword([]byte(body.NewPassword), bcryptCost)
	if err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	tx, err := a.db.Begin(r.Context())
	if err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	var currentHash string
	if err = tx.QueryRow(r.Context(), `
		SELECT coalesce(password_hash, '') FROM users WHERE id = $1 FOR UPDATE
	`, user.ID).Scan(&currentHash); err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if currentHash == "" {
		httpx.ErrorCode(w, http.StatusConflict, "password_not_available", "This account does not have a password")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(currentHash), []byte(body.CurrentPassword)) != nil {
		httpx.ErrorCode(w, http.StatusUnauthorized, "current_password_incorrect", "Current password is incorrect")
		return
	}
	var sessionVersion int64
	err = tx.QueryRow(r.Context(), `
		UPDATE users
		SET password_hash = $2,
		    session_version = session_version + 1,
		    updated_at = now()
		WHERE id = $1
		RETURNING session_version
	`, user.ID, string(newHash)).Scan(&sessionVersion)
	if err != nil || tx.Commit(r.Context()) != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	a.setSessionCookie(w, user.AuthUserID, sessionVersion)
	httpx.JSON(w, http.StatusOK, map[string]bool{"success": true})
}

func (a *App) authSessionsInvalidate(w http.ResponseWriter, r *http.Request) {
	user, ok := a.requireUser(w, r)
	if !ok {
		return
	}
	var sessionVersion int64
	err := a.db.QueryRow(r.Context(), `
		UPDATE users
		SET session_version = session_version + 1, updated_at = now()
		WHERE id = $1 AND session_version = $2
		RETURNING session_version
	`, user.ID, user.SessionVersion).Scan(&sessionVersion)
	if errors.Is(err, pgx.ErrNoRows) {
		a.clearSessionCookie(w)
		httpx.ErrorCode(w, http.StatusUnauthorized, "session_expired", "Session expired")
		return
	}
	if err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	a.setSessionCookie(w, user.AuthUserID, sessionVersion)
	httpx.JSON(w, http.StatusOK, map[string]bool{"success": true})
}
