package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"

	"koinote/backend/internal/model"
)

// Reconstruct installations written by older releases, before adapter copies
// and undeclared dependencies were checked. Do not go through today's preview.
func koiExistingLibraryFixture(t *testing.T, a *App, userID int, kind string, source map[string]any, content string, enabled bool) koiSkillInstallation {
	t.Helper()
	id, _ := randomUUID()
	version := koiQuotaTestVersion(t, a, userID, id, content)
	raw, _ := json.Marshal(source)
	ctx := context.Background()
	if _, err := a.db.Exec(ctx, `UPDATE koi_skill_installations SET source_kind=$2,source=$3,current_version_id=$4,enabled=$5,description='Review writing' WHERE id=$1`, id, kind, raw, version, enabled); err != nil {
		t.Fatal(err)
	}
	digest := koiSkillContentDigest([]koiSkillFile{{Path: "SKILL.md", SHA256: koiDigest([]byte(content))}})
	if _, err := a.db.Exec(ctx, `UPDATE koi_skill_versions SET compatibility='{"conversation":true,"article":true}',rules_version=$2,description='Review writing',content_sha256=$3 WHERE id=$1`, version, koiSkillEntryRulesVersion, digest); err != nil {
		t.Fatal(err)
	}
	skill, err := a.loadKoiInstallation(ctx, a.db, userID, id)
	if err != nil {
		t.Fatal(err)
	}
	return skill
}

func koiApplyExistingLibraryMigration(t *testing.T, a *App) {
	t.Helper()
	raw, err := os.ReadFile("../../migrations/0118_koi_skill_existing_duplicates.sql")
	if err == nil {
		_, err = a.db.Exec(context.Background(), string(raw))
	}
	if err != nil {
		t.Fatal(err)
	}
}

func TestKoiExistingDuplicatesPreserveSnapshotsAndReleaseQuota(t *testing.T) {
	for _, kind := range []string{"github", "hub", "migration"} {
		t.Run(kind, func(t *testing.T) {
			a, user, _ := writingTestApp(t)
			a.cfg.KoiSkillTestAccounts = []string{user.AuthUserID}
			ctx := context.Background()
			source := map[string]any{"repositoryId": 123, "workspaceId": 7}
			first := koiExistingLibraryFixture(t, a, user.ID, kind, source, "# Review the article", true)
			second := koiExistingLibraryFixture(t, a, user.ID, kind, source, "# Review the article", true)
			old := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), model.Document{}, "old task")
			// New pinning already groups duplicates, including before migration.
			if pins, err := a.koiTaskSkills(ctx, old); err != nil || len(pins) != 1 {
				t.Fatalf("new task repeated a package: %+v %v", pins, err)
			}
			// Older tasks could have pinned both copies. Keep those exact versions.
			if _, err := a.db.Exec(ctx, `INSERT INTO agent_task_skill_versions(task_id,version_id) VALUES($1,$2),($1,$3) ON CONFLICT DO NOTHING`, old.ID, first.VersionID, second.VersionID); err != nil {
				t.Fatal(err)
			}
			if _, err := a.db.Exec(ctx, `UPDATE koi_skill_installations SET enabled=false WHERE id=$1`, first.ID); err != nil {
				t.Fatal(err)
			}
			for range 2 {
				koiApplyExistingLibraryMigration(t, a)
			}
			var deleted bool
			var revision int
			if err := a.db.QueryRow(ctx, `SELECT deleted_at IS NOT NULL,revision FROM koi_skill_installations WHERE id=$1`, first.ID).Scan(&deleted, &revision); err != nil || !deleted || revision != 2 {
				t.Fatalf("duplicate was not retired exactly once: %t %d %v", deleted, revision, err)
			}
			current, err := a.loadKoiInstallation(ctx, a.db, user.ID, second.ID)
			if err != nil || !current.Enabled || current.Revision != second.Revision {
				t.Fatalf("enabled canonical installation changed: %+v %v", current, err)
			}
			next := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), model.Document{}, "next task")
			if pins, err := a.koiTaskSkills(ctx, next); err != nil || len(pins) != 1 || pins[0].InstallationID != second.ID {
				t.Fatalf("new task did not use canonical copy: %+v %v", pins, err)
			}
			koiFolderRequest(t, a, user, "DELETE", fmt.Sprintf("/api/koi/skills/%s?expectedRevision=%d", second.ID, current.Revision), nil, 200)
			if err := a.cleanupKoiSkillVersionsForUser(ctx, user.ID); err != nil {
				t.Fatal(err)
			}
			pins, err := a.koiTaskSkills(ctx, old)
			if err != nil || len(pins) != 2 {
				t.Fatalf("migration/uninstall lost old snapshots: %+v %v", pins, err)
			}
			for _, pin := range pins {
				if _, err := a.koiSkillPackageFor(ctx, pin); err != nil {
					t.Fatalf("retained package cannot be loaded: %v", err)
				}
			}
			usage, err := a.storageUsageFor(ctx, user.ID)
			if err != nil || usage.KoiSkillBytes != first.SizeBytes {
				t.Fatalf("active duplicate pins overcharged quota: %+v %v", usage, err)
			}
			if _, err := a.db.Exec(ctx, `UPDATE writing_agent_tasks SET status='completed' WHERE id IN ($1,$2)`, old.ID, next.ID); err != nil {
				t.Fatal(err)
			}
			if err := a.cleanupKoiSkillVersionsForUser(ctx, user.ID); err != nil {
				t.Fatal(err)
			}
			usage, err = a.storageUsageFor(ctx, user.ID)
			if err != nil || usage.KoiSkillBytes != 0 {
				t.Fatalf("completed tasks retained logical quota: %+v %v", usage, err)
			}
		})
	}
}

func TestKoiExistingDuplicateBoundariesKeepIndependentPackages(t *testing.T) {
	a, user, _ := writingTestApp(t)
	a.cfg.KoiSkillTestAccounts = []string{user.AuthUserID}
	ctx := context.Background()
	var want int64
	for _, fixture := range []struct {
		kind    string
		source  map[string]any
		content string
	}{
		{"github", map[string]any{"repositoryId": 123}, "# Same"},
		{"github", map[string]any{"repositoryId": 123}, "# Different"},
		{"github", map[string]any{"repositoryId": 456}, "# Same"},
		{"hub", map[string]any{"workspaceId": 123}, "# Same"},
		{"github", map[string]any{}, "# Same"}, {"github", map[string]any{}, "# Same"},
		{"folder", map[string]any{}, "# Same"}, {"folder", map[string]any{}, "# Same"},
		{"migration", map[string]any{}, "# Same"},
		{"migration", map[string]any{"workspaceId": 123}, "# Same"},
		{"migration", map[string]any{"workspaceId": 123}, "# Different"},
		{"migration", map[string]any{"workspaceId": 456}, "# Same"},
	} {
		want += koiExistingLibraryFixture(t, a, user.ID, fixture.kind, fixture.source, fixture.content, true).SizeBytes
	}
	other := seedMCPUser(t, a.db, a, membershipTierLifetime)
	foreign := koiExistingLibraryFixture(t, a, other.ID, "github", map[string]any{"repositoryId": 123}, "# Same", true)
	koiApplyExistingLibraryMigration(t, a)
	task := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), model.Document{}, "review")
	if pins, err := a.koiTaskSkills(ctx, task); err != nil || len(pins) != 12 {
		t.Fatalf("independent packages were merged: %+v %v", pins, err)
	}
	usage, err := a.storageUsageFor(ctx, user.ID)
	if err != nil || usage.KoiSkillBytes != want {
		t.Fatalf("independent package quota changed: %+v %v", usage, err)
	}
	if _, err := a.loadKoiInstallation(ctx, a.db, other.ID, foreign.ID); err != nil {
		t.Fatalf("migration merged different accounts: %v", err)
	}
}

func TestKoiReviewedExistingLibraryOnlyExcludesNewTasks(t *testing.T) {
	for _, kind := range []string{"github", "hub", "migration"} {
		t.Run(kind, func(t *testing.T) {
			a, _, workspace, _ := koiHubSourceTestApp(t, false, map[string]string{"SKILL.md": "# Review"})
			koiTestCuration(t, a, koiReviewedRepository{RepositoryID: 1250162731, RepositoryURL: "https://github.com/Octo/demo", Packages: map[string]string{}})
			a.cfg.AgentGPTBaseURL, a.cfg.AgentGPTAPIKey = "https://agent.example.test", "test-key"
			a.cfg.AgentGPTAppID, a.cfg.AgentGPTSigningSecret = "test-app", "test-signing"
			user := seedMCPUser(t, a.db, a, membershipTierLifetime)
			grantLifetimeCreditsForTest(t, a.db, user.ID)
			a.cfg.KoiSkillTestAccounts = []string{user.AuthUserID}
			ctx := context.Background()
			workspaceID := workspace.WorkspaceID
			if kind == "migration" {
				workspaceID = agentSkillRepositoryForTest(t, a, user.ID, map[string]string{"SKILL.md": "# Review"})
			}
			source := map[string]any{"repositoryId": 123}
			if kind == "hub" || kind == "migration" {
				source = map[string]any{"workspaceId": workspaceID}
			}
			first := koiExistingLibraryFixture(t, a, user.ID, kind, source, "# Run an unsupported local publisher", true)
			old := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), model.Document{}, "old task")
			if kind == "github" {
				source["repositoryId"] = 1250162731
				raw, _ := json.Marshal(source)
				if _, err := a.db.Exec(ctx, `UPDATE koi_skill_installations SET source=$2 WHERE id=$1`, first.ID, raw); err != nil {
					t.Fatal(err)
				}
			} else if kind == "hub" {
				if _, err := a.db.Exec(ctx, `UPDATE agent_repository_publications SET github_source='{"repositoryId":1250162731}' WHERE workspace_id=$1`, workspace.WorkspaceID); err != nil {
					t.Fatal(err)
				}
			} else {
				if _, err := a.db.Exec(ctx, `UPDATE agent_workspaces SET github_source='{"repositoryId":1250162731}' WHERE id=$1`, workspaceID); err != nil {
					t.Fatal(err)
				}
			}
			current, err := a.loadKoiInstallation(ctx, a.db, user.ID, first.ID)
			if err != nil || current.Compatibility.Conversation || current.Compatibility.Article || !strings.Contains(strings.Join(current.Compatibility.Reasons, ","), "review_not_approved") {
				t.Fatalf("legacy installation bypassed review: %+v %v", current, err)
			}
			koiFolderRequest(t, a, user, "PATCH", "/api/koi/skills/"+first.ID, map[string]any{"expectedRevision": first.Revision, "enabled": true}, 422)
			if kind == "migration" {
				update := koiTestUpdate(t, a, user, first, "# Different local publisher")
				if update.Status != "failed" || len(update.Candidates) != 0 || len(update.Rejected) != 1 || update.Rejected[0].Reason != "not_reviewed" {
					t.Fatalf("manual migration replacement bypassed review: %+v", update)
				}
			}
			for n := range 20 {
				koiExistingLibraryFixture(t, a, user.ID, kind, source, fmt.Sprintf("# Unsupported %d", n), true)
			}
			koiExistingLibraryFixture(t, a, user.ID, "github", map[string]any{"repositoryId": 456}, "# Allowed", true)
			koiExistingLibraryFixture(t, a, user.ID, "github", map[string]any{"repositoryId": 456}, "# Disabled", false)
			for state, want := range map[string]int{"": 23, "unavailable": 21, "enabled": 1, "disabled": 1} {
				params := url.Values{"state": {state}}
				count := 0
				for {
					var page struct {
						Skills     []koiSkillInstallation
						NextCursor string
					}
					w := koiFolderRequest(t, a, user, "GET", "/api/koi/skills?"+params.Encode(), nil, 200)
					if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil {
						t.Fatal(err)
					}
					for _, skill := range page.Skills {
						if state == "unavailable" && skill.Compatibility.Conversation {
							t.Fatal("unavailable filter leaked a compatible Skill")
						}
					}
					count += len(page.Skills)
					if page.NextCursor == "" {
						break
					}
					params.Set("cursor", page.NextCursor)
				}
				if count != want {
					t.Fatalf("state %s returned %d, want %d", state, count, want)
				}
			}
			next := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), model.Document{}, "new task")
			if pins, err := a.koiTaskSkills(ctx, next); err != nil || len(pins) != 1 || pins[0].VersionID == first.VersionID {
				t.Fatalf("new task included rejected Skills: %+v %v", pins, err)
			}
			pins, err := a.koiTaskSkills(ctx, old)
			if err != nil || len(pins) != 1 || pins[0].VersionID != first.VersionID {
				t.Fatalf("review changed old snapshot: %+v %v", pins, err)
			}
			if _, err := a.koiSkillPackageFor(ctx, pins[0]); err != nil {
				t.Fatal(err)
			}
			if kind == "hub" || kind == "migration" {
				koiApplyExistingLibraryMigration(t, a)
				query := `DELETE FROM agent_repository_publications WHERE workspace_id=$1`
				if kind == "migration" {
					query = `DELETE FROM agent_workspaces WHERE id=$1`
				}
				if _, err := a.db.Exec(ctx, query, workspaceID); err != nil {
					t.Fatal(err)
				}
				current, err := a.loadKoiInstallation(ctx, a.db, user.ID, first.ID)
				if err != nil || current.Compatibility.Conversation {
					t.Fatalf("withdrawal lost the saved upstream review identity: %+v %v", current, err)
				}
			}
		})
	}
}
