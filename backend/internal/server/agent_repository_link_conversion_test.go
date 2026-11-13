package server

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
)

func systemMirrorConversionFixture(t *testing.T) (*App, agentWorkspaceView, *repositoryObjectFixture) {
	t.Helper()
	a, _, w, objects := koiHubSourceTestApp(t, true, map[string]string{"review/SKILL.md": "# Original review"})
	source := &agentGitHubSource{RepositoryID: 123, RepositoryURL: "https://github.com/octo/demo", Author: "Octo", AuthorURL: "https://github.com/Octo", Ref: "main", CommitSHA: githubTestSHA, License: "MPL-2.0"}
	if _, err := a.db.Exec(context.Background(), `UPDATE agent_workspaces SET user_id=NULL,is_system=true,github_source=$2 WHERE id=$1`, w.WorkspaceID, source); err != nil {
		t.Fatal(err)
	}
	if _, err := a.db.Exec(context.Background(), `UPDATE agent_repository_publications SET github_source=$2 WHERE workspace_id=$1`, w.WorkspaceID, source); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = a.db.Exec(context.Background(), `DELETE FROM agent_repository_system_events WHERE workspace_id=$1`, w.WorkspaceID)
		_, _ = a.db.Exec(context.Background(), `DELETE FROM agent_workspaces WHERE id=$1`, w.WorkspaceID)
	})
	a.githubHTTPClient = koiGitHubSourceTestClient(t, "")
	return a, w, objects
}

func TestPublicMirrorConversionPreservesPrivateSkillsAndForks(t *testing.T) {
	a, w, objects := systemMirrorConversionFixture(t)
	ctx := context.Background()
	user := seedMCPUser(t, a.db, a, membershipTierLifetime)
	a.cfg.KoiSkillTestAccounts = []string{user.AuthUserID}
	if _, err := a.db.Exec(ctx, `INSERT INTO agent_workspace_settings(user_id,enabled) VALUES($1,true)`, user.ID); err != nil {
		t.Fatal(err)
	}
	publication, err := a.loadPublicAgentRepository(ctx, w.WorkspaceID, nil)
	if err != nil {
		t.Fatal(err)
	}
	requestID, _ := randomUUID()
	preview := koiFolderView(t, koiFolderRequest(t, a, user, "POST", "/api/koi/skill-imports", koiImportRequest{RequestID: requestID, SourceKind: "hub", WorkspaceID: w.WorkspaceID, PublicationID: publication.PublicationID, Revision: &publication.Revision}, 202))
	skill := koiTestConfirm(t, a, user, preview)
	koiFolderRequest(t, a, user, "PATCH", "/api/koi/skills/"+skill.ID, map[string]any{"expectedRevision": skill.Revision, "enabled": false}, 200)
	requestID, _ = randomUUID()
	fork, err := a.forkAgentRepository(ctx, user.ID, w.WorkspaceID, w.Revision, requestID)
	if err != nil {
		t.Fatal(err)
	}
	requestID, _ = randomUUID()
	stale := koiFolderView(t, koiFolderRequest(t, a, user, "POST", "/api/koi/skill-imports", koiImportRequest{RequestID: requestID, SourceKind: "hub", WorkspaceID: w.WorkspaceID, PublicationID: publication.PublicationID, Revision: &publication.Revision}, 202))
	before, err := a.loadKoiInstallation(ctx, a.db, user.ID, skill.ID)
	if err != nil {
		t.Fatal(err)
	}
	options := SystemRepositoryLinkOptions{GitHubToken: "fixture-token", WorkspaceID: w.WorkspaceID}
	// Public calls here use no credential; the metadata fixture enforces it.
	options.GitHubToken = "unused-required-token"
	base := a.githubHTTPClient.Transport
	downloads := 0
	a.githubHTTPClient.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		r.Header.Del("Authorization")
		if r.URL.Host == githubCodeLoadHost {
			downloads++
		}
		return base.RoundTrip(r)
	})
	summary, err := a.ConvertPublicSystemRepositoriesToLinks(ctx, options)
	if err != nil || summary.WouldConvert != 1 || summary.Converted != 0 || downloads != 0 {
		t.Fatalf("preview: %+v %v downloads=%d", summary, err, downloads)
	}
	after, err := a.loadKoiInstallation(ctx, a.db, user.ID, skill.ID)
	if err != nil || after.SourceKind != "hub" || after.Revision != before.Revision {
		t.Fatalf("preview mutated private skill: %+v %v", after, err)
	}
	options.Apply = true
	summary, err = a.ConvertPublicSystemRepositoriesToLinks(ctx, options)
	if err != nil || summary.Converted != 1 || summary.Bytes == 0 || downloads != 0 {
		t.Fatalf("apply: %+v %v downloads=%d", summary, err, downloads)
	}
	linked, err := a.loadPublicAgentRepository(ctx, w.WorkspaceID, nil)
	if err != nil || !linked.GitHubSource.LinkOnly || len(linked.Files) != 0 || linked.PublicationID != publication.PublicationID || linked.Revision != w.Revision+1 {
		t.Fatalf("converted publication: %+v %v", linked, err)
	}
	var files, blobs, history int
	if err = a.db.QueryRow(ctx, `SELECT (SELECT count(*) FROM agent_workspace_files WHERE workspace_id=$1),(SELECT count(*) FROM agent_workspace_blobs WHERE workspace_id=$1),(SELECT count(*) FROM agent_workspace_commit_files WHERE workspace_id=$1)`, w.WorkspaceID).Scan(&files, &blobs, &history); err != nil || files+blobs+history != 0 {
		t.Fatalf("mirror content retained: %d/%d/%d %v", files, blobs, history, err)
	}
	after, err = a.loadKoiInstallation(ctx, a.db, user.ID, skill.ID)
	if err != nil || after.ID != before.ID || after.VersionID != before.VersionID || after.Enabled || after.SourceKind != "github" || after.Revision != before.Revision+1 {
		t.Fatalf("private skill changed: %+v %v", after, err)
	}
	var fixedKind string
	if err = a.db.QueryRow(ctx, `SELECT source_fixed->>'kind' FROM koi_skill_versions WHERE id=$1`, after.VersionID).Scan(&fixedKind); err != nil || fixedKind != "hub" {
		t.Fatalf("immutable version provenance changed: %s %v", fixedKind, err)
	}
	detail := koiFolderRequest(t, a, user, "GET", "/api/koi/skills/"+skill.ID, nil, 200)
	if !strings.Contains(detail.Body.String(), "# Original review") {
		t.Fatal("conversion broke installed content")
	}
	copy, err := a.loadAgentWorkspace(ctx, user.ID, fork.WorkspaceID)
	if err != nil || len(copy.Files) != len(w.Files) {
		t.Fatalf("fork lost files: %+v %v", copy, err)
	}
	if removed, err := a.collectAgentRepositoryObjects(ctx, 100); err != nil || removed != 0 || objects.deletes != 0 {
		t.Fatalf("removed backup/private objects: %d %v", removed, err)
	}
	koiFolderRequest(t, a, user, "POST", "/api/koi/skill-imports/"+stale.ID+"/confirm", koiFolderConfirmation(stale), 409)
	var update struct {
		Status  string
		Preview koiSkillImportView
	}
	response := koiFolderRequest(t, a, user, "POST", "/api/koi/skills/"+skill.ID+"/check-update", nil, 200)
	if err = json.Unmarshal(response.Body.Bytes(), &update); err != nil || update.Status != "update_available" {
		t.Fatalf("GitHub update unavailable: %s %v", response.Body, err)
	}
	updated := koiTestConfirm(t, a, user, update.Preview)
	if updated.ID != skill.ID || updated.VersionID == before.VersionID || updated.Enabled {
		t.Fatalf("update replaced identity/state: %+v", updated)
	}
	summary, err = a.ConvertPublicSystemRepositoriesToLinks(ctx, options)
	if err != nil || summary.Checked != 0 {
		t.Fatalf("rerun not idempotent: %+v %v", summary, err)
	}
}

func TestMirrorConversionRetainsUnverifiedAndConflictingSources(t *testing.T) {
	for _, state := range []string{"unavailable", "private", "identity_changed", "disabled", "transient", "installed_conflict"} {
		t.Run(state, func(t *testing.T) {
			a, w, _ := systemMirrorConversionFixture(t)
			base := a.githubHTTPClient.Transport
			a.githubHTTPClient.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
				if strings.EqualFold(r.URL.Path, "/repos/octo/demo") && state != "installed_conflict" {
					body := `{"id":123,"name":"demo","full_name":"Octo/demo","owner":{"login":"Octo"},"default_branch":"main","private":false}`
					status := 200
					switch state {
					case "unavailable":
						status = 404
					case "transient":
						status = 503
					case "private":
						body = strings.Replace(body, `"private":false`, `"private":true`, 1)
					case "identity_changed":
						body = strings.Replace(body, `"id":123`, `"id":456`, 1)
					case "disabled":
						body = strings.Replace(body, `"private":false`, `"private":false,"disabled":true`, 1)
					}
					return &http.Response{StatusCode: status, Header: make(http.Header), Request: r, Body: io.NopCloser(strings.NewReader(body))}, nil
				}
				return base.RoundTrip(r)
			})
			if state == "installed_conflict" {
				user := seedMCPUser(t, a.db, a, membershipTierLifetime)
				for _, kind := range []string{"hub", "github"} {
					id, _ := randomUUID()
					source := map[string]any{"workspaceId": w.WorkspaceID, "path": "review"}
					key := "hub:" + fmt.Sprint(w.WorkspaceID) + ":review"
					if kind == "github" {
						key = "github:123:review"
					}
					raw, _ := json.Marshal(source)
					if _, err := a.db.Exec(context.Background(), `INSERT INTO koi_skill_installations(id,user_id,source_key,source_kind,source,name) VALUES($1,$2,$3,$4,$5,'review')`, id, user.ID, key, kind, raw); err != nil {
						t.Fatal(err)
					}
				}
			}
			result, err := a.convertPublicSystemRepositoryToLink(context.Background(), w.WorkspaceID, SystemRepositoryLinkOptions{Apply: true})
			if result.Status != "retained" || result.Files != int64(len(w.Files)) || (state == "transient" && err == nil) {
				t.Fatalf("unsafe conversion: %+v %v", result, err)
			}
			current, loadErr := a.loadPublicAgentRepository(context.Background(), w.WorkspaceID, nil)
			if loadErr != nil || current.GitHubSource.LinkOnly || len(current.Files) != len(w.Files) || current.Revision != w.Revision {
				t.Fatalf("retained mirror mutated: %+v %v", current, loadErr)
			}
		})
	}
}
