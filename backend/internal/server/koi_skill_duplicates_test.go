package server

import (
	"context"
	"encoding/json"
	"testing"

	"koinote/backend/internal/model"
)

func koiDuplicateArchive(t *testing.T, version string) []byte {
	t.Helper()
	entries := []githubArchiveEntry{}
	for _, dir := range []string{"claude-plugin/review", "gemini-extension/review", "skills/review"} {
		entries = append(entries, githubArchiveEntry{"root/" + dir + "/SKILL.md", "---\nname: review\ndescription: Review writing\n---\n" + version, 0})
	}
	return githubArchive(t, entries...)
}

func TestKoiGitHubDuplicateCopiesReuseInstallationAndTracking(t *testing.T) {
	a, user, _ := writingTestApp(t)
	a.cfg.KoiSkillTestAccounts = []string{user.AuthUserID}
	a.githubHTTPClient = koiReviewGitHubClient(t, koiDuplicateArchive(t, "First guidance"), 123)
	create := func(dir string) koiSkillImportView {
		request, _ := randomUUID()
		return koiFolderView(t, koiFolderRequest(t, a, user, "POST", "/api/koi/skill-imports", koiImportRequest{RequestID: request, SourceKind: "github", RepositoryURL: "https://github.com/Octo/demo", Path: dir}, 202))
	}
	full := create("")
	if len(full.Candidates) != 1 || full.Candidates[0].Directory != "skills/review" {
		t.Fatalf("duplicate adapters were not grouped: %+v", full.Candidates)
	}
	first := koiTestConfirm(t, a, user, create("gemini-extension/review"))
	oldTask := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), model.Document{}, "Review version one")
	full = create("")
	if len(full.Candidates) != 1 || full.Candidates[0].InstalledID != first.ID || full.Candidates[0].InstalledStatus != "installed" || full.Candidates[0].Directory != "gemini-extension/review" {
		t.Fatalf("existing adapter identity lost: %+v", full.Candidates)
	}
	alias := create("skills/review")
	if alias.Candidates[0].InstalledStatus != "installed" || koiTestConfirm(t, a, user, alias).ID != first.ID {
		t.Fatal("installing a different adapter created another installation")
	}
	koiFolderRequest(t, a, user, "PATCH", "/api/koi/skills/"+first.ID, map[string]any{"expectedRevision": first.Revision, "enabled": false}, 200)
	a.githubHTTPClient = koiReviewGitHubClient(t, koiDuplicateArchive(t, "Updated guidance"), 123)
	update := create("")
	if len(update.Candidates) != 1 || update.Candidates[0].InstalledStatus != "update" || update.Candidates[0].Directory != "gemini-extension/review" {
		t.Fatalf("adapter update did not preserve its tracking path: %+v", update.Candidates)
	}
	second := koiTestConfirm(t, a, user, update)
	if second.ID != first.ID || second.Enabled || second.Source["path"] != first.Source["path"] {
		t.Fatalf("adapter update changed installation identity/state: %+v", second)
	}
	pins, err := a.koiTaskSkills(context.Background(), oldTask)
	if err != nil || len(pins) != 1 || pins[0].VersionID != first.VersionID {
		t.Fatalf("update changed running task's fixed version: %+v %v", pins, err)
	}
	usage, err := a.storageUsageFor(context.Background(), user.ID)
	if err != nil || usage.KoiSkillBytes != first.SizeBytes+second.SizeBytes {
		t.Fatalf("duplicate copies inflated quota: %+v %v", usage, err)
	}
	// A different repository with the same content remains independent.
	a.githubHTTPClient = koiReviewGitHubClient(t, koiDuplicateArchive(t, "Updated guidance"), 456)
	other := create("skills/review")
	if other.Candidates[0].InstalledStatus != "" || koiTestConfirm(t, a, user, other).ID == first.ID {
		t.Fatal("identical bytes from independent sources were merged")
	}
}

func TestKoiDuplicateConfirmationHandlesOldPreviewsAndConcurrentAliases(t *testing.T) {
	for _, scenario := range []string{"old_preview", "concurrent_aliases"} {
		t.Run(scenario, func(t *testing.T) {
			a, user, _ := writingTestApp(t)
			a.cfg.KoiSkillTestAccounts = []string{user.AuthUserID}
			a.githubHTTPClient = koiReviewGitHubClient(t, koiDuplicateArchive(t, "Review the article"), 123)
			create := func(dir string) koiSkillImportView {
				request, _ := randomUUID()
				return koiFolderView(t, koiFolderRequest(t, a, user, "POST", "/api/koi/skill-imports", koiImportRequest{RequestID: request, SourceKind: "github", RepositoryURL: "https://github.com/Octo/demo", Path: dir}, 202))
			}
			full := create("")
			if scenario == "old_preview" {
				analysis, err := a.koiAnalyzeSource(context.Background(), user.ID, full.Source)
				if err != nil {
					t.Fatal(err)
				}
				raw, _ := json.Marshal(analysis.candidates)
				if _, err = a.db.Exec(context.Background(), `UPDATE koi_skill_imports SET candidates=$2 WHERE id=$1`, full.ID, raw); err != nil {
					t.Fatal(err)
				}
				full = koiFolderView(t, koiFolderRequest(t, a, user, "GET", "/api/koi/skill-imports/"+full.ID, nil, 200))
				if len(full.Candidates) != 3 {
					t.Fatal("old preview fixture must contain all three adapters")
				}
				koiTestConfirm(t, a, user, full)
			} else {
				alias := create("gemini-extension/review")
				type result struct {
					installed []koiSkillInstallation
					err       error
				}
				results := make(chan result, 2)
				for _, view := range []koiSkillImportView{full, alias} {
					input := koiFolderConfirmation(view)
					go func() {
						installed, err := a.confirmKoiImport(context.Background(), user, view.ID, input)
						results <- result{installed, err}
					}()
				}
				var id string
				for i := 0; i < 2; i++ {
					result := <-results
					if result.err != nil || len(result.installed) != 1 {
						t.Fatalf("concurrent alias confirmation: %+v %v", result.installed, result.err)
					}
					if id != "" && id != result.installed[0].ID {
						t.Fatal("concurrent aliases created separate installations")
					}
					id = result.installed[0].ID
				}
			}
			var count int
			if err := a.db.QueryRow(context.Background(), `SELECT count(*) FROM koi_skill_installations WHERE user_id=$1 AND deleted_at IS NULL`, user.ID).Scan(&count); err != nil || count != 1 {
				t.Fatalf("duplicate installations persisted: %d %v", count, err)
			}
		})
	}
}

func TestKoiHubDuplicatePackagesInstallOnce(t *testing.T) {
	app, _, workspace, _ := koiHubSourceTestApp(t, true, map[string]string{
		"claude-plugin/review/SKILL.md": "---\nname: review\ndescription: Review writing\n---\nReview.",
		"skills/review/SKILL.md":        "---\nname: review\ndescription: Review writing\n---\nReview.",
	})
	user := seedMCPUser(t, app.db, app, membershipTierLifetime)
	app.cfg.KoiSkillTestAccounts = []string{user.AuthUserID}
	t.Cleanup(func() { _, _ = app.db.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, user.ID) })
	request, _ := randomUUID()
	view := koiFolderView(t, koiFolderRequest(t, app, user, "POST", "/api/koi/skill-imports", koiImportRequest{RequestID: request, SourceKind: "hub", WorkspaceID: workspace.WorkspaceID}, 202))
	if len(view.Candidates) != 1 {
		t.Fatalf("Hub adapters duplicated: %+v", view.Candidates)
	}
	installed := koiTestConfirm(t, app, user, view)
	usage, err := app.storageUsageFor(context.Background(), user.ID)
	if err != nil || usage.KoiSkillBytes != installed.SizeBytes {
		t.Fatalf("Hub copies inflated quota: %+v %v", usage, err)
	}
}

func TestKoiDuplicateGroupingRetainsIndependentPackages(t *testing.T) {
	candidates := []koiSkillCandidate{{Name: "review", Directory: "a", ContentSHA256: "first"}, {Name: "review", Directory: "b", ContentSHA256: "second"}, {Name: "review", Directory: "c", ContentSHA256: "first"}}
	if groups := koiCandidateGroups("github", nil, candidates); len(groups) != 2 {
		t.Fatal("different content with the same name must remain separate")
	}
	if groups := koiCandidateGroups("migration", nil, candidates); len(groups) != 3 {
		t.Fatal("migration must retain independent source identities")
	}
}
