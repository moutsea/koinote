package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"koinote/backend/internal/config"
)

// 登录与注册的限流。
//
// 上线前审计发现这两个端点完全没有限流：实测 20 次连续错误登录全部返回 401，
// 一个 429 都没有。配上 6 位的密码下限，爆破成本极低；注册无限流则意味着任何人
// 都能刷满用户表。限流器本来就在（rateLimiter），只是只接了分享口令那一处。
//
// 这些用例全部在触达数据库之前返回，所以不需要真实连接 —— 限流命中时直接 429，
// 而校验失败时也在查库之前就返回了。

// postJSONFrom 用指定的客户端 IP 打请求。
//
// 限流按 IP 分桶，所以测「不同 IP 互不影响」必须能控制这个值。
// 走 X-Forwarded-For 而不是 RemoteAddr：那是生产里 Worker 设的头，
// requestIP 优先读它（见 ratelimit.go），测的应该是真实生效的那条路径。
//
// 请求一旦穿过限流就会去查库，而这些用例里 app.db 是 nil —— 那会 panic。
// 这里把 panic 收住并当成「限流放行了」：本套件关心的只是放行/拦截这个二元结果，
// 查库之后的行为由别的测试覆盖。
//
// 用 recover 而不是接一个真库：这几条断言的对象是限流的分桶与阈值，纯内存逻辑，
// 挂上 postgres 只会让它们变慢且需要外部依赖，而覆盖的还是同一件事。
func postJSONFrom(handler http.HandlerFunc, ip, body string) (rec *httptest.ResponseRecorder, passed bool) {
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Forwarded-For", ip)
	rec = httptest.NewRecorder()

	defer func() {
		if recover() != nil {
			// 走到查库才 panic，说明限流放行了
			passed = true
		}
	}()
	handler(rec, req)
	return rec, rec.Code != http.StatusTooManyRequests
}

// limited 判断这次请求是否被限流挡下。
func limited(handler http.HandlerFunc, ip, body string) bool {
	_, passed := postJSONFrom(handler, ip, body)
	return !passed
}

// 同一 IP 连续试错密码，超过阈值必须 429。
//
// 这是最初那个漏洞的直接回归测试。
func TestLoginRateLimitedByIP(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "s"})
	body := `{"username":"victim","password":"wrong"}`

	// 前 loginIPAttempts 次必须放行
	for i := 0; i < loginIPAttempts; i++ {
		if limited(app.authLogin, "203.0.113.7", body) {
			t.Fatalf("第 %d 次就被限流，阈值是 %d", i+1, loginIPAttempts)
		}
	}

	// 第 loginIPAttempts+1 次必须被挡，且带上前端认得的错误码
	rec, passed := postJSONFrom(app.authLogin, "203.0.113.7", body)
	if passed {
		t.Fatalf("超过阈值后仍放行（HTTP %d）", rec.Code)
	}
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("期望 429，实际 %d（响应 %s）", rec.Code, rec.Body.String())
	}
	if code := decodeErrorCode(t, rec); code != "too_many_requests" {
		t.Errorf("期望错误码 too_many_requests，实际 %q", code)
	}
}

// 不同 IP 各自计数，互不牵连。
//
// 少了这条，一个把 key 写死（比如忘了拼 IP）的实现也能通过上面那条 ——
// 但那会让一个人的失败次数把所有用户一起锁死。
func TestLoginRateLimitIsolatesIPs(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "s"})
	body := `{"username":"victim","password":"wrong"}`

	// 把 A 用满
	for i := 0; i <= loginIPAttempts; i++ {
		postJSONFrom(app.authLogin, "198.51.100.1", body)
	}
	if !limited(app.authLogin, "198.51.100.1", body) {
		t.Fatal("IP A 应已被限流")
	}

	// B 应当完全不受影响
	if limited(app.authLogin, "198.51.100.2", body) {
		t.Fatal("IP B 不该因为 IP A 的失败次数被限流")
	}
}

// 账号维度：很多不同 IP 试同一个账号也要被挡。
//
// IP 维度对撞库/代理池无效 —— 每个 IP 只试一两次就换，永远碰不到 IP 阈值。
// 这条用「每次换一个 IP」来确保挡住它的只能是账号维度。
func TestLoginRateLimitedByAccount(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "s"})
	body := `{"username":"target","password":"wrong"}`

	blocked := false
	// 多试几轮：每次换 IP，所以 IP 维度永远不会触发
	for i := 0; i < loginAccountAttempts+5; i++ {
		ip := "192.0.2." + itoa(i+1)
		if limited(app.authLogin, ip, body) {
			blocked = true
			// 必须是在账号阈值附近才挡，不能一上来就挡
			if i < loginAccountAttempts {
				t.Fatalf("第 %d 次（每次换 IP）就被挡，账号阈值是 %d", i+1, loginAccountAttempts)
			}
			break
		}
	}
	if !blocked {
		t.Fatalf("换 IP 试同一账号 %d 次仍未被限流 —— 撞库挡不住", loginAccountAttempts+5)
	}
}

// 别人不能靠试错把我的账号锁在门外。
//
// 这条是设计上最容易做错的一处，而且做错了很隐蔽 —— 它看起来"更安全"。
//
// 一开始账号维度的阈值和 IP 一样是 10，结果攻击者只要对着某个账号发 10 个错误
// 请求，那个账号的真实用户就被挡 15 分钟，密码再对也进不去。那是我们自己造出来
// 的拒绝服务，比它挡住的撞库更容易被利用。
//
// 所以账号阈值必须远高于 IP 阈值：攻击者要锁人，得先撞上自己的 IP 阈值。
func TestAttackerCannotLockOutVictimAccount(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "s"})
	const victim = "victim-account"

	// 攻击者从自己的 IP 试满（超过 IP 阈值就会被自己的桶挡住）
	for i := 0; i < loginIPAttempts+5; i++ {
		postJSONFrom(app.authLogin, "203.0.113.250",
			`{"username":"`+victim+`","password":"wrong"}`)
	}

	// 受害者从自己的 IP 登录同一个账号：必须放行
	if limited(app.authLogin, "198.51.100.77",
		`{"username":"`+victim+`","password":"correct-horse"}`) {
		t.Fatal("攻击者试错把受害者锁在门外了 —— 账号维度阈值定得太低")
	}

	// 结构性保证，而不只是当前取值碰巧合适
	if loginAccountAttempts <= loginIPAttempts {
		t.Fatalf("账号阈值(%d)必须远高于 IP 阈值(%d)，否则任何人都能锁任何账号",
			loginAccountAttempts, loginIPAttempts)
	}
}

// 账号维度对大小写不敏感。
//
// 登录本身是大小写不敏感的（见 passwordLoginRecord），限流必须跟着 ——
// 否则 Alice / alice / ALICE 各拿一份独立配额，阈值被轻易放大。
func TestLoginRateLimitAccountCaseInsensitive(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "s"})

	variants := []string{"Target", "target", "TARGET", "TaRgEt"}
	blocked := false
	for i := 0; i < loginAccountAttempts+5; i++ {
		// 每次换 IP 且换大小写写法，只有归一化的账号维度能挡住
		ip := "192.0.2." + itoa(i+1)
		name := variants[i%len(variants)]
		if limited(app.authLogin, ip, `{"username":"`+name+`","password":"wrong"}`) {
			blocked = true
			break
		}
	}
	if !blocked {
		t.Fatal("变换大小写绕过了账号维度限流")
	}
}

// 注册限流：同一 IP 反复注册要被挡。
//
// 用合法请求体 —— 限流故意放在参数校验之后（见 authRegister 的注释），
// 非法请求不计数。
func TestRegisterRateLimitedByIP(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "s"})

	blocked := false
	for i := 0; i < registerIPAttempts+3; i++ {
		body := `{"username":"u` + itoa(i) + `","email":"u` + itoa(i) + `@example.com","password":"secret123","verificationCode":"123456"}`
		if limited(app.authRegister, "203.0.113.99", body) {
			blocked = true
			if i < registerIPAttempts {
				t.Fatalf("第 %d 次注册就被挡，阈值是 %d", i+1, registerIPAttempts)
			}
			break
		}
	}
	if !blocked {
		t.Fatalf("同 IP 注册 %d 次仍未被限流", registerIPAttempts+3)
	}
}

// 参数非法的请求不消耗注册配额。
//
// 这条是被现有测试逼出来的：限流最初放在最前面，于是那组「注册参数校验」用例
// （连发 9 个非法请求）从第 6 个开始变成 429。测试撞上的正是真实用户会撞上的
// 路径 —— 在注册页手滑五次就被锁一小时，而一个号都没建成。
//
// 挡刷号的效果不受影响：批量注册必须发合法请求，而合法请求全都计数。
func TestRegisterInvalidInputDoesNotConsumeQuota(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "s"})
	ip := "203.0.113.55"

	// 远超阈值的非法请求：密码太短、邮箱没有 @、字段缺失
	invalid := []string{
		`{"username":"u","email":"a@b.com","password":"12345"}`,
		`{"username":"u","email":"notanemail","password":"secret123"}`,
		`{}`,
		`{"username":"   ","email":"a@b.com","password":"secret123"}`,
	}
	for round := 0; round < 5; round++ {
		for _, body := range invalid {
			if limited(app.authRegister, ip, body) {
				t.Fatalf("非法请求不该消耗配额，但第 %d 轮就被限流了", round+1)
			}
		}
	}

	// 配额应当还是满的：紧接着发一个合法请求，不该被挡
	if limited(app.authRegister, ip,
		`{"username":"real","email":"real@example.com","password":"secret123","verificationCode":"123456"}`) {
		t.Fatal("20 个非法请求之后合法请求被限流 —— 说明非法请求消耗了配额")
	}
}

// 同理：账号或密码为空的登录请求不消耗配额。
func TestLoginInvalidInputDoesNotConsumeQuota(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "s"})
	ip := "203.0.113.66"

	for i := 0; i < loginIPAttempts+10; i++ {
		if limited(app.authLogin, ip, `{"username":"","password":""}`) {
			t.Fatalf("空凭证不该消耗配额，第 %d 次就被限流", i+1)
		}
	}
}

// 请求体有大小上限。
//
// 不设上限意味着任何人都能用一个巨大的 JSON 占内存，而这条路不需要登录。
func TestAuthBodySizeLimited(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "s"})

	huge := `{"username":"u","email":"a@b.com","password":"` +
		strings.Repeat("x", authBodyMax+1024) + `"}`

	for name, handler := range map[string]http.HandlerFunc{
		"register":          app.authRegister,
		"login":             app.authLogin,
		"verification-code": app.authVerificationCode,
		"verify-email":      app.authVerifyEmail,
	} {
		rec, _ := postJSONFrom(handler, "203.0.113.200", huge)
		if rec.Code != http.StatusRequestEntityTooLarge {
			t.Errorf("%s: 超大请求体期望 413，实际 %d（响应 %s）",
				name, rec.Code, rec.Body.String())
		}
	}
}

// itoa 避免为了几个数字引入 strconv —— 这里只需要小的非负整数
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var digits []byte
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}
