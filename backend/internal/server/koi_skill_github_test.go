package server

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"
)

func TestKoiGitHubArchiveReadsOnlyPackageMembers(t *testing.T) {
	archive := githubArchive(t,
		githubArchiveEntry{"root/LICENSE", "MIT License", 0},
		githubArchiveEntry{"root/skills/review/SKILL.md", "# Review\nKeep sentences short.\n", 0},
		githubArchiveEntry{"root/skills/review/reference.md", "Examples.", 0},
		githubArchiveEntry{"root/skills/review/nested/SKILL.md", "# Nested\nA separate method.\n", 0},
		githubArchiveEntry{"root/skills/review/nested/large.bin", strings.Repeat("x", koiSkillFileBytes+1), 0},
		githubArchiveEntry{"root/docs/unrelated.bin", strings.Repeat("x", koiSkillFileBytes+1), 0},
		githubArchiveEntry{"root/docs/private-example.txt", "-----BEGIN OPENSSH PRIVATE KEY-----\nexample\n-----END OPENSSH PRIVATE KEY-----", 0},
	)
	for _, exact := range []bool{false, true} {
		files, err := readKoiGitHubArchive(context.Background(), bytes.NewReader(archive), int64(len(archive)), "skills/review", exact)
		wantCount := 5
		if exact {
			wantCount = 3
		}
		if err != nil || len(files) != wantCount {
			t.Fatalf("exact=%v: %d files, %v", exact, len(files), err)
		}
		for _, file := range files {
			if strings.HasPrefix(file.Path, "docs/") || exact && strings.Contains(file.Path, "/nested/") {
				t.Fatalf("unselected member read: %s", file.Path)
			}
			if file.SizeBytes > koiSkillFileBytes {
				if len(file.Content) != 0 || file.SHA256 != "" || file.Path != "skills/review/nested/large.bin" {
					t.Fatalf("oversized member must retain only rejection metadata: %+v", file)
				}
				continue
			}
			if file.SizeBytes != int64(len(file.Content)) || file.SHA256 != koiDigest(file.Content) || file.MimeType == "" {
				t.Fatalf("member metadata does not match its bytes: %+v", file)
			}
		}
		if license := koiSkillLicense(nil, files, "skills/review"); license != "MIT License" {
			t.Fatalf("ancestor license was lost: %q", license)
		}
	}
}

func TestKoiGitHubArchiveValidatesAllPaths(t *testing.T) {
	for _, bad := range []githubArchiveEntry{
		{"root/docs/../escape.txt", "x", 0},
		{"root/docs/link", "../review/SKILL.md", os.ModeSymlink | 0600},
		{"other-root/docs/file.txt", "x", 0},
		{"root/review/SKILL.md", "duplicate", 0},
		{"root/docs", "file conflicts with directory", 0},
	} {
		t.Run(bad.name, func(t *testing.T) {
			archive := githubArchive(t,
				githubArchiveEntry{"root/review/SKILL.md", "# Review", 0},
				githubArchiveEntry{"root/docs/file.txt", "unselected", 0}, bad)
			files, err := readKoiGitHubArchive(context.Background(), bytes.NewReader(archive), int64(len(archive)), "review", true)
			if files != nil || !errors.Is(err, errAgentGitHubArchiveInvalid) {
				t.Fatalf("unsafe archive accepted: %v", err)
			}
		})
	}
}

func TestKoiGitHubArchiveRejectsSelectedSensitiveContent(t *testing.T) {
	archive := githubArchive(t,
		githubArchiveEntry{"root/review/SKILL.md", "# Review", 0},
		githubArchiveEntry{"root/review/private.key", "-----BEGIN OPENSSH PRIVATE KEY-----\nexample\n-----END OPENSSH PRIVATE KEY-----", 0})
	files, err := readKoiGitHubArchive(context.Background(), bytes.NewReader(archive), int64(len(archive)), "review", true)
	var sensitive *agentWorkspaceSensitiveError
	if files != nil || !errors.As(err, &sensitive) || sensitive.Path != "review/private.key" {
		t.Fatalf("sensitive package did not fail atomically: %v", err)
	}
}

func TestKoiGitHubArchiveImportLimits(t *testing.T) {
	for _, over := range []bool{false, true} {
		t.Run(fmt.Sprintf("file count over=%v", over), func(t *testing.T) {
			entries := []githubArchiveEntry{{"root/SKILL.md", "# Review", 0}}
			count := koiSkillImportFiles
			if over {
				count++
			}
			for i := 1; i < count; i++ {
				entries = append(entries, githubArchiveEntry{fmt.Sprintf("root/ref-%d.txt", i), "", 0})
			}
			archive := githubArchive(t, entries...)
			files, err := readKoiGitHubArchive(context.Background(), bytes.NewReader(archive), int64(len(archive)), "", true)
			if over {
				if files != nil || !errors.Is(err, errKoiSkillTooLarge) {
					t.Fatalf("file count limit not enforced: %d, %v", len(files), err)
				}
			} else if err != nil || len(files) != count {
				t.Fatalf("valid boundary rejected: %d, %v", len(files), err)
			}
		})
		t.Run(fmt.Sprintf("byte count over=%v", over), func(t *testing.T) {
			entries := []githubArchiveEntry{{"root/SKILL.md", "#", 0}}
			content := strings.Repeat("x", koiSkillFileBytes)
			for i := 0; i < koiSkillImportBytes/koiSkillFileBytes-1; i++ {
				entries = append(entries, githubArchiveEntry{fmt.Sprintf("root/ref-%d.txt", i), content, 0})
			}
			last := content[:len(content)-1]
			if over {
				last = content
			}
			entries = append(entries, githubArchiveEntry{"root/last.txt", last, 0})
			archive := githubArchive(t, entries...)
			files, err := readKoiGitHubArchive(context.Background(), bytes.NewReader(archive), int64(len(archive)), "", true)
			if over {
				if files != nil || !errors.Is(err, errKoiSkillTooLarge) {
					t.Fatalf("byte count limit not enforced: %v", err)
				}
			} else if err != nil || len(files) != len(entries) {
				t.Fatalf("valid boundary rejected: %d, %v", len(files), err)
			}
		})
	}
}

func TestKoiGitHubDownloadUsesPinnedSharedTransport(t *testing.T) {
	archive := githubArchive(t,
		githubArchiveEntry{"root/review/SKILL.md", "# Review", 0},
		githubArchiveEntry{"root/docs/unrelated.bin", strings.Repeat("x", koiSkillFileBytes+1), 0})
	for _, token := range []string{"", "test-token"} {
		name := "public"
		if token != "" {
			name = "private"
		}
		t.Run(name, func(t *testing.T) {
			client := githubImportClient(t, archive, token, token != "")
			transport := client.Transport
			downloads := 0
			client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
				if r.URL.Host == githubCodeLoadHost {
					downloads++
					if r.URL.Path != "/Octo/demo/zip/"+githubTestSHA {
						t.Errorf("archive is not pinned to the resolved commit: %s", r.URL.Path)
					}
				}
				return transport.RoundTrip(r)
			})
			app := &App{githubHTTPClient: client}
			files, err := app.downloadKoiGitHubRepository(context.Background(), "Octo", "demo", githubTestSHA, token, "review", true)
			if err != nil || len(files) != 1 || files[0].Path != "review/SKILL.md" || string(files[0].Content) != "# Review" || downloads != 1 {
				t.Fatalf("pinned selective download: %d files, %d downloads, %v", len(files), downloads, err)
			}
		})
	}
}
