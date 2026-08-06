package server

import (
	"os"
	"strings"
	"testing"
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

// 配额常量本身。改动它是产品决策，不该是手滑 —— 比如把 500*1024*1024 写成
// 500*1000*1000，或者少写一个 1024 变成 500 KiB。
func TestImageQuotaBytes(t *testing.T) {
	const wantMiB = 500
	if ImageQuotaBytes != wantMiB*1024*1024 {
		t.Fatalf("ImageQuotaBytes = %d，期望 %d MiB (%d)",
			ImageQuotaBytes, wantMiB, wantMiB*1024*1024)
	}
	// 与单图上限的关系：配额必须远大于单图上限，否则一张图就能占满，
	// "配额"就没有意义了。Worker 侧 MAX_BYTES 是 10 MiB
	const singleImageMax = 10 * 1024 * 1024
	if ImageQuotaBytes < singleImageMax*10 {
		t.Fatalf("配额 %d 相对单图上限 %d 太小，至少该能放十张",
			ImageQuotaBytes, singleImageMax)
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
