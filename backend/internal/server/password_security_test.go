package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"

	"koinote/backend/internal/config"
)

func TestPasswordResetHashUsesIndependentPurpose(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "reset-secret"})
	registration := app.verificationCodeHash("user@example.com", "123456")
	reset := app.passwordResetCodeHash("user@example.com", "123456")
	if registration == reset {
		t.Fatal("注册验证码与密码找回码不能共享同一个 HMAC purpose")
	}
	if reset == app.passwordResetCodeHash("other@example.com", "123456") {
		t.Fatal("密码找回码必须绑定邮箱")
	}
}

func TestPasswordResetRejectsInvalidInputBeforeDatabase(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "s"})
	for _, body := range []string{
		`{"email":"bad"}`,
		`{"email":"name <a@example.com>"}`,
	} {
		rec := postJSON(app.authPasswordResetCode, body)
		if rec.Code != http.StatusBadRequest || decodeErrorCode(t, rec) != "invalid_email" {
			t.Fatalf("非法邮箱应在查库前拒绝，实际 %d %s", rec.Code, rec.Body.String())
		}
	}
	short := postJSON(app.authPasswordReset, `{"email":"a@example.com","verificationCode":"123456","newPassword":"12345"}`)
	if short.Code != http.StatusBadRequest || decodeErrorCode(t, short) != "password_too_short" {
		t.Fatalf("短密码应在查库前拒绝，实际 %d %s", short.Code, short.Body.String())
	}
}

func TestPasswordSecurityEndToEnd(t *testing.T) {
	pool := newGCTestPool(t)
	ctx := context.Background()
	suffix := itoa64(time.Now().UnixNano())
	email := "password-security-" + suffix + "@example.test"
	oauthEmail := "password-oauth-" + suffix + "@example.test"
	missingEmail := "password-missing-" + suffix + "@example.test"
	authUserID := "password-security-" + suffix
	oldPassword := "old-secret-123"
	newPassword := "new-secret-456"
	finalPassword := "final-secret-789"
	passwordHash, err := bcrypt.GenerateFromPassword([]byte(oldPassword), bcryptCost)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `
		INSERT INTO users (auth_user_id, email, password_hash, is_verified)
		VALUES ($1, $2, $3, true), ($4, $5, NULL, true)
	`, authUserID, email, string(passwordHash), "password-oauth-"+suffix, oauthEmail); err != nil {
		t.Fatalf("创建密码安全测试用户: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM password_reset_codes WHERE email = ANY($1)`, []string{email, oauthEmail, missingEmail})
		_, _ = pool.Exec(ctx, `DELETE FROM password_reset_sends WHERE email_hash = ANY($1)`, []string{
			newTestApp(config.Config{SessionSecret: "password-security-secret"}).passwordResetEmailHash(email),
			newTestApp(config.Config{SessionSecret: "password-security-secret"}).passwordResetEmailHash(oauthEmail),
			newTestApp(config.Config{SessionSecret: "password-security-secret"}).passwordResetEmailHash(missingEmail),
		})
		_, _ = pool.Exec(ctx, `DELETE FROM users WHERE email = ANY($1)`, []string{email, oauthEmail})
	})

	app := New(config.Config{
		SessionSecret:   "password-security-secret",
		EnableMockEmail: true,
	}, pool)

	// 未知邮箱与 OAuth-only 邮箱都返回相同成功形状，且不生成可消费的验证码。
	for _, hiddenEmail := range []string{missingEmail, oauthEmail} {
		rec := postJSON(app.authPasswordResetCode, `{"email":"`+hiddenEmail+`","locale":"zh"}`)
		if rec.Code != http.StatusOK {
			t.Fatalf("匿名找回应统一返回 200，%s 实际 %d（%s）", hiddenEmail, rec.Code, rec.Body.String())
		}
		var body struct {
			DevCode string `json:"devCode"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil || body.DevCode != "" {
			t.Fatalf("不存在或 OAuth-only 账号不应下发开发验证码: %s", rec.Body.String())
		}
	}

	issued := postJSON(app.authPasswordResetCode, `{"email":"`+email+`","locale":"zh"}`)
	if issued.Code != http.StatusOK {
		t.Fatalf("发送找回码失败: %d %s", issued.Code, issued.Body.String())
	}
	var issuedBody struct {
		DevCode string `json:"devCode"`
	}
	if err := json.Unmarshal(issued.Body.Bytes(), &issuedBody); err != nil || issuedBody.DevCode == "" {
		t.Fatalf("本地找回码响应错误: %s", issued.Body.String())
	}

	legacyCookie := sessionCookieFor(t, app, authUserID, 0)
	if rec := requestWithCookie(app.authSession, http.MethodGet, `{}`, legacyCookie); rec.Code != http.StatusOK {
		t.Fatalf("迁移前无版本 Cookie 在初始版本上应兼容，实际 %d %s", rec.Code, rec.Body.String())
	}

	wrong := postJSON(app.authPasswordReset, `{"email":"`+email+`","verificationCode":"000000","newPassword":"`+newPassword+`"}`)
	if wrong.Code != http.StatusBadRequest || decodeErrorCode(t, wrong) != "invalid_verification_code" {
		t.Fatalf("错误找回码应拒绝，实际 %d %s", wrong.Code, wrong.Body.String())
	}
	var attempts int
	if err := pool.QueryRow(ctx, `SELECT attempts FROM password_reset_codes WHERE email = $1`, email).Scan(&attempts); err != nil || attempts != 1 {
		t.Fatalf("错误找回码次数应持久化，attempts=%d err=%v", attempts, err)
	}

	reset := postJSON(app.authPasswordReset, `{"email":"`+email+`","verificationCode":"`+issuedBody.DevCode+`","newPassword":"`+newPassword+`"}`)
	if reset.Code != http.StatusOK {
		t.Fatalf("重置密码失败: %d %s", reset.Code, reset.Body.String())
	}
	if cookie := findSessionCookie(reset); cookie == nil || cookie.MaxAge >= 0 {
		t.Fatal("重置密码后应清除当前浏览器 Cookie，要求重新登录")
	}
	assertPasswordAndVersion(t, pool, email, newPassword, 2)
	if rec := requestWithCookie(app.authSession, http.MethodGet, `{}`, legacyCookie); rec.Code != http.StatusUnauthorized || decodeErrorCode(t, rec) != "session_expired" {
		t.Fatalf("重置后旧会话应立即失效，实际 %d %s", rec.Code, rec.Body.String())
	}

	loginRec := postJSON(app.authLogin, `{"email":"`+email+`","password":"`+newPassword+`"}`)
	if loginRec.Code != http.StatusOK {
		t.Fatalf("新密码登录失败: %d %s", loginRec.Code, loginRec.Body.String())
	}
	versionTwoCookie := findSessionCookie(loginRec)
	if versionTwoCookie == nil {
		t.Fatal("新密码登录未签发会话")
	}

	wrongCurrent := requestWithCookie(app.authPasswordChange, http.MethodPost,
		`{"currentPassword":"wrong","newPassword":"`+finalPassword+`"}`, versionTwoCookie)
	if wrongCurrent.Code != http.StatusUnauthorized || decodeErrorCode(t, wrongCurrent) != "current_password_incorrect" {
		t.Fatalf("错误当前密码应拒绝，实际 %d %s", wrongCurrent.Code, wrongCurrent.Body.String())
	}
	assertPasswordAndVersion(t, pool, email, newPassword, 2)

	changed := requestWithCookie(app.authPasswordChange, http.MethodPost,
		`{"currentPassword":"`+newPassword+`","newPassword":"`+finalPassword+`"}`, versionTwoCookie)
	if changed.Code != http.StatusOK {
		t.Fatalf("修改密码失败: %d %s", changed.Code, changed.Body.String())
	}
	versionThreeCookie := findSessionCookie(changed)
	if versionThreeCookie == nil {
		t.Fatal("修改密码后未给当前设备签发新会话")
	}
	assertPasswordAndVersion(t, pool, email, finalPassword, 3)
	if rec := requestWithCookie(app.authSession, http.MethodGet, `{}`, versionTwoCookie); rec.Code != http.StatusUnauthorized {
		t.Fatalf("改密后旧设备会话应失效，实际 %d", rec.Code)
	}
	if rec := requestWithCookie(app.authSession, http.MethodGet, `{}`, versionThreeCookie); rec.Code != http.StatusOK {
		t.Fatalf("改密当前设备应继续登录，实际 %d %s", rec.Code, rec.Body.String())
	}

	invalidated := requestWithCookie(app.authSessionsInvalidate, http.MethodPost, `{}`, versionThreeCookie)
	if invalidated.Code != http.StatusOK {
		t.Fatalf("主动退出其他设备失败: %d %s", invalidated.Code, invalidated.Body.String())
	}
	versionFourCookie := findSessionCookie(invalidated)
	if versionFourCookie == nil {
		t.Fatal("主动失效后未给当前设备签发新会话")
	}
	if rec := requestWithCookie(app.authSession, http.MethodGet, `{}`, versionThreeCookie); rec.Code != http.StatusUnauthorized {
		t.Fatalf("主动失效后旧 Cookie 仍有效，实际 %d", rec.Code)
	}
	if rec := requestWithCookie(app.authSession, http.MethodGet, `{}`, versionFourCookie); rec.Code != http.StatusOK {
		t.Fatalf("主动失效后当前设备应继续登录，实际 %d %s", rec.Code, rec.Body.String())
	}
}

func TestPasswordResetDeliveryFailureKeepsAnonymousResponseAndRemovesCode(t *testing.T) {
	pool := newGCTestPool(t)
	ctx := context.Background()
	suffix := itoa64(time.Now().UnixNano())
	email := "password-delivery-" + suffix + "@example.test"
	hash, err := bcrypt.GenerateFromPassword([]byte("secret123"), bcryptCost)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `INSERT INTO users (auth_user_id, email, password_hash, is_verified) VALUES ($1, $2, $3, true)`, "password-delivery-"+suffix, email, string(hash)); err != nil {
		t.Fatal(err)
	}
	app := New(config.Config{SessionSecret: "password-delivery-secret"}, pool)
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM password_reset_codes WHERE email = $1`, email)
		_, _ = pool.Exec(ctx, `DELETE FROM password_reset_sends WHERE email_hash = $1`, app.passwordResetEmailHash(email))
		_, _ = pool.Exec(ctx, `DELETE FROM users WHERE email = $1`, email)
	})
	app.emailSender = failingVerificationEmailSender{}
	rec := postJSON(app.authPasswordResetCode, `{"email":"`+email+`"}`)
	if rec.Code != http.StatusOK {
		t.Fatalf("发信失败不能用状态码枚举账号，实际 %d %s", rec.Code, rec.Body.String())
	}
	var remaining int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM password_reset_codes WHERE email = $1`, email).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("发信失败后找回码必须删除，remaining=%d err=%v", remaining, err)
	}
}

func sessionCookieFor(t *testing.T, app *App, authUserID string, version int64) *http.Cookie {
	t.Helper()
	token, expiresAt := app.signSession(authUserID, version)
	return &http.Cookie{Name: sessionCookieName, Value: token, Path: "/", Expires: expiresAt}
}

func requestWithCookie(handler http.HandlerFunc, method, body string, cookie *http.Cookie) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, "/", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if cookie != nil {
		req.AddCookie(cookie)
	}
	rec := httptest.NewRecorder()
	handler(rec, req)
	return rec
}

func findSessionCookie(rec *httptest.ResponseRecorder) *http.Cookie {
	for _, cookie := range rec.Result().Cookies() {
		if cookie.Name == sessionCookieName {
			return cookie
		}
	}
	return nil
}

func assertPasswordAndVersion(t *testing.T, pool *pgxpool.Pool, email, password string, expectedVersion int64) {
	t.Helper()
	var hash string
	var version int64
	if err := pool.QueryRow(context.Background(), `SELECT password_hash, session_version FROM users WHERE email = $1`, email).Scan(&hash, &version); err != nil {
		t.Fatal(err)
	}
	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
		t.Fatal("数据库密码哈希与期望新密码不匹配")
	}
	if version != expectedVersion {
		t.Fatalf("session_version=%d，期望 %d", version, expectedVersion)
	}
}
