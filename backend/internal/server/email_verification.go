package server

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"net/mail"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"golang.org/x/crypto/bcrypt"

	"koinote/backend/internal/config"
	"koinote/backend/internal/httpx"
)

const (
	verificationCodeTTL       = 10 * time.Minute
	verificationResendDelay   = time.Minute
	verificationEmailHourMax  = 5
	verificationIPHourMax     = 20
	verificationAttemptMax    = 5
	verificationRequestMax    = 4 << 10
	verificationDeliveryLimit = 10 * time.Second
)

var errEmailDeliveryUnavailable = errors.New("email delivery is unavailable")

type verificationEmailSender interface {
	SendVerificationEmail(ctx context.Context, to, code, locale string) error
	SendPasswordResetEmail(ctx context.Context, to, code, locale string) error
}

type workerVerificationEmailSender struct {
	workerURL     string
	internalToken string
	client        *http.Client
}

func newWorkerVerificationEmailSender(cfg config.Config) verificationEmailSender {
	return &workerVerificationEmailSender{
		workerURL:     strings.TrimRight(cfg.WorkerURL, "/"),
		internalToken: strings.TrimSpace(cfg.InternalToken),
		client:        &http.Client{Timeout: verificationDeliveryLimit},
	}
}

func (s *workerVerificationEmailSender) SendVerificationEmail(ctx context.Context, to, code, locale string) error {
	return s.sendCodeEmail(ctx, to, code, locale, "registration")
}

func (s *workerVerificationEmailSender) SendPasswordResetEmail(ctx context.Context, to, code, locale string) error {
	return s.sendCodeEmail(ctx, to, code, locale, "password_reset")
}

func (s *workerVerificationEmailSender) sendCodeEmail(ctx context.Context, to, code, locale, purpose string) error {
	if s.workerURL == "" || s.internalToken == "" {
		return errEmailDeliveryUnavailable
	}
	body, err := json.Marshal(map[string]string{
		"email": to, "code": code, "locale": locale, "purpose": purpose,
	})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		s.workerURL+"/api/internal/email/verification", strings.NewReader(string(body)))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Koinote-Internal-Token", s.internalToken)

	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("worker email endpoint returned %d", resp.StatusCode)
	}
	return nil
}

func (a *App) verificationSecret() []byte {
	if secret := strings.TrimSpace(a.cfg.EmailVerificationSecret); secret != "" {
		return []byte(secret)
	}
	return []byte(a.cfg.SessionSecret)
}

func (a *App) verificationCodeHash(email, code string) string {
	mac := hmac.New(sha256.New, a.verificationSecret())
	_, _ = mac.Write([]byte("code:" + normalizeEmail(email) + ":" + code))
	return hex.EncodeToString(mac.Sum(nil))
}

func (a *App) verificationIPHash(ip string) string {
	mac := hmac.New(sha256.New, a.verificationSecret())
	_, _ = mac.Write([]byte("ip:" + ip))
	return hex.EncodeToString(mac.Sum(nil))
}

func generateVerificationCode() (string, error) {
	value, err := rand.Int(rand.Reader, big.NewInt(900_000))
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("%06d", value.Int64()+100_000), nil
}

func validRegistrationEmail(value string) bool {
	if len(value) > 255 || strings.ContainsAny(value, "\r\n") {
		return false
	}
	parsed, err := mail.ParseAddress(value)
	at := strings.LastIndexByte(value, '@')
	return err == nil && parsed.Address == value && at > 0 &&
		at < len(value)-1 && strings.Contains(value[at+1:], ".")
}

func normalizeLocale(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "zh", "fr", "ja":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "en"
	}
}

func (a *App) authVerificationCode(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email  string `json:"email"`
		Locale string `json:"locale"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, verificationRequestMax)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			httpx.ErrorCode(w, http.StatusRequestEntityTooLarge, "bad_request", "Request body is too large")
			return
		}
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid request")
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
	codeHash := a.verificationCodeHash(email, code)
	ipHash := a.verificationIPHash(requestIP(r))

	tx, err := a.db.Begin(r.Context())
	if err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	// 并发请求必须串行检查并写入配额，否则两个同时到达的请求都能看到旧计数并放行。
	if _, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "email:"+email); err == nil {
		_, err = tx.Exec(r.Context(), `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, "ip:"+ipHash)
	}
	if err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if _, err = tx.Exec(r.Context(), `DELETE FROM email_verification_sends WHERE created_at < now() - interval '24 hours'`); err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if _, err = tx.Exec(r.Context(), `DELETE FROM email_verification_codes WHERE expires_at < now() - interval '24 hours'`); err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	var isVerified, hasPassword bool
	err = tx.QueryRow(r.Context(), `
		SELECT is_verified, password_hash IS NOT NULL
		FROM users WHERE lower(email) = lower($1) LIMIT 1
	`, email).Scan(&isVerified, &hasPassword)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if err == nil && (isVerified || !hasPassword) {
		httpx.ErrorCode(w, http.StatusConflict, "email_already_registered", "Email is already registered")
		return
	}

	var recent bool
	if err = tx.QueryRow(r.Context(), `
		SELECT EXISTS (
			SELECT 1 FROM email_verification_sends
			WHERE email = $1 AND created_at > now() - interval '60 seconds'
		)
	`, email).Scan(&recent); err != nil {
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
			count(*) FILTER (WHERE email = $1),
			count(*) FILTER (WHERE ip_hash = $2)
		FROM email_verification_sends
		WHERE created_at > now() - interval '1 hour'
	`, email, ipHash).Scan(&emailCount, &ipCount); err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if emailCount >= verificationEmailHourMax || ipCount >= verificationIPHourMax {
		httpx.ErrorCode(w, http.StatusTooManyRequests, "verification_rate_limited", "Too many verification requests")
		return
	}

	if _, err = tx.Exec(r.Context(), `
		INSERT INTO email_verification_codes (email, code_hash, attempts, expires_at, last_sent_at)
		VALUES ($1, $2, 0, now() + interval '10 minutes', now())
		ON CONFLICT (email) DO UPDATE SET
			code_hash = excluded.code_hash,
			attempts = 0,
			expires_at = excluded.expires_at,
			last_sent_at = excluded.last_sent_at
	`, email, codeHash); err == nil {
		_, err = tx.Exec(r.Context(), `
			INSERT INTO email_verification_sends (email, ip_hash, created_at)
			VALUES ($1, $2, now())
		`, email, ipHash)
	}
	if err != nil || tx.Commit(r.Context()) != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	locale := normalizeLocale(body.Locale)
	if a.cfg.EnableMockEmail {
		httpx.JSON(w, http.StatusOK, map[string]any{
			"ok": true, "expiresInSeconds": int(verificationCodeTTL.Seconds()),
			"retryAfterSeconds": int(verificationResendDelay.Seconds()), "devCode": code,
		})
		return
	}
	deliveryCtx, cancelDelivery := context.WithTimeout(context.Background(), verificationDeliveryLimit)
	defer cancelDelivery()
	if a.emailSender == nil || a.emailSender.SendVerificationEmail(deliveryCtx, email, code, locale) != nil {
		cleanupCtx, cancelCleanup := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancelCleanup()
		_, _ = a.db.Exec(cleanupCtx, `DELETE FROM email_verification_codes WHERE email = $1 AND code_hash = $2`, email, codeHash)
		httpx.ErrorCode(w, http.StatusServiceUnavailable, "email_send_failed", "Verification email could not be sent")
		return
	}

	httpx.JSON(w, http.StatusOK, map[string]any{
		"ok": true, "expiresInSeconds": int(verificationCodeTTL.Seconds()),
		"retryAfterSeconds": int(verificationResendDelay.Seconds()),
	})
}

// authVerifyEmail 为历史遗留的未验证密码账号提供恢复入口。密码、验证码、用户状态
// 都在同一事务里校验和更新，验证码只有在账号确实标记成功后才会被消费。
func (a *App) authVerifyEmail(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Email            string `json:"email"`
		Password         string `json:"password"`
		VerificationCode string `json:"verificationCode"`
	}
	if !decodeAuthBody(w, r, &body) {
		return
	}

	body.Email = normalizeEmail(body.Email)
	if body.Email == "" || body.Password == "" {
		httpx.ErrorCode(w, http.StatusBadRequest, "missing_fields", "Email and password are required")
		return
	}
	if !validRegistrationEmail(body.Email) {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_email", "Invalid email format")
		return
	}
	if body.VerificationCode == "" {
		httpx.ErrorCode(w, http.StatusBadRequest, "verification_code_required", "Email verification code is required")
		return
	}

	limiter, ipKey, accountKey, allowed := a.takeLoginAttempt(w, r, body.Email)
	if !allowed {
		return
	}

	tx, err := a.db.Begin(r.Context())
	if err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	var rec loginRecord
	err = tx.QueryRow(r.Context(), `
		SELECT auth_user_id, email, coalesce(password_hash, ''), is_verified
		FROM users
		WHERE lower(email) = lower($1)
		LIMIT 1
		FOR UPDATE
	`, body.Email).Scan(&rec.AuthUserID, &rec.Email, &rec.PasswordHash, &rec.IsVerified)
	if errors.Is(err, pgx.ErrNoRows) {
		_ = bcrypt.CompareHashAndPassword([]byte("$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidin"), []byte(body.Password))
		httpx.ErrorCode(w, http.StatusUnauthorized, "invalid_credentials", "Incorrect account or password")
		return
	}
	if err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if rec.PasswordHash == "" {
		_ = bcrypt.CompareHashAndPassword([]byte("$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidin"), []byte(body.Password))
		httpx.ErrorCode(w, http.StatusUnauthorized, "invalid_credentials", "Incorrect account or password")
		return
	}
	if bcrypt.CompareHashAndPassword([]byte(rec.PasswordHash), []byte(body.Password)) != nil {
		httpx.ErrorCode(w, http.StatusUnauthorized, "invalid_credentials", "Incorrect account or password")
		return
	}
	if rec.IsVerified {
		httpx.ErrorCode(w, http.StatusConflict, "email_already_verified", "Email address is already verified")
		return
	}

	verification, verifyErr := a.verifyEmailCode(r.Context(), tx, body.Email, body.VerificationCode)
	if verifyErr != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if verification != verificationValid {
		if err = tx.Commit(r.Context()); err != nil {
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		verificationError(w, verification)
		return
	}
	if _, err = tx.Exec(r.Context(), `
		UPDATE users SET is_verified = true, updated_at = now()
		WHERE auth_user_id = $1
	`, rec.AuthUserID); err == nil {
		_, err = tx.Exec(r.Context(), `DELETE FROM email_verification_codes WHERE email = $1`, body.Email)
	}
	if err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	user, err := a.getUserByAuthUserID(r.Context(), rec.AuthUserID)
	if err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	limiter.reset(ipKey)
	limiter.reset(accountKey)
	a.noteUserClient(user.ID, userClientWeb)
	a.setSessionCookie(w, rec.AuthUserID, user.SessionVersion)
	httpx.JSON(w, http.StatusOK, map[string]any{"user": user})
}

type verificationStatus string

const (
	verificationValid            verificationStatus = "valid"
	verificationInvalid          verificationStatus = "invalid"
	verificationExpired          verificationStatus = "expired"
	verificationAttemptsExceeded verificationStatus = "attempts_exceeded"
)

func (a *App) verifyEmailCode(ctx context.Context, tx pgx.Tx, email, code string) (verificationStatus, error) {
	var codeHash string
	var attempts int
	var expiresAt time.Time
	err := tx.QueryRow(ctx, `
		SELECT code_hash, attempts, expires_at
		FROM email_verification_codes
		WHERE email = $1
		FOR UPDATE
	`, normalizeEmail(email)).Scan(&codeHash, &attempts, &expiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return verificationInvalid, nil
	}
	if err != nil {
		return "", err
	}
	if !expiresAt.After(time.Now()) {
		_, err = tx.Exec(ctx, `DELETE FROM email_verification_codes WHERE email = $1`, normalizeEmail(email))
		return verificationExpired, err
	}
	if attempts >= verificationAttemptMax {
		_, err = tx.Exec(ctx, `DELETE FROM email_verification_codes WHERE email = $1`, normalizeEmail(email))
		return verificationAttemptsExceeded, err
	}

	expected := a.verificationCodeHash(email, code)
	if len(code) != 6 || !hmac.Equal([]byte(codeHash), []byte(expected)) {
		nextAttempts := attempts + 1
		if nextAttempts >= verificationAttemptMax {
			_, err = tx.Exec(ctx, `DELETE FROM email_verification_codes WHERE email = $1`, normalizeEmail(email))
			return verificationAttemptsExceeded, err
		}
		_, err = tx.Exec(ctx, `UPDATE email_verification_codes SET attempts = $2 WHERE email = $1`, normalizeEmail(email), nextAttempts)
		return verificationInvalid, err
	}
	return verificationValid, nil
}

func verificationError(w http.ResponseWriter, status verificationStatus) {
	switch status {
	case verificationExpired:
		httpx.ErrorCode(w, http.StatusBadRequest, "verification_code_expired", "Verification code has expired")
	case verificationAttemptsExceeded:
		httpx.ErrorCode(w, http.StatusBadRequest, "verification_attempts_exceeded", "Too many incorrect verification attempts")
	default:
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_verification_code", "Verification code is incorrect")
	}
}
