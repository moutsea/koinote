package server

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestShareInlineDestinationCompatibility(t *testing.T) {
	type destinationCase struct {
		Source   string
		Accepted bool
	}
	var cases []destinationCase
	for _, suffix := range []string{
		"()", "( )", "(foo)", "(https://example.com/path)", "(mailto:reader@example.com)",
		`(a\(b\))`, `(<a\>b>)`, `(url "title")`, `(url (title))`, `(<url> "title")`,
		`(javascript\&colon;bad)`, `(javascript&amp;colon;bad)`, `(java\script:bad)`,
		"(%6aavascript:bad)",
		"(javascrİpt:bad)",
		"(data:image/png;base64,abc)", "(data:image/gif;base64,abc)",
		"(data:image/jpeg;base64,abc)", "(data:image/webp;base64,abc)",
		"(java&#0;script:bad)", "(java&#x85;script:bad)",
		"(a" + strings.Repeat("(", 32) + "b" + strings.Repeat(")", 32) + ")",
	} {
		cases = append(cases, destinationCase{"[x]" + suffix, true})
	}
	for _, suffix := range []string{
		`(javascript:bad)`, `(JaVaScRiPt:bad)`, `(javascript\:bad)`,
		`(javascript&colon;bad)`, `(&#106;avascript:bad)`, `(&#x6a;avascript:bad)`,
		"(&#00000106;avascript:bad)",
		`(<&#xfeff;javascript:bad>)`, `(vbscript:bad)`, `(file:///tmp/file)`,
		`(data:text/plain,bad)`, `(data:image/svg+xml;bad)`, `(data:image/jpg;bad)`,
		`(/bad\ url)`, "(/bad\x01url)", "(/bad\x7furl)",
		`(<url>"title")`, `(url (nested(title)))`, `(<first<second>)`,
		"(a" + strings.Repeat("(", 33) + "b" + strings.Repeat(")", 33) + ")",
	} {
		cases = append(cases, destinationCase{"[x]" + suffix, false})
	}
	for _, tc := range cases {
		end := shareInlineDestinationEnd([]byte(tc.Source), 3)
		if (end == len(tc.Source)) != tc.Accepted || end != 0 && end != len(tc.Source) {
			t.Errorf("destination=%q end=%d accepted=%t", tc.Source, end, tc.Accepted)
		}
	}
	if output := os.Getenv("KOINOTE_SHARE_DESTINATION_FIXTURES"); output != "" {
		data, err := json.Marshal(cases)
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(output, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
}
