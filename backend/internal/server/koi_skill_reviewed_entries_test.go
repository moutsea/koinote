package server

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"koinote/backend/internal/model"
)

func TestKoiUnavailableSkillCanBeDisabledBeforeReviewRestores(t *testing.T) {
	ctx := context.Background()
	a, user, _ := writingTestApp(t)
	a.cfg.KoiSkillTestAccounts = []string{user.AuthUserID}
	skill := koiExistingLibraryFixture(t, a, user.ID, "github", map[string]any{"repositoryId": 11}, "# Review writing", true)
	oldTask := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), model.Document{}, "Review")
	koiTestCuration(t, a, koiReviewedRepository{RepositoryID: 11, RepositoryURL: "https://github.com/review/writing", Packages: map[string]string{}})
	var detail struct{ Skill koiSkillInstallation }
	decodeJSONResponse(t, koiFolderRequest(t, a, user, "GET", "/api/koi/skills/"+skill.ID, nil, 200), &detail)
	if !detail.Skill.Enabled || detail.Skill.Compatibility.Conversation {
		t.Fatalf("availability must not replace the user's enabled setting: %+v", detail.Skill)
	}
	blocked := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), model.Document{}, "Review")
	if pins, err := a.koiTaskSkills(ctx, blocked); err != nil || len(pins) != 0 {
		t.Fatalf("unavailable skill entered a new task: %+v %v", pins, err)
	}
	decodeJSONResponse(t, koiFolderRequest(t, a, user, "PATCH", "/api/koi/skills/"+skill.ID, map[string]any{"expectedRevision": skill.Revision, "enabled": false}, 200), &detail)
	if detail.Skill.Enabled {
		t.Fatal("unavailable skill could not be disabled")
	}
	koiFolderRequest(t, a, user, "PATCH", "/api/koi/skills/"+skill.ID, map[string]any{"expectedRevision": detail.Skill.Revision, "enabled": true}, 422)
	if _, err := a.db.Exec(ctx, `UPDATE agent_repository_curation SET packages=$1 WHERE repository_id=11`, map[string]string{skill.ContentSHA256: "review"}); err != nil {
		t.Fatal(err)
	}
	next := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), model.Document{}, "Review")
	if pins, err := a.koiTaskSkills(ctx, next); err != nil || len(pins) != 0 {
		t.Fatalf("restored review re-enabled a skill the user switched off: %+v %v", pins, err)
	}
	if pins, err := a.koiTaskSkills(ctx, oldTask); err != nil || len(pins) != 1 || pins[0].VersionID != skill.VersionID {
		t.Fatalf("review/toggle rewrote an existing task: %+v %v", pins, err)
	}
}

func TestKoiReviewedCapabilitiesRestoreExistingAndCachedState(t *testing.T) {
	ctx := context.Background()
	a, user, doc := writingTestApp(t)
	a.cfg.KoiSkillTestAccounts = []string{user.AuthUserID}
	files := map[string]string{"SKILL.md": "---\nname: review-writing\ndescription: Polish current article.\n---\nPolish the text."}
	candidates, _ := koiSkillCandidates(koiCandidateTestFiles(files))
	digest := candidates[0].ContentSHA256
	koiTestCuration(t, a, koiReviewedRepository{RepositoryID: 11, RepositoryURL: "https://github.com/review/writing", Packages: map[string]string{digest: "writing"}, RequiredCapabilities: map[string][]string{digest: {"network"}}})
	initial := koiFolderPreview(t, a, user, files)
	installed := koiTestConfirm(t, a, user, initial)
	old := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), model.Document{}, "Review")
	cached := koiFolderPreview(t, a, user, files)
	// Reconstruct a version written before declared and reviewed capabilities
	// were separated. Existing task snapshots must remain unchanged.
	if _, err := a.db.Exec(ctx, `UPDATE koi_skill_versions SET rules_version=3,compatibility=$2 WHERE id=$1`, installed.VersionID, installed.Compatibility); err != nil {
		t.Fatal(err)
	}
	if _, err := a.db.Exec(ctx, `UPDATE agent_repository_curation SET required_capabilities='{}' WHERE repository_id=11`); err != nil {
		t.Fatal(err)
	}
	refreshed := koiFolderView(t, koiFolderRequest(t, a, user, "GET", "/api/koi/skill-imports/"+cached.ID, nil, 200))
	if !refreshed.Candidates[0].Compatibility.Article {
		t.Fatal("cached preview retained a removed review restriction")
	}
	current, err := a.loadKoiInstallation(ctx, a.db, user.ID, installed.ID)
	if err != nil || !current.Compatibility.Article || current.VersionID != installed.VersionID || !current.Enabled {
		t.Fatalf("installation did not recover in place: %+v %v", current, err)
	}
	if again := koiTestConfirm(t, a, user, refreshed); again.ID != installed.ID || !again.Compatibility.Article {
		t.Fatalf("identical reinstall retained stale capabilities: %+v", again)
	}
	receipt, err := a.loadKoiImport(ctx, a.db, user.ID, initial.ID, false)
	if err != nil || len(receipt.Installed) != 1 || !receipt.Installed[0].Compatibility.Article {
		t.Fatalf("receipt retained obsolete entry advice: %+v %v", receipt, err)
	}
	article := agentTestTask(t, a, user, koiArticleSession(t, a, user, doc), model.Document{}, "Polish")
	if pins, err := a.koiTaskSkills(ctx, article); err != nil || len(pins) != 1 || !pins[0].Compatibility.Article {
		t.Fatalf("new article lost the restored Skill: %+v %v", pins, err)
	}
	if _, err := a.db.Exec(ctx, `UPDATE agent_repository_curation SET required_capabilities=$1 WHERE repository_id=11`, map[string][]string{digest: {"network"}}); err != nil {
		t.Fatal(err)
	}
	if pins, err := a.koiTaskSkills(ctx, article); err != nil || len(pins) != 1 || !pins[0].Compatibility.Article {
		t.Fatalf("review rewrote the running article snapshot: %+v %v", pins, err)
	}
	if pins, err := a.koiTaskSkills(ctx, old); err != nil || len(pins) != 1 || pins[0].Compatibility.Article {
		t.Fatalf("refresh rewrote the old conversation snapshot: %+v %v", pins, err)
	}
}

func TestKoiReviewedNetworkPolicyForNewImports(t *testing.T) {
	a, user, doc := writingTestApp(t)
	a.cfg.KoiSkillTestAccounts = []string{user.AuthUserID}
	files := map[string]string{"SKILL.md": "---\nname: reviewed-research\ndescription: Research current sources.\n---\nSearch the web before drafting."}
	candidates, rejected := koiSkillCandidates(koiCandidateTestFiles(files))
	if len(candidates) != 1 || len(rejected) != 0 {
		t.Fatal("invalid test package")
	}
	digest := candidates[0].ContentSHA256
	koiTestCuration(t, a, koiReviewedRepository{RepositoryID: 11, RepositoryURL: "https://github.com/review/research", Packages: map[string]string{digest: "research"}, RequiredCapabilities: map[string][]string{digest: {"network"}}})
	preview := koiFolderPreview(t, a, user, files)
	if len(preview.Candidates) != 1 || preview.Candidates[0].Compatibility.Article || !preview.Candidates[0].Compatibility.Conversation {
		t.Fatalf("new preview did not apply content requirements: %+v", preview)
	}
	skill := koiTestConfirm(t, a, user, preview)
	if skill.Compatibility.Article || !skill.Compatibility.Conversation {
		t.Fatalf("confirmation lost the reviewed entry scope: %+v", skill)
	}
	article := agentTestTask(t, a, user, koiArticleSession(t, a, user, doc), model.Document{}, "Research current sources")
	if pins, err := a.koiTaskSkills(context.Background(), article); err != nil || len(pins) != 0 {
		t.Fatalf("article loaded a newly installed network-only skill: %+v %v", pins, err)
	}
}

func TestKoiReviewedNetworkPolicyForExistingInstallations(t *testing.T) {
	digest := strings.Repeat("a", 64)
	for _, kind := range []string{"github", "hub", "migration", "folder"} {
		t.Run(kind, func(t *testing.T) {
			a, user, doc := writingTestApp(t)
			koiTestCuration(t, a, koiReviewedRepository{RepositoryID: 11, RepositoryURL: "https://github.com/review/research", Packages: map[string]string{digest: "research"}, RequiredCapabilities: map[string][]string{digest: {"network"}}})
			a.cfg.KoiSkillTestAccounts = []string{user.AuthUserID}
			ctx := context.Background()
			// Older installs have no declared requirements and may have lost the
			// upstream identity. Reviewed capabilities still apply to those bytes.
			network := koiExistingLibraryFixture(t, a, user.ID, kind, map[string]any{}, "# Research", true)
			if _, err := a.db.Exec(ctx, `UPDATE koi_skill_versions SET content_sha256=$2 WHERE id=$1`, network.VersionID, digest); err != nil {
				t.Fatal(err)
			}
			offline := koiExistingLibraryFixture(t, a, user.ID, "folder", map[string]any{}, "# Polish the current article", true)
			var page struct{ Skills []koiSkillInstallation }
			w := koiFolderRequest(t, a, user, "GET", "/api/koi/skills?state=enabled", nil, 200)
			if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil || len(page.Skills) != 2 {
				t.Fatalf("conversation-compatible skills disappeared: %s %v", w.Body.String(), err)
			}
			for _, skill := range page.Skills {
				if skill.ID == network.ID && (!skill.Compatibility.Conversation || skill.Compatibility.Article || !slices.Contains(skill.Compatibility.Warnings, "article_capability_unavailable:network")) {
					t.Fatalf("installed list did not reflect capability review: %+v", skill)
				}
			}
			article := agentTestTask(t, a, user, koiArticleSession(t, a, user, doc), model.Document{}, "Polish the article")
			pins, err := a.koiTaskSkills(ctx, article)
			if err != nil || len(pins) != 1 || pins[0].VersionID != offline.VersionID {
				t.Fatalf("new article task included network-only skills: %+v %v", pins, err)
			}
			article.WorkspaceID = "review-article-task"
			_, loaded, err := a.agentLoadSkill(context.WithValue(ctx, writingMCPContext{}, article), nil, agentLoadSkillInput{SkillID: network.ID, Version: network.VersionID})
			if err != nil || loaded["available"] != false {
				t.Fatalf("article bypassed scope via direct skill load: %+v %v", loaded, err)
			}
			conversation := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), model.Document{}, "Research current sources")
			pins, err = a.koiTaskSkills(ctx, conversation)
			if err != nil || len(pins) != 2 {
				t.Fatalf("conversation lost its network skill: %+v %v", pins, err)
			}
			for _, pin := range pins {
				if _, err := a.koiSkillPackageFor(ctx, pin); err != nil {
					t.Fatal(err)
				}
			}
			// Reconstruct a task pinned before the policy was corrected. Reading
			// the library must not rewrite that task's immutable version metadata.
			if _, err := a.db.Exec(ctx, `INSERT INTO agent_task_skill_versions(task_id,version_id) VALUES($1,$2)`, article.ID, network.VersionID); err != nil {
				t.Fatal(err)
			}
			if _, err := a.loadKoiInstallation(ctx, a.db, user.ID, network.ID); err != nil {
				t.Fatal(err)
			}
			if pins, err = a.koiTaskSkills(ctx, article); err != nil || len(pins) != 2 {
				t.Fatalf("library review rewrote an existing task snapshot: %+v %v", pins, err)
			}
		})
	}
}

func TestKoiReviewedNetworkPolicyRefreshesCachedPreviewAndReceipt(t *testing.T) {
	a, user, _ := writingTestApp(t)
	a.cfg.KoiSkillTestAccounts = []string{user.AuthUserID}
	digest := strings.Repeat("b", 64)
	koiTestCuration(t, a, koiReviewedRepository{RepositoryID: 11, RepositoryURL: "https://github.com/review/research", Packages: map[string]string{digest: "research"}, RequiredCapabilities: map[string][]string{digest: {"network"}}})
	request, _ := randomUUID()
	view := koiFolderView(t, koiFolderRequest(t, a, user, "POST", "/api/koi/skill-imports", koiImportRequest{RequestID: request, SourceKind: "folder", DeclaredPaths: []string{"SKILL.md"}}, 202))
	koiFolderUpload(t, a, user, view.ID, "SKILL.md", "# Content strategy", 200)
	view = koiFolderView(t, koiFolderRequest(t, a, user, "POST", "/api/koi/skill-imports/"+view.ID+"/analyze", nil, 200))
	view.Candidates[0].ContentSHA256 = digest
	if _, err := a.db.Exec(context.Background(), `UPDATE koi_skill_imports SET candidates=$2 WHERE id=$1`, view.ID, view.Candidates); err != nil {
		t.Fatal(err)
	}
	updated := koiFolderView(t, koiFolderRequest(t, a, user, "GET", "/api/koi/skill-imports/"+view.ID, nil, 200))
	if updated.Revision != view.Revision || updated.Candidates[0].Compatibility.Article || !updated.Candidates[0].Compatibility.Conversation {
		t.Fatalf("cached preview retained stale entry advice or changed identity: %+v", updated)
	}
	result := map[string]any{"installed": []koiSkillInstallation{{ContentSHA256: digest, Compatibility: koiSkillCompatibility{Conversation: true, Article: true}}}, "confirmationHash": "original-receipt"}
	if _, err := a.db.Exec(context.Background(), `UPDATE koi_skill_imports SET status='committed',result=$2 WHERE id=$1`, view.ID, result); err != nil {
		t.Fatal(err)
	}
	updated, err := a.loadKoiImport(context.Background(), a.db, user.ID, view.ID, false)
	if err != nil || updated.confirmationHash != "original-receipt" || len(updated.Installed) != 1 || updated.Installed[0].Compatibility.Article || !updated.Installed[0].Compatibility.Conversation {
		t.Fatalf("confirmation receipt showed obsolete entry advice: %+v %v", updated, err)
	}
}

// Reviewed requirements apply to local uploads even when a standalone folder
// does not include the repository's inherited license/provenance files.
func TestKoiReviewedLocalDependenciesCoverFolderAndExistingTasks(t *testing.T) {
	for _, tc := range []struct {
		name, instructions    string
		reasons, capabilities []string
	}{
		{"local commands", "Run bash scripts/check.sh before writing to ~/.local-workflow/.", []string{"local_command:shell"}, []string{"shell", "filesystem_write"}},
		{"local files", "Read ~/.local-workflow/sessions/ to restore the previous diagnosis.", []string{"file_system_read:filesystem_read"}, []string{"filesystem_read"}},
		{"local knowledge library", "Scan the user's knowledge directory and update its navigation files.", []string{"file_system_read:filesystem_read", "file_system_write:filesystem_write"}, []string{"filesystem_read", "filesystem_write"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			a, user, doc := writingTestApp(t)
			a.cfg.KoiSkillTestAccounts = []string{user.AuthUserID}
			enableRepositoryR2Fixture(t, a)
			t.Cleanup(func() { _, _ = a.db.Exec(ctx, `DELETE FROM users WHERE id=$1`, user.ID) })
			source := koiCandidateTestFiles(map[string]string{
				"LICENSE":                       "Test notice",
				"skills/local/SKILL.md":         "---\nname: local-workflow\ndescription: Manage local work.\n---\n" + tc.instructions,
				"skills/local/scripts/check.sh": "exit 0\n",
			})
			candidates, rejected := koiSkillCandidates(source)
			if len(candidates) != 1 || len(rejected) != 0 {
				t.Fatal("invalid source fixture")
			}
			full, folder := map[string]string{}, map[string]string{}
			for _, file := range candidates[0].Files {
				full[file.Path] = string(file.Content)
				if !strings.HasPrefix(file.Path, "_provenance/") {
					folder[file.Path] = string(file.Content)
				}
			}
			decorated := map[string]string{"README.md": "Private library import instructions."}
			for path, content := range folder {
				decorated[path] = content
			}
			variants := []map[string]string{full, folder, decorated}
			var cached []koiSkillImportView
			var installed []koiSkillInstallation
			digests := map[string]bool{}
			for _, files := range variants {
				preview := koiFolderPreview(t, a, user, files)
				installed = append(installed, koiTestConfirm(t, a, user, preview))
				cached = append(cached, koiFolderPreview(t, a, user, files))
				digests[preview.Candidates[0].ContentSHA256] = true
			}
			if len(digests) != len(variants) {
				t.Fatal("source variants did not exercise distinct content digests")
			}
			requirements := map[string][]string{koiSkillEntryDigest(candidates[0].Instructions): tc.capabilities}
			old := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), model.Document{}, "Existing work")
			// These digests are intentionally outside the approved package set. Their
			// requirements must still restrict imports without a trusted repository ID.
			koiTestCuration(t, a, koiReviewedRepository{RepositoryID: 11, RepositoryURL: "https://github.com/review/local", Packages: map[string]string{}, RequiredCapabilities: requirements})
			for index, skill := range installed {
				current, err := a.loadKoiInstallation(ctx, a.db, user.ID, skill.ID)
				if err != nil || current.Compatibility.Conversation || current.Compatibility.Article {
					t.Fatalf("existing local skill retained unsupported availability: %+v %v", current, err)
				}
				for _, reason := range tc.reasons {
					if !slices.Contains(current.Compatibility.Reasons, reason) {
						t.Fatalf("existing local skill lost dependency %s: %+v", reason, current)
					}
				}
				preview := koiFolderView(t, koiFolderRequest(t, a, user, "GET", "/api/koi/skill-imports/"+cached[index].ID, nil, 200))
				if preview.Candidates[0].Compatibility.Conversation || preview.Candidates[0].Compatibility.Article {
					t.Fatal("cached preview retained unsupported availability")
				}
				koiFolderRequest(t, a, user, "POST", "/api/koi/skill-imports/"+preview.ID+"/confirm", koiFolderConfirmation(preview), 409)
			}
			for _, files := range variants {
				view := koiFolderCreate(t, a, user, files)
				for path, content := range files {
					koiFolderUpload(t, a, user, view.ID, path, content, 200)
				}
				view = koiFolderView(t, koiFolderRequest(t, a, user, "POST", "/api/koi/skill-imports/"+view.ID+"/analyze", nil, 200))
				if view.Status != "failed" || len(view.Candidates) != 0 || len(view.Rejected) != 1 || view.Rejected[0].Reason != "incompatible" {
					t.Fatalf("local import bypassed dependency review: %+v", view)
				}
			}
			for _, session := range []agentSession{agentTestSession(t, a, user, "review"), koiArticleSession(t, a, user, doc)} {
				task := agentTestTask(t, a, user, session, model.Document{}, "New work")
				if pins, err := a.koiTaskSkills(ctx, task); err != nil || len(pins) != 0 {
					t.Fatalf("new task pinned a local dependency: %+v %v", pins, err)
				}
			}
			pins, err := a.koiTaskSkills(ctx, old)
			if err != nil || len(pins) != len(variants) || !pins[0].Compatibility.Conversation || !pins[1].Compatibility.Conversation {
				t.Fatalf("review rewrote running task snapshots: %+v %v", pins, err)
			}
		})
	}
}
