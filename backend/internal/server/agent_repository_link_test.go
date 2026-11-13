package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestSystemGitHubLinkCollectionAndPrivateInstall(t *testing.T) {
	a, user, _ := writingTestApp(t)
	ctx := context.Background()
	a.cfg.KoiSkillTestAccounts = []string{user.AuthUserID}
	if _, err := a.db.Exec(ctx, `UPDATE users SET is_admin=true WHERE id=$1`, user.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := a.db.Exec(ctx, `INSERT INTO agent_workspace_settings(user_id,enabled) VALUES($1,true) ON CONFLICT(user_id) DO UPDATE SET enabled=true`, user.ID); err != nil {
		t.Fatal(err)
	}
	objects := enableRepositoryR2Fixture(t, a)
	t.Cleanup(func() { _, _ = a.db.Exec(ctx, `DELETE FROM koi_skill_installations WHERE user_id=$1`, user.ID) })
	archive := githubArchive(t, githubArchiveEntry{"root/review/SKILL.md", "---\nname: review\ndescription: Improve an article.\n---\n# Review", 0})
	client := githubImportClient(t, archive, "", false)
	base := client.Transport
	downloads := 0
	client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host == githubCodeLoadHost {
			downloads++
		}
		if r.Header.Get("Authorization") != "" {
			t.Error("public link must not require credentials")
		}
		if r.URL.Path == "/repos/Octo/demo/commits/"+githubTestSHA {
			return &http.Response{StatusCode: 200, Header: make(http.Header), Request: r, Body: io.NopCloser(strings.NewReader(githubTestSHA))}, nil
		}
		if r.URL.Path == "/repos/Octo/demo" {
			r.URL.Path = "/repos/octo/demo"
		}
		return base.RoundTrip(r)
	})
	a.githubHTTPClient = client
	// Discovery backoff describes an earlier failed mirror check, not an
	// existing entry. An administrator can intentionally collect the public link.
	if _, err := a.db.Exec(ctx, `INSERT INTO agent_repository_discoveries(github_id,repository_url,github_stars,code,retry_after) VALUES(123,'https://github.com/octo/demo',1000,'sensitive_data_detected',now()+interval '7 days')`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = a.db.Exec(ctx, `DELETE FROM agent_repository_discoveries WHERE github_id=123`) })
	requestID, _ := randomUUID()
	input := fmt.Sprintf(`{"repositoryUrl":"https://github.com/octo/demo","linkOnly":true,"requestId":%q}`, requestID)
	cookie := mcpSessionCookie(a, user.AuthUserID)
	var imported struct{ Workspace agentWorkspaceView }
	decodeJSONResponse(t, callRepositoryAPI(t, a, cookie, "POST", "/api/admin/agent-repositories/import/github", input, 201), &imported)
	w := imported.Workspace
	t.Cleanup(func() {
		_, _ = a.db.Exec(ctx, `DELETE FROM agent_repository_system_events WHERE workspace_id=$1`, w.WorkspaceID)
		_, _ = a.db.Exec(ctx, `DELETE FROM agent_workspaces WHERE id=$1`, w.WorkspaceID)
	})
	if downloads != 0 || objects.puts != 0 || len(w.Files) != 0 || w.GitHubSource == nil || !w.GitHubSource.LinkOnly {
		t.Fatalf("link copied repository contents: %+v", w)
	}
	if w.Name != "Octo/demo" {
		t.Fatalf("lost source name: %s", w.Name)
	}
	// An uncertain response replays the same entry; changing import mode conflicts.
	callRepositoryAPI(t, a, cookie, "POST", "/api/admin/agent-repositories/import/github", input, 201)
	callRepositoryAPI(t, a, cookie, "POST", "/api/admin/agent-repositories/import/github", strings.Replace(input, `"linkOnly":true`, `"linkOnly":false`, 1), 409)
	callRepositoryAPI(t, a, cookie, "POST", "/api/agent/workspaces/import/github", input, 400)
	duplicateID, _ := randomUUID()
	duplicate := callRepositoryAPI(t, a, cookie, "POST", "/api/admin/agent-repositories/import/github", strings.Replace(input, requestID, duplicateID, 1), 409)
	if !strings.Contains(duplicate.Body.String(), "github_already_collected") {
		t.Fatalf("unclear duplicate response: %s", duplicate.Body)
	}

	sharing := fmt.Sprintf("/api/admin/agent-repositories/%d/sharing", w.WorkspaceID)
	callRepositoryAPI(t, a, cookie, "PUT", sharing, fmt.Sprintf(`{"expectedRevision":%d,"license":"MPL-2.0"}`, w.Revision), 200)
	publicPath := fmt.Sprintf("/api/agent/repositories/%d", w.WorkspaceID)
	var public struct{ Repository agentRepositoryPublication }
	decodeJSONResponse(t, callRepositoryAPI(t, a, nil, "GET", publicPath, "", 200), &public)
	if !public.Repository.GitHubSource.LinkOnly || len(public.Repository.Files) != 1 || public.Repository.Files[0].Path != "README.md" || public.Repository.SyncDisabledReason != "link_only" {
		t.Fatalf("link publication lost mode: %+v", public.Repository)
	}
	// Old clients read the application guide with their existing README renderer.
	guideURL := fmt.Sprintf("%s/files/1?revision=%d&publication=%s", publicPath, public.Repository.Revision, url.QueryEscape(public.Repository.PublicationID))
	var guide struct{ File agentWorkspaceFileContentView }
	decodeJSONResponse(t, callRepositoryAPI(t, a, nil, "GET", guideURL, "", 200), &guide)
	content, err := base64.StdEncoding.DecodeString(guide.File.ContentBase64)
	if err != nil || guide.File.SHA256 != koiDigest(content) || guide.File.SizeBytes != int64(len(content)) || guide.File.SHA256 != public.Repository.Files[0].SHA256 {
		t.Fatalf("guide metadata mismatch: %+v %v", guide, err)
	}
	for _, expected := range []string{fmt.Sprintf("/repositories/%d?installKoi=true", w.WorkspaceID), "/download", "1.1.21", "已有技能无需重新安装", w.GitHubSource.RepositoryURL} {
		if !strings.Contains(string(content), expected) {
			t.Fatalf("guide missing installation path %q: %s", expected, content)
		}
	}
	callRepositoryAPI(t, a, nil, "GET", strings.Replace(guideURL, "publication=", "publication=stale", 1), "", 409)
	callRepositoryAPI(t, a, nil, "GET", fmt.Sprintf("%s/files/1?revision=%d", publicPath, public.Repository.Revision+1), "", 404)
	callRepositoryAPI(t, a, nil, "GET", strings.Replace(guideURL, "/files/1?", "/files/2?", 1), "", 404)
	// A capability-aware client keeps the empty, honest source-link manifest.
	for _, action := range []struct{ method, path string }{{"GET", publicPath}, {"POST", publicPath + "/sync"}} {
		req := httptest.NewRequest(action.method, action.path, nil)
		req.Header.Set(repositoryLinksHeader, "1")
		response := httptest.NewRecorder()
		a.Routes().ServeHTTP(response, req)
		var modern struct{ Repository agentRepositoryPublication }
		if response.Code != 200 {
			t.Fatalf("modern link response: %d %s", response.Code, response.Body)
		}
		decodeJSONResponse(t, response, &modern)
		if len(modern.Repository.Files) != 0 || !modern.Repository.GitHubSource.LinkOnly {
			t.Fatalf("modern link acquired fake files: %+v", modern)
		}
	}
	// Refreshing an old-client view must preserve its installation guide.
	var refreshed struct{ Repository agentRepositoryPublication }
	decodeJSONResponse(t, callRepositoryAPI(t, a, cookie, "POST", publicPath+"/sync", "", 200), &refreshed)
	if len(refreshed.Repository.Files) != 1 || refreshed.Repository.Files[0].SHA256 != guide.File.SHA256 {
		t.Fatalf("refresh dropped guide: %+v", refreshed)
	}
	// Sync, Fork and Clone cannot turn a catalog link into a mirror or an empty copy.
	if _, err := a.forkAgentRepository(ctx, user.ID, w.WorkspaceID, w.Revision, requestID); !errors.Is(err, errAgentGitHubRepositoryInvalid) {
		t.Fatalf("link fork: %v", err)
	}
	cloneID, _ := randomUUID()
	callRepositoryAPI(t, a, nil, "POST", publicPath+"/clone", fmt.Sprintf(`{"expectedRevision":%d,"requestId":%q,"method":"zip","refresh":false}`, w.Revision, cloneID), 400)
	if _, err := a.readKoiHubSource(ctx, koiHubSourceInput{WorkspaceID: w.WorkspaceID}); !errors.Is(err, errAgentGitHubRepositoryInvalid) {
		t.Fatalf("link read as mirror: %v", err)
	}
	if checked, err := a.backfillAgentRepositoryKoiInstallability(ctx, 8); err != nil || checked != 0 {
		t.Fatalf("link compatibility backfill: %d %v", checked, err)
	}
	if downloads != 0 {
		t.Fatal("catalog action downloaded repository")
	}
	// Only a user-requested GitHub preview reads files. Confirmation saves the
	// selected package privately and never adds public/workspace file content.
	installID, _ := randomUUID()
	preview := koiFolderView(t, koiFolderRequest(t, a, user, "POST", "/api/koi/skill-imports", koiImportRequest{RequestID: installID, SourceKind: "github", RepositoryURL: w.GitHubSource.RepositoryURL, Ref: w.GitHubSource.Ref}, 202))
	if downloads != 1 || objects.puts != 0 {
		t.Fatalf("preview downloads=%d puts=%d", downloads, objects.puts)
	}
	skill := koiTestConfirm(t, a, user, preview)
	if skill.SourceKind != "github" || skill.Source["commitSha"] != githubTestSHA {
		t.Fatalf("private install lost source: %+v", skill.Source)
	}
	var files, blobs, published int
	err = a.db.QueryRow(ctx, `SELECT (SELECT count(*) FROM agent_workspace_files WHERE workspace_id=$1),(SELECT count(*) FROM agent_workspace_blobs WHERE workspace_id=$1),(SELECT count(*) FROM agent_repository_publication_files WHERE workspace_id=$1)`, w.WorkspaceID).Scan(&files, &blobs, &published)
	if err != nil || files+blobs+published != 0 {
		t.Fatalf("link acquired content: %d/%d/%d %v", files, blobs, published, err)
	}
	response := koiFolderRequest(t, a, user, "GET", "/api/koi/skills?source=github&githubRepositoryId=123", nil, 200)
	var page struct{ Skills []koiSkillInstallation }
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil || len(page.Skills) != 1 || page.Skills[0].ID != skill.ID {
		t.Fatalf("installed link status: %s %v", response.Body, err)
	}
	for _, filter := range []string{"githubRepositoryId=124", "source=hub&githubRepositoryId=123", "githubRepositoryId=0", "hubWorkspaceId=7&githubRepositoryId=123"} {
		status := 400
		if filter == "githubRepositoryId=124" {
			status = 200
		}
		result := koiFolderRequest(t, a, user, "GET", "/api/koi/skills?"+filter, nil, status)
		if status == 200 && strings.Contains(result.Body.String(), skill.ID) {
			t.Fatal("status crossed repository boundary")
		}
	}
	callRepositoryAPI(t, a, cookie, "DELETE", sharing, fmt.Sprintf(`{"expectedRevision":%d}`, w.Revision), 200)
	callRepositoryAPI(t, a, nil, "GET", guideURL, "", 404)
	// Withdrawal and deletion are administrator decisions, never new candidates.
	for _, deleted := range []bool{false, true} {
		if deleted {
			if _, err := a.db.Exec(ctx, `UPDATE agent_workspaces SET deleted_at=now() WHERE id=$1`, w.WorkspaceID); err != nil {
				t.Fatal(err)
			}
		}
		attempt, _ := randomUUID()
		callRepositoryAPI(t, a, cookie, "POST", "/api/admin/agent-repositories/import/github", strings.Replace(input, requestID, attempt, 1), 409)
	}
}

func TestDiscoveredGitHubLinksDoNotMirrorOrPromiseCompatibility(t *testing.T) {
	codes := []string{"license_review_required", "no_koi_compatible_skills", "koi_preview_too_large", "github_archive_invalid", "archive_rejected", "sensitive_path", "sensitive_data_detected"}
	a, objects, f := newDiscoveryFixture(t, len(codes))
	ctx := context.Background()
	for i, code := range codes {
		item := f.items[i]
		f.items[i].License.SPDXID = "NOASSERTION"
		if _, err := a.db.Exec(ctx, `INSERT INTO agent_repository_discoveries(github_id,repository_url,github_stars,code,retry_after) VALUES($1,$2,1000,$3,now()+interval '7 days')`, item.ID, "https://github.com/"+item.FullName, code); err != nil {
			t.Fatal(err)
		}
	}
	item := f.items[0]
	base := a.githubHTTPClient.Transport
	treeCalls := 0
	a.githubHTTPClient.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if strings.Contains(r.URL.Path, "/git/trees/") {
			treeCalls++
			if r.Header.Get("Authorization") != "" || !strings.HasSuffix(r.URL.Path, "/"+githubSyncTestSHA) {
				t.Errorf("link tree is not pinned/public: %s", r.URL)
			}
			return &http.Response{StatusCode: 200, Header: make(http.Header), Request: r, Body: io.NopCloser(strings.NewReader(`{"truncated":false,"tree":[{"path":"review/SKILL.md","type":"blob"}]}`))}, nil
		}
		return base.RoundTrip(r)
	})
	summary, err := a.DiscoverSystemAgentRepositories(ctx, SystemRepositoryDiscoveryOptions{Apply: true, LinkOnly: true, GitHubToken: "discovery-test-token"})
	if err != nil || summary.Added != len(codes) || f.archiveCalls != 0 || objects.puts != 0 || treeCalls != len(codes) {
		t.Fatalf("link discovery: %+v %v downloads=%d puts=%d trees=%d", summary, err, f.archiveCalls, objects.puts, treeCalls)
	}
	var link, installable bool
	var files int
	err = a.db.QueryRow(ctx, `SELECT (p.github_source->>'linkOnly')::bool,p.koi_installable,(SELECT count(*) FROM agent_repository_publication_files WHERE workspace_id=p.workspace_id) FROM agent_repository_publications p JOIN agent_workspaces w ON w.id=p.workspace_id WHERE w.github_source->>'repositoryId'=$1`, fmt.Sprint(item.ID)).Scan(&link, &installable, &files)
	if err != nil || !link || installable || files != 0 {
		t.Fatalf("link marked compatible or mirrored: %v %v %d %v", link, installable, files, err)
	}
}

func TestLinkDiscoveryKeepsRelevantCooldownAndCollectionHistory(t *testing.T) {
	cases := []struct {
		code      string
		accepted  bool
		collected bool
	}{
		{code: "no_skills"},
		{code: "invalid_metadata"},
		{code: "unavailable_source"},
		{code: "ineligible_source"},
		{code: "repository_tree_incomplete"},
		{code: "added", accepted: true, collected: true},
	}
	a, _, fixture := newDiscoveryFixture(t, len(cases))
	ctx := context.Background()
	for i, tc := range cases {
		item := fixture.items[i]
		sourceURL := "https://github.com/" + item.FullName
		if _, err := a.db.Exec(ctx, `INSERT INTO agent_repository_discoveries(github_id,repository_url,github_stars,code,retry_after,accepted_on)
 VALUES($1,$2,1000,$3,now()+interval '7 days',CASE WHEN $4 THEN current_date ELSE NULL END)`, item.ID, sourceURL, tc.code, tc.accepted); err != nil {
			t.Fatal(err)
		}
		collected, err := systemRepositoryCollected(ctx, a.db, item.ID, sourceURL)
		if err != nil || collected != tc.collected {
			t.Fatalf("%s collection status: %t %v", tc.code, collected, err)
		}
		for _, linkOnly := range []bool{false, true} {
			skip, err := systemRepositoryDiscoveryShouldSkip(ctx, a.db, item.ID, sourceURL, linkOnly)
			if err != nil || !skip {
				t.Fatalf("%s cooldown/history lost (link=%t): %t %v", tc.code, linkOnly, skip, err)
			}
		}
		if _, err := a.db.Exec(ctx, `UPDATE agent_repository_discoveries SET retry_after=now()-interval '1 minute' WHERE github_id=$1`, item.ID); err != nil {
			t.Fatal(err)
		}
		skip, err := systemRepositoryDiscoveryShouldSkip(ctx, a.db, item.ID, sourceURL, true)
		if err != nil || skip != tc.collected {
			t.Fatalf("%s expired cooldown: %t %v", tc.code, skip, err)
		}
	}
}
