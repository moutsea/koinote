package server

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"testing"
)

func TestGitHubArchiveMetadataAllowsSelectiveReads(t *testing.T) {
	archive := githubArchive(t,
		githubArchiveEntry{"root/LICENSE", "MIT License", 0},
		githubArchiveEntry{"root/skills/review/SKILL.md", "# Review", 0},
		githubArchiveEntry{"root/skills/review/references/guide.md", "Review guide", 0},
		githubArchiveEntry{"root/skills/review/nested/SKILL.md", "# Nested", 0},
		githubArchiveEntry{"root/skills/review/nested/large.bin", strings.Repeat("x", agentWorkspaceMaxFileBytes+1), 0},
	)
	ctx := context.Background()
	members, err := githubArchiveMembers(ctx, bytes.NewReader(archive), int64(len(archive)))
	if err != nil || len(members) != 5 {
		t.Fatalf("archive metadata: %d members, %v", len(members), err)
	}
	byPath := map[string]koiSkillFile{}
	for _, member := range members {
		byPath[member.Path] = koiSkillFile{Path: member.Path}
	}
	needed := koiSkillNeededPaths(byPath, "skills/review", true)
	want := map[string]string{
		"LICENSE":                           "MIT License",
		"skills/review/SKILL.md":            "# Review",
		"skills/review/references/guide.md": "Review guide",
	}
	if len(needed) != len(want) {
		t.Fatalf("selected package members: %v", needed)
	}
	for _, member := range members {
		if !needed[member.Path] {
			continue
		}
		content, err := readGitHubArchiveMember(ctx, member, 128<<10)
		if expected, ok := want[member.Path]; err != nil || !ok || string(content) != expected {
			t.Fatalf("selected member %q: %q, %v", member.Path, content, err)
		}
	}
	// Sharing metadata inspection must not relax the existing full-import limit.
	if _, err := readGitHubArchive(ctx, bytes.NewReader(archive), int64(len(archive))); !errors.Is(err, errAgentGitHubArchiveInvalid) {
		t.Fatalf("full repository import accepted an oversized member: %v", err)
	}
}

func TestGitHubArchiveDownloadReaderLifetime(t *testing.T) {
	archive := githubArchive(t, githubArchiveEntry{"root/SKILL.md", "# Review", 0})
	for _, readerErr := range []error{nil, errors.New("archive reader rejected the input")} {
		name := "success"
		if readerErr != nil {
			name = "reader error"
		}
		t.Run(name, func(t *testing.T) {
			app := &App{githubHTTPClient: githubImportClient(t, archive, "test-token", true)}
			var downloaded *os.File
			err := app.readGitHubRepositoryArchive(context.Background(), "Octo", "demo", githubTestSHA, "test-token", func(reader io.ReaderAt, size int64) error {
				var ok bool
				downloaded, ok = reader.(*os.File)
				if !ok || size != int64(len(archive)) {
					t.Fatalf("download must stay in a temporary file: %T, %d bytes", reader, size)
				}
				info, err := downloaded.Stat()
				if err != nil || info.Mode().Perm()&0077 != 0 {
					t.Fatalf("archive must stay private: %v, %v", info, err)
				}
				members, err := githubArchiveMembers(context.Background(), reader, size)
				if err != nil || len(members) != 1 || members[0].Path != "SKILL.md" {
					t.Fatalf("reader did not receive the pinned archive: %v", err)
				}
				return readerErr
			})
			if !errors.Is(err, readerErr) || downloaded == nil {
				t.Fatalf("reader result was lost: %v", err)
			}
			if _, err := downloaded.Stat(); !errors.Is(err, os.ErrClosed) {
				t.Fatalf("temporary archive was not closed: %v", err)
			}
			if _, err := os.Stat(downloaded.Name()); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("temporary archive was not removed: %v", err)
			}
		})
	}
}
