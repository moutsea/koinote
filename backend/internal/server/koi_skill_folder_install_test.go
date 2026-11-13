package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"net/url"
	"sort"
	"strings"
	"sync"
	"testing"

	"koinote/backend/internal/config"
	"koinote/backend/internal/model"
)

func koiFolderRequest(t *testing.T, a *App, user model.User, method, path string, input any, status int) *httptest.ResponseRecorder {
	t.Helper()
	w := writingTestRequest(t, a, user, method, path, input)
	if w.Code != status {
		t.Fatalf("%s %s: %d %s (want %d)", method, path, w.Code, w.Body.String(), status)
	}
	return w
}

func koiFolderView(t *testing.T, w *httptest.ResponseRecorder) koiSkillImportView {
	t.Helper()
	var body struct {
		Preview koiSkillImportView `json:"preview"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	return body.Preview
}

func koiFolderCreate(t *testing.T, a *App, user model.User, files map[string]string) koiSkillImportView {
	t.Helper()
	paths := []string{}
	for path := range files {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	id, _ := randomUUID()
	w := koiFolderRequest(t, a, user, "POST", "/api/koi/skill-imports", koiImportRequest{RequestID: id, SourceKind: "folder", DeclaredPaths: paths, DirectoryName: "skills"}, 202)
	return koiFolderView(t, w)
}

func koiFolderUpload(t *testing.T, a *App, user model.User, id, path, content string, status int) {
	t.Helper()
	koiFolderRequest(t, a, user, "PUT", "/api/koi/skill-imports/"+id+"/files?path="+url.QueryEscape(path), map[string]string{"contentBase64": base64.StdEncoding.EncodeToString([]byte(content))}, status)
}

func koiFolderPreview(t *testing.T, a *App, user model.User, files map[string]string) koiSkillImportView {
	t.Helper()
	view := koiFolderCreate(t, a, user, files)
	for path, content := range files {
		koiFolderUpload(t, a, user, view.ID, path, content, 200)
	}
	view = koiFolderView(t, koiFolderRequest(t, a, user, "POST", "/api/koi/skill-imports/"+view.ID+"/analyze", nil, 200))
	if view.Status != "ready" {
		t.Fatalf("folder analysis: %+v", view)
	}
	return view
}

func koiFolderConfirmation(view koiSkillImportView) koiImportConfirmation {
	id, _ := randomUUID()
	input := koiImportConfirmation{RequestID: id, PreviewRevision: view.Revision}
	for _, candidate := range view.Candidates {
		input.CandidateIDs = append(input.CandidateIDs, candidate.ID)
	}
	return input
}

func koiFolderInstalled(t *testing.T, w *httptest.ResponseRecorder) []koiSkillInstallation {
	t.Helper()
	var body struct {
		Installed []koiSkillInstallation `json:"installed"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	return body.Installed
}

func TestKoiFolderInstallR2LifecycleAndConcurrentConfirmation(t *testing.T) {
	a, user, doc := writingTestApp(t)
	a.cfg.KoiSkillTestAccounts = []string{user.AuthUserID}
	enableRepositoryR2Fixture(t, a)
	ctx := context.Background()
	files := map[string]string{"review/SKILL.md": "---\nname: review\ndescription: Review the note\n---\nRead guide.md.", "review/guide.md": "Review structure.", "other/SKILL.md": "# Other\nImprove the wording."}
	view := koiFolderPreview(t, a, user, files)
	if len(view.Candidates) != 2 {
		t.Fatalf("candidates: %+v", view.Candidates)
	}
	input := koiFolderConfirmation(view)
	for _, candidate := range view.Candidates {
		if candidate.Name == "review" {
			input.CandidateIDs = []string{candidate.ID}
		}
	}
	path := "/api/koi/skill-imports/" + view.ID + "/confirm"
	var wg sync.WaitGroup
	responses := make(chan *httptest.ResponseRecorder, 3)
	for range 3 {
		wg.Add(1)
		go func() { defer wg.Done(); responses <- writingTestRequest(t, a, user, "POST", path, input) }()
	}
	wg.Wait()
	close(responses)
	var skill koiSkillInstallation
	for response := range responses {
		if response.Code != 200 {
			t.Fatalf("concurrent confirmation: %d %s", response.Code, response.Body.String())
		}
		installed := koiFolderInstalled(t, response)
		if len(installed) != 1 || (skill.ID != "" && skill.ID != installed[0].ID) {
			t.Fatalf("duplicate result: %+v", installed)
		}
		skill = installed[0]
	}
	var count int
	if err := a.db.QueryRow(ctx, `SELECT count(*) FROM koi_skill_installations WHERE user_id=$1`, user.ID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("install count %d: %v", count, err)
	}
	usage, err := a.storageUsageFor(ctx, user.ID)
	wantBytes := int64(len(files["review/SKILL.md"]) + len(files["review/guide.md"]))
	if err != nil || usage.KoiSkillBytes != wantBytes {
		t.Fatalf("quota counted wrong package: %+v %v", usage, err)
	}
	detail := koiFolderRequest(t, a, user, "GET", "/api/koi/skills/"+skill.ID, nil, 200)
	if strings.Contains(detail.Body.String(), "objects/") || !strings.Contains(detail.Body.String(), "Read guide.md.") {
		t.Fatalf("R2 detail: %s", detail.Body.String())
	}
	file := koiFolderRequest(t, a, user, "GET", "/api/koi/skills/"+skill.ID+"/files/1", nil, 200)
	if !strings.Contains(file.Body.String(), "contentBase64") || strings.Contains(file.Body.String(), "objects/") {
		t.Fatalf("private file: %s", file.Body.String())
	}
	list := koiFolderRequest(t, a, user, "GET", "/api/koi/skills", nil, 200)
	if !strings.Contains(list.Body.String(), skill.ID) {
		t.Fatal("installed package missing from list")
	}
	// Confirmation only stores the selected package; staged preview bytes are gone.
	view = koiFolderView(t, koiFolderRequest(t, a, user, "GET", "/api/koi/skill-imports/"+view.ID, nil, 200))
	if view.Status != "committed" || view.UploadedFiles != 0 || len(view.Candidates) != 0 || len(view.Installed) != 1 {
		t.Fatalf("receipt: %+v", view)
	}
	changed := input
	changed.RequestID, _ = randomUUID()
	koiFolderRequest(t, a, user, "POST", path, changed, 409)

	// Another preview of identical bytes keeps the installation and its disabled state.
	if _, err := a.db.Exec(ctx, `UPDATE koi_skill_installations SET enabled=false WHERE id=$1`, skill.ID); err != nil {
		t.Fatal(err)
	}
	repeat := koiFolderPreview(t, a, user, map[string]string{"SKILL.md": files["review/SKILL.md"], "guide.md": files["review/guide.md"]})
	installed := koiFolderInstalled(t, koiFolderRequest(t, a, user, "POST", "/api/koi/skill-imports/"+repeat.ID+"/confirm", koiFolderConfirmation(repeat), 200))
	if len(installed) != 1 || installed[0].ID != skill.ID || installed[0].Enabled {
		t.Fatalf("reimport changed identity or switch: %+v", installed)
	}

	// Uninstall releases the library entry, but a task reference keeps the files.
	task := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), doc, "Review the note")
	if _, err := a.db.Exec(ctx, `INSERT INTO agent_task_skill_versions(task_id,version_id) VALUES($1,$2)`, task.ID, skill.VersionID); err != nil {
		t.Fatal(err)
	}
	uninstall := fmt.Sprintf("/api/koi/skills/%s?expectedRevision=%d", skill.ID, skill.Revision)
	koiFolderRequest(t, a, user, "DELETE", fmt.Sprintf("/api/koi/skills/%s?expectedRevision=99", skill.ID), nil, 409)
	for range 2 {
		response := koiFolderRequest(t, a, user, "DELETE", uninstall, nil, 200)
		if !strings.Contains(response.Body.String(), fmt.Sprintf(`"retainedBytes":%d`, wantBytes)) {
			t.Fatalf("lost pinned bytes: %s", response.Body.String())
		}
	}
	if err := a.cleanupKoiSkillVersions(ctx); err != nil {
		t.Fatal(err)
	}
	if err := a.db.QueryRow(ctx, `SELECT count(*) FROM koi_skill_versions WHERE id=$1`, skill.VersionID).Scan(&count); err != nil || count != 1 {
		t.Fatalf("live version removed: %d %v", count, err)
	}
	if err := a.finishWritingTask(ctx, task, "completed", "", json.RawMessage(`{"totalTokens":0}`), "done"); err != nil {
		t.Fatal(err)
	}
	if err := a.cleanupKoiSkillVersions(ctx); err != nil {
		t.Fatal(err)
	}
	if err := a.db.QueryRow(ctx, `SELECT count(*) FROM koi_skill_versions WHERE id=$1`, skill.VersionID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("unreferenced version retained: %d %v", count, err)
	}
	var retained bool
	if err := a.db.QueryRow(ctx, `SELECT bool_and(committed AND delete_after>now()+interval '400 days') FROM agent_repository_objects WHERE committed`).Scan(&retained); err != nil || !retained {
		t.Fatalf("backup retention lost: %v %v", retained, err)
	}
	usage, err = a.storageUsageFor(ctx, user.ID)
	if err != nil || usage.KoiSkillBytes != 0 {
		t.Fatalf("uninstalled bytes still charged: %+v %v", usage, err)
	}
}

func TestKoiFolderInstallQuotaRollsBackEntireBatch(t *testing.T) {
	a := New(config.Config{SessionSecret: "folder-quota"}, newGCTestPool(t))
	enableRepositoryR2Fixture(t, a)
	user := seedMCPUser(t, a.db, a, membershipTierLifetime)
	a.cfg.KoiSkillTestAccounts = []string{user.AuthUserID}
	view := koiFolderPreview(t, a, user, map[string]string{"one/SKILL.md": "# One\nRead the note.", "two/SKILL.md": "# Two\nReview wording."})
	if len(view.Candidates) != 2 {
		t.Fatalf("candidates: %+v", view.Candidates)
	}
	var size int64
	for _, candidate := range view.Candidates {
		size += candidate.SizeBytes
	}
	ctx := context.Background()
	key := "u/" + user.AuthUserID + "/quota.png"
	if _, err := a.db.Exec(ctx, `INSERT INTO image_objects(object_key,user_id,bytes) VALUES($1,$2,$3)`, key, user.ID, a.storageQuotaFor(user)-size+1); err != nil {
		t.Fatal(err)
	}
	input := koiFolderConfirmation(view)
	path := "/api/koi/skill-imports/" + view.ID + "/confirm"
	response := koiFolderRequest(t, a, user, "POST", path, input, 409)
	if !strings.Contains(response.Body.String(), "storage_quota_exceeded") {
		t.Fatal(response.Body.String())
	}
	var count int
	if err := a.db.QueryRow(ctx, `SELECT count(*) FROM koi_skill_installations WHERE user_id=$1`, user.ID).Scan(&count); err != nil || count != 0 {
		t.Fatalf("partial installation survived: %d %v", count, err)
	}
	current := koiFolderView(t, koiFolderRequest(t, a, user, "GET", "/api/koi/skill-imports/"+view.ID, nil, 200))
	if current.Status != "ready" || current.UploadedFiles != 2 {
		t.Fatalf("quota failure consumed preview: %+v", current)
	}
	if _, err := a.db.Exec(ctx, `UPDATE image_objects SET bytes=bytes-1 WHERE object_key=$1`, key); err != nil {
		t.Fatal(err)
	}
	installed := koiFolderInstalled(t, koiFolderRequest(t, a, user, "POST", path, input, 200))
	if len(installed) != 2 {
		t.Fatalf("retry did not install the full selection: %+v", installed)
	}
	usage, err := a.storageUsageFor(ctx, user.ID)
	if err != nil || usage.Total() != a.storageQuotaFor(user) || usage.KoiSkillBytes != size {
		t.Fatalf("exact quota boundary: %+v %v", usage, err)
	}
}

func TestKoiFolderInstallAccessRecoveryAndPreviewCleanup(t *testing.T) {
	a := New(config.Config{SessionSecret: "folder-access"}, newGCTestPool(t))
	user := seedMCPUser(t, a.db, a, membershipTierLifetime)
	other := seedMCPUser(t, a.db, a, membershipTierLifetime)
	free := seedMCPUser(t, a.db, a, "free")
	koiFolderRequest(t, a, user, "GET", "/api/koi/skills", nil, 403)
	a.cfg.KoiSkillTestAccounts = []string{user.AuthUserID, other.AuthUserID, free.AuthUserID}
	for _, source := range []string{"github", "hub", "migration"} {
		id, _ := randomUUID()
		koiFolderRequest(t, a, user, "POST", "/api/koi/skill-imports", koiImportRequest{RequestID: id, SourceKind: source, DeclaredPaths: []string{"SKILL.md"}}, 400)
	}
	files := map[string]string{"SKILL.md": "# Review\nRead guide.md.", "guide.md": "Review the note."}
	view := koiFolderCreate(t, a, user, files)
	root := "/api/koi/skill-imports/" + view.ID
	for _, method := range []string{"GET", "DELETE"} {
		koiFolderRequest(t, a, other, method, root, nil, 404)
	}
	koiFolderUpload(t, a, other, view.ID, "SKILL.md", files["SKILL.md"], 404)
	koiFolderUpload(t, a, other, view.ID, "SKILL.md", strings.Repeat("x", koiSkillFileBytes+1), 404)
	koiFolderRequest(t, a, other, "POST", root+"/analyze", nil, 404)
	foreignInput := koiFolderConfirmation(view)
	foreignInput.CandidateIDs = []string{"not-owned"}
	koiFolderRequest(t, a, other, "POST", root+"/confirm", foreignInput, 404)
	id, _ := randomUUID()
	koiFolderRequest(t, a, free, "POST", "/api/koi/skill-imports", koiImportRequest{RequestID: id, SourceKind: "folder", DeclaredPaths: []string{"SKILL.md"}}, 403)
	koiFolderUpload(t, a, user, view.ID, "../SKILL.md", "x", 400)
	koiFolderUpload(t, a, user, view.ID, "undeclared.md", "x", 400)
	koiFolderUpload(t, a, user, view.ID, "guide.md", strings.Repeat("x", koiSkillFileBytes+1), 413)
	koiFolderUpload(t, a, user, view.ID, "guide.md", "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----", 422)
	koiFolderRequest(t, a, user, "POST", root+"/analyze", nil, 400)
	koiFolderUpload(t, a, user, view.ID, "SKILL.md", files["SKILL.md"], 200)
	failed := koiFolderView(t, koiFolderRequest(t, a, user, "POST", root+"/analyze", nil, 200))
	if failed.Status != "failed" || failed.RejectedFiles != 1 || len(failed.Rejected) != 1 || failed.Rejected[0].Reason != "sensitive_data_detected" {
		t.Fatalf("rejected upload lost its reason: %+v", failed)
	}
	koiFolderUpload(t, a, user, view.ID, "guide.md", files["guide.md"], 200)
	view = koiFolderView(t, koiFolderRequest(t, a, user, "POST", root+"/analyze", nil, 200))
	if view.Status != "ready" {
		t.Fatalf("missing upload was not recoverable: %+v", view)
	}
	koiFolderUpload(t, a, user, view.ID, "SKILL.md", "# Changed", 409)
	input := koiFolderConfirmation(view)
	input.PreviewRevision--
	koiFolderRequest(t, a, user, "POST", root+"/confirm", input, 409)
	// Members can remove previews and installed data even after losing membership.
	if _, err := a.db.Exec(context.Background(), `UPDATE users SET membership_tier='free' WHERE id=$1`, user.ID); err != nil {
		t.Fatal(err)
	}
	koiFolderRequest(t, a, user, "DELETE", root, nil, 200)
	koiFolderRequest(t, a, user, "DELETE", root, nil, 200)
	view = koiFolderView(t, koiFolderRequest(t, a, user, "GET", root, nil, 200))
	if view.Status != "cancelled" || view.UploadedFiles != 0 || len(view.Candidates) != 0 {
		t.Fatalf("cancelled preview retained content: %+v", view)
	}

	// Validation failures are editable, and expiry clears both bytes and instructions.
	bad := koiFolderCreate(t, a, other, map[string]string{"SKILL.md": ""})
	koiFolderUpload(t, a, other, bad.ID, "SKILL.md", "", 200)
	bad = koiFolderView(t, koiFolderRequest(t, a, other, "POST", "/api/koi/skill-imports/"+bad.ID+"/analyze", nil, 200))
	if bad.Status != "failed" {
		t.Fatalf("empty skill accepted: %+v", bad)
	}
	koiFolderUpload(t, a, other, bad.ID, "SKILL.md", "# Fixed\nRead the note.", 200)
	bad = koiFolderView(t, koiFolderRequest(t, a, other, "POST", "/api/koi/skill-imports/"+bad.ID+"/analyze", nil, 200))
	if bad.Status != "ready" {
		t.Fatalf("failed analysis cannot be retried: %+v", bad)
	}
	if _, err := a.db.Exec(context.Background(), `UPDATE koi_skill_imports SET expires_at=now()-interval '1 second' WHERE id=$1`, bad.ID); err != nil {
		t.Fatal(err)
	}
	koiFolderRequest(t, a, other, "POST", "/api/koi/skill-imports/"+bad.ID+"/confirm", koiFolderConfirmation(bad), 410)
	if err := a.cleanupKoiSkillImports(context.Background()); err != nil {
		t.Fatal(err)
	}
	bad = koiFolderView(t, koiFolderRequest(t, a, other, "GET", "/api/koi/skill-imports/"+bad.ID, nil, 200))
	if bad.Status != "expired" || bad.UploadedFiles != 0 || len(bad.Candidates) != 0 {
		t.Fatalf("expired preview retained content: %+v", bad)
	}
}

func TestKoiFolderInstallIdempotencyAndAccountIsolation(t *testing.T) {
	a := New(config.Config{SessionSecret: "folder-isolation"}, newGCTestPool(t))
	user := seedMCPUser(t, a.db, a, membershipTierLifetime)
	other := seedMCPUser(t, a.db, a, membershipTierLifetime)
	a.cfg.KoiSkillTestAccounts = []string{user.AuthUserID, other.AuthUserID}
	id, _ := randomUUID()
	input := koiImportRequest{RequestID: id, SourceKind: "folder", DeclaredPaths: []string{"two/SKILL.md", "one/SKILL.md"}, DirectoryName: "skills"}
	var wg sync.WaitGroup
	responses := make(chan *httptest.ResponseRecorder, 3)
	for range 3 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			// Each handler canonicalizes its own decoded copy of the input.
			responses <- writingTestRequest(t, a, user, "POST", "/api/koi/skill-imports", input)
		}()
	}
	wg.Wait()
	close(responses)
	var view koiSkillImportView
	for response := range responses {
		if response.Code != 202 {
			t.Fatalf("concurrent preview creation: %d %s", response.Code, response.Body.String())
		}
		next := koiFolderView(t, response)
		if view.ID != "" && view.ID != next.ID {
			t.Fatal("creation retry produced another preview")
		}
		view = next
	}
	input.DeclaredPaths = []string{"one/SKILL.md", "two/SKILL.md"}
	if replay := koiFolderView(t, koiFolderRequest(t, a, user, "POST", "/api/koi/skill-imports", input, 202)); replay.ID != view.ID {
		t.Fatal("path order changed idempotent identity")
	}
	input.DirectoryName = "changed"
	koiFolderRequest(t, a, user, "POST", "/api/koi/skill-imports", input, 409)
	for _, path := range input.DeclaredPaths {
		koiFolderUpload(t, a, user, view.ID, path, "# Review\nRead the note.", 200)
	}
	root := "/api/koi/skill-imports/" + view.ID
	view = koiFolderView(t, koiFolderRequest(t, a, user, "POST", root+"/analyze", nil, 200))
	if len(view.Candidates) != 1 {
		t.Fatalf("identical folder packages should also be grouped in the preview: %+v", view.Candidates)
	}
	installed := koiFolderInstalled(t, koiFolderRequest(t, a, user, "POST", root+"/confirm", koiFolderConfirmation(view), 200))
	if len(installed) != 1 {
		t.Fatalf("identical packages installed twice: %+v", installed)
	}
	skill := installed[0]
	skillPath := "/api/koi/skills/" + skill.ID
	koiFolderRequest(t, a, other, "GET", skillPath, nil, 404)
	koiFolderRequest(t, a, other, "GET", skillPath+"/files/1?version="+skill.VersionID, nil, 404)
	koiFolderRequest(t, a, other, "DELETE", skillPath+"?expectedRevision=1", nil, 404)
	if list := koiFolderRequest(t, a, other, "GET", "/api/koi/skills", nil, 200); strings.Contains(list.Body.String(), skill.ID) {
		t.Fatal("another account can list private skills")
	}
	// Database mode is also readable, and membership loss must not trap data.
	if _, err := a.db.Exec(context.Background(), `UPDATE users SET membership_tier='free' WHERE id=$1`, user.ID); err != nil {
		t.Fatal(err)
	}
	detail := koiFolderRequest(t, a, user, "GET", skillPath, nil, 200)
	if !strings.Contains(detail.Body.String(), "Read the note.") {
		t.Fatal("inline instructions are not readable")
	}
	koiFolderRequest(t, a, user, "DELETE", skillPath+"?expectedRevision=1", nil, 200)
	koiFolderRequest(t, a, user, "GET", skillPath, nil, 404)
	usage, err := a.storageUsageFor(context.Background(), user.ID)
	if err != nil || usage.KoiSkillBytes != 0 {
		t.Fatalf("uninstall did not release quota immediately: %+v %v", usage, err)
	}
}

func TestKoiFolderInstallRejectedFilesPreserveCandidateBoundaries(t *testing.T) {
	a := New(config.Config{SessionSecret: "folder-rejected-files"}, newGCTestPool(t))
	objects := enableRepositoryR2Fixture(t, a)
	user := seedMCPUser(t, a.db, a, membershipTierLifetime)
	a.cfg.KoiSkillTestAccounts = []string{user.AuthUserID}
	files := map[string]string{
		"SKILL.md":             "# Parent\nReview the note using guide.md.",
		"guide.md":             "Check the structure.",
		"good/SKILL.md":        "# Good\nImprove wording.",
		"bad/SKILL.md":         strings.Repeat("x", 1<<20), // Exceeds the HTTP body limit too.
		"bad/guide.md":         "Must not be folded into the parent Skill.",
		"large/SKILL.md":       "# Large\nRead reference.txt.",
		"large/reference.txt":  strings.Repeat("x", koiSkillFileBytes+1),
		"secret/SKILL.md":      "# Secret\nRead reference.txt.",
		"secret/reference.txt": "-----BEGIN PRIVATE KEY-----\nprivate-value\n-----END PRIVATE KEY-----",
	}
	view := koiFolderCreate(t, a, user, files)
	for path, content := range files {
		status := 200
		switch path {
		case "bad/SKILL.md", "large/reference.txt":
			status = 413
		case "secret/reference.txt":
			// A rejected replacement must remove the previously accepted bytes.
			koiFolderUpload(t, a, user, view.ID, path, "Old safe content.", 200)
			status = 422
		}
		koiFolderUpload(t, a, user, view.ID, path, content, status)
	}
	root := "/api/koi/skill-imports/" + view.ID
	view = koiFolderView(t, koiFolderRequest(t, a, user, "POST", root+"/analyze", nil, 200))
	if view.Status != "ready" || len(view.Candidates) != 2 || len(view.Rejected) != 3 || view.UploadedFiles != 6 || view.RejectedFiles != 3 {
		t.Fatalf("rejected uploads blocked valid siblings: %+v", view)
	}
	wantRejected := map[string]string{"bad": "file_too_large", "large": "file_too_large", "secret": "sensitive_data_detected"}
	for _, rejected := range view.Rejected {
		if rejected.Reason != wantRejected[rejected.Directory] || len(rejected.Details) != 1 || !strings.Contains(rejected.Details[0], rejected.Directory+"/") {
			t.Fatalf("missing file rejection detail: %+v", rejected)
		}
		delete(wantRejected, rejected.Directory)
	}
	if len(wantRejected) != 0 {
		t.Fatalf("missing rejected Skills: %+v", wantRejected)
	}
	// Validation errors must not mutate a preview that is already frozen.
	koiFolderUpload(t, a, user, view.ID, "SKILL.md", strings.Repeat("x", 1<<20), 409)
	ctx := context.Background()
	var errors, contents, hashes, sizes int
	if err := a.db.QueryRow(ctx, `SELECT count(*),count(content),count(sha256),count(size_bytes)
 FROM koi_skill_import_files WHERE import_id=$1 AND error_code<>''`, view.ID).Scan(&errors, &contents, &hashes, &sizes); err != nil || errors != 3 || contents+hashes+sizes != 0 {
		t.Fatalf("rejected bytes retained: %d %d %d %d %v", errors, contents, hashes, sizes, err)
	}
	invalid := koiFolderConfirmation(view)
	invalid.CandidateIDs = append(invalid.CandidateIDs, "sk-not-offered")
	koiFolderRequest(t, a, user, "POST", root+"/confirm", invalid, 409)
	installed := koiFolderInstalled(t, koiFolderRequest(t, a, user, "POST", root+"/confirm", koiFolderConfirmation(view), 200))
	if len(installed) != 2 {
		t.Fatalf("valid selection did not commit: %+v", installed)
	}
	wantBytes := int64(len(files["SKILL.md"]) + len(files["guide.md"]) + len(files["good/SKILL.md"]))
	usage, err := a.storageUsageFor(ctx, user.ID)
	if err != nil || usage.KoiSkillBytes != wantBytes {
		t.Fatalf("rejected files entered installed packages or quota: %+v %v", usage, err)
	}
	objects.mu.Lock()
	puts := objects.puts
	objects.mu.Unlock()
	if puts != 3 {
		t.Fatalf("unselected or rejected files reached R2: %d uploads", puts)
	}
	view = koiFolderView(t, koiFolderRequest(t, a, user, "GET", root, nil, 200))
	if view.Status != "committed" || view.UploadedFiles != 0 || view.RejectedFiles != 0 {
		t.Fatalf("confirmation retained preview members: %+v", view)
	}
}

func TestKoiFolderInstallRejectedNoticesAndCleanup(t *testing.T) {
	for _, action := range []string{"cancelled", "expired"} {
		t.Run(action, func(t *testing.T) {
			a := New(config.Config{SessionSecret: "folder-rejected-notice"}, newGCTestPool(t))
			user := seedMCPUser(t, a.db, a, membershipTierLifetime)
			a.cfg.KoiSkillTestAccounts = []string{user.AuthUserID}
			files := map[string]string{
				"shared/LICENSE":      "-----BEGIN PRIVATE KEY-----\nprivate-value\n-----END PRIVATE KEY-----",
				"shared/one/SKILL.md": "# One\nReview the note.",
				"shared/two/SKILL.md": "# Two\nCheck wording.",
				"other/SKILL.md":      "# Other\nRead the note.",
			}
			view := koiFolderCreate(t, a, user, files)
			for path, content := range files {
				status := 200
				if path == "shared/LICENSE" {
					status = 422
				}
				koiFolderUpload(t, a, user, view.ID, path, content, status)
			}
			root := "/api/koi/skill-imports/" + view.ID
			view = koiFolderView(t, koiFolderRequest(t, a, user, "POST", root+"/analyze", nil, 200))
			if view.Status != "ready" || len(view.Candidates) != 1 || view.Candidates[0].Directory != "other" || len(view.Rejected) != 2 {
				t.Fatalf("inherited rejected notice was dropped: %+v", view)
			}
			for _, rejected := range view.Rejected {
				if rejected.Reason != "sensitive_data_detected" || len(rejected.Details) != 1 || rejected.Details[0] != "sensitive_data_detected:shared/LICENSE" {
					t.Fatalf("missing inherited rejection: %+v", rejected)
				}
			}
			ctx := context.Background()
			if action == "cancelled" {
				koiFolderRequest(t, a, user, "DELETE", root, nil, 200)
			} else {
				if _, err := a.db.Exec(ctx, `UPDATE koi_skill_imports SET expires_at=now()-interval '1 second' WHERE id=$1`, view.ID); err != nil {
					t.Fatal(err)
				}
				if err := a.cleanupKoiSkillImports(ctx); err != nil {
					t.Fatal(err)
				}
			}
			view = koiFolderView(t, koiFolderRequest(t, a, user, "GET", root, nil, 200))
			if view.Status != action || view.UploadedFiles != 0 || view.RejectedFiles != 0 || len(view.Rejected) != 0 || len(view.Candidates) != 0 {
				t.Fatalf("preview retained rejected members after %s: %+v", action, view)
			}
		})
	}
}
