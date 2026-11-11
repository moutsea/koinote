package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	"koinote/backend/internal/config"
)

func koiQuotaTestVersion(t *testing.T, a *App, userID int, installation, content string) string {
	t.Helper()
	version, err := randomUUID()
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := a.db.Exec(ctx, `INSERT INTO koi_skill_installations(id,user_id,source_key,source_kind,source,name)
 VALUES($1::uuid,$2,$1::text,'folder','{}','review') ON CONFLICT(id) DO NOTHING`, installation, userID); err != nil {
		t.Fatal(err)
	}
	digest := koiDigest([]byte(content))
	if _, err := a.db.Exec(ctx, `INSERT INTO koi_skill_versions(id,installation_id,user_id,content_sha256,entry_path,name,file_count,size_bytes,compatibility)
 VALUES($1,$2,$3,$4,'SKILL.md','review',1,$5,'{}')`, version, installation, userID, digest, len(content)); err != nil {
		t.Fatal(err)
	}
	if _, err := a.db.Exec(ctx, `INSERT INTO koi_skill_version_files(version_id,position,path,sha256,size_bytes,content)
 VALUES($1,1,'SKILL.md',$2,$3,$4)`, version, digest, len(content), []byte(content)); err != nil {
		t.Fatal(err)
	}
	return version
}

func TestKoiSkillQuotaCountsCurrentAndPinnedVersionsOnce(t *testing.T) {
	a, user, doc := writingTestApp(t)
	ctx := context.Background()
	installation, _ := randomUUID()
	first := koiQuotaTestVersion(t, a, user.ID, installation, "# First version")
	second := koiQuotaTestVersion(t, a, user.ID, installation, "# Second version")
	_ = koiQuotaTestVersion(t, a, user.ID, installation, "# Unreferenced history")
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := a.db.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	check := func(want int64) {
		t.Helper()
		usage, err := a.storageUsageFor(ctx, user.ID)
		if err != nil || usage.KoiSkillBytes != want {
			t.Fatalf("Skill usage=%d, want %d: %v", usage.KoiSkillBytes, want, err)
		}
	}
	check(0)
	exec(`UPDATE koi_skill_installations SET current_version_id=$2,enabled=false WHERE id=$1`, installation, first)
	check(int64(len("# First version"))) // Disabled packages still occupy storage.
	one := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), doc, "Read the note")
	two := agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), doc, "Review the note")
	exec(`INSERT INTO agent_task_skill_versions(task_id,version_id) VALUES($1,$3),($2,$3)`, one.ID, two.ID, first)
	check(int64(len("# First version"))) // Current + two task refs is one copy.
	exec(`UPDATE koi_skill_installations SET current_version_id=$2 WHERE id=$1`, installation, second)
	check(int64(len("# First version") + len("# Second version")))
	if _, err := a.db.Exec(ctx, `DELETE FROM koi_skill_versions WHERE id=$1`, first); err == nil {
		t.Fatal("task-pinned version was deletable")
	}
	exec(`UPDATE koi_skill_installations SET deleted_at=now() WHERE id=$1`, installation)
	check(int64(len("# First version"))) // Uninstall releases the unpinned current version.
	exec(`UPDATE writing_agent_tasks SET status='completed' WHERE id=$1`, one.ID)
	check(int64(len("# First version")))
	exec(`UPDATE writing_agent_tasks SET status='cancelled' WHERE id=$1`, two.ID)
	check(0) // Terminal task references no longer consume logical quota.
	// User deletion must cascade through both task and version references.
	exec(`DELETE FROM users WHERE id=$1`, user.ID)
	check(0)
}

func TestKoiSkillQuotaAppliesToExistingWritersAndUsageAPI(t *testing.T) {
	ctx := context.Background()
	a := New(config.Config{SessionSecret: "skill-quota", ImageQuotaBytes: 1 << 20}, newGCTestPool(t))
	user := seedMCPUser(t, a.db, a, "free")
	doc, err := a.createDocument(ctx, createDocumentParams{User: user, Title: "Note", Content: "Original"})
	if err != nil {
		t.Fatal(err)
	}
	installation, _ := randomUUID()
	content := strings.Repeat("x", 2048)
	version := koiQuotaTestVersion(t, a, user.ID, installation, content)
	if _, err := a.db.Exec(ctx, `UPDATE koi_skill_installations SET current_version_id=$2 WHERE id=$1`, installation, version); err != nil {
		t.Fatal(err)
	}
	usage, err := a.storageUsageFor(ctx, user.ID)
	if err != nil || usage.KoiSkillBytes != int64(len(content)) || usage.Total() != int64(len(content)+len(doc.Title)+len(doc.Content)) {
		t.Fatalf("wrong account storage: %+v %v", usage, err)
	}
	a.cfg.ImageQuotaBytes = usage.Total()
	response := writingTestRequest(t, a, user, "GET", "/api/storage/usage", nil)
	var reported struct {
		UsedBytes, KoiSkillBytes int64
	}
	if response.Code != 200 || json.Unmarshal(response.Body.Bytes(), &reported) != nil || reported.KoiSkillBytes != usage.KoiSkillBytes || reported.UsedBytes != usage.Total() {
		t.Fatalf("usage API lost Skill storage: %d %s", response.Code, response.Body.String())
	}
	view, err := a.loadAgentWorkspaceStorage(ctx, a.db, user)
	if err != nil || view.PersonalUsedBytes != usage.Total() || view.AvailableBytes != 0 {
		t.Fatalf("repository allocation ignores Skill usage: %+v %v", view, err)
	}
	if _, err := a.allocateAgentWorkspaceStorage(ctx, user, 1); !errors.Is(err, errAgentStorageAllocationFull) {
		t.Fatalf("repository expansion bypassed Skill quota: %v", err)
	}
	create := createDocumentParams{User: user, Title: "New", Content: "x"}
	if _, err := a.createDocument(ctx, create); !errors.Is(err, errDocumentQuotaExceeded) {
		t.Fatalf("document creation bypassed Skill quota: %v", err)
	}
	update := updateDocumentParams{User: user, DocID: doc.DocID, Title: doc.Title, Content: doc.Content + "!", Theme: doc.Theme, ExpectedRevision: doc.Revision, Source: documentSourceWeb}
	if _, err := a.updateDocument(ctx, update); !errors.Is(err, errDocumentQuotaExceeded) {
		t.Fatalf("document growth bypassed Skill quota: %v", err)
	}
	imageKey := "u/" + user.AuthUserID + "/skill-quota.png"
	if _, err := a.recordImageObject(ctx, user.ID, imageKey, 1, a.storageQuotaFor(user), imagePurposePersistent, nil); !errors.Is(err, errQuotaExceeded) {
		t.Fatalf("image upload bypassed Skill quota: %v", err)
	}
	envelope, _ := json.Marshal(map[string]any{
		"version": 1, "kdf": "PBKDF2-SHA-256", "iterations": 310000,
		"salt": base64.StdEncoding.EncodeToString(make([]byte, 16)), "iv": base64.StdEncoding.EncodeToString(make([]byte, 12)),
		"ciphertext": base64.StdEncoding.EncodeToString(make([]byte, 16)),
	})
	payload := configSnapshotCreateInput{Name: "Quota test", FileCount: 1, EnvelopeVersion: 1, Envelope: string(envelope)}
	response = writingTestRequest(t, a, user, "POST", "/api/config-snapshots", payload)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "config_snapshot_quota_exceeded") {
		t.Fatalf("config snapshot bypassed Skill quota: %d %s", response.Code, response.Body.String())
	}
	a.cfg.ImageQuotaBytes--
	tx, err := a.db.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	err = a.checkAgentStorage(ctx, tx, user)
	tx.Rollback(ctx)
	if !errors.Is(err, errDocumentQuotaExceeded) {
		t.Fatalf("Agent storage check ignores Skills: %v", err)
	}
	a.cfg.ImageQuotaBytes++
	// Releasing the package allows the same operations to succeed without
	// deleting its backup-retained files or changing other storage allowances.
	if _, err := a.db.Exec(ctx, `UPDATE koi_skill_installations SET deleted_at=now() WHERE id=$1`, installation); err != nil {
		t.Fatal(err)
	}
	if _, err := a.createDocument(ctx, create); err != nil {
		t.Fatalf("document create after release: %v", err)
	}
	if _, err := a.updateDocument(ctx, update); err != nil {
		t.Fatalf("document update after release: %v", err)
	}
	if _, err := a.recordImageObject(ctx, user.ID, imageKey, 1, a.storageQuotaFor(user), imagePurposePersistent, nil); err != nil {
		t.Fatalf("image upload after release: %v", err)
	}
	response = writingTestRequest(t, a, user, "POST", "/api/config-snapshots", payload)
	if response.Code != http.StatusCreated {
		t.Fatalf("config snapshot after release: %d %s", response.Code, response.Body.String())
	}
	if _, err := a.allocateAgentWorkspaceStorage(ctx, user, 1); err != nil {
		t.Fatalf("repository expansion after release: %v", err)
	}
}
