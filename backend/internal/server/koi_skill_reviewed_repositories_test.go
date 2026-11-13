package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
)

func koiTestCuration(t *testing.T, a *App, entries ...koiReviewedRepository) koiRepositoryCuration {
	t.Helper()
	for _, entry := range entries {
		capabilities := entry.RequiredCapabilities
		if capabilities == nil {
			capabilities = map[string][]string{}
		}
		var packages any
		if entry.Packages != nil {
			packages = entry.Packages
		}
		if _, err := a.db.Exec(context.Background(), `INSERT INTO agent_repository_curation
 (repository_id,repository_url,category,packages,required_capabilities) VALUES($1,$2,NULLIF($3,''),$4,$5)`,
			entry.RepositoryID, entry.RepositoryURL, entry.Category, packages, capabilities); err != nil {
			t.Fatal(err)
		}
		id := entry.RepositoryID
		t.Cleanup(func() {
			_, _ = a.db.Exec(context.Background(), `DELETE FROM agent_repository_curation WHERE repository_id=$1`, id)
		})
	}
	review, err := loadKoiRepositoryCuration(context.Background(), a.db)
	if err != nil {
		t.Fatal(err)
	}
	return review
}

func TestKoiRepositoryCurationUsesDatabaseAndExactContent(t *testing.T) {
	a, _, _ := writingTestApp(t)
	digest := strings.Repeat("a", 64)
	review := koiTestCuration(t, a,
		koiReviewedRepository{RepositoryID: 11, RepositoryURL: "https://github.com/review/research", Packages: map[string]string{digest: "research"}, RequiredCapabilities: map[string][]string{digest: {"network"}}},
		koiReviewedRepository{RepositoryID: 12, RepositoryURL: "https://github.com/review/unsupported", Packages: map[string]string{}},
		koiReviewedRepository{RepositoryID: 13, RepositoryURL: "https://github.com/review/category", Category: "writing"},
	)
	base := koiSkillCompatibility{Conversation: true, Article: true}
	got := review.compatibility("11", digest, base)
	if !got.Conversation || got.Article || !reflect.DeepEqual(got, review.contentCompatibility(digest, got)) {
		t.Fatalf("wrong reviewed capabilities: %+v", got)
	}
	if accepted, rejected := review.candidates(11, []koiSkillCandidate{{ContentSHA256: digest}}); len(accepted) != 1 || len(rejected) != 0 {
		t.Fatal("approved content was rejected")
	}
	if got := review.compatibility("11", strings.Repeat("b", 64), base, digest); got.Conversation || got.Article {
		t.Fatal("an entry digest must never authorize an unapproved package")
	}
	for _, id := range []int64{11, 12, 13} {
		accepted, rejected := review.candidates(id, []koiSkillCandidate{{ContentSHA256: strings.Repeat("b", 64)}})
		if (id == 13 && len(accepted) != 1) || (id != 13 && len(rejected) != 1) {
			t.Fatalf("NULL and empty reviews have different meanings: %d", id)
		}
	}
	if got := systemRepositoryDiscoveryCategory("skills", "", "https://github.com/REVIEW/CATEGORY.git", review); got != "writing" {
		t.Fatal(got)
	}
	// A database update must affect the next operation without restarting the app.
	if _, err := a.db.Exec(context.Background(), `UPDATE agent_repository_curation SET packages='{}' WHERE repository_id=11`); err != nil {
		t.Fatal(err)
	}
	updated, err := loadKoiRepositoryCuration(context.Background(), a.db)
	if err != nil {
		t.Fatal(err)
	}
	if got := updated.compatibility("11", digest, base); got.Conversation || got.Article {
		t.Fatalf("stale database review: %+v", got)
	}
	if updated.revision <= review.revision {
		t.Fatal("package policy updates must advance the cache revision")
	}
	if _, err := a.db.Exec(context.Background(), `UPDATE agent_repository_curation SET category='research' WHERE repository_id=11`); err != nil {
		t.Fatal(err)
	}
	if current := koiTestCuration(t, a); current.revision != updated.revision {
		t.Fatal("category-only edits invalidated installation checks")
	}
	if got := review.compatibility("11", digest, koiSkillCompatibility{}); got.Conversation || got.Article {
		t.Fatal("review broadened declared restrictions")
	}
}

func koiReviewGitHubClient(t *testing.T, archive []byte, repositoryID int64) *http.Client {
	t.Helper()
	client := githubImportClient(t, archive, "", false)
	base := client.Transport
	client.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/repos/Octo/demo/commits/"+githubTestSHA {
			return &http.Response{StatusCode: 200, Header: make(http.Header), Request: r, Body: io.NopCloser(strings.NewReader(githubTestSHA))}, nil
		}
		response, err := base.RoundTrip(r)
		if err == nil && strings.EqualFold(r.URL.Path, "/repos/Octo/demo") {
			var metadata map[string]any
			if err = json.NewDecoder(response.Body).Decode(&metadata); err != nil {
				t.Fatal(err)
			}
			response.Body.Close()
			metadata["id"] = repositoryID
			raw, _ := json.Marshal(metadata)
			response.Body = io.NopCloser(strings.NewReader(string(raw)))
		}
		return response, err
	})
	return client
}

func TestKoiReviewedGitHubScopeGuardsPreviewConfirmAndUpdate(t *testing.T) {
	a, user, _ := writingTestApp(t)
	a.cfg.KoiSkillTestAccounts = []string{user.AuthUserID}
	koiTestCuration(t, a, koiReviewedRepository{RepositoryID: 1250162731, RepositoryURL: "https://github.com/Octo/demo", Packages: map[string]string{}})
	archive := githubArchive(t, githubArchiveEntry{"root/tools/publisher/SKILL.md", "---\nname: publisher\ndescription: Publish PRD\n---\nRun dws and Python to publish to DingTalk.", 0})
	a.githubHTTPClient = koiReviewGitHubClient(t, archive, 123)
	create := func(dir string) koiSkillImportView {
		request, _ := randomUUID()
		return koiFolderView(t, koiFolderRequest(t, a, user, "POST", "/api/koi/skill-imports", koiImportRequest{RequestID: request, SourceKind: "github", RepositoryURL: "https://github.com/Octo/demo", Path: dir}, 202))
	}
	// Simulate a ready preview issued before the review policy was deployed.
	old := create("")
	if _, err := a.db.Exec(context.Background(), `UPDATE koi_skill_imports SET source=jsonb_set(source,'{repositoryId}','1250162731') WHERE id=$1`, old.ID); err != nil {
		t.Fatal(err)
	}
	installed := koiTestConfirm(t, a, user, create("tools/publisher"))
	if _, err := a.db.Exec(context.Background(), `UPDATE koi_skill_installations SET source=jsonb_set(source,'{repositoryId}','1250162731'),source_key='github:1250162731:tools/publisher' WHERE id=$1`, installed.ID); err != nil {
		t.Fatal(err)
	}
	a.githubHTTPClient = koiReviewGitHubClient(t, archive, 1250162731)
	for _, dir := range []string{"", "tools/publisher"} {
		view := create(dir)
		if view.Status != "failed" || len(view.Candidates) != 0 || len(view.Rejected) != 1 || view.Rejected[0].Reason != "not_reviewed" || view.Source["reviewedSubset"] != true {
			t.Fatalf("unreviewed package offered for installation: %+v", view)
		}
	}
	koiFolderRequest(t, a, user, "POST", "/api/koi/skill-imports/"+old.ID+"/confirm", koiFolderConfirmation(old), 409)
	var update struct {
		Preview koiSkillImportView `json:"preview"`
	}
	w := koiFolderRequest(t, a, user, "POST", "/api/koi/skills/"+installed.ID+"/check-update", nil, 200)
	if err := json.Unmarshal(w.Body.Bytes(), &update); err != nil || update.Preview.Status != "failed" || len(update.Preview.Rejected) != 1 || update.Preview.Rejected[0].Reason != "not_reviewed" {
		t.Fatalf("update bypassed review policy: %s %v", w.Body.String(), err)
	}
	current, err := a.loadKoiInstallation(context.Background(), a.db, user.ID, installed.ID)
	if err != nil || current.VersionID != installed.VersionID || current.Revision != installed.Revision {
		t.Fatalf("failed review changed the installed version: %+v %v", current, err)
	}
}

func TestKoiReviewedHubScopeMatchesGitHub(t *testing.T) {
	app, _, workspace, _ := koiHubSourceTestApp(t, true, map[string]string{"tools/publisher/SKILL.md": "---\nname: publisher\ndescription: Publish PRD\n---\nRun dws and Python."})
	koiTestCuration(t, app, koiReviewedRepository{RepositoryID: 1250162731, RepositoryURL: "https://github.com/Octo/demo", Packages: map[string]string{}})
	if _, err := app.db.Exec(context.Background(), `UPDATE agent_repository_publications SET github_source=$2 WHERE workspace_id=$1`, workspace.WorkspaceID,
		&agentGitHubSource{RepositoryID: 1250162731, RepositoryURL: "https://github.com/PANGKAIFENG/ai-product-manager-skills"}); err != nil {
		t.Fatal(err)
	}
	user := seedMCPUser(t, app.db, app, membershipTierLifetime)
	app.cfg.KoiSkillTestAccounts = []string{user.AuthUserID}
	t.Cleanup(func() { _, _ = app.db.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, user.ID) })
	for _, dir := range []string{"", "tools/publisher"} {
		request, _ := randomUUID()
		view := koiFolderView(t, koiFolderRequest(t, app, user, "POST", "/api/koi/skill-imports", koiImportRequest{RequestID: request, SourceKind: "hub", WorkspaceID: workspace.WorkspaceID, Path: dir}, 202))
		if view.Status != "failed" || len(view.Candidates) != 0 || len(view.Rejected) != 1 || view.Rejected[0].Reason != "not_reviewed" {
			t.Fatalf("mirrored Hub content bypassed review scope: %+v", view)
		}
	}
}
