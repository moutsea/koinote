package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"golang.org/x/crypto/bcrypt"

	"koinote/backend/internal/config"
)

// decodeErrorCode 从错误响应里取出稳定错误码，前端靠它做 i18n。
func decodeErrorCode(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	var body struct {
		Error string `json:"error"`
		Code  string `json:"code"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("解析错误响应失败: %v (原文 %q)", err, rec.Body.String())
	}
	return body.Code
}

// postJSON 直接打到 handler 上，绕开路由（这些端点不需要 PathValue）。
func postJSON(handler http.HandlerFunc, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	handler(rec, req)
	return rec
}

// ---------- 注册参数校验 ----------

// 这些用例全部在触达数据库之前返回，因此不需要真实连接。
func TestAuthRegisterValidation(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "s"})

	cases := []struct {
		name         string
		body         string
		expectedHTTP int
		expectedCode string
	}{
		{"请求体非 JSON", `not json`, http.StatusBadRequest, "bad_request"},
		{"空对象", `{}`, http.StatusBadRequest, "missing_fields"},
		{"缺用户名", `{"email":"a@b.com","password":"secret123"}`, http.StatusBadRequest, "missing_fields"},
		{"缺邮箱", `{"username":"u","password":"secret123"}`, http.StatusBadRequest, "missing_fields"},
		{"缺密码", `{"username":"u","email":"a@b.com"}`, http.StatusBadRequest, "missing_fields"},
		{"用户名仅空白", `{"username":"   ","email":"a@b.com","password":"secret123"}`, http.StatusBadRequest, "missing_fields"},
		{"邮箱仅空白", `{"username":"u","email":"   ","password":"secret123"}`, http.StatusBadRequest, "missing_fields"},
		{"邮箱无 @", `{"username":"u","email":"notanemail","password":"secret123"}`, http.StatusBadRequest, "invalid_email"},
		{"密码过短", `{"username":"u","email":"a@b.com","password":"12345"}`, http.StatusBadRequest, "password_too_short"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := postJSON(app.authRegister, tc.body)
			if rec.Code != tc.expectedHTTP {
				t.Fatalf("期望 HTTP %d，实际 %d（响应 %s）", tc.expectedHTTP, rec.Code, rec.Body.String())
			}
			if code := decodeErrorCode(t, rec); code != tc.expectedCode {
				t.Fatalf("期望错误码 %q，实际 %q", tc.expectedCode, code)
			}
		})
	}
}

// 密码长度按字符数而非字节数计，5 个汉字（15 字节）应当被拒。
func TestAuthRegisterPasswordLengthCountsRunes(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "s"})
	rec := postJSON(app.authRegister, `{"username":"u","email":"a@b.com","password":"密码五个字"}`)

	if code := decodeErrorCode(t, rec); code != "password_too_short" {
		t.Fatalf("5 个字符的密码应被拒，实际错误码 %q", code)
	}
}

// 校验失败时绝不能签发会话 cookie
func TestAuthRegisterFailureIssuesNoCookie(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "s"})
	rec := postJSON(app.authRegister, `{"username":"u","email":"bad","password":"secret123"}`)

	for _, c := range rec.Result().Cookies() {
		if c.Name == sessionCookieName && c.Value != "" {
			t.Fatal("注册校验失败却签发了会话 cookie")
		}
	}
}

// ---------- 登录参数校验 ----------

func TestAuthLoginValidation(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "s"})

	cases := []struct {
		name         string
		body         string
		expectedCode string
	}{
		{"请求体非 JSON", `not json`, "bad_request"},
		{"空对象", `{}`, "missing_fields"},
		{"只给账号不给密码", `{"username":"u"}`, "missing_fields"},
		{"只给密码不给账号", `{"password":"secret123"}`, "missing_fields"},
		{"账号仅空白", `{"username":"   ","password":"secret123"}`, "missing_fields"},
		{"邮箱字段仅空白", `{"email":"   ","password":"secret123"}`, "missing_fields"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := postJSON(app.authLogin, tc.body)
			if rec.Code != http.StatusBadRequest {
				t.Fatalf("期望 400，实际 %d（响应 %s）", rec.Code, rec.Body.String())
			}
			if code := decodeErrorCode(t, rec); code != tc.expectedCode {
				t.Fatalf("期望错误码 %q，实际 %q", tc.expectedCode, code)
			}
		})
	}
}

// ---------- 登出 ----------

func TestAuthLogoutClearsCookie(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "s"})
	rec := postJSON(app.authLogout, ``)

	if rec.Code != http.StatusOK {
		t.Fatalf("期望 200，实际 %d", rec.Code)
	}
	c := readSetCookie(t, rec, sessionCookieName)
	if c.Value != "" || c.MaxAge >= 0 {
		t.Fatalf("登出应清空 cookie 并设置负 MaxAge，实际 value=%q maxAge=%d", c.Value, c.MaxAge)
	}
}

// ---------- 会话查询鉴权 ----------

func TestAuthSessionRequiresAuth(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "s"})

	cases := []struct {
		name   string
		cookie *http.Cookie
	}{
		{"完全无 cookie", nil},
		{"垃圾 cookie", &http.Cookie{Name: sessionCookieName, Value: "garbage"}},
		{"签名被篡改", &http.Cookie{Name: sessionCookieName, Value: "payload.badsig"}},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/auth/session", nil)
			if tc.cookie != nil {
				req.AddCookie(tc.cookie)
			}
			rec := httptest.NewRecorder()
			app.authSession(rec, req)

			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("期望 401，实际 %d", rec.Code)
			}
			if code := decodeErrorCode(t, rec); code != "unauthorized" {
				t.Fatalf("期望错误码 unauthorized，实际 %q", code)
			}
		})
	}
}

// ---------- 密码哈希 ----------

// bcrypt 每次加盐，同一密码两次哈希必须不同，但都能校验通过。
func TestBcryptHashingBehavior(t *testing.T) {
	password := "secret123"

	first, err := bcrypt.GenerateFromPassword([]byte(password), bcryptCost)
	if err != nil {
		t.Fatalf("生成哈希失败: %v", err)
	}
	second, err := bcrypt.GenerateFromPassword([]byte(password), bcryptCost)
	if err != nil {
		t.Fatalf("生成哈希失败: %v", err)
	}

	if string(first) == string(second) {
		t.Fatal("两次哈希结果相同，说明没有加盐")
	}
	if bcrypt.CompareHashAndPassword(first, []byte(password)) != nil {
		t.Error("正确密码应校验通过")
	}
	if bcrypt.CompareHashAndPassword(first, []byte("wrongpass")) == nil {
		t.Error("错误密码不应校验通过")
	}
	if cost, _ := bcrypt.Cost(first); cost != bcryptCost {
		t.Errorf("期望 cost=%d，实际 %d", bcryptCost, cost)
	}
}

// 登录失败路径里那个占位哈希必须是「永不匹配」的，
// 它的作用只是消耗与真实校验相当的时间，缓解用户枚举的时序差异。
func TestDummyHashNeverMatches(t *testing.T) {
	dummy := []byte("$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidin")
	for _, guess := range []string{"", "secret123", "password", "invalid"} {
		if bcrypt.CompareHashAndPassword(dummy, []byte(guess)) == nil {
			t.Fatalf("占位哈希竟然匹配了密码 %q", guess)
		}
	}
}

// ---------- UUID 生成 ----------

func TestRandomUUIDFormat(t *testing.T) {
	seen := make(map[string]bool, 200)
	for i := 0; i < 200; i++ {
		id, err := randomUUID()
		if err != nil {
			t.Fatalf("生成 UUID 失败: %v", err)
		}
		if len(id) != 36 {
			t.Fatalf("UUID 长度应为 36，实际 %d (%q)", len(id), id)
		}
		parts := strings.Split(id, "-")
		if len(parts) != 5 {
			t.Fatalf("UUID 应为 5 段，实际 %q", id)
		}
		if lens := []int{len(parts[0]), len(parts[1]), len(parts[2]), len(parts[3]), len(parts[4])}; lens[0] != 8 ||
			lens[1] != 4 || lens[2] != 4 || lens[3] != 4 || lens[4] != 12 {
			t.Fatalf("UUID 分段长度不符 8-4-4-4-12，实际 %q", id)
		}
		if parts[2][0] != '4' {
			t.Fatalf("应为 version 4 UUID，实际 %q", id)
		}
		if v := parts[3][0]; v != '8' && v != '9' && v != 'a' && v != 'b' {
			t.Fatalf("variant 位应为 8/9/a/b，实际 %q", id)
		}
		if seen[id] {
			t.Fatalf("生成了重复 UUID %q", id)
		}
		seen[id] = true
	}
}
