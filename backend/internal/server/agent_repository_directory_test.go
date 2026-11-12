package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"testing"
	"time"

	"koinote/backend/internal/config"
)

func TestAgentRepositoryDirectoryKoiPriorityAcrossPages(t *testing.T) {
	ctx := context.Background()
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "directory-koi-priority"}, pool)
	owner := seedMCPUser(t, pool, app, membershipTierLifetime)
	var ids []int64
	t.Cleanup(func() { _, _ = pool.Exec(context.Background(), `DELETE FROM agent_workspaces WHERE id=ANY($1)`, ids) })
	for i := 0; i < 2*publicRepositoryPageSize+3; i++ {
		var id int64
		if err := pool.QueryRow(ctx, `INSERT INTO agent_workspaces(user_id,name,description,hub_category) VALUES($1,'priority-test','','writing') RETURNING id`, owner.ID).Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
		var installable *bool
		if i != 2*publicRepositoryPageSize+2 { // Unchecked entries share the ordinary group.
			value := i <= publicRepositoryPageSize
			installable = &value
		}
		if _, err := pool.Exec(ctx, `INSERT INTO agent_repository_publications(workspace_id,revision,name,description,license,published_at,koi_installable)
 VALUES($1,0,'priority-test','','MIT',timestamptz '2026-10-01T00:00:00Z'+make_interval(mins=>$2),$3)`, id, i, installable); err != nil {
			t.Fatal(err)
		}
	}
	type page struct {
		Repositories []agentRepositoryDirectoryItem
		NextCursor   *string
		Total        int
	}
	get := func(path string) page {
		t.Helper()
		var result page
		decodeJSONResponse(t, callRepositoryAPI(t, app, nil, http.MethodGet, path, "", 200), &result)
		return result
	}
	want := append([]int64{}, ids[:publicRepositoryPageSize+1]...)
	for i, j := 0, len(want)-1; i < j; i, j = i+1, j-1 {
		want[i], want[j] = want[j], want[i]
	}
	for i := len(ids) - 1; i > publicRepositoryPageSize; i-- {
		want = append(want, ids[i])
	}
	// Filters must preserve the same global ranking, not sort one page at a time.
	for _, filter := range []string{"", "&category=writing&source=community"} {
		path := "/api/agent/repositories?q=priority-test" + filter
		var got []agentRepositoryDirectoryItem
		for pageNumber := 0; pageNumber < 4; pageNumber++ {
			result := get(path)
			if pageNumber == 0 && result.Total != len(want) {
				t.Fatalf("wrong count: %d", result.Total)
			}
			got = append(got, result.Repositories...)
			if result.NextCursor == nil {
				break
			}
			path = "/api/agent/repositories?q=priority-test" + filter + "&cursor=" + url.QueryEscape(*result.NextCursor)
		}
		if len(got) != len(want) {
			t.Fatalf("pagination omitted or repeated rows: got %d, want %d", len(got), len(want))
		}
		for i, item := range got {
			if item.WorkspaceID != want[i] || item.KoiInstallable != (i <= publicRepositoryPageSize) {
				t.Fatalf("rank %d: %+v, want workspace %d", i, item, want[i])
			}
		}
	}
	// Clients already browsing before rollout may still hold a time-only cursor.
	legacyAt := 2*publicRepositoryPageSize - 1
	encoded, _ := json.Marshal(map[string]any{"id": ids[legacyAt], "publishedAt": time.Date(2026, 10, 1, 0, legacyAt, 0, 0, time.UTC)})
	legacy := get("/api/agent/repositories?q=priority-test&cursor=" + base64.RawURLEncoding.EncodeToString(encoded))
	if len(legacy.Repositories) == 0 || legacy.Repositories[0].WorkspaceID != ids[legacyAt-1] {
		t.Fatal("an older client's cursor changed ordering in the middle of browsing")
	}
}

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
