package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"

	"koinote/backend/internal/config"
)

func TestGenerateVerificationCode(t *testing.T) {
	pattern := regexp.MustCompile(`^\d{6}$`)
	seen := make(map[string]bool)
	for range 100 {
		code, err := generateVerificationCode()
		if err != nil {
			t.Fatalf("生成验证码失败: %v", err)
		}
		if !pattern.MatchString(code) {
			t.Fatalf("验证码必须是 6 位数字，实际 %q", code)
		}
		seen[code] = true
	}
	if len(seen) < 90 {
		t.Fatalf("100 次只生成了 %d 个不同验证码，随机性异常", len(seen))
	}
}

func TestVerificationHashIsBoundToEmailAndSecret(t *testing.T) {
	first := newTestApp(config.Config{SessionSecret: "first"})
	second := newTestApp(config.Config{SessionSecret: "second"})
	base := first.verificationCodeHash("User@Example.com", "123456")
	if base == "123456" || strings.Contains(base, "123456") {
		t.Fatal("数据库哈希不能包含明文验证码")
	}
	if base != first.verificationCodeHash("user@example.com", "123456") {
		t.Fatal("邮箱归一化后应得到同一验证码哈希")
	}
	if base == first.verificationCodeHash("other@example.com", "123456") {
		t.Fatal("同一个验证码不能跨邮箱复用")
	}
	if base == second.verificationCodeHash("user@example.com", "123456") {
		t.Fatal("轮换密钥后验证码哈希必须变化")
	}
}

func TestVerificationCodeValidationRejectsBadEmailBeforeDatabase(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "s"})
	for _, email := range []string{"bad", "a@localhost", "name <a@example.com>", "a@example.com\r\nBcc:x@y.com"} {
		rec := postJSON(app.authVerificationCode, `{"email":`+mustJSON(t, email)+`}`)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("邮箱 %q 应在查库前被拒，实际 HTTP %d", email, rec.Code)
		}
		if code := decodeErrorCode(t, rec); code != "invalid_email" {
			t.Fatalf("邮箱 %q 期望 invalid_email，实际 %q", email, code)
		}
	}
}

func mustJSON(t *testing.T, value string) string {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestWorkerVerificationEmailSender(t *testing.T) {
	var received struct {
		Email  string `json:"email"`
		Code   string `json:"code"`
		Locale string `json:"locale"`
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/internal/email/verification" {
			t.Errorf("路径错误: %s", r.URL.Path)
		}
		if token := r.Header.Get("X-Koinote-Internal-Token"); token != "internal" {
			t.Errorf("内部令牌错误: %q", token)
		}
		if err := json.NewDecoder(r.Body).Decode(&received); err != nil {
			t.Errorf("解析请求失败: %v", err)
		}
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	sender := newWorkerVerificationEmailSender(config.Config{
		WorkerURL:     server.URL,
		InternalToken: "internal",
	})
	if err := sender.SendVerificationEmail(context.Background(), "user@example.com", "123456", "zh"); err != nil {
		t.Fatalf("发送失败: %v", err)
	}
	if received.Email != "user@example.com" || received.Code != "123456" || received.Locale != "zh" {
		t.Fatalf("Worker 收到的载荷错误: %+v", received)
	}
}

type failingVerificationEmailSender struct{}

func (failingVerificationEmailSender) SendVerificationEmail(context.Context, string, string, string) error {
	return errors.New("delivery failed")
}

func TestEmailVerificationRegistrationFlow(t *testing.T) {
	pool := newGCTestPool(t)
	ctx := context.Background()
	suffix := time.Now().UnixNano()
	email := "verify-" + itoa64(suffix) + "@example.test"
	username := "verify-" + itoa64(suffix)
	inviterEmail := "inviter-" + itoa64(suffix) + "@example.test"
	inviterAuthUserID := "inviter-" + itoa64(suffix)
	inviterCode, err := newInvitationCode()
	if err != nil {
		t.Fatal(err)
	}
	var inviterUserID int
	if err := pool.QueryRow(ctx, `
		INSERT INTO users (auth_user_id, email, is_verified, invitation_code)
		VALUES ($1, $2, true, $3)
		RETURNING id
	`, inviterAuthUserID, inviterEmail, inviterCode).Scan(&inviterUserID); err != nil {
		t.Fatalf("创建邀请人: %v", err)
	}

	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM invitations WHERE inviter_user_id = $1`, inviterUserID)
		_, _ = pool.Exec(ctx, `DELETE FROM users WHERE email = ANY($1)`, []string{email, inviterEmail})
		_, _ = pool.Exec(ctx, `DELETE FROM email_verification_codes WHERE email = $1`, email)
		_, _ = pool.Exec(ctx, `DELETE FROM email_verification_sends WHERE email = $1`, email)
	})

	app := New(config.Config{
		SessionSecret:   "verification-test-secret",
		EnableMockEmail: true,
	}, pool)
	issue := postJSON(app.authVerificationCode, `{"email":"`+email+`","locale":"zh"}`)
	if issue.Code != http.StatusOK {
		t.Fatalf("发送验证码期望 200，实际 %d（%s）", issue.Code, issue.Body.String())
	}
	var issueBody struct {
		DevCode string `json:"devCode"`
	}
	if err := json.Unmarshal(issue.Body.Bytes(), &issueBody); err != nil || !regexp.MustCompile(`^\d{6}$`).MatchString(issueBody.DevCode) {
		t.Fatalf("开发验证码响应错误: %s", issue.Body.String())
	}
	resend := postJSON(app.authVerificationCode, `{"email":"`+email+`","locale":"zh"}`)
	if resend.Code != http.StatusTooManyRequests || decodeErrorCode(t, resend) != "verification_rate_limited" {
		t.Fatalf("60 秒内重发应被限流，实际 %d（%s）", resend.Code, resend.Body.String())
	}

	var storedHash string
	if err := pool.QueryRow(ctx, `SELECT code_hash FROM email_verification_codes WHERE email = $1`, email).Scan(&storedHash); err != nil {
		t.Fatalf("验证码未落库: %v", err)
	}
	if storedHash == issueBody.DevCode || strings.Contains(storedHash, issueBody.DevCode) {
		t.Fatal("数据库保存了明文验证码")
	}

	wrong := postJSON(app.authRegister, `{"username":"`+username+`","email":"`+email+`","password":"secret123","verificationCode":"000000"}`)
	if wrong.Code != http.StatusBadRequest || decodeErrorCode(t, wrong) != "invalid_verification_code" {
		t.Fatalf("错误验证码应被拒，实际 HTTP %d（%s）", wrong.Code, wrong.Body.String())
	}
	var attempts int
	if err := pool.QueryRow(ctx, `SELECT attempts FROM email_verification_codes WHERE email = $1`, email).Scan(&attempts); err != nil || attempts != 1 {
		t.Fatalf("错误次数应持久化为 1，实际 %d（err=%v）", attempts, err)
	}

	invalidInvite := "ZZZZZZZZZZZZZZZZ"
	if invalidInvite == inviterCode {
		invalidInvite = "YYYYYYYYYYYYYYYY"
	}
	rejectedInvite := postJSON(app.authRegister, `{"username":"`+username+`","email":"`+email+`","password":"secret123","verificationCode":"`+issueBody.DevCode+`","invitationCode":"`+invalidInvite+`"}`)
	if rejectedInvite.Code != http.StatusBadRequest || decodeErrorCode(t, rejectedInvite) != "invalid_invitation_code" {
		t.Fatalf("无效邀请码应拒绝整笔注册，实际 %d（%s）", rejectedInvite.Code, rejectedInvite.Body.String())
	}
	var codeStillAvailable int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM email_verification_codes WHERE email = $1`, email).Scan(&codeStillAvailable); err != nil || codeStillAvailable != 1 {
		t.Fatalf("邀请失败不应消费验证码（remaining=%d err=%v）", codeStillAvailable, err)
	}

	registered := postJSON(app.authRegister, `{"username":"`+username+`","email":"`+email+`","password":"secret123","verificationCode":"`+issueBody.DevCode+`","invitationCode":"`+strings.ToLower(inviterCode)+`"}`)
	if registered.Code != http.StatusOK {
		t.Fatalf("正确验证码注册期望 200，实际 %d（%s）", registered.Code, registered.Body.String())
	}
	if len(registered.Result().Cookies()) == 0 {
		t.Fatal("验证成功注册后没有签发会话")
	}
	var verified bool
	if err := pool.QueryRow(ctx, `SELECT is_verified FROM users WHERE email = $1`, email).Scan(&verified); err != nil || !verified {
		t.Fatalf("新用户应标记为已验证（verified=%v err=%v）", verified, err)
	}
	var invitedBonus, inviterBonus int64
	if err := pool.QueryRow(ctx, `SELECT bonus_storage_bytes FROM users WHERE email = $1`, email).Scan(&invitedBonus); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT bonus_storage_bytes FROM users WHERE id = $1`, inviterUserID).Scan(&inviterBonus); err != nil {
		t.Fatal(err)
	}
	if invitedBonus != invitationRewardBytes || inviterBonus != invitationRewardBytes {
		t.Fatalf("邮箱邀请奖励错误：邀请人=%d，被邀请人=%d", inviterBonus, invitedBonus)
	}
	var remaining int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM email_verification_codes WHERE email = $1`, email).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("成功注册后验证码应一次性删除（remaining=%d err=%v）", remaining, err)
	}
}

func TestUnverifiedAccountRecoveryFlow(t *testing.T) {
	pool := newGCTestPool(t)
	ctx := context.Background()
	suffix := itoa64(time.Now().UnixNano())
	email := "recover-" + suffix + "@example.test"
	username := "recover-" + suffix
	authUserID, err := randomUUID()
	if err != nil {
		t.Fatal(err)
	}
	passwordHash, err := bcrypt.GenerateFromPassword([]byte("secret123"), bcryptCost)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `
		INSERT INTO users (auth_user_id, email, username, password_hash, is_verified)
		VALUES ($1, $2, $3, $4, false)
	`, authUserID, email, username, string(passwordHash)); err != nil {
		t.Fatalf("创建未验证账号失败: %v", err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM users WHERE email = $1`, email)
		_, _ = pool.Exec(ctx, `DELETE FROM email_verification_codes WHERE email = $1`, email)
		_, _ = pool.Exec(ctx, `DELETE FROM email_verification_sends WHERE email = $1`, email)
	})

	app := New(config.Config{
		SessionSecret:   "verification-test-secret",
		EnableMockEmail: true,
	}, pool)
	loginResult := postJSON(app.authLogin, `{"username":"`+username+`","password":"secret123"}`)
	if loginResult.Code != http.StatusForbidden || decodeErrorCode(t, loginResult) != "email_not_verified" {
		t.Fatalf("未验证账号登录应进入恢复流程，实际 %d（%s）", loginResult.Code, loginResult.Body.String())
	}
	var loginBody struct {
		Email string `json:"email"`
	}
	if err = json.Unmarshal(loginResult.Body.Bytes(), &loginBody); err != nil || loginBody.Email != email {
		t.Fatalf("登录响应没有返回已校验密码对应的邮箱: %s", loginResult.Body.String())
	}

	issue := postJSON(app.authVerificationCode, `{"email":"`+email+`","locale":"zh"}`)
	if issue.Code != http.StatusOK {
		t.Fatalf("未验证老账号应允许发码，实际 %d（%s）", issue.Code, issue.Body.String())
	}
	var issueBody struct {
		DevCode string `json:"devCode"`
	}
	if err = json.Unmarshal(issue.Body.Bytes(), &issueBody); err != nil || issueBody.DevCode == "" {
		t.Fatalf("验证码响应错误: %s", issue.Body.String())
	}

	wrongPassword := postJSON(app.authVerifyEmail, `{"email":"`+email+`","password":"wrong-password","verificationCode":"`+issueBody.DevCode+`"}`)
	if wrongPassword.Code != http.StatusUnauthorized || decodeErrorCode(t, wrongPassword) != "invalid_credentials" {
		t.Fatalf("错误密码应被拒，实际 %d（%s）", wrongPassword.Code, wrongPassword.Body.String())
	}
	var attempts int
	if err = pool.QueryRow(ctx, `SELECT attempts FROM email_verification_codes WHERE email = $1`, email).Scan(&attempts); err != nil || attempts != 0 {
		t.Fatalf("密码错误不应消耗验证码次数（attempts=%d err=%v）", attempts, err)
	}

	wrongCode := postJSON(app.authVerifyEmail, `{"email":"`+email+`","password":"secret123","verificationCode":"000000"}`)
	if wrongCode.Code != http.StatusBadRequest || decodeErrorCode(t, wrongCode) != "invalid_verification_code" {
		t.Fatalf("错误验证码应被拒，实际 %d（%s）", wrongCode.Code, wrongCode.Body.String())
	}
	if err = pool.QueryRow(ctx, `SELECT attempts FROM email_verification_codes WHERE email = $1`, email).Scan(&attempts); err != nil || attempts != 1 {
		t.Fatalf("验证码错误次数应持久化（attempts=%d err=%v）", attempts, err)
	}

	verified := postJSON(app.authVerifyEmail, `{"email":"`+email+`","password":"secret123","verificationCode":"`+issueBody.DevCode+`"}`)
	if verified.Code != http.StatusOK {
		t.Fatalf("验证并登录期望 200，实际 %d（%s）", verified.Code, verified.Body.String())
	}
	if len(verified.Result().Cookies()) == 0 {
		t.Fatal("验证成功后没有签发会话")
	}
	var isVerified bool
	if err = pool.QueryRow(ctx, `SELECT is_verified FROM users WHERE email = $1`, email).Scan(&isVerified); err != nil || !isVerified {
		t.Fatalf("账号没有标记为已验证（verified=%v err=%v）", isVerified, err)
	}
	var remaining int
	if err = pool.QueryRow(ctx, `SELECT count(*) FROM email_verification_codes WHERE email = $1`, email).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("验证成功后验证码应删除（remaining=%d err=%v）", remaining, err)
	}
	verifyAgain := postJSON(app.authVerifyEmail, `{"email":"`+email+`","password":"secret123","verificationCode":"000000"}`)
	if verifyAgain.Code != http.StatusConflict || decodeErrorCode(t, verifyAgain) != "email_already_verified" {
		t.Fatalf("已验证账号不应把恢复端点当第二登录入口，实际 %d（%s）", verifyAgain.Code, verifyAgain.Body.String())
	}
	for _, cookie := range verifyAgain.Result().Cookies() {
		if cookie.Name == sessionCookieName && cookie.Value != "" {
			t.Fatal("已验证账号调用恢复端点不应签发会话")
		}
	}

	alreadyVerified := postJSON(app.authVerificationCode, `{"email":"`+email+`"}`)
	if alreadyVerified.Code != http.StatusConflict || decodeErrorCode(t, alreadyVerified) != "email_already_registered" {
		t.Fatalf("已验证账号不应继续发注册验证码，实际 %d（%s）", alreadyVerified.Code, alreadyVerified.Body.String())
	}
}

func TestFailedEmailDeliveryRemovesIssuedCode(t *testing.T) {
	pool := newGCTestPool(t)
	ctx := context.Background()
	email := "delivery-fail-" + itoa64(time.Now().UnixNano()) + "@example.test"
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `DELETE FROM email_verification_codes WHERE email = $1`, email)
		_, _ = pool.Exec(ctx, `DELETE FROM email_verification_sends WHERE email = $1`, email)
	})

	app := New(config.Config{SessionSecret: "verification-test-secret"}, pool)
	app.emailSender = failingVerificationEmailSender{}
	rec := postJSON(app.authVerificationCode, `{"email":"`+email+`"}`)
	if rec.Code != http.StatusServiceUnavailable || decodeErrorCode(t, rec) != "email_send_failed" {
		t.Fatalf("发信失败期望 503/email_send_failed，实际 %d（%s）", rec.Code, rec.Body.String())
	}
	var remaining int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM email_verification_codes WHERE email = $1`, email).Scan(&remaining); err != nil || remaining != 0 {
		t.Fatalf("发信失败后验证码必须删除（remaining=%d err=%v）", remaining, err)
	}
}

func itoa64(value int64) string {
	return strconv.FormatInt(value, 10)
}
