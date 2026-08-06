package server

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
)

const (
	hexA = "0123456789abcdef"
	hexB = "fedcba9876543210"
)

func TestExtractOwnedImageKeys(t *testing.T) {
	tests := []struct {
		name    string
		content string
		owner   string
		want    []string
	}{
		{
			name:    "空正文",
			content: "",
			owner:   "alice",
			want:    nil,
		},
		{
			name:    "没有图片",
			content: "# 标题\n\n一段正文，没有图。",
			owner:   "alice",
			want:    nil,
		},
		{
			name:    "CDN 形式的绝对地址",
			content: fmt.Sprintf("![图](https://img.koinote.app/u/alice/%s.png)", hexA),
			owner:   "alice",
			want:    []string{"u/alice/" + hexA + ".png"},
		},
		{
			name:    "Worker 代理形式的相对地址",
			content: fmt.Sprintf("![图](/images/u/alice/%s.jpg)", hexA),
			owner:   "alice",
			want:    []string{"u/alice/" + hexA + ".jpg"},
		},
		{
			name: "多张图，去重",
			content: fmt.Sprintf(
				"![a](/images/u/alice/%s.png)\n![b](/images/u/alice/%s.webp)\n![a 又一次](/images/u/alice/%s.png)",
				hexA, hexB, hexA,
			),
			owner: "alice",
			want: []string{
				"u/alice/" + hexA + ".png",
				"u/alice/" + hexB + ".webp",
			},
		},
		{
			// 这条是安全边界：在自己的文档里写别人的图片地址，不能让它进回收队列
			name:    "别人的图片一律不认",
			content: fmt.Sprintf("![偷](https://img.koinote.app/u/bob/%s.png)", hexA),
			owner:   "alice",
			want:    nil,
		},
		{
			name: "混着自己的和别人的，只取自己的",
			content: fmt.Sprintf(
				"![我的](/images/u/alice/%s.png)\n![他的](/images/u/bob/%s.png)",
				hexA, hexB,
			),
			owner: "alice",
			want:  []string{"u/alice/" + hexA + ".png"},
		},
		{
			// HasPrefix 而非 == 的话这条会漏
			name:    "前缀相近的用户名不串",
			content: fmt.Sprintf("![别人](/images/u/alice2/%s.png)", hexA),
			owner:   "alice",
			want:    nil,
		},
		{
			name:    "空 owner 不匹配任何东西",
			content: fmt.Sprintf("![图](/images/u/alice/%s.png)", hexA),
			owner:   "",
			want:    nil,
		},
		{
			name:    "hex 太短不认（可能是站外的巧合地址）",
			content: "![图](/images/u/alice/abc.png)",
			owner:   "alice",
			want:    nil,
		},
		{
			name:    "不支持的扩展名不认",
			content: fmt.Sprintf("![图](/images/u/alice/%s.svg)", hexA),
			owner:   "alice",
			want:    nil,
		},
		{
			name:    "裸 HTML img 也认",
			content: fmt.Sprintf(`<img src="https://img.koinote.app/u/alice/%s.gif">`, hexA),
			owner:   "alice",
			want:    []string{"u/alice/" + hexA + ".gif"},
		},
		{
			name:    "带查询串的地址",
			content: fmt.Sprintf("![图](https://img.koinote.app/u/alice/%s.png?v=2)", hexA),
			owner:   "alice",
			want:    []string{"u/alice/" + hexA + ".png"},
		},
		{
			name:    "大写 hex 不认（key 生成的是小写）",
			content: "![图](/images/u/alice/0123456789ABCDEF.png)",
			owner:   "alice",
			want:    nil,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := extractOwnedImageKeys(tc.content, tc.owner)
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("extractOwnedImageKeys() = %v, 期望 %v", got, tc.want)
			}
		})
	}
}

// 不变量：抽出来的每个 key 都必须通过入队前的形状校验，
// 且前缀必须是当前用户 —— 两个函数各自演进时不能漂开
func TestExtractedKeysAreAlwaysSafe(t *testing.T) {
	owner := "alice"
	content := fmt.Sprintf(
		"![a](/images/u/alice/%s.png) ![b](https://img.koinote.app/u/alice/%s.jpg) "+
			"![c](/images/u/bob/%s.gif) ![d](/images/u/alice/%s.webp)",
		hexA, hexB, hexA, hexB,
	)
	keys := extractOwnedImageKeys(content, owner)
	if len(keys) == 0 {
		t.Fatal("期望抽出若干 key，得到 0 个")
	}
	for _, key := range keys {
		if !isSafeImageKey(key) {
			t.Errorf("抽出的 key 没通过 isSafeImageKey: %q", key)
		}
		if !strings.HasPrefix(key, "u/"+owner+"/") {
			t.Errorf("抽出的 key 不属于当前用户: %q", key)
		}
	}
}

func TestIsSafeImageKey(t *testing.T) {
	good := []string{
		"u/alice/" + hexA + ".png",
		"u/a/" + hexA + ".jpg",
		"u/user-with_dashes/" + hexB + ".webp",
		"u/alice/" + hexA + ".gif",
	}
	for _, key := range good {
		if !isSafeImageKey(key) {
			t.Errorf("应放行 %q", key)
		}
	}

	bad := []string{
		"",
		"u/alice/../../etc/passwd",
		"u/alice//" + hexA + ".png",
		"../" + hexA + ".png",
		"u/alice/" + hexA + ".svg",
		"u/alice/" + hexA + ".exe",
		"u/alice/short.png",
		"alice/" + hexA + ".png",
		"/u/alice/" + hexA + ".png",
		"u/alice/" + hexA + ".png/extra",
		"u/alice/" + hexA + ".PNG",
		"u/" + strings.Repeat("x", 200) + "/" + hexA + ".png",
		"u/alice/" + hexA + ".png\n",
	}
	for _, key := range bad {
		if isSafeImageKey(key) {
			t.Errorf("应拒绝 %q", key)
		}
	}
}
