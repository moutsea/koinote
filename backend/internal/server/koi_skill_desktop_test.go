package server

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"koinote/backend/internal/config"
)

func TestKoiSkillAccountRollout(t *testing.T) {
	for _, test := range []struct {
		name     string
		accounts []string
		authID   string
		allowed  bool
	}{
		{"closed", nil, "member", false},
		{"empty configuration", []string{"", " "}, "member", false},
		{"selected account", []string{" member "}, "member", true},
		{"other account", []string{"member"}, "other", false},
		{"public rollout", []string{" * "}, "other", true},
		{"wildcard is explicit", []string{"member-*"}, "member-other", false},
		{"no anonymous access", []string{"*"}, "", false},
		{"no blank identity", []string{"*"}, " ", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			a := &App{cfg: config.Config{KoiSkillTestAccounts: test.accounts}}
			if got := a.koiSkillAccountAllowed(test.authID); got != test.allowed {
				t.Fatalf("allowed=%v, want %v", got, test.allowed)
			}
		})
	}
}

func TestKoiDesktopRequestScopes(t *testing.T) {
	id := "550e8400-e29b-41d4-a716-446655440000"
	routes := map[string]string{
		"/api/koi/settings": "GET PUT",
		"/api/koi/skills":   "GET",
		"/api/koi/skills?source=hub&hubWorkspaceId=7":           "GET",
		"/api/koi/skills/" + id:                                 "GET PATCH DELETE",
		"/api/koi/skills/" + id + "/check-update":               "POST",
		"/api/koi/skills/" + id + "/files/1?version=" + id:      "GET",
		"/api/koi/skill-migration/skip":                         "POST",
		"/api/koi/skill-imports":                                "POST",
		"/api/koi/skill-imports/" + id:                          "GET DELETE",
		"/api/koi/skill-imports/" + id + "/files?path=guide.md": "PUT",
		"/api/koi/skill-imports/" + id + "/analyze":             "POST",
		"/api/koi/skill-imports/" + id + "/confirm":             "POST",
		"/api/koi/skills/not-a-uuid":                            "",
		"/api/koi/skills/" + id + "/files/0":                    "",
		"/api/koi/skills/" + id + "/files/1/extra":              "",
		"/api/koi/skill-imports/not-a-uuid/analyze":             "",
		"/api/koi/skill-imports/" + id + "/confirm/extra":       "",
		"/api/koi/skill-imports/" + id + "/unknown":             "",
		"/api/koi/admin":                                        "",
	}
	for path, methods := range routes {
		for _, method := range []string{"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"} {
			want := strings.Contains(" "+methods+" ", " "+method+" ")
			if got := desktopRequestAllowed(httptest.NewRequest(method, path, nil)); got != want {
				t.Errorf("%s %s: allowed=%v, want %v", method, path, got, want)
			}
		}
	}
}

// Exercise the same Bearer-only authentication used by the packaged desktop app.
// Cookie-authenticated Skill tests do not cover the desktop endpoint allowlist.
func TestKoiDesktopManagementLifecycle(t *testing.T) {
	a, user, _ := writingTestApp(t)
	ctx := context.Background()
	tokens, err := a.issueDesktopTokenPair(ctx, a.db, user.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	accessToken := tokens.AccessToken
	handler := a.Routes()
	request := func(method, path string, input any, status int) *httptest.ResponseRecorder {
		t.Helper()
		var body []byte
		if input != nil {
			body, err = json.Marshal(input)
			if err != nil {
				t.Fatal(err)
			}
		}
		r := httptest.NewRequest(method, path, bytes.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+accessToken)
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != status {
			t.Fatalf("%s %s: %d %s (want %d)", method, path, w.Code, w.Body.String(), status)
		}
		return w
	}
	before := request("GET", "/api/koi/settings", nil, 200)
	if !strings.Contains(before.Body.String(), `"managementAvailable":false`) {
		t.Fatal(before.Body.String())
	}
	blocked := request("GET", "/api/koi/skills", nil, 403)
	if !strings.Contains(blocked.Body.String(), `"code":"koi_unavailable"`) {
		t.Fatal(blocked.Body.String())
	}
	a.cfg.KoiSkillTestAccounts = []string{"*"}
	opened := request("GET", "/api/koi/settings", nil, 200)
	if !strings.Contains(opened.Body.String(), `"managementAvailable":true`) || !strings.Contains(opened.Body.String(), `"canInstall":true`) {
		t.Fatal(opened.Body.String())
	}
	request("PUT", "/api/koi/settings", map[string]any{"expectedRevision": 1, "autoSkills": false}, 200)
	requestID, _ := randomUUID()
	view := koiFolderView(t, request("POST", "/api/koi/skill-imports", koiImportRequest{RequestID: requestID, SourceKind: "folder", DeclaredPaths: []string{"SKILL.md", "guide.md"}}, 202))
	previewPath := "/api/koi/skill-imports/" + view.ID
	request("GET", previewPath, nil, 200)
	for path, content := range map[string]string{"SKILL.md": "# Desktop review\nRead guide.md.", "guide.md": "Review the article structure."} {
		request("PUT", previewPath+"/files?path="+url.QueryEscape(path), map[string]string{"contentBase64": base64.StdEncoding.EncodeToString([]byte(content))}, 200)
	}
	view = koiFolderView(t, request("POST", previewPath+"/analyze", nil, 200))
	installed := koiFolderInstalled(t, request("POST", previewPath+"/confirm", koiFolderConfirmation(view), 200))
	if len(installed) != 1 || !installed[0].Enabled {
		t.Fatalf("unexpected installations: %+v", installed)
	}
	skill := installed[0]
	skillPath := "/api/koi/skills/" + skill.ID
	list := request("GET", "/api/koi/skills?source=folder", nil, 200)
	if !strings.Contains(list.Body.String(), skill.ID) {
		t.Fatal("installed Skill is missing from desktop list")
	}
	request("GET", skillPath, nil, 200)
	request("GET", skillPath+"/files/2?version="+skill.VersionID, nil, 200)
	other := insertAgentReviewTestUser(t, a.db)
	otherTokens, err := a.issueDesktopTokenPair(ctx, a.db, other.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	accessToken = otherTokens.AccessToken
	request("GET", skillPath, nil, 404)
	request("GET", skillPath+"/files/2?version="+skill.VersionID, nil, 404)
	request("GET", previewPath, nil, 404)
	accessToken = tokens.AccessToken
	request("POST", skillPath+"/check-update", nil, 200)
	if _, err := a.db.Exec(ctx, `UPDATE users SET membership_tier='free' WHERE id=$1`, user.ID); err != nil {
		t.Fatal(err)
	}
	free := request("GET", "/api/koi/settings", nil, 200)
	if !strings.Contains(free.Body.String(), `"managementAvailable":true`) || !strings.Contains(free.Body.String(), `"canInstall":false`) {
		t.Fatal(free.Body.String())
	}
	request("GET", skillPath, nil, 200)
	blocked = request("POST", "/api/koi/skill-imports", koiImportRequest{RequestID: requestID, SourceKind: "folder", DeclaredPaths: []string{"SKILL.md"}}, 403)
	if !strings.Contains(blocked.Body.String(), `"code":"membership_required"`) {
		t.Fatal(blocked.Body.String())
	}
	request("POST", skillPath+"/check-update", nil, 403)
	request("PATCH", skillPath, map[string]any{"expectedRevision": skill.Revision, "enabled": false}, 200)
	blocked = request("PATCH", skillPath, map[string]any{"expectedRevision": skill.Revision + 1, "enabled": true}, 403)
	if !strings.Contains(blocked.Body.String(), `"code":"membership_required"`) {
		t.Fatal(blocked.Body.String())
	}
	request("DELETE", skillPath+"?expectedRevision=2", nil, 200)
	request("GET", skillPath, nil, 404)
}
