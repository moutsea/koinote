package server

import (
	"fmt"
	"strings"
	"testing"

	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
)

func TestSharePreviewAdjacentMalformedLinks(t *testing.T) {
	for _, prefix := range []string{
		"[bad](unfinished", "[bad](<oops", "[bad](url (oops",
		"[bad](unfinished[x](unfinished", "[bad](<oops\\>",
	} {
		for _, link := range []string{
			"[good](https://visible.example/[x])",
			"![good](https://visible.example/[x])",
			"[good](<https://visible.example/[x]>)",
			"[good](https://visible.example/(nested)/[x] \"title\")",
		} {
			t.Run(prefix+link, func(t *testing.T) {
				content := prefix + link + " " + strings.Repeat("后", 150) + "\n\n[x]: /hidden"
				preview := sharePreview(content)
				if !strings.Contains(preview, link) || strings.Contains(preview, "/hidden") {
					t.Fatalf("adjacent valid link must retain its destination: %q", preview)
				}
				source := []byte(content)
				cutoff := strings.Index(content, "visible")
				if got := shareSafeInlineCutoff(source, cutoff, shareRawMarkdownRanges(source)); got != len(prefix) {
					t.Fatalf("cutoff inside the adjacent link: got=%d want=%d", got, len(prefix))
				}
			})
		}
	}
}

func TestSharePreviewManyAdjacentMalformedLinks(t *testing.T) {
	link := "[good](https://visible.example/[x])"
	for _, pattern := range []string{"[bad](unfinished", "[bad](<oops"} {
		prefix := strings.Repeat(pattern, 10_000)
		content := prefix + link + strings.Repeat("后", len(prefix)+2*len(link)) + "\n\n[x]: /hidden"
		if got := sharePreview(content); !strings.Contains(got, link) {
			t.Fatal("a long run of malformed links must not skip the valid adjacent link")
		}
	}
}

func TestSharePreviewRejectsTruncatedReferenceDefinitions(t *testing.T) {
	for _, use := range []string{"[label][id]", "![label][id]", "[id][]", "![id]", "[id]"} {
		for _, destination := range []string{
			"https://example.com/" + strings.Repeat("long-path/", 10) + "image.png",
			"<https://example.com/" + strings.Repeat("long-path/", 10) + "image.png>",
		} {
			for _, format := range []string{
				"[id]: %s",
				"[id]: %s \"a long title\"",
				"[id]:\n  %s\n  \"a long\ntitle\"",
				"[id]: %s\n  \"a long\ntitle\"",
			} {
				content := use + "\n\n" + fmt.Sprintf(format, destination)
				source := []byte(content)
				raw := shareRawMarkdownRanges(source)
				// 检查地址及标题中的每个截断位置，包括地址已经完整但标题尚未完整。
				for end := strings.Index(content, "https") + 1; end < len(content); end++ {
					preview := shareReadableReferences(source, end, raw)
					if strings.HasPrefix(preview, "[") || strings.HasPrefix(preview, "![") {
						t.Fatalf("truncated definition retained reference markup: end=%d preview=%q", end, preview)
					}
					if strings.Contains(preview, "https:") || strings.Contains(preview, "[id]:") {
						t.Fatalf("partial definition could become an automatic link: %q", preview)
					}
					root := shareMarkdownParser.Parse(text.NewReader([]byte(preview)))
					_ = ast.Walk(root, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
						if entering && (node.Kind() == ast.KindLink || node.Kind() == ast.KindImage) {
							t.Fatalf("truncated definition produced a link/image: end=%d preview=%q", end, preview)
						}
						return ast.WalkContinue, nil
					})
				}
				if got := shareReadableReferences(source, len(source), raw); got != content {
					t.Fatalf("complete definition must stay intact: %q", got)
				}
				if got := sharePreview(content); strings.HasPrefix(got, "[") || strings.HasPrefix(got, "![") {
					t.Fatalf("half preview retained a truncated definition: %q", got)
				}
			}
		}
	}
}

func TestSharePreviewMultilineReferenceLabels(t *testing.T) {
	for _, newline := range []string{"\n", "\r\n", "\n  "} {
		for _, label := range []string{"two" + newline + "line", "two\\[part\\]" + newline + "line"} {
			definition := "[" + strings.ReplaceAll(strings.ReplaceAll(label, "\r", ""), "\n", " ") + "]: /target"
			for _, marker := range []string{"", "!"} {
				use := marker + "[label][" + label + "]"
				content := use + " more " + strings.Repeat("后", 100) + "\n\n" + definition
				if got := sharePreview(content); !strings.HasPrefix(got, "label more ") || strings.Contains(got, "/target") {
					t.Fatalf("multiline reference must become readable text: %q", got)
				}
				source := []byte(content)
				for end := 1; end < len(use); end++ {
					if got := shareReadableReferences(source, end, nil); got != "" {
						t.Fatalf("cutoff inside multiline reference must retreat: end=%d got=%q", end, got)
					}
				}
				visible := definition + "\n\n" + use + " " + strings.Repeat("后", 100)
				if got := sharePreview(visible); !strings.Contains(got, use) {
					t.Fatalf("visible multiline reference must stay intact: %q", got)
				}
			}
		}
	}
	content := "[label][two\n\nline] " + strings.Repeat("后", 100) + "\n\n[two line]: /hidden"
	if got := sharePreview(content); !strings.HasPrefix(got, "[label][two\n\nline]") {
		t.Fatalf("blank lines must still break reference labels: %q", got)
	}
}

func TestSharePreviewEscapedImageMarkers(t *testing.T) {
	for count := 0; count <= 5; count++ {
		escapes := strings.Repeat(`\`, count)
		use := escapes + "![x]"
		plain := escapes + "x"
		if count%2 == 1 {
			plain = escapes + "!x"
		}
		for _, wrap := range []bool{false, true} {
			input, want := use, plain
			if wrap {
				input = "[outer " + use + "](/outer)"
				if count%2 == 1 {
					want = "outer " + plain + " (/outer)"
				} else {
					want = "[outer " + plain + "](/outer)"
				}
			}
			content := input + " more " + strings.Repeat("后", 150) + "\n\n[x]: /hidden"
			if got := sharePreview(content); !strings.HasPrefix(got, want+" more ") {
				t.Fatalf("escaped image marker changed: count=%d wrap=%t got=%q want=%q", count, wrap, got, want)
			}
			visible := "[x]: /visible\n\n" + input + " more " + strings.Repeat("后", 150)
			if got := sharePreview(visible); !strings.Contains(got, input+" more ") {
				t.Fatalf("visible reference must retain original escape sequence: %q", got)
			}
		}
	}
	content := "[visible]: /outer\n\n[outer \\![x]][visible] more " + strings.Repeat("后", 150) + "\n\n[x]: /hidden"
	if got := sharePreview(content); !strings.Contains(got, "\nouter \\!x more ") {
		t.Fatalf("escaped ! must not activate an outer reference link: %q", got)
	}
}

func TestSharePreviewMalformedInlineFallsBackToReference(t *testing.T) {
	for _, tc := range []struct{ use, want string }{
		{"[x](broken", "x(broken"},
		{"[outer [x](broken](/outer)", "outer x(broken (/outer)"},
		{"[outer [x](<broken](/outer)", "outer x(<broken (/outer)"},
		{"[outer [x](url (nested(title))](/outer)", "outer x(url (nested(title)) (/outer)"},
		{"[outer [x](url \"unclosed](/outer)", "outer x(url \"unclosed (/outer)"},
		{"[outer [x](broken][visible]", "outer x(broken"},
		{"[x](broken [good](https://visible.example/[x])", "x(broken [good](https://visible.example/[x])"},
		{"[x](https://visible.example/[x])", "[x](https://visible.example/[x])"},
	} {
		prefix := "[visible]: /outer\n\n"
		content := prefix + tc.use + " more " + strings.Repeat("后", 150) + "\n\n[x]: /hidden"
		if got := sharePreview(content); !strings.HasPrefix(got, prefix+tc.want+" more ") || strings.Contains(got, "/hidden") {
			t.Fatalf("failed inline link must fall back to its reference: use=%q got=%q", tc.use, got)
		}
		visible := "[x]: /visible\n" + prefix + tc.use + " more " + strings.Repeat("后", 150)
		if got := sharePreview(visible); !strings.Contains(got, tc.use+" more ") {
			t.Fatalf("fallback with a visible definition must stay intact: %q", got)
		}
	}
}

func TestSharePreviewMultilineReferencesInContainers(t *testing.T) {
	for _, tc := range []struct{ first, next string }{
		{"> ", "> "}, {"> ", ""}, {"> > ", "> > "},
		{"- ", "  "}, {"1. ", "   "}, {"> - ", ">   "},
		{"- > ", "  > "}, {"> 1. ", ">    "},
	} {
		for _, newline := range []string{"\n", "\r\n"} {
			for _, marker := range []string{"", "!"} {
				for _, label := range []string{"two", `two\>part`, `two\[part\]`} {
					key := label + newline + tc.next + "line"
					use := tc.first + marker + "[label][" + key + "]"
					definition := "[" + label + " line]: /hidden"
					content := use + " more\n\n" + strings.Repeat("后", 150) + "\n\n" + definition
					if got := sharePreview(content); !strings.HasPrefix(got, tc.first+"label more\n") || strings.Contains(got, "/hidden") {
						t.Fatalf("container prefix must not become part of a reference label: use=%q got=%q", use, got)
					}
					visible := definition + "\n\n" + use + " more\n\n" + strings.Repeat("后", 150)
					if got := sharePreview(visible); !strings.Contains(got, use+" more") {
						t.Fatalf("visible container reference must stay intact: %q", got)
					}
					source := []byte(content)
					for end := len(tc.first) + 1; end < len(use); end++ {
						if got := shareReadableReferences(source, end, nil); got != tc.first {
							t.Fatalf("container reference must not be cut in half: use=%q end=%d got=%q", use, end, got)
						}
					}
				}
			}
		}
	}
	for _, use := range []string{
		"[label][two\n> line]", "> [label][two\n>\n> line]",
		"> [label][two\n> > line]", "[label][two\n\nline]",
	} {
		content := use + " more\n\n" + strings.Repeat("后", 150) + "\n\n[two line]: /hidden"
		if got := sharePreview(content); !strings.HasPrefix(got, use+" more") {
			t.Fatalf("labels cannot cross actual block boundaries: %q", got)
		}
	}
}

func TestSharePreviewDenseImagesKeepDestinations(t *testing.T) {
	image := "![x](https://visible.example/image.png)"
	content := "[ref] " + strings.Repeat(image+" <i>x</i> ", 2000) + "\n\n[ref]: /hidden"
	preview := sharePreview(content)
	if !strings.HasPrefix(preview, "ref "+image) || strings.Contains(preview, "/hidden") {
		t.Fatalf("dense images changed their content: %.150s", preview)
	}
	if got := strings.Count(preview, image); got < 990 || got > 1001 {
		t.Fatalf("expected roughly half the images, got %d", got)
	}
}

func BenchmarkSharePreviewDenseImages(b *testing.B) {
	for _, count := range []int{16000, 32000, 60000} {
		b.Run(fmt.Sprint(count), func(b *testing.B) {
			content := "[ref] " + strings.Repeat("![x](a) <i>x</i> ", count) + "\n\n[ref]: /hidden"
			b.SetBytes(int64(len(content)))
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				_ = sharePreview(content)
			}
		})
	}
}
