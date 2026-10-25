package server

import (
	"context"
	"os"
	"testing"
)

func reviewedTranslationFixture(t *testing.T) agentWorkspaceFile {
	t.Helper()
	content, err := os.ReadFile("testdata/agent_repository_licenses/vinvcn-LICENSE.zh-CN.md")
	if err != nil {
		t.Fatal(err)
	}
	return repositoryTestFile("LICENSE.zh-CN.md", string(content))
}

func TestReviewedSystemRepositoryLicenseIsScopedAndContentPinned(t *testing.T) {
	for _, name := range []string{"approved", "missing identity", "other repository", "other path", "other SPDX", "changed content", "missing root", "root replaced by translation", "unknown nested", "restricted nested", "restricted notice"} {
		t.Run(name, func(t *testing.T) {
			id, license := int64(1223387690), "MIT"
			files := []agentWorkspaceFile{repositoryTestFile("SKILL.md", "# Skill"), repositoryTestFile("LICENSE", discoveryMIT), reviewedTranslationFixture(t)}
			switch name {
			case "missing identity":
				id = 0
			case "other repository":
				id++
			case "other path":
				files[2].Path = "nested/LICENSE.zh-CN.md"
			case "other SPDX":
				license = "Apache-2.0"
				files[1] = repositoryTestFile("LICENSE", "Apache License\nVersion 2.0, January 2004\nlimitations under the License")
			case "changed content":
				// Leave the approved SHA256 field intact to detect trusting a
				// supplied digest instead of checking the actual new content.
				files[2].Content = append(files[2].Content, '\n')
			case "missing root":
				files = append(files[:1], files[2:]...)
			case "root replaced by translation":
				files[1].Content = append([]byte(nil), files[2].Content...)
			case "unknown nested":
				files = append(files, repositoryTestFile("nested/LICENSE", "Special terms"))
			case "restricted nested":
				files = append(files, repositoryTestFile("nested/LICENSE", discoveryMIT+"\nNon-commercial only"))
			case "restricted notice":
				files = append(files, repositoryTestFile("NOTICE", "Images are not covered by the root MIT license"))
			}
			want := name == "approved"
			if allowed := systemRepositoryLicenseFilesAllowed(files, id, license); allowed != want {
				t.Fatalf("license scan allowed=%t, want=%t", allowed, want)
			}
			if code := validateDiscoveredSkills(files, id, license); (code == "") != want {
				t.Fatalf("discovery license boundary: %q", code)
			}
		})
	}
}

func TestSystemRepositoryLicenseAcceptsISC(t *testing.T) {
	for _, tc := range []struct {
		name    string
		root    string
		license string
		extra   agentWorkspaceFile
		want    bool
	}{
		{"root and nested", discoveryISC, "ISC", repositoryTestFile("vendor/LICENSE", discoveryISC), true},
		{"root and nested and distribute", discoveryISCAnd, "ISC", repositoryTestFile("vendor/LICENSE", discoveryISCAnd), true},
		{"mit root with isc dependency", discoveryMIT, "MIT", repositoryTestFile("vendor/LICENSE", discoveryISC), true},
		{"mit root with isc and distribute dependency", discoveryMIT, "MIT", repositoryTestFile("vendor/LICENSE", discoveryISCAnd), true},
		{"isc text labelled mit", discoveryISC, "MIT", agentWorkspaceFile{}, false},
		{"0bsd dependency", discoveryMIT, "MIT", repositoryTestFile("vendor/LICENSE", discovery0BSD), false},
		{"isc with restriction", discoveryMIT, "MIT", repositoryTestFile("vendor/LICENSE", discoveryISC+"\nNon-commercial use only"), false},
		{"isc with wrapped restriction", discoveryMIT, "MIT", repositoryTestFile("vendor/LICENSE", discoveryISC+"\nNon-\nCommercial use only"), false},
		{"isc with wrapped notice restriction", discoveryMIT, "MIT", repositoryTestFile("vendor/LICENSE", discoveryISC+"\nImages are not covered\nby this license"), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			files := []agentWorkspaceFile{repositoryTestFile("SKILL.md", "# Skill"), repositoryTestFile("LICENSE", tc.root)}
			if tc.extra.Path != "" {
				files = append(files, tc.extra)
			}
			if allowed := systemRepositoryLicenseFilesAllowed(files, 12345, tc.license); allowed != tc.want {
				t.Fatalf("license scan allowed=%t, want=%t", allowed, tc.want)
			}
		})
	}
}

func TestSystemRepositorySyncReviewedTranslation(t *testing.T) {
	for _, changed := range []bool{false, true} {
		t.Run(map[bool]string{false: "unchanged license", true: "changed license"}[changed], func(t *testing.T) {
			app, w, _, _, upstream := seedSystemRepositorySync(t, true)
			source := *w.GitHubSource
			source.RepositoryID = 1223387690
			source.RepositoryURL = "https://github.com/vinvcn/mattpocock-skills-zh-CN"
			if _, err := app.db.Exec(context.Background(), `UPDATE agent_workspaces SET github_source=$2 WHERE id=$1`, w.WorkspaceID, source); err != nil {
				t.Fatal(err)
			}
			upstream.repositoryID, upstream.fullName = source.RepositoryID, "vinvcn/mattpocock-skills-zh-CN"
			translation := reviewedTranslationFixture(t)
			if changed {
				translation.Content = append(translation.Content, '\n')
			}
			upstream.archive = githubArchive(t, githubArchiveEntry{"root/LICENSE", discoveryMIT, 0},
				githubArchiveEntry{"root/LICENSE.zh-CN.md", string(translation.Content), 0},
				githubArchiveEntry{"root/SKILL.md", "# Updated skill", 0})
			summary, results, err := runSystemRepositorySync(t, app, w.WorkspaceID, true)
			if changed {
				if err == nil || summary.Failed != 1 || len(results) != 1 || results[0].Code != "license_review_required" {
					t.Fatalf("changed translation accepted: %+v %+v %v", summary, results, err)
				}
			} else if err != nil || summary.Updated != 1 {
				t.Fatalf("approved translation rejected: %+v %v", summary, err)
			}
			view, err := app.loadPublicAgentRepository(context.Background(), w.WorkspaceID, nil)
			wantSHA := githubSyncTestSHA
			if changed {
				wantSHA = githubTestSHA
			}
			if err != nil || view.GitHubSource.CommitSHA != wantSHA {
				t.Fatalf("wrong published snapshot: %+v %v", view, err)
			}
		})
	}
}
