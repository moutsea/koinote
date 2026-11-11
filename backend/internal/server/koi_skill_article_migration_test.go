package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"koinote/backend/internal/model"
)

func koiArticleSession(t *testing.T, a *App, user model.User, doc model.Document) agentSession {
	t.Helper()
	w := koiFolderRequest(t, a, user, "POST", "/api/documents/"+doc.DocID+"/koi-session", nil, 200)
	var out struct {
		Session agentSession `json:"session"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out.Session
}

func koiMigrationPreview(t *testing.T, a *App, user model.User) (koiSkillImportView, string) {
	t.Helper()
	request, _ := randomUUID()
	return koiFolderView(t, koiFolderRequest(t, a, user, "POST", "/api/koi/skill-imports", koiImportRequest{RequestID: request, SourceKind: "migration"}, 202)), request
}

func TestKoiArticleInstalledSkillsKeepScopeAndVersion(t *testing.T) {
	a, user, doc := writingTestApp(t)
	a.cfg.KoiSkillTestAccounts = []string{user.AuthUserID}
	ctx := context.Background()
	skill := koiRuntimeInstall(t, a, user, map[string]string{"method/SKILL.md": "---\nname: method\ndescription: Editing method\nrequiredTools: [read_file]\n---\nRead references/style.md.", "method/references/style.md": "Preserve the author’s voice."})
	web := koiRuntimeInstall(t, a, user, map[string]string{"web/SKILL.md": "---\nname: web\ndescription: Research\nrequiredTools: [web_fetch]\n---\nSearch first."})
	// A package installed before article support must pick up the new derived
	// compatibility without changing either its version or its source bytes.
	if _, err := a.db.Exec(ctx, `UPDATE koi_skill_versions SET rules_version=1,compatibility=jsonb_set(compatibility,'{article}','false') WHERE id=$1`, skill.VersionID); err != nil {
		t.Fatal(err)
	}
	task := agentTestTask(t, a, user, koiArticleSession(t, a, user, doc), model.Document{}, "润色当前文章")
	pinned, err := a.koiTaskSkills(ctx, task)
	if err != nil || len(pinned) != 1 || pinned[0].VersionID != skill.VersionID {
		t.Fatalf("article snapshot: %+v %v", pinned, err)
	}
	input := map[string]any{"policy": map[string]any{}}
	if err = a.prepareAgentConversationInput(ctx, &task, input, ""); err != nil {
		t.Fatal(err)
	}
	tools := input["policy"].(map[string]any)["allowTools"].([]string)
	for _, name := range []string{"koinote.find_skills", "koinote.load_skill", "skill_view", "read_file"} {
		if !slices.Contains(tools, name) {
			t.Fatalf("article tool missing: %s", name)
		}
	}
	for _, name := range []string{"koinote.propose_operations", "web_fetch", "web_search", "shell", "koinote.save_artifact"} {
		if slices.Contains(tools, name) {
			t.Fatalf("article authority expanded: %s", name)
		}
	}
	if !strings.Contains(input["systemPrompt"].(string), automaticAgentSkillInstructions) {
		t.Fatal("article is not told how to load Skills")
	}
	task.WorkspaceID = "article-workspace"
	toolCtx := context.WithValue(ctx, writingMCPContext{}, task)
	_, catalog, err := a.agentFindSkills(toolCtx, nil, agentSearchInput{})
	if err != nil || len(catalog["skills"].([]map[string]any)) != 1 {
		t.Fatalf("article catalog: %v %v", catalog, err)
	}
	_, unavailable, err := a.agentLoadSkill(toolCtx, nil, agentLoadSkillInput{SkillID: web.ID, Version: web.VersionID})
	if err != nil || unavailable["available"] != false {
		t.Fatalf("article loaded a web Skill: %v %v", unavailable, err)
	}
	var installed []map[string]any
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/connect"):
			fmt.Fprint(w, `{"state":"ready","tools":["get_document","propose_document_change","search_documents","list_folders","propose_operations","get_conversation","save_artifact","get_operation_results","find_skills","load_skill"]}`)
		case strings.HasSuffix(r.URL.Path, "/mcp"):
			fmt.Fprint(w, `{}`)
		case strings.HasSuffix(r.URL.Path, "/skills"):
			json.NewEncoder(w).Encode(installed)
		case strings.HasSuffix(r.URL.Path, "/install"):
			var pkg map[string]any
			if err := json.NewDecoder(r.Body).Decode(&pkg); err != nil {
				t.Error(err)
			}
			files := pkg["files"].([]any)
			if len(files) != 1 || files[0].(map[string]any)["path"] != "references/style.md" {
				t.Errorf("reference package: %v", files)
			}
			manifest := pkg["manifest"].(map[string]any)
			installed = []map[string]any{{"id": "article-native", "packageId": manifest["id"], "packageVersion": manifest["version"], "status": "published"}}
			fmt.Fprint(w, `{"id":"article-native"}`)
		case strings.HasSuffix(r.URL.Path, "/status"):
			fmt.Fprint(w, `{}`)
		default:
			t.Errorf("unexpected request %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer remote.Close()
	a.cfg.AgentGPTBaseURL = remote.URL
	if err = a.prepareWritingInput(toolCtx, &task); err != nil {
		t.Fatal(err)
	}
	_, loaded, err := a.agentLoadSkill(toolCtx, nil, agentLoadSkillInput{SkillID: skill.ID, Version: skill.VersionID})
	if err != nil || loaded["available"] != true {
		t.Fatalf("article native load: %v %v", loaded, err)
	}
	if loads, err := a.loadWritingLoadedSkills(ctx, task.ID); err != nil || len(loads) != 1 {
		t.Fatalf("article usage receipt: %v %v", loads, err)
	}
	koiFolderRequest(t, a, user, "DELETE", "/api/koi/skills/"+skill.ID+"?expectedRevision=1", nil, 200)
	if pinned, err = a.koiTaskSkills(ctx, task); err != nil || len(pinned) != 1 {
		t.Fatalf("running article lost version: %v %v", pinned, err)
	}
	if err = a.finishWritingTask(ctx, task, "completed", "", json.RawMessage(`{"totalTokens":0}`), "已检查"); err != nil {
		t.Fatal(err)
	}
	next := agentTestTask(t, a, user, koiArticleSession(t, a, user, doc), model.Document{}, "再检查一次")
	if pinned, err = a.koiTaskSkills(ctx, next); err != nil || len(pinned) != 0 {
		t.Fatalf("new article saw uninstalled or incompatible Skill: %v %v", pinned, err)
	}
}

func TestKoiMigrationSelectionIsAtomicAndKeepsOldTasks(t *testing.T) {
	a, user, _ := writingTestApp(t)
	ctx := context.Background()
	enableRepositoryR2Fixture(t, a)
	t.Cleanup(func() {
		if _, err := a.db.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, user.ID); err != nil {
			t.Error(err)
		}
	})
	repository := agentSkillRepositoryForTest(t, a, user.ID, map[string]string{"method/SKILL.md": "---\nname: method\ndescription: Edit text\n---\nPreserve facts.", "method/guide.md": "Read carefully.", "other/SKILL.md": "# Other", "bad/SKILL.md": "---\nname: [broken\n---\nInvalid."})
	other := insertAgentReviewTestUser(t, a.db)
	agentSkillRepositoryForTest(t, a, other.ID, map[string]string{"foreign/SKILL.md": "# Foreign"})
	old := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), model.Document{}, "旧任务")
	a.cfg.KoiSkillTestAccounts = []string{user.AuthUserID}
	settings, err := a.koiSettingsForUser(ctx, user.ID)
	if err != nil || settings.LibraryMode != "legacy" {
		t.Fatalf("legacy classification: %+v %v", settings, err)
	}
	blocked, _ := randomUUID()
	koiFolderRequest(t, a, user, "POST", "/api/koi/skill-imports", koiImportRequest{RequestID: blocked, SourceKind: "folder", DeclaredPaths: []string{"SKILL.md"}}, 409)
	koiFolderRequest(t, a, user, "PUT", "/api/koi/settings", map[string]any{"expectedRevision": settings.Revision, "autoSkills": false}, 200)
	disabled := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), model.Document{}, "关闭技能")
	if automaticAgentSkills(disabled) || usesExplicitAgentSkill(disabled) {
		t.Fatal("legacy switch bypassed or eager empty package restored")
	}
	settings, _ = a.koiSettingsForUser(ctx, user.ID)
	koiFolderRequest(t, a, user, "PUT", "/api/koi/settings", map[string]any{"expectedRevision": settings.Revision, "autoSkills": true}, 200)
	preview, request := koiMigrationPreview(t, a, user)
	if len(preview.Candidates) != 2 || len(preview.Rejected) != 1 {
		t.Fatalf("migration boundaries: %+v", preview)
	}
	input := koiFolderConfirmation(preview)
	for _, item := range preview.Candidates {
		if item.Name == "method" {
			input.CandidateIDs = []string{item.ID}
		}
	}
	input.Enable = new(bool)
	path := "/api/koi/skill-imports/" + preview.ID + "/confirm"
	installed := koiFolderInstalled(t, koiFolderRequest(t, a, user, "POST", path, input, 200))
	if len(installed) != 1 || installed[0].Name != "method" || installed[0].Enabled || installed[0].SourceKind != "migration" {
		t.Fatalf("migration selection: %+v", installed)
	}
	repeated := koiFolderInstalled(t, koiFolderRequest(t, a, user, "POST", path, input, 200))
	if repeated[0].ID != installed[0].ID {
		t.Fatal("migration retry duplicated installation")
	}
	replay := koiFolderView(t, koiFolderRequest(t, a, user, "POST", "/api/koi/skill-imports", koiImportRequest{RequestID: request, SourceKind: "migration"}, 202))
	if replay.Status != "committed" {
		t.Fatal("create receipt lost after migration")
	}
	settings, err = a.koiSettingsForUser(ctx, user.ID)
	if err != nil || settings.LibraryMode != "installed" || !automaticAgentSkills(old) || koiTaskLibraryMode(old) != "legacy" {
		t.Fatalf("migration rewrote old task: %+v %v", settings, err)
	}
	updated := koiTestConfirm(t, a, user, koiTestUpdate(t, a, user, installed[0], "---\nname: method\ndescription: Edit text\n---\nNew version."))
	if updated.ID != installed[0].ID || updated.Enabled || updated.SourceKind != "migration" {
		t.Fatalf("manual migrated update: %+v", updated)
	}
	current, err := a.loadAgentWorkspace(ctx, user.ID, repository)
	if err != nil || current.Revision != 1 || len(current.Files) != 4 {
		t.Fatalf("source repository changed: %+v %v", current, err)
	}
	next := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), model.Document{}, "新任务")
	if found, err := a.koiTaskSkills(ctx, next); err != nil || len(found) != 0 || koiTaskLibraryMode(next) != "installed" {
		t.Fatalf("disabled migration fell back to repositories: %+v %v", found, err)
	}
	koiFolderRequest(t, a, user, "DELETE", fmt.Sprintf("/api/koi/skills/%s?expectedRevision=%d", updated.ID, updated.Revision), nil, 200)
	settings, err = a.koiSettingsForUser(ctx, user.ID)
	if err != nil || settings.LibraryMode != "installed" {
		t.Fatal("uninstall restored legacy rule", err)
	}
}

func TestKoiMigrationFailuresAndEmptyChoiceKeepLibrariesConsistent(t *testing.T) {
	a, user, _ := writingTestApp(t)
	ctx := context.Background()
	a.cfg.KoiSkillTestAccounts = []string{user.AuthUserID}
	repository := agentSkillRepositoryForTest(t, a, user.ID, map[string]string{"SKILL.md": "# Method"})
	preview, _ := koiMigrationPreview(t, a, user)
	usage, err := a.storageUsageFor(ctx, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = a.db.Exec(ctx, `INSERT INTO image_objects(object_key,user_id,bytes) VALUES($1,$2,$3)`, "u/"+user.AuthUserID+"/full.png", user.ID, a.storageQuotaFor(user)-usage.Total()); err != nil {
		t.Fatal(err)
	}
	path := "/api/koi/skill-imports/" + preview.ID + "/confirm"
	w := koiFolderRequest(t, a, user, "POST", path, koiFolderConfirmation(preview), 409)
	if !strings.Contains(w.Body.String(), "storage_quota_exceeded") {
		t.Fatal(w.Body.String())
	}
	settings, err := a.koiSettingsForUser(ctx, user.ID)
	if err != nil || settings.LibraryMode != "legacy" {
		t.Fatal("quota failure switched library", err)
	}
	var count int
	if err = a.db.QueryRow(ctx, `SELECT count(*) FROM koi_skill_installations WHERE user_id=$1`, user.ID).Scan(&count); err != nil || count != 0 {
		t.Fatal("quota failure left partial installation", count, err)
	}
	if _, err = a.db.Exec(ctx, `DELETE FROM image_objects WHERE user_id=$1`, user.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = a.patchAgentWorkspace(ctx, user.ID, repository, 1, []agentWorkspaceFile{repositoryTestFile("SKILL.md", "# Changed")}, nil); err != nil {
		t.Fatal(err)
	}
	koiFolderRequest(t, a, user, "POST", path, koiFolderConfirmation(preview), 409)
	settings, _ = a.koiSettingsForUser(ctx, user.ID)
	if settings.LibraryMode != "legacy" {
		t.Fatal("source conflict switched library")
	}
	koiFolderRequest(t, a, user, "POST", "/api/koi/skill-migration/skip", map[string]any{"expectedRevision": settings.Revision + 1}, 409)
	for range 2 {
		koiFolderRequest(t, a, user, "POST", "/api/koi/skill-migration/skip", map[string]any{"expectedRevision": settings.Revision}, 200)
	}
	koiFolderRequest(t, a, user, "POST", path, koiFolderConfirmation(preview), 409)
	next := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), model.Document{}, "继续使用基础能力")
	if koiTaskLibraryMode(next) != "installed" {
		t.Fatal("empty library restored repository discovery")
	}
	if found, err := a.koiTaskSkills(ctx, next); err != nil || len(found) != 0 {
		t.Fatal("empty library exposes old skills", found, err)
	}
	// Existing released installations win over repository discovery even if the
	// user has since uninstalled them and no task history remains.
	adopted := koiRuntimeInstall(t, a, user, map[string]string{"SKILL.md": "# Adopted"})
	koiFolderRequest(t, a, user, "DELETE", "/api/koi/skills/"+adopted.ID+"?expectedRevision=1", nil, 200)
	if _, err = a.db.Exec(ctx, `UPDATE agent_session_settings SET library_mode=NULL WHERE user_id=$1`, user.ID); err != nil {
		t.Fatal(err)
	}
	settings, err = a.koiSettingsForUser(ctx, user.ID)
	if err != nil || settings.LibraryMode != "installed" {
		t.Fatal("existing account was switched back to legacy", settings, err)
	}
}

func TestKoiMigrationCannotBeBypassedByLegacyWritingRequests(t *testing.T) {
	a, user, doc := writingTestApp(t)
	ctx := context.Background()
	repository := agentSkillRepositoryForTest(t, a, user.ID, map[string]string{"SKILL.md": "# Legacy method"})
	request, _ := randomUUID()
	oldInput := writingCreateInput{RequestID: request, DocID: doc.DocID, ExpectedRevision: doc.Revision, Message: "Review", SkillRepositoryID: repository, SkillPath: "SKILL.md"}
	accepted := koiFolderRequest(t, a, user, "POST", "/api/writing-agent/tasks", oldInput, 202)
	a.cfg.KoiSkillTestAccounts = []string{user.AuthUserID}
	settings, err := a.koiSettingsForUser(ctx, user.ID)
	if err != nil || settings.LibraryMode != "legacy" {
		t.Fatal(settings, err)
	}
	koiFolderRequest(t, a, user, "POST", "/api/koi/skill-migration/skip", map[string]any{"expectedRevision": settings.Revision}, 200)
	// Existing client retries still receive the original task, with no new
	// reservation. New selectors cannot restore the old repository rule.
	replayed := koiFolderRequest(t, a, user, "POST", "/api/writing-agent/tasks", oldInput, 200)
	var before, after struct {
		Task writingTask `json:"task"`
	}
	json.Unmarshal(accepted.Body.Bytes(), &before)
	json.Unmarshal(replayed.Body.Bytes(), &after)
	if before.Task.ID != after.Task.ID {
		t.Fatal("old task replay changed identity")
	}
	oldInput.RequestID, _ = randomUUID()
	w := koiFolderRequest(t, a, user, "POST", "/api/writing-agent/tasks", oldInput, 400)
	if !strings.Contains(w.Body.String(), "skill_unavailable") {
		t.Fatal(w.Body.String())
	}
	var count int
	if err = a.db.QueryRow(ctx, `SELECT count(*) FROM credit_reservations WHERE user_id=$1`, user.ID).Scan(&count); err != nil || count != 1 {
		t.Fatal("rejected legacy selector reserved Credits", count, err)
	}
	config := koiFolderRequest(t, a, user, "GET", "/api/writing-agent/config", nil, 200)
	if !strings.Contains(config.Body.String(), `"skills":[]`) {
		t.Fatal("configuration restored repository discovery", config.Body.String())
	}
}
