package server

import "testing"

// TestNormalizeShareAccess 读取路径的档位归一。
// 删掉 public 档后，存量行仍会读出 "public"，必须按 link 处理。
func TestNormalizeShareAccess(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"口令档保持", "password", shareAccessPassword},
		{"链接档保持", "link", shareAccessLink},
		{"存量 public 归一为 link", "public", shareAccessLink},
		{"空值归一为 link", "", shareAccessLink},
		{"空白归一为 link", "   ", shareAccessLink},
		{"未知取值归一为 link", "whatever", shareAccessLink},
		{"带空白的口令档", " password ", shareAccessPassword},
		// 库里只写入小写常量，认下大写只会掩盖数据被外部改过的事实
		{"大写不认作口令档", "PASSWORD", shareAccessLink},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := normalizeShareAccess(tc.raw); got != tc.want {
				t.Fatalf("normalizeShareAccess(%q) = %q，期望 %q", tc.raw, got, tc.want)
			}
		})
	}
}

// TestNormalizeShareAccessNeverInventsPassword 归一只会放宽读取结果，
// 绝不能把非口令档读成口令档 —— 那会让界面显示一个不存在的口令保护。
func TestNormalizeShareAccessNeverInventsPassword(t *testing.T) {
	for _, raw := range []string{"", "link", "public", "pass", "passwordx", "PASSWORD", "口令"} {
		if normalizeShareAccess(raw) == shareAccessPassword {
			t.Fatalf("normalizeShareAccess(%q) 凭空得出口令档", raw)
		}
	}
}

// TestShouldRotateShareToken 这是本次修复的核心判定。
//
// 规则：只有「原本有口令、改后没口令」才轮换 token。
// 收紧权限复用 token 是有意的（老链接只会变严）；放宽则必须换，
// 否则同一 URL 从要口令变成谁都能读，而用户以为只是改了个设置。
func TestShouldRotateShareToken(t *testing.T) {
	cases := []struct {
		name             string
		token            string
		hadPassword      bool
		willHavePassword bool
		want             bool
	}{
		{"放宽：口令→无口令，必须轮换", "tok", true, false, true},
		{"收紧：无口令→口令，复用", "tok", false, true, false},
		{"不变：口令→口令（改口令），复用", "tok", true, true, false},
		{"不变：无口令→无口令，复用", "tok", false, false, false},
		{"首次分享：无老 token，谈不上轮换", "", false, false, false},
		{"首次分享带口令，不算轮换", "", false, true, false},
		// 空 token 但库里残留口令哈希：仍是首次分享，没有老链接可失效
		{"空 token 即便有残留哈希也不轮换", "", true, false, false},
		{"空白 token 视为无 token", "   ", true, false, false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := shouldRotateShareToken(tc.token, tc.hadPassword, tc.willHavePassword)
			if got != tc.want {
				t.Fatalf("shouldRotateShareToken(%q, had=%v, will=%v) = %v，期望 %v",
					tc.token, tc.hadPassword, tc.willHavePassword, got, tc.want)
			}
		})
	}
}

// TestShouldRotateOnEveryLoosening 穷举一遍：只要是放宽且有老 token，
// 就必须轮换。这条单独立一个测试，因为它是本次修复要守住的唯一不变式 ——
// 漏掉任何一种放宽路径都等于漏洞还在。
func TestShouldRotateOnEveryLoosening(t *testing.T) {
	for _, token := range []string{"a", "deadbeef", "0123456789abcdef"} {
		if !shouldRotateShareToken(token, true, false) {
			t.Fatalf("token=%q 的放宽操作没有触发轮换", token)
		}
	}
}

// TestShareAccessConstantsDistinct 三个常量取值不能重合，
// 否则档位判断会互相串味。
func TestShareAccessConstantsDistinct(t *testing.T) {
	if shareAccessLink == shareAccessPassword {
		t.Fatal("link 与 password 取值相同")
	}
	if shareAccessPublicLegacy == shareAccessLink ||
		shareAccessPublicLegacy == shareAccessPassword {
		t.Fatal("legacy public 与在用档位取值重合")
	}
}
