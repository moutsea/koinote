package server

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"
)

func TestSystemRepositoryDiscoveryRelevantSearchAndRanking(t *testing.T) {
	app, _, f := newDiscoveryFixture(t, 3)
	f.items[0].Name, f.items[0].Description = "Tech-Doc-Style-Chinese", "Chinese technical writing"
	f.items[1].Name, f.items[1].Description = "obsidian-skills", "Knowledge management"
	searched := map[string]bool{}
	client := app.githubHTTPClient.Transport
	app.githubHTTPClient.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/search/repositories" {
			searched[strings.Split(r.URL.Query().Get("q"), " stars:")[0]] = true
		}
		return client.RoundTrip(r)
	})
	items, err := app.searchSystemRepositoryCandidates(context.Background(), "discovery-test-token")
	if err != nil || len(items) != 3 || items[0].ID != f.items[1].ID || items[1].ID != f.items[0].ID || items[2].ID != f.items[2].ID {
		t.Fatalf("targeted candidates must precede generic coding repos, then rank by stars: %+v %v", items, err)
	}
	for _, query := range []string{"writing skill in:name,description", "写作 skill in:name,description", "obsidian skill in:name,description", "knowledge skill in:name,description", `"second brain" skill in:name,description`, "humanizer in:name,description", "topic:agent-skills"} {
		if !searched[query] {
			t.Errorf("missing discovery search: %s", query)
		}
	}
}

func TestSystemRepositoryDiscoveryCategories(t *testing.T) {
	for _, tc := range []struct{ name, description, category string }{
		{"Humanizer-zh", "", "writing"},
		{"avoid-ai-writing", "", "writing"},
		{"Tech-Doc-Style-Chinese", "", "writing"},
		{"skills", "中文写作与润色", "writing"},
		{"x-made-easy-skill", "A Chinese Made Easy writing skill inspired by Calculus Made Easy", "writing"},
		{"obsidian-skills", "", "research"},
		{"research-writing-skill", "Academic writing", "research"},
		{"learn-from-materials", "", "research"},
		{"skills", "Organize an Obsidian knowledge base", "research"},
		{"notes", "将材料整理成知识库与阅读笔记", "research"},
		{"bama", "Agent skills to research, clone and build native macOS apps", "agents"},
		{"skills", "Reusable coding skills", "agents"},
	} {
		if got := systemRepositoryDiscoveryCategory(tc.name, tc.description); got != tc.category {
			t.Errorf("%q: got %q, want %q", tc.name, got, tc.category)
		}
	}
}

func TestDiscoveredKoiSkillsMatchInstallationPreview(t *testing.T) {
	for _, tc := range []struct {
		name, entry, extraPath, extraContent, code string
	}{
		{"writing instructions", "---\nname: writing\ndescription: Polish an article\n---\nImprove clarity.", "", "", ""},
		{"missing description", "---\nname: writing\n---\nImprove clarity.", "", "", "no_koi_compatible_skills"},
		{"local shell", "---\nname: writing\ndescription: Rewrite\nallowed-tools: Bash\n---\nRun a command.", "", "", "no_koi_compatible_skills"},
		{"oversized package member", "# Rewrite", "reference.md", strings.Repeat("a", koiSkillFileBytes+1), "no_koi_compatible_skills"},
		{"mixed collection", "---\nname: local\ndescription: Local\nallowed-tools: Bash\n---\nRun a command.", "writing/SKILL.md", "# Rewrite", ""},
		{"readme only", "", "README.md", "# Writing skills", "no_skills"},
		{"wrong entry case", "", "skill.md", "# Rewrite", "no_skills"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			files := []agentWorkspaceFile{repositoryTestFile("LICENSE", discoveryMIT)}
			if tc.entry != "" {
				files = append(files, repositoryTestFile("SKILL.md", tc.entry))
			}
			if tc.extraPath != "" {
				files = append(files, repositoryTestFile(tc.extraPath, tc.extraContent))
			}
			if code := validateDiscoveredSkills(files, 12345, "MIT"); code != tc.code {
				t.Fatalf("validation = %q, want %q", code, tc.code)
			}
		})
	}
	for _, limit := range []string{"files", "bytes"} {
		t.Run("Hub preview "+limit+" limit", func(t *testing.T) {
			files := []agentWorkspaceFile{repositoryTestFile("LICENSE", discoveryMIT)}
			count := koiSkillImportFiles
			if limit == "bytes" {
				count = koiSkillImportBytes/koiSkillFileBytes + 1
			}
			for i := 0; i < count; i++ {
				dir := fmt.Sprintf("skills/%d/", i)
				files = append(files, repositoryTestFile(dir+"SKILL.md", "# Rewrite"))
				if limit == "bytes" {
					files = append(files, repositoryTestFile(dir+"reference.md", strings.Repeat("a", koiSkillFileBytes)))
				}
			}
			if code := validateDiscoveredKoiSkills(files, "MIT"); code != "koi_preview_too_large" {
				t.Fatalf("root preview cannot read this collection: %q", code)
			}
		})
	}
}

func TestSystemRepositoryDiscoveryPublishesInstallableCategory(t *testing.T) {
	app, _, f := newDiscoveryFixture(t, 1)
	f.items[0].Description = "中文文章写作与润色"
	summary, results, err := runDiscovery(app, true)
	if err != nil || summary.Added != 1 || results[0].Category != "writing" {
		t.Fatalf("discovery: %+v %+v %v", summary, results, err)
	}
	view, err := app.loadPublicAgentRepository(context.Background(), results[0].WorkspaceID, nil)
	if err != nil || view.Category != "writing" {
		t.Fatalf("published category: %+v %v", view, err)
	}
	if value := repositoryKoiInstallability(t, app, view.WorkspaceID); value == nil || !*value {
		t.Fatal("verified discoveries must enter the installable group immediately")
	}
	source, err := app.readKoiHubSource(context.Background(), koiHubSourceInput{WorkspaceID: view.WorkspaceID, PublicationID: view.PublicationID, Revision: &view.Revision})
	if err != nil {
		t.Fatal(err)
	}
	candidates, rejected := koiSkillCandidates(source.Files)
	if len(candidates) != 1 || len(rejected) != 0 {
		t.Fatalf("published repo cannot be installed: %+v %+v", candidates, rejected)
	}
}

func TestDiscoveredRepositoryUpdatesKeepInstallableSnapshot(t *testing.T) {
	app, workspace, _, _, upstream := seedSystemRepositorySync(t, true)
	ctx := context.Background()
	_, err := app.db.Exec(ctx, `INSERT INTO agent_repository_discoveries(github_id,repository_url,github_stars,code,accepted_on,workspace_id)
 VALUES($1,$2,100,'added',CURRENT_DATE,$3)`, workspace.GitHubSource.RepositoryID, workspace.GitHubSource.RepositoryURL, workspace.WorkspaceID)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = app.db.Exec(context.Background(), `DELETE FROM agent_repository_discoveries WHERE github_id=$1`, workspace.GitHubSource.RepositoryID)
	})
	before, err := app.loadPublicAgentRepository(ctx, workspace.WorkspaceID, nil)
	if err != nil {
		t.Fatal(err)
	}
	summary, results, err := runSystemRepositorySync(t, app, workspace.WorkspaceID, true)
	if err != nil || summary.Skipped != 1 || len(results) != 1 || results[0].Code != "koi_skills_unavailable" {
		t.Fatalf("incompatible update: %+v %+v %v", summary, results, err)
	}
	after, err := app.loadPublicAgentRepository(ctx, workspace.WorkspaceID, nil)
	if err != nil || before.Revision != after.Revision || before.PublicationID != after.PublicationID || before.GitHubSource.CommitSHA != after.GitHubSource.CommitSHA {
		t.Fatalf("incompatible update replaced saved publication: %+v %v", after, err)
	}
	upstream.archive = githubArchive(t, githubArchiveEntry{"root/LICENSE", discoveryMIT, 0}, githubArchiveEntry{"root/SKILL.md", "# Polish writing", 0})
	summary, results, err = runSystemRepositorySync(t, app, workspace.WorkspaceID, true)
	if err != nil || summary.Updated != 1 {
		t.Fatalf("compatible upstream cannot recover: %+v %+v %v", summary, results, err)
	}
	if value := repositoryKoiInstallability(t, app, workspace.WorkspaceID); value == nil || !*value {
		t.Fatal("sync did not refresh the installation priority with its publication")
	}
}

func TestDiscoveredRepositoryCategoryBackfillPreservesManualAndPrivateCopies(t *testing.T) {
	app, _, _ := newDiscoveryFixture(t, 6)
	_, results, err := runDiscovery(app, true)
	if err != nil || len(results) != 6 {
		t.Fatalf("seed: %+v %v", results, err)
	}
	ctx := context.Background()
	user := seedMCPUser(t, app.db, app, membershipTierLifetime)
	for i, result := range results {
		url := "https://github.com/op7418/Humanizer-zh"
		if i == 1 {
			url = "https://github.com/dmoshehun-prog/learn-from-materials"
		}
		if _, err = app.db.Exec(ctx, `UPDATE agent_workspaces SET github_source=jsonb_set(github_source,'{repositoryUrl}',to_jsonb($2::text)) WHERE id=$1`, result.WorkspaceID, url); err != nil {
			t.Fatal(err)
		}
	}
	_, err = app.db.Exec(ctx, `UPDATE agent_workspaces SET hub_category='product' WHERE id=$1`, results[2].WorkspaceID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = app.db.Exec(ctx, `INSERT INTO agent_repository_system_events(workspace_id,actor_user_id,action,revision) VALUES($1,$2,'publish',1)`, results[3].WorkspaceID, user.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = app.db.Exec(ctx, `UPDATE agent_workspaces SET is_system=false,user_id=$2 WHERE id=$1`, results[4].WorkspaceID, user.ID); err != nil {
		t.Fatal(err)
	}
	if _, err = app.db.Exec(ctx, `DELETE FROM agent_repository_publications WHERE workspace_id=$1`, results[5].WorkspaceID); err != nil {
		t.Fatal(err)
	}
	snapshot := func() string {
		t.Helper()
		var value string
		if err := app.db.QueryRow(ctx, `SELECT jsonb_agg(jsonb_build_object('workspace',to_jsonb(w)-'hub_category','publication',to_jsonb(p)) ORDER BY w.id)::text
 FROM agent_workspaces w LEFT JOIN agent_repository_publications p ON p.workspace_id=w.id WHERE w.id=ANY($1)`, []int64{results[0].WorkspaceID, results[1].WorkspaceID, results[2].WorkspaceID, results[3].WorkspaceID, results[4].WorkspaceID, results[5].WorkspaceID}).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	before := snapshot()
	migration, err := os.ReadFile("../../migrations/0113_discovered_repository_categories.sql")
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, err = app.db.Exec(ctx, string(migration)); err != nil {
			t.Fatal(err)
		}
	}
	for i, want := range []string{"writing", "research", "product", "agents", "agents", "agents"} {
		var category string
		if err = app.db.QueryRow(ctx, `SELECT hub_category FROM agent_workspaces WHERE id=$1`, results[i].WorkspaceID).Scan(&category); err != nil || category != want {
			t.Errorf("row %d: category %q, want %q: %v", i, category, want, err)
		}
	}
	if before != snapshot() {
		t.Fatal("classification changed repository content, versions or publication identity")
	}
}
