package server

import (
	"context"
	"encoding/json"
	"net/url"
	"testing"

	"koinote/backend/internal/config"
)

func TestKoiSkillSourceFiltersAndPagination(t *testing.T) {
	a := New(config.Config{SessionSecret: "skill-source-filters"}, newGCTestPool(t))
	user := seedMCPUser(t, a.db, a, membershipTierLifetime)
	other := seedMCPUser(t, a.db, a, membershipTierLifetime)
	a.cfg.KoiSkillTestAccounts = []string{user.AuthUserID}
	seed := func(userID int, source string, enabled, deleted bool) {
		t.Helper()
		installation, _ := randomUUID()
		version, _ := randomUUID()
		_, err := a.db.Exec(context.Background(), `WITH installed AS (
 INSERT INTO koi_skill_installations(id,user_id,source_key,source_kind,source,name,enabled,deleted_at,current_version_id)
 VALUES($1::uuid,$3,$1::text,$4,'{}','review '||$4,$5,CASE WHEN $6 THEN now() END,$2) RETURNING id
 )
 INSERT INTO koi_skill_versions(id,installation_id,user_id,content_sha256,entry_path,name,file_count,size_bytes,compatibility,rules_version)
 SELECT $2,id,$3,repeat('a',64),'SKILL.md','review',1,1,'{"conversation":true,"article":true}',$7 FROM installed`,
			installation, version, userID, source, enabled, deleted, koiSkillEntryRulesVersion)
		if err != nil {
			t.Fatal(err)
		}
	}
	for index := range 22 {
		seed(user.ID, "github", index != 0, false)
	}
	for _, source := range []string{"folder", "hub", "migration"} {
		seed(user.ID, source, true, false)
	}
	seed(other.ID, "github", true, false)
	seed(user.ID, "github", true, true)
	for _, tc := range []struct {
		filter string
		count  int
	}{
		{"", 25}, {"source=github", 22}, {"source=folder", 1}, {"source=hub", 1}, {"source=migration", 1},
		{"source=github&q=review&state=disabled", 1}, {"source=github&q=folder", 0},
	} {
		t.Run(tc.filter, func(t *testing.T) {
			params, _ := url.ParseQuery(tc.filter)
			seen := map[string]bool{}
			for {
				w := koiFolderRequest(t, a, user, "GET", "/api/koi/skills?"+params.Encode(), nil, 200)
				var page struct {
					Skills     []koiSkillInstallation `json:"skills"`
					NextCursor string                 `json:"nextCursor"`
				}
				if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil {
					t.Fatal(err)
				}
				for _, skill := range page.Skills {
					if seen[skill.ID] || (params.Get("source") != "" && skill.SourceKind != params.Get("source")) {
						t.Fatalf("duplicate or wrong-source Skill: %+v", skill)
					}
					seen[skill.ID] = true
				}
				if page.NextCursor == "" {
					break
				}
				params.Set("cursor", page.NextCursor)
			}
			if len(seen) != tc.count {
				t.Fatalf("got %d Skills, want %d", len(seen), tc.count)
			}
		})
	}
	koiFolderRequest(t, a, user, "GET", "/api/koi/skills?source=unknown", nil, 400)
}
