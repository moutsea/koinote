package server

import (
	"regexp"
	"strings"
)

// 从正文里认出图床对象。
//
// 正文是 Markdown，图片写成 ![alt](url)。url 有两种形态：
//   - 配了自定义域名：https://img.koinote.app/u/<authUserId>/<hex>.png
//   - 回落到 Worker 代理：/images/u/<authUserId>/<hex>.png
//
// 两种都以 /u/<authUserId>/<hex>.<ext> 结尾，所以直接认这一段，不必知道对外基址是
// 什么 —— 后端本来也读不到 Worker 的 IMAGE_PUBLIC_BASE。
//
// 顺带也能认出裸写在 HTML <img src> 里的地址：正则不依赖 Markdown 的括号结构。

// imageKeyPattern 匹配 u/<id>/<hex>.<ext>。
//
// hex 至少 8 位是为了不把随便一个 /u/xxx/yyy.png 的站外地址当成自己的对象。真正的
// 归属判断靠下面的 authUserId 前缀比对，这里只是先筛出形状对的。
var imageKeyPattern = regexp.MustCompile(`u/([A-Za-z0-9_-]{1,128})/([0-9a-f]{8,64})\.(png|jpg|gif|webp)`)

// extractOwnedImageKeys 从正文里抽出属于 authUserID 的图床对象 key，去重。
//
// 只返回前缀是自己 authUserId 的 key —— 这条是安全边界，不是优化。少了它，
// 在自己的文档里写上别人的图片地址、再把文档删掉，就能删掉别人的图。
func extractOwnedImageKeys(content, authUserID string) []string {
	if content == "" || authUserID == "" {
		return nil
	}

	seen := make(map[string]struct{})
	var keys []string
	for _, match := range imageKeyPattern.FindAllStringSubmatch(content, -1) {
		owner, hex, ext := match[1], match[2], match[3]
		// 归属：前缀必须严格等于当前用户。用 == 而不是 HasPrefix ——
		// 后者会让 authUserId 为 "abc" 的人匹配到 "abcd" 的对象
		if owner != authUserID {
			continue
		}
		key := "u/" + owner + "/" + hex + "." + ext
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		keys = append(keys, key)
	}
	return keys
}

// safeImageKeyPattern 是整串锚定的版本，用于入队前的形状兜底。
var safeImageKeyPattern = regexp.MustCompile(
	`^u/[A-Za-z0-9_-]{1,128}/[0-9a-f]{8,64}\.(png|jpg|gif|webp)$`,
)

// isSafeImageKey 与 Worker 侧 images.ts 的同名函数保持一致。
func isSafeImageKey(key string) bool {
	if key == "" || len(key) > 256 {
		return false
	}
	if strings.Contains(key, "..") || strings.Contains(key, "//") {
		return false
	}
	return safeImageKeyPattern.MatchString(key)
}
