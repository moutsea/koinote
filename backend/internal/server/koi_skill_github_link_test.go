package server

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestKoiGitHubLinkParsing(t *testing.T) {
	for _, tc := range []struct {
		link   string
		target koiGitHubTarget
	}{
		{"https://github.com/acme/skills", koiGitHubTarget{Owner: "acme", Repo: "skills"}},
		{" https://www.github.com/acme/skills.git/ ", koiGitHubTarget{Owner: "acme", Repo: "skills"}},
		{"https://github.com/acme/skills/tree/main/review", koiGitHubTarget{Owner: "acme", Repo: "skills", Path: "main/review"}},
		{"https://github.com/acme/skills/blob/main/SKILL.md", koiGitHubTarget{Owner: "acme", Repo: "skills", Path: "main/SKILL.md", FileEntry: true}},
		{"https://github.com/acme/skills/blob/feature%2Freview/method/SKILL.md", koiGitHubTarget{Owner: "acme", Repo: "skills", Path: "feature/review/method/SKILL.md", FileEntry: true}},
		{"https://github.com/acme/skills/tree/" + githubTestSHA, koiGitHubTarget{Owner: "acme", Repo: "skills", Ref: githubTestSHA}},
		{"https://github.com/acme/skills/blob/" + githubTestSHA + "/review/SKILL.md", koiGitHubTarget{Owner: "acme", Repo: "skills", Ref: githubTestSHA, Path: "review/SKILL.md", FileEntry: true}},
		{"https://github.com/acme/skills/tree/" + strings.Repeat("a", 64) + "/review", koiGitHubTarget{Owner: "acme", Repo: "skills", Ref: strings.Repeat("a", 64), Path: "review"}},
	} {
		t.Run(tc.link, func(t *testing.T) {
			target, err := parseKoiGitHubLink(tc.link)
			if err != nil || target != tc.target {
				t.Fatalf("target = %+v, %v; want %+v", target, err, tc.target)
			}
		})
	}
	for _, link := range []string{
		"http://github.com/acme/skills", "https://gitlab.com/acme/skills",
		"https://user:pass@github.com/acme/skills", "https://github.com:443/acme/skills",
		"https://github.com/acme/skills?token=secret", "https://github.com/acme/skills#readme",
		"https://github.com/acme", "https://github.com/../skills", "https://github.com/acme/skills/releases",
		"https://github.com/acme/skills/tree/", "https://github.com/acme/skills/tree/main//review",
		"https://github.com/acme/skills/tree/main/../review", "https://github.com/acme/skills/tree/main%09/review",
		"https://github.com/acme/skills/blob/main/README.md", "https://github.com/acme/skills/blob/SKILL.md",
		"https://github.com/acme/skills/tree/" + githubTestSHA + "/../review",
	} {
		t.Run(link, func(t *testing.T) {
			if _, err := parseKoiGitHubLink(link); !errors.Is(err, errKoiGitHubLink) {
				t.Fatalf("invalid link was not rejected: %v", err)
			}
		})
	}
}

func TestKoiGitHubRefDisambiguation(t *testing.T) {
	refs := []string{"main", "feature/a/b", "main", "v1.2"}
	for _, tc := range []struct{ remainder, ref, dir string }{
		{"main/skills/review", "main", "skills/review"},
		{"feature/a/b", "feature/a/b", ""},
		{"feature/a/b/review/SKILL.md", "feature/a/b", "review/SKILL.md"},
		{"v1.2/review", "v1.2", "review"},
		{githubTestSHA + "/review", githubTestSHA, "review"},
	} {
		t.Run(tc.remainder, func(t *testing.T) {
			ref, dir, err := koiResolveGitHubRefPath(tc.remainder, refs)
			if err != nil || ref != tc.ref || dir != tc.dir {
				t.Fatalf("resolved %q/%q, %v; want %q/%q", ref, dir, err, tc.ref, tc.dir)
			}
		})
	}
	for _, tc := range []struct {
		remainder string
		refs      []string
	}{
		{"release/1.2/review", []string{"release", "release/1.2"}},
		{"release/1.2/review", []string{"release/1.2", "release"}},
		{"feature/a/b", []string{"feature", "feature/a/b"}},
		{"unknown/review", refs},
		{"main/../review", refs},
		{"main//review", refs},
		{"bad ref/review", []string{"bad ref"}},
	} {
		if _, _, err := koiResolveGitHubRefPath(tc.remainder, tc.refs); !errors.Is(err, errKoiGitHubLink) {
			t.Fatalf("unresolved or ambiguous link %q was accepted: %v", tc.remainder, err)
		}
	}
	// A full commit permalink stays pinned even if a branch shares its prefix.
	if ref, dir, err := koiResolveGitHubRefPath(githubTestSHA+"/review", []string{githubTestSHA + "/review"}); err != nil || ref != githubTestSHA || dir != "review" {
		t.Fatalf("commit permalink was reinterpreted as a branch: %q/%q, %v", ref, dir, err)
	}
}

func TestKoiNormalizeRepoPath(t *testing.T) {
	for raw, want := range map[string]string{"": "", "/": "", " /skills/review/ ": "skills/review", "review": "review"} {
		if got, err := koiNormalizeRepoPath(raw); err != nil || got != want {
			t.Fatalf("normalize %q = %q, %v; want %q", raw, got, err, want)
		}
	}
	for _, raw := range []string{"..", "../review", "skills/../review", "skills//review", "skills\\review", "C:/review", "review\x00/file"} {
		if _, err := koiNormalizeRepoPath(raw); !errors.Is(err, errKoiGitHubLink) {
			t.Fatalf("invalid directory %q lost its source error: %v", raw, err)
		}
	}
}

func TestKoiGitHubFileLinkSelectsItsPackage(t *testing.T) {
	target, err := parseKoiGitHubLink("https://github.com/Octo/demo/blob/feature/review/method/SKILL.md")
	if err != nil {
		t.Fatal(err)
	}
	target.Ref, target.Path, err = koiResolveGitHubRefPath(target.Path, []string{"main", "feature/review"})
	if err != nil || target.Ref != "feature/review" {
		t.Fatalf("resolve file link: %+v, %v", target, err)
	}
	archive := githubArchive(t,
		githubArchiveEntry{"root/LICENSE", "MIT License", 0},
		githubArchiveEntry{"root/method/SKILL.md", "# Review", 0},
		githubArchiveEntry{"root/method/reference.md", "Review guide", 0},
		githubArchiveEntry{"root/method/nested/SKILL.md", "# Nested", 0},
		githubArchiveEntry{"root/other/SKILL.md", "# Other", 0})
	app := &App{githubHTTPClient: githubImportClient(t, archive, "", false)}
	dir := koiSkillDirOf(target.Path)
	files, err := app.downloadKoiGitHubRepository(context.Background(), target.Owner, target.Repo, githubTestSHA, "", dir, target.FileEntry)
	if err != nil || len(files) != 3 {
		t.Fatalf("file link package: %d files, %v", len(files), err)
	}
	for _, file := range files {
		if file.Path != "LICENSE" && file.Path != "method/SKILL.md" && file.Path != "method/reference.md" {
			t.Fatalf("file link included another package: %q", file.Path)
		}
	}
}
