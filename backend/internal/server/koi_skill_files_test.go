package server

import (
	"reflect"
	"slices"
	"strings"
	"testing"
	"unicode/utf8"
)

func koiSkillFileFixture(path, content string) koiSkillFile {
	return koiSkillFile{Path: path, Content: []byte(content), SHA256: koiDigest([]byte(content)), MimeType: "text/plain", SizeBytes: int64(len(content))}
}

func koiSkillFileTreeFixture() map[string]koiSkillFile {
	files := map[string]koiSkillFile{}
	for path, content := range map[string]string{
		"LICENSE":                              "Repository license",
		"NOTICE.md":                            "Repository notice",
		"skills/COPYING":                       "Skills license",
		"skills/writing/SKILL.md":              "# Writing\nKeep sentences short.\n",
		"skills/writing/LICENSE":               "Local license",
		"skills/writing/references/guide.md":   "Writing reference",
		"skills/writing/nested/SKILL.md":       "# Nested\nA separate method.\n",
		"skills/writing/nested/reference.md":   "Nested reference",
		"skills/writing-extra/SKILL.md":        "# Another skill",
		"skills/writing-extra/references/a.md": "Sibling reference",
		"docs/private-example.txt":             "An unrelated file",
	} {
		files[path] = koiSkillFileFixture(path, content)
	}
	return files
}

func TestKoiSkillNeededPaths(t *testing.T) {
	files := koiSkillFileTreeFixture()
	single := []string{"LICENSE", "NOTICE.md", "skills/COPYING", "skills/writing/LICENSE", "skills/writing/SKILL.md", "skills/writing/references/guide.md"}
	for _, tc := range []struct {
		name, dir string
		exact     bool
		want      []string
	}{
		{"single skill excludes nested and sibling skills", "skills/writing", true, single},
		{"directory includes nested candidates", "skills/writing", false, append(slices.Clone(single), "skills/writing/nested/SKILL.md", "skills/writing/nested/reference.md")},
		{"exact directory without an entry selects nothing", "skills", true, []string{}},
		{"missing directory selects nothing", "missing", false, []string{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			selected := []string{}
			for path := range koiSkillNeededPaths(files, tc.dir, tc.exact) {
				selected = append(selected, path)
			}
			slices.Sort(selected)
			want := slices.Clone(tc.want)
			slices.Sort(want)
			if !slices.Equal(selected, want) {
				t.Fatalf("selected %v, want %v", selected, want)
			}
		})
	}
	files["SKILL.md"] = koiSkillFileFixture("SKILL.md", "# Root skill")
	root := koiSkillNeededPaths(files, "", true)
	if !root["SKILL.md"] || !root["docs/private-example.txt"] || root["skills/writing/SKILL.md"] {
		t.Fatalf("a root skill must own its ordinary files but exclude nested skills: %v", root)
	}
}

func TestKoiSkillPackageFilesPreserveProvenance(t *testing.T) {
	files := koiSkillFileTreeFixture()
	files["skills/writing/NOTICE.txt"] = koiSkillFileFixture("skills/writing/NOTICE.txt", "Local attribution")
	files["skills/NOTICE-third-party.md"] = koiSkillFileFixture("skills/NOTICE-third-party.md", "Ancestor attribution")
	selected := koiSkillPackageFiles("skills/writing", files, []string{"skills/writing/nested"})
	if len(selected) != 8 {
		t.Fatalf("unexpected package members: %+v", selected)
	}
	before := slices.Clone(selected)
	rebased := koiSkillRebaseFiles("skills/writing", selected)
	if !reflect.DeepEqual(selected, before) {
		t.Fatal("rebasing modified the source file metadata")
	}
	byHash := map[string]koiSkillFile{}
	for _, file := range selected {
		byHash[file.SHA256] = file
	}
	paths := []string{}
	var entry koiSkillFile
	for _, file := range rebased {
		original := byHash[file.SHA256]
		paths = append(paths, file.Path)
		if file.Path == "SKILL.md" {
			entry = file
		}
		if string(file.Content) != string(original.Content) || file.MimeType != original.MimeType || file.SizeBytes != original.SizeBytes {
			t.Fatalf("rebasing changed file contents or metadata: %q", file.Path)
		}
		if file.Path != "SKILL.md" && file.Path != "LICENSE" && file.Path != "NOTICE.txt" && file.Path != "references/guide.md" && !strings.HasPrefix(file.Path, "_provenance/") {
			t.Fatalf("unexpected package-relative path: %q", file.Path)
		}
	}
	if len(rebased) != len(selected) || !slices.IsSorted(paths) {
		t.Fatalf("rebased files were lost or unstable: %v", paths)
	}
	if _, description, _, format, _, err := koiParseSkillEntry(entry); err != nil || description != "Writing" || format != "plain-markdown" {
		t.Fatalf("rebased entry cannot be parsed: %q %q %v", description, format, err)
	}
}

func TestKoiSkillRebaseAvoidsProvenanceCollision(t *testing.T) {
	reserved := "_provenance/" + koiDigest([]byte("LICENSE"))[:16] + "/LICENSE"
	files := []koiSkillFile{
		koiSkillFileFixture("method/SKILL.md", "# Method"),
		koiSkillFileFixture("method/LICENSE", "Local license"),
		koiSkillFileFixture("method/"+reserved, "Existing package member"),
		koiSkillFileFixture("LICENSE", "Repository license"),
	}
	rebased := koiSkillRebaseFiles("method", files)
	seen := map[string]bool{}
	contents := map[string]bool{}
	for _, file := range rebased {
		if seen[file.Path] {
			t.Fatalf("provenance overwrote a package member: %q", file.Path)
		}
		seen[file.Path], contents[string(file.Content)] = true, true
	}
	for _, original := range files {
		if !contents[string(original.Content)] {
			t.Fatalf("lost source bytes: %q", original.Path)
		}
	}
}

func TestKoiSkillContentDigestTracksPackageChanges(t *testing.T) {
	files := []koiSkillFile{koiSkillFileFixture("SKILL.md", "# Writing"), koiSkillFileFixture("references/guide.md", "Guide")}
	before := slices.Clone(files)
	initial := koiSkillContentDigest(files)
	slices.Reverse(files)
	if koiSkillContentDigest(files) != initial || !reflect.DeepEqual(files, []koiSkillFile{before[1], before[0]}) {
		t.Fatal("digest must be independent of enumeration order without changing its input")
	}
	for _, changed := range [][]koiSkillFile{
		{before[0], koiSkillFileFixture("references/guide.md", "Updated guide")},
		{before[0], koiSkillFileFixture("references/renamed.md", "Guide")},
		{before[0]},
		{before[0], before[1], koiSkillFileFixture("LICENSE", "MIT")},
	} {
		if koiSkillContentDigest(changed) == initial {
			t.Fatal("a content, path or file-set change must change the package digest")
		}
	}
}

func TestKoiSkillLicenseUsesPackageProvenance(t *testing.T) {
	for _, tc := range []struct {
		name   string
		raw    map[string]any
		remove []string
		want   string
	}{
		{"local license", nil, nil, "Local license"},
		{"local license precedes metadata", map[string]any{"license": "Apache-2.0"}, nil, "Local license"},
		{"metadata precedes ancestors", map[string]any{"license": " Apache-2.0 "}, []string{"skills/writing/LICENSE"}, "Apache-2.0"},
		{"alternate metadata spelling", map[string]any{"licence": "MIT"}, []string{"skills/writing/LICENSE"}, "MIT"},
		{"closest ancestor", nil, []string{"skills/writing/LICENSE"}, "Skills license"},
		{"repository ancestor", nil, []string{"skills/writing/LICENSE", "skills/COPYING"}, "Repository license"},
		{"metadata with notices only", map[string]any{"license": "MIT"}, []string{"skills/writing/LICENSE", "skills/COPYING", "LICENSE"}, "MIT"},
		{"notices alone are not a license", nil, []string{"skills/writing/LICENSE", "skills/COPYING", "LICENSE"}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			files := koiSkillFileTreeFixture()
			files["skills/writing/NOTICE.txt"] = koiSkillFileFixture("skills/writing/NOTICE.txt", "Local attribution")
			files["skills/NOTICE-third-party.md"] = koiSkillFileFixture("skills/NOTICE-third-party.md", "Ancestor attribution")
			for _, path := range tc.remove {
				delete(files, path)
			}
			selected := koiSkillPackageFiles("skills/writing", files, []string{"skills/writing/nested"})
			if got := koiSkillLicense(tc.raw, selected, "skills/writing"); got != tc.want {
				t.Fatalf("license = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestKoiSkillLicenseLengthDoesNotChangeProvenance(t *testing.T) {
	longNotice := "Apache License, Version 2.0\n" + strings.Repeat("License terms. ", 650)
	unicodeNotice := "Apache License, Version 2.0\n" + strings.Repeat("许可证正文。", 650)
	metadata := strings.Repeat("Custom license terms. ", 8)
	for _, tc := range []struct {
		name, dir, noticePath, text string
		raw                         map[string]any
	}{
		{"root long notice", "", "LICENSE", longNotice, nil},
		{"local long notice precedes metadata and ancestors", "skills/writing", "skills/writing/LICENSE", unicodeNotice, map[string]any{"license": "MIT"}},
		{"closest long ancestor", "skills/writing", "skills/LICENSE", longNotice, nil},
		{"long metadata precedes ancestors", "skills/writing", "", metadata, map[string]any{"license": metadata}},
		{"oversize alternate metadata", "skills/writing", "", unicodeNotice, map[string]any{"licence": unicodeNotice}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			files := map[string]koiSkillFile{"LICENSE": koiSkillFileFixture("LICENSE", "MIT")}
			entryPath := "SKILL.md"
			if tc.dir != "" {
				entryPath = tc.dir + "/" + entryPath
			}
			files[entryPath] = koiSkillFileFixture(entryPath, "# Writing")
			if tc.noticePath != "" {
				files[tc.noticePath] = koiSkillFileFixture(tc.noticePath, tc.text)
			}
			selected := koiSkillPackageFiles(tc.dir, files, nil)
			before := koiSkillContentDigest(koiSkillRebaseFiles(tc.dir, selected))
			got := koiSkillLicense(tc.raw, selected, tc.dir)
			want := strings.TrimSpace(tc.text)
			if len(want) <= 4096 {
				if got != want {
					t.Fatalf("license declaration was replaced: %q", got)
				}
			} else if len(got) < 4093 || len(got) > 4096 || !utf8.ValidString(got) || !strings.HasSuffix(got, "…") || !strings.HasPrefix(want, strings.TrimSuffix(got, "…")) {
				t.Fatalf("expected a bounded UTF-8 summary of the selected notice, got %d bytes: %.80q", len(got), got)
			}
			rebased := koiSkillRebaseFiles(tc.dir, selected)
			if koiSkillContentDigest(rebased) != before {
				t.Fatal("license summary changed the package digest")
			}
			for _, file := range rebased {
				if koiDigest(file.Content) != file.SHA256 || int64(len(file.Content)) != file.SizeBytes {
					t.Fatalf("license summary changed preserved source bytes or metadata: %q", file.Path)
				}
			}
		})
	}
}
