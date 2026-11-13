package server

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestKoiBackgroundChecksLeaveGitHubQuotaForInstallations(t *testing.T) {
	ctx := context.Background()
	app, owner, first, _ := koiLinkIndexFixture(t)
	var ids []int64
	t.Cleanup(func() { _, _ = app.db.Exec(ctx, `DELETE FROM agent_workspaces WHERE id=ANY($1)`, ids) })
	source := &agentGitHubSource{RepositoryID: 123, RepositoryURL: "https://github.com/Octo/demo", Ref: "main", LinkOnly: true}
	for range 30 {
		var id int64
		if err := app.db.QueryRow(ctx, `INSERT INTO agent_workspaces(user_id,name,description) VALUES($1,'Quota source link','') RETURNING id`, owner).Scan(&id); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
		if _, err := app.db.Exec(ctx, `INSERT INTO agent_repository_publications(workspace_id,revision,name,description,license,github_source) VALUES($1,0,'Quota source link','','MIT',$2)`, id, source); err != nil {
			t.Fatal(err)
		}
	}
	const token = "maintenance-test-token"
	archive := githubArchive(t, githubArchiveEntry{"root/SKILL.md", "# Improve writing", 0})
	public, maintenance := githubImportClient(t, archive, "", false).Transport, githubImportClient(t, archive, token, false).Transport
	anonymousAPI, authenticatedAPI, downloads := 0, 0, 0
	app.githubHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host == githubCodeLoadHost {
			downloads++
			return public.RoundTrip(r)
		}
		if r.Header.Get("Authorization") != "" {
			authenticatedAPI++
			return maintenance.RoundTrip(r)
		}
		anonymousAPI++
		if anonymousAPI > 60 {
			return &http.Response{StatusCode: 429, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
		}
		return public.RoundTrip(r)
	})}
	if count, err := app.backfillAgentRepositoryKoiInstallability(ctx, 64); count != 0 || err != nil || anonymousAPI+authenticatedAPI+downloads != 0 {
		t.Fatalf("application backfill contacted GitHub: count=%d err=%v", count, err)
	}
	if count, err := app.RefreshAgentRepositoryKoiInstallability(ctx, ""); count != 0 || err == nil || anonymousAPI+authenticatedAPI+downloads != 0 {
		t.Fatal("maintenance without a token consumed GitHub quota")
	}
	if count, err := app.RefreshAgentRepositoryKoiInstallability(ctx, token); count != 31 || err != nil || anonymousAPI != 0 || authenticatedAPI != 62 || downloads != 31 {
		t.Fatalf("maintenance quota: count=%d err=%v anonymous=%d authenticated=%d downloads=%d", count, err, anonymousAPI, authenticatedAPI, downloads)
	}
	if value := repositoryKoiInstallability(t, app, first); value == nil || !*value {
		t.Fatal("maintenance did not index links")
	}
	analysis, err := app.koiAnalyzeSource(ctx, owner, map[string]any{"kind": "github", "repositoryUrl": source.RepositoryURL})
	if err != nil || len(analysis.candidates) != 1 || anonymousAPI != 2 {
		t.Fatalf("user preview lost anonymous quota: candidates=%d err=%v requests=%d", len(analysis.candidates), err, anonymousAPI)
	}
}

func TestKoiLinkRecheckPreservesResultAndRetriesTemporaryFailures(t *testing.T) {
	const token = "maintenance-test-token"
	for _, status := range []int{503, 429, 401} {
		for _, prior := range []string{"unknown", "compatible", "incompatible", "old-compatible", "old-incompatible"} {
			t.Run(fmt.Sprintf("%d/%s", status, prior), func(t *testing.T) {
				ctx := context.Background()
				app, _, id, _ := koiLinkIndexFixture(t)
				var previous *bool
				if prior != "unknown" {
					value := strings.TrimPrefix(prior, "old-") == "compatible"
					previous = &value
				}
				evidence := koiInstallabilityEvidence{RulesVersion: koiSkillEntryRulesVersion}
				if strings.HasPrefix(prior, "old-") {
					evidence.RulesVersion--
				}
				if _, err := app.db.Exec(ctx, `UPDATE agent_repository_publications SET koi_installable=$2,koi_installability_curation_revision=(SELECT revision FROM agent_repository_curation_state WHERE singleton),koi_installability_checked_at=now()-interval '25 hours',koi_installability_evidence=$3 WHERE workspace_id=$1`, id, previous, evidence); err != nil {
					t.Fatal(err)
				}
				snapshot := func() string {
					t.Helper()
					var result string
					if err := app.db.QueryRow(ctx, `SELECT (to_jsonb(p)-'koi_installability_attempted_at')::text FROM agent_repository_publications p WHERE workspace_id=$1`, id).Scan(&result); err != nil {
						t.Fatal(err)
					}
					return result
				}
				before, requests := snapshot(), 0
				app.githubHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
					requests++
					if r.Header.Get("Authorization") != "Bearer "+token {
						t.Error("maintenance retried anonymously")
					}
					return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
				})}
				count, err := app.RefreshAgentRepositoryKoiInstallability(ctx, token)
				if count != 1 || err == nil || requests != 1 || errors.Is(err, ErrKoiInstallabilityDeferred) != (status != 401) {
					t.Fatalf("failed check: count=%d err=%v requests=%d", count, err, requests)
				}
				if snapshot() != before {
					t.Fatal("temporary failure changed the definitive compatibility result/publication")
				}
				var directory struct{ Total, KoiPending int }
				decodeJSONResponse(t, callRepositoryAPI(t, app, nil, "GET", "/api/agent/repositories?koiInstallable=true&q=Review%20skills", "", 200), &directory)
				want := 0
				if prior == "compatible" {
					want = 1
				}
				if directory.Total != want {
					t.Fatalf("temporary failure changed filtered results: got %d want %d", directory.Total, want)
				}
				if (directory.KoiPending == 1) != (prior == "unknown" || strings.HasPrefix(prior, "old-")) {
					t.Fatalf("pending status disagrees with the retained result: %+v", directory)
				}
				if count, err := app.RefreshAgentRepositoryKoiInstallability(ctx, token); count != 0 || err != nil || requests != 1 {
					t.Fatal("retry did not back off")
				}
				if _, err := app.db.Exec(ctx, `UPDATE agent_repository_publications SET koi_installability_attempted_at=now()-interval '6 minutes' WHERE workspace_id=$1`, id); err != nil {
					t.Fatal(err)
				}
				entry := "# Improve writing"
				if prior == "compatible" {
					entry = "---\nname: local\ndescription: Local tool\nallowed-tools: Bash\n---\nRun locally."
				}
				app.githubHTTPClient = githubImportClient(t, githubArchive(t, githubArchiveEntry{"root/SKILL.md", entry, 0}), token, false)
				if count, err := app.RefreshAgentRepositoryKoiInstallability(ctx, token); count != 1 || err != nil {
					t.Fatalf("recovery did not retry after five minutes: %d %v", count, err)
				}
				if value := repositoryKoiInstallability(t, app, id); value == nil || *value != (prior != "compatible") {
					t.Fatal("successful recovery did not replace the stale result")
				}
			})
		}
	}
}

func TestKoiDeferredChecksDoNotMaskFatalFailures(t *testing.T) {
	for _, deferred := range []int{1, 8} {
		for _, failure := range []string{"database", "credentials"} {
			t.Run(fmt.Sprintf("%s/after_%d", failure, deferred), func(t *testing.T) {
				ctx := context.Background()
				app, owner, first, _ := koiLinkIndexFixture(t)
				ids := []int64{first}
				t.Cleanup(func() { _, _ = app.db.Exec(ctx, `DELETE FROM agent_workspaces WHERE id=ANY($1)`, ids[1:]) })
				for range deferred {
					var id int64
					if err := app.db.QueryRow(ctx, `INSERT INTO agent_workspaces(user_id,name,description) VALUES($1,'Later compatibility check','') RETURNING id`, owner).Scan(&id); err != nil {
						t.Fatal(err)
					}
					ids = append(ids, id)
					if _, err := app.db.Exec(ctx, `INSERT INTO agent_repository_publications(workspace_id,revision,name,description,license,github_source)
 SELECT $1,0,'Later compatibility check','','MIT',github_source FROM agent_repository_publications WHERE workspace_id=$2`, id, first); err != nil {
						t.Fatal(err)
					}
				}
				if failure == "database" {
					t.Cleanup(func() {
						if _, err := app.db.Exec(ctx, `DROP TRIGGER IF EXISTS fail_koi_maintenance_claim ON agent_repository_publications;
 DROP FUNCTION IF EXISTS fail_koi_maintenance_claim()`); err != nil {
							t.Error(err)
						}
					})
					_, err := app.db.Exec(ctx, fmt.Sprintf(`CREATE FUNCTION fail_koi_maintenance_claim() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'forced maintenance database failure'; END $$;
 CREATE TRIGGER fail_koi_maintenance_claim BEFORE UPDATE OF koi_installability_attempted_at ON agent_repository_publications
 FOR EACH ROW WHEN (NEW.workspace_id=%d) EXECUTE FUNCTION fail_koi_maintenance_claim()`, ids[len(ids)-1]))
					if err != nil {
						t.Fatal(err)
					}
				}
				calls := 0
				app.githubHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
					calls++
					status := 503
					if calls > deferred {
						status = 401
					}
					return &http.Response{StatusCode: status, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
				})}
				count, err := app.RefreshAgentRepositoryKoiInstallability(ctx, "maintenance-test-token")
				if err == nil || errors.Is(err, ErrKoiInstallabilityDeferred) {
					t.Fatalf("fatal %s failure was hidden by prior deferrals: count=%d err=%v", failure, count, err)
				}
				if failure == "credentials" && !agentGitHubTokenRejected(err) || failure == "database" && !strings.Contains(err.Error(), "forced maintenance database failure") {
					t.Fatalf("wrong fatal error: %v", err)
				}
			})
		}
	}
}

func TestKoiSourceReadFailuresAreDeferredWithoutCertifyingLinks(t *testing.T) {
	for _, failure := range []string{"timeout", "download", "cancelled"} {
		t.Run(failure, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			app, _, id, _ := koiLinkIndexFixture(t)
			const token = "maintenance-test-token"
			base := githubImportClient(t, githubArchive(t, githubArchiveEntry{"root/SKILL.md", "# Write clearly", 0}), token, false).Transport
			app.githubHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
				if failure == "timeout" {
					return nil, context.DeadlineExceeded
				}
				if failure == "cancelled" {
					cancel()
					return nil, context.Canceled
				}
				if r.URL.Host == githubCodeLoadHost {
					return &http.Response{StatusCode: 404, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("")), Request: r}, nil
				}
				return base.RoundTrip(r)
			})}
			count, err := app.RefreshAgentRepositoryKoiInstallability(ctx, token)
			if count != 1 || err == nil || errors.Is(err, ErrKoiInstallabilityDeferred) != (failure != "cancelled") {
				t.Fatalf("wrong source error disposition: count=%d err=%v", count, err)
			}
			if failure == "cancelled" && !errors.Is(err, context.Canceled) {
				t.Fatalf("cancellation was hidden: %v", err)
			}
			if value := repositoryKoiInstallability(t, app, id); value != nil {
				t.Fatal("failed source read certified an unknown link")
			}
		})
	}
}

func TestKoiMaintenanceCredentialsDoNotFallBackAnonymously(t *testing.T) {
	for _, status := range []int{401, 403} {
		calls := 0
		app := &App{githubHTTPClient: &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			calls++
			if r.Header.Get("Authorization") == "" {
				t.Error("maintenance used anonymous API fallback")
			}
			return &http.Response{StatusCode: status, Header: make(http.Header), Request: r, Body: io.NopCloser(strings.NewReader(""))}, nil
		})}}
		_, err := app.readKoiGitHubSource(context.Background(), koiGitHubSourceInput{RepositoryURL: "https://github.com/Octo/demo", PublicOnly: true}, "rejected-maintenance-token")
		if !agentGitHubTokenRejected(err) || errors.Is(err, errAgentGitHubRateLimited) || calls != 1 {
			t.Fatalf("rejected token retried: calls=%d err=%v", calls, err)
		}
	}
}
