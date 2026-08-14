package server

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/modelcontextprotocol/go-sdk/mcp"

	"koinote/backend/internal/config"
	"koinote/backend/internal/model"
)

func TestMCPRequiresBearerTokenBeforeDatabaseAccess(t *testing.T) {
	app := newTestApp(config.Config{AppURL: "https://koinote.app"})
	req := httptest.NewRequest(http.MethodPost, "/mcp", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"initialize"}`))
	rec := httptest.NewRecorder()
	app.Routes().ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("无 bearer token 期望 401，实际 %d（%s）", rec.Code, rec.Body.String())
	}
	if got := rec.Header().Get("WWW-Authenticate"); !strings.Contains(got, "Bearer") {
		t.Fatalf("401 必须声明 Bearer 认证，实际 %q", got)
	}
}

func TestMCPTokenEncryptionKeyIsolation(t *testing.T) {
	development := newTestApp(config.Config{SessionSecret: "development-session"})
	ciphertext, err := development.encryptMCPToken("token-a", "knt_mcp_secret")
	if err != nil {
		t.Fatalf("开发环境应回退到会话密钥: %v", err)
	}
	if plain, err := development.decryptMCPToken("token-a", ciphertext); err != nil || plain != "knt_mcp_secret" {
		t.Fatalf("同一 token ID 解密失败: plain=%q err=%v", plain, err)
	}
	if _, err := development.decryptMCPToken("token-b", ciphertext); err == nil {
		t.Fatal("密文不得被替换到另一 token ID 后继续解密")
	}

	productionWithoutKey := newTestApp(config.Config{NodeEnv: "production", SessionSecret: "session-only"})
	if _, err := productionWithoutKey.encryptMCPToken("token-a", "knt_mcp_secret"); err == nil {
		t.Fatal("生产环境不得回退复用 SESSION_SECRET")
	}

	production := newTestApp(config.Config{
		NodeEnv: "production", SessionSecret: "session", MCPTokenEncryptionKey: "mcp-key",
	})
	if _, err := production.decryptMCPToken("token-a", ciphertext); err == nil {
		t.Fatal("不同加密密钥不得解开密文")
	}
}

func TestMCPTokenExpiryValidation(t *testing.T) {
	tests := []struct {
		name       string
		input      mcpTokenExpiryInput
		useDefault bool
		valid      bool
		permanent  bool
	}{
		{name: "创建默认九十天", useDefault: true, valid: true},
		{name: "永久", input: mcpTokenExpiryInput{NeverExpires: true}, valid: true, permanent: true},
		{name: "三十天", input: mcpTokenExpiryInput{ExpiresInDays: 30}, valid: true},
		{name: "更新不接受空值", valid: false},
		{name: "超过一年", input: mcpTokenExpiryInput{ExpiresInDays: 366}, valid: false},
		{name: "永久不能同时带天数", input: mcpTokenExpiryInput{ExpiresInDays: 30, NeverExpires: true}, valid: false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			expiresAt, valid := mcpTokenExpiry(tc.input, tc.useDefault)
			if valid != tc.valid {
				t.Fatalf("valid = %v，期望 %v", valid, tc.valid)
			}
			if !valid {
				return
			}
			if tc.permanent != (expiresAt == nil) {
				t.Fatalf("expiresAt = %v，permanent 期望 %v", expiresAt, tc.permanent)
			}
		})
	}
}

func TestMCPOriginValidation(t *testing.T) {
	app := newTestApp(config.Config{AppURL: "https://koinote.app"})
	cases := []struct {
		name   string
		origin string
		allow  bool
	}{
		{name: "非浏览器客户端无 Origin", allow: true},
		{name: "本站", origin: "https://koinote.app", allow: true},
		{name: "本站端口不同", origin: "https://koinote.app:444", allow: false},
		{name: "恶意站点", origin: "https://evil.example", allow: false},
		{name: "userinfo", origin: "https://user@koinote.app", allow: false},
		{name: "非法 URL", origin: "://bad", allow: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/mcp", nil)
			if tc.origin != "" {
				req.Header.Set("Origin", tc.origin)
			}
			if got := app.validMCPOrigin(req); got != tc.allow {
				t.Fatalf("validMCPOrigin(%q) = %v，期望 %v", tc.origin, got, tc.allow)
			}
		})
	}
}

func TestMCPScopeControlsExposedTools(t *testing.T) {
	readTools := listInMemoryMCPTools(t, mcpPrincipal{Scope: "read"})
	wantRead := []string{
		"get_document",
		"get_document_history_settings",
		"get_document_version",
		"list_document_versions",
		"list_documents",
		"list_trashed_documents",
		"search_documents",
	}
	if !slices.Equal(readTools, wantRead) {
		t.Fatalf("read scope 工具 = %v，期望 %v", readTools, wantRead)
	}

	writeTools := listInMemoryMCPTools(t, mcpPrincipal{Scope: "write"})
	wantWrite := append(slices.Clone(wantRead),
		"append_to_document", "create_document", "restore_document_version", "restore_trashed_document", "trash_document", "update_document", "update_document_history_settings")
	slices.Sort(wantWrite)
	if !slices.Equal(writeTools, wantWrite) {
		t.Fatalf("write scope 工具 = %v，期望 %v", writeTools, wantWrite)
	}
	if slices.Contains(writeTools, "delete_document") || slices.Contains(writeTools, "permanently_delete_document") {
		t.Fatal("MCP 不得暴露永久删除工具")
	}
}

func TestMCPUpdateThemeIsOptional(t *testing.T) {
	ctx := context.Background()
	serverTransport, clientTransport := mcp.NewInMemoryTransports()
	server := newTestApp(config.Config{AppURL: "https://koinote.app"}).newMCPServer(mcpPrincipal{Scope: "write"})
	serverSession, err := server.Connect(ctx, serverTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = serverSession.Close() })
	client := mcp.NewClient(&mcp.Implementation{Name: "koinote-schema-test", Version: "1.0.0"}, nil)
	clientSession, err := client.Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = clientSession.Close() })
	result, err := clientSession.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, tool := range result.Tools {
		if tool.Name != "update_document" {
			continue
		}
		encoded, err := json.Marshal(tool.InputSchema)
		if err != nil {
			t.Fatal(err)
		}
		var schema struct {
			Required   []string                   `json:"required"`
			Properties map[string]json.RawMessage `json:"properties"`
		}
		if err := json.Unmarshal(encoded, &schema); err != nil {
			t.Fatalf("解析 update_document 输入 schema: %v（%s）", err, encoded)
		}
		for _, required := range schema.Required {
			if required == "theme" {
				t.Fatal("update_document.theme 必须可省略；省略表示保留现有主题")
			}
		}
		if _, ok := schema.Properties["theme"]; !ok {
			t.Fatal("update_document 输入 schema 缺少 theme 属性")
		}
		return
	}
	t.Fatal("write scope 缺少 update_document")
}

func TestMCPUpdateRejectsUnknownTheme(t *testing.T) {
	_, err := validateMCPDocumentTheme("unknown-theme")
	if err == nil || !strings.Contains(err.Error(), "not a supported") {
		t.Fatalf("未知主题应被拒绝，实际 %v", err)
	}
}

func TestMCPChunkingUsesUnicodeCharacters(t *testing.T) {
	content, offset, next, total, more, err := chunkText("甲🙂乙abc", 1, 3)
	if err != nil {
		t.Fatal(err)
	}
	if content != "🙂乙a" || offset != 1 || next != 4 || total != 6 || !more {
		t.Fatalf("Unicode 分段错误: content=%q offset=%d next=%d total=%d more=%v",
			content, offset, next, total, more)
	}
	if _, _, _, _, _, err := chunkText("abc", 4, 1); err == nil {
		t.Fatal("offset 超过正文长度必须报错")
	}
}

func TestDocumentVersionSnapshotPolicy(t *testing.T) {
	now := time.Now()
	recent := now.Add(-webVersionSnapshotInterval + time.Second)
	old := now.Add(-webVersionSnapshotInterval)
	settings := documentHistorySettings{Enabled: true, MCPEnabled: true, Available: true}
	if mode := documentVersionModeForMutation(settings, documentSourceMCP, true, &recent, now, false); mode != documentVersionFull {
		t.Fatalf("MCP 完整历史模式 = %v，期望 full", mode)
	}
	if mode := documentVersionModeForMutation(settings, documentSourceWeb, false, &recent, now, false); mode != documentVersionNone {
		t.Fatalf("网页五分钟节流期间模式 = %v，期望 none", mode)
	}
	if mode := documentVersionModeForMutation(settings, documentSourceWeb, false, &old, now, false); mode != documentVersionFull {
		t.Fatalf("网页满五分钟后模式 = %v，期望 full", mode)
	}
	if mode := documentVersionModeForMutation(settings, documentSourceWeb, false, nil, now, false); mode != documentVersionFull {
		t.Fatalf("网页首次覆盖前模式 = %v，期望 full", mode)
	}
	settings.Enabled = false
	if mode := documentVersionModeForMutation(settings, documentSourceWeb, false, nil, now, true); mode != documentVersionNone {
		t.Fatalf("关闭历史后网页强制快照模式 = %v，期望 none", mode)
	}
	if mode := documentVersionModeForMutation(settings, documentSourceMCP, true, nil, now, false); mode != documentVersionSafety {
		t.Fatalf("关闭全部历史后 MCP 模式 = %v，期望 safety", mode)
	}
	settings.Enabled = true
	settings.MCPEnabled = false
	if mode := documentVersionModeForMutation(settings, documentSourceMCP, true, nil, now, false); mode != documentVersionSafety {
		t.Fatalf("关闭 MCP 完整历史后 Agent 模式 = %v，期望 safety", mode)
	}
	if mode := documentVersionModeForMutation(settings, documentSourceRestore, false, nil, now, false); mode != documentVersionFull {
		t.Fatalf("网页恢复模式 = %v，期望 full", mode)
	}
	if mode := documentVersionModeForMutation(settings, documentSourceRestore, true, nil, now, false); mode != documentVersionSafety {
		t.Fatalf("Agent 恢复模式 = %v，期望 safety", mode)
	}
	settings.Available = false
	if mode := documentVersionModeForMutation(settings, documentSourceMCP, true, nil, now, false); mode != documentVersionNone {
		t.Fatalf("非会员 MCP 模式 = %v，期望 none", mode)
	}
}

func TestMCPDocumentsEndToEnd(t *testing.T) {
	pool := newGCTestPool(t)
	app := New(config.Config{
		SessionSecret: "mcp-test-session-secret",
		AppURL:        "http://127.0.0.1",
	}, pool)
	server := httptest.NewServer(app.Routes())
	t.Cleanup(server.Close)

	lifetime := seedMCPUser(t, pool, app, membershipTierLifetime)
	otherLifetime := seedMCPUser(t, pool, app, membershipTierLifetime)
	free := seedMCPUser(t, pool, app, membershipTierFree)
	lifetimeCookie := mcpSessionCookie(app, lifetime.AuthUserID)
	otherLifetimeCookie := mcpSessionCookie(app, otherLifetime.AuthUserID)
	freeCookie := mcpSessionCookie(app, free.AuthUserID)

	t.Run("免费用户不能创建令牌", func(t *testing.T) {
		response := requestMCPTokenAPI(t, server.Client(), http.MethodPost, server.URL+"/api/mcp/tokens", freeCookie,
			map[string]any{"name": "Codex", "scope": "write", "expiresInDays": 90})
		defer response.Body.Close()
		if response.StatusCode != http.StatusForbidden {
			t.Fatalf("免费用户创建 PAT 期望 403，实际 %d", response.StatusCode)
		}
		if code := decodeHTTPErrorCode(t, response); code != "membership_required" {
			t.Fatalf("错误码 = %q，期望 membership_required", code)
		}
	})

	writeToken := createMCPTokenForTest(t, server, lifetimeCookie, "Codex", "write")
	readToken := createMCPTokenForTest(t, server, lifetimeCookie, "Claude", "read")
	otherReadToken := createMCPTokenForTest(t, server, otherLifetimeCookie, "Other", "read")

	t.Run("创建永久令牌并编辑有效期", func(t *testing.T) {
		response := requestMCPTokenAPI(t, server.Client(), http.MethodPost, server.URL+"/api/mcp/tokens", lifetimeCookie,
			map[string]any{"name": "Permanent", "scope": "read", "neverExpires": true})
		defer response.Body.Close()
		if response.StatusCode != http.StatusCreated {
			t.Fatalf("创建永久令牌期望 201，实际 %d", response.StatusCode)
		}
		var created createdMCPToken
		if err := json.NewDecoder(response.Body).Decode(&created); err != nil {
			t.Fatal(err)
		}
		if created.Token.ExpiresAt != nil {
			t.Fatalf("永久令牌 expiresAt = %v，期望 nil", created.Token.ExpiresAt)
		}

		response = requestMCPTokenAPI(t, server.Client(), http.MethodPatch,
			server.URL+"/api/mcp/tokens/"+created.Token.TokenID, lifetimeCookie,
			map[string]any{"expiresInDays": 30})
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			t.Fatalf("永久改为 30 天期望 200，实际 %d", response.StatusCode)
		}
		var updated struct {
			Token mcpTokenView `json:"token"`
		}
		if err := json.NewDecoder(response.Body).Decode(&updated); err != nil {
			t.Fatal(err)
		}
		if updated.Token.ExpiresAt == nil || time.Until(*updated.Token.ExpiresAt) < 29*24*time.Hour {
			t.Fatalf("更新后的到期时间异常: %v", updated.Token.ExpiresAt)
		}

		response = requestMCPTokenAPI(t, server.Client(), http.MethodPatch,
			server.URL+"/api/mcp/tokens/"+created.Token.TokenID, lifetimeCookie,
			map[string]any{"neverExpires": true})
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			t.Fatalf("改回永久期望 200，实际 %d", response.StatusCode)
		}
		if err := json.NewDecoder(response.Body).Decode(&updated); err != nil {
			t.Fatal(err)
		}
		if updated.Token.ExpiresAt != nil {
			t.Fatalf("改回永久后 expiresAt = %v，期望 nil", updated.Token.ExpiresAt)
		}
	})

	t.Run("不能编辑其他账号令牌有效期", func(t *testing.T) {
		response := requestMCPTokenAPI(t, server.Client(), http.MethodPatch,
			server.URL+"/api/mcp/tokens/"+writeToken.Token.TokenID, otherLifetimeCookie,
			map[string]any{"neverExpires": true})
		defer response.Body.Close()
		if response.StatusCode != http.StatusNotFound {
			t.Fatalf("跨账号编辑有效期期望 404，实际 %d", response.StatusCode)
		}
	})

	t.Run("拒绝冲突或非法有效期", func(t *testing.T) {
		for _, body := range []map[string]any{
			{"expiresInDays": 0},
			{"expiresInDays": 366},
			{"expiresInDays": 30, "neverExpires": true},
		} {
			response := requestMCPTokenAPI(t, server.Client(), http.MethodPatch,
				server.URL+"/api/mcp/tokens/"+writeToken.Token.TokenID, lifetimeCookie, body)
			defer response.Body.Close()
			if response.StatusCode != http.StatusBadRequest || decodeHTTPErrorCode(t, response) != "invalid_token_expiry" {
				t.Fatalf("非法有效期 %#v 期望 400 invalid_token_expiry，实际 %d", body, response.StatusCode)
			}
		}
	})

	t.Run("令牌用摘要鉴权并加密保存恢复副本", func(t *testing.T) {
		var storedHash, ciphertext []byte
		if err := pool.QueryRow(context.Background(), `
			SELECT token_hash, token_ciphertext FROM mcp_tokens WHERE token_id = $1
		`, writeToken.Token.TokenID).Scan(&storedHash, &ciphertext); err != nil {
			t.Fatalf("读取 token 存储值: %v", err)
		}
		want := sha256.Sum256([]byte(writeToken.Secret))
		if !bytes.Equal(storedHash, want[:]) {
			t.Fatalf("数据库没有保存预期 SHA-256: got=%x want=%x", storedHash, want)
		}
		if bytes.Contains(storedHash, []byte(writeToken.Secret)) || bytes.Contains(ciphertext, []byte(writeToken.Secret)) {
			t.Fatal("数据库不得保存明文令牌")
		}
		decrypted, err := app.decryptMCPToken(writeToken.Token.TokenID, ciphertext)
		if err != nil || decrypted != writeToken.Secret {
			t.Fatalf("恢复加密令牌失败: decrypted=%q err=%v", decrypted, err)
		}
	})

	t.Run("账号本人可以重复查看完整令牌", func(t *testing.T) {
		for attempt := 0; attempt < 2; attempt++ {
			response := requestMCPTokenAPI(t, server.Client(), http.MethodPost,
				server.URL+"/api/mcp/tokens/"+writeToken.Token.TokenID+"/reveal", lifetimeCookie, nil)
			defer response.Body.Close()
			if response.StatusCode != http.StatusOK || response.Header.Get("Cache-Control") != "no-store" {
				t.Fatalf("第 %d 次查看期望 200/no-store，实际 %d/%q", attempt+1, response.StatusCode, response.Header.Get("Cache-Control"))
			}
			var result struct {
				Secret string `json:"secret"`
			}
			if err := json.NewDecoder(response.Body).Decode(&result); err != nil || result.Secret != writeToken.Secret {
				t.Fatalf("第 %d 次查看返回异常: result=%+v err=%v", attempt+1, result, err)
			}
		}
	})

	t.Run("不能查看其他账号的令牌", func(t *testing.T) {
		response := requestMCPTokenAPI(t, server.Client(), http.MethodPost,
			server.URL+"/api/mcp/tokens/"+writeToken.Token.TokenID+"/reveal", otherLifetimeCookie, nil)
		defer response.Body.Close()
		if response.StatusCode != http.StatusNotFound {
			t.Fatalf("跨账号查看期望 404，实际 %d", response.StatusCode)
		}
	})

	t.Run("旧令牌保持可用但无法恢复", func(t *testing.T) {
		plain := mcpTokenPrefix + strings.Repeat("e", 64)
		hash := sha256.Sum256([]byte(plain))
		legacyID := "legacy-" + lifetime.AuthUserID
		if _, err := pool.Exec(context.Background(), `
			INSERT INTO mcp_tokens (token_id, user_id, name, token_hash, token_hint, scope, expires_at)
			VALUES ($1, $2, 'legacy', $3, '…eeeeeeee', 'read', now() + interval '1 day')
		`, legacyID, lifetime.ID, hash[:]); err != nil {
			t.Fatalf("插入旧令牌: %v", err)
		}
		response := requestMCPTokenAPI(t, server.Client(), http.MethodPost,
			server.URL+"/api/mcp/tokens/"+legacyID+"/reveal", lifetimeCookie, nil)
		defer response.Body.Close()
		if response.StatusCode != http.StatusConflict || decodeHTTPErrorCode(t, response) != "mcp_token_not_revealable" {
			t.Fatalf("旧令牌查看期望 409 mcp_token_not_revealable，实际 %d", response.StatusCode)
		}
	})

	t.Run("非会员令牌即使存在也不能认证", func(t *testing.T) {
		plain := mcpTokenPrefix + strings.Repeat("f", 64)
		hash := sha256.Sum256([]byte(plain))
		if _, err := pool.Exec(context.Background(), `
			INSERT INTO mcp_tokens (token_id, user_id, name, token_hash, token_hint, scope, expires_at)
			VALUES ($1, $2, 'forged-free', $3, '…ffffffff', 'write', now() + interval '1 day')
		`, "token-free-"+free.AuthUserID, free.ID, hash[:]); err != nil {
			t.Fatalf("插入免费用户测试令牌: %v", err)
		}
		if _, err := connectMCPClient(context.Background(), server.URL+"/mcp", plain); err == nil {
			t.Fatal("免费用户的 PAT 不得建立 MCP 会话")
		}
	})

	readSession, err := connectMCPClient(context.Background(), server.URL+"/mcp", readToken.Secret)
	if err != nil {
		t.Fatalf("read MCP 握手失败: %v", err)
	}
	t.Cleanup(func() { _ = readSession.Close() })
	assertMCPToolSet(t, readSession, []string{
		"get_document", "get_document_history_settings", "get_document_version", "list_document_versions",
		"list_documents", "list_trashed_documents", "search_documents",
	})

	writeSession, err := connectMCPClient(context.Background(), server.URL+"/mcp", writeToken.Secret)
	if err != nil {
		t.Fatalf("write MCP 握手失败: %v", err)
	}
	t.Cleanup(func() { _ = writeSession.Close() })
	assertMCPToolSet(t, writeSession, []string{
		"append_to_document", "create_document", "get_document", "get_document_history_settings", "get_document_version",
		"list_document_versions", "list_documents", "list_trashed_documents", "restore_document_version",
		"restore_trashed_document", "search_documents", "trash_document", "update_document",
		"update_document_history_settings",
	})
	otherReadSession, err := connectMCPClient(context.Background(), server.URL+"/mcp", otherReadToken.Secret)
	if err != nil {
		t.Fatalf("其他用户 read MCP 握手失败: %v", err)
	}
	t.Cleanup(func() { _ = otherReadSession.Close() })

	ctx := context.Background()
	historySettingsResult := callMCPToolOK(t, readSession, "get_document_history_settings", map[string]any{})
	var historySettings documentHistorySettings
	decodeMCPStructured(t, historySettingsResult, &historySettings)
	if !historySettings.Enabled || !historySettings.MCPEnabled || historySettings.PerDocumentMax != defaultDocumentHistoryLimit {
		t.Fatalf("MCP 读取历史设置异常: %+v", historySettings)
	}
	updatedHistorySettingsResult := callMCPToolOK(t, writeSession, "update_document_history_settings", map[string]any{
		"enabled": true, "perDocumentMax": 20, "mcpEnabled": true,
	})
	decodeMCPStructured(t, updatedHistorySettingsResult, &historySettings)
	if !historySettings.Enabled || !historySettings.MCPEnabled || historySettings.PerDocumentMax != 20 {
		t.Fatalf("MCP 更新历史设置异常: %+v", historySettings)
	}

	createdResult := callMCPToolOK(t, writeSession, "create_document", map[string]any{
		"title": "MCP 集成测试", "content": "甲🙂乙\n\n初始内容",
	})
	var created mcpDocumentMutationOutput
	decodeMCPStructured(t, createdResult, &created)
	if created.DocID == "" || created.Revision != 1 {
		t.Fatalf("新建结果异常: %+v", created)
	}
	otherUserRead := callMCPTool(t, otherReadSession, "get_document", map[string]any{"docId": created.DocID})
	if !otherUserRead.IsError || !strings.Contains(mcpResultText(otherUserRead), "not found") {
		t.Fatalf("其他用户不得读取本账号文档: %s", mcpResultText(otherUserRead))
	}
	otherDocument, err := app.createDocument(ctx, createDocumentParams{
		User: otherLifetime, Title: "其他账号私有文档", Content: "private",
	})
	if err != nil {
		t.Fatalf("创建其他账号文档: %v", err)
	}
	ownerReadOther := callMCPTool(t, readSession, "get_document", map[string]any{"docId": otherDocument.DocID})
	if !ownerReadOther.IsError || !strings.Contains(mcpResultText(ownerReadOther), "not found") {
		t.Fatalf("本账号不得读取其他用户文档: %s", mcpResultText(ownerReadOther))
	}

	chunkResult := callMCPToolOK(t, readSession, "get_document", map[string]any{
		"docId": created.DocID, "offset": 1, "limit": 3,
	})
	var chunk mcpDocumentChunk
	decodeMCPStructured(t, chunkResult, &chunk)
	if chunk.Content != "🙂乙\n" || chunk.NextOffset != 4 || !chunk.HasMore || chunk.Revision != 1 {
		t.Fatalf("分段读取异常: %+v", chunk)
	}

	updatedContent := "甲🙂乙\n\n由 MCP 更新"
	updatedResult := callMCPToolOK(t, writeSession, "update_document", map[string]any{
		"docId": created.DocID, "expectedRevision": 1, "title": "MCP 集成测试",
		"content": updatedContent, "theme": "minimal",
	})
	var updated mcpDocumentMutationOutput
	decodeMCPStructured(t, updatedResult, &updated)
	if updated.Revision != 2 {
		t.Fatalf("更新 revision = %d，期望 2", updated.Revision)
	}

	// 请求已成功但客户端丢了响应时，会用旧 revision 重试完全相同的内容。
	// 这必须幂等返回当前 revision，不能把网络抖动变成永久冲突。
	retryResult := callMCPToolOK(t, writeSession, "update_document", map[string]any{
		"docId": created.DocID, "expectedRevision": 1, "title": "MCP 集成测试",
		"content": updatedContent, "theme": "minimal",
	})
	var retried mcpDocumentMutationOutput
	decodeMCPStructured(t, retryResult, &retried)
	if retried.Revision != 2 {
		t.Fatalf("幂等重试 revision = %d，期望仍为 2", retried.Revision)
	}

	conflict := callMCPTool(t, writeSession, "update_document", map[string]any{
		"docId": created.DocID, "expectedRevision": 1, "title": "冲突写入",
		"content": "不能覆盖", "theme": "minimal",
	})
	if !conflict.IsError || !strings.Contains(mcpResultText(conflict), "revision conflict") {
		t.Fatalf("旧 revision 应得到可自修正的工具错误，实际 error=%v text=%q",
			conflict.IsError, mcpResultText(conflict))
	}

	versionsResult := callMCPToolOK(t, readSession, "list_document_versions", map[string]any{
		"docId": created.DocID,
	})
	var versions mcpVersionPage
	decodeMCPStructured(t, versionsResult, &versions)
	if len(versions.Versions) != 1 || versions.Versions[0].Revision != 1 || versions.Versions[0].Source != "mcp" {
		t.Fatalf("首次 MCP 更新应保留 revision 1，实际 %+v", versions.Versions)
	}

	oldVersionResult := callMCPToolOK(t, readSession, "get_document_version", map[string]any{
		"docId": created.DocID, "revision": 1, "offset": 0, "limit": 100,
	})
	var oldVersion mcpVersionChunk
	decodeMCPStructured(t, oldVersionResult, &oldVersion)
	if oldVersion.Content != "甲🙂乙\n\n初始内容" {
		t.Fatalf("历史正文 = %q", oldVersion.Content)
	}

	restoredResult := callMCPToolOK(t, writeSession, "restore_document_version", map[string]any{
		"docId": created.DocID, "revision": 1, "expectedRevision": 2,
	})
	var restored mcpDocumentMutationOutput
	decodeMCPStructured(t, restoredResult, &restored)
	if restored.Revision != 3 {
		t.Fatalf("恢复后 revision = %d，期望 3", restored.Revision)
	}

	appendedResult := callMCPToolOK(t, writeSession, "append_to_document", map[string]any{
		"docId": created.DocID, "expectedRevision": 3, "content": "追加内容",
	})
	var appended mcpDocumentMutationOutput
	decodeMCPStructured(t, appendedResult, &appended)
	if appended.Revision != 4 {
		t.Fatalf("追加后 revision = %d，期望 4", appended.Revision)
	}
	finalChunkResult := callMCPToolOK(t, readSession, "get_document", map[string]any{
		"docId": created.DocID, "limit": 100,
	})
	var finalChunk mcpDocumentChunk
	decodeMCPStructured(t, finalChunkResult, &finalChunk)
	if finalChunk.Content != "甲🙂乙\n\n初始内容\n\n追加内容" || finalChunk.Revision != 4 {
		t.Fatalf("追加结果异常: %+v", finalChunk)
	}

	searchResult := callMCPToolOK(t, readSession, "search_documents", map[string]any{"query": "集成", "limit": 10})
	var search mcpDocumentPage
	decodeMCPStructured(t, searchResult, &search)
	if len(search.Documents) != 1 || search.Documents[0].DocID != created.DocID {
		t.Fatalf("标题搜索结果异常: %+v", search.Documents)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO documents (doc_id, user_id, title, content)
		VALUES ($1, $2, '其他用户文档', '这里也有追加内容，但不应被搜索到')
	`, "other-search-"+otherLifetime.AuthUserID, otherLifetime.ID); err != nil {
		t.Fatalf("插入跨用户搜索文档: %v", err)
	}
	bodySearchResult := callMCPToolOK(t, readSession, "search_documents", map[string]any{"query": "追加内容", "limit": 10})
	var bodySearch mcpDocumentPage
	decodeMCPStructured(t, bodySearchResult, &bodySearch)
	if len(bodySearch.Documents) != 1 || bodySearch.Documents[0].DocID != created.DocID ||
		bodySearch.Documents[0].TitleMatched || !bodySearch.Documents[0].ContentMatched ||
		!strings.Contains(bodySearch.Documents[0].Snippet, "追加内容") {
		t.Fatalf("正文搜索或跨用户隔离异常: %+v", bodySearch.Documents)
	}
	listResult := callMCPToolOK(t, readSession, "list_documents", map[string]any{"limit": 1})
	var list mcpDocumentPage
	decodeMCPStructured(t, listResult, &list)
	if len(list.Documents) != 1 || list.Documents[0].Revision != 4 {
		t.Fatalf("文档列表结果异常: %+v", list.Documents)
	}

	staleTrash := callMCPTool(t, writeSession, "trash_document", map[string]any{
		"docId": created.DocID, "expectedRevision": 3,
	})
	if !staleTrash.IsError || !strings.Contains(mcpResultText(staleTrash), "revision conflict") {
		t.Fatalf("旧 revision 移入回收站必须冲突: %s", mcpResultText(staleTrash))
	}
	trashedResult := callMCPToolOK(t, writeSession, "trash_document", map[string]any{
		"docId": created.DocID, "expectedRevision": 4,
	})
	var trashed mcpTrashedDocumentOutput
	decodeMCPStructured(t, trashedResult, &trashed)
	if trashed.DocID != created.DocID || trashed.Revision != 5 || trashed.DeletesAt == "" {
		t.Fatalf("移入回收站结果异常: %+v", trashed)
	}
	trashedSearchResult := callMCPToolOK(t, readSession, "search_documents", map[string]any{"query": "追加内容", "limit": 10})
	var trashedSearch mcpDocumentPage
	decodeMCPStructured(t, trashedSearchResult, &trashedSearch)
	if len(trashedSearch.Documents) != 0 {
		t.Fatalf("回收站文档不应出现在搜索结果: %+v", trashedSearch.Documents)
	}
	missing := callMCPTool(t, readSession, "get_document", map[string]any{"docId": created.DocID})
	if !missing.IsError || !strings.Contains(mcpResultText(missing), "not found") {
		t.Fatalf("回收站文档不应由普通读取返回: %s", mcpResultText(missing))
	}
	trashListResult := callMCPToolOK(t, readSession, "list_trashed_documents", map[string]any{"limit": 10})
	var trashList mcpTrashedDocumentPage
	decodeMCPStructured(t, trashListResult, &trashList)
	if len(trashList.Documents) != 1 || trashList.Documents[0].DocID != created.DocID {
		t.Fatalf("回收站列表异常: %+v", trashList.Documents)
	}
	restoredTrashResult := callMCPToolOK(t, writeSession, "restore_trashed_document", map[string]any{
		"docId": created.DocID, "expectedRevision": 5,
	})
	var restoredTrash mcpDocumentMutationOutput
	decodeMCPStructured(t, restoredTrashResult, &restoredTrash)
	if restoredTrash.Revision != 6 {
		t.Fatalf("回收站恢复 revision = %d，期望 6", restoredTrash.Revision)
	}
	preservedThemeResult := callMCPToolOK(t, writeSession, "update_document", map[string]any{
		"docId": created.DocID, "expectedRevision": 6, "title": "MCP 集成测试",
		"content": "省略 theme 时保留现有主题",
	})
	var preservedTheme mcpDocumentMutationOutput
	decodeMCPStructured(t, preservedThemeResult, &preservedTheme)
	if preservedTheme.Revision != 7 {
		t.Fatalf("省略 theme 更新 revision = %d，期望 7", preservedTheme.Revision)
	}
	var storedTheme string
	if err := pool.QueryRow(ctx, `SELECT theme FROM documents WHERE doc_id = $1`, created.DocID).Scan(&storedTheme); err != nil {
		t.Fatalf("读取省略后的 theme: %v", err)
	}
	if storedTheme != "minimal" {
		t.Fatalf("省略 theme 后主题 = %q，期望 minimal", storedTheme)
	}

	var successfulAudits int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM mcp_audit_logs
		WHERE user_id = $1 AND result = 'success'
	`, lifetime.ID).Scan(&successfulAudits); err != nil {
		t.Fatalf("读取 MCP 审计日志: %v", err)
	}
	if successfulAudits < 10 {
		t.Fatalf("成功调用审计日志仅 %d 条", successfulAudits)
	}
	var documentAudits int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM mcp_audit_logs
		WHERE user_id = $1 AND doc_id = $2
	`, lifetime.ID, created.DocID).Scan(&documentAudits); err != nil {
		t.Fatalf("读取文档审计标识: %v", err)
	}
	if documentAudits < 8 {
		t.Fatalf("带稳定 doc_id 的审计日志仅 %d 条", documentAudits)
	}

	t.Run("有效令牌上限", func(t *testing.T) {
		// 当前已有 write/read/legacy/permanent 四个，补到 20。过期令牌不占有效名额。
		for index := 0; index < mcpTokenMaxActive-4; index++ {
			plain := fmt.Sprintf("%s%064x", mcpTokenPrefix, index+1)
			hash := sha256.Sum256([]byte(plain))
			if _, err := pool.Exec(ctx, `
				INSERT INTO mcp_tokens (token_id, user_id, name, token_hash, token_hint, scope, expires_at)
				VALUES ($1, $2, $3, $4, '…00000000', 'read', now() + interval '1 day')
			`, fmt.Sprintf("limit-%s-%d", lifetime.AuthUserID, index), lifetime.ID,
				fmt.Sprintf("limit-%d", index), hash[:]); err != nil {
				t.Fatalf("补测试令牌 %d: %v", index, err)
			}
		}
		response := requestMCPTokenAPI(t, server.Client(), http.MethodPost, server.URL+"/api/mcp/tokens", lifetimeCookie,
			map[string]any{"name": "too-many", "scope": "read", "expiresInDays": 90})
		defer response.Body.Close()
		if response.StatusCode != http.StatusConflict {
			t.Fatalf("超过有效令牌上限期望 409，实际 %d", response.StatusCode)
		}
		if code := decodeHTTPErrorCode(t, response); code != "mcp_token_limit_reached" {
			t.Fatalf("错误码 = %q", code)
		}
	})

	t.Run("撤销立即失效", func(t *testing.T) {
		response := requestMCPTokenAPI(t, server.Client(), http.MethodDelete,
			server.URL+"/api/mcp/tokens/"+writeToken.Token.TokenID, lifetimeCookie, nil)
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			t.Fatalf("撤销令牌期望 200，实际 %d", response.StatusCode)
		}
		if _, err := writeSession.ListTools(ctx, nil); err == nil {
			t.Fatal("已建立的无状态 MCP 会话在令牌撤销后必须立即失效")
		}
	})
}

func TestDocumentCASAndVersionRetention(t *testing.T) {
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "document-version-test"}, pool)
	lifetime := seedMCPUser(t, pool, app, membershipTierLifetime)
	free := seedMCPUser(t, pool, app, membershipTierFree)
	ctx := context.Background()

	t.Run("并发更新只有一个成功", func(t *testing.T) {
		doc, err := app.createDocument(ctx, createDocumentParams{User: lifetime, Title: "CAS", Content: "base"})
		if err != nil {
			t.Fatal(err)
		}
		results := make(chan error, 2)
		var start sync.WaitGroup
		start.Add(1)
		for _, content := range []string{"first", "second"} {
			content := content
			go func() {
				start.Wait()
				_, err := app.updateDocument(ctx, updateDocumentParams{
					User: lifetime, DocID: doc.DocID, Title: doc.Title, Theme: doc.Theme,
					Content: content, ExpectedRevision: 1, Source: documentSourceMCP,
				})
				results <- err
			}()
		}
		start.Done()
		var successes, conflicts int
		for range 2 {
			switch err := <-results; {
			case err == nil:
				successes++
			case errors.Is(err, errDocumentRevisionConflict):
				conflicts++
			default:
				t.Fatalf("并发更新异常错误: %v", err)
			}
		}
		if successes != 1 || conflicts != 1 {
			t.Fatalf("success=%d conflict=%d", successes, conflicts)
		}
		latest, err := app.loadMCPDocument(ctx, lifetime.ID, doc.DocID)
		if err != nil || latest.Revision != 2 {
			t.Fatalf("最新 revision=%d err=%v", latest.Revision, err)
		}
	})

	t.Run("网页快照节流且 no-op 不增 revision", func(t *testing.T) {
		doc, err := app.createDocument(ctx, createDocumentParams{User: lifetime, Title: "web", Content: "v1"})
		if err != nil {
			t.Fatal(err)
		}
		doc, err = app.updateDocument(ctx, updateDocumentParams{
			User: lifetime, DocID: doc.DocID, Title: doc.Title, Theme: doc.Theme,
			Content: "v2", ExpectedRevision: doc.Revision, Source: documentSourceWeb,
		})
		if err != nil {
			t.Fatal(err)
		}
		doc, err = app.updateDocument(ctx, updateDocumentParams{
			User: lifetime, DocID: doc.DocID, Title: doc.Title, Theme: doc.Theme,
			Content: "v3", ExpectedRevision: doc.Revision, Source: documentSourceWeb,
		})
		if err != nil {
			t.Fatal(err)
		}
		var count int
		if err := pool.QueryRow(ctx, `
			SELECT count(*) FROM document_versions v
			JOIN documents d ON d.id = v.document_id WHERE d.doc_id = $1
		`, doc.DocID).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 1 {
			t.Fatalf("五分钟内两次网页写入应只有 1 个快照，实际 %d", count)
		}
		doc, err = app.updateDocument(ctx, updateDocumentParams{
			User: lifetime, DocID: doc.DocID, Title: doc.Title, Theme: doc.Theme,
			Content: "v4", ExpectedRevision: doc.Revision, Source: documentSourceWeb, ForceVersion: true,
		})
		if err != nil {
			t.Fatal(err)
		}
		unchanged, err := app.updateDocument(ctx, updateDocumentParams{
			User: lifetime, DocID: doc.DocID, Title: doc.Title, Theme: doc.Theme,
			Content: doc.Content, ExpectedRevision: doc.Revision, Source: documentSourceWeb,
		})
		if err != nil || unchanged.Revision != doc.Revision {
			t.Fatalf("no-op 保存不应增加 revision: before=%d after=%d err=%v",
				doc.Revision, unchanged.Revision, err)
		}
		staleRetry, err := app.updateDocument(ctx, updateDocumentParams{
			User: lifetime, DocID: doc.DocID, Title: doc.Title, Theme: doc.Theme,
			Content: doc.Content, ExpectedRevision: doc.Revision - 1, Source: documentSourceWeb,
		})
		if err != nil || staleRetry.Revision != doc.Revision {
			t.Fatalf("相同内容的旧 revision 重试必须幂等: revision=%d err=%v", staleRetry.Revision, err)
		}
		if _, err := app.updateDocument(ctx, updateDocumentParams{
			User: lifetime, DocID: doc.DocID, Title: doc.Title, Theme: doc.Theme,
			Content: "stale-different", ExpectedRevision: doc.Revision - 1, Source: documentSourceWeb,
		}); !errors.Is(err, errDocumentRevisionConflict) {
			t.Fatalf("旧 revision 的不同内容应冲突，实际 %v", err)
		}
	})

	t.Run("MCP 写入后下一次网页保存会保留 Agent 状态", func(t *testing.T) {
		doc, err := app.createDocument(ctx, createDocumentParams{User: lifetime, Title: "handoff", Content: "web-v1"})
		if err != nil {
			t.Fatal(err)
		}
		doc, err = app.updateDocument(ctx, updateDocumentParams{
			User: lifetime, DocID: doc.DocID, Title: doc.Title, Theme: doc.Theme,
			Content: "web-v2", ExpectedRevision: doc.Revision, Source: documentSourceWeb,
		})
		if err != nil {
			t.Fatal(err)
		}
		doc, err = app.updateDocument(ctx, updateDocumentParams{
			User: lifetime, DocID: doc.DocID, Title: doc.Title, Theme: doc.Theme,
			Content: "agent-v3", ExpectedRevision: doc.Revision, Source: documentSourceMCP,
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := app.updateDocument(ctx, updateDocumentParams{
			User: lifetime, DocID: doc.DocID, Title: doc.Title, Theme: doc.Theme,
			Content: "web-v4", ExpectedRevision: doc.Revision, Source: documentSourceWeb,
		}); err != nil {
			t.Fatal(err)
		}
		var retained string
		if err := pool.QueryRow(ctx, `
				SELECT v.content
				FROM document_versions v
				JOIN documents d ON d.id = v.document_id
				WHERE d.doc_id = $1 AND v.revision = 3
			`, doc.DocID).Scan(&retained); err != nil {
			t.Fatalf("读取 Agent 写入后的快照: %v", err)
		}
		if retained != "agent-v3" {
			t.Fatalf("网页覆盖前保留内容 = %q，期望 agent-v3", retained)
		}
	})

	t.Run("免费用户不保存历史", func(t *testing.T) {
		doc, err := app.createDocument(ctx, createDocumentParams{User: free, Title: "free", Content: "old"})
		if err != nil {
			t.Fatal(err)
		}
		if _, err := app.updateDocument(ctx, updateDocumentParams{
			User: free, DocID: doc.DocID, Title: doc.Title, Theme: doc.Theme,
			Content: "new", ExpectedRevision: doc.Revision, Source: documentSourceWeb,
		}); err != nil {
			t.Fatal(err)
		}
		var count int
		if err := pool.QueryRow(ctx, `
			SELECT count(*) FROM document_versions v
			JOIN documents d ON d.id = v.document_id WHERE d.doc_id = $1
		`, doc.DocID).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Fatalf("免费用户历史版本数 = %d，期望 0", count)
		}
	})

	t.Run("每篇最多二十版且淘汰后回收历史图片", func(t *testing.T) {
		user := seedMCPUser(t, pool, app, membershipTierLifetime)
		key := gcKey(user.AuthUserID, "eeeeeeee55555555")
		doc, err := app.createDocument(ctx, createDocumentParams{
			User: user, Title: "image history", Content: "![](https://img.koinote.app/" + key + ")",
		})
		if err != nil {
			t.Fatal(err)
		}
		for revision := 1; revision <= defaultDocumentHistoryLimit+1; revision++ {
			doc, err = app.updateDocument(ctx, updateDocumentParams{
				User: user, DocID: doc.DocID, Title: doc.Title, Theme: doc.Theme,
				Content: fmt.Sprintf("正文 %d", revision), ExpectedRevision: doc.Revision,
				Source: documentSourceMCP,
			})
			if err != nil {
				t.Fatalf("第 %d 次更新: %v", revision, err)
			}
			if revision <= defaultDocumentHistoryLimit {
				if got := pendingKeys(t, pool, user.AuthUserID); len(got) != 0 {
					t.Fatalf("历史仍保留图片时不应入队: %v", got)
				}
			}
		}
		var versionCount int
		if err := pool.QueryRow(ctx, `
			SELECT count(*) FROM document_versions v
			JOIN documents d ON d.id = v.document_id WHERE d.doc_id = $1
		`, doc.DocID).Scan(&versionCount); err != nil {
			t.Fatal(err)
		}
		if versionCount != defaultDocumentHistoryLimit {
			t.Fatalf("每篇历史数 = %d，期望 %d", versionCount, defaultDocumentHistoryLimit)
		}
		got := pendingKeys(t, pool, user.AuthUserID)
		if len(got) != 1 || got[0] != key {
			t.Fatalf("含图片的旧版淘汰后应回收图片，实际 %v", got)
		}
	})

	t.Run("每用户最多一百版", func(t *testing.T) {
		user := seedMCPUser(t, pool, app, membershipTierLifetime)
		var docs []model.Document
		for index := 0; index < 6; index++ {
			doc, err := app.createDocument(ctx, createDocumentParams{
				User: user, Title: fmt.Sprintf("retention-%d", index), Content: "current",
			})
			if err != nil {
				t.Fatal(err)
			}
			docs = append(docs, doc)
			if _, err := pool.Exec(ctx, `
				INSERT INTO document_versions (document_id, revision, title, theme, content, source)
				SELECT d.id, series, d.title, d.theme, 'snapshot', 'mcp'
				FROM documents d CROSS JOIN generate_series(1, 20) AS series
				WHERE d.doc_id = $1
			`, doc.DocID); err != nil {
				t.Fatalf("填充历史: %v", err)
			}
		}
		trigger := docs[0]
		if _, err := app.updateDocument(ctx, updateDocumentParams{
			User: user, DocID: trigger.DocID, Title: trigger.Title, Theme: trigger.Theme,
			Content: "trigger prune", ExpectedRevision: trigger.Revision, Source: documentSourceMCP,
		}); err != nil {
			t.Fatal(err)
		}
		var count int
		if err := pool.QueryRow(ctx, `
			SELECT count(*) FROM document_versions v
			JOIN documents d ON d.id = v.document_id WHERE d.user_id = $1
		`, user.ID).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != userDocumentVersionLimit {
			t.Fatalf("用户历史数 = %d，期望 %d", count, userDocumentVersionLimit)
		}
	})
}

func TestDocumentHistorySettingsEndToEnd(t *testing.T) {
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "history-settings"}, pool)
	server := httptest.NewServer(app.Routes())
	t.Cleanup(server.Close)
	lifetime := seedMCPUser(t, pool, app, membershipTierLifetime)
	free := seedMCPUser(t, pool, app, membershipTierFree)
	lifetimeCookie := mcpSessionCookie(app, lifetime.AuthUserID)
	freeCookie := mcpSessionCookie(app, free.AuthUserID)
	ctx := context.Background()

	response := requestMCPTokenAPI(t, server.Client(), http.MethodGet,
		server.URL+"/api/settings/document-history", lifetimeCookie, nil)
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("读取历史设置期望 200，实际 %d", response.StatusCode)
	}
	var initial struct {
		Settings documentHistorySettings `json:"settings"`
	}
	if err := json.NewDecoder(response.Body).Decode(&initial); err != nil {
		t.Fatal(err)
	}
	if !initial.Settings.Enabled || !initial.Settings.MCPEnabled ||
		initial.Settings.PerDocumentMax != defaultDocumentHistoryLimit ||
		!initial.Settings.Available || initial.Settings.AccountMax != userDocumentVersionLimit {
		t.Fatalf("默认历史设置异常: %+v", initial.Settings)
	}

	for _, tc := range []struct {
		name   string
		method string
		body   any
	}{
		{name: "读取", method: http.MethodGet},
		{name: "修改", method: http.MethodPut, body: map[string]any{
			"enabled": true, "perDocumentMax": 5, "mcpEnabled": true,
		}},
	} {
		t.Run("免费用户不能"+tc.name+"历史设置", func(t *testing.T) {
			freeResponse := requestMCPTokenAPI(t, server.Client(), tc.method,
				server.URL+"/api/settings/document-history", freeCookie, tc.body)
			defer freeResponse.Body.Close()
			if freeResponse.StatusCode != http.StatusForbidden {
				t.Fatalf("免费用户%s历史设置期望 403，实际 %d", tc.name, freeResponse.StatusCode)
			}
			if code := decodeHTTPErrorCode(t, freeResponse); code != "membership_required" {
				t.Fatalf("错误码 = %q，期望 membership_required", code)
			}
		})
	}

	freeDoc, err := app.createDocument(ctx, createDocumentParams{User: free, Title: "free", Content: "v1"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO document_versions (document_id, revision, title, theme, content, source)
		SELECT id, 1, title, theme, content, 'web' FROM documents WHERE doc_id = $1
	`, freeDoc.DocID); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		method string
		path   string
		body   any
	}{
		{name: "列出版本", method: http.MethodGet, path: "/api/documents/" + freeDoc.DocID + "/versions"},
		{name: "读取版本", method: http.MethodGet, path: "/api/documents/" + freeDoc.DocID + "/versions/1"},
		{name: "恢复版本", method: http.MethodPost, path: "/api/documents/" + freeDoc.DocID + "/versions/1/restore", body: map[string]any{"expectedRevision": 1}},
	} {
		t.Run("免费用户不能"+tc.name, func(t *testing.T) {
			freeResponse := requestMCPTokenAPI(t, server.Client(), tc.method,
				server.URL+tc.path, freeCookie, tc.body)
			defer freeResponse.Body.Close()
			if freeResponse.StatusCode != http.StatusForbidden {
				t.Fatalf("免费用户%s期望 403，实际 %d", tc.name, freeResponse.StatusCode)
			}
			if code := decodeHTTPErrorCode(t, freeResponse); code != "membership_required" {
				t.Fatalf("错误码 = %q，期望 membership_required", code)
			}
		})
	}

	doc, err := app.createDocument(ctx, createDocumentParams{User: lifetime, Title: "history", Content: "v1"})
	if err != nil {
		t.Fatal(err)
	}
	for revision := 2; revision <= 4; revision++ {
		doc, err = app.updateDocument(ctx, updateDocumentParams{
			User: lifetime, DocID: doc.DocID, Title: doc.Title, Theme: doc.Theme,
			Content: fmt.Sprintf("v%d", revision), ExpectedRevision: doc.Revision,
			Source: documentSourceMCP,
		})
		if err != nil {
			t.Fatalf("生成第 %d 版: %v", revision, err)
		}
	}

	putHistorySettings(t, server, lifetimeCookie, true, 2, true)
	if revisions := documentVersionRevisions(t, pool, doc.DocID); !slices.Equal(revisions, []int64{3, 2}) {
		t.Fatalf("调低单篇上限后 revisions=%v，期望 [3 2]", revisions)
	}

	putHistorySettings(t, server, lifetimeCookie, false, 2, true)
	doc, err = app.updateDocument(ctx, updateDocumentParams{
		User: lifetime, DocID: doc.DocID, Title: doc.Title, Theme: doc.Theme,
		Content: "history disabled", ExpectedRevision: doc.Revision,
		Source: documentSourceWeb, ForceVersion: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if revisions := documentVersionRevisions(t, pool, doc.DocID); !slices.Equal(revisions, []int64{3, 2}) {
		t.Fatalf("关闭历史后仍生成版本: %v", revisions)
	}

	putHistorySettings(t, server, lifetimeCookie, true, 2, false)
	doc, err = app.updateDocument(ctx, updateDocumentParams{
		User: lifetime, DocID: doc.DocID, Title: doc.Title, Theme: doc.Theme,
		Content: "mcp history disabled", ExpectedRevision: doc.Revision,
		Source: documentSourceMCP,
	})
	if err != nil {
		t.Fatal(err)
	}
	if versions := documentVersionRows(t, pool, doc.DocID); !slices.Equal(versions, []documentVersionRow{
		{Revision: 5, SafetySnapshot: true},
		{Revision: 3},
	}) {
		t.Fatalf("关闭 MCP 完整历史后应额外留一份安全快照，实际 %+v", versions)
	}
	doc, err = app.updateDocument(ctx, updateDocumentParams{
		User: lifetime, DocID: doc.DocID, Title: doc.Title, Theme: doc.Theme,
		Content: "second mcp safety snapshot", ExpectedRevision: doc.Revision,
		Source: documentSourceMCP,
	})
	if err != nil {
		t.Fatal(err)
	}
	if versions := documentVersionRows(t, pool, doc.DocID); !slices.Equal(versions, []documentVersionRow{
		{Revision: 6, SafetySnapshot: true},
		{Revision: 3},
	}) {
		t.Fatalf("连续 Agent 写入应替换而非累加安全快照，实际 %+v", versions)
	}

	if _, err := app.updateDocument(ctx, updateDocumentParams{
		User: lifetime, DocID: doc.DocID, Title: doc.Title, Theme: doc.Theme,
		Content: "web restore snapshot", ExpectedRevision: doc.Revision,
		Source: documentSourceRestore,
	}); err != nil {
		t.Fatal(err)
	}
	if versions := documentVersionRows(t, pool, doc.DocID); !slices.Equal(versions, []documentVersionRow{
		{Revision: 7},
		{Revision: 3},
	}) {
		t.Fatalf("网页完整快照应替代安全快照并遵守上限，实际 %+v", versions)
	}
}

func putHistorySettings(t *testing.T, server *httptest.Server, cookie *http.Cookie, enabled bool, perDocumentMax int, mcpEnabled bool) {
	t.Helper()
	response := requestMCPTokenAPI(t, server.Client(), http.MethodPut,
		server.URL+"/api/settings/document-history", cookie,
		map[string]any{"enabled": enabled, "perDocumentMax": perDocumentMax, "mcpEnabled": mcpEnabled})
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("更新历史设置期望 200，实际 %d", response.StatusCode)
	}
}

func documentVersionRevisions(t *testing.T, pool *pgxpool.Pool, docID string) []int64 {
	t.Helper()
	rows, err := pool.Query(context.Background(), `
		SELECT version.revision
		FROM document_versions AS version
		JOIN documents AS document ON document.id = version.document_id
		WHERE document.doc_id = $1
		ORDER BY version.revision DESC
	`, docID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var revisions []int64
	for rows.Next() {
		var revision int64
		if err := rows.Scan(&revision); err != nil {
			t.Fatal(err)
		}
		revisions = append(revisions, revision)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return revisions
}

type documentVersionRow struct {
	Revision       int64
	SafetySnapshot bool
}

func documentVersionRows(t *testing.T, pool *pgxpool.Pool, docID string) []documentVersionRow {
	t.Helper()
	rows, err := pool.Query(context.Background(), `
		SELECT version.revision, version.safety_snapshot
		FROM document_versions AS version
		JOIN documents AS document ON document.id = version.document_id
		WHERE document.doc_id = $1
		ORDER BY version.revision DESC
	`, docID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var versions []documentVersionRow
	for rows.Next() {
		var version documentVersionRow
		if err := rows.Scan(&version.Revision, &version.SafetySnapshot); err != nil {
			t.Fatal(err)
		}
		versions = append(versions, version)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return versions
}

func TestTrashedDocumentKeepsImagesUntilPermanentDeletion(t *testing.T) {
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "delete-version-images"}, pool)
	user := seedMCPUser(t, pool, app, membershipTierLifetime)
	oldKey := gcKey(user.AuthUserID, "11111111aaaaaaaa")
	currentKey := gcKey(user.AuthUserID, "22222222bbbbbbbb")
	doc, err := app.createDocument(context.Background(), createDocumentParams{
		User: user, Title: "delete", Content: "![](https://img.koinote.app/" + oldKey + ")",
	})
	if err != nil {
		t.Fatal(err)
	}
	doc, err = app.updateDocument(context.Background(), updateDocumentParams{
		User: user, DocID: doc.DocID, Title: doc.Title, Theme: doc.Theme,
		Content:          "![](https://img.koinote.app/" + currentKey + ")",
		ExpectedRevision: doc.Revision, Source: documentSourceMCP,
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := pendingKeys(t, pool, user.AuthUserID); len(got) != 0 {
		t.Fatalf("旧图片仍在历史中时不应入队: %v", got)
	}

	req := httptest.NewRequest(http.MethodDelete, "/api/documents/"+doc.DocID, nil)
	req.AddCookie(mcpSessionCookie(app, user.AuthUserID))
	rec := httptest.NewRecorder()
	app.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("删除文档期望 200，实际 %d（%s）", rec.Code, rec.Body.String())
	}
	if got := pendingKeys(t, pool, user.AuthUserID); len(got) != 0 {
		t.Fatalf("移入回收站期间图片必须保留，实际入队 %v", got)
	}
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO mcp_audit_logs (user_id, tool_name, document_id, doc_id, result, duration_ms)
		SELECT $1, 'trash_document', id, doc_id, 'success', 1
		FROM documents WHERE doc_id = $2
	`, user.ID, doc.DocID); err != nil {
		t.Fatalf("插入永久删除前审计记录: %v", err)
	}

	purgeReq := httptest.NewRequest(http.MethodDelete, "/api/documents/"+doc.DocID+"/permanent", strings.NewReader(`{"confirmation":"delete"}`))
	purgeReq.Header.Set("Content-Type", "application/json")
	purgeReq.AddCookie(mcpSessionCookie(app, user.AuthUserID))
	purgeRec := httptest.NewRecorder()
	app.Routes().ServeHTTP(purgeRec, purgeReq)
	if purgeRec.Code != http.StatusOK {
		t.Fatalf("永久删除文档期望 200，实际 %d（%s）", purgeRec.Code, purgeRec.Body.String())
	}
	got := pendingKeys(t, pool, user.AuthUserID)
	want := []string{oldKey, currentKey}
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Fatalf("永久删除后待回收图片 = %v，期望 %v", got, want)
	}
	var auditDocID string
	var auditDocumentID *int
	if err := pool.QueryRow(context.Background(), `
		SELECT doc_id, document_id FROM mcp_audit_logs
		WHERE user_id = $1 AND tool_name = 'trash_document'
		ORDER BY id DESC LIMIT 1
	`, user.ID).Scan(&auditDocID, &auditDocumentID); err != nil {
		t.Fatalf("读取永久删除后审计记录: %v", err)
	}
	if auditDocID != doc.DocID || auditDocumentID != nil {
		t.Fatalf("永久删除后审计关联异常: doc_id=%q document_id=%v", auditDocID, auditDocumentID)
	}
}

func TestExpiredTrashCleanupPurgesOnlyExpiredDocuments(t *testing.T) {
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "trash-cleanup"}, pool)
	user := seedMCPUser(t, pool, app, membershipTierLifetime)
	ctx := context.Background()

	recent, err := app.createDocument(ctx, createDocumentParams{User: user, Title: "recent", Content: "recent"})
	if err != nil {
		t.Fatal(err)
	}
	expired, err := app.createDocument(ctx, createDocumentParams{User: user, Title: "expired", Content: "expired"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := app.trashDocument(ctx, user, recent.DocID, recent.Revision); err != nil {
		t.Fatal(err)
	}
	if _, err := app.trashDocument(ctx, user, expired.DocID, expired.Revision); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		UPDATE documents SET trashed_at = now() - interval '31 days' WHERE doc_id = $1
	`, expired.DocID); err != nil {
		t.Fatal(err)
	}
	if err := app.purgeExpiredTrashedDocuments(ctx); err != nil {
		t.Fatal(err)
	}

	var recentExists, expiredExists bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM documents WHERE doc_id = $1)`, recent.DocID).Scan(&recentExists); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM documents WHERE doc_id = $1)`, expired.DocID).Scan(&expiredExists); err != nil {
		t.Fatal(err)
	}
	if !recentExists || expiredExists {
		t.Fatalf("清理后 recent=%v expired=%v，期望 recent 保留、expired 删除", recentExists, expiredExists)
	}
}

func TestMCPAuditCleanupRetention(t *testing.T) {
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "mcp-audit-retention"}, pool)
	user := seedMCPUser(t, pool, app, membershipTierLifetime)
	ctx := context.Background()

	if _, err := pool.Exec(ctx, `
		INSERT INTO mcp_audit_logs (user_id, tool_name, result, duration_ms, created_at)
		VALUES
			($1, 'old_tool', 'success', 1, now() - interval '181 days'),
			($1, 'recent_tool', 'success', 1, now() - interval '179 days')
	`, user.ID); err != nil {
		t.Fatal(err)
	}
	if err := app.runMCPAuditCleanupOnce(ctx); err != nil {
		t.Fatal(err)
	}

	var tools []string
	rows, err := pool.Query(ctx, `
		SELECT tool_name FROM mcp_audit_logs
		WHERE user_id = $1 ORDER BY tool_name
	`, user.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var tool string
		if err := rows.Scan(&tool); err != nil {
			t.Fatal(err)
		}
		tools = append(tools, tool)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(tools, []string{"recent_tool"}) {
		t.Fatalf("清理后审计工具 = %v，期望只保留 recent_tool", tools)
	}
}

func listInMemoryMCPTools(t *testing.T, principal mcpPrincipal) []string {
	t.Helper()
	ctx := context.Background()
	serverTransport, clientTransport := mcp.NewInMemoryTransports()
	server := newTestApp(config.Config{AppURL: "https://koinote.app"}).newMCPServer(principal)
	serverSession, err := server.Connect(ctx, serverTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = serverSession.Close() })
	client := mcp.NewClient(&mcp.Implementation{Name: "koinote-test", Version: "1.0.0"}, nil)
	clientSession, err := client.Connect(ctx, clientTransport, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = clientSession.Close() })
	result, err := clientSession.ListTools(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(result.Tools))
	for _, tool := range result.Tools {
		names = append(names, tool.Name)
	}
	slices.Sort(names)
	return names
}

func seedMCPUser(t *testing.T, pool *pgxpool.Pool, app *App, tier string) model.User {
	t.Helper()
	suffix, err := randomUUID()
	if err != nil {
		t.Fatal(err)
	}
	authUserID := "mcp-test-" + suffix
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO users (
			auth_user_id, email, nickname, password_hash, is_verified,
			membership_tier, membership_granted_at
		) VALUES ($1, $1 || '@example.test', 'MCP Test', 'x', true, $2::text,
			CASE WHEN $2::text = 'lifetime' THEN now() ELSE NULL END)
	`, authUserID, tier); err != nil {
		t.Fatalf("创建 MCP 测试用户: %v", err)
	}
	user, err := app.getUserByAuthUserID(context.Background(), authUserID)
	if err != nil {
		t.Fatalf("读取 MCP 测试用户: %v", err)
	}
	t.Cleanup(func() {
		ctx := context.Background()
		_, _ = pool.Exec(ctx, `DELETE FROM pending_image_deletions WHERE object_key LIKE 'u/' || $1 || '/%'`, authUserID)
		_, _ = pool.Exec(ctx, `DELETE FROM users WHERE id = $1`, user.ID)
	})
	return user
}

func mcpSessionCookie(app *App, authUserID string) *http.Cookie {
	token, expiresAt := app.signSession(authUserID, 1)
	return &http.Cookie{Name: sessionCookieName, Value: token, Path: "/", Expires: expiresAt}
}

type createdMCPToken struct {
	Token  mcpTokenView `json:"token"`
	Secret string       `json:"secret"`
}

func createMCPTokenForTest(t *testing.T, server *httptest.Server, cookie *http.Cookie, name, scope string) createdMCPToken {
	t.Helper()
	response := requestMCPTokenAPI(t, server.Client(), http.MethodPost, server.URL+"/api/mcp/tokens", cookie,
		map[string]any{"name": name, "scope": scope, "expiresInDays": 90})
	defer response.Body.Close()
	if response.StatusCode != http.StatusCreated {
		t.Fatalf("创建 %s token 期望 201，实际 %d", scope, response.StatusCode)
	}
	var result createdMCPToken
	if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(result.Secret, mcpTokenPrefix) || result.Token.Scope != scope {
		t.Fatalf("令牌响应异常: %+v", result)
	}
	return result
}

func requestMCPTokenAPI(t *testing.T, client *http.Client, method, endpoint string, cookie *http.Cookie, body any) *http.Response {
	t.Helper()
	var reader *bytes.Reader
	if body == nil {
		reader = bytes.NewReader(nil)
	} else {
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequest(method, endpoint, reader)
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if cookie != nil {
		req.AddCookie(cookie)
	}
	response, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func decodeHTTPErrorCode(t *testing.T, response *http.Response) string {
	t.Helper()
	var body struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(response.Body).Decode(&body); err != nil {
		t.Fatalf("解析错误响应: %v", err)
	}
	return body.Code
}

type mcpBearerTransport struct {
	token string
	base  http.RoundTripper
}

func (transport mcpBearerTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	clone := request.Clone(request.Context())
	clone.Header = request.Header.Clone()
	clone.Header.Set("Authorization", "Bearer "+transport.token)
	return transport.base.RoundTrip(clone)
}

func connectMCPClient(ctx context.Context, endpoint, token string) (*mcp.ClientSession, error) {
	httpClient := &http.Client{Transport: mcpBearerTransport{token: token, base: http.DefaultTransport}}
	client := mcp.NewClient(&mcp.Implementation{Name: "koinote-integration-test", Version: "1.0.0"}, nil)
	return client.Connect(ctx, &mcp.StreamableClientTransport{
		Endpoint: endpoint, HTTPClient: httpClient, DisableStandaloneSSE: true, MaxRetries: -1,
	}, nil)
}

func assertMCPToolSet(t *testing.T, session *mcp.ClientSession, want []string) {
	t.Helper()
	result, err := session.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	got := make([]string, 0, len(result.Tools))
	for _, tool := range result.Tools {
		got = append(got, tool.Name)
	}
	slices.Sort(got)
	want = slices.Clone(want)
	slices.Sort(want)
	if !slices.Equal(got, want) {
		t.Fatalf("MCP 工具 = %v，期望 %v", got, want)
	}
}

func callMCPTool(t *testing.T, session *mcp.ClientSession, name string, arguments any) *mcp.CallToolResult {
	t.Helper()
	result, err := session.CallTool(context.Background(), &mcp.CallToolParams{Name: name, Arguments: arguments})
	if err != nil {
		t.Fatalf("调用 %s: %v", name, err)
	}
	return result
}

func callMCPToolOK(t *testing.T, session *mcp.ClientSession, name string, arguments any) *mcp.CallToolResult {
	t.Helper()
	result := callMCPTool(t, session, name, arguments)
	if result.IsError {
		t.Fatalf("调用 %s 返回工具错误: %s", name, mcpResultText(result))
	}
	return result
}

func decodeMCPStructured(t *testing.T, result *mcp.CallToolResult, target any) {
	t.Helper()
	encoded, err := json.Marshal(result.StructuredContent)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(encoded, target); err != nil {
		t.Fatalf("解析 MCP structuredContent: %v（%s）", err, encoded)
	}
}

func mcpResultText(result *mcp.CallToolResult) string {
	var parts []string
	for _, content := range result.Content {
		if text, ok := content.(*mcp.TextContent); ok {
			parts = append(parts, text.Text)
		}
	}
	return strings.Join(parts, "\n")
}
