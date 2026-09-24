package server

import (
	"html"
	"regexp"
	"strconv"
	"strings"
)

// 与 Markdown-it 的 unescapeAll 一样只解码一遍，不能把 \\&colon;
// 或 &amp;colon; 二次解码成冒号，否则会改变链接是否有效的判断。
var shareURLUnescape = regexp.MustCompile(`\\[[:punct:]]|&[a-zA-Z#][a-zA-Z0-9]{1,31};`)

func shareAllowedLinkDestination(source []byte) bool {
	value := string(source)
	if strings.ContainsAny(value, `\&`) {
		value = shareURLUnescape.ReplaceAllStringFunc(value, func(match string) string {
			if match[0] == '\\' {
				return match[1:]
			}
			if match[1] == '#' {
				digits, base := match[2:len(match)-1], 10
				if len(digits) > 0 && (digits[0] == 'x' || digits[0] == 'X') {
					digits, base = digits[1:], 16
				}
				if code, err := strconv.ParseUint(digits, base, 32); err == nil && len(digits) <= 8 {
					if code <= 8 || code == 11 || code >= 14 && code <= 31 || code >= 127 && code <= 159 ||
						code >= 0xd800 && code <= 0xdfff || code >= 0xfdd0 && code <= 0xfdef ||
						code&0xffff >= 0xfffe || code > 0x10ffff {
						return match
					}
					return string(rune(code))
				}
			}
			return html.UnescapeString(match)
		})
	}
	// mdurl 在编码之前按 JavaScript trim 规则去掉两端空白；其余字符
	// 的 URL 编码不会改变下面这些 ASCII 协议前缀。
	value = strings.Trim(value, " \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff")
	// 非 ASCII 字符会先被 URL 编码，不能把 İ 等字符转成 ASCII 协议字母。
	prefix := []byte(value[:min(len(value), len("data:image/jpeg;"))])
	for i, letter := range prefix {
		if letter >= 'A' && letter <= 'Z' {
			prefix[i] += 'a' - 'A'
		}
	}
	value = string(prefix)
	for _, scheme := range []string{"javascript:", "vbscript:", "file:", "data:"} {
		if strings.HasPrefix(value, scheme) {
			for _, image := range []string{"gif", "png", "jpeg", "webp"} {
				if strings.HasPrefix(value, "data:image/"+image+";") {
					return true
				}
			}
			return false
		}
	}
	return true
}
