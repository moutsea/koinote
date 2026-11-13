package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"sync"
	"testing"
)

func TestAgentRepositoryDirectoryFreezesInFlightKoiChecks(t *testing.T) {
	for _, phase := range []string{"reading", "committing"} {
		t.Run(phase, func(t *testing.T) {
			ctx := context.Background()
			app, owner, target, _ := koiHubSourceTestApp(t, true, map[string]string{"SKILL.md": "# Rewrite articles"})
			// The promoted entry ends page two, so its live badge must not become
			// the frozen cursor's priority and repeat the ordinary group on page three.
			ids := make([]int64, 2*publicRepositoryPageSize+3)
			ids[3] = target.WorkspaceID
			if _, err := app.db.Exec(ctx, `UPDATE agent_repository_publications SET published_at='2026-10-01T00:03:00Z' WHERE workspace_id=$1`, target.WorkspaceID); err != nil {
				t.Fatal(err)
			}
			for i := range ids {
				if i == 3 {
					continue
				}
				if err := app.db.QueryRow(ctx, `INSERT INTO agent_workspaces(user_id,name,description) VALUES($1,'Review skills','') RETURNING id`, owner).Scan(&ids[i]); err != nil {
					t.Fatal(err)
				}
				if _, err := app.db.Exec(ctx, `INSERT INTO agent_repository_publications(workspace_id,revision,name,description,license,published_at,koi_installable,koi_installability_curation_revision)
 VALUES($1,0,'Review skills','','MIT',timestamptz '2026-10-01T00:00:00Z'+make_interval(mins=>$2),false,(SELECT revision FROM agent_repository_curation_state WHERE singleton))`, ids[i], i); err != nil {
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
			path := "/api/agent/repositories?q=Review%20skills&source=community"
			var first page
			if phase == "reading" {
				store := app.agentObjectStore.(*workerAgentRepositoryObjects)
				client := *store.client
				base := client.Transport
				if base == nil {
					base = http.DefaultTransport
				}
				var capture sync.Once
				client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
					if r.Method == http.MethodGet {
						capture.Do(func() { first = get(path) })
					}
					return base.RoundTrip(r)
				})
				store.client = &client
				if count, err := app.backfillAgentRepositoryKoiInstallability(ctx, 8); err != nil || count != 1 {
					t.Fatalf("backfill: %d %v", count, err)
				}
			} else {
				tx, err := app.db.Begin(ctx)
				if err != nil {
					t.Fatal(err)
				}
				defer tx.Rollback(ctx)
				if _, err = tx.Exec(ctx, `UPDATE agent_repository_publications SET koi_installable=true,koi_installability_curation_revision=(SELECT revision FROM agent_repository_curation_state WHERE singleton),koi_installability_xid=pg_current_xact_id() WHERE workspace_id=$1`, target.WorkspaceID); err != nil {
					t.Fatal(err)
				}
				first = get(path)
				if err = tx.Commit(ctx); err != nil {
					t.Fatal(err)
				}
			}
			if first.NextCursor == nil || first.Total != len(ids) {
				t.Fatalf("first page: %+v", first)
			}
			got := append([]agentRepositoryDirectoryItem{}, first.Repositories...)
			next := first.NextCursor
			for n := 0; next != nil && n < 4; n++ {
				current := get(path + "&cursor=" + url.QueryEscape(*next))
				got = append(got, current.Repositories...)
				next = current.NextCursor
			}
			if next != nil || len(got) != len(ids) {
				t.Fatalf("missing/repeated entries: got %d of %d, next=%v", len(got), len(ids), next)
			}
			for i, item := range got {
				if item.WorkspaceID != ids[len(ids)-1-i] {
					t.Fatalf("rank %d changed after validation: %+v", i, item)
				}
			}
			fresh := get(path)
			if fresh.Repositories[0].WorkspaceID != target.WorkspaceID || !fresh.Repositories[0].KoiInstallable {
				t.Fatal("a fresh visit did not apply completed validation")
			}
			encoded, err := base64.RawURLEncoding.DecodeString(*first.NextCursor)
			if err != nil {
				t.Fatal(err)
			}
			var invalid map[string]any
			if err = json.Unmarshal(encoded, &invalid); err != nil {
				t.Fatal(err)
			}
			for _, snapshot := range []any{"invalid", "", nil} {
				invalid["koiSnapshot"] = snapshot
				value, _ := json.Marshal(invalid)
				callRepositoryAPI(t, app, nil, http.MethodGet, path+"&cursor="+base64.RawURLEncoding.EncodeToString(value), "", 400)
			}
		})
	}
}
