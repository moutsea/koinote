package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"
)

func koiCandidateTestFiles(entries map[string]string) []koiSkillFile {
	files := make([]koiSkillFile, 0, len(entries))
	for path, content := range entries {
		files = append(files, koiSkillFileFixture(path, content))
	}
	return files
}

func TestKoiSkillCandidatesKeepBoundariesAndSource(t *testing.T) {
	tree := koiSkillFileTreeFixture()
	files := make([]koiSkillFile, 0, len(tree))
	for _, file := range tree {
		files = append(files, file)
	}
	before, _ := json.Marshal(files)
	candidates, rejected := koiSkillCandidates(files, koiSkillSourceContext{Directory: "skills/writing", RootName: "Repository", License: "Fallback license"})
	if len(candidates) != 2 || len(rejected) != 0 || candidates[0].Directory != "" || candidates[1].Directory != "nested" {
		t.Fatalf("wrong candidates or ordering: %+v %+v", candidates, rejected)
	}
	for _, candidate := range candidates {
		if candidate.EntryPath != "SKILL.md" || candidate.MetadataFormat != "plain-markdown" || candidate.License != "Local license" || candidate.FileCount != 6 {
			t.Fatalf("source context or package members lost: %+v", candidate)
		}
		var size int64
		for _, file := range candidate.Files {
			if strings.HasPrefix(file.Path, "skills/") || strings.HasPrefix(file.Path, "nested/") {
				t.Fatalf("unrebased or nested member: %s", file.Path)
			}
			size += file.SizeBytes
		}
		if candidate.SizeBytes != size || candidate.ContentSHA256 != koiSkillContentDigest(candidate.Files) {
			t.Fatalf("package size or digest is inconsistent: %+v", candidate)
		}
	}
	after, _ := json.Marshal(files)
	if !bytes.Equal(before, after) {
		t.Fatal("candidate analysis modified source files")
	}
}

func TestKoiSkillCandidatesDeriveMetadataAndPreserveDeclarations(t *testing.T) {
	for _, root := range []string{"writing", "Review Methods", "写作方法", ".", ""} {
		files := []koiSkillFile{{Path: "SKILL.md", Content: []byte("# 写作方法\n先写提纲。")}}
		candidates, rejected := koiSkillCandidates(files, koiSkillSourceContext{RootName: root, License: "MIT"})
		if len(candidates) != 1 || len(rejected) != 0 || candidates[0].Name == "" || candidates[0].Description != "写作方法" || candidates[0].License != "MIT" || candidates[0].Files[0].MimeType != "application/octet-stream" {
			t.Fatalf("root %q lost display metadata: %+v %+v", root, candidates, rejected)
		}
	}
	entry := "\ufeff---\r\nname: method\r\ndescription: Editing method\r\nlicense: Apache-2.0\r\nmetadata: {author: Acme}\r\nuser-invocable: false\r\n---\r\nRead the guide.\r\n"
	candidates, rejected := koiSkillCandidates(koiCandidateTestFiles(map[string]string{"method/SKILL.md": entry}))
	if len(candidates) != 1 || len(rejected) != 0 {
		t.Fatalf("structural analysis failed: %+v %+v", candidates, rejected)
	}
	candidate := candidates[0]
	if candidate.Name != "method" || candidate.Description != "Editing method" || candidate.Instructions != entry || string(candidate.Files[0].Content) != entry || candidate.License != "Apache-2.0" ||
		candidate.RawMetadata["user-invocable"] != false || candidate.RawMetadata["metadata"].(map[string]any)["author"] != "Acme" {
		t.Fatal("analysis changed source bytes, metadata or invocation declarations")
	}
}

func TestKoiSkillCandidatesRejectPackagesIndependently(t *testing.T) {
	for _, tc := range []struct {
		name, entry, reason string
		files               int
		attachmentSize      int
		metadataOnly        bool
	}{
		{name: "malformed YAML", entry: "---\nname: [broken\n---\nBody", reason: "invalid_frontmatter"},
		{name: "invalid name", entry: "---\nname: Bad_Name\n---\nBody", reason: "invalid_name"},
		{name: "metadata type", entry: "---\ndescription: 3\n---\nBody", reason: "invalid_metadata_type"},
		{name: "missing native name", entry: "---\ndescription: Review a document.\n---\n# Review", reason: "missing_name"},
		{name: "missing native description", entry: "---\nname: review\n---\n# Review", reason: "missing_description"},
		{name: "empty native body", entry: "---\nname: review\ndescription: Review a document.\n---\n \t", reason: "empty_entry"},
		{name: "empty entry", entry: " \n\t", reason: "empty_entry"},
		{name: "entry size", entry: strings.Repeat("x", koiSkillEntryBytes+1), reason: "entry_too_large"},
		{name: "attachment size", entry: "# Child", files: 1, attachmentSize: koiSkillFileBytes + 1, reason: "file_too_large"},
		{name: "metadata-only attachment", entry: "# Child", files: 1, attachmentSize: koiSkillFileBytes + 1, metadataOnly: true, reason: "file_too_large"},
		{name: "file count", entry: "# Child", files: koiSkillMaxFiles, attachmentSize: 1, reason: "too_many_files"},
		{name: "package size", entry: "# Child", files: 4, attachmentSize: koiSkillFileBytes, reason: "package_too_large"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			files := koiCandidateTestFiles(map[string]string{"SKILL.md": "# Parent", "child/SKILL.md": tc.entry})
			for i := 0; i < tc.files; i++ {
				file := koiSkillFileFixture(fmt.Sprintf("child/reference-%02d.txt", i), strings.Repeat("x", tc.attachmentSize))
				if tc.metadataOnly {
					file.Content, file.SHA256 = nil, ""
				}
				files = append(files, file)
			}
			candidates, rejected := koiSkillCandidates(files)
			if len(candidates) != 1 || candidates[0].Directory != "" || candidates[0].FileCount != 1 || len(rejected) != 1 || rejected[0].Directory != "child" || rejected[0].EntryPath != "child/SKILL.md" || rejected[0].Reason != tc.reason {
				t.Fatalf("invalid child blocked its parent or lost its reason: %+v %+v", candidates, rejected)
			}
			if tc.reason == "file_too_large" && (len(rejected[0].Details) != 1 || rejected[0].Details[0] != "file_too_large:reference-00.txt") {
				t.Fatalf("missing attachment error context: %+v", rejected)
			}
		})
	}
	// Rejection paths remain relative to the selected directory.
	_, rejected := koiSkillCandidates(koiCandidateTestFiles(map[string]string{"method/SKILL.md": ""}), koiSkillSourceContext{Directory: "method"})
	if len(rejected) != 1 || rejected[0].Directory != "." || rejected[0].EntryPath != "SKILL.md" {
		t.Fatalf("selected root error has the wrong path: %+v", rejected)
	}
}

func TestKoiSkillCandidatesAcceptPackageLimitBoundaries(t *testing.T) {
	files := []koiSkillFile{koiSkillFileFixture("SKILL.md", strings.Repeat("x", koiSkillEntryBytes))}
	for i := 0; i < 3; i++ {
		files = append(files, koiSkillFileFixture(fmt.Sprintf("reference-%d.txt", i), strings.Repeat("x", koiSkillFileBytes)))
	}
	files = append(files, koiSkillFileFixture("reference-small.txt", strings.Repeat("x", koiSkillEntryBytes)))
	candidates, rejected := koiSkillCandidates(files)
	if len(candidates) != 1 || len(rejected) != 0 || candidates[0].SizeBytes != koiSkillPackageBytes {
		t.Fatalf("exact size limits rejected: %+v %+v", candidates, rejected)
	}
	files = []koiSkillFile{koiSkillFileFixture("SKILL.md", "# Method")}
	for i := 1; i < koiSkillMaxFiles; i++ {
		files = append(files, koiSkillFileFixture(fmt.Sprintf("reference-%d.txt", i), "Guide"))
	}
	candidates, rejected = koiSkillCandidates(files)
	if len(candidates) != 1 || len(rejected) != 0 || candidates[0].FileCount != koiSkillMaxFiles {
		t.Fatalf("exact file count rejected: %+v %+v", candidates, rejected)
	}
}

func TestKoiSkillCandidatesHaveStableContentIdentity(t *testing.T) {
	files := koiCandidateTestFiles(map[string]string{"method/SKILL.md": "# Method", "method/guide.md": "Guide"})
	first, _ := koiSkillCandidates(files)
	slices.Reverse(files)
	reordered, _ := koiSkillCandidates(files)
	if len(first) != 1 || len(reordered) != 1 || first[0].ID != reordered[0].ID || first[0].ContentSHA256 != reordered[0].ContentSHA256 {
		t.Fatal("enumeration order changed the candidate identity")
	}
	changed, _ := koiSkillCandidates(koiCandidateTestFiles(map[string]string{"method/SKILL.md": "# Method", "method/guide.md": "Changed guide"}))
	sibling, _ := koiSkillCandidates(koiCandidateTestFiles(map[string]string{"other/SKILL.md": "# Method", "other/guide.md": "Guide"}))
	if first[0].ID == changed[0].ID || first[0].ContentSHA256 == changed[0].ContentSHA256 || first[0].ID == sibling[0].ID || first[0].ContentSHA256 != sibling[0].ContentSHA256 {
		t.Fatal("content version or source directory isolation is broken")
	}
	for _, files := range [][]koiSkillFile{nil, {koiSkillFileFixture("README.md", "No entry")}} {
		candidates, rejected := koiSkillCandidates(files)
		if len(candidates) != 0 || len(rejected) != 0 {
			t.Fatal("a source without SKILL.md invented candidates")
		}
	}
}
