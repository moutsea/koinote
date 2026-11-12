package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"testing"

	"koinote/backend/internal/model"
)

// A detail view must keep reading the version it displayed after an update,
// without allowing another installation's version or another account's bytes.
func TestKoiFilePreviewPinsVersionAndOwner(t *testing.T) {
	for _, r2 := range []bool{false, true} {
		t.Run(fmt.Sprint("r2=", r2), func(t *testing.T) {
			a, user, _ := writingTestApp(t)
			other := insertAgentReviewTestUser(t, a.db)
			a.cfg.KoiSkillTestAccounts = []string{user.AuthUserID, other.AuthUserID}
			if r2 {
				enableRepositoryR2Fixture(t, a)
				t.Cleanup(func() {
					if _, err := a.db.Exec(context.Background(), `DELETE FROM users WHERE id=$1`, user.ID); err != nil {
						t.Error(err)
					}
				})
			}
			original := "<script>must stay inert</script>"
			first := koiRuntimeInstall(t, a, user, map[string]string{"SKILL.md": "# Review", "reference.html": original})
			agentTestTask(t, a, user, agentTestSession(t, a, user, "review"), model.Document{}, "Read references")
			var detail struct {
				Files []koiSkillFileView `json:"files"`
			}
			w := koiFolderRequest(t, a, user, "GET", "/api/koi/skills/"+first.ID, nil, 200)
			if err := json.Unmarshal(w.Body.Bytes(), &detail); err != nil {
				t.Fatal(err)
			}
			position := 0
			for _, file := range detail.Files {
				if file.Path == "reference.html" {
					position = file.Position
				}
			}
			if position == 0 {
				t.Fatal("reference missing from detail")
			}
			request, _ := randomUUID()
			view := koiFolderView(t, koiFolderRequest(t, a, user, "POST", "/api/koi/skill-imports", koiImportRequest{RequestID: request, SourceKind: "folder", DeclaredPaths: []string{"SKILL.md", "reference.html"}, UpdateFromID: first.ID, ExpectedRevision: first.Revision}, 202))
			for path, text := range map[string]string{"SKILL.md": "# Review", "reference.html": "Updated reference"} {
				koiFolderUpload(t, a, user, view.ID, path, text, 200)
			}
			view = koiFolderView(t, koiFolderRequest(t, a, user, "POST", "/api/koi/skill-imports/"+view.ID+"/analyze", nil, 200))
			second := koiTestConfirm(t, a, user, view)
			for _, read := range []struct{ version, content string }{{first.VersionID, original}, {second.VersionID, "Updated reference"}, {"", "Updated reference"}} {
				path := fmt.Sprintf("/api/koi/skills/%s/files/%d", first.ID, position)
				if read.version != "" {
					path += "?version=" + read.version
				}
				w := koiFolderRequest(t, a, user, "GET", path, nil, 200)
				var response struct{ ContentBase64 string }
				if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
					t.Fatal(err)
				}
				decoded, err := base64.StdEncoding.DecodeString(response.ContentBase64)
				if err != nil || string(decoded) != read.content {
					t.Fatalf("wrong version bytes: %s %v", w.Body.String(), err)
				}
			}
			unrelated := koiRuntimeInstall(t, a, user, map[string]string{"SKILL.md": "# Other", "reference.html": "Other installation"})
			path := fmt.Sprintf("/api/koi/skills/%s/files/%d?version=", first.ID, position)
			koiFolderRequest(t, a, user, "GET", path+unrelated.VersionID, nil, 404)
			koiFolderRequest(t, a, other, "GET", path+first.VersionID, nil, 404)
		})
	}
}
