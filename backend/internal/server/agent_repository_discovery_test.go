package server

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"koinote/backend/internal/config"
)

const discoveryMIT = `MIT License
Copyright (c) Original Author
Permission is hereby granted, free of charge, to any person obtaining a copy of this software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.`

const discoveryISC = `ISC License

Copyright (c) 2025, Mapbox

Permission to use, copy, modify, and/or distribute this software for any purpose
with or without fee is hereby granted, provided that the above copyright notice
and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.`

const discoveryISCAnd = `ISC License

Copyright (c) 2013-2025 The btcsuite developers
Copyright (c) 2015-2016 The Decred developers

Permission to use, copy, modify, and distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.`

const discovery0BSD = `BSD Zero Clause License
Copyright (c) 2025, Original Author
Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted.
THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE.`

var discoveryFixtureSequence atomic.Int64

type discoveryFixture struct {
	items                     []githubRepositoryMetadata
	archives                  map[int64][]byte
	statuses                  map[int64]int
	archiveCalls, searchCalls int
	incomplete                bool
}

func newDiscoveryFixture(t *testing.T, count int) (*App, *repositoryObjectFixture, *discoveryFixture) {
	t.Helper()
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "discovery-test"}, pool)
	objects := enableRepositoryR2Fixture(t, app)
	base := 9000000000 + discoveryFixtureSequence.Add(1000)
	f := &discoveryFixture{archives: map[int64][]byte{}, statuses: map[int64]int{}}
	for i := 0; i < count; i++ {
		item := githubRepositoryMetadata{ID: base + int64(i), Name: fmt.Sprintf("skills-%d", i), Stars: 1000 + i, DefaultBranch: "main", Description: "Reusable coding skills"}
		item.Owner.Login = "DiscoveryTest"
		item.FullName = item.Owner.Login + "/" + item.Name
		item.License = &struct {
			SPDXID string `json:"spdx_id"`
		}{SPDXID: "MIT"}
		f.items = append(f.items, item)
		f.archives[item.ID] = githubArchive(t, githubArchiveEntry{"root/LICENSE", discoveryMIT, 0}, githubArchiveEntry{"root/SKILL.md", "---\nname: example\ndescription: Example skill\n---\n# Skill", 0})
	}
	t.Cleanup(func() {
		ctx := context.Background()
		// Delete events before their workspace foreign key is set to NULL.
		_, err := pool.Exec(ctx, `DELETE FROM agent_repository_system_events WHERE workspace_id IN (SELECT id FROM agent_workspaces WHERE github_source->>'repositoryId' BETWEEN $1 AND $2)`, fmt.Sprint(base), fmt.Sprint(base+999))
		if err != nil {
			t.Error(err)
		}
		_, err = pool.Exec(ctx, `DELETE FROM agent_workspaces WHERE github_source->>'repositoryId' BETWEEN $1 AND $2`, fmt.Sprint(base), fmt.Sprint(base+999))
		if err != nil {
			t.Error(err)
		}
		_, err = pool.Exec(ctx, `DELETE FROM agent_repository_discoveries WHERE github_id BETWEEN $1 AND $2`, base, base+999)
		if err != nil {
			t.Error(err)
		}
	})
	app.githubHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "api.github.com" || r.Header.Get("Authorization") != "Bearer discovery-test-token" {
			t.Error("unexpected upstream request")
		}
		res := &http.Response{StatusCode: 200, Header: make(http.Header), Request: r}
		var data []byte
		if r.URL.Path == "/search/repositories" {
			f.searchCalls++
			q := r.URL.Query()
			if q.Get("sort") != "stars" || q.Get("order") != "desc" || !strings.Contains(q.Get("q"), "stars:>=100 fork:false archived:false is:public") {
				t.Error("incorrect popularity/public search")
			}
			page, err := strconv.Atoi(q.Get("page"))
			if err != nil || page < 1 || q.Get("per_page") != "100" {
				t.Fatal("invalid search pagination")
			}
			start := min((page-1)*100, len(f.items))
			items := f.items[start:min(start+100, len(f.items))]
			data, _ = json.Marshal(map[string]any{"items": items, "incomplete_results": f.incomplete})
		} else {
			found := false
			for _, item := range f.items {
				prefix := "/repos/" + item.FullName
				if r.URL.Path != prefix && !strings.HasPrefix(r.URL.Path, prefix+"/") {
					continue
				}
				found = true
				switch {
				case strings.Contains(r.URL.Path, "/commits/"):
					if !strings.HasSuffix(r.URL.Path, "/commits/main") {
						t.Error("wrong branch")
					}
					data = []byte(githubSyncTestSHA)
				case strings.Contains(r.URL.Path, "/zipball/"):
					if !strings.HasSuffix(r.URL.Path, "/"+githubSyncTestSHA) {
						t.Error("unversioned archive")
					}
					f.archiveCalls++
					data = f.archives[item.ID]
				default:
					data, _ = json.Marshal(item)
					if status := f.statuses[item.ID]; status != 0 {
						res.StatusCode = status
					}
				}
				break
			}
			if !found {
				t.Errorf("unexpected endpoint %s", r.URL.Path)
				res.StatusCode = 404
			}
		}
		res.Body = io.NopCloser(bytes.NewReader(data))
		return res, nil
	})}
	return app, objects, f
}

func runDiscovery(app *App, apply bool) (SystemRepositoryDiscoverySummary, []SystemRepositoryDiscoveryResult, error) {
	var results []SystemRepositoryDiscoveryResult
	summary, err := app.DiscoverSystemAgentRepositories(context.Background(), SystemRepositoryDiscoveryOptions{Apply: apply, GitHubToken: "discovery-test-token", OnResult: func(r SystemRepositoryDiscoveryResult) { results = append(results, r) }})
	return summary, results, err
}

func TestSystemRepositoryDiscoveryDailyLimitAndNextDay(t *testing.T) {
	app, _, f := newDiscoveryFixture(t, 25)
	summary, results, err := runDiscovery(app, true)
	if err != nil || summary.Added != 20 || summary.Remaining != 0 || summary.Candidates != 25 || len(results) != 20 {
		t.Fatalf("first run: %+v %v", summary, err)
	}
	if !sort.SliceIsSorted(results, func(i, j int) bool { return results[i].Stars > results[j].Stars }) {
		t.Fatal("not ranked by stars")
	}
	ctx := context.Background()
	for _, result := range results {
		view, err := app.loadPublicAgentRepository(ctx, result.WorkspaceID, nil)
		if err != nil || view.GitHubSource.RepositoryID <= 0 || view.GitHubSource.Author != "DiscoveryTest" || view.GitHubSource.License != "MIT" || len(view.Files) != 2 {
			t.Fatalf("public provenance/files: %+v %v", view, err)
		}
		assertRepositoryHasNoDatabaseContent(t, app, result.WorkspaceID)
		var system bool
		var events int
		if err = app.db.QueryRow(ctx, `SELECT is_system AND user_id IS NULL,(SELECT count(*) FROM agent_repository_system_events WHERE workspace_id=$1 AND actor_user_id IS NULL) FROM agent_workspaces WHERE id=$1`, result.WorkspaceID).Scan(&system, &events); err != nil || !system || events != 2 {
			t.Fatalf("ownership/audit: %v %d %v", system, events, err)
		}
	}
	searches, archives := f.searchCalls, f.archiveCalls
	summary, _, err = runDiscovery(app, true)
	if err != nil || summary.AlreadyAdded != 20 || summary.Added != 0 || f.searchCalls != searches || f.archiveCalls != archives {
		t.Fatalf("same-day retry did work: %+v %v", summary, err)
	}
	// Deletion does not recover daily capacity or make the same GitHub repo new.
	if _, err = app.db.Exec(ctx, `DELETE FROM agent_repository_system_events WHERE workspace_id=$1`, results[0].WorkspaceID); err != nil {
		t.Fatal(err)
	}
	if _, err = app.db.Exec(ctx, `DELETE FROM agent_workspaces WHERE id=$1`, results[0].WorkspaceID); err != nil {
		t.Fatal(err)
	}
	summary, _, err = runDiscovery(app, true)
	if err != nil || summary.AlreadyAdded != 20 {
		t.Fatalf("deletion refunded budget: %+v %v", summary, err)
	}
	if _, err = app.db.Exec(ctx, `UPDATE agent_repository_discoveries SET accepted_on=accepted_on-1 WHERE github_id BETWEEN $1 AND $2`, f.items[0].ID, f.items[24].ID); err != nil {
		t.Fatal(err)
	}
	// A renamed accepted repo is still the same identity, even after deletion.
	f.items[24].Name, f.items[24].FullName = "renamed", "DiscoveryTest/renamed"
	summary, _, err = runDiscovery(app, true)
	if err != nil || summary.Added != 5 || summary.Skipped != 20 || summary.Remaining != 15 {
		t.Fatalf("next-day dedup: %+v %v", summary, err)
	}
}

func TestSystemRepositoryDiscoveryContinuesPastPreviewBudget(t *testing.T) {
	app, objects, f := newDiscoveryFixture(t, 123)
	// Higher-star results consume the first 100 checks without yielding a repo.
	// Eligible results deliberately start on the other side of that boundary.
	for i := 23; i < len(f.items); i++ {
		f.items[i].License.SPDXID = "UNLICENSED"
	}
	summary, _, err := runDiscovery(app, false)
	if err != nil || summary.Checked != 100 || summary.WouldAdd != 0 || summary.Outcome != "candidate_check_budget_reached" {
		t.Fatalf("bounded preview: %+v %v", summary, err)
	}
	var ledgerRows int
	if err = app.db.QueryRow(context.Background(), `SELECT count(*) FROM agent_repository_discoveries WHERE github_id BETWEEN $1 AND $2`, f.items[0].ID, f.items[122].ID).Scan(&ledgerRows); err != nil || ledgerRows != 0 {
		t.Fatalf("preview persisted progress: %d %v", ledgerRows, err)
	}
	objects.mu.Lock()
	puts := objects.puts
	objects.mu.Unlock()
	if puts != 0 {
		t.Fatal("preview wrote R2")
	}
	summary, results, err := runDiscovery(app, true)
	if err != nil || summary.Candidates != 123 || summary.Checked != 120 || summary.Skipped != 100 || summary.Added != 20 || summary.Remaining != 0 || summary.Outcome != "daily_target_reached" {
		t.Fatalf("did not continue to daily target: %+v %v", summary, err)
	}
	if len(results) != 120 || f.archiveCalls != 20 {
		t.Fatalf("checked %d results, downloaded %d archives", len(results), f.archiveCalls)
	}
	searches := f.searchCalls
	summary, _, err = runDiscovery(app, true)
	if err != nil || summary.AlreadyAdded != 20 || summary.Checked != 0 || f.searchCalls != searches {
		t.Fatalf("later schedule should be a no-op: %+v %v", summary, err)
	}
}

func TestSystemRepositoryDiscoveryCatchUpAfterInterruption(t *testing.T) {
	app, _, f := newDiscoveryFixture(t, 125)
	for i := 25; i < len(f.items); i++ {
		f.items[i].License.SPDXID = "UNLICENSED"
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	summary, err := app.DiscoverSystemAgentRepositories(ctx, SystemRepositoryDiscoveryOptions{
		Apply: true, GitHubToken: "discovery-test-token",
		OnResult: func(result SystemRepositoryDiscoveryResult) {
			if result.Status == "added" {
				cancel()
			}
		},
	})
	if !errors.Is(err, context.Canceled) || summary.Checked != 101 || summary.Added != 1 {
		t.Fatalf("interrupted continuation: %+v %v", summary, err)
	}
	summary, _, err = runDiscovery(app, true)
	if err != nil || summary.AlreadyAdded != 1 || summary.Added != 19 || summary.Checked != 19 || summary.Skipped != 101 || summary.Remaining != 0 || summary.Outcome != "daily_target_reached" {
		t.Fatalf("catch-up did not resume from persisted results: %+v %v", summary, err)
	}
	if f.archiveCalls != 20 {
		t.Fatalf("catch-up downloaded accepted archives again: %d calls", f.archiveCalls)
	}
}

func TestSystemRepositoryDiscoveryExhaustsIneligibleCandidates(t *testing.T) {
	app, _, f := newDiscoveryFixture(t, 105)
	for i := range f.items {
		f.items[i].License.SPDXID = "UNLICENSED"
	}
	summary, _, err := runDiscovery(app, true)
	if err != nil || summary.Checked != 105 || summary.Skipped != 105 || summary.Added != 0 || summary.Remaining != 20 || summary.Outcome != "insufficient_eligible_candidates" {
		t.Fatalf("candidate exhaustion: %+v %v", summary, err)
	}
	if f.archiveCalls != 0 {
		t.Fatal("downloaded ineligible archives")
	}
}

func TestSystemRepositoryDiscoveryPreviewAndPolicy(t *testing.T) {
	app, objects, f := newDiscoveryFixture(t, 5)
	f.archives[f.items[1].ID] = githubArchive(t, githubArchiveEntry{"root/README.md", "A list", 0}, githubArchiveEntry{"root/LICENSE", discoveryMIT, 0})
	f.items[2].License.SPDXID = "UNLICENSED"
	f.archives[f.items[3].ID] = githubArchive(t, githubArchiveEntry{"root/SKILL.md", "Skill", 0}, githubArchiveEntry{"root/LICENSE", discoveryMIT, 0}, githubArchiveEntry{"root/.env", "configuration", 0})
	f.archives[f.items[4].ID] = githubArchive(t, githubArchiveEntry{"root/SKILL.md", "Skill", 0}, githubArchiveEntry{"root/LICENSE", discoveryMIT, 0}, githubArchiveEntry{"root/nested/LICENSE", "CC-BY-NC-4.0", 0})
	summary, results, err := runDiscovery(app, false)
	if err != nil || summary.WouldAdd != 1 || summary.Added != 0 || summary.Skipped != 4 || len(results) != 5 {
		t.Fatalf("preview: %+v %+v %v", summary, results, err)
	}
	var rows int
	if err = app.db.QueryRow(context.Background(), `SELECT count(*) FROM agent_repository_discoveries WHERE github_id BETWEEN $1 AND $2`, f.items[0].ID, f.items[4].ID).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("preview wrote ledger: %d %v", rows, err)
	}
	objects.mu.Lock()
	puts := objects.puts
	objects.mu.Unlock()
	if puts != 0 {
		t.Fatal("preview wrote R2")
	}
	summary, _, err = runDiscovery(app, true)
	if err != nil || summary.Added != 1 || summary.Skipped != 4 {
		t.Fatalf("apply: %+v %v", summary, err)
	}
	archives := f.archiveCalls
	summary, _, err = runDiscovery(app, true)
	if err != nil || summary.Checked != 0 || summary.Skipped != 5 || f.archiveCalls != archives {
		t.Fatalf("policy cache: %+v %v", summary, err)
	}
}

func TestSystemRepositoryDiscoveryRecoversPartialFailure(t *testing.T) {
	app, objects, f := newDiscoveryFixture(t, 3)
	f.statuses[f.items[1].ID] = 503
	summary, _, err := runDiscovery(app, true)
	if err == nil || summary.Added != 2 || summary.Failed != 1 {
		t.Fatalf("partial: %+v %v", summary, err)
	}
	delete(f.statuses, f.items[1].ID)
	objects.mu.Lock()
	objects.failPut = true
	objects.mu.Unlock()
	summary, _, err = runDiscovery(app, true)
	if err == nil || summary.Added != 0 || summary.AlreadyAdded != 2 || summary.Failed != 1 {
		t.Fatalf("storage failure: %+v %v", summary, err)
	}
	var workspaces int
	if err = app.db.QueryRow(context.Background(), `SELECT count(*) FROM agent_workspaces WHERE github_source->>'repositoryId'=$1`, fmt.Sprint(f.items[1].ID)).Scan(&workspaces); err != nil || workspaces != 0 {
		t.Fatalf("partial workspace left: %d %v", workspaces, err)
	}
	objects.mu.Lock()
	objects.failPut = false
	objects.mu.Unlock()
	summary, _, err = runDiscovery(app, true)
	if err != nil || summary.Added != 1 || summary.AlreadyAdded != 2 {
		t.Fatalf("retry: %+v %v", summary, err)
	}
}

func TestSystemRepositoryDiscoveryJobLockAndRateLimit(t *testing.T) {
	app, _, f := newDiscoveryFixture(t, 3)
	ctx := context.Background()
	tx, err := app.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock($1)`, agentRepositoryDiscoveryLock); err != nil {
		t.Fatal(err)
	}
	if _, _, err = runDiscovery(app, true); err == nil || f.searchCalls != 0 {
		t.Fatal("overlapping job was not rejected")
	}
	if err = tx.Rollback(ctx); err != nil {
		t.Fatal(err)
	}
	f.incomplete = true
	if _, _, err = runDiscovery(app, true); err == nil || f.archiveCalls != 0 {
		t.Fatal("incomplete ranking was accepted")
	}
	f.incomplete = false
	f.statuses[f.items[2].ID] = 429
	summary, _, err := runDiscovery(app, true)
	if !errors.Is(err, errAgentGitHubRateLimited) || summary.Checked != 1 || summary.Added != 0 {
		t.Fatalf("rate limit: %+v %v", summary, err)
	}
}

func TestSystemRepositoryDiscoveryAtomicDailyBudget(t *testing.T) {
	app, _, f := newDiscoveryFixture(t, 2)
	ctx := context.Background()
	day, _, err := systemRepositoryDiscoveryBudget(ctx, app.db)
	if err != nil {
		t.Fatal(err)
	}
	// Leave only one place, then race two independent import transactions.
	for i := int64(100); i < 119; i++ {
		if _, err = app.db.Exec(ctx, `INSERT INTO agent_repository_discoveries(github_id,repository_url,github_stars,code,accepted_on) VALUES($1,'https://github.com/test/previous',100,'added',$2::date)`, f.items[0].ID+i, day); err != nil {
			t.Fatal(err)
		}
	}
	var wg sync.WaitGroup
	results := make(chan error, 2)
	for _, item := range f.items {
		files, err := readGitHubArchive(ctx, bytes.NewReader(f.archives[item.ID]), int64(len(f.archives[item.ID])))
		if err != nil {
			t.Fatal(err)
		}
		wg.Add(1)
		go func(item githubRepositoryMetadata, files []agentWorkspaceFile) {
			defer wg.Done()
			source := &agentGitHubSource{RepositoryID: item.ID, RepositoryURL: "https://github.com/" + item.FullName, Author: item.Owner.Login, AuthorURL: "https://github.com/" + item.Owner.Login, CommitSHA: githubSyncTestSHA, Ref: "main", License: "MIT"}
			_, err := app.publishDiscoveredSystemRepository(ctx, day, item.Stars, item.Name, item.Description, source, files)
			results <- err
		}(item, files)
	}
	wg.Wait()
	close(results)
	success, stopped := 0, 0
	for err := range results {
		if err == nil {
			success++
		} else if errors.Is(err, errAgentRepositoryDiscoveryStopped) {
			stopped++
		} else {
			t.Fatal(err)
		}
	}
	if success != 1 || stopped != 1 {
		t.Fatalf("daily cap race: %d success %d stopped", success, stopped)
	}
	_, count, err := systemRepositoryDiscoveryBudget(ctx, app.db)
	if err != nil || count != 20 {
		t.Fatalf("budget %d: %v", count, err)
	}
}

func TestDiscoveredSkillsLicenseReview(t *testing.T) {
	for _, tc := range []struct{ name, license, root, extraPath, extraText, expected string }{
		{"mit", "MIT", "", "", "", ""},
		{"isc", "ISC", discoveryISC, "", "", ""},
		{"isc and distribute", "ISC", discoveryISCAnd, "", "", ""},
		{"missing matching root", "Apache-2.0", "", "", "", "license_review_required"},
		{"nested unknown", "MIT", "", "sub/LICENSE.txt", "special terms", "license_review_required"},
		{"nested permissive", "MIT", "", "sub/LICENSE.txt", discoveryMIT, ""},
		{"nested isc", "MIT", "", "sub/LICENSE.txt", discoveryISC, ""},
		{"nested isc and distribute", "MIT", "", "sub/LICENSE.txt", discoveryISCAnd, ""},
		{"nested 0bsd", "MIT", "", "sub/LICENSE.txt", discovery0BSD, "license_review_required"},
		{"nested isc wrapped restriction", "MIT", "", "sub/LICENSE.txt", discoveryISC + "\nNon-\nCommercial use only", "license_review_required"},
		{"notice exception", "MIT", "", "NOTICE", "Third party quotes are not covered by MIT", "license_review_required"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := tc.root
			if root == "" {
				root = discoveryMIT
			}
			files := []agentWorkspaceFile{repositoryTestFile("SKILL.md", "# skill"), repositoryTestFile("LICENSE", root)}
			if tc.extraPath != "" {
				files = append(files, repositoryTestFile(tc.extraPath, tc.extraText))
			}
			if code := validateDiscoveredSkills(files, 12345, tc.license); code != tc.expected {
				t.Fatalf("got %q want %q", code, tc.expected)
			}
		})
	}
}

func TestSystemRepositoryDiscoveryAcceptsISC(t *testing.T) {
	app, _, f := newDiscoveryFixture(t, 1)
	f.items[0].License.SPDXID = "ISC"
	f.archives[f.items[0].ID] = githubArchive(t,
		githubArchiveEntry{"root/LICENSE", discoveryISC, 0},
		githubArchiveEntry{"root/SKILL.md", "---\nname: example\ndescription: Example skill\n---\n# Skill", 0},
		githubArchiveEntry{"root/vendor/pixelmatch/LICENSE", discoveryISC, 0})
	summary, results, err := runDiscovery(app, true)
	if err != nil || summary.Added != 1 || len(results) != 1 || results[0].Status != "added" {
		t.Fatalf("ISC repository rejected: %+v %+v %v", summary, results, err)
	}
}

func TestSystemRepositoryDiscoveryExistingWithdrawnAndLegacyURLs(t *testing.T) {
	app, _, f := newDiscoveryFixture(t, 2)
	ctx := context.Background()
	var id int64
	// An older, withdrawn system entry has no numeric GitHub ID. Match its
	// source URL case-insensitively without publishing or modifying it.
	source := &agentGitHubSource{RepositoryURL: strings.ToLower("https://github.com/" + f.items[1].FullName), CommitSHA: githubTestSHA, License: "MIT"}
	if err := app.db.QueryRow(ctx, `INSERT INTO agent_workspaces(user_id,is_system,name,github_source) VALUES(NULL,true,'Withdrawn',$1) RETURNING id`, source).Scan(&id); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = app.db.Exec(context.Background(), `DELETE FROM agent_workspaces WHERE id=$1`, id) })
	summary, _, err := runDiscovery(app, true)
	if err != nil || summary.Skipped != 1 || summary.Added != 1 || f.archiveCalls != 1 {
		t.Fatalf("legacy dedup: %+v %v", summary, err)
	}
	var published bool
	if err = app.db.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM agent_repository_publications WHERE workspace_id=$1)`, id).Scan(&published); err != nil || published {
		t.Fatalf("withdrawn entry republished: %v %v", published, err)
	}
}

func TestSystemRepositoryDiscoveryTransactionRollback(t *testing.T) {
	app, _, f := newDiscoveryFixture(t, 1)
	ctx := context.Background()
	// Force a database error at the last ledger write, after workspace, history,
	// scans and publication have been written inside the same transaction.
	constraint := fmt.Sprintf(`ALTER TABLE agent_repository_discoveries ADD CONSTRAINT discovery_test_failure CHECK (github_id <> %d) NOT VALID`, f.items[0].ID)
	if _, err := app.db.Exec(ctx, constraint); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = app.db.Exec(context.Background(), `ALTER TABLE agent_repository_discoveries DROP CONSTRAINT IF EXISTS discovery_test_failure`)
	})
	summary, _, err := runDiscovery(app, true)
	if err == nil || summary.Failed != 1 || summary.Added != 0 {
		t.Fatalf("failure: %+v %v", summary, err)
	}
	var count int
	if err = app.db.QueryRow(ctx, `SELECT count(*) FROM agent_workspaces WHERE github_source->>'repositoryId'=$1`, fmt.Sprint(f.items[0].ID)).Scan(&count); err != nil || count != 0 {
		t.Fatalf("transaction left partial repo: %d %v", count, err)
	}
	if _, err = app.db.Exec(ctx, `ALTER TABLE agent_repository_discoveries DROP CONSTRAINT discovery_test_failure`); err != nil {
		t.Fatal(err)
	}
	summary, _, err = runDiscovery(app, true)
	if err != nil || summary.Added != 1 || summary.AlreadyAdded != 0 {
		t.Fatalf("retry after rollback: %+v %v", summary, err)
	}
}
