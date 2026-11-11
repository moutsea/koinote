package server

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"koinote/backend/internal/model"
)

// The UI suite supplies the actual serialized requests emitted by the dialog,
// so display DTO fields cannot silently pass its permissive API mock.
func TestKoiImportRequestContract(t *testing.T) {
	filename := os.Getenv("KOINOTE_TEST_IMPORT_REQUESTS")
	if filename == "" {
		t.Skip("run npm run test:koi-skills for the frontend request contract")
	}
	raw, err := os.ReadFile(filename)
	if err != nil {
		t.Fatal(err)
	}
	var requests []json.RawMessage
	if err = json.Unmarshal(raw, &requests); err != nil {
		t.Fatal(err)
	}
	sources := map[string]bool{}
	for _, body := range requests {
		var input koiImportRequest
		if err = decodeJSONBody(httptest.NewRequest(http.MethodPost, "/api/koi/skill-imports", bytes.NewReader(body)), &input); err != nil {
			t.Fatalf("UI import request rejected by backend: %s: %v", body, err)
		}
		if !validUUID(input.RequestID) {
			t.Fatalf("missing request identity: %s", body)
		}
		sources[input.SourceKind] = true
		if input.SourceKind == "hub" && (input.WorkspaceID <= 0 || input.PublicationID == "" || input.Revision == nil) {
			t.Fatalf("Hub request lost its published snapshot: %s", body)
		}
	}
	if !sources["folder"] || !sources["github"] || !sources["hub"] {
		t.Fatalf("expected requests from all three install sources: %v", sources)
	}
}

func koiTestConfirm(t *testing.T, a *App, user model.User, view koiSkillImportView) koiSkillInstallation {
	t.Helper()
	installed := koiFolderInstalled(t, koiFolderRequest(t, a, user, "POST", "/api/koi/skill-imports/"+view.ID+"/confirm", koiFolderConfirmation(view), 200))
	if len(installed) != 1 {
		t.Fatalf("expected one installation: %+v", installed)
	}
	return installed[0]
}

func koiTestUpdate(t *testing.T, a *App, user model.User, skill koiSkillInstallation, content string) koiSkillImportView {
	t.Helper()
	request, _ := randomUUID()
	view := koiFolderView(t, koiFolderRequest(t, a, user, "POST", "/api/koi/skill-imports", koiImportRequest{RequestID: request, SourceKind: "folder", DeclaredPaths: []string{"SKILL.md"}, UpdateFromID: skill.ID, ExpectedRevision: skill.Revision}, 202))
	koiFolderUpload(t, a, user, view.ID, "SKILL.md", content, 200)
	return koiFolderView(t, koiFolderRequest(t, a, user, "POST", "/api/koi/skill-imports/"+view.ID+"/analyze", nil, 200))
}

func TestKoiFolderReplacementPreservesIdentityPinsAndQuota(t *testing.T) {
	a, user, _ := writingTestApp(t)
	a.cfg.KoiSkillTestAccounts = []string{user.AuthUserID}
	enableRepositoryR2Fixture(t, a)
	t.Cleanup(func() {
		if _, err := a.db.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, user.ID); err != nil {
			t.Error(err)
		}
	})
	ctx := context.Background()
	first := koiRuntimeInstall(t, a, user, map[string]string{"SKILL.md": "# Review v1"})
	session := agentTestSession(t, a, user, "review")
	oldTask := agentTestTask(t, a, user, session, model.Document{}, "Review first version")
	koiFolderRequest(t, a, user, "PATCH", "/api/koi/skills/"+first.ID, map[string]any{"expectedRevision": first.Revision, "enabled": false}, 200)
	first.Revision++
	first.Enabled = false
	view := koiTestUpdate(t, a, user, first, "# Review v2\nNew guidance")
	if len(view.Candidates) != 1 || view.Candidates[0].InstalledStatus != "update" || view.Candidates[0].InstalledRevision != first.Revision {
		t.Fatalf("missing replacement target: %+v", view)
	}
	confirmation := koiFolderConfirmation(view)
	installed := koiFolderInstalled(t, koiFolderRequest(t, a, user, "POST", "/api/koi/skill-imports/"+view.ID+"/confirm", confirmation, 200))
	second := installed[0]
	if second.ID != first.ID || second.Enabled || second.Revision != first.Revision+1 || second.VersionID == first.VersionID {
		t.Fatalf("replacement changed identity/state: %+v", second)
	}
	replay := koiFolderInstalled(t, koiFolderRequest(t, a, user, "POST", "/api/koi/skill-imports/"+view.ID+"/confirm", confirmation, 200))
	if replay[0].VersionID != second.VersionID || replay[0].Revision != second.Revision {
		t.Fatal("confirmation replay changed the result")
	}
	pins, err := a.koiTaskSkills(ctx, oldTask)
	if err != nil || len(pins) != 1 || pins[0].VersionID != first.VersionID {
		t.Fatalf("running task lost original package: %+v %v", pins, err)
	}
	disabledTask := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), model.Document{}, "Disabled library")
	pins, err = a.koiTaskSkills(ctx, disabledTask)
	if err != nil || len(pins) != 0 {
		t.Fatalf("replacement re-enabled a disabled skill: %+v %v", pins, err)
	}
	koiFolderRequest(t, a, user, "PATCH", "/api/koi/skills/"+second.ID, map[string]any{"expectedRevision": second.Revision, "enabled": true}, 200)
	second.Revision++
	newTask := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), model.Document{}, "Updated library")
	pins, err = a.koiTaskSkills(ctx, newTask)
	if err != nil || len(pins) != 1 || pins[0].VersionID != second.VersionID {
		t.Fatalf("new task missed new package: %+v %v", pins, err)
	}
	usage, err := a.storageUsageFor(ctx, user.ID)
	if err != nil || usage.KoiSkillBytes != first.SizeBytes+second.SizeBytes {
		t.Fatalf("old task quota missing: %+v %v", usage, err)
	}
	noop := koiTestUpdate(t, a, user, second, "# Review v2\nNew guidance")
	same := koiTestConfirm(t, a, user, noop)
	if same.VersionID != second.VersionID || same.Revision != second.Revision {
		t.Fatal("same-content update wrote a new version")
	}
	// The complete update transaction must roll back when new bytes exceed quota.
	tooLarge := koiTestUpdate(t, a, user, second, "# Review v3\n"+strings.Repeat("guidance ", 100))
	quotaKey := "u/" + user.AuthUserID + "/replacement-quota.png"
	if _, err = a.db.Exec(ctx, `INSERT INTO image_objects(object_key,user_id,bytes) VALUES($1,$2,$3)`, quotaKey, user.ID, a.storageQuotaFor(user)-usage.Total()); err != nil {
		t.Fatal(err)
	}
	koiFolderRequest(t, a, user, "POST", "/api/koi/skill-imports/"+tooLarge.ID+"/confirm", koiFolderConfirmation(tooLarge), 409)
	current, err := a.loadKoiInstallation(ctx, a.db, user.ID, second.ID)
	if err != nil || current.VersionID != second.VersionID || current.Revision != second.Revision {
		t.Fatalf("failed update changed current version: %+v %v", current, err)
	}
	// A stale preview must not overwrite an intervening enable/disable change.
	if _, err = a.db.Exec(ctx, `DELETE FROM image_objects WHERE object_key=$1`, quotaKey); err != nil {
		t.Fatal(err)
	}
	koiFolderRequest(t, a, user, "PATCH", "/api/koi/skills/"+second.ID, map[string]any{"expectedRevision": second.Revision, "enabled": false}, 200)
	koiFolderRequest(t, a, user, "POST", "/api/koi/skill-imports/"+tooLarge.ID+"/confirm", koiFolderConfirmation(tooLarge), 409)
	if _, err = a.db.Exec(ctx, `UPDATE writing_agent_tasks SET status='completed' WHERE id=$1`, oldTask.ID); err != nil {
		t.Fatal(err)
	}
	if err = a.cleanupKoiSkillVersionsForUser(ctx, user.ID); err != nil {
		t.Fatal(err)
	}
	usage, err = a.storageUsageFor(ctx, user.ID)
	if err != nil || usage.KoiSkillBytes != second.SizeBytes {
		t.Fatalf("old version was not reclaimed: %+v %v", usage, err)
	}
}

func TestKoiGitHubInstallAndUpdateStayPinned(t *testing.T) {
	a, user, _ := writingTestApp(t)
	a.cfg.KoiSkillTestAccounts = []string{user.AuthUserID}
	sha1, sha2 := strings.Repeat("a", 40), strings.Repeat("b", 40)
	current := sha1
	repositoryID := 123
	contents := map[string]string{sha1: "# Review v1", sha2: "# Review v2\nUpdated instructions"}
	archives := map[string][]byte{}
	for sha, content := range contents {
		archives[sha] = githubArchive(t, githubArchiveEntry{"root/review/SKILL.md", content, 0})
	}
	a.githubHTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		response := &http.Response{StatusCode: 200, Header: make(http.Header), Request: r}
		var data []byte
		switch {
		case r.URL.Host == githubCodeLoadHost:
			sha := strings.TrimPrefix(r.URL.Path, "/Octo/demo/zip/")
			data = archives[sha]
			if len(data) == 0 {
				t.Errorf("archive is not pinned: %s", r.URL)
			}
		case r.URL.Path == "/repos/octo/demo" || r.URL.Path == "/repos/Octo/demo":
			data = []byte(fmt.Sprintf(`{"id":%d,"name":"demo","full_name":"Octo/demo","owner":{"login":"Octo"},"default_branch":"main","private":false}`, repositoryID))
		case strings.HasPrefix(r.URL.Path, "/repos/Octo/demo/commits/"):
			sha := strings.TrimPrefix(r.URL.Path, "/repos/Octo/demo/commits/")
			if sha == "main" {
				sha = current
			}
			data = []byte(sha)
		default:
			t.Errorf("unexpected upstream request: %s", r.URL)
			response.StatusCode = 404
		}
		response.Body = io.NopCloser(bytes.NewReader(data))
		return response, nil
	})}
	request, _ := randomUUID()
	input := koiImportRequest{RequestID: request, SourceKind: "github", RepositoryURL: "https://github.com/octo/demo", Path: "review"}
	preview := koiFolderView(t, koiFolderRequest(t, a, user, "POST", "/api/koi/skill-imports", input, 202))
	current = sha2 // The default branch moves between preview and confirmation.
	first := koiTestConfirm(t, a, user, preview)
	if first.Source["commitSha"] != sha1 || first.Source["path"] != "review" {
		t.Fatalf("installation followed moving branch: %+v", first.Source)
	}
	koiFolderRequest(t, a, user, "PATCH", "/api/koi/skills/"+first.ID, map[string]any{"expectedRevision": first.Revision, "enabled": false}, 200)
	var update struct {
		Status  string             `json:"status"`
		Preview koiSkillImportView `json:"preview"`
	}
	w := koiFolderRequest(t, a, user, "POST", "/api/koi/skills/"+first.ID+"/check-update", nil, 200)
	if err := json.Unmarshal(w.Body.Bytes(), &update); err != nil {
		t.Fatal(err)
	}
	if update.Status != "update_available" || update.Preview.Candidates[0].InstalledID != first.ID {
		t.Fatalf("update target missing: %s", w.Body.String())
	}
	current = sha1
	second := koiTestConfirm(t, a, user, update.Preview)
	if second.ID != first.ID || second.Enabled || second.Source["commitSha"] != sha2 {
		t.Fatalf("update did not use reviewed version: %+v", second)
	}
	request, _ = randomUUID()
	input.RequestID = request
	current = sha2
	duplicate := koiTestConfirm(t, a, user, koiFolderView(t, koiFolderRequest(t, a, user, "POST", "/api/koi/skill-imports", input, 202)))
	if duplicate.ID != second.ID || duplicate.Revision != second.Revision || duplicate.Enabled {
		t.Fatal("duplicate installation changed state")
	}
	repositoryID = 456
	koiFolderRequest(t, a, user, "POST", "/api/koi/skills/"+first.ID+"/check-update", nil, 409)
	// Invalid links are actionable input errors rather than server faults.
	request, _ = randomUUID()
	input.RequestID = request
	input.RepositoryURL = "https://example.com/demo"
	koiFolderRequest(t, a, user, "POST", "/api/koi/skill-imports", input, 400)
}

func TestKoiHubInstallChecksPublicationAndKeepsPrivateCopy(t *testing.T) {
	ctx := context.Background()
	a, owner, workspace, _ := koiHubSourceTestApp(t, true, map[string]string{"review/SKILL.md": "# Published review"})
	user := seedMCPUser(t, a.db, a, membershipTierLifetime)
	t.Cleanup(func() {
		if _, err := a.db.Exec(context.Background(), `DELETE FROM users WHERE id=ANY($1)`, []int{user.ID, owner}); err != nil {
			t.Error(err)
		}
	})
	a.cfg.KoiSkillTestAccounts = []string{user.AuthUserID}
	publication, err := a.loadPublicAgentRepository(ctx, workspace.WorkspaceID, nil)
	if err != nil {
		t.Fatal(err)
	}
	create := func() koiSkillImportView {
		t.Helper()
		request, _ := randomUUID()
		return koiFolderView(t, koiFolderRequest(t, a, user, "POST", "/api/koi/skill-imports", koiImportRequest{RequestID: request, SourceKind: "hub", WorkspaceID: workspace.WorkspaceID, PublicationID: publication.PublicationID, Revision: &publication.Revision}, 202))
	}
	stale := create()
	if err = a.setAgentRepositoryPublication(ctx, owner, workspace.WorkspaceID, workspace.Revision, "Apache-2.0", false); err != nil {
		t.Fatal(err)
	}
	koiFolderRequest(t, a, user, "POST", "/api/koi/skill-imports/"+stale.ID+"/confirm", koiFolderConfirmation(stale), 409)
	publication, err = a.loadPublicAgentRepository(ctx, workspace.WorkspaceID, nil)
	if err != nil {
		t.Fatal(err)
	}
	ready := create()
	// Private edits remain private until publication, including at confirmation.
	updated, err := a.patchAgentWorkspace(ctx, owner, workspace.WorkspaceID, workspace.Revision, []agentWorkspaceFile{repositoryTestFile("review/SKILL.md", "# Private review")}, nil)
	if err != nil {
		t.Fatal(err)
	}
	first := koiTestConfirm(t, a, user, ready)
	if first.Source["path"] != "review" {
		t.Fatalf("wrong Hub package identity: %+v", first.Source)
	}
	if err = a.setAgentRepositoryPublication(ctx, owner, workspace.WorkspaceID, updated.Revision, "Apache-2.0", false); err != nil {
		t.Fatal(err)
	}
	var update struct {
		Status  string             `json:"status"`
		Preview koiSkillImportView `json:"preview"`
	}
	w := koiFolderRequest(t, a, user, "POST", "/api/koi/skills/"+first.ID+"/check-update", nil, 200)
	if err = json.Unmarshal(w.Body.Bytes(), &update); err != nil {
		t.Fatal(err)
	}
	if update.Status != "update_available" {
		t.Fatalf("Hub update missing: %s", w.Body.String())
	}
	second := koiTestConfirm(t, a, user, update.Preview)
	if first.ID != second.ID || first.VersionID == second.VersionID {
		t.Fatal("Hub update created another installation")
	}
	if err = a.setAgentRepositoryPublication(ctx, owner, workspace.WorkspaceID, updated.Revision, "", true); err != nil {
		t.Fatal(err)
	}
	w = koiFolderRequest(t, a, user, "POST", "/api/koi/skills/"+first.ID+"/check-update", nil, 200)
	if !strings.Contains(w.Body.String(), "source_unavailable") {
		t.Fatalf("withdrawn source was not explained: %s", w.Body.String())
	}
	detail := koiFolderRequest(t, a, user, "GET", "/api/koi/skills/"+first.ID, nil, 200)
	if !strings.Contains(detail.Body.String(), "# Private review") {
		t.Fatal("withdrawal broke the installed private copy")
	}
}
