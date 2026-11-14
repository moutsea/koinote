package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"koinote/backend/internal/model"
)

func TestAgentRepositoryKnowledgePublicCatalog(t *testing.T) {
	a, user, _ := writingTestApp(t)
	a.cfg.KoiSkillTestAccounts = []string{user.AuthUserID}
	other := insertAgentReviewTestUser(t, a.db)
	ctx := context.Background()
	add := func(name, description, category string, checked, installable, published, deleted bool) int64 {
		t.Helper()
		var id int64
		if err := a.db.QueryRow(ctx, `INSERT INTO agent_workspaces(user_id,name,description,hub_category,deleted_at)
 VALUES($1,'PRIVATE_NAME','PRIVATE_DESCRIPTION',$2,CASE WHEN $3 THEN now() END) RETURNING id`, user.ID, category, deleted).Scan(&id); err != nil {
			t.Fatal(err)
		}
		if published {
			if _, err := a.db.Exec(ctx, `INSERT INTO agent_repository_publications(workspace_id,revision,name,description,license,github_source,koi_installable,koi_installability_curation_revision,koi_installability_evidence)
 VALUES($1,0,$2,$3,'MIT',$4,$5,(SELECT revision FROM agent_repository_curation_state WHERE singleton),$6)`, id, name, description,
				map[string]any{"repositoryId": id, "author": "CatalogAuthor"}, installable,
				koiInstallabilityEvidence{RulesVersion: map[bool]int{true: koiSkillEntryRulesVersion, false: 0}[checked]}); err != nil {
				t.Fatal(err)
			}
		}
		return id
	}
	write := add("catalog-review/writer", "公众号润色", "writing", true, true, true, false)
	knowledge := add("catalog-review/knowledge", "Knowledge writing", "research", true, true, true, false)
	_ = add("catalog-review/reference", "润色 writing", "writing", true, false, true, false)
	_ = add("catalog-review/stale", "润色 writing", "writing", false, true, true, false)
	pending := add("catalog-review/pending", "润色 writing", "writing", false, false, true, false)
	if _, err := a.db.Exec(ctx, `UPDATE agent_repository_publications SET koi_installable=NULL,koi_installability_evidence=NULL WHERE workspace_id=$1`, pending); err != nil {
		t.Fatal(err)
	}
	_ = add("catalog-review/deleted", "润色 writing", "writing", true, true, true, true)
	_ = add("catalog-review/unpublished", "润色 writing", "writing", true, true, false, false)
	withdrawn := add("catalog-review/withdrawn", "润色 writing", "writing", true, true, true, false)
	if _, err := a.db.Exec(ctx, `DELETE FROM agent_repository_publications WHERE workspace_id=$1`, withdrawn); err != nil {
		t.Fatal(err)
	}
	for i, owner := range []model.User{user, user, other} {
		kind, source := "hub", map[string]any{"workspaceId": write}
		if i == 1 {
			kind, source = "github", map[string]any{"repositoryId": write}
		}
		skill := koiExistingLibraryFixture(t, a, owner.ID, kind, source, fmt.Sprintf("# Review %d", i), i != 1)
		if _, err := a.db.Exec(ctx, `UPDATE koi_skill_installations SET name=$2 WHERE id=$1`, skill.ID, fmt.Sprintf("installed-%d", i)); err != nil {
			t.Fatal(err)
		}
	}
	onTask := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), model.Document{}, "有哪些写作技能？")
	if _, err := a.db.Exec(ctx, `UPDATE agent_session_settings SET auto_skills=false WHERE user_id=$1`, user.ID); err != nil {
		t.Fatal(err)
	}
	offTask := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), model.Document{}, "推荐写作技能")
	search := func(task writingTask, input agentRepositorySearchInput) map[string]any {
		t.Helper()
		_, result, err := a.agentSearchRepositories(context.WithValue(ctx, writingMCPContext{}, task), nil, input)
		if err != nil {
			t.Fatal(err)
		}
		encoded, _ := json.Marshal(result)
		if strings.Contains(string(encoded), "PRIVATE_") || strings.Contains(string(encoded), "installed-2") {
			t.Fatal("private workspace metadata or another account's installation leaked")
		}
		return result
	}
	page := search(offTask, agentRepositorySearchInput{Query: "润色 writing", Limit: 1})
	if page["total"] != 2 || page["hasMore"] != true || page["automaticSkillUse"] != false {
		t.Fatalf("recommendation must work independently of automatic invocation: %+v", page)
	}
	if page["skillSettings"].(koiSkillSettings).AutoSkills || page["manageSkillsUrl"] != agentSkillsManageURL || page["nextCursor"] == "" {
		t.Fatalf("missing current settings, activation entry or continuation: %+v", page)
	}
	items := page["repositories"].([]agentRepositoryKnowledge)
	if len(items) != 1 || items[0].WorkspaceID != write || items[0].InstallURL != fmt.Sprintf("/repositories/%d?installKoi=true", write) || len(items[0].InstalledSkills) != 2 {
		t.Fatalf("relevance, current installations or installation link incorrect: %+v", items)
	}
	for _, skill := range items[0].InstalledSkills {
		if skill.AvailableInTask {
			t.Fatal("disabled automatic invocation must not make new task Skills available")
		}
	}
	items = search(onTask, agentRepositorySearchInput{Query: "公众号"})["repositories"].([]agentRepositoryKnowledge)
	if !items[0].InstalledSkills[0].AvailableInTask || items[0].InstalledSkills[1].Enabled || items[0].InstalledSkills[1].AvailableInTask {
		t.Fatalf("current enable state and pinned availability were confused: %+v", items)
	}
	page = search(offTask, agentRepositorySearchInput{Query: "CatalogAuthor", Category: "research"})
	if page["total"] != 1 || page["repositories"].([]agentRepositoryKnowledge)[0].WorkspaceID != knowledge {
		t.Fatalf("author/category search failed: %+v", page)
	}
	all := false
	page = search(offTask, agentRepositorySearchInput{Query: "catalog-review", InstallableOnly: &all})
	if page["total"] != 5 {
		t.Fatalf("general catalog must include reference projects, excluding deleted/withdrawn/private rows: %+v", page)
	}
	for _, item := range page["repositories"].([]agentRepositoryKnowledge) {
		if !item.KoiInstallable && item.InstallURL != "" || (strings.HasSuffix(item.Name, "/stale") || item.WorkspaceID == pending) && item.CompatibilityChecked {
			t.Fatalf("unverified/unsupported project offered for installation: %+v", item)
		}
	}
	// Changing settings cannot silently enable Skills in an already running task.
	if _, err := a.db.Exec(ctx, `UPDATE agent_session_settings SET auto_skills=true WHERE user_id=$1`, user.ID); err != nil {
		t.Fatal(err)
	}
	page = search(offTask, agentRepositorySearchInput{Query: "公众号"})
	if !page["skillSettings"].(koiSkillSettings).AutoSkills || page["automaticSkillUse"] != false || page["repositories"].([]agentRepositoryKnowledge)[0].InstalledSkills[0].AvailableInTask {
		t.Fatalf("account switch was confused with task availability: %+v", page)
	}

	// Exercise the actual authenticated MCP path, with automatic Skills off.
	srv := httptest.NewServer(a.Routes())
	defer srv.Close()
	client, err := connectMCPClient(ctx, srv.URL+"/api/writing-agent/mcp/"+offTask.ID, a.writingSecret(offTask.ID, "mcp"))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	result, err := client.CallTool(ctx, &mcp.CallToolParams{Name: "search_repositories", Arguments: map[string]any{"query": "公众号"}})
	if err != nil || result.IsError || result.StructuredContent == nil {
		t.Fatalf("catalog tool unavailable over MCP: %+v %v", result, err)
	}
}

func TestAgentRepositoryKnowledgeMoreRecommendations(t *testing.T) {
	a, user, _ := writingTestApp(t)
	ctx := context.Background()
	// More matches than the tool's maximum first page, with identical keywords.
	_, err := a.db.Exec(ctx, `WITH workspaces AS (
 INSERT INTO agent_workspaces(user_id,name,hub_category)
 SELECT $1,'pagination-review/'||n,'writing' FROM generate_series(1,14) n RETURNING id,name)
 INSERT INTO agent_repository_publications(workspace_id,revision,name,description,license,koi_installable,koi_installability_curation_revision,koi_installability_evidence)
 SELECT id,0,name,'公众号润色','MIT',true,(SELECT revision FROM agent_repository_curation_state WHERE singleton),$2 FROM workspaces`,
		user.ID, koiInstallabilityEvidence{RulesVersion: koiSkillEntryRulesVersion})
	if err != nil {
		t.Fatal(err)
	}
	task := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), model.Document{}, "推荐写作技能")
	ctx = context.WithValue(ctx, writingMCPContext{}, task)
	search := func(in agentRepositorySearchInput) map[string]any {
		t.Helper()
		_, result, err := a.agentSearchRepositories(ctx, nil, in)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	in := agentRepositorySearchInput{Query: "pagination-review", Limit: 5}
	seen := map[int64]bool{}
	for page := 0; ; page++ {
		result := search(in)
		if result["total"] != 14 || page > 2 {
			t.Fatalf("incomplete or looping pagination: %+v", result)
		}
		for _, item := range result["repositories"].([]agentRepositoryKnowledge) {
			if seen[item.WorkspaceID] {
				t.Fatal("repository repeated across pages")
			}
			seen[item.WorkspaceID] = true
		}
		in.Cursor = result["nextCursor"].(string)
		if result["hasMore"] != (in.Cursor != "") {
			t.Fatal("continuation flags disagree")
		}
		if in.Cursor == "" {
			break
		}
	}
	if len(seen) != 14 {
		t.Fatalf("repositories hidden past the first page: %d", len(seen))
	}
	in.Limit = 12
	first := search(in)["repositories"].([]agentRepositoryKnowledge)
	for _, item := range first {
		in.ExcludeWorkspaceIDs = append(in.ExcludeWorkspaceIDs, item.WorkspaceID)
	}
	remaining := search(in)
	if remaining["total"] != 2 || remaining["hasMore"] != false {
		t.Fatalf("exclusions must count remaining matches: %+v", remaining)
	}
	for _, item := range remaining["repositories"].([]agentRepositoryKnowledge) {
		for _, excluded := range in.ExcludeWorkspaceIDs {
			if item.WorkspaceID == excluded {
				t.Fatal("previous recommendation was returned again")
			}
		}
	}
}

func TestAgentRepositoryKnowledgeBothEntriesWithAutomaticSkillsOff(t *testing.T) {
	a, user, doc := writingTestApp(t)
	a.cfg.KoiSkillTestAccounts = []string{user.AuthUserID}
	ctx := context.Background()
	if _, err := a.db.Exec(ctx, `INSERT INTO agent_session_settings(user_id,auto_skills,library_mode) VALUES($1,false,'installed') ON CONFLICT(user_id) DO UPDATE SET auto_skills=false`, user.ID); err != nil {
		t.Fatal(err)
	}
	for _, article := range []bool{false, true} {
		s := agentTestSession(t, a, user, "review")
		if article {
			response := writingTestRequest(t, a, user, "POST", "/api/documents/"+doc.DocID+"/koi-session", nil)
			var out struct{ Session agentSession }
			if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &out) != nil {
				t.Fatal(response.Code, response.Body.String())
			}
			s = out.Session
		}
		task := agentTestTask(t, a, user, s, model.Document{}, "Koinote 有什么功能，有没有适合我的技能？")
		wire := map[string]any{"policy": map[string]any{}}
		if err := a.prepareAgentIntentInput(ctx, &task, wire, ""); err != nil {
			t.Fatal(err)
		}
		tools := strings.Join(wire["policy"].(map[string]any)["allowTools"].([]string), ",")
		if !strings.Contains(tools, "koinote.search_repositories") || strings.Contains(tools, "koinote.find_skills") || strings.Contains(tools, "koinote.load_skill") || article && strings.Contains(tools, "koinote.propose_operations") {
			t.Fatalf("recommendation widened invocation or writing policy: %s", tools)
		}
		if !strings.Contains(wire["systemPrompt"].(string), agentProductKnowledgeInstructions) || article && !strings.Contains(wire["systemPrompt"].(string), "咨询产品功能、仓库或技能推荐时不必读取文章") {
			t.Fatal("missing product knowledge or general-question scope")
		}
		_, result, err := a.agentSearchRepositories(context.WithValue(ctx, writingMCPContext{}, task), nil, agentRepositorySearchInput{})
		if err != nil || result["automaticSkillUse"] != false || result["skillSettings"].(koiSkillSettings).AutoSkills || result["manageSkillsUrl"] != agentSkillsManageURL {
			t.Fatalf("activation guidance unavailable in entry article=%t: %+v %v", article, result, err)
		}
	}
}

func TestAgentRepositoryKnowledgeRejectsInvalidInput(t *testing.T) {
	a := &App{}
	ctx := context.WithValue(context.Background(), writingMCPContext{}, writingTask{Conversation: true})
	for _, input := range []agentRepositorySearchInput{{Query: strings.Repeat("a", 81)}, {Query: strings.Repeat("a ", 9)}, {Category: "unknown"}, {Limit: -1}, {Limit: 13}, {Cursor: "invalid"}, {Cursor: encodeMCPCursor(-1)}, {ExcludeWorkspaceIDs: []int64{0}}, {ExcludeWorkspaceIDs: make([]int64, 101)}} {
		if _, _, err := a.agentSearchRepositories(ctx, nil, input); !errors.Is(err, errAgentInput) {
			t.Fatalf("invalid input accepted: %+v %v", input, err)
		}
	}
}
