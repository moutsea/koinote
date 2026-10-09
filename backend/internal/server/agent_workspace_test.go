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
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"koinote/backend/internal/config"
	"koinote/backend/internal/model"
)

func TestMCPAgentWorkspaceWriteRateLimit(t *testing.T) {
	app := &App{}
	principal := mcpPrincipal{User: model.User{ID: 90210}, Scope: "agent_write"}
	for attempt := 0; attempt < agentWorkspaceWriteLimit; attempt++ {
		if err := app.allowMCPAgentWorkspaceWrite(principal); err != nil {
			t.Fatalf("attempt %d unexpectedly rate limited: %v", attempt+1, err)
		}
	}
	if err := app.allowMCPAgentWorkspaceWrite(principal); err == nil {
		t.Fatal("the request after the write limit was accepted")
	}
}

func TestMCPAgentWorkspaceMutationsAreAuditedAndRateLimited(t *testing.T) {
	pool, userID := newCreditTestUser(t)
	ctx := context.Background()
	var authUserID string
	if err := pool.QueryRow(ctx, `
		UPDATE users SET membership_tier = 'lifetime', membership_granted_at = now()
		WHERE id = $1 RETURNING auth_user_id
	`, userID).Scan(&authUserID); err != nil {
		t.Fatalf("grant membership: %v", err)
	}
	app := &App{db: pool, cfg: config.Config{SessionSecret: "mcp-agent-workspace-test", AppURL: "https://koinote.example"}}
	user, err := app.getUserByAuthUserID(ctx, authUserID)
	if err != nil {
		t.Fatalf("load user: %v", err)
	}
	tokenHash := sha256.Sum256([]byte("agent-workspace-audit-token"))
	var tokenID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO mcp_tokens (token_id, user_id, name, token_hash, token_hint, scope)
		VALUES ('agent-workspace-audit-token', $1, 'Agent workspace test', $2, '…test', 'agent_write')
		RETURNING id
	`, user.ID, tokenHash[:]).Scan(&tokenID); err != nil {
		t.Fatalf("create test token: %v", err)
	}
	principal := mcpPrincipal{User: user, TokenID: tokenID, Scope: "agent_write"}
	mcpContext := context.WithValue(ctx, mcpPrincipalContextKey{}, principal)
	_, workspace, err := app.mcpCreateAgentWorkspace(mcpContext, nil, mcpCreateAgentWorkspaceInput{Name: "Audit test"})
	if err != nil {
		t.Fatalf("MCP create: %v", err)
	}
	for attempt := 1; attempt < agentWorkspaceWriteLimit; attempt++ {
		_, updated, manageErr := app.mcpManageAgentWorkspace(mcpContext, nil, mcpManageAgentWorkspaceInput{
			WorkspaceID: workspace.WorkspaceID, ExpectedRevision: workspace.Revision,
			Name: fmt.Sprintf("Audit test %d", attempt),
		})
		if manageErr != nil {
			t.Fatalf("MCP manage attempt %d: %v", attempt, manageErr)
		}
		workspace = updated
	}
	if _, _, err := app.mcpManageAgentWorkspace(mcpContext, nil, mcpManageAgentWorkspaceInput{
		WorkspaceID: workspace.WorkspaceID, ExpectedRevision: workspace.Revision, Name: "rate limited",
	}); err == nil || !strings.Contains(err.Error(), "too many workspace updates") {
		t.Fatalf("rate-limited manage error = %v", err)
	}
	var createSuccess, manageSuccess, manageErrors int
	if err := pool.QueryRow(ctx, `
		SELECT
			count(*) FILTER (WHERE tool_name = 'create_agent_workspace' AND result = 'success'),
			count(*) FILTER (WHERE tool_name = 'manage_agent_workspace' AND result = 'success'),
			count(*) FILTER (WHERE tool_name = 'manage_agent_workspace' AND result = 'error')
		FROM mcp_audit_logs WHERE user_id = $1 AND token_id = $2
	`, user.ID, tokenID).Scan(&createSuccess, &manageSuccess, &manageErrors); err != nil {
		t.Fatalf("read MCP audit logs: %v", err)
	}
	if createSuccess != 1 || manageSuccess != agentWorkspaceWriteLimit-1 || manageErrors != 1 {
		t.Fatalf("audit counts = create %d, manage success %d, manage errors %d", createSuccess, manageSuccess, manageErrors)
	}
}

func TestAgentWorkspaceHistoryPruningKeepsNewestRevisionAndCleansBlobs(t *testing.T) {
	pool, userID := newCreditTestUser(t)
	ctx := context.Background()
	app := &App{db: pool, cfg: config.Config{AppURL: "https://koinote.example"}}
	workspace, err := app.createAgentWorkspace(ctx, userID, "History test", "", "en")
	if err != nil {
		t.Fatalf("create workspace: %v", err)
	}
	for revision := 0; revision < 4; revision++ {
		content := []byte(fmt.Sprintf("version-%d", revision))
		hash := sha256.Sum256(content)
		workspace, err = app.patchAgentWorkspace(ctx, userID, workspace.WorkspaceID, workspace.Revision, []agentWorkspaceFile{{
			Path: "skills/history.md", Content: content, MimeType: "text/markdown", SHA256: hex.EncodeToString(hash[:]),
		}}, nil)
		if err != nil {
			t.Fatalf("patch revision %d: %v", revision, err)
		}
	}
	var commitsBefore int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM agent_workspace_commits WHERE workspace_id = $1`, workspace.WorkspaceID).Scan(&commitsBefore); err != nil {
		t.Fatalf("count commits before pruning: %v", err)
	}
	if commitsBefore < 5 {
		t.Fatalf("commits before pruning = %d, want at least 5", commitsBefore)
	}
	if _, err := pool.Exec(ctx, `SELECT prune_agent_workspace_quota_history($1, 1)`, workspace.WorkspaceID); err != nil {
		t.Fatalf("prune quota history: %v", err)
	}
	var commitsAfter, blobsAfter int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM agent_workspace_commits WHERE workspace_id = $1`, workspace.WorkspaceID).Scan(&commitsAfter); err != nil {
		t.Fatalf("count commits after pruning: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM agent_workspace_blobs WHERE workspace_id = $1`, workspace.WorkspaceID).Scan(&blobsAfter); err != nil {
		t.Fatalf("count blobs after pruning: %v", err)
	}
	if commitsAfter != 1 || blobsAfter != 2 {
		t.Fatalf("after pruning commits=%d blobs=%d, want one newest snapshot plus README", commitsAfter, blobsAfter)
	}
	if _, err := pool.Exec(ctx, `SELECT prune_agent_workspace_history($1, 1)`, workspace.WorkspaceID); err != nil {
		t.Fatalf("prune workspace history: %v", err)
	}
}

func TestAgentWorkspaceQuotaPruningOnlyTouchesWrittenWorkspace(t *testing.T) {
	pool, userID := newCreditTestUser(t)
	ctx := context.Background()
	app := &App{db: pool, cfg: config.Config{AppURL: "https://koinote.example"}}
	writeVersions := func(name string) agentWorkspaceView {
		workspace, err := app.createAgentWorkspace(ctx, userID, name, "", "en")
		if err != nil {
			t.Fatalf("create %s: %v", name, err)
		}
		for revision := 0; revision < 3; revision++ {
			content := []byte(fmt.Sprintf("%s-version-%d", name, revision))
			hash := sha256.Sum256(content)
			workspace, err = app.patchAgentWorkspace(ctx, userID, workspace.WorkspaceID, workspace.Revision, []agentWorkspaceFile{{
				Path: "skills/history.md", Content: content, MimeType: "text/markdown", SHA256: hex.EncodeToString(hash[:]),
			}}, nil)
			if err != nil {
				t.Fatalf("patch %s revision %d: %v", name, revision, err)
			}
		}
		return workspace
	}
	countCommits := func(workspaceID int64) int {
		var count int
		if err := pool.QueryRow(ctx, `SELECT count(*) FROM agent_workspace_commits WHERE workspace_id = $1`, workspaceID).Scan(&count); err != nil {
			t.Fatalf("count commits: %v", err)
		}
		return count
	}
	first := writeVersions("Quota A")
	second := writeVersions("Quota B")
	secondBefore := countCommits(second.WorkspaceID)

	// 预算充足时什么都不删。
	if _, err := pool.Exec(ctx, `SELECT prune_agent_workspace_quota_history($1, $2)`, first.WorkspaceID, int64(1)<<40); err != nil {
		t.Fatalf("prune with large budget: %v", err)
	}
	if got := countCommits(first.WorkspaceID); got < 4 {
		t.Fatalf("large budget pruned history: commits=%d", got)
	}

	if _, err := pool.Exec(ctx, `SELECT prune_agent_workspace_quota_history($1, 1)`, first.WorkspaceID); err != nil {
		t.Fatalf("prune quota history: %v", err)
	}
	if got := countCommits(first.WorkspaceID); got != 1 {
		t.Fatalf("written workspace commits after prune = %d, want only newest", got)
	}
	if got := countCommits(second.WorkspaceID); got != secondBefore {
		t.Fatalf("other workspace commits changed from %d to %d", secondBefore, got)
	}
}

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

func TestAgentWorkspaceSensitiveOverrideIsNotAvailableToAgentTokens(t *testing.T) {
	for _, token := range []string{"knt_mcp_example", "knt_agent_example"} {
		req := httptest.NewRequest(http.MethodPatch, "/api/agent/workspace", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		if agentWorkspaceSensitiveOverrideAllowed(req) {
			t.Fatalf("token %q can bypass sensitive-data validation", token)
		}
	}
	for _, request := range []*http.Request{
		httptest.NewRequest(http.MethodPatch, "/api/agent/workspace", nil),
		func() *http.Request {
			req := httptest.NewRequest(http.MethodPatch, "/api/agent/workspace", nil)
			req.Header.Set("Authorization", "Bearer desktop-access-token")
			return req
		}(),
	} {
		if !agentWorkspaceSensitiveOverrideAllowed(request) {
			t.Fatal("user-facing session cannot opt into explicit sensitive-data confirmation")
		}
	}
}

func TestValidateAgentWorkspaceFilesRejectsCommonSecretFormats(t *testing.T) {
	for _, content := range []string{
		`cookie: "session-cookie-value-1234"`,
		`Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456`,
		`token: "sk-abcdefghijklmnopqrstuvwxyz123456"`,
		`cookie: "my-consent-secret-123456"`,
		`password: "prefixconsentsuffix123456"`,
	} {
		_, err := validateAgentWorkspaceFiles([]agentWorkspaceFileInput{{
			Path: "settings/agent.yaml", ContentBase64: base64.StdEncoding.EncodeToString([]byte(content)),
		}})
		if err == nil || !strings.Contains(err.Error(), "redact") {
			t.Fatalf("secret format accepted: %q (%v)", content, err)
		}
	}
}

func TestValidateAgentWorkspaceFilesAllowsDocumentationExamples(t *testing.T) {
	for _, content := range []string{
		`apiKey: process.env.OPENAI_API_KEY`,
		`STRIPE_API_KEY: SecretsStoreSecret`,
		`API_KEY=your_global_api_key`,
		`document.cookie = 'cookie_consent'`,
	} {
		if _, err := validateAgentWorkspaceFiles([]agentWorkspaceFileInput{{
			Path: "skills/example.md", ContentBase64: base64.StdEncoding.EncodeToString([]byte(content)),
		}}); err != nil {
			t.Fatalf("documentation example rejected: %q (%v)", content, err)
		}
	}
}

func TestAgentWorkspaceSensitiveContentFixtures(t *testing.T) {
	contents, err := os.ReadFile("testdata/agent_workspace_sensitive_content.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Name      string `json:"name"`
		Content   string `json:"content"`
		Sensitive bool   `json:"sensitive"`
	}
	if err := json.Unmarshal(contents, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			_, err := validateAgentWorkspaceFiles([]agentWorkspaceFileInput{{
				Path:          "skills/cloudflare/references/zaraz/gotchas.md",
				ContentBase64: base64.StdEncoding.EncodeToString([]byte(fixture.Content)),
			}})
			var sensitive *agentWorkspaceSensitiveError
			if got := errors.As(err, &sensitive); got != fixture.Sensitive || (!fixture.Sensitive && err != nil) {
				t.Fatalf("sensitive = %t, want %t; error = %v", got, fixture.Sensitive, err)
			}
		})
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

func TestValidateAgentWorkspaceFilesAllowsMoreThanTwoHundredFiles(t *testing.T) {
	content := base64.StdEncoding.EncodeToString([]byte("portable skill"))
	inputs := make([]agentWorkspaceFileInput, 201)
	for index := range inputs {
		inputs[index] = agentWorkspaceFileInput{
			Path:          fmt.Sprintf("skills/skill-%03d/SKILL.md", index),
			ContentBase64: content,
		}
	}
	files, err := validateAgentWorkspaceFiles(inputs)
	if err != nil {
		t.Fatalf("more than 200 files rejected: %v", err)
	}
	if len(files) != len(inputs) {
		t.Fatalf("validated %d files, want %d", len(files), len(inputs))
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
		"KOINOTE_AGENT_TOKEN",
		"Authorization: Bearer $KOINOTE_AGENT_TOKEN",
		"Streamable HTTP",
		"expectedRevision",
		"redact sensitive values",
		"do not execute scripts",
		"My Space > Settings",
		"without a token",
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
		"One-click upload local Agent content",
		"Recommended: one-click upload from the desktop app",
		"Claude Code",
		"API keys",
		"https://koinote.example/mcp",
	} {
		if !strings.Contains(readme, want) {
			t.Errorf("README missing %q", want)
		}
	}
	if strings.Index(readme, "Recommended: one-click upload from the desktop app") > strings.Index(readme, "Alternative: connect an Agent through MCP") || strings.Index(readme, "Alternative: connect an Agent through MCP") > strings.Index(readme, "Import a folder manually") {
		t.Error("README guidance is not ordered client upload, MCP, then manual import")
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
		{locale: "en", want: "Recommended: one-click upload from the desktop app"},
		{locale: "zh", want: "首选方式：通过客户端一键上传"},
		{locale: "fr", want: "Méthode recommandée : import en un clic depuis l’application de bureau"},
		{locale: "ja", want: "おすすめ：デスクトップアプリからワンクリックでアップロード"},
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
	overridePayload := `{"expectedRevision":1,"allowSensitive":true,"upsert":[{"path":"settings.json","contentBase64":"YXBpX2tleTogc2stZXhhbXBsZS0xMjM0NTY3ODkw"}]}`
	override := callLLMChannelAPI(t, app, cookie, http.MethodPatch, "/api/agent/workspace", overridePayload)
	if override.Code != http.StatusOK {
		t.Fatalf("explicit sensitive workspace update status=%d body=%s", override.Code, override.Body.String())
	}

	updatedContent := "name: revised\n"
	patchPayload := fmt.Sprintf(`{"expectedRevision":2,"upsert":[{"path":"skills/writing/SKILL.md","contentBase64":"%s","mimeType":"text/markdown"},{"path":"settings.json","contentBase64":"%s","mimeType":"application/json"}]}`,
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
	if patchedBody.Workspace.Revision != 3 || len(patchedBody.Workspace.Files) != 2 {
		t.Fatalf("patched workspace = %+v", patchedBody.Workspace)
	}

	deleteOnly := `{"expectedRevision":3,"delete":["settings.json"]}`
	deleted := callLLMChannelAPI(t, app, cookie, http.MethodPatch, "/api/agent/workspace", deleteOnly)
	if deleted.Code != http.StatusOK {
		t.Fatalf("delete-only patch status=%d body=%s", deleted.Code, deleted.Body.String())
	}
	var deletedBody struct {
		Workspace agentWorkspaceView `json:"workspace"`
	}
	decodeJSONResponse(t, deleted, &deletedBody)
	if deletedBody.Workspace.Revision != 4 || len(deletedBody.Workspace.Files) != 1 || deletedBody.Workspace.Files[0].Path != "skills/writing/SKILL.md" {
		t.Fatalf("delete-only workspace = %+v", deletedBody.Workspace)
	}

	stalePatch := `{"expectedRevision":3,"delete":["skills/writing/SKILL.md"]}`
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
