package server

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
)

func TestShareReferenceDefinitionCompatibility(t *testing.T) {
	type definitionCase struct {
		Source, Destination, Title string
		Label                      string
		Accepted                   bool
	}
	var cases []definitionCase
	for _, tc := range []struct {
		definition string
		accepted   bool
	}{
		{"/outer", true}, {"</outer>", true}, {"<>", true},
		{"/outer\n \"\" trailing", false}, {"/outer\n '' trailing", false}, {"/outer\n () trailing", false},
		{"<a\\\nb>", false}, {"a\\\nb", true},
		{"/outer\n \"a\\\nb\"", true},
		{"/outer \"title\"", true}, {"/outer\n 'multiline\n title'", true},
		{"/outer\n \"unfinished", true}, {"/outer\n \"title\" trailing", true},
		{"/outer (nested(title))", false}, {"/outer \"title\" trailing", false},
		{"/outer\n\n \"title\"", true}, {"\n /outer\n \"title\"", true},
		{"<url>\"title\"", false}, {`/bad\ url`, false},
		{"javascript:bad", false}, {"JaVaScRiPt:bad", false},
		{`javascript\:bad`, false}, {"javascript&colon;bad", false},
		{"&#106;avascript:bad", false}, {"<&#xfeff;javascript:bad>", false},
		{"file:///tmp/file", false}, {"vbscript:bad", false},
		{"data:text/plain,bad", false}, {"data:image/svg+xml;bad", false},
		{"data:image/png;base64,abc", true}, {"data:image/gif;base64,abc", true},
		{"data:image/jpeg;base64,abc", true}, {"data:image/webp;base64,abc", true},
		{`javascript\&colon;bad`, true}, {"javascript&amp;colon;bad", true},
		{"a" + strings.Repeat("(", 32) + "b" + strings.Repeat(")", 32), true},
		{"a" + strings.Repeat("(", 33) + "b" + strings.Repeat(")", 33), false},
	} {
		for _, prefix := range []string{"", "> ", "> - "} {
			source := "[x]: " + tc.definition
			if prefix != "" {
				continuation := prefix
				if prefix == "> - " {
					continuation = ">   "
				}
				source = prefix + strings.ReplaceAll(source, "\n", "\n"+continuation)
			}
			cases = append(cases, definitionCase{Source: source + "\n\n[x]", Accepted: tc.accepted})
		}
	}
	cases = append(cases,
		definitionCase{Source: "[x]: javascript:bad\n\n[x]: /outer\n\n[x]", Accepted: true},
		definitionCase{Source: "[x]: /first\n[x]: /second\n\n[x]", Accepted: true},
		definitionCase{Source: "[x]: javascript:bad\n[x]: /outer\n\n[x]", Accepted: false},
		definitionCase{Source: "[x]: /outer\n[x]: javascript:bad\n[x]: /second\n\n[x]", Accepted: true},
		definitionCase{Source: "[two\n line]: /outer\n\n[x]", Accepted: false},
		definitionCase{Source: "[x]: /outer\n  [other]: /other\n\n[x]", Accepted: true},
	)
	for _, definition := range []struct {
		source   string
		accepted bool
	}{
		{"[x]: /dummy\n    code\n[y]: /hidden", true},
		{"[x]: /dummy\n\tcode\n[y]: /hidden", true},
		{"[x]: /dummy\n    [y]: /code\n---", false},
		{"[x]: /dummy\n    [y]: /code\n===", false},
		{"[x]: /dummy\n    code\n[y]: /hidden\n---", true},
		{"[x]: /dummy\nordinary\n    code\n[y]: /hidden", false},
	} {
		for _, prefix := range []string{"", "> ", "- "} {
			accepted := definition.accepted
			if prefix != "" && strings.Contains(definition.source, "\n\tcode") {
				accepted = false // 容器前缀占两列，这个 tab 只产生两列缩进。
			}
			continuation := prefix
			if prefix == "- " {
				continuation = "  "
			}
			source := prefix + strings.ReplaceAll(definition.source, "\n", "\n"+continuation)
			cases = append(cases, definitionCase{Source: source + "\n\n[y]", Label: "y", Accepted: accepted})
		}
	}
	for i := range cases {
		tc := &cases[i]
		if tc.Label == "" {
			tc.Label = "x"
		}
		context := parser.NewContext()
		sharePreviewParser.Parse(text.NewReader([]byte(tc.Source)), parser.WithContext(context))
		reference, accepted := context.Reference(tc.Label)
		if accepted != tc.Accepted {
			t.Errorf("source=%q accepted=%t want=%t", tc.Source, accepted, tc.Accepted)
		}
		if accepted {
			tc.Destination, tc.Title = string(reference.Destination()), string(reference.Title())
		}
	}
	if output := os.Getenv("KOINOTE_SHARE_REFERENCE_FIXTURES"); output != "" {
		data, err := json.Marshal(cases)
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(output, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestShareRejectedDefinitionCutoffs(t *testing.T) {
	for _, destination := range []string{"javascript:bad", "file:///tmp/file", "data:text/plain,bad", `/bad\ url`} {
		for _, prefix := range []string{"", "> "} {
			source := []byte("[x]\n\n" + prefix + "[x]: " + destination)
			for cutoff := strings.Index(string(source), destination) + 1; cutoff < len(source); cutoff++ {
				preview := shareReadableReferences(source, cutoff, shareRawMarkdownRanges(source))
				context := parser.NewContext()
				sharePreviewParser.Parse(text.NewReader([]byte(preview)), parser.WithContext(context))
				if len(context.References()) != 0 {
					t.Fatalf("cutoff=%d created a new definition: source=%q preview=%q", cutoff, source, preview)
				}
			}
		}
	}
}
