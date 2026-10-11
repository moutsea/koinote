package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"koinote/backend/internal/config"
)

func TestAgentRepositoryPersonalSlotsExcludeSystem(t *testing.T) {
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "system-slots"}, pool)
	ctx := context.Background()
	user := seedMCPUser(t, pool, app, membershipTierLifetime)
	if _, err := pool.Exec(ctx, `UPDATE users SET is_admin=true WHERE id=$1`, user.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO agent_workspace_storage_quotas(user_id,bonus_bytes) VALUES($1,200000000)`, user.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO agent_workspaces(user_id,name) SELECT $1,'Private '||n FROM generate_series(1,100) n`, user.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := app.createAgentWorkspace(ctx, user.ID, "Over personal limit", "", "en"); !errors.Is(err, errAgentWorkspaceLimit) {
		t.Fatalf("bonus must not add personal slots: %v", err)
	}
}

func TestSystemAgentRepositoryLifecycle(t *testing.T) {
	for _, storage := range []string{"legacy", "r2"} {
		t.Run(storage, func(t *testing.T) {
			ctx := context.Background()
			pool := newGCTestPool(t)
			app := New(config.Config{SessionSecret: "system-repository", AppURL: "https://koinote.example"}, pool)
			if storage == "r2" {
				enableRepositoryR2Fixture(t, app)
			}
			admin := seedMCPUser(t, pool, app, membershipTierFree)
			otherAdmin := seedMCPUser(t, pool, app, membershipTierLifetime)
			member := seedMCPUser(t, pool, app, membershipTierLifetime)
			if _, err := pool.Exec(ctx, `UPDATE users SET is_admin=true WHERE id=ANY($1::int[])`, []int{admin.ID, otherAdmin.ID}); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(ctx, `INSERT INTO agent_workspace_settings(user_id,enabled) VALUES($1,true),($2,true)`, member.ID, otherAdmin.ID); err != nil {
				t.Fatal(err)
			}
			cookie, otherCookie := mcpSessionCookie(app, admin.AuthUserID), mcpSessionCookie(app, otherAdmin.AuthUserID)
			// Free administrators can configure import access without upgrading or enabling personal sync.
			callRepositoryAPI(t, app, cookie, http.MethodPut, "/api/agent/github-credential", `{"token":"github_pat_system_fixture_token"}`, 200)
			callRepositoryAPI(t, app, cookie, http.MethodDelete, "/api/agent/github-credential", "", 200)
			const base = "/api/admin/agent-repositories"
			callRepositoryAPI(t, app, nil, http.MethodGet, base, "", 401)
			callRepositoryAPI(t, app, mcpSessionCookie(app, member.AuthUserID), http.MethodPost, base+"/import/github", `{}`, 403)
			archive := githubArchive(t, githubArchiveEntry{"root/README.md", "# System demo", 0}, githubArchiveEntry{"root/LICENSE", "MPL-2.0", 0})
			app.githubHTTPClient = githubImportClient(t, archive, "", false)
			requestID, _ := randomUUID()
			body := fmt.Sprintf(`{"repositoryUrl":"https://github.com/octo/demo","requestId":%q}`, requestID)
			app.githubHTTPClient = githubImportClient(t, archive, "", true)
			callRepositoryAPI(t, app, cookie, http.MethodPost, base+"/import/github", body, 400)
			app.githubHTTPClient = githubImportClient(t, archive, "", false)
			var output struct{ Workspace agentWorkspaceView }
			decodeJSONResponse(t, callRepositoryAPI(t, app, cookie, http.MethodPost, base+"/import/github", body, 201), &output)
			w := output.Workspace
			t.Cleanup(func() {
				_, _ = pool.Exec(context.Background(), `DELETE FROM agent_repository_system_events WHERE workspace_id=$1`, w.WorkspaceID)
				_, _ = pool.Exec(context.Background(), `DELETE FROM agent_workspaces WHERE id=$1`, w.WorkspaceID)
			})
			if !w.SystemManaged || w.GitHubSource.Author != "Octo" || w.GitHubSource.RepositoryURL != "https://github.com/Octo/demo" {
				t.Fatalf("system provenance: %+v", w)
			}
			var owner *int
			if err := pool.QueryRow(ctx, `SELECT user_id FROM agent_workspaces WHERE id=$1`, w.WorkspaceID).Scan(&owner); err != nil || owner != nil {
				t.Fatalf("owned by person: %v %v", owner, err)
			}
			var count, quotaRows int
			var used int64
			if err := pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM agent_workspaces WHERE user_id=$1),agent_workspace_storage_bytes($1),(SELECT count(*) FROM agent_workspace_storage_quotas WHERE user_id=$1)`, admin.ID).Scan(&count, &used, &quotaRows); err != nil || count != 0 || used != 0 || quotaRows != 0 {
				t.Fatalf("personal quota changed: %d %d %d %v", count, used, quotaRows, err)
			}
			if _, err := app.loadAgentWorkspace(ctx, admin.ID, w.WorkspaceID); !errors.Is(err, errAgentWorkspaceNotFound) {
				t.Fatalf("personal read allowed: %v", err)
			}
			// All admins share an idempotency scope; retries require no upstream access.
			app.githubHTTPClient = nil
			decodeJSONResponse(t, callRepositoryAPI(t, app, otherCookie, http.MethodPost, base+"/import/github", body, 201), &output)
			if output.Workspace.WorkspaceID != w.WorkspaceID {
				t.Fatal("retry duplicated system repo")
			}
			changed := strings.Replace(body, `"repositoryUrl":`, `"name":"different","repositoryUrl":`, 1)
			callRepositoryAPI(t, app, otherCookie, http.MethodPost, base+"/import/github", changed, 409)
			sharing := fmt.Sprintf("%s/%d/sharing", base, w.WorkspaceID)
			personalSharing := fmt.Sprintf("/api/agent/workspaces/%d/sharing", w.WorkspaceID)
			callRepositoryAPI(t, app, otherCookie, http.MethodPut, personalSharing, fmt.Sprintf(`{"expectedRevision":%d,"license":"MPL-2.0"}`, w.Revision), 404)
			publish := fmt.Sprintf(`{"expectedRevision":%d,"license":"MPL-2.0"}`, w.Revision)
			callRepositoryAPI(t, app, otherCookie, http.MethodPut, sharing, publish, 200)
			publicPath := fmt.Sprintf("/api/agent/repositories/%d", w.WorkspaceID)
			var public struct{ Repository agentRepositoryPublication }
			decodeJSONResponse(t, callRepositoryAPI(t, app, nil, http.MethodGet, publicPath, "", 200), &public)
			if !public.Repository.SystemManaged || public.Repository.GitHubSource.Author != "Octo" {
				t.Fatal("public scope or attribution lost")
			}
			list := callRepositoryAPI(t, app, nil, http.MethodGet, "/api/agent/repositories", "", 200)
			if !strings.Contains(list.Body.String(), `"systemManaged":true`) {
				t.Fatal("public list lost system marker")
			}
			file := w.Files[0]
			callRepositoryAPI(t, app, nil, http.MethodGet, fmt.Sprintf("%s/files/%d?revision=%d", publicPath, file.FileID, w.Revision), "", 200)
			forkID, _ := randomUUID()
			fork, err := app.forkAgentRepository(ctx, member.ID, w.WorkspaceID, w.Revision, forkID)
			if err != nil || fork.SystemManaged || fork.GitHubSource.Author != "Octo" {
				t.Fatalf("fork should be personal with provenance: %+v %v", fork, err)
			}
			// Agent tokens are never administrators, even when issued by an admin.
			var token createdMCPToken
			decodeJSONResponse(t, callRepositoryAPI(t, app, otherCookie, http.MethodPost, "/api/mcp/tokens", `{"name":"System denied","scope":"agent_write"}`, 201), &token)
			for _, method := range []string{http.MethodGet, http.MethodPut, http.MethodDelete} {
				req := httptest.NewRequest(method, sharing, strings.NewReader(publish))
				req.Header.Set("Authorization", "Bearer "+token.Secret)
				rec := httptest.NewRecorder()
				app.Routes().ServeHTTP(rec, req)
				if rec.Code != 401 && rec.Code != 403 {
					t.Fatalf("MCP token admitted: %d", rec.Code)
				}
			}
			// Deleting the curator account does not delete public files or the catalog.
			if _, err := pool.Exec(ctx, `DELETE FROM users WHERE id=$1`, admin.ID); err != nil {
				t.Fatal(err)
			}
			callRepositoryAPI(t, app, nil, http.MethodGet, publicPath, "", 200)
			callRepositoryAPI(t, app, otherCookie, http.MethodDelete, sharing, publish, 200)
			callRepositoryAPI(t, app, nil, http.MethodGet, publicPath, "", 404)
			var listing struct {
				Repositories []struct {
					WorkspaceID       int64
					PublishedRevision *int64
				}
			}
			decodeJSONResponse(t, callRepositoryAPI(t, app, otherCookie, http.MethodGet, base, "", 200), &listing)
			found := false
			for _, item := range listing.Repositories {
				if item.WorkspaceID == w.WorkspaceID {
					found = item.PublishedRevision == nil
				}
			}
			if !found {
				t.Fatal("unpublished system repository cannot be managed")
			}
			callRepositoryAPI(t, app, otherCookie, http.MethodPut, sharing, publish, 200)
			if storage == "legacy" {
				enableRepositoryR2Fixture(t, app)
				if n, err := app.migrateAgentRepositoryObjects(ctx, 20); err != nil || n < 2 {
					t.Fatalf("system R2 migration: %d %v", n, err)
				}
				callRepositoryAPI(t, app, nil, http.MethodGet, fmt.Sprintf("%s/files/%d?revision=%d", publicPath, file.FileID, w.Revision), "", 200)
			}
			var events int
			if err := pool.QueryRow(ctx, `SELECT count(*) FROM agent_repository_system_events WHERE workspace_id=$1`, w.WorkspaceID).Scan(&events); err != nil || events != 4 {
				t.Fatalf("audit events: %d %v", events, err)
			}
		})
	}
}

func TestCuratedRepositoryOwnershipMigration(t *testing.T) {
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "catalog-migration"}, pool)
	ctx := context.Background()
	admin := seedMCPUser(t, pool, app, membershipTierLifetime)
	member := seedMCPUser(t, pool, app, membershipTierLifetime)
	if _, err := pool.Exec(ctx, `UPDATE users SET is_admin=true,email='cfjwlchangji@gmail.com' WHERE id=$1`, admin.ID); err != nil {
		t.Fatal(err)
	}
	var catalog struct {
		Repositories []struct {
			RequestID     string
			RepositoryURL string
			CommitSHA     string
			SizeBytes     int64
		}
	}
	data, err := os.ReadFile("../../../data/agent-repositories/catalog.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &catalog); err != nil {
		t.Fatal(err)
	}
	// A second administrator imported the same catalog ID first. Prefer the
	// published original below without deleting or adopting this personal copy.
	otherAdmin := seedMCPUser(t, pool, app, membershipTierLifetime)
	if _, err := pool.Exec(ctx, `UPDATE users SET is_admin=true WHERE id=$1`, otherAdmin.ID); err != nil {
		t.Fatal(err)
	}
	first := catalog.Repositories[0]
	if _, err := pool.Exec(ctx, `INSERT INTO agent_workspaces(user_id,name,github_source,github_import_request_id) VALUES($1,'Duplicate',$2,$3::uuid)`, otherAdmin.ID, &agentGitHubSource{RepositoryURL: first.RepositoryURL, CommitSHA: first.CommitSHA}, first.RequestID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO agent_workspace_storage_quotas(user_id,bonus_bytes) VALUES($1,199998649)`, otherAdmin.ID); err != nil {
		t.Fatal(err)
	}
	var ids []int64
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM agent_repository_system_events WHERE workspace_id=ANY($1::bigint[])`, ids)
		_, _ = pool.Exec(context.Background(), `DELETE FROM agent_workspaces WHERE id=ANY($1::bigint[])`, ids)
	})
	var budget int64
	for _, item := range catalog.Repositories {
		budget += item.SizeBytes
		source := &agentGitHubSource{RepositoryURL: item.RepositoryURL, CommitSHA: item.CommitSHA}
		var id int64
		if err := pool.QueryRow(ctx, `INSERT INTO agent_workspaces(user_id,name,github_source,github_import_request_id) VALUES($1,'Catalog',$2,$3::uuid) RETURNING id`, admin.ID, source, item.RequestID).Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	// A member's identical import ID and an admin's ordinary import stay personal.
	item := catalog.Repositories[0]
	if _, err := pool.Exec(ctx, `INSERT INTO agent_workspaces(user_id,name,github_source,github_import_request_id) VALUES($1,'Personal',$2,$3::uuid),($4,'Other','{}',NULL)`, member.ID, &agentGitHubSource{RepositoryURL: item.RepositoryURL, CommitSHA: item.CommitSHA}, item.RequestID, admin.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO agent_workspace_storage_quotas(user_id,bonus_bytes,allocated_bytes) VALUES($1,$2,4194304)`, admin.ID, budget); err != nil {
		t.Fatal(err)
	}
	// Adopt a real published R2 snapshot that already has a personal fork.
	enableRepositoryR2Fixture(t, app)
	if _, err := pool.Exec(ctx, `INSERT INTO agent_workspace_settings(user_id,enabled) VALUES($1,true)`, admin.ID); err != nil {
		t.Fatal(err)
	}
	before, err := app.patchAgentWorkspace(ctx, admin.ID, ids[0], 0, []agentWorkspaceFile{repositoryTestFile("SKILL.md", "# Preserved system skill")}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := app.setAgentRepositoryPublication(ctx, admin.ID, ids[0], before.Revision, "MIT", false); err != nil {
		t.Fatal(err)
	}
	beforePublic, err := app.loadPublicAgentRepository(ctx, ids[0], nil)
	if err != nil {
		t.Fatal(err)
	}
	forkRequest, _ := randomUUID()
	fork, err := app.forkAgentRepository(ctx, member.ID, ids[0], before.Revision, forkRequest)
	if err != nil {
		t.Fatal(err)
	}
	var beforeKey string
	if err := pool.QueryRow(ctx, `SELECT r2_object_key FROM agent_workspace_blobs WHERE workspace_id=$1 AND sha256=$2`, ids[0], before.Files[0].SHA256).Scan(&beforeKey); err != nil {
		t.Fatal(err)
	}
	starPath := fmt.Sprintf("/api/agent/repositories/%d/star", ids[0])
	callRepositoryAPI(t, app, mcpSessionCookie(app, member.AuthUserID), http.MethodPut, starPath, "", 200)
	migration, err := os.ReadFile("../../migrations/0088_adopt_curated_agent_repositories.sql")
	if err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if _, err := pool.Exec(ctx, string(migration)); err != nil {
			t.Fatal(err)
		}
	}
	var count, personal, events int
	var bonus, allocated int64
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM agent_workspaces WHERE id=ANY($1::bigint[]) AND user_id IS NULL AND is_system`, ids).Scan(&count); err != nil || count != 100 {
		t.Fatalf("adopted %d: %v", count, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM agent_workspaces WHERE user_id=ANY($1::int[])`, []int{admin.ID, member.ID}).Scan(&personal); err != nil || personal != 3 {
		t.Fatalf("personal imports affected: %d %v", personal, err)
	}
	if err := pool.QueryRow(ctx, `SELECT bonus_bytes,allocated_bytes FROM agent_workspace_storage_quotas WHERE user_id=$1`, admin.ID).Scan(&bonus, &allocated); err != nil || bonus != 0 || allocated != 4194304 {
		t.Fatalf("personal allocation/grant: %d %d %v", bonus, allocated, err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM agent_repository_system_events WHERE workspace_id=ANY($1::bigint[])`, ids).Scan(&events); err != nil || events != 100 {
		t.Fatalf("migration not idempotent: %d %v", events, err)
	}
	var untouched int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM agent_workspaces w JOIN agent_workspace_storage_quotas q ON q.user_id=w.user_id WHERE w.user_id=$1 AND NOT w.is_system AND q.bonus_bytes=199998649`, otherAdmin.ID).Scan(&untouched); err != nil || untouched != 1 {
		t.Fatalf("unverified bonus or duplicate changed: %d %v", untouched, err)
	}
	publication, err := app.loadPublicAgentRepository(ctx, ids[0], nil)
	if err != nil || !publication.SystemManaged || publication.UpdatedAt != beforePublic.UpdatedAt || publication.Revision != before.Revision || publication.StarCount != 1 || len(publication.Files) != 1 || publication.Files[0] != before.Files[0] {
		t.Fatalf("public snapshot changed: %+v %v", publication, err)
	}
	var afterKey string
	if err := pool.QueryRow(ctx, `SELECT r2_object_key FROM agent_workspace_blobs WHERE workspace_id=$1 AND sha256=$2`, ids[0], before.Files[0].SHA256).Scan(&afterKey); err != nil || afterKey != beforeKey {
		t.Fatalf("R2 reference changed: %q %v", afterKey, err)
	}
	callRepositoryAPI(t, app, nil, http.MethodGet, fmt.Sprintf("/api/agent/repositories/%d/files/%d?revision=%d", ids[0], before.Files[0].FileID, before.Revision), "", 200)
	var sourceID int64
	if err := pool.QueryRow(ctx, `SELECT source_workspace_id FROM agent_repository_forks WHERE workspace_id=$1`, fork.WorkspaceID).Scan(&sourceID); err != nil || sourceID != ids[0] {
		t.Fatalf("fork source changed: %d %v", sourceID, err)
	}
}

func TestCuratedMigrationPartialAndExistingSystem(t *testing.T) {
	for _, existing := range []bool{false, true} {
		for _, changedBonus := range []bool{false, true} {
			t.Run(fmt.Sprintf("existing=%t/changedBonus=%t", existing, changedBonus), func(t *testing.T) {
				pool := newGCTestPool(t)
				app := New(config.Config{SessionSecret: "partial-migration"}, pool)
				ctx := context.Background()
				admin := seedMCPUser(t, pool, app, membershipTierLifetime)
				if _, err := pool.Exec(ctx, `UPDATE users SET is_admin=true,email='cfjwlchangji@gmail.com' WHERE id=$1`, admin.ID); err != nil {
					t.Fatal(err)
				}
				bonus := int64(199998649)
				if changedBonus {
					bonus++
				}
				if _, err := pool.Exec(ctx, `INSERT INTO agent_workspace_storage_quotas(user_id,bonus_bytes,allocated_bytes) VALUES($1,$2,4194304)`, admin.ID, bonus); err != nil {
					t.Fatal(err)
				}
				const request = "11a411b7-2c99-4aae-8b2e-b84ef60b133e"
				source := &agentGitHubSource{RepositoryURL: "https://github.com/Leonxlnx/taste-skill", CommitSHA: "18dfc928b135629e0eddfdd445a06400d04ed439"}
				var personalID, systemID int64
				if err := pool.QueryRow(ctx, `INSERT INTO agent_workspaces(user_id,name,github_source,github_import_request_id) VALUES($1,'Partial',$2,$3::uuid) RETURNING id`, admin.ID, source, request).Scan(&personalID); err != nil {
					t.Fatal(err)
				}
				if existing {
					if err := pool.QueryRow(ctx, `INSERT INTO agent_workspaces(is_system,name,github_import_request_id) VALUES(true,'Existing system',$1::uuid) RETURNING id`, request).Scan(&systemID); err != nil {
						t.Fatal(err)
					}
				}
				t.Cleanup(func() {
					_, _ = pool.Exec(context.Background(), `DELETE FROM agent_repository_system_events WHERE workspace_id=ANY($1::bigint[])`, []int64{personalID, systemID})
					_, _ = pool.Exec(context.Background(), `DELETE FROM agent_workspaces WHERE id=ANY($1::bigint[])`, []int64{personalID, systemID})
				})
				migration, err := os.ReadFile("../../migrations/0088_adopt_curated_agent_repositories.sql")
				if err != nil {
					t.Fatal(err)
				}
				for range 2 {
					if _, err := pool.Exec(ctx, string(migration)); err != nil {
						t.Fatal(err)
					}
				}
				var system bool
				if err := pool.QueryRow(ctx, `SELECT is_system FROM agent_workspaces WHERE id=$1`, personalID).Scan(&system); err != nil || system == existing {
					t.Fatalf("existing system ownership changed: %t %v", system, err)
				}
				var after, allocated int64
				if err := pool.QueryRow(ctx, `SELECT bonus_bytes,allocated_bytes FROM agent_workspace_storage_quotas WHERE user_id=$1`, admin.ID).Scan(&after, &allocated); err != nil {
					t.Fatal(err)
				}
				want := int64(0)
				if changedBonus {
					want = bonus
				}
				if after != want || allocated != 4194304 {
					t.Fatalf("partial grant cleanup: bonus=%d allocated=%d", after, allocated)
				}
			})
		}
	}
}
