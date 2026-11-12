package server

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"testing"
)

func repositoryKoiInstallability(t *testing.T, app *App, id int64) *bool {
	t.Helper()
	var result *bool
	if err := app.db.QueryRow(context.Background(), `SELECT koi_installable FROM agent_repository_publications WHERE workspace_id=$1`, id).Scan(&result); err != nil {
		t.Fatal(err)
	}
	return result
}

func TestAgentRepositoryKoiInstallabilityUsesPublication(t *testing.T) {
	ctx := context.Background()
	app, owner, workspace, objects := koiHubSourceTestApp(t, true, map[string]string{
		"writing/SKILL.md": "# Polish an article",
		"local/SKILL.md":   "---\nname: local\ndescription: Local workflow\nallowed-tools: Bash\n---\nRun locally.",
	})
	var before string
	if err := app.db.QueryRow(ctx, `SELECT (to_jsonb(p)-'koi_installable'-'koi_installability_checked_at'-'koi_installability_xid')::text FROM agent_repository_publications p WHERE workspace_id=$1`, workspace.WorkspaceID).Scan(&before); err != nil {
		t.Fatal(err)
	}
	if count, err := app.backfillAgentRepositoryKoiInstallability(ctx, 8); err != nil || count != 1 {
		t.Fatalf("backfill: %d %v", count, err)
	}
	if value := repositoryKoiInstallability(t, app, workspace.WorkspaceID); value == nil || !*value {
		t.Fatal("a mixed collection with one compatible Skill must be ranked as installable")
	}
	var after string
	if err := app.db.QueryRow(ctx, `SELECT (to_jsonb(p)-'koi_installable'-'koi_installability_checked_at'-'koi_installability_xid')::text FROM agent_repository_publications p WHERE workspace_id=$1`, workspace.WorkspaceID).Scan(&after); err != nil || before != after {
		t.Fatalf("checking compatibility changed the published version: %v", err)
	}
	reads := objects.reads
	if count, err := app.backfillAgentRepositoryKoiInstallability(ctx, 8); err != nil || count != 0 || objects.reads != reads {
		t.Fatalf("cached publication was downloaded again: %d %v", count, err)
	}
	updated, err := app.patchAgentWorkspace(ctx, owner, workspace.WorkspaceID, workspace.Revision, nil, []string{"writing/SKILL.md"})
	if err != nil {
		t.Fatal(err)
	}
	if value := repositoryKoiInstallability(t, app, workspace.WorkspaceID); value == nil || !*value {
		t.Fatal("private edits changed public installation priority")
	}
	if err = app.setAgentRepositoryPublication(ctx, owner, workspace.WorkspaceID, updated.Revision, "MIT", false); err != nil {
		t.Fatal(err)
	}
	if value := repositoryKoiInstallability(t, app, workspace.WorkspaceID); value != nil {
		t.Fatal("republication retained stale installation priority")
	}
	if _, err = app.backfillAgentRepositoryKoiInstallability(ctx, 8); err != nil {
		t.Fatal(err)
	}
	if value := repositoryKoiInstallability(t, app, workspace.WorkspaceID); value == nil || *value {
		t.Fatal("SKILL.md with only local-shell support must not be ranked as Koi-installable")
	}
}

func TestAgentRepositoryKoiInstallabilityReadRecovery(t *testing.T) {
	ctx := context.Background()
	app, owner, workspace, objects := koiHubSourceTestApp(t, true, map[string]string{"SKILL.md": "# Rewrite"})
	objects.corruptRead = true
	if count, err := app.backfillAgentRepositoryKoiInstallability(ctx, 8); err == nil || count != 1 {
		t.Fatalf("corrupt storage read: %d %v", count, err)
	}
	if value := repositoryKoiInstallability(t, app, workspace.WorkspaceID); value != nil {
		t.Fatal("temporary storage failure was cached as incompatibility")
	}
	if count, err := app.backfillAgentRepositoryKoiInstallability(ctx, 8); err != nil || count != 0 {
		t.Fatalf("failure retry must be delayed: %d %v", count, err)
	}
	objects.corruptRead = false
	later, err := app.createAgentWorkspace(ctx, owner, "Later publication", "", "en")
	if err != nil {
		t.Fatal(err)
	}
	later, err = app.patchAgentWorkspace(ctx, owner, later.WorkspaceID, later.Revision, []agentWorkspaceFile{repositoryTestFile("SKILL.md", "# Polish writing")}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = app.setAgentRepositoryPublication(ctx, owner, later.WorkspaceID, later.Revision, "MIT", false); err != nil {
		t.Fatal(err)
	}
	if count, err := app.backfillAgentRepositoryKoiInstallability(ctx, 8); err != nil || count != 1 {
		t.Fatalf("one failed publication blocked a later publication: %d %v", count, err)
	}
	if value := repositoryKoiInstallability(t, app, later.WorkspaceID); value == nil || !*value {
		t.Fatal("later publication was not checked")
	}
	if _, err := app.db.Exec(ctx, `UPDATE agent_repository_publications SET koi_installability_checked_at=now()-interval '6 minutes' WHERE workspace_id=$1`, workspace.WorkspaceID); err != nil {
		t.Fatal(err)
	}
	if count, err := app.backfillAgentRepositoryKoiInstallability(ctx, 8); err != nil || count != 1 {
		t.Fatalf("storage recovery: %d %v", count, err)
	}
	if value := repositoryKoiInstallability(t, app, workspace.WorkspaceID); value == nil || !*value {
		t.Fatal("compatible publication could not recover after storage failure")
	}
}

func TestAgentRepositoryKoiInstallabilitySyncRemovesPriority(t *testing.T) {
	app, workspace, _, _, _ := seedSystemRepositorySync(t, true)
	if _, err := app.db.Exec(context.Background(), `UPDATE agent_repository_publications SET koi_installable=true WHERE workspace_id=$1`, workspace.WorkspaceID); err != nil {
		t.Fatal(err)
	}
	summary, _, err := runSystemRepositorySync(t, app, workspace.WorkspaceID, true)
	if err != nil || summary.Updated != 1 {
		t.Fatalf("sync: %+v %v", summary, err)
	}
	if value := repositoryKoiInstallability(t, app, workspace.WorkspaceID); value == nil || *value {
		t.Fatal("an upstream version without installable Skills kept its old priority")
	}
}

func TestAgentRepositoryKoiInstallabilityIgnoresRepublication(t *testing.T) {
	ctx := context.Background()
	app, owner, workspace, _ := koiHubSourceTestApp(t, true, map[string]string{"SKILL.md": "# Rewrite"})
	store := app.agentObjectStore.(*workerAgentRepositoryObjects)
	client := *store.client
	base := client.Transport
	if base == nil {
		base = http.DefaultTransport
	}
	republished := false
	var republish sync.Once
	client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		response, err := base.RoundTrip(r)
		if r.Method == http.MethodGet {
			republish.Do(func() {
				republished = true
				if publishErr := app.setAgentRepositoryPublication(ctx, owner, workspace.WorkspaceID, workspace.Revision, "Apache-2.0", false); publishErr != nil {
					t.Error(publishErr)
				}
			})
		}
		return response, err
	})
	store.client = &client
	if _, err := app.backfillAgentRepositoryKoiInstallability(ctx, 8); err != nil && !errors.Is(err, errAgentWorkspaceConflict) {
		t.Fatal(err)
	}
	if !republished || repositoryKoiInstallability(t, app, workspace.WorkspaceID) != nil {
		t.Fatal("old compatibility check overwrote a new publication at the same revision")
	}
}
