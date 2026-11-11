package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestWritingSkillPackageKeepsNestedSkillsIndependent(t *testing.T) {
	a, user, _ := writingTestApp(t)
	for _, tc := range []struct {
		name, prefix, instructions string
	}{
		{"root Markdown skill", "", "# Parent\nRead references/guide.md."},
		{"nested native skill", "skills/writer/", "---\nname: writer\ndescription: Write a note.\nfiles: [references/guide.md]\ndisable-model-invocation: true\n---\nRead the guide."},
	} {
		t.Run(tc.name, func(t *testing.T) {
			files := map[string]string{
				tc.prefix + "SKILL.md":            tc.instructions,
				tc.prefix + "references/guide.md": "Parent reference",
				tc.prefix + "child/SKILL.md":      "# Independent child",
				tc.prefix + "child/large.bin":     strings.Repeat("x", 129<<10),
			}
			// Neither a child's file count nor its invalid attachment can prevent
			// the parent from loading. Ordinary subdirectories remain in scope.
			for i := 0; i < 33; i++ {
				files[fmt.Sprintf("%schild/attachment-%02d.txt", tc.prefix, i)] = "Child attachment"
			}
			if tc.prefix != "" {
				files["SKILL.md"] = "# Ancestor skill"
				files["skills/writer-extra/SKILL.md"] = "# Sibling skill"
				files["skills/writer-extra/large.bin"] = strings.Repeat("y", 129<<10)
			}
			repositoryID := agentSkillRepositoryForTest(t, a, user.ID, files)
			for _, entry := range []string{"article", "conversation"} {
				t.Run(entry, func(t *testing.T) {
					load := a.writingSkill
					if entry == "conversation" {
						load = a.writingConversationSkill
					}
					raw, err := load(context.Background(), user.ID, repositoryID, tc.prefix+"SKILL.md")
					if err != nil {
						t.Fatal(err)
					}
					var pkg struct {
						Instructions string          `json:"instructions"`
						Manifest     json.RawMessage `json:"manifest"`
						Files        []struct {
							Path          string `json:"path"`
							ContentBase64 string `json:"contentBase64"`
						} `json:"files"`
					}
					if err := json.Unmarshal(raw, &pkg); err != nil {
						t.Fatal(err)
					}
					if pkg.Instructions != tc.instructions || len(pkg.Files) != 1 || pkg.Files[0].Path != "references/guide.md" || pkg.Files[0].ContentBase64 != base64.StdEncoding.EncodeToString([]byte("Parent reference")) {
						t.Fatalf("wrong package boundary or changed source: %s", raw)
					}
					if strings.HasPrefix(tc.instructions, "---") && len(pkg.Manifest) != 0 {
						t.Fatal("native frontmatter must retain the existing envelope")
					}
				})
			}
			if _, err := a.writingConversationSkill(context.Background(), user.ID, repositoryID, tc.prefix+"child/SKILL.md"); err == nil {
				t.Fatal("selecting the oversized child itself must still enforce limits")
			}
			if _, err := a.writingSkill(context.Background(), user.ID, repositoryID, tc.prefix+"missing/SKILL.md"); err == nil {
				t.Fatal("a missing entry must not load a descendant or ancestor skill")
			}
		})
	}
}

func TestWritingSkillPackageBoundaryRetainsPackageLimits(t *testing.T) {
	a, user, _ := writingTestApp(t)
	for _, tc := range []struct {
		name, entry string
		count, size int
		wantError   bool
	}{
		{"32 files including entry", "# Skill", 31, 1, false},
		{"33 files including entry", "# Skill", 32, 1, true},
		{"oversized entry", strings.Repeat("x", (64<<10)+1), 0, 0, true},
		{"oversized attachment", "# Skill", 1, (128 << 10) + 1, true},
		{"oversized package", "# Skill", 4, 128 << 10, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			files := map[string]string{"SKILL.md": tc.entry}
			for i := 0; i < tc.count; i++ {
				files[fmt.Sprintf("references/%02d.txt", i)] = strings.Repeat("x", tc.size)
			}
			repositoryID := agentSkillRepositoryForTest(t, a, user.ID, files)
			_, err := a.writingConversationSkill(context.Background(), user.ID, repositoryID, "SKILL.md")
			if (err != nil) != tc.wantError {
				t.Fatalf("load error = %v, wantError = %v", err, tc.wantError)
			}
		})
	}
}
