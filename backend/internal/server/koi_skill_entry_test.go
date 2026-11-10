package server

import (
	"errors"
	"strings"
	"testing"
)

func TestKoiSkillEntryMetadata(t *testing.T) {
	content := "\ufeff---\r\nname: summarize-notes\r\ndescription: Summarize a note.\r\nmetadata:\r\n  author: Koinote\r\nallowed-tools: read_file\r\n---\r\n# Instructions\r\nRead the selected note.\r\n"
	name, description, raw, format, instructions, err := koiParseSkillEntry(koiSkillFile{Content: []byte(content)})
	if err != nil {
		t.Fatal(err)
	}
	if name != "summarize-notes" || description != "Summarize a note." || format != "agent-skills" {
		t.Fatalf("unexpected entry: %q, %q, %q", name, description, format)
	}
	if instructions != content {
		t.Fatal("parsing must preserve the original source bytes")
	}
	if raw["allowed-tools"] != "read_file" || raw["metadata"].(map[string]any)["author"] != "Koinote" {
		t.Fatalf("extension metadata was lost: %#v", raw)
	}
}

func TestKoiSkillEntryPlainMarkdown(t *testing.T) {
	content := "\n# Summarize notes\n\nUse the selected note.\n"
	name, description, raw, format, instructions, err := koiParseSkillEntry(koiSkillFile{Content: []byte(content)})
	if err != nil {
		t.Fatal(err)
	}
	if name != "" || description != "Summarize notes" || len(raw) != 0 || format != "plain-markdown" || instructions != content {
		t.Fatalf("unexpected plain Markdown result: %q, %q, %#v, %q", name, description, raw, format)
	}
	_, description, _, _, _, err = koiParseSkillEntry(koiSkillFile{Content: []byte(strings.Repeat("记", 210))})
	if err != nil || description != strings.Repeat("记", 200)+"…" {
		t.Fatalf("description truncation damaged Unicode: %q, %v", description, err)
	}
}

func TestKoiSkillEntryRejectsInvalidMetadata(t *testing.T) {
	for _, tc := range []struct{ name, content string }{
		{"unterminated", "---\nname: summarize-notes\n# Body"},
		{"invalid YAML", "---\nname: [broken\n---\n# Body"},
		{"numeric name", "---\nname: 123\n---\n# Body"},
		{"list description", "---\nname: summarize-notes\ndescription: [one, two]\n---\n# Body"},
		{"invalid name", "---\nname: Summarize Notes\n---\n# Body"},
		{"oversized name", "---\nname: " + strings.Repeat("a", koiSkillNameMaxRunes+1) + "\n---\n# Body"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, _, _, format, _, err := koiParseSkillEntry(koiSkillFile{Content: []byte(tc.content)})
			if !errors.Is(err, errKoiSkillPackage) || format == "plain-markdown" {
				t.Fatalf("invalid metadata must fail instead of falling back: format=%q, err=%v", format, err)
			}
		})
	}
}

func TestKoiSkillEntrySizeLimit(t *testing.T) {
	for _, tc := range []struct {
		name     string
		file     koiSkillFile
		tooLarge bool
	}{
		{"at limit", koiSkillFile{Content: []byte(strings.Repeat("x", koiSkillEntryBytes))}, false},
		{"content over limit", koiSkillFile{Content: []byte(strings.Repeat("x", koiSkillEntryBytes+1))}, true},
		{"reported size over limit", koiSkillFile{Content: []byte("# Skill"), SizeBytes: koiSkillEntryBytes + 1}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, _, _, _, _, err := koiParseSkillEntry(tc.file)
			if errors.Is(err, errKoiSkillTooLarge) != tc.tooLarge || (!tc.tooLarge && err != nil) {
				t.Fatalf("unexpected size validation: %v", err)
			}
		})
	}
}
