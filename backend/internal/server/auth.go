package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgconn"
	"golang.org/x/crypto/bcrypt"

	"koinote/backend/internal/httpx"
)

const bcryptCost = 10

// 登录与注册的限流。
//
// 之前完全没有：实测 20 次连续错误登录全部返回 401，一个 429 都没有。配上 6 位
// 的密码下限，爆破成本极低；注册端点无限流则意味着任何人都能刷满用户表。
// 限流器本来就在（rateLimiter），只是只接了分享口令那一处。
//
// 登录按两个维度计，两者的阈值差一个数量级，这是刻意的：
//
//	· IP（10 次/15 分钟）—— 主防线，挡一个来源反复试。这个维度可以收得很紧，
//	  因为被限的只是攻击者自己的出口。
//
//	· 账号（100 次/15 分钟）—— 兜底，挡分布式撞库（很多 IP 各试几次，永远碰不到
//	  IP 阈值）。必须放得很宽，因为**任何人都能对着别人的账号发失败请求** ——
//	  阈值定成 10 的话，攻击者用 10 个请求就能把任意用户锁在门外 15 分钟，
//	  那是我们自己造出来的拒绝服务，比它挡住的撞库更容易被利用。
//
// 这条是写测试时发现的：一开始两个维度都取 10，那条「不同 IP 互不牵连」的断言
// 直接失败 —— IP B 明明是干净的，却因为 IP A 对同一个账号试满了而被挡。
// 断言失败暴露的不是测试写错，是这个设计本身把受害者一起锁了。
//
// 100 次这个量级：正常人 15 分钟内不可能对一个账号试 100 次密码，而要靠它锁人
// 得连发 100 个请求且只能锁 15 分钟 —— 成本高、收益低、且这些请求本身会先撞上
// 攻击者自己的 IP 阈值。彻底消除锁人风险需要 CAPTCHA 或渐进延迟，那超出 v1 范围。
//
// 成功登录后两个维度都清零，免得之前打错几次继续压着这个用户。
//
// 注册 5 次/小时按 IP：正常人不会一小时内注册 5 个账号，而共用出口 IP 的
// 办公网/校园网偶尔会撞上 —— 代价是他们得等一会儿，比放开刷号划算。
const (
	loginIPAttempts = 10
	// 远高于 IP 阈值，理由见上：这个维度收紧等于给了别人锁我们用户的开关
	loginAccountAttempts = 100
	loginWindow          = 15 * time.Minute

	registerIPAttempts = 5
	registerWindow     = time.Hour

	// 请求体上限。凭证类请求体不该更大，而不设上限意味着任何人都能用一个
	// 巨大的 JSON 占满内存 —— 这条路甚至不需要登录。
	authBodyMax = 4 << 10 // 4 KiB
)

// decodeAuthBody 读取并解析凭证类请求体，带大小上限。
//
// 与 shareVerify 那处同一套写法：MaxBytesReader 超限时 Decode 返回
// *http.MaxBytesError，要单独回 413，否则会被当成"JSON 格式错"报成 400，
// 排查时看不出是体积问题。
func decodeAuthBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, authBodyMax)
	if err := json.NewDecoder(r.Body).Decode(dst); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			httpx.ErrorCode(w, http.StatusRequestEntityTooLarge, "bad_request", "Request body is too large")
			return false
		}
		httpx.ErrorCode(w, http.StatusBadRequest, "bad_request", "Invalid request")
		return false
	}
	return true
}

// tooManyAttempts 统一的限流响应。错误码与分享口令那处保持一致，
// 前端已经认得 too_many_requests。
func tooManyAttempts(w http.ResponseWriter) {
	httpx.ErrorCode(w, http.StatusTooManyRequests, "too_many_requests",
		"Too many attempts, please try again later")
}

func (a *App) takeLoginAttempt(w http.ResponseWriter, r *http.Request, identifier string) (*rateLimiter, string, string, bool) {
	limiter := a.rateLimit()
	ipKey := "login:ip:" + requestIP(r)
	if !limiter.allow(ipKey, loginIPAttempts, loginWindow) {
		tooManyAttempts(w)
		return nil, "", "", false
	}

	accountKey := fmt.Sprintf("login:acct:%x",
		sha256.Sum256([]byte(strings.ToLower(identifier))))
	if !limiter.allow(accountKey, loginAccountAttempts, loginWindow) {
		tooManyAttempts(w)
		return nil, "", "", false
	}
	return limiter, ipKey, accountKey, true
}

// authRegister 注册新用户。验证码消费、用户写入与验证码删除在同一事务内完成：
// 任一步失败都会回滚，用户可以用原验证码重试，不会出现“验证码吃掉了但账号没建成”。
func (a *App) authRegister(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Username         string `json:"username"`
		Email            string `json:"email"`
		Password         string `json:"password"`
		VerificationCode string `json:"verificationCode"`
		InvitationCode   string `json:"invitationCode"`
	}
	if !decodeAuthBody(w, r, &body) {
		return
	}

	body.Username = strings.TrimSpace(body.Username)
	body.Email = normalizeEmail(body.Email)

	if body.Username == "" || body.Email == "" || body.Password == "" {
		httpx.ErrorCode(w, http.StatusBadRequest, "missing_fields", "Username, email and password are all required")
		return
	}
	if !validRegistrationEmail(body.Email) {
		httpx.ErrorCode(w, http.StatusBadRequest, "invalid_email", "Invalid email format")
		return
	}
	if utf8.RuneCountInString(body.Password) < 6 {
		httpx.ErrorCode(w, http.StatusBadRequest, "password_too_short", "Password must be at least 6 characters")
		return
	}
	if body.VerificationCode == "" {
		httpx.ErrorCode(w, http.StatusBadRequest, "verification_code_required", "Email verification code is required")
		return
	}
	body.InvitationCode = normalizeInvitationCode(body.InvitationCode)
	if body.InvitationCode != "" && !validInvitationCode(body.InvitationCode) {
		invitationError(w)
		return
	}

	// 限流放在参数校验**之后**，只对「格式合法、真要建号」的请求计数。
	//
	// 一开始放在最前面，结果是填错表单也消耗配额 —— 阈值 5 次/小时，用户在注册页
	// 手滑五次（密码太短、邮箱漏了 @）就被锁一小时，而他一个号都没注册成功。
	// 这个后果是现有测试逼出来的：那组参数校验用例连发 9 个非法请求，第 6 个开始
	// 变成 429。测试撞上的正是真实用户会撞上的路径。
	//
	// 挡刷号的效果不受影响：真正要批量注册就必须发合法请求，而合法请求全都计数。
	if !a.rateLimit().allow("register:ip:"+requestIP(r), registerIPAttempts, registerWindow) {
		tooManyAttempts(w)
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
	invitationCode, err := newInvitationCode()
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

	verification, verifyErr := a.verifyEmailCode(r.Context(), tx, body.Email, body.VerificationCode)
	if verifyErr != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if verification != verificationValid {
		if err := tx.Commit(r.Context()); err != nil {
			httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
			return
		}
		verificationError(w, verification)
		return
	}

	var newUserID int
	var newAuthUserID string
	err = tx.QueryRow(r.Context(), `
		INSERT INTO users (
			auth_user_id, email, username, password_hash, is_verified,
			invitation_code, created_at, updated_at
		)
		VALUES ($1, $2, $3, $4, true, $5, now(), now())
		RETURNING id, auth_user_id
	`, authUserID, body.Email, body.Username, string(passwordHash), invitationCode).Scan(&newUserID, &newAuthUserID)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			httpx.ErrorCode(w, http.StatusConflict, "conflict", "Email or username is already taken")
			return
		}
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if err = applyInvitationReward(r.Context(), tx, newUserID, body.InvitationCode); err != nil {
		if errors.Is(err, errInvalidInvitationCode) {
			invitationError(w)
			return
		}
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if _, err = tx.Exec(r.Context(), `DELETE FROM email_verification_codes WHERE email = $1`, body.Email); err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}
	if err = tx.Commit(r.Context()); err != nil {
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
	if !decodeAuthBody(w, r, &body) {
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

	// 限流放在参数校验之后，理由同 authRegister：只对「真的在试一组凭证」的请求
	// 计数。空账号/空密码这类请求根本没验过任何口令，算进去只会让填错表单的
	// 真实用户被锁，挡不住任何爆破 —— 爆破必须发出完整的凭证组合。
	// 账号维度与 IP 维度共用一组辅助函数；邮箱恢复端点也调用它，避免攻击者在
	// /login 和 /verify-email 之间轮换，把密码尝试次数翻倍。
	limiter, ipKey, accountKey, allowed := a.takeLoginAttempt(w, r, identifier)
	if !allowed {
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
	if !rec.IsVerified {
		httpx.JSON(w, http.StatusForbidden, map[string]string{
			"code": "email_not_verified", "error": "Email address has not been verified", "email": rec.Email,
		})
		return
	}

	user, err := a.getUserByAuthUserID(r.Context(), rec.AuthUserID)
	if err != nil {
		httpx.ErrorCode(w, http.StatusInternalServerError, "server_error", "Server error, please try again later")
		return
	}

	// 登录成功后清掉两个维度的计数：之前打错几次密码不该继续压着这个用户。
	// 与 shareVerify 成功后 reset 同一个理由。
	limiter.reset(ipKey)
	limiter.reset(accountKey)

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
