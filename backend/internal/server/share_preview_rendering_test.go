package server

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// 这些用例同时交给 Go 和前端 Markdown 解析器，避免仅比较源码而漏掉链接语义变化。
func TestSharePreviewRendering(t *testing.T) {
	type fixture struct {
		name, use, want string
		outerLinks      int
	}
	cases := []fixture{
		{"explicit image", "[outer ![alt][img]](/outer)", "[outer alt](/outer)", 1},
		{"linked badge", "[![badge][img]](/outer)", "[badge](/outer)", 1},
		{"collapsed image", "[outer ![img][]](/outer)", "[outer img](/outer)", 1},
		{"shortcut image", "[outer ![img]](/outer)", "[outer img](/outer)", 1},
		{"reference around image", "[outer ![alt][img]][visible]", "[outer alt][visible]", 1},
		{"adjacent reference", "[outer ![alt][img]](/outer) [x]", "[outer alt](/outer) x", 1},
		{"multiline image id", "[outer ![alt][two\nline]](/outer)", "[outer alt](/outer)", 1},
		{"failed image", "![x](broken", "!x(broken", 0},
		{"failed image in link", "[outer ![x](broken](/outer)", "outer !x(broken (/outer)", 0},
		{"failed image angle", "[outer ![x](<broken](/outer)", "outer !x(<broken (/outer)", 0},
		{"failed image title", "[outer ![x](url \"broken](/outer)", "outer !x(url \"broken (/outer)", 0},
		{"failed image adjacent link", "![x](broken [good](/outer)", "!x(broken [good](/outer)", 1},
		{"valid inline image", "[outer ![x](/image.png)](/outer)", "[outer ![x](/image.png)](/outer)", 1},
		{"colon suffix", "See [x]: note", "See x: note", 0},
		{"colon in link", "[outer [x]: note](/outer)", "outer x: note (/outer)", 0},
		{"colon after image", "[outer ![img]: note](/outer)", "[outer img: note](/outer)", 1},
		{"incomplete suffix", "See [x][broken", "See x[broken", 0},
		{"empty incomplete suffix", "See [x][", "See x[", 0},
		{"nested incomplete suffix", "See [x][[broken", "See x[[broken", 0},
		{"incomplete image suffix", "See ![img][broken", "See img[broken", 0},
		{"suffix across paragraph", "See [x][broken\n\nmore", "See x[broken\n\nmore", 0},
		{"complete undefined suffix", "See [x][unknown]", "See [x][unknown]", 0},
		{"complete nested suffix", "See [x][[closed]]", "See [x][[closed]]", 0},
		{"escaped closing bracket", `See [x][broken\]`, `See x[broken\]`, 0},
		{"escaped image", `[outer \![x](broken](/outer)`, `outer \!x(broken (/outer)`, 0},
		{"code brackets in suffix", "[outer [x][`[[`]](/outer)", "[outer [x][`[[`]](/outer)", 1},
		{"code bracket in suffix", "[x][`[`]", "[x][`[`]", 0},
		{"code closing brackets", "[outer [x][`]]`]](/outer)", "[outer [x][`]]`]](/outer)", 1},
		{"unclosed suffix after code", "[x][`[[`", "x[`[[`", 0},
		{"reference in inline image alt", "[outer ![alt [x]](/image.png)](/outer)", "[outer ![alt x](/image.png)](/outer)", 1},
		{"reference in hidden image alt", "[outer ![alt [x]][img]](/outer)", "[outer alt x](/outer)", 1},
		{"reference outside image", "[outer ![alt [x]](/image.png)][visible]", "[outer ![alt x](/image.png)][visible]", 1},
		{"visible reference in hidden image", "[outer ![alt [visible]][img]](/outer)", "[outer alt visible](/outer)", 1},
		{"inline link in hidden image", "[outer ![alt [x](/inner)][img]](/outer)", "[outer alt x](/outer)", 1},
		{"inline image in hidden image", "[outer ![alt ![x](/image.png)][img]](/outer)", "[outer alt x](/outer)", 1},
		{"autolink in hidden image", "[outer ![alt <https://example.com>][img]](/outer)", "[outer alt https://example.com](/outer)", 1},
		{"visible reference in visible image", "[outer ![alt [visible]](/image.png)](/outer)", "[outer ![alt [visible]](/image.png)](/outer)", 1},
		{"quote multiline title", "> [x](/outer\n> \"title\")", "> [x](/outer\n> \"title\")", 1},
		{"quote multiline destination", "> [x](\n> /outer)", "> [x](\n> /outer)", 1},
		{"quote multiline image", "> ![x](/image.png\n> \"title\")", "> ![x](/image.png\n> \"title\")", 0},
		{"nested quote inline", "> > [x](/outer\n> > \"title\")", "> > [x](/outer\n> > \"title\")", 1},
		{"quote list inline", "> - [x](\n>   /outer\n>   )", "> - [x](\n>   /outer\n>   )", 1},
		{"lazy quote inline", "> [x](/outer\n\"title\")", "> [x](/outer\n\"title\")", 1},
		{"list inline title", "- [x](/outer\n  \"title\")", "- [x](/outer\n  \"title\")", 1},
	}
	for _, destination := range []string{
		`/bad\ url`, "javascript:bad", "JaVaScRiPt:bad", `javascript\:bad`,
		"&#106;avascript:bad", "javascript&colon;bad", "< javascript:bad >", "<javascript:bad>",
		"vbscript:bad", "file:///tmp/file", "data:text/plain,bad", "data:image/svg+xml;bad",
		"/bad\x01url", "a" + strings.Repeat("(", 33) + "b" + strings.Repeat(")", 33),
		`<url>"title"`,
	} {
		for _, marker := range []string{"", "!"} {
			cases = append(cases, fixture{
				name: "rejected destination " + marker + destination,
				use:  "[outer " + marker + "[x](" + destination + ")](/outer)",
				want: "outer " + marker + "x(" + destination + ") (/outer)",
			})
		}
	}
	type renderingCase struct {
		Name, Source, Preview string
		OuterLinks            int
		Hidden                bool
		Expected              *string
	}
	var rendering []renderingCase
	prefix := "[visible]: /outer\n\n"
	definitions := "[x]: /hidden\n[img]: /hidden.png\n[two line]: /hidden.png\n"
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			source := prefix + tc.use + "\n\n" + strings.Repeat("后", 200) + "\n\n" + definitions
			preview := sharePreview(source)
			if !strings.HasPrefix(preview, prefix+tc.want) || strings.Contains(preview, "/hidden") {
				t.Fatalf("preview=%q; want prefix=%q", preview, prefix+tc.want)
			}
			rendering = append(rendering, renderingCase{tc.name, source, preview, tc.outerLinks, true, nil})
			visible := definitions + prefix + tc.use + "\n\n" + strings.Repeat("后", 200)
			visiblePreview := sharePreview(visible)
			if !strings.HasPrefix(visiblePreview, definitions+prefix+tc.use) {
				t.Fatalf("visible definitions must preserve the original Markdown: %q", visiblePreview)
			}
			rendering = append(rendering, renderingCase{tc.name + " visible", visible, visiblePreview, 0, false, nil})
		})
	}
	check := func(name, source, want string) {
		t.Helper()
		preview := sharePreview(source)
		if got := strings.TrimSpace(strings.ReplaceAll(preview, "后", "")); got != strings.TrimSpace(want) {
			t.Errorf("%s: preview=%q want=%q", name, got, want)
		}
		rendering = append(rendering, renderingCase{Name: name, Source: source, Preview: preview, Expected: &want})
	}
	padding := "\n\n" + strings.Repeat("后", 300) + "\n\n"
	for _, destination := range []string{
		"javascript:bad", "file:///tmp/image.png", "data:text/plain,bad", "data:image/svg+xml;bad",
		`javascript\:bad`, "&#106;avascript:bad", "< javascript:bad >", `/bad\ url`,
	} {
		invalid := "[x]: " + destination
		use := "[outer [x]](/outer)"
		check("hidden rejected definition "+destination, use+padding+invalid, use)
		check("visible rejected definition "+destination, invalid+"\n\n"+use+padding, invalid+"\n\n"+use)
		imageDefinition := "[img]: " + destination
		check("rejected image scope "+destination, imageDefinition+"\n\n[outer ![alt [x]][img]](/outer)"+padding+"[x]: /hidden",
			imageDefinition+"\n\nouter ![alt x][img] (/outer)")
	}
	invalid, valid, use := "[x]: javascript:bad", "[x]: /outer", "[outer [x]](/outer)"
	check("rejected duplicate before hidden valid", invalid+"\n\n"+use+padding+valid, "x: javascript:bad\n\nouter x (/outer)")
	check("rejected duplicate before visible valid", invalid+"\n\n"+valid+"\n\n[x]"+padding, invalid+"\n\n"+valid+"\n\n[x]")
	check("valid duplicate before rejected", valid+"\n\n"+invalid+"\n\n[x]"+padding, valid+"\n\n"+invalid+"\n\n[x]")
	check("reference cannot interrupt rejected paragraph", invalid+"\n"+valid+"\n\n"+use+padding, invalid+"\n"+valid+"\n\n"+use)
	check("rejected definition inside quote", "> "+invalid+"\n>\n> "+use+padding, "> "+invalid+"\n>\n> "+use)
	check("quote long destination cutoff", "> [x](\n> https://example.com/"+strings.Repeat("path/", 30)+"\n> \"title\")\n\nending", ">")
	check("rejected definition cut before protocol colon", "[x]\n\n[x]: javascript:bad", "[x]")
	for _, tc := range []struct{ name, use, definition, want string }{
		{"definition after code", "[outer [y]](/outer)", "[x]: /dummy\n    code\n[y]: /hidden", "outer y (/outer)"},
		{"code is not a definition", "[outer [y]](/outer)", "[x]: /dummy\n    [y]: /code\n---", "[outer [y]](/outer)"},
		{"empty title trailing text", "[outer [x]](/outer)", "[x]: /target\n '' trailing", "[outer [x]](/outer)"},
		{"escaped newline in reference address", "[outer [x]](/outer)", "[x]: <a\\\nb>", "[outer [x]](/outer)"},
	} {
		check(tc.name, tc.use+padding+tc.definition, tc.want)
		check(tc.name+" visible", tc.definition+"\n\n"+tc.use+padding, tc.definition+"\n\n"+tc.use)
	}
	// npm run test:share-preview 请求真实后端输出，普通 Go 测试无需 Node 环境。
	if output := os.Getenv("KOINOTE_SHARE_PREVIEW_FIXTURES"); output != "" {
		data, err := json.Marshal(rendering)
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(output, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestSharePreviewReferenceUseBoundaries(t *testing.T) {
	for _, use := range []string{"![alt][img]", "![img][]", "![img]", "[x]: note", "[x][broken", "[x][[broken", "![x](broken"} {
		source := []byte(use + " more " + strings.Repeat("后", 100) + "\n\n[x]: /hidden\n[img]: /hidden.png")
		start, stop := 0, strings.Index(use, "]")+1
		if strings.HasPrefix(use, "![x](") {
			start = 1
		}
		if use == "![alt][img]" || use == "![img][]" {
			stop = len(use)
		}
		for cutoff := start + 1; cutoff < stop; cutoff++ {
			if got := shareReadableReferences(source, cutoff, nil); got != use[:start] {
				t.Fatalf("cut inside %q at %d: got=%q want=%q", use, cutoff, got, use[:start])
			}
		}
	}
}
