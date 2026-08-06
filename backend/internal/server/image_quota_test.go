package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"koinote/backend/internal/config"
)

// imageKeyOwner 是记账时的归属边界：Worker 报上来的 key 前缀必须是报账者自己。
// 少了这道判断，一个用户能把对象记到别人账上 —— 既能耗尽别人的配额，也能让自己的
// 用量不涨。所以这里的用例偏重"不该通过"的情形。
func TestImageKeyOwner(t *testing.T) {
	tests := []struct {
		name      string
		key       string
		wantOwner string
		wantOK    bool
	}{
		{
			name:      "常规 key",
			key:       "u/alice/" + hexA + ".png",
			wantOwner: "alice",
			wantOK:    true,
		},
		{
			name:      "带连字符与下划线的 id",
			key:       "u/a_b-c/" + hexA + ".webp",
			wantOwner: "a_b-c",
			wantOK:    true,
		},
		{
			name:   "空串",
			key:    "",
			wantOK: false,
		},
		{
			name:   "缺 u/ 前缀",
			key:    "alice/" + hexA + ".png",
			wantOK: false,
		},
		{
			name:   "路径穿越",
			key:    "u/../alice/" + hexA + ".png",
			wantOK: false,
		},
		{
			name:   "双斜杠",
			key:    "u//alice/" + hexA + ".png",
			wantOK: false,
		},
		{
			name:   "不支持的扩展名",
			key:    "u/alice/" + hexA + ".svg",
			wantOK: false,
		},
		{
			name:   "hex 太短",
			key:    "u/alice/abc.png",
			wantOK: false,
		},
		{
			name:   "hex 含非十六进制字符",
			key:    "u/alice/zzzzzzzz.png",
			wantOK: false,
		},
		{
			name:   "多一层目录",
			key:    "u/alice/sub/" + hexA + ".png",
			wantOK: false,
		},
		{
			name:   "前后有多余内容（正则必须整串锚定）",
			key:    "x/u/alice/" + hexA + ".png",
			wantOK: false,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			owner, ok := imageKeyOwner(tc.key)
			if ok != tc.wantOK {
				t.Fatalf("imageKeyOwner(%q) ok = %v，期望 %v", tc.key, ok, tc.wantOK)
			}
			if owner != tc.wantOwner {
				t.Fatalf("imageKeyOwner(%q) owner = %q，期望 %q", tc.key, owner, tc.wantOwner)
			}
		})
	}
}

// imageKeyOwner 与 isSafeImageKey 用的是两个正则（后者不捕获，前者捕获一段）。
// 两个正则分开写就会漂，所以钉住它们的判定必须一致：能过 isSafeImageKey 的 key
// 一定能解析出 owner，反之亦然。
func TestImageKeyOwnerAgreesWithIsSafeImageKey(t *testing.T) {
	keys := []string{
		"u/alice/" + hexA + ".png",
		"u/alice/" + hexB + ".jpg",
		"u/a/" + hexA + ".gif",
		"u/a_b-c/" + hexA + ".webp",
		"",
		"alice/" + hexA + ".png",
		"u/../alice/" + hexA + ".png",
		"u//alice/" + hexA + ".png",
		"u/alice/" + hexA + ".svg",
		"u/alice/abc.png",
		"u/alice/sub/" + hexA + ".png",
		"x/u/alice/" + hexA + ".png",
		"u/alice/" + hexA + ".png/extra",
		// 超长 id：两边都该拒（上限 128）
		"u/" + repeat("a", 129) + "/" + hexA + ".png",
		// 正好 128：两边都该收
		"u/" + repeat("a", 128) + "/" + hexA + ".png",
	}

	for _, key := range keys {
		safe := isSafeImageKey(key)
		_, ok := imageKeyOwner(key)
		if safe != ok {
			t.Errorf("判定不一致 key=%q: isSafeImageKey=%v, imageKeyOwner ok=%v", key, safe, ok)
		}
	}
}

// 归属比对必须是相等，不是前缀。authUserId 为 "abc" 的人不该能碰到 "abcd" 的对象。
func TestImageKeyOwnerIsExactNotPrefix(t *testing.T) {
	key := "u/abcd/" + hexA + ".png"
	owner, ok := imageKeyOwner(key)
	if !ok {
		t.Fatalf("imageKeyOwner(%q) 应当成功", key)
	}
	if owner == "abc" {
		t.Fatal("owner 不该是前缀 abc")
	}
	if owner != "abcd" {
		t.Fatalf("owner = %q，期望 abcd", owner)
	}
}

// imageQuota 必须永远返回正数。
//
// 配额为 0 或负数的后果是所有人都传不了图 —— 也就是一个手滑的配置能让功能整体失效。
// 这道兜底是那件事唯一的防线，所以把各种坏 Config 都过一遍。
func TestImageQuotaAlwaysPositive(t *testing.T) {
	cases := []struct {
		name       string
		configured int64
		want       int64
	}{
		{
			name:       "正常配置照用",
			configured: 200 * 1024 * 1024,
			want:       200 * 1024 * 1024,
		},
		{
			// Config 零值。测试里构造的 App、或将来别的加载路径都可能是这样
			name:       "零回落到默认",
			configured: 0,
			want:       config.DefaultImageQuotaMB * 1024 * 1024,
		},
		{
			name:       "负数回落到默认",
			configured: -1,
			want:       config.DefaultImageQuotaMB * 1024 * 1024,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			app := newTestApp(config.Config{ImageQuotaBytes: tc.configured})
			got := app.imageQuota()
			if got != tc.want {
				t.Fatalf("imageQuota() = %d，期望 %d", got, tc.want)
			}
			if got <= 0 {
				t.Fatalf("配额必须为正，实际 %d", got)
			}
		})
	}
}

// 默认配额与单图上限的关系：必须远大于单图上限，否则一张图就能占满，
// "配额"就没有意义了。Worker 侧 MAX_BYTES 是 10 MiB。
func TestDefaultQuotaFitsManyImages(t *testing.T) {
	const singleImageMax = 10 * 1024 * 1024
	defaultQuota := config.DefaultImageQuotaMB * 1024 * 1024

	if defaultQuota < singleImageMax*10 {
		t.Fatalf("默认配额 %d 相对单图上限 %d 太小，至少该能放十张",
			defaultQuota, singleImageMax)
	}
}

// hasInternalToken 是 /api/images/record 的守卫。
//
// 它防的是一个具体的配额绕过：光用 requireUser 的话，那个函数也接受浏览器的会话
// cookie，于是任何登录用户都能自己报账 —— 对一个记账曾经失败的 key 报 bytes=1，
// ON CONFLICT DO NOTHING 会把这个错误的大小固定下来，之后再没人纠正。
//
// 直接测这个函数而不是打 /api/images/record：newTestApp 的 db 是 nil，走路由的话
// requireUser 会因为查不到用户而先返回 401，于是无论有没有这道守卫都是 401 ——
// 那样的断言分辨不出两者，是空的（已验证：去掉守卫，路由级断言仍然全绿）。
func TestHasInternalToken(t *testing.T) {
	cases := []struct {
		name       string
		configured string
		sent       string
		want       bool
	}{
		{
			name:       "令牌正确",
			configured: "real-token",
			sent:       "real-token",
			want:       true,
		},
		{
			name:       "令牌错误",
			configured: "real-token",
			sent:       "wrong-token",
			want:       false,
		},
		{
			// hmac.Equal 不该因为前缀对就放行
			name:       "令牌是正确值的前缀",
			configured: "real-token",
			sent:       "real",
			want:       false,
		},
		{
			name:       "令牌是正确值的超集",
			configured: "real-token",
			sent:       "real-token-extra",
			want:       false,
		},
		{
			name:       "没带令牌头",
			configured: "real-token",
			sent:       "",
			want:       false,
		},
		{
			// 关键：未配置令牌时，任何请求都不该通过。
			// 否则空令牌的部署等于这个端点完全敞开 —— 连空头都能过
			name:       "未配置令牌，带空头",
			configured: "",
			sent:       "",
			want:       false,
		},
		{
			name:       "未配置令牌，带任意值",
			configured: "",
			sent:       "anything",
			want:       false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			app := newTestApp(config.Config{InternalToken: tc.configured})
			req := httptest.NewRequest(http.MethodPost, "/api/images/record", nil)
			if tc.sent != "" {
				req.Header.Set("X-Koinote-Internal-Token", tc.sent)
			}
			if got := app.hasInternalToken(req); got != tc.want {
				t.Fatalf("hasInternalToken = %v，期望 %v（配置 %q，发送 %q）",
					got, tc.want, tc.configured, tc.sent)
			}
		})
	}
}

// 路由存在且未登录时不返回 2xx。
//
// 这条不区分"被守卫拒"和"被 requireUser 拒"（db 为 nil，见上面的说明），
// 只保证这两个端点没有敞着。
func TestQuotaRoutesRejectUnauthenticated(t *testing.T) {
	app := newTestApp(config.Config{SessionSecret: "s", InternalToken: "real-token"})

	cases := []struct {
		method string
		path   string
		body   string
	}{
		{http.MethodGet, "/api/storage/usage", ""},
		{http.MethodPost, "/api/images/record", `{"key":"u/alice/` + hexA + `.png","bytes":1}`},
	}

	for _, tc := range cases {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, tc.path, strings.NewReader(tc.body))
			rec := httptest.NewRecorder()
			app.Routes().ServeHTTP(rec, req)

			if rec.Code >= 200 && rec.Code < 300 {
				t.Fatalf("未登录不该成功，实际 %d", rec.Code)
			}
		})
	}
}

// 记账语句必须是"判断与插入在同一句"。
//
// 这条性质的正确性没有真数据库验不了（并发行为属于集成测试），但它有一种很具体的退化
// 方式：有人为了可读性把那句拆成 SELECT SUM 再 INSERT。拆完之后所有单机测试照旧全绿，
// 只有并发上传时配额才会被突破 —— 这种改动不该悄无声息地过去。
//
// 所以这里读源码，钉住那条语句的形状。读自己的源码做断言不常规，但比"没有任何东西
// 拦得住这次退化"要好。
func TestRecordImageObjectUsesSingleStatement(t *testing.T) {
	data, err := os.ReadFile("image_quota.go")
	if err != nil {
		t.Fatalf("读 image_quota.go: %v", err)
	}
	src := string(data)

	idx := strings.Index(src, "INSERT INTO image_objects")
	if idx < 0 {
		t.Fatal("找不到 INSERT INTO image_objects")
	}
	// 截到该 SQL 字面量的结束反引号
	tail := src[idx:]
	end := strings.Index(tail, "`")
	if end < 0 {
		t.Fatal("找不到 SQL 字面量的结尾反引号")
	}
	stmt := tail[:end]

	for _, want := range []string{"SELECT", "WHERE", "SUM(bytes)", "ON CONFLICT"} {
		if !strings.Contains(stmt, want) {
			t.Errorf("记账语句里缺 %q —— 判断与插入必须在同一句 SQL 里，"+
				"否则并发上传会突破配额。当前语句:\n%s", want, stmt)
		}
	}
}

func repeat(s string, n int) string {
	return strings.Repeat(s, n)
}
