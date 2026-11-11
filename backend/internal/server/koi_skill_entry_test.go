package server

import (
	"errors"
	"strings"
	"testing"
)

func TestKoiSkillEntryMetadata(t *testing.T) {
	content := "\ufeff---\r\nname: summarize-notes\r\ndescription: Summarize a note.\r\nmetadata:\r\n  author: Koinote\r\nallowed-tools: read_file\r\n---\r\n# Instructions\r\nRead the selected note.\r\n"
	for _, entry := range []string{
		content,
		strings.ReplaceAll(content, "---\r\n", "--- \t\r\n"),
		strings.Replace(content, "\r\n---\r\n", "\r\n...\r\n", 1),
	} {
		name, description, raw, format, instructions, err := koiParseSkillEntry(koiSkillFile{Content: []byte(entry)})
		if err != nil {
			t.Fatal(err)
		}
		if name != "summarize-notes" || description != "Summarize a note." || format != "agent-skills" {
			t.Fatalf("unexpected entry: %q, %q, %q", name, description, format)
		}
		if instructions != entry {
			t.Fatal("parsing must preserve the original source bytes")
		}
		if raw["allowed-tools"] != "read_file" || raw["metadata"].(map[string]any)["author"] != "Koinote" {
			t.Fatalf("extension metadata was lost: %#v", raw)
		}
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
		{"invalid closing delimiter", "---\nname: summarize-notes\ndescription: Summarize a note.\n---not-a-delimiter\n# Body"},
		{"invalid YAML", "---\nname: [broken\n---\n# Body"},
		{"missing name", "---\ndescription: Summarize a note.\n---\n# Body"},
		{"blank name", "---\nname: ' '\ndescription: Summarize a note.\n---\n# Body"},
		{"null name", "---\nname: null\ndescription: Summarize a note.\n---\n# Body"},
		{"missing description", "---\nname: summarize-notes\n---\n# Body"},
		{"blank description", "---\nname: summarize-notes\ndescription: ' '\n---\n# Body"},
		{"null description", "---\nname: summarize-notes\ndescription: null\n---\n# Body"},
		{"empty metadata", "---\n{}\n---\n# Body"},
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

func TestKoiSkillEntryRejectsEmptyBody(t *testing.T) {
	header := "---\nname: summarize-notes\ndescription: Summarize a note.\n---"
	for _, content := range []string{
		" \n\t", "\ufeff \r\n\t", header, header + "\n \t\n",
		"\ufeff" + strings.ReplaceAll(header, "\n", "\r\n") + "\r\n \t",
		strings.Replace(header, "\n---", "\n... \t", 1),
	} {
		_, _, _, _, _, err := koiParseSkillEntry(koiSkillFile{Content: []byte(content)})
		if !errors.Is(err, errKoiSkillEmptyEntry) || !errors.Is(err, errKoiSkillPackage) {
			t.Fatalf("empty body did not produce an entry validation error: %q, %v", content, err)
		}
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
