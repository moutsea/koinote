package server

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"testing"

	"koinote/backend/internal/config"
)

func TestAgentRepositoryDirectoryFiltersAndPagination(t *testing.T) {
	pool := newGCTestPool(t)
	ctx := context.Background()
	app := New(config.Config{SessionSecret: "directory-filters"}, pool)
	owner := seedMCPUser(t, pool, app, membershipTierLifetime)
	var ids []int64
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM agent_workspaces WHERE id=ANY($1::bigint[])`, ids)
	})
	add := func(system bool, category string, published, deleted bool) {
		t.Helper()
		var userID *int
		if !system {
			userID = &owner.ID
		}
		var id int64
		source := &agentGitHubSource{Author: "OriginalAuthor", RepositoryURL: "https://github.com/example/skills"}
		err := pool.QueryRow(ctx, `INSERT INTO agent_workspaces(user_id,is_system,name,description,hub_category,deleted_at)
          VALUES($1,$2,'private-name-secret','private-description-secret',$3,CASE WHEN $4 THEN now() END) RETURNING id`, userID, system, category, deleted).Scan(&id)
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
		if published {
			if _, err = pool.Exec(ctx, `INSERT INTO agent_repository_publications(workspace_id,revision,name,description,license,github_source,published_at)
              VALUES($1,0,$2,'Public skills','MIT',$3,'2026-10-01T12:00:00Z')`, id, fmt.Sprintf("Public %d", id), source); err != nil {
				t.Fatal(err)
			}
		}
	}
	for range publicRepositoryPageSize + 1 {
		add(true, "design", true, false)
	}
	for range 2 {
		add(true, "agents", true, false)
		add(false, "design", true, false)
	}
	for range 3 {
		add(false, "writing", true, false)
	}
	add(true, "research", false, false)
	add(false, "media", true, true)
	type page struct {
		Repositories []agentRepositoryDirectoryItem
		NextCursor   *string
		Total        int
		Facets       []agentRepositoryDirectoryFacet
	}
	get := func(path string) page {
		var result page
		decodeJSONResponse(t, callRepositoryAPI(t, app, nil, http.MethodGet, path, "", 200), &result)
		return result
	}
	all := get("/api/agent/repositories")
	if all.Total != publicRepositoryPageSize+8 || len(all.Repositories) != publicRepositoryPageSize || len(all.Facets) != 4 {
		t.Fatalf("incomplete directory metadata: %+v", all)
	}
	first := get("/api/agent/repositories?source=system&category=design")
	if first.Total != publicRepositoryPageSize+1 || len(first.Repositories) != publicRepositoryPageSize || first.NextCursor == nil {
		t.Fatalf("filter applied after pagination: %+v", first)
	}
	seen := map[int64]bool{}
	for _, item := range first.Repositories {
		if !item.SystemManaged || item.Category != "design" {
			t.Fatalf("wrong category: %+v", item)
		}
		seen[item.WorkspaceID] = true
	}
	second := get("/api/agent/repositories?source=system&category=design&cursor=" + url.QueryEscape(*first.NextCursor))
	if len(second.Repositories) != 1 || second.NextCursor != nil || seen[second.Repositories[0].WorkspaceID] || second.Total != 0 || second.Facets != nil {
		t.Fatalf("cursor lost or repeated results: %+v", second)
	}
	callRepositoryAPI(t, app, nil, http.MethodGet, "/api/agent/repositories?category=writing&cursor="+url.QueryEscape(*first.NextCursor), "", 400)
	community := get("/api/agent/repositories?source=community&category=design")
	if community.Total != 2 || len(community.Repositories) != 2 {
		t.Fatalf("community filter: %+v", community)
	}
	for _, item := range community.Repositories {
		if item.SystemManaged {
			t.Fatal("system repo in community")
		}
	}
	if got := get("/api/agent/repositories?q=OriginalAuthor&source=system"); got.Total != publicRepositoryPageSize+3 {
		t.Fatalf("author search: %d", got.Total)
	}
	for _, query := range []string{"private-name-secret", "private-description-secret", "absent"} {
		got := get("/api/agent/repositories?q=" + query)
		if got.Total != 0 || len(got.Repositories) != 0 || len(got.Facets) != 0 {
			t.Fatalf("private metadata searchable: %+v", got)
		}
	}
	for _, query := range []string{"source=admin", "category=unknown", "category=design%27", "cursor=invalid"} {
		callRepositoryAPI(t, app, nil, http.MethodGet, "/api/agent/repositories?"+query, "", 400)
	}
}

func TestAgentRepositoryPublicationCategory(t *testing.T) {
	pool := newGCTestPool(t)
	ctx := context.Background()
	app := New(config.Config{SessionSecret: "publication-category"}, pool)
	owner := seedMCPUser(t, pool, app, membershipTierLifetime)
	if _, err := pool.Exec(ctx, `INSERT INTO agent_workspace_settings(user_id,enabled) VALUES($1,true)`, owner.ID); err != nil {
		t.Fatal(err)
	}
	repository, err := app.createAgentWorkspace(ctx, owner.ID, "Categorized", "", "en")
	if err != nil {
		t.Fatal(err)
	}
	cookie := mcpSessionCookie(app, owner.AuthUserID)
	path := fmt.Sprintf("/api/agent/workspaces/%d/sharing", repository.WorkspaceID)
	payload := fmt.Sprintf(`{"expectedRevision":%d,"license":"MIT","category":"writing"}`, repository.Revision)
	callRepositoryAPI(t, app, cookie, http.MethodPut, path, payload, 200)
	public, err := app.loadPublicAgentRepository(ctx, repository.WorkspaceID, nil)
	if err != nil || public.Category != "writing" {
		t.Fatalf("category not published: %+v %v", public, err)
	}
	// Older clients omit category; withdrawal and republication must keep it.
	oldPayload := fmt.Sprintf(`{"expectedRevision":%d,"license":"MIT"}`, repository.Revision)
	callRepositoryAPI(t, app, cookie, http.MethodDelete, path, oldPayload, 200)
	callRepositoryAPI(t, app, cookie, http.MethodPut, path, oldPayload, 200)
	public, err = app.loadPublicAgentRepository(ctx, repository.WorkspaceID, nil)
	if err != nil || public.Category != "writing" {
		t.Fatalf("legacy client erased category: %+v %v", public, err)
	}
	callRepositoryAPI(t, app, cookie, http.MethodPut, path, fmt.Sprintf(`{"expectedRevision":%d,"license":"MIT","category":"bad"}`, repository.Revision), 400)
	callRepositoryAPI(t, app, cookie, http.MethodPut, path, `{"expectedRevision":9999,"license":"MIT","category":"design"}`, 409)
	public, err = app.loadPublicAgentRepository(ctx, repository.WorkspaceID, nil)
	if err != nil || public.Category != "writing" {
		t.Fatal("rejected publication changed classification")
	}
}

func TestAgentRepositorySitemapListsWholeDirectory(t *testing.T) {
	pool := newGCTestPool(t)
	ctx := context.Background()
	app := New(config.Config{SessionSecret: "directory-sitemap"}, pool)
	var ids []int64
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM agent_workspaces WHERE id=ANY($1::bigint[])`, ids)
	})
	add := func(published, deleted bool, minute int) int64 {
		t.Helper()
		var id int64
		if err := pool.QueryRow(ctx, `INSERT INTO agent_workspaces(is_system,name,description,hub_category,deleted_at)
          VALUES(true,'sitemap','','agents',CASE WHEN $1 THEN now() END) RETURNING id`, deleted).Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
		if published {
			if _, err := pool.Exec(ctx, `INSERT INTO agent_repository_publications(workspace_id,revision,name,description,license,published_at)
              VALUES($1,0,'Sitemap','','MIT',timestamptz '2026-10-01T00:00:00Z' + make_interval(mins => $2))`, id, minute); err != nil {
				t.Fatal(err)
			}
		}
		return id
	}
	// More than two directory pages: the old edge walk stopped after a fixed number of pages
	want := map[int64]bool{}
	for i := range 2*publicRepositoryPageSize + 1 {
		want[add(true, false, i)] = true
	}
	withdrawn := add(true, true, 1000)
	unpublished := add(false, false, 0)

	var result struct {
		Repositories []agentRepositorySitemapEntry `json:"repositories"`
	}
	decodeJSONResponse(t, callRepositoryAPI(t, app, nil, http.MethodGet, "/api/agent/repositories/sitemap", "", 200), &result)
	var previous *agentRepositorySitemapEntry
	for i, entry := range result.Repositories {
		if entry.WorkspaceID == withdrawn || entry.WorkspaceID == unpublished {
			t.Fatalf("sitemap lists a repository the directory hides: %d", entry.WorkspaceID)
		}
		if previous != nil && entry.UpdatedAt.After(previous.UpdatedAt) {
			t.Fatalf("sitemap not ordered by publication time at %d", i)
		}
		previous = &result.Repositories[i]
		delete(want, entry.WorkspaceID)
	}
	if len(want) != 0 {
		t.Fatalf("sitemap missing %d published repositories", len(want))
	}
	// The literal route must not shadow real repository IDs
	callRepositoryAPI(t, app, nil, http.MethodGet, fmt.Sprintf("/api/agent/repositories/%d", ids[0]), "", 200)
}
