package server

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"koinote/backend/internal/config"
)

func koiHubSourceTestApp(t *testing.T, r2 bool, files map[string]string) (*App, int, agentWorkspaceView, *repositoryObjectFixture) {
	t.Helper()
	app := New(config.Config{SessionSecret: "hub-source-test", AppURL: "https://koinote.example"}, newGCTestPool(t))
	var objects *repositoryObjectFixture
	if r2 {
		objects = enableRepositoryR2Fixture(t, app)
	}
	user := seedMCPUser(t, app.db, app, membershipTierLifetime)
	ctx := context.Background()
	workspace, err := app.createAgentWorkspace(ctx, user.ID, "Review skills", "Published methods", "en")
	if err != nil {
		t.Fatal(err)
	}
	upserts := make([]agentWorkspaceFile, 0, len(files))
	for path, content := range files {
		upserts = append(upserts, repositoryTestFile(path, content))
	}
	workspace, err = app.patchAgentWorkspace(ctx, user.ID, workspace.WorkspaceID, workspace.Revision, upserts, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = app.setAgentRepositoryPublication(ctx, user.ID, workspace.WorkspaceID, workspace.Revision, "MIT", false); err != nil {
		t.Fatal(err)
	}
	app.githubHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		t.Errorf("Hub snapshot unexpectedly contacted GitHub: %s", r.URL)
		return nil, errors.New("unexpected GitHub request")
	})}
	return app, user.ID, workspace, objects
}

func TestKoiHubSourceReadsPublishedPackageOnly(t *testing.T) {
	for _, r2 := range []bool{false, true} {
		t.Run(fmt.Sprintf("r2=%v", r2), func(t *testing.T) {
			ctx := context.Background()
			publishedEntry := "\ufeff---\r\nname: review\r\ndescription: Review a document.\r\n---\r\n# Review v1"
			app, owner, workspace, objects := koiHubSourceTestApp(t, r2, map[string]string{
				"LICENSE": "MIT License", "review/SKILL.md": publishedEntry, "review/guide.md": "Published guide",
				"review/nested/SKILL.md": "# Independent child", "review/nested/large.bin": strings.Repeat("x", koiSkillFileBytes+1),
				"other/SKILL.md": "# Other", "docs/unrelated.bin": strings.Repeat("y", koiSkillFileBytes+1),
			})
			published, err := app.loadPublicAgentRepository(ctx, workspace.WorkspaceID, nil)
			if err != nil {
				t.Fatal(err)
			}
			// New private content and deletion must not alter the saved publication.
			if _, err = app.patchAgentWorkspace(ctx, owner, workspace.WorkspaceID, workspace.Revision,
				[]agentWorkspaceFile{repositoryTestFile("review/SKILL.md", "# Private v2"), repositoryTestFile("private/SKILL.md", "# Private skill")}, []string{"review/guide.md"}); err != nil {
				t.Fatal(err)
			}
			parentDigest := ""
			for _, exact := range []bool{true, false} {
				if objects != nil {
					objects.mu.Lock()
					objects.reads = 0
					objects.mu.Unlock()
				}
				result, err := app.readKoiHubSource(ctx, koiHubSourceInput{WorkspaceID: workspace.WorkspaceID,
					PublicationID: published.PublicationID, Revision: &published.Revision, Path: " /review/ ", ExactSkill: exact})
				if err != nil {
					t.Fatal(err)
				}
				if result.Path != "review" || result.ExactSkill != exact || result.Publication.PublicationID != published.PublicationID ||
					result.Publication.Revision != published.Revision || result.Publication.License != "MIT" || result.Publication.Name != "Review skills" {
					t.Fatalf("published source metadata changed: %+v", result)
				}
				paths := []string{}
				for _, file := range result.Files {
					paths = append(paths, file.Path)
					if file.SizeBytes > koiSkillFileBytes {
						if len(file.Content) != 0 || file.SHA256 == "" {
							t.Fatal("oversized file must retain metadata without reading bytes")
						}
						continue
					}
					if file.SHA256 != koiDigest(file.Content) || file.SizeBytes != int64(len(file.Content)) {
						t.Fatalf("unverified file: %s", file.Path)
					}
					if file.Path == "review/SKILL.md" && string(file.Content) != publishedEntry {
						t.Fatal("unpublished workspace content leaked into Hub source")
					}
				}
				want := []string{"LICENSE", "review/SKILL.md", "review/guide.md"}
				reads := 3
				if !exact {
					want = append(want, "review/nested/SKILL.md", "review/nested/large.bin")
					reads++
				}
				if !reflect.DeepEqual(paths, want) {
					t.Fatalf("wrong source scope: %v", paths)
				}
				candidates, rejected := koiSkillCandidates(result.Files, koiSkillSourceContext{
					Directory: result.Path, RootName: result.Publication.Name, License: result.Publication.License,
				})
				if len(candidates) != 1 || candidates[0].Directory != "" || candidates[0].FileCount != 3 || candidates[0].License != "MIT License" {
					t.Fatalf("published parent package changed during analysis: %+v", candidates)
				}
				if exact {
					parentDigest = candidates[0].ContentSHA256
					if len(rejected) != 0 {
						t.Fatalf("exact selection included rejected children: %+v", rejected)
					}
				} else if len(rejected) != 1 || rejected[0].Directory != "nested" || rejected[0].Reason != "file_too_large" || candidates[0].ContentSHA256 != parentDigest {
					t.Fatalf("invalid child affected the parent package: digest=%s, rejected=%+v", candidates[0].ContentSHA256, rejected)
				}
				if objects != nil {
					objects.mu.Lock()
					actual := objects.reads
					objects.mu.Unlock()
					if actual != reads {
						t.Fatalf("read %d objects, want only %d selected members", actual, reads)
					}
				}
			}
		})
	}
}

func TestKoiHubSourceRequiresLivePublicationIdentity(t *testing.T) {
	ctx := context.Background()
	app, owner, workspace, _ := koiHubSourceTestApp(t, false, map[string]string{"SKILL.md": "# Review"})
	source, err := app.readKoiHubSource(ctx, koiHubSourceInput{WorkspaceID: workspace.WorkspaceID})
	if err != nil || len(source.Files) == 0 {
		t.Fatalf("root selection failed: %+v %v", source, err)
	}
	expectError := func(input koiHubSourceInput, want error) {
		t.Helper()
		result, err := app.readKoiHubSource(ctx, input)
		if !errors.Is(err, want) || result.Publication != nil || len(result.Files) != 0 {
			t.Fatalf("input=%+v: got %+v %v, want %v", input, result, err, want)
		}
	}
	zero := int64(0)
	expectError(koiHubSourceInput{WorkspaceID: workspace.WorkspaceID, Revision: &zero}, errAgentWorkspaceConflict)
	expectError(koiHubSourceInput{WorkspaceID: workspace.WorkspaceID, PublicationID: "stale publication"}, errAgentWorkspaceConflict)
	// The same revision can be republished with different public metadata.
	if err = app.setAgentRepositoryPublication(ctx, owner, workspace.WorkspaceID, workspace.Revision, "Apache-2.0", false); err != nil {
		t.Fatal(err)
	}
	expectError(koiHubSourceInput{WorkspaceID: workspace.WorkspaceID, PublicationID: source.Publication.PublicationID}, errAgentWorkspaceConflict)
	if err = app.setAgentRepositoryPublication(ctx, owner, workspace.WorkspaceID, workspace.Revision, "", true); err != nil {
		t.Fatal(err)
	}
	expectError(koiHubSourceInput{WorkspaceID: workspace.WorkspaceID}, errAgentWorkspaceNotFound)
	if err = app.setAgentRepositoryPublication(ctx, owner, workspace.WorkspaceID, workspace.Revision, "MIT", false); err != nil {
		t.Fatal(err)
	}
	if _, err = app.db.Exec(ctx, `UPDATE agent_workspaces SET deleted_at=now() WHERE id=$1`, workspace.WorkspaceID); err != nil {
		t.Fatal(err)
	}
	expectError(koiHubSourceInput{WorkspaceID: workspace.WorkspaceID}, errAgentWorkspaceNotFound)
}

func TestKoiHubSourceRejectsPublicationChangeDuringRead(t *testing.T) {
	for _, withdraw := range []bool{false, true} {
		t.Run(fmt.Sprintf("withdraw=%v", withdraw), func(t *testing.T) {
			ctx := context.Background()
			app, owner, workspace, _ := koiHubSourceTestApp(t, true, map[string]string{"review/SKILL.md": "# Review"})
			store := app.agentObjectStore.(*workerAgentRepositoryObjects)
			client := *store.client
			base := client.Transport
			if base == nil {
				base = http.DefaultTransport
			}
			reads := 0
			client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
				response, err := base.RoundTrip(r)
				if r.Method == http.MethodGet {
					reads++
					// Only SKILL.md is selected. Change publication after its blob
					// lookup to exercise the final check after all network reads.
					if reads == 1 {
						if publishErr := app.setAgentRepositoryPublication(ctx, owner, workspace.WorkspaceID, workspace.Revision, "MIT", withdraw); publishErr != nil {
							t.Fatal(publishErr)
						}
					}
				}
				return response, err
			})
			store.client = &client
			result, err := app.readKoiHubSource(ctx, koiHubSourceInput{WorkspaceID: workspace.WorkspaceID, Path: "review"})
			want := errAgentWorkspaceConflict
			if withdraw {
				want = errAgentWorkspaceNotFound
			}
			if !errors.Is(err, want) || reads != 1 || result.Publication != nil {
				t.Fatalf("publication change accepted: %+v, reads=%d, %v", result, reads, err)
			}
		})
	}
}

func TestKoiHubSourceRejectsCorruptContent(t *testing.T) {
	for _, r2 := range []bool{false, true} {
		t.Run(fmt.Sprintf("r2=%v", r2), func(t *testing.T) {
			app, _, workspace, objects := koiHubSourceTestApp(t, r2, map[string]string{"SKILL.md": "# Review"})
			if r2 {
				objects.mu.Lock()
				objects.corruptRead = true
				objects.mu.Unlock()
			} else if _, err := app.db.Exec(context.Background(), `UPDATE agent_workspace_blobs SET content=$2 WHERE workspace_id=$1 AND sha256=$3`, workspace.WorkspaceID, []byte("# Broken"), koiDigest([]byte("# Review"))); err != nil {
				t.Fatal(err)
			}
			result, err := app.readKoiHubSource(context.Background(), koiHubSourceInput{WorkspaceID: workspace.WorkspaceID})
			if !errors.Is(err, errAgentRepositoryStorage) || result.Publication != nil {
				t.Fatalf("corrupt content accepted: %+v %v", result, err)
			}
		})
	}
}

func TestKoiHubSourceRejectsInvalidInputBeforeDatabaseRead(t *testing.T) {
	negative := int64(-1)
	for _, input := range []koiHubSourceInput{
		{}, {WorkspaceID: 1, Revision: &negative}, {WorkspaceID: 1, Path: "../review"}, {WorkspaceID: 1, Path: "review//nested"},
	} {
		if _, err := (&App{}).readKoiHubSource(context.Background(), input); err == nil {
			t.Fatalf("invalid input accepted: %+v", input)
		}
	}
}

func TestKoiHubSourceBoundsSelectedFiles(t *testing.T) {
	for _, tc := range []struct {
		name        string
		count, size int
	}{
		{"file count", koiSkillImportFiles, 1},
		{"total bytes", koiSkillImportBytes / koiSkillFileBytes, koiSkillFileBytes},
	} {
		t.Run(tc.name, func(t *testing.T) {
			files := map[string]string{"review/SKILL.md": "# Review"}
			for i := 0; i < tc.count; i++ {
				files[fmt.Sprintf("review/reference-%03d.txt", i)] = strings.Repeat("x", tc.size)
			}
			app, _, workspace, _ := koiHubSourceTestApp(t, false, files)
			result, err := app.readKoiHubSource(context.Background(), koiHubSourceInput{WorkspaceID: workspace.WorkspaceID, Path: "review"})
			if !errors.Is(err, errKoiSkillTooLarge) || result.Publication != nil || len(result.Files) != 0 {
				t.Fatalf("oversized selection returned content: files=%d, %v", len(result.Files), err)
			}
		})
	}
}
