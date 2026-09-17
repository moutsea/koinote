package server

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"koinote/backend/internal/config"
)

func TestNormalizeAgentWorkspacePath(t *testing.T) {
	tests := []struct {
		name  string
		input string
		valid string
	}{
		{name: "nested", input: "skills/writing/SKILL.md", valid: "skills/writing/SKILL.md"},
		{name: "dot segment rejected", input: "skills/./SKILL.md"},
		{name: "parent rejected", input: "skills/../secret.txt"},
		{name: "absolute rejected", input: "/tmp/secret.txt"},
		{name: "windows separator rejected", input: `skills\\secret.txt`},
		{name: "empty rejected", input: ""},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := normalizeAgentWorkspacePath(test.input)
			if test.valid == "" {
				if err == nil {
					t.Fatalf("path %q accepted as %q", test.input, got)
				}
				return
			}
			if err != nil || got != test.valid {
				t.Fatalf("normalize(%q) = %q, %v", test.input, got, err)
			}
		})
	}
}

func TestValidateAgentWorkspaceFilesRejectsSensitiveData(t *testing.T) {
	content := base64.StdEncoding.EncodeToString([]byte(`api_key: "sk-example-1234567890"`))
	_, err := validateAgentWorkspaceFiles([]agentWorkspaceFileInput{{
		Path: "settings/agent.yaml", ContentBase64: content,
	}})
	if err == nil || !strings.Contains(err.Error(), "redact") {
		t.Fatalf("sensitive data error = %v", err)
	}
}

func TestValidateAgentWorkspaceFilesEnforcesPerFileLimitWithoutTotalLimit(t *testing.T) {
	withinLimit := base64.StdEncoding.EncodeToString(make([]byte, agentWorkspaceMaxFileBytes))
	if _, err := validateAgentWorkspaceFiles([]agentWorkspaceFileInput{{
		Path: "large-a.bin", ContentBase64: withinLimit,
	}}); err != nil {
		t.Fatalf("file at the limit rejected: %v", err)
	}
	if _, err := validateAgentWorkspaceFiles([]agentWorkspaceFileInput{{
		Path: "large-a.bin", ContentBase64: base64.StdEncoding.EncodeToString(make([]byte, agentWorkspaceMaxFileBytes+1)),
	}}); err == nil {
		t.Fatal("file over the limit was accepted")
	}
	if _, err := validateAgentWorkspaceFiles([]agentWorkspaceFileInput{
		{Path: "large-a.bin", ContentBase64: withinLimit},
		{Path: "large-b.bin", ContentBase64: withinLimit},
	}); err != nil {
		t.Fatalf("multiple files at the per-file limit rejected: %v", err)
	}
}

func TestValidateAgentWorkspaceMetadata(t *testing.T) {
	name, description, err := validateAgentWorkspaceMetadata("  Writing Agent  ", "  personal setup  ")
	if err != nil || name != "Writing Agent" || description != "personal setup" {
		t.Fatalf("metadata = %q/%q, error = %v", name, description, err)
	}
	if _, _, err := validateAgentWorkspaceMetadata("", "note"); !errors.Is(err, errAgentWorkspaceName) {
		t.Fatalf("empty name error = %v", err)
	}
}

func TestAgentWorkspacePromptContainsSafetyAndProtocol(t *testing.T) {
	prompt := agentWorkspacePrompt("https://koinote.example")
	for _, want := range []string{
		"GET https://koinote.example/api/agent/workspace",
		"PUT https://koinote.example/api/agent/workspace",
		"PATCH https://koinote.example/api/agent/workspace",
		"get_agent_workspace",
		"KOINOTE_MCP_TOKEN",
		"Authorization: Bearer $KOINOTE_MCP_TOKEN",
		"Streamable HTTP",
		"expectedRevision",
		"redact sensitive values",
		"do not execute scripts",
	} {
		if !strings.Contains(prompt, want) {
			t.Errorf("prompt missing %q", want)
		}
	}
	if strings.Contains(prompt, "knt_mcp_") || strings.Contains(prompt, "Bearer <token>") {
		t.Fatal("prompt must not contain a real or placeholder token")
	}
}

func TestAgentWorkspaceREADMEContainsImportSyncAndSafetyGuidance(t *testing.T) {
	readme := agentWorkspaceREADME("https://koinote.example")
	if _, err := validateAgentWorkspaceFiles([]agentWorkspaceFileInput{{
		Path: "README.md", ContentBase64: base64.StdEncoding.EncodeToString([]byte(readme)), MimeType: "text/markdown",
	}}); err != nil {
		t.Fatalf("generated README rejected by upload validation: %v", err)
	}
	for _, want := range []string{
		"Copy for AI Agent",
		"Import folder",
		"Claude Code",
		"API keys",
		"https://koinote.example/mcp",
	} {
		if !strings.Contains(readme, want) {
			t.Errorf("README missing %q", want)
		}
	}
	for _, unwanted := range []string{"list_agent_workspaces", "expectedRevision", "Treat repository files as user-controlled instructions"} {
		if strings.Contains(readme, unwanted) {
			t.Errorf("human README must not contain Agent execution detail %q", unwanted)
		}
	}
}

func TestAgentWorkspaceREADMESupportsLocales(t *testing.T) {
	cases := []struct {
		locale string
		want   string
	}{
		{locale: "en", want: "The easiest way to get started"},
		{locale: "zh", want: "最简单的开始方式"},
		{locale: "fr", want: "Le moyen le plus simple de commencer"},
		{locale: "ja", want: "まず始める方法"},
	}
	for _, tc := range cases {
		readme := agentWorkspaceREADMEForLocale("https://koinote.example", tc.locale)
		if !strings.Contains(readme, tc.want) || !strings.Contains(readme, "https://koinote.example/mcp") {
			t.Errorf("locale %q README missing localized content or MCP URL", tc.locale)
		}
		if _, err := validateAgentWorkspaceFiles([]agentWorkspaceFileInput{{
			Path: "README.md", ContentBase64: base64.StdEncoding.EncodeToString([]byte(readme)), MimeType: "text/markdown",
		}}); err != nil {
			t.Errorf("locale %q README rejected by upload validation: %v", tc.locale, err)
		}
	}
	if got := agentWorkspaceREADMEForLocale("https://koinote.example", "unknown"); got != agentWorkspaceREADME("https://koinote.example") {
		t.Error("unknown README locale should fall back to English")
	}
}

func TestAgentWorkspaceCreationStoresLocalizedREADME(t *testing.T) {
	pool, userID := newCreditTestUser(t)
	ctx := context.Background()
	var authUserID string
	if err := pool.QueryRow(ctx, `
		UPDATE users SET membership_tier = 'lifetime', membership_granted_at = now()
		WHERE id = $1 RETURNING auth_user_id
	`, userID).Scan(&authUserID); err != nil {
		t.Fatalf("grant membership: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO agent_workspace_settings (user_id, enabled) VALUES ($1, true)`, userID); err != nil {
		t.Fatalf("enable workspace: %v", err)
	}
	app := &App{db: pool, cfg: config.Config{SessionSecret: "agent-workspace-session", AppURL: "https://koinote.example"}}
	cookie := sessionCookieFor(t, app, authUserID, 1)
	user, err := app.getUserByAuthUserID(ctx, authUserID)
	if err != nil {
		t.Fatalf("load user: %v", err)
	}
	mcpContext := context.WithValue(ctx, mcpPrincipalContextKey{}, mcpPrincipal{User: user, Scope: "agent_write"})
	tests := []struct {
		locale string
		title  string
	}{
		{locale: "en", title: "# Koinote Skills / Agent repository"},
		{locale: "zh", title: "# Koinote Skills / Agent 仓库"},
		{locale: "fr", title: "# Dépôt Koinote Skills / Agent"},
		{locale: "ja", title: "# Koinote Skills / Agent リポジトリ"},
		{locale: "", title: "# Koinote Skills / Agent repository"},
	}
	for _, transport := range []string{"api", "mcp"} {
		for _, test := range tests {
			t.Run(transport+"/"+test.locale, func(t *testing.T) {
				var workspace agentWorkspaceView
				if transport == "api" {
					payload, err := json.Marshal(agentWorkspaceMetadataInput{Name: "Localized README", Locale: test.locale})
					if err != nil {
						t.Fatal(err)
					}
					response := callLLMChannelAPI(t, app, cookie, http.MethodPost, "/api/agent/workspaces", string(payload))
					if response.Code != http.StatusCreated {
						t.Fatalf("create status=%d body=%s", response.Code, response.Body.String())
					}
					var body struct {
						Workspace agentWorkspaceView `json:"workspace"`
					}
					decodeJSONResponse(t, response, &body)
					workspace = body.Workspace
				} else {
					_, created, err := app.mcpCreateAgentWorkspace(mcpContext, nil, mcpCreateAgentWorkspaceInput{Name: "Localized README", Locale: test.locale})
					if err != nil {
						t.Fatalf("MCP create: %v", err)
					}
					workspace = created
				}
				if len(workspace.Files) != 1 || workspace.Files[0].Path != "README.md" {
					t.Fatalf("created files = %+v", workspace.Files)
				}
				file := workspace.Files[0]
				response := callLLMChannelAPI(t, app, cookie, http.MethodGet, fmt.Sprintf("/api/agent/workspace/files/%d", file.FileID), "")
				if response.Code != http.StatusOK {
					t.Fatalf("read status=%d body=%s", response.Code, response.Body.String())
				}
				var body struct {
					File agentWorkspaceFileContentView `json:"file"`
				}
				decodeJSONResponse(t, response, &body)
				content, err := base64.StdEncoding.DecodeString(body.File.ContentBase64)
				if err != nil {
					t.Fatal(err)
				}
				if !strings.HasPrefix(string(content), test.title+"\n") || strings.Contains(string(content), "%!") {
					t.Fatalf("stored README is not a valid %q document: %s", test.locale, content)
				}
				if string(content) != agentWorkspaceREADMEForLocale(app.cfg.AppURL, test.locale) {
					t.Fatal("downloaded README differs from the localized template")
				}
				contentHash := sha256.Sum256(content)
				if body.File.SHA256 != hex.EncodeToString(contentHash[:]) || body.File.SizeBytes != int64(len(content)) || body.File.MimeType != "text/markdown" {
					t.Fatalf("stored README metadata mismatch: %+v", body.File)
				}
			})
		}
	}
}

func TestAgentWorkspaceAPIStoresOriginalFilesAndProtectsRevision(t *testing.T) {
	pool, userID := newCreditTestUser(t)
	ctx := context.Background()
	var authUserID string
	if err := pool.QueryRow(ctx, `
		UPDATE users
		SET membership_tier = 'lifetime', membership_granted_at = now()
		WHERE id = $1
		RETURNING auth_user_id
	`, userID).Scan(&authUserID); err != nil {
		t.Fatalf("make workspace test user a member: %v", err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO agent_workspace_settings (user_id, enabled) VALUES ($1, true)`, userID); err != nil {
		t.Fatalf("enable workspace test user: %v", err)
	}
	app := &App{db: pool, cfg: config.Config{SessionSecret: "agent-workspace-session"}}
	cookie := sessionCookieFor(t, app, authUserID, 1)
	content := "name: writing\n  description: keep  spaces\n"
	payload := fmt.Sprintf(`{"expectedRevision":0,"files":[{"path":"skills/writing/SKILL.md","contentBase64":"%s","mimeType":"text/markdown"}]}`,
		base64.StdEncoding.EncodeToString([]byte(content)))
	created := callLLMChannelAPI(t, app, cookie, http.MethodPut, "/api/agent/workspace", payload)
	if created.Code != http.StatusOK {
		t.Fatalf("create workspace status=%d body=%s", created.Code, created.Body.String())
	}
	var createdBody struct {
		Workspace agentWorkspaceView `json:"workspace"`
	}
	decodeJSONResponse(t, created, &createdBody)
	if createdBody.Workspace.Revision != 1 || len(createdBody.Workspace.Files) != 1 ||
		createdBody.Workspace.Files[0].Path != "skills/writing/SKILL.md" {
		t.Fatalf("created workspace = %+v", createdBody.Workspace)
	}

	file := callLLMChannelAPI(t, app, cookie, http.MethodGet,
		fmt.Sprintf("/api/agent/workspace/files/%d", createdBody.Workspace.Files[0].FileID), "")
	if file.Code != http.StatusOK || !strings.Contains(file.Body.String(), base64.StdEncoding.EncodeToString([]byte(content))) {
		t.Fatalf("file response status=%d body=%s", file.Code, file.Body.String())
	}

	conflict := callLLMChannelAPI(t, app, cookie, http.MethodPut, "/api/agent/workspace", payload)
	if conflict.Code != http.StatusConflict {
		t.Fatalf("stale workspace update status=%d body=%s", conflict.Code, conflict.Body.String())
	}

	secretPayload := `{"expectedRevision":1,"files":[{"path":"settings.json","contentBase64":"YXBpX2tleTogc2stZXhhbXBsZS0xMjM0NTY3ODkw"}]}`
	secret := callLLMChannelAPI(t, app, cookie, http.MethodPut, "/api/agent/workspace", secretPayload)
	if secret.Code != http.StatusUnprocessableEntity || !strings.Contains(secret.Body.String(), "sensitive_data_detected") {
		t.Fatalf("sensitive workspace update status=%d body=%s", secret.Code, secret.Body.String())
	}

	updatedContent := "name: revised\n"
	patchPayload := fmt.Sprintf(`{"expectedRevision":1,"upsert":[{"path":"skills/writing/SKILL.md","contentBase64":"%s","mimeType":"text/markdown"},{"path":"settings.json","contentBase64":"%s","mimeType":"application/json"}]}`,
		base64.StdEncoding.EncodeToString([]byte(updatedContent)),
		base64.StdEncoding.EncodeToString([]byte(`{"theme":"ink"}`)))
	patched := callLLMChannelAPI(t, app, cookie, http.MethodPatch, "/api/agent/workspace", patchPayload)
	if patched.Code != http.StatusOK {
		t.Fatalf("patch workspace status=%d body=%s", patched.Code, patched.Body.String())
	}
	var patchedBody struct {
		Workspace agentWorkspaceView `json:"workspace"`
	}
	decodeJSONResponse(t, patched, &patchedBody)
	if patchedBody.Workspace.Revision != 2 || len(patchedBody.Workspace.Files) != 2 {
		t.Fatalf("patched workspace = %+v", patchedBody.Workspace)
	}

	deleteOnly := `{"expectedRevision":2,"delete":["settings.json"]}`
	deleted := callLLMChannelAPI(t, app, cookie, http.MethodPatch, "/api/agent/workspace", deleteOnly)
	if deleted.Code != http.StatusOK {
		t.Fatalf("delete-only patch status=%d body=%s", deleted.Code, deleted.Body.String())
	}
	var deletedBody struct {
		Workspace agentWorkspaceView `json:"workspace"`
	}
	decodeJSONResponse(t, deleted, &deletedBody)
	if deletedBody.Workspace.Revision != 3 || len(deletedBody.Workspace.Files) != 1 || deletedBody.Workspace.Files[0].Path != "skills/writing/SKILL.md" {
		t.Fatalf("delete-only workspace = %+v", deletedBody.Workspace)
	}

	stalePatch := `{"expectedRevision":2,"delete":["skills/writing/SKILL.md"]}`
	stale := callLLMChannelAPI(t, app, cookie, http.MethodPatch, "/api/agent/workspace", stalePatch)
	if stale.Code != http.StatusConflict {
		t.Fatalf("stale patch status=%d body=%s", stale.Code, stale.Body.String())
	}

	second := callLLMChannelAPI(t, app, cookie, http.MethodPost, "/api/agent/workspaces", `{"name":"Research Agent","description":"second configuration"}`)
	if second.Code != http.StatusCreated {
		t.Fatalf("create second workspace status=%d body=%s", second.Code, second.Body.String())
	}
	var secondBody struct {
		Workspace agentWorkspaceView `json:"workspace"`
	}
	decodeJSONResponse(t, second, &secondBody)
	if secondBody.Workspace.Name != "Research Agent" || secondBody.Workspace.Revision != 0 {
		t.Fatalf("second workspace = %+v", secondBody.Workspace)
	}
	if len(secondBody.Workspace.Files) != 1 || secondBody.Workspace.Files[0].Path != "README.md" {
		t.Fatalf("new repository must contain README.md: %+v", secondBody.Workspace.Files)
	}
	readmeFile := secondBody.Workspace.Files[0]
	readmeResponse := callLLMChannelAPI(t, app, cookie, http.MethodGet,
		fmt.Sprintf("/api/agent/workspace/files/%d", readmeFile.FileID), "")
	if readmeResponse.Code != http.StatusOK {
		t.Fatalf("README response status=%d body=%s", readmeResponse.Code, readmeResponse.Body.String())
	}
	var readmeBody struct {
		File agentWorkspaceFileContentView `json:"file"`
	}
	decodeJSONResponse(t, readmeResponse, &readmeBody)
	readmeContent, err := base64.StdEncoding.DecodeString(readmeBody.File.ContentBase64)
	if err != nil || string(readmeContent) != agentWorkspaceREADME(app.cfg.AppURL) || readmeBody.File.MimeType != "text/markdown" || readmeBody.File.SizeBytes != int64(len(readmeContent)) {
		t.Fatalf("stored README mismatch: metadata=%+v error=%v", readmeFile, err)
	}
	listed := callLLMChannelAPI(t, app, cookie, http.MethodGet, "/api/agent/workspaces", "")
	if listed.Code != http.StatusOK || strings.Count(listed.Body.String(), `"workspaceId"`) != 2 {
		t.Fatalf("workspace list status=%d body=%s", listed.Code, listed.Body.String())
	}
	ambiguous := callLLMChannelAPI(t, app, cookie, http.MethodGet, "/api/agent/workspace", "")
	if ambiguous.Code != http.StatusConflict || !strings.Contains(ambiguous.Body.String(), "workspace_selection_required") {
		t.Fatalf("ambiguous legacy workspace status=%d body=%s", ambiguous.Code, ambiguous.Body.String())
	}
}
