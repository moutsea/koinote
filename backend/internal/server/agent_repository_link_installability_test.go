package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

func koiLinkIndexFixture(t *testing.T) (*App, int, int64, *repositoryObjectFixture) {
	t.Helper()
	app, owner, workspace, objects := koiHubSourceTestApp(t, true, map[string]string{"README.md": "A source link"})
	source := &agentGitHubSource{RepositoryID: 123, RepositoryURL: "https://github.com/Octo/demo", Ref: "main", LinkOnly: true}
	if _, err := app.db.Exec(context.Background(), `UPDATE agent_repository_publications SET github_source=$2 WHERE workspace_id=$1`, workspace.WorkspaceID, source); err != nil {
		t.Fatal(err)
	}
	return app, owner, workspace.WorkspaceID, objects
}

func TestKoiCurationRechecksCachedPublications(t *testing.T) {
	for _, link := range []bool{false, true} {
		t.Run(map[bool]string{false: "mirror", true: "link"}[link], func(t *testing.T) {
			ctx := context.Background()
			content := map[string]string{"SKILL.md": "# Write clearly", "README.md": "Repository import instructions."}
			a, _, workspace, _ := koiHubSourceTestApp(t, true, content)
			source := &agentGitHubSource{RepositoryID: 123, RepositoryURL: "https://github.com/Octo/demo", Ref: "main", LinkOnly: link}
			if _, err := a.db.Exec(ctx, `UPDATE agent_repository_publications SET github_source=$2 WHERE workspace_id=$1`, workspace.WorkspaceID, source); err != nil {
				t.Fatal(err)
			}
			const token = "maintenance-test-token"
			a.githubHTTPClient = githubImportClient(t, githubArchive(t, githubArchiveEntry{"root/SKILL.md", content["SKILL.md"], 0}, githubArchiveEntry{"root/README.md", content["README.md"], 0}), token, false)
			requests := 0
			base := a.githubHTTPClient.Transport
			a.githubHTTPClient.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) { requests++; return base.RoundTrip(r) })
			localChecks := false
			check := func(want bool) {
				t.Helper()
				credential := token
				if localChecks {
					credential = ""
				}
				before := requests
				if count, err := a.checkAgentRepositoryKoiInstallability(ctx, 8, credential); err != nil || count != 1 {
					t.Fatalf("policy recheck: %d %v", count, err)
				}
				if localChecks && requests != before {
					t.Fatal("reapplying a review downloaded GitHub content")
				}
				if value := repositoryKoiInstallability(t, a, workspace.WorkspaceID); value == nil || *value != want {
					t.Fatalf("wrong policy result: %v, want %t", value, want)
				}
			}
			directory := func(want int, pending ...int) {
				t.Helper()
				var page struct {
					Total        int
					KoiPending   int
					Repositories []agentRepositoryDirectoryItem
				}
				decodeJSONResponse(t, callRepositoryAPI(t, a, nil, "GET", "/api/agent/repositories?koiInstallable=true&q=Review%20skills", "", 200), &page)
				if page.Total != want || len(page.Repositories) != want {
					t.Fatalf("directory exposed stale policy results: %+v", page)
				}
				if len(pending) > 0 && page.KoiPending != pending[0] {
					t.Fatalf("wrong pending state: %+v", page)
				}
			}
			check(true)
			localChecks = true
			directory(1)
			candidates, _ := koiSkillCandidates(koiCandidateTestFiles(content))
			if !link {
				snapshot, err := a.readKoiHubSource(ctx, koiHubSourceInput{WorkspaceID: workspace.WorkspaceID})
				if err != nil {
					t.Fatal(err)
				}
				candidates, _ = koiSkillCandidates(snapshot.Files)
			}
			digest := candidates[0].ContentSHA256
			oldReview := koiTestCuration(t, a)
			var started time.Time
			if err := a.db.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&started); err != nil {
				t.Fatal(err)
			}
			koiTestCuration(t, a, koiReviewedRepository{RepositoryID: 123, RepositoryURL: source.RepositoryURL, Packages: map[string]string{}})
			directory(0, 1) // Immediately hide old true results before any download.
			if link {
				a.rememberKoiGitHubInstallability(ctx, source, started, false, oldReview.revision, nil)
				if value := repositoryKoiInstallability(t, a, workspace.WorkspaceID); value == nil || !*value {
					t.Fatal("a preview using old rules wrote a new result")
				}
			}
			check(false) // Mirrors and fresh links must both be checked again.
			if _, err := a.db.Exec(ctx, `UPDATE agent_repository_curation SET packages=$1 WHERE repository_id=123`, map[string]string{digest: "writing"}); err != nil {
				t.Fatal(err)
			}
			check(true)
			directory(1)
			entryDigest := koiSkillEntryDigest(content["SKILL.md"])
			if entryDigest == digest {
				t.Fatal("the repository must include files beyond its entry")
			}
			if _, err := a.db.Exec(ctx, `UPDATE agent_repository_curation SET required_capabilities=$1 WHERE repository_id=123`, map[string][]string{entryDigest: {"filesystem_read", "filesystem_write"}}); err != nil {
				t.Fatal(err)
			}
			directory(0)
			check(false)
			if _, err := a.db.Exec(ctx, `DELETE FROM agent_repository_curation WHERE repository_id=123`); err != nil {
				t.Fatal(err)
			}
			check(true)
			directory(1)
		})
	}
}

func TestKoiLinkUpgradeWarmsThenReappliesRulesLocally(t *testing.T) {
	ctx := context.Background()
	a, _, id, _ := koiLinkIndexFixture(t)
	assertDirectory := func(total, pending int) {
		t.Helper()
		var page struct {
			Total, KoiPending int
			Facets            []agentRepositoryDirectoryFacet
			Repositories      []agentRepositoryDirectoryItem
		}
		decodeJSONResponse(t, callRepositoryAPI(t, a, nil, "GET", "/api/agent/repositories?koiInstallable=true&q=Review%20skills", "", 200), &page)
		if page.Total != total || page.KoiPending != pending || len(page.Repositories) != total {
			t.Fatalf("directory: %+v", page)
		}
		installableCount, pendingCount := 0, 0
		for _, facet := range page.Facets {
			installableCount += facet.KoiInstallableCount
			pendingCount += facet.KoiPendingCount
		}
		if installableCount != total || pendingCount != pending {
			t.Fatalf("facet counts disagree with directory: %+v", page)
		}
		decodeJSONResponse(t, callRepositoryAPI(t, a, nil, "GET", "/api/agent/repositories?q=Review%20skills", "", 200), &page)
		if len(page.Repositories) != 1 || page.Repositories[0].KoiInstallable != (total == 1) {
			t.Fatalf("unfiltered directory retained an obsolete badge: %+v", page)
		}
	}
	const token = "maintenance-test-token"
	a.githubHTTPClient = githubImportClient(t, githubArchive(t, githubArchiveEntry{"root/SKILL.md", "# Write clearly", 0}), token, false)
	// Both old positive and negative results need rechecking, even when checked
	// moments ago at the current curation revision. Missing evidence is stale too.
	for _, cached := range []struct {
		name        string
		installable bool
		evidence    *koiInstallabilityEvidence
	}{
		{"old false", false, &koiInstallabilityEvidence{RulesVersion: koiSkillEntryRulesVersion - 1}},
		{"old true", true, &koiInstallabilityEvidence{RulesVersion: koiSkillEntryRulesVersion - 1}},
		{"missing evidence", true, nil},
	} {
		t.Run(cached.name, func(t *testing.T) {
			if _, err := a.db.Exec(ctx, `UPDATE agent_repository_publications SET koi_installable=$2,koi_installability_evidence=$3,
 koi_installability_curation_revision=(SELECT revision FROM agent_repository_curation_state WHERE singleton),
 koi_installability_checked_at=now(),koi_installability_xid=pg_current_xact_id() WHERE workspace_id=$1`, id, cached.installable, cached.evidence); err != nil {
				t.Fatal(err)
			}
			assertDirectory(0, 1)
			if checked, err := a.backfillAgentRepositoryKoiInstallability(ctx, 8); err != nil || checked != 0 {
				t.Fatalf("old links used anonymous checks: %d %v", checked, err)
			}
			var snapshot string
			if err := a.db.QueryRow(ctx, `SELECT pg_current_snapshot()::text`).Scan(&snapshot); err != nil {
				t.Fatal(err)
			}
			if checked, err := a.RefreshAgentRepositoryKoiInstallability(ctx, token); err != nil || checked != 1 {
				t.Fatalf("deployment warm-up: %d %v", checked, err)
			}
			assertDirectory(1, 0)
			var visible bool
			if err := a.db.QueryRow(ctx, `SELECT pg_visible_in_snapshot(koi_installability_xid,$2::pg_snapshot) FROM agent_repository_publications WHERE workspace_id=$1`, id, snapshot).Scan(&visible); err != nil || visible {
				t.Fatalf("revalidated result entered an older pagination snapshot: visible=%v %v", visible, err)
			}
		})
	}
	var checkedAt time.Time
	if err := a.db.QueryRow(ctx, `SELECT koi_installability_checked_at FROM agent_repository_publications WHERE workspace_id=$1`, id).Scan(&checkedAt); err != nil {
		t.Fatal(err)
	}
	a.githubHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		t.Errorf("policy recheck downloaded %s", r.URL)
		return nil, io.EOF
	})}
	koiTestCuration(t, a, koiReviewedRepository{RepositoryID: 999, RepositoryURL: "https://github.com/unrelated/review", Packages: map[string]string{}})
	if checked, err := a.backfillAgentRepositoryKoiInstallability(ctx, 8); err != nil || checked != 1 {
		t.Fatalf("local recheck: %d %v", checked, err)
	}
	assertDirectory(1, 0)
	var after time.Time
	if err := a.db.QueryRow(ctx, `SELECT koi_installability_checked_at FROM agent_repository_publications WHERE workspace_id=$1`, id).Scan(&after); err != nil || !checkedAt.Equal(after) {
		t.Fatalf("a local policy refresh postponed upstream checks: %v", err)
	}
}

func TestKoiLinkCompatibilityChecksAndRevalidatesUpstream(t *testing.T) {
	ctx := context.Background()
	app, _, id, objects := koiLinkIndexFixture(t)
	// Upgrade the previously cached false state without changing the publication.
	if _, err := app.db.Exec(ctx, `UPDATE agent_repository_publications SET koi_installable=false,koi_installability_curation_revision=(SELECT revision FROM agent_repository_curation_state WHERE singleton),koi_installability_checked_at=now() WHERE workspace_id=$1`, id); err != nil {
		t.Fatal(err)
	}
	migration, err := os.ReadFile("../../migrations/0117_link_repository_installability.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = app.db.Exec(ctx, string(migration)); err != nil {
		t.Fatal(err)
	}
	if repositoryKoiInstallability(t, app, id) != nil {
		t.Fatal("legacy link was not queued for real validation")
	}
	archive := func(entry string) []byte { return githubArchive(t, githubArchiveEntry{"root/SKILL.md", entry, 0}) }
	const token = "maintenance-test-token"
	app.githubHTTPClient = githubImportClient(t, archive("# Improve writing"), token, false)
	puts, reads := objects.puts, objects.reads
	if count, err := app.RefreshAgentRepositoryKoiInstallability(ctx, token); err != nil || count != 1 {
		t.Fatalf("maintenance check: %d %v", count, err)
	}
	if value := repositoryKoiInstallability(t, app, id); value == nil || !*value {
		t.Fatal("compatible public link was excluded")
	}
	// A recent false result from the old whole-archive scanner must be retried
	// with the new package boundaries, without waiting for the daily interval.
	legacy := koiInstallabilityEvidence{RulesVersion: koiSkillEntryRulesVersion - 1, Digests: []string{}}
	if _, err := app.db.Exec(ctx, `UPDATE agent_repository_publications SET koi_installable=false,koi_installability_evidence=$2 WHERE workspace_id=$1`, id, legacy); err != nil {
		t.Fatal(err)
	}
	if count, err := app.checkAgentRepositoryKoiInstallability(ctx, 8, token); err != nil || count != 1 {
		t.Fatalf("old scanner result was not revalidated: %d %v", count, err)
	}
	if value := repositoryKoiInstallability(t, app, id); value == nil || !*value {
		t.Fatal("old negative compatibility result was retained")
	}
	var xid string
	if err := app.db.QueryRow(ctx, `SELECT koi_installability_xid::text FROM agent_repository_publications WHERE workspace_id=$1`, id).Scan(&xid); err != nil {
		t.Fatal(err)
	}
	for _, compatible := range []bool{true, false} {
		entry := "# Improve writing"
		if !compatible {
			entry = "---\nname: local\ndescription: Local tools\nallowed-tools: Bash\n---\nRun locally."
		}
		app.githubHTTPClient = githubImportClient(t, archive(entry), token, false)
		if _, err := app.db.Exec(ctx, `UPDATE agent_repository_publications SET koi_installability_checked_at=now()-interval '25 hours',koi_installability_attempted_at=NULL WHERE workspace_id=$1`, id); err != nil {
			t.Fatal(err)
		}
		if count, err := app.checkAgentRepositoryKoiInstallability(ctx, 8, token); err != nil || count != 1 {
			t.Fatalf("revalidation: %d %v", count, err)
		}
		if value := repositoryKoiInstallability(t, app, id); value == nil || *value != compatible {
			t.Fatal("upstream compatibility change was not reflected")
		}
		if compatible {
			var after string
			if err := app.db.QueryRow(ctx, `SELECT koi_installability_xid::text FROM agent_repository_publications WHERE workspace_id=$1`, id).Scan(&after); err != nil || after != xid {
				t.Fatalf("unchanged compatibility disturbed active pagination: %v", err)
			}
		}
	}
	if objects.puts != puts || objects.reads != reads {
		t.Fatal("checking a link used the mirror content store")
	}
}

func TestKoiLinkMigrationPreservesVerifiedInstallability(t *testing.T) {
	ctx := context.Background()
	app, _, id, _ := koiLinkIndexFixture(t)
	if _, err := app.db.Exec(ctx, `UPDATE agent_repository_publications SET koi_installable=true,koi_installability_curation_revision=(SELECT revision FROM agent_repository_curation_state WHERE singleton),koi_installability_checked_at=now(),koi_installability_xid=pg_current_xact_id(),koi_installability_evidence=$2 WHERE workspace_id=$1`, id, koiInstallabilityEvidence{RulesVersion: koiSkillEntryRulesVersion}); err != nil {
		t.Fatal(err)
	}
	var before string
	if err := app.db.QueryRow(ctx, `SELECT koi_installability_checked_at::text||':'||koi_installability_xid::text FROM agent_repository_publications WHERE workspace_id=$1`, id).Scan(&before); err != nil {
		t.Fatal(err)
	}
	migration, err := os.ReadFile("../../migrations/0117_link_repository_installability.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = app.db.Exec(ctx, string(migration)); err != nil {
		t.Fatal(err)
	}
	if value := repositoryKoiInstallability(t, app, id); value == nil || !*value {
		t.Fatal("migration cleared a verified compatible link")
	}
	var after string
	if err := app.db.QueryRow(ctx, `SELECT koi_installability_checked_at::text||':'||koi_installability_xid::text FROM agent_repository_publications WHERE workspace_id=$1`, id).Scan(&after); err != nil || before != after {
		t.Fatalf("migration disturbed verification or pagination: %s -> %s %v", before, after, err)
	}
	if checked, err := app.backfillAgentRepositoryKoiInstallability(ctx, 8); err != nil || checked != 0 {
		t.Fatalf("startup tried unauthenticated link checks: %d %v", checked, err)
	}
	w := callRepositoryAPI(t, app, nil, "GET", "/api/agent/repositories?q=Review%20skills&koiInstallable=true", "", 200)
	var directory struct{ Total int }
	if err := json.Unmarshal(w.Body.Bytes(), &directory); err != nil || directory.Total != 1 {
		t.Fatalf("verified link disappeared from installable directory: %s %v", w.Body.String(), err)
	}
}

func TestKoiLinkIndexHonorsReviewedSubset(t *testing.T) {
	ctx := context.Background()
	app, _, id, _ := koiLinkIndexFixture(t)
	koiTestCuration(t, app, koiReviewedRepository{RepositoryID: 1250162731, RepositoryURL: "https://github.com/Octo/demo", Packages: map[string]string{}})
	if _, err := app.db.Exec(ctx, `UPDATE agent_repository_publications SET github_source=jsonb_set(github_source,'{repositoryId}','1250162731') WHERE workspace_id=$1`, id); err != nil {
		t.Fatal(err)
	}
	archive := githubArchive(t, githubArchiveEntry{"root/SKILL.md", "# Requires undeclared local publishing tools", 0})
	client := koiReviewGitHubClient(t, archive, 1250162731)
	base := client.Transport
	client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		clone := r.Clone(r.Context())
		clone.Header.Del("Authorization")
		return base.RoundTrip(clone)
	})
	app.githubHTTPClient = client
	if count, err := app.RefreshAgentRepositoryKoiInstallability(ctx, "maintenance-test-token"); err != nil || count != 1 {
		t.Fatalf("reviewed link check: %d %v", count, err)
	}
	if value := repositoryKoiInstallability(t, app, id); value == nil || *value {
		t.Fatal("directory advertised an unreviewed package as installable")
	}
}

func TestKoiLinkCompatibilityFailureAndPublicationGuards(t *testing.T) {
	const token = "maintenance-test-token"
	for _, scenario := range []string{"transient", "rate_limit", "private", "replaced", "unsafe_archive", "changed_publication", "changed_source", "newer_preview", "changed_review"} {
		t.Run(scenario, func(t *testing.T) {
			ctx := context.Background()
			app, _, id, _ := koiLinkIndexFixture(t)
			entry := githubArchiveEntry{"root/SKILL.md", "# Write clearly", 0}
			if scenario == "unsafe_archive" {
				entry.name = "root/../SKILL.md"
			}
			client := githubImportClient(t, githubArchive(t, entry), token, scenario == "private")
			base := client.Transport
			calls := 0
			client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
				calls++
				if scenario == "transient" || scenario == "rate_limit" {
					status := 503
					if scenario == "rate_limit" {
						status = 429
					}
					return &http.Response{StatusCode: status, Header: make(http.Header), Request: r, Body: io.NopCloser(strings.NewReader(""))}, nil
				}
				if r.URL.Host == githubCodeLoadHost {
					var err error
					switch scenario {
					case "changed_review":
						koiTestCuration(t, app, koiReviewedRepository{RepositoryID: 123, RepositoryURL: "https://github.com/Octo/demo", Packages: map[string]string{}})
					case "changed_publication":
						_, err = app.db.Exec(ctx, `UPDATE agent_repository_publications SET published_at=clock_timestamp() WHERE workspace_id=$1`, id)
					case "changed_source":
						_, err = app.db.Exec(ctx, `UPDATE agent_repository_publications SET github_source=jsonb_set(github_source,'{ref}','"other"') WHERE workspace_id=$1`, id)
					case "newer_preview":
						var started time.Time
						err = app.db.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&started)
						if err == nil {
							app.rememberKoiGitHubInstallability(ctx, &agentGitHubSource{RepositoryID: 123, RepositoryURL: "https://github.com/Octo/demo", Ref: "main"}, started, false, koiTestCuration(t, app).revision, nil)
						}
					}
					if err != nil {
						t.Fatal(err)
					}
				}
				response, err := base.RoundTrip(r)
				if scenario == "replaced" && r.URL.Path == "/repos/Octo/demo" && err == nil {
					body, _ := io.ReadAll(response.Body)
					response.Body.Close()
					response.Body = io.NopCloser(strings.NewReader(strings.Replace(string(body), `"id":123`, `"id":124`, 1)))
				}
				return response, err
			})
			app.githubHTTPClient = client
			count, err := app.checkAgentRepositoryKoiInstallability(ctx, 8, token)
			transient := scenario == "transient" || scenario == "rate_limit"
			if count != 1 || (err != nil) != transient {
				t.Fatalf("check: %d %v", count, err)
			}
			value := repositoryKoiInstallability(t, app, id)
			if scenario == "private" || scenario == "replaced" || scenario == "unsafe_archive" || scenario == "newer_preview" {
				if value == nil || *value {
					t.Fatal("private/replaced upstream certified")
				}
			} else if value != nil {
				t.Fatal("failed/outdated check certified publication")
			}
			if transient {
				before := calls
				if count, err := app.checkAgentRepositoryKoiInstallability(ctx, 8, token); count != 0 || err != nil || calls != before {
					t.Fatal("temporary failure retried without backoff")
				}
				app.githubHTTPClient = githubImportClient(t, githubArchive(t, githubArchiveEntry{"root/SKILL.md", "# Write clearly", 0}), token, false)
				if _, err := app.db.Exec(ctx, `UPDATE agent_repository_publications SET koi_installability_attempted_at=now()-interval '6 minutes' WHERE workspace_id=$1`, id); err != nil {
					t.Fatal(err)
				}
				if count, err := app.checkAgentRepositoryKoiInstallability(ctx, 8, token); count != 1 || err != nil {
					t.Fatalf("recovery: %d %v", count, err)
				}
				if value := repositoryKoiInstallability(t, app, id); value == nil || !*value {
					t.Fatal("recovered link stayed excluded")
				}
			}
		})
	}
}

func TestKoiGitHubPreviewCannotCertifyDifferentHubTarget(t *testing.T) {
	ctx := context.Background()
	app, owner, id, _ := koiLinkIndexFixture(t)
	app.githubHTTPClient = koiGitHubSourceTestClient(t, "")
	for _, extra := range []map[string]any{
		{"path": "review"}, {"ref": "feature/review"}, {"commitSha": githubTestSHA}, {"fileEntry": true},
	} {
		source := map[string]any{"kind": "github", "repositoryUrl": "https://github.com/Octo/demo", "ref": "main"}
		for key, value := range extra {
			source[key] = value
		}
		if _, err := app.koiAnalyzeSource(ctx, owner, source); err != nil {
			t.Fatal(err)
		}
		if repositoryKoiInstallability(t, app, id) != nil {
			t.Fatalf("alternate target certified Hub: %+v", extra)
		}
	}
	indexStart := func() time.Time {
		t.Helper()
		var started time.Time
		if err := app.db.QueryRow(ctx, `SELECT clock_timestamp()`).Scan(&started); err != nil {
			t.Fatal(err)
		}
		return started
	}
	started := indexStart()
	source := &agentGitHubSource{RepositoryID: 123, RepositoryURL: "https://github.com/Octo/demo", Ref: "main", Private: true}
	app.rememberKoiGitHubInstallability(ctx, source, started, true, koiTestCuration(t, app).revision, nil)
	if repositoryKoiInstallability(t, app, id) != nil {
		t.Fatal("private preview certified Hub")
	}
	source.Private = false
	app.rememberKoiGitHubInstallability(ctx, source, indexStart(), false, koiTestCuration(t, app).revision, nil)
	if value := repositoryKoiInstallability(t, app, id); value == nil || *value {
		t.Fatal("newer validation not saved")
	}
	app.rememberKoiGitHubInstallability(ctx, source, started, true, koiTestCuration(t, app).revision, nil)
	if value := repositoryKoiInstallability(t, app, id); value == nil || *value {
		t.Fatal("late preview overwrote newer validation")
	}
}
