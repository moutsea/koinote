package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"koinote/backend/internal/model"
)

func koiRuntimeInstall(t *testing.T, a *App, user model.User, files map[string]string) koiSkillInstallation {
	t.Helper()
	view := koiFolderPreview(t, a, user, files)
	w := koiFolderRequest(t, a, user, "POST", "/api/koi/skill-imports/"+view.ID+"/confirm", koiFolderConfirmation(view), 200)
	installed := koiFolderInstalled(t, w)
	if len(installed) != 1 {
		t.Fatalf("expected one package: %s", w.Body.String())
	}
	return installed[0]
}

func TestKoiInstalledTaskPinsLoadsAndReleases(t *testing.T) {
	a, user, _ := writingTestApp(t)
	a.cfg.KoiSkillTestAccounts = []string{user.AuthUserID}
	enableRepositoryR2Fixture(t, a)
	ctx := context.Background()
	t.Cleanup(func() {
		if _, err := a.db.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, user.ID); err != nil {
			t.Error(err)
		}
	})
	entry := "---\nname: review\ndescription: Review structure\nrequiredTools: [koinote.get_document]\nfiles: [guide.md]\n---\nRead guide.md and preserve the author's voice.\n"
	skill := koiRuntimeInstall(t, a, user, map[string]string{"LICENSE": "MIT License", "review/SKILL.md": entry, "review/guide.md": "Structure guide"})
	session := agentTestSession(t, a, user, "review")
	task := agentTestTask(t, a, user, session, model.Document{}, "检查结构")
	if !automaticAgentSkills(task) || usesExplicitAgentSkill(task) || koiTaskLibraryMode(task) != "installed" {
		t.Fatal("new allowlisted task did not use the optional installed library")
	}
	// Installed-library tasks cannot see repository Skills, foreign packages or
	// packages installed after acceptance.
	agentSkillRepositoryForTest(t, a, user.ID, map[string]string{"legacy/SKILL.md": "# Legacy"})
	later := koiRuntimeInstall(t, a, user, map[string]string{"later/SKILL.md": "# Later\nA later installation."})
	other := insertAgentReviewTestUser(t, a.db)
	foreign := writingTask{ID: task.ID, UserID: other.ID}
	if skills, err := a.koiTaskSkills(ctx, foreign); err != nil || len(skills) != 0 {
		t.Fatalf("cross-account snapshot: %+v %v", skills, err)
	}
	task.WorkspaceID = "installed-task"
	toolCtx := context.WithValue(ctx, writingMCPContext{}, task)
	_, catalog, err := a.agentFindSkills(toolCtx, nil, agentSearchInput{Query: "structure"})
	if err != nil || len(catalog["skills"].([]map[string]any)) != 1 {
		t.Fatalf("installed discovery: %v %v", catalog, err)
	}
	item := catalog["skills"].([]map[string]any)[0]
	if item["skillId"] != skill.ID || item["version"] != skill.VersionID {
		t.Fatalf("unpinned identity: %v", item)
	}
	for _, input := range []agentLoadSkillInput{{SkillID: later.ID, Version: later.VersionID}, {SkillID: skill.ID, Version: later.VersionID}, {RepositoryID: 1, Revision: 1, Path: "SKILL.md"}} {
		_, result, err := a.agentLoadSkill(toolCtx, nil, input)
		if input.SkillID == "" {
			if err != errAgentInput {
				t.Fatalf("repository selector accepted by installed task: %v", err)
			}
		} else if err != nil || result["available"] != false {
			t.Fatalf("unreferenced package loaded: %v %v", result, err)
		}
	}
	// Uninstall after acceptance must keep the package for this active task.
	koiFolderRequest(t, a, user, "PATCH", "/api/koi/skills/"+skill.ID, map[string]any{"expectedRevision": skill.Revision, "enabled": false}, 200)
	koiFolderRequest(t, a, user, "DELETE", fmt.Sprintf("/api/koi/skills/%s?expectedRevision=%d", skill.ID, skill.Revision+1), nil, 200)
	if err := a.cleanupKoiSkillVersionsForUser(ctx, user.ID); err != nil {
		t.Fatal(err)
	}
	usage, err := a.storageUsageFor(ctx, user.ID)
	if err != nil || usage.KoiSkillBytes != skill.SizeBytes+later.SizeBytes {
		t.Fatalf("active task bytes lost: %+v %v", usage, err)
	}
	installed := []map[string]any{}
	var packages []map[string]any
	failPublish := true
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasSuffix(r.URL.Path, "/connect"):
			json.NewEncoder(w).Encode(map[string]any{"state": "ready", "tools": []string{"get_document", "propose_document_change", "search_documents", "list_folders", "propose_operations", "get_conversation", "save_artifact", "find_skills", "load_skill"}})
		case strings.HasSuffix(r.URL.Path, "/mcp"):
			fmt.Fprint(w, `{}`)
		case strings.HasSuffix(r.URL.Path, "/skills"):
			json.NewEncoder(w).Encode(installed)
		case strings.HasSuffix(r.URL.Path, "/install"):
			var pkg map[string]any
			if err := json.NewDecoder(r.Body).Decode(&pkg); err != nil {
				t.Error(err)
			}
			packages = append(packages, pkg)
			manifest := pkg["manifest"].(map[string]any)
			installed = append(installed, map[string]any{"id": "native-skill", "packageId": manifest["id"], "packageVersion": manifest["version"], "status": "candidate"})
			fmt.Fprint(w, `{"id":"native-skill"}`)
		case strings.HasSuffix(r.URL.Path, "/status"):
			if failPublish {
				failPublish = false
				http.Error(w, "private failure", 503)
				return
			}
			installed[0]["status"] = "published"
			fmt.Fprint(w, `{}`)
		default:
			t.Errorf("unexpected native request: %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer remote.Close()
	a.cfg.AgentGPTBaseURL = remote.URL
	if err = a.prepareWritingInput(toolCtx, &task); err != nil {
		t.Fatal(err)
	}
	if len(packages) != 0 {
		t.Fatal("optional package installed eagerly")
	}
	input := agentLoadSkillInput{SkillID: skill.ID, Version: skill.VersionID}
	_, failed, err := a.agentLoadSkill(toolCtx, nil, input)
	if err != nil || failed["available"] != false || strings.Contains(fmt.Sprint(failed), "private failure") {
		t.Fatalf("optional failure: %v %v", failed, err)
	}
	if loads, err := a.loadWritingLoadedSkills(ctx, task.ID); err != nil || len(loads) != 0 {
		t.Fatalf("failed load was reported: %+v %v", loads, err)
	}
	for range 2 {
		_, loaded, err := a.agentLoadSkill(toolCtx, nil, input)
		if err != nil || loaded["available"] != true || loaded["skillId"] != "native-skill" {
			t.Fatalf("pinned load: %v %v", loaded, err)
		}
	}
	// Exercise the public MCP schema too: installed tasks must not be forced to
	// supply the legacy repository selector fields.
	if _, err := a.db.Exec(ctx, `UPDATE writing_agent_tasks SET workspace_id=$2 WHERE id=$1`, task.ID, task.WorkspaceID); err != nil {
		t.Fatal(err)
	}
	mcpServer := httptest.NewServer(a.Routes())
	defer mcpServer.Close()
	client, err := connectMCPClient(ctx, mcpServer.URL+"/api/writing-agent/mcp/"+task.ID, a.writingSecret(task.ID, "mcp"))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	result, err := client.CallTool(ctx, &mcp.CallToolParams{Name: "load_skill", Arguments: map[string]any{"skillId": skill.ID, "version": skill.VersionID}})
	if err != nil || result.IsError {
		t.Fatalf("installed MCP selector: %+v %v", result, err)
	}
	if len(packages) != 1 || packages[0]["instructions"] != entry || len(packages[0]["files"].([]any)) != 2 {
		t.Fatalf("package bytes/cache changed: %+v", packages)
	}
	loaded, err := a.loadWritingTask(ctx, task.ID, user.ID)
	if err != nil || len(loaded.LoadedSkills) != 1 || loaded.LoadedSkills[0].ID != skill.VersionID {
		t.Fatalf("usage receipt: %+v %v", loaded.LoadedSkills, err)
	}
	page := koiFolderRequest(t, a, user, "GET", "/api/agent/sessions/"+session.ID, nil, 200)
	if !strings.Contains(page.Body.String(), `"loadedSkills"`) || !strings.Contains(page.Body.String(), skill.VersionID) {
		t.Fatal("session history lost Skill usage")
	}
	// A new task sees the changed library; replaying the old task never re-pins.
	next := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), model.Document{}, "next")
	if skills, err := a.koiTaskSkills(ctx, next); err != nil || len(skills) != 1 || skills[0].InstallationID != later.ID {
		t.Fatalf("new task library: %+v %v", skills, err)
	}
	if err = a.finishWritingTask(ctx, task, "completed", "", json.RawMessage(`{"totalTokens":2001}`), "done"); err != nil {
		t.Fatal(err)
	}
	if err = a.cleanupKoiSkillVersionsForUser(ctx, user.ID); err != nil {
		t.Fatal(err)
	}
	usage, err = a.storageUsageFor(ctx, user.ID)
	if err != nil || usage.KoiSkillBytes != later.SizeBytes {
		t.Fatalf("terminal task did not release bytes: %+v %v", usage, err)
	}
	loaded, err = a.loadWritingTask(ctx, task.ID, user.ID)
	if err != nil || len(loaded.LoadedSkills) != 1 {
		t.Fatalf("usage receipt depended on deleted package: %+v %v", loaded.LoadedSkills, err)
	}
}

func TestKoiSettingsAndTaskProtocolBoundaries(t *testing.T) {
	a, user, doc := writingTestApp(t)
	ctx := context.Background()
	ordinary := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), model.Document{}, "ordinary")
	if len(ordinary.SkillSnapshot) != 0 || koiTaskLibraryMode(ordinary) != "legacy" {
		t.Fatal("ordinary account switched protocols")
	}
	overview := koiFolderRequest(t, a, user, "GET", "/api/koi/settings", nil, 200)
	if !strings.Contains(overview.Body.String(), `"managementAvailable":false`) {
		t.Fatal("ordinary account saw management")
	}
	koiFolderRequest(t, a, user, "PUT", "/api/koi/settings", map[string]any{"expectedRevision": 1, "autoSkills": false}, 403)
	a.cfg.KoiSkillTestAccounts = []string{user.AuthUserID}
	koiFolderRequest(t, a, user, "PUT", "/api/koi/settings", map[string]any{"expectedRevision": 1, "autoSkills": false}, 200)
	koiFolderRequest(t, a, user, "PUT", "/api/koi/settings", map[string]any{"expectedRevision": 1, "autoSkills": true}, 409)
	task := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), model.Document{}, "chat without skills")
	if automaticAgentSkills(task) || usesExplicitAgentSkill(task) {
		t.Fatal("disabled optional Skills fell back to an explicit package")
	}
	input := map[string]any{"policy": map[string]any{}}
	if err := a.prepareAgentConversationInput(ctx, &task, input, ""); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(fmt.Sprint(input["policy"]), "koinote.find_skills") || strings.Contains(input["systemPrompt"].(string), "The selected Skill is loaded") {
		t.Fatal("disabled Skills still requested discovery or eager loading")
	}
	if _, _, err := a.agentFindSkills(context.WithValue(ctx, writingMCPContext{}, task), nil, agentSearchInput{}); err != errAgentInput {
		t.Fatalf("disabled discovery callable: %v", err)
	}
	if settings, err := loadKoiSkillSettings(ctx, a.db, user.ID); err != nil || settings.AutoSkills || settings.Revision != 2 {
		t.Fatalf("settings persistence: %+v %v", settings, err)
	}
	// Older clients still write permission without resetting the new switch.
	koiFolderRequest(t, a, user, "PUT", "/api/agent/session-settings", map[string]string{"permission": "assist"}, 200)
	if settings, err := loadKoiSkillSettings(ctx, a.db, user.ID); err != nil || settings.AutoSkills || settings.Revision != 2 {
		t.Fatalf("permission write reset optional Skill settings: %+v %v", settings, err)
	}
	koiFolderRequest(t, a, user, "PUT", "/api/koi/settings", map[string]any{"expectedRevision": 2, "autoSkills": true}, 200)
	if automaticAgentSkills(task) || usesExplicitAgentSkill(task) {
		t.Fatal("changing settings rewrote the earlier task protocol")
	}
	skill := koiRuntimeInstall(t, a, user, map[string]string{"toggle/SKILL.md": "# Toggle\nKeep the author's voice."})
	skillPath := "/api/koi/skills/" + skill.ID
	koiFolderRequest(t, a, user, "PATCH", skillPath, map[string]any{"expectedRevision": 1, "enabled": false}, 200)
	koiFolderRequest(t, a, user, "PATCH", skillPath, map[string]any{"expectedRevision": 1, "enabled": true}, 409)
	koiFolderRequest(t, a, user, "PATCH", skillPath, map[string]any{"expectedRevision": 2, "enabled": true}, 200)
	list := koiFolderRequest(t, a, user, "GET", "/api/koi/skills?q=toggle&state=enabled", nil, 200)
	if !strings.Contains(list.Body.String(), skill.ID) {
		t.Fatal("enabled Skill missing from filtered list")
	}
	// Article-bound sessions keep their existing tool scope in this batch.
	article := koiFolderRequest(t, a, user, "POST", "/api/documents/"+doc.DocID+"/koi-session", nil, 200)
	var response struct {
		Session agentSession `json:"session"`
	}
	json.Unmarshal(article.Body.Bytes(), &response)
	articleTask := agentTestTask(t, a, user, response.Session, model.Document{}, "review article")
	if len(articleTask.SkillSnapshot) != 0 {
		t.Fatal("article entry was switched to installed Skills")
	}
	if err := a.prepareAgentConversationInput(ctx, &articleTask, input, ""); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(fmt.Sprint(input["policy"]), "koinote.find_skills") {
		t.Fatal("article tool scope expanded")
	}
	if !automaticAgentSkills(ordinary) || koiTaskLibraryMode(ordinary) != "legacy" {
		t.Fatal("existing task changed with allowlist/settings")
	}
	if _, err := a.db.Exec(ctx, `UPDATE users SET membership_tier='free' WHERE id=$1`, user.ID); err != nil {
		t.Fatal(err)
	}
	koiFolderRequest(t, a, user, "PUT", "/api/koi/settings", map[string]any{"expectedRevision": 3, "autoSkills": false}, 403)
	koiFolderRequest(t, a, user, "PATCH", skillPath, map[string]any{"expectedRevision": 3, "enabled": false}, 200)
	koiFolderRequest(t, a, user, "PATCH", skillPath, map[string]any{"expectedRevision": 4, "enabled": true}, 403)
	koiFolderRequest(t, a, user, "DELETE", skillPath+"?expectedRevision=4", nil, 200)
}

// Export the real stored package for the optional native runtime contract check.
func TestKoiSkillRuntimeContract(t *testing.T) {
	a, user, _ := writingTestApp(t)
	a.cfg.KoiSkillTestAccounts = []string{user.AuthUserID}
	for _, format := range []string{"standard", "plain"} {
		t.Run(format, func(t *testing.T) {
			entry := "---\nname: method\ndescription: Review notes\nrequiredTools: [koinote.get_document]\nfiles: [guide.md]\n---\nRead guide.md first.\n"
			if format == "plain" {
				entry = "# Plain method\nRead guide.md first.\n"
			}
			skill := koiRuntimeInstall(t, a, user, map[string]string{"LICENSE": "MIT License", "method/SKILL.md": entry, "method/guide.md": "Guide"})
			pkg, err := a.koiSkillPackageFor(context.Background(), koiTaskSkill{InstallationID: skill.ID, VersionID: skill.VersionID, Name: skill.Name, Description: skill.Description, EntryPath: skill.EntryPath})
			if err != nil {
				t.Fatal(err)
			}
			if directory := os.Getenv("KOINOTE_TEST_SKILL_CONTRACT_DIR"); directory != "" {
				if err := os.WriteFile(filepath.Join(directory, format+".json"), pkg, 0600); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}
