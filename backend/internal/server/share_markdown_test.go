package server

import (
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

// 地址扫描优化单独与原版 Goldmark 对照；预览的引用规则另与前端对照。
var shareMarkdownParser = newShareMarkdownParser()

func assertShareMarkdownMatchesDefault(t *testing.T, source []byte) {
	t.Helper()
	wantContext, gotContext := parser.NewContext(), parser.NewContext()
	want := goldmark.DefaultParser().Parse(text.NewReader(source), parser.WithContext(wantContext))
	got := shareMarkdownParser.Parse(text.NewReader(source), parser.WithContext(gotContext))
	// 比较 AST 的结构及源码坐标，避免优化改变代码区间或引用回退语义。
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("AST changed for %q", source)
	}
	if len(gotContext.References()) != len(wantContext.References()) {
		t.Fatalf("reference count changed for %q", source)
	}
	for _, reference := range wantContext.References() {
		gotReference, ok := gotContext.Reference(util.ToLinkReference(reference.Label()))
		if !ok || !reflect.DeepEqual(gotReference, reference) {
			t.Fatalf("reference %q changed for %q", reference.Label(), source)
		}
	}
}

func TestShareMarkdownPreservesGoldmarkSemantics(t *testing.T) {
	for i, fragment := range []string{
		"[x](<missing ",
		"[x](<missing \\> ",
		"[x](<ok>)",
		"[x](<escaped\\>still-url>)",
		"[x](<backslash\\\\>)",
		"[x](<url> \"title\")",
		"[x](<url> (title))",
		"[x](<url> invalid)",
		"[x](<url> \"unclosed title",
		"[x](\n<url>\n\"title\"\n)",
		"![outer [x]](<url>)",
		"[outer `[x](<missing` **[x]**](<url>)",
		"[x](<one [x](<two> invalid)",
		"[x](<one [x](<two> \"valid\")",
		"[x](url[x](url",
		"[x](url[x](url invalid)",
		"[x](url[x](url \"title\")",
		"[x](url[x](url\n\"title\")",
		"[x](url\\(escaped\\)path)",
		"[x](url\\\\(nested)tail)",
		"[x](url[x](url)tail)",
	} {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			t.Parallel()
			for _, format := range []string{"%s", "> %s", "- %s", "# %s", "`%s`", "```md\n%s\n```"} {
				for _, definition := range []string{"", "\n\n[x]: /hidden"} {
					source := []byte(fmt.Sprintf(format, fragment+" "+fragment) + definition)
					assertShareMarkdownMatchesDefault(t, source)
				}
			}
		})
	}
}

type shareCountingLinkParser struct {
	parser.InlineParser
	bytes *int
}

func (p shareCountingLinkParser) Parse(parent ast.Node, block text.Reader, pc parser.Context) ast.Node {
	_, position := block.Position()
	return p.InlineParser.Parse(parent, shareCountingLinkReader{Reader: block, bytes: p.bytes, start: position.Start}, pc)
}

func (p shareCountingLinkParser) CloseBlock(parent ast.Node, block text.Reader, pc parser.Context) {
	p.InlineParser.(parser.CloseBlocker).CloseBlock(parent, block, pc)
}

type shareCountingLinkReader struct {
	text.Reader
	bytes *int
	start int
}

func (r shareCountingLinkReader) PeekLine() ([]byte, text.Segment) {
	line, segment := r.Reader.PeekLine()
	if segment.Start > r.start && len(line) > 0 {
		// 统计 Goldmark 实际可能扫描的地址字符，不把标签后的整行算入。
		if line[0] == '<' {
			*r.bytes += len(line)
		} else {
			depth := 0
			for i := 0; i < len(line); i++ {
				*r.bytes += 1
				if line[i] == '\\' && i+1 < len(line) && util.IsPunct(line[i+1]) {
					i++
				} else if line[i] == '(' {
					depth++
				} else if line[i] == ')' {
					depth--
					if depth < 0 {
						break
					}
				} else if util.IsSpace(line[i]) {
					break
				}
			}
		}
	}
	return line, segment
}

func TestShareMarkdownBoundsRepeatedDestinationScans(t *testing.T) {
	for _, tc := range []struct {
		pattern string
		tails   []string
	}{
		{"[x](<url ", []string{"", "\\>", "> invalid)", "> \"unclosed", ">)"}},
		{"[x](url", []string{"", " invalid)", " \"unclosed", " \"title\")", "\n\"title\")"}},
		{"[x](url\\(path", []string{"", " invalid)", " \"unclosed"}},
	} {
		for _, tail := range tc.tails {
			source := []byte(strings.Repeat(tc.pattern, 25_600) + tail + "\n\n[x]: /hidden")
			var scanned int
			inlines := parser.DefaultInlineParsers()
			for i, inline := range inlines {
				if inline.Value == parser.NewLinkParser() {
					inlines[i].Value = shareLinkParser{InlineParser: shareCountingLinkParser{
						InlineParser: parser.NewLinkParser(), bytes: &scanned,
					}}
				}
			}
			p := parser.NewParser(
				parser.WithBlockParsers(parser.DefaultBlockParsers()...),
				parser.WithInlineParsers(inlines...),
				parser.WithParagraphTransformers(parser.DefaultParagraphTransformers()...),
			)
			p.Parse(text.NewReader(source))
			if scanned > 2*len(source) {
				t.Fatalf("repeated destination scans must stay linear: pattern=%q tail=%q source=%d scanned=%d", tc.pattern, tail, len(source), scanned)
			}
		}
	}
}

func FuzzShareMarkdownPreservesGoldmarkSemantics(f *testing.F) {
	for _, seed := range []string{
		"[x](<url [x](<url ",
		"[x](<url [x](<url> invalid)\n\n[x]: /hidden",
		"[x](<url\\> still url>) `[x](<code`\n\n[x]: /hidden",
		"> [x](\n> <url>\n> \"title\")",
		"[x](url[x](url invalid)\n\n[x]: /hidden",
		"[x](url[x](url \"title\")\n\n[x]: /hidden",
		"[x](url\\(a) [x](url\\\\(b)\n\n[x]: /hidden",
	} {
		f.Add([]byte(seed))
	}
	f.Fuzz(func(t *testing.T, source []byte) {
		if len(source) > 4096 {
			t.Skip()
		}
		assertShareMarkdownMatchesDefault(t, source)
	})
}

func TestSharePreviewPreservesLongReferenceLabels(t *testing.T) {
	for _, label := range []string{
		strings.Repeat("x", 999), strings.Repeat("x", 1000),
		strings.Repeat("文", 1000), `escaped\[brackets\]`,
	} {
		for _, use := range []string{"[" + label + "]", "[" + label + "][]", "[link][" + label + "]"} {
			content := use + " more " + strings.Repeat("后", 4000) + "\n\n[" + label + "]: /hidden"
			preview := sharePreview(content)
			if strings.Contains(preview, "/hidden") {
				t.Fatal("hidden reference leaked")
			}
			if strings.Contains(preview, use) {
				t.Fatalf("long or escaped reference should keep readable text: label=%q preview=%q", label, preview)
			}
		}
	}
	label := strings.Repeat("文", 1000)
	if got := sharePreview("[" + label + "][id] more " + strings.Repeat("后", 4000) + "\n\n[id]: /hidden"); !strings.HasPrefix(got, label+" more") {
		t.Fatal("long link text with a short reference label must stay readable")
	}
}

func BenchmarkSharePreviewBareAndNestedReferences(b *testing.B) {
	for _, count := range []int{6400, 12800, 25600} {
		for name, content := range map[string]string{
			"bare":   strings.Repeat("[x](url", count) + "\n\n[x]: /hidden",
			"nested": strings.Repeat("[", count) + "x" + strings.Repeat("]", count) + "\n\n[x]: /hidden",
		} {
			b.Run(fmt.Sprintf("%s/%d", name, count), func(b *testing.B) {
				b.SetBytes(int64(len(content)))
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					_ = sharePreview(content)
				}
			})
		}
	}
}

func BenchmarkSharePreviewAngleDestinations(b *testing.B) {
	for _, count := range []int{6400, 12800, 25600} {
		for name, tail := range map[string]string{"unclosed": "", "escaped_closer": "\\>", "invalid_tail": "> invalid)"} {
			b.Run(fmt.Sprintf("%s/%d", name, count), func(b *testing.B) {
				content := strings.Repeat("[x](<url ", count) + tail + "\n\n[x]: /hidden"
				b.SetBytes(int64(len(content)))
				b.ResetTimer()
				for i := 0; i < b.N; i++ {
					_ = sharePreview(content)
				}
			})
		}
	}
}
