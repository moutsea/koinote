package server

import (
	"strings"
	"testing"
)

func TestShareInlineContainerBoundaries(t *testing.T) {
	for _, use := range []string{
		"> [x](\n> /outer)",
		"> [x](/outer\n> \"title\")",
		"> [x](\n> </outer>\n> 'multi\n> line title'\n> )",
		"> ![x](/image.png\n> (title))",
		"> > [x](\n> > /outer\n> > \"title\")",
		"> - [x](\n>   /outer\n>   )",
		"- [x](\n  /outer\n  \"title\")",
		"> [x](/outer\n\"lazy continuation\")",
		"> [x](\r\n> /outer\r\n> \"title\")",
	} {
		t.Run(use, func(t *testing.T) {
			start := strings.Index(use, "[x]")
			if use[start-1] == '!' {
				start--
			}
			source := []byte(use + "\n\n" + strings.Repeat("后", 100) + "\n\n[x]: /hidden")
			for cutoff := start + 1; cutoff < len(use); cutoff++ {
				if got := shareSafeInlineCutoff(source, cutoff, shareRawMarkdownRanges(source)); got != start {
					t.Fatalf("cutoff=%d got=%d want=%d", cutoff, got, start)
				}
			}
			if got := shareSafeInlineCutoff(source, len(use), shareRawMarkdownRanges(source)); got != len(use) {
				t.Fatalf("complete link must stay visible: got=%d want=%d", got, len(use))
			}
			if got := sharePreview(string(source)); !strings.HasPrefix(got, use) {
				t.Fatalf("valid inline markup changed: %q", got)
			}
		})
	}
	for _, source := range []string{
		"> [x](/outer\n>\n> \"title\")",
		"> [x](\n\n> /outer)",
		"- [x](\n- /outer)",
		"> [x](\n> javascript:bad)",
		"> [x](\n> file:///tmp/file)",
	} {
		scanner := shareBlockInlineScanner{shareReferenceLabels: shareReferenceLabels{source: []byte(source)}}
		if end := scanner.end(strings.Index(source, "(")); end != 0 {
			t.Errorf("invalid or cross-block destination accepted: source=%q end=%d", source, end)
		}
	}
}
