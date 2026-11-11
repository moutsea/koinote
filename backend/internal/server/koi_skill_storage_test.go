package server

import (
	"context"
	"fmt"
	"testing"

	"koinote/backend/internal/config"
)

// Exercise independent Skill references through the real R2 HTTP adapter and GC.
func TestKoiSkillStorageProtectsObjectsAndBackupRetention(t *testing.T) {
	ctx := context.Background()
	app := New(config.Config{SessionSecret: "skill-storage-test"}, newGCTestPool(t))
	objects := enableRepositoryR2Fixture(t, app)
	user := seedMCPUser(t, app.db, app, membershipTierLifetime)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := app.db.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	file := repositoryTestFile("SKILL.md", "# Review\nRead before editing.")
	staged, err := app.stageAgentRepositoryFiles(ctx, user.ID, []agentWorkspaceFile{file})
	if err != nil || len(staged) != 1 {
		t.Fatalf("stage Skill object: %+v %v", staged, err)
	}
	key := staged[file.SHA256]
	installation, _ := randomUUID()
	version, _ := randomUUID()
	exec(`INSERT INTO koi_skill_installations(id,user_id,source_key,source_kind,source,name)
 VALUES($1::uuid,$2,$1::text,'folder','{}','review')`, installation, user.ID)
	exec(`INSERT INTO koi_skill_versions(id,installation_id,user_id,content_sha256,entry_path,name,file_count,size_bytes,compatibility)
 VALUES($1,$2,$3,$4,'SKILL.md','review',1,$5,'{}')`, version, installation, user.ID, file.SHA256, len(file.Content))
	exec(`INSERT INTO koi_skill_version_files(version_id,position,path,sha256,size_bytes,r2_object_key)
 VALUES($1,1,'SKILL.md',$2,$3,$4)`, version, file.SHA256, len(file.Content), key)
	exec(`UPDATE koi_skill_installations SET current_version_id=$2 WHERE id=$1`, installation, version)
	retained := func() {
		t.Helper()
		var ok bool
		if err := app.db.QueryRow(ctx, `SELECT committed AND delete_after>now()+interval '400 days'
 FROM agent_repository_objects WHERE object_key=$1`, key).Scan(&ok); err != nil || !ok {
			t.Fatalf("Skill object must outlive database backups: %v %v", ok, err)
		}
	}
	retained()
	// Even an expired object remains protected by a Skill-only reference.
	exec(`UPDATE agent_repository_objects SET delete_after=now()-interval '1 day' WHERE object_key=$1`, key)
	if removed, err := app.collectAgentRepositoryObjects(ctx, 100); err != nil || removed != 0 {
		t.Fatalf("live Skill object collected: %d %v", removed, err)
	}
	content, err := app.readAgentRepositoryContent(ctx, nil, &key, file.SHA256, int64(len(file.Content)), 0, koiSkillFileBytes)
	if err != nil || string(content) != string(file.Content) {
		t.Fatalf("Skill bytes lost: %q %v", content, err)
	}
	// Removing an account cascades installations, versions and files; object
	// bytes remain recoverable for backups that still contain those references.
	exec(`DELETE FROM users WHERE id=$1`, user.ID)
	var count int
	if err := app.db.QueryRow(ctx, `SELECT
 (SELECT count(*) FROM koi_skill_installations WHERE id=$1)+
 (SELECT count(*) FROM koi_skill_versions WHERE id=$2)+
 (SELECT count(*) FROM koi_skill_version_files WHERE version_id=$2)`, installation, version).Scan(&count); err != nil || count != 0 {
		t.Fatalf("account deletion left Skill references: %d %v", count, err)
	}
	retained()
	if removed, err := app.collectAgentRepositoryObjects(ctx, 100); err != nil || removed != 0 {
		t.Fatalf("backup-retained object collected: %d %v", removed, err)
	}
	exec(`UPDATE agent_repository_objects SET delete_after=now()-interval '1 day' WHERE object_key=$1`, key)
	if removed, err := app.collectAgentRepositoryObjects(ctx, 100); err != nil || removed != 1 {
		t.Fatalf("unreferenced expired object not collected: %d %v", removed, err)
	}
	objects.mu.Lock()
	defer objects.mu.Unlock()
	if _, exists := objects.objects[key]; exists || objects.deletes != 1 {
		t.Fatalf("unexpected physical cleanup: exists=%v deletes=%d", exists, objects.deletes)
	}
}

func TestKoiSkillStorageIdentityAndFileConstraints(t *testing.T) {
	ctx := context.Background()
	app := New(config.Config{SessionSecret: "skill-storage-constraints"}, newGCTestPool(t))
	user := seedMCPUser(t, app.db, app, membershipTierLifetime)
	id, _ := randomUUID()
	other, _ := randomUUID()
	version, _ := randomUUID()
	insert := `INSERT INTO koi_skill_installations(id,user_id,source_key,source_kind,source,name)
 VALUES($1,$2,'folder:fixed','folder','{}','review')`
	if _, err := app.db.Exec(ctx, insert, id, user.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := app.db.Exec(ctx, insert, other, user.ID); err == nil {
		t.Fatal("duplicate active source accepted")
	}
	if _, err := app.db.Exec(ctx, `UPDATE koi_skill_installations SET deleted_at=now() WHERE id=$1`, id); err != nil {
		t.Fatal(err)
	}
	if _, err := app.db.Exec(ctx, insert, other, user.ID); err != nil {
		t.Fatalf("deleted source blocked reinstallation: %v", err)
	}
	digest := koiDigest([]byte("# Review"))
	if _, err := app.db.Exec(ctx, `INSERT INTO koi_skill_versions(id,installation_id,user_id,content_sha256,entry_path,name,file_count,size_bytes,compatibility)
 VALUES($1,$2,$3,$4,'SKILL.md','review',1,8,'{}')`, version, other, user.ID, digest); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name    string
		content any
		key     any
		size    int
	}{
		{"missing bytes", nil, nil, 8},
		{"both stores", []byte("# Review"), "objects/missing", 8},
		{"missing object", nil, "objects/missing", 8},
		{"oversize file", []byte("# Review"), nil, koiSkillFileBytes + 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := app.db.Exec(ctx, `INSERT INTO koi_skill_version_files(version_id,position,path,sha256,size_bytes,content,r2_object_key)
 VALUES($1,1,'SKILL.md',$2,$3,$4,$5)`, version, digest, tc.size, tc.content, tc.key); err == nil {
				t.Fatal("invalid storage reference accepted")
			}
		})
	}
	if _, err := app.db.Exec(ctx, `INSERT INTO koi_skill_version_files(version_id,position,path,sha256,size_bytes,content)
 VALUES($1,1,'SKILL.md',$2,8,$3)`, version, digest, []byte("# Review")); err != nil {
		t.Fatalf("inline file rejected: %v", err)
	}
	for _, values := range []string{"(1,'other.md')", "(2,'SKILL.md')"} {
		query := fmt.Sprintf(`INSERT INTO koi_skill_version_files(version_id,position,path,sha256,size_bytes,content)
 SELECT $1,p,n,$2,8,$3 FROM (VALUES %s) AS f(p,n)`, values)
		if _, err := app.db.Exec(ctx, query, version, digest, []byte("# Review")); err == nil {
			t.Fatal("duplicate file position or path accepted")
		}
	}
}
