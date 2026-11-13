package server

import (
	"strings"
	"testing"
)

func TestAgentReplyRedaction(t *testing.T) {
	for _, tc := range []struct{ name, input, want string }{
		{"titles", "三个标题：\n1. 山间来信\n2. 云南慢行\n3. 把日子写成诗", "三个标题：\n1. 山间来信\n2. 云南慢行\n3. 把日子写成诗"},
		{"markdown", "[封面下载](https://example.test/cover.jpg)\n标题建议", "[封面下载](https://example.test/cover.jpg)\n标题建议"},
		{"fields", "标题建议\napi_key=private-value; token: \"private-token\"\n下一段", "标题建议\napi_key=[redacted]; token: \"[redacted]\"\n下一段"},
		{"header", "Authorization: Bearer private-value\n continued-value\n\n标题建议", "Authorization: [redacted]\n\n标题建议"},
		{"json", `{"apiKey":"private-value","title":"山间来信","totalTokens":12}`, `{"apiKey":"[redacted]","title":"山间来信","totalTokens":12}`},
		{"nested-json", `{"reply":"{\"secret\":\"private-value\"}"}`, `{"reply":"{\"secret\":\"[redacted]\"}"}`},
		{"header-tuples", `[["Authorization","private-value"],["Content-Type","text/plain"]]`, `[["Authorization","[redacted]"],["Content-Type","text/plain"]]`},
		{"named-header", `{"name":"Cookie","value":"private-value"}`, `{"name":"Cookie","value":"[redacted]"}`},
		{"incomplete-json", `{"title":"山间来信","token":"private-value`, "[redacted]"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := redactAgentReply(tc.input); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
	long := strings.Repeat("文", 45000) + ` token: "private-value"`
	if got := writingDisplayResult(redactAgentReply(long)); strings.Contains(got, "private-value") || !strings.HasSuffix(got, writingResultClipped) {
		t.Fatal("long reply must be redacted before display clipping")
	}
}
