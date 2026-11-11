package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"koinote/backend/internal/model"
)

func agentSkillRepositoryForTest(t *testing.T, a *App, userID int, files map[string]string) int64 {
	t.Helper()
	ctx := context.Background()
	var id int64
	if err := a.db.QueryRow(ctx, `INSERT INTO agent_workspaces(user_id,name,description,revision) VALUES($1,'测试写作方法','用于检查文章结构',1) RETURNING id`, userID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	for path, content := range files {
		digest := sha256.Sum256([]byte(content))
		hash := hex.EncodeToString(digest[:])
		if _, err := a.db.Exec(ctx, `INSERT INTO agent_workspace_blobs(workspace_id,sha256,content) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`, id, hash, []byte(content)); err != nil {
			t.Fatal(err)
		}
		if _, err := a.db.Exec(ctx, `INSERT INTO agent_workspace_files(workspace_id,path,mime_type,size_bytes,sha256) VALUES($1,$2,'text/plain',$3,$4)`, id, path, len(content), hash); err != nil {
			t.Fatal(err)
		}
	}
	return id
}

func TestAgentAutomaticSkillsBaseAndLegacyRequestRetry(t *testing.T) {
	a, u, _ := writingTestApp(t)
	s := agentTestSession(t, a, u, "review")
	requestID, _ := randomUUID()
	payload := map[string]any{"requestId": requestID, "message": "整理文档", "skillRepositoryId": 9999999, "skillPath": "removed/SKILL.md"}
	w := writingTestRequest(t, a, u, "POST", "/api/agent/sessions/"+s.ID+"/tasks", payload)
	if w.Code != 202 {
		t.Fatalf("old client selection must not block a new task: %d %s", w.Code, w.Body.String())
	}
	var response struct {
		Task writingTask `json:"task"`
	}
	json.Unmarshal(w.Body.Bytes(), &response)
	task, err := a.loadWritingTask(context.Background(), response.Task.ID, u.ID)
	if err != nil || !automaticAgentSkills(task) {
		t.Fatalf("missing auto mode: %v", err)
	}
	input := map[string]any{"policy": map[string]any{}}
	if err = a.prepareAgentConversationInput(context.Background(), &task, input, "old-selected-skill"); err != nil {
		t.Fatal(err)
	}
	if _, ok := input["selectedSkillId"]; ok {
		t.Fatal("automatic selection bypasses native model invocation policy")
	}
	prompt := input["systemPrompt"].(string)
	for _, expected := range []string{automaticAgentSkillInstructions, agentTaskScopeInstructions, "wait for prerequisite operations"} {
		if !strings.Contains(prompt, expected) {
			t.Fatal("base rules lost")
		}
	}
	w = writingTestRequest(t, a, u, "POST", "/api/agent/sessions/"+s.ID+"/tasks", payload)
	if w.Code != 200 || !strings.Contains(w.Body.String(), task.ID) {
		t.Fatalf("legacy exact retry failed: %d", w.Code)
	}
	payload["skillRepositoryId"] = 0
	w = writingTestRequest(t, a, u, "POST", "/api/agent/sessions/"+s.ID+"/tasks", payload)
	if w.Code != 409 {
		t.Fatal("changing a retry payload must not silently accept a different hash")
	}
}

func TestAgentAutomaticSkillsCatalogAndLazyLoad(t *testing.T) {
	a, u, _ := writingTestApp(t)
	_, other, _ := writingTestApp(t)
	s := agentTestSession(t, a, u, "review")
	task := agentTestTask(t, a, u, s, model.Document{}, "检查文章结构")
	task.WorkspaceID = "isolated-skill-task"
	ctx := context.WithValue(context.Background(), writingMCPContext{}, task)
	instructions := "---\nname: review\ndescription: 检查文章结构\ndisable-model-invocation: true\nuser-invocable: false\nrequiredTools: [web_fetch]\nscripts:\n  check: scripts/check.py\nruntime:\n  kind: python\n---\nOnly review; never rewrite without a request."
	files := map[string]string{
		"review/SKILL.md": instructions, "review/scripts/check.py": "print(55)", "unrelated.txt": "excluded",
		"review/nested/SKILL.md":  "# Independent skill",
		"review/nested/large.txt": strings.Repeat("x", 129<<10),
	}
	repo := agentSkillRepositoryForTest(t, a, u.ID, files)
	foreign := agentSkillRepositoryForTest(t, a, other.ID, files)
	many := map[string]string{}
	for i := 0; i < 23; i++ {
		many[fmt.Sprintf("skill-%02d/SKILL.md", i)] = "# Test"
	}
	agentSkillRepositoryForTest(t, a, u.ID, many)
	_, page, err := a.agentFindSkills(ctx, nil, agentSearchInput{Limit: 100})
	if err != nil || len(page["skills"].([]map[string]any)) != 20 || page["nextCursor"] == "" {
		t.Fatalf("catalog first page: %v %v", page, err)
	}
	_, next, err := a.agentFindSkills(ctx, nil, agentSearchInput{Limit: 100, Cursor: page["nextCursor"].(string)})
	if err != nil || len(next["skills"].([]map[string]any)) != 5 || next["nextCursor"] != "" {
		t.Fatalf("catalog pagination/ownership: %v %v", next, err)
	}
	_, page, err = a.agentFindSkills(ctx, nil, agentSearchInput{Query: "review/"})
	if err != nil || len(page["skills"].([]map[string]any)) != 2 {
		t.Fatalf("catalog search: %v %v", page, err)
	}
	if page["skills"].([]map[string]any)[1]["path"] != "review/nested/SKILL.md" {
		t.Fatal("nested Skill must remain independently discoverable")
	}

	installed := []map[string]any{}
	packages := []map[string]any{}
	failPublish := true
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case strings.HasSuffix(r.URL.Path, "/connect"):
			json.NewEncoder(w).Encode(map[string]any{"state": "ready", "tools": []string{"get_document", "propose_document_change", "search_documents", "list_folders", "propose_operations", "get_conversation", "save_artifact", "find_skills", "load_skill"}})
		case strings.HasSuffix(r.URL.Path, "/mcp"):
			fmt.Fprint(w, `{}`)
		case strings.HasSuffix(r.URL.Path, "/skills"):
			json.NewEncoder(w).Encode(installed)
		case strings.HasSuffix(r.URL.Path, "/install"):
			var pkg map[string]any
			json.NewDecoder(r.Body).Decode(&pkg)
			packages = append(packages, pkg)
			manifest := pkg["manifest"].(map[string]any)
			id := fmt.Sprintf("skill-%d", len(packages))
			installed = append(installed, map[string]any{"id": id, "packageId": manifest["id"], "packageVersion": manifest["version"], "workspaceId": task.WorkspaceID, "status": "candidate"})
			json.NewEncoder(w).Encode(map[string]string{"id": id})
		case strings.HasSuffix(r.URL.Path, "/status"):
			if failPublish {
				failPublish = false
				http.Error(w, "private remote diagnostic", 503)
				return
			}
			for _, item := range installed {
				if strings.Contains(r.URL.Path, "/"+item["id"].(string)+"/") {
					item["status"] = "published"
				}
			}
			fmt.Fprint(w, `{}`)
		default:
			t.Errorf("unexpected remote call: %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	defer remote.Close()
	a.cfg.AgentGPTBaseURL = remote.URL
	if err = a.prepareWritingInput(ctx, &task); err != nil {
		t.Fatal(err)
	}
	if len(packages) != 0 {
		t.Fatal("task eagerly installed a Skill")
	}
	for _, in := range []agentLoadSkillInput{{foreign, 1, "review/SKILL.md"}, {repo, 2, "review/SKILL.md"}, {repo, 1, "../SKILL.md"}} {
		_, result, err := a.agentLoadSkill(ctx, nil, in)
		if err != nil || result["available"] != false {
			t.Fatalf("invalid source loaded: %v %v", result, err)
		}
	}
	if len(packages) != 0 {
		t.Fatal("unowned/stale Skill uploaded")
	}
	in := agentLoadSkillInput{repo, 1, "review/SKILL.md"}
	_, failed, err := a.agentLoadSkill(ctx, nil, in)
	if err != nil || failed["available"] != false || strings.Contains(fmt.Sprint(failed), "private remote") {
		t.Fatalf("optional failure: %v %v", failed, err)
	}
	_, loaded, err := a.agentLoadSkill(ctx, nil, in)
	if err != nil || loaded["available"] != true || loaded["skillId"] != "skill-1" || len(packages) != 1 {
		t.Fatalf("retry should reuse installed package: %v %v", loaded, err)
	}
	_, again, err := a.agentLoadSkill(ctx, nil, in)
	if err != nil || again["skillId"] != loaded["skillId"] || len(packages) != 1 {
		t.Fatal("repeat load duplicated package")
	}
	pkg := packages[0]
	manifest := pkg["manifest"].(map[string]any)
	if pkg["instructions"] != instructions || manifest["disableModelInvocation"] != true || manifest["userInvocable"] != false || manifest["runtime"] == nil || manifest["scripts"] == nil || len(pkg["files"].([]any)) != 1 {
		t.Fatal("native policies or reference files lost")
	}
	if _, ok := loaded["instructions"]; ok {
		t.Fatal("loader exposed body before native invocation checks")
	}
	second := agentSkillRepositoryForTest(t, a, u.ID, files)
	_, result, err := a.agentLoadSkill(ctx, nil, agentLoadSkillInput{second, 1, "review/SKILL.md"})
	if err != nil || result["skillId"] == loaded["skillId"] || len(packages) != 2 {
		t.Fatal("identical names from different repositories collided")
	}
	if _, err = a.db.Exec(ctx, `UPDATE agent_workspaces SET revision=revision+1 WHERE id=$1`, repo); err != nil {
		t.Fatal(err)
	}
	_, stale, err := a.agentLoadSkill(ctx, nil, in)
	if err != nil || stale["available"] != false {
		t.Fatal("stale catalog revision loaded")
	}
}
