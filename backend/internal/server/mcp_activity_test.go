package server

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"koinote/backend/internal/config"
)

func TestMCPActivityListPaginationAndIsolation(t *testing.T) {
	pool := newGCTestPool(t)
	ctx := context.Background()
	app := New(config.Config{SessionSecret: "mcp-activity-secret"}, pool)
	user := seedMCPUser(t, pool, app, membershipTierLifetime)
	other := seedMCPUser(t, pool, app, membershipTierLifetime)
	suffix, err := randomHex(8)
	if err != nil {
		t.Fatal(err)
	}
	docID := "mcp-activity-doc-" + suffix
	var documentID int
	if err := pool.QueryRow(ctx, `
		INSERT INTO documents (doc_id, user_id, title, content)
		VALUES ($1, $2, 'Activity document', 'private body') RETURNING id
	`, docID, user.ID).Scan(&documentID); err != nil {
		t.Fatal(err)
	}
	tokenHash := sha256.Sum256([]byte("mcp-activity-" + suffix))
	var tokenID int64
	if err := pool.QueryRow(ctx, `
		INSERT INTO mcp_tokens (token_id, user_id, name, token_hash, token_hint, scope)
		VALUES ($1, $2, 'Codex desktop', $3, '…activity', 'write') RETURNING id
	`, "mcp-activity-"+suffix, user.ID, tokenHash[:]).Scan(&tokenID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO mcp_audit_logs (user_id, token_id, tool_name, document_id, doc_id, result, duration_ms, created_at)
		VALUES
			($1, $2, 'get_document', $3, $4, 'success', 2, now() - interval '3 seconds'),
			($1, $2, 'update_document', $3, $4, 'success', 5, now() - interval '2 seconds'),
			($1, $2, 'restore_document', $3, $4, 'error', 7, now() - interval '1 second'),
			($5, NULL, 'other_user_tool', NULL, NULL, 'success', 1, now())
	`, user.ID, tokenID, documentID, docID, other.ID); err != nil {
		t.Fatal(err)
	}

	requestPage := func(cursor string) *httptest.ResponseRecorder {
		path := "/api/mcp/activity?limit=2"
		if cursor != "" {
			path += "&cursor=" + cursor
		}
		req := httptest.NewRequest(http.MethodGet, path, nil)
		req.AddCookie(sessionCookieFor(t, app, user.AuthUserID, user.SessionVersion))
		rec := httptest.NewRecorder()
		app.mcpActivityList(rec, req)
		return rec
	}

	first := requestPage("")
	if first.Code != http.StatusOK {
		t.Fatalf("第一页状态=%d body=%s", first.Code, first.Body.String())
	}
	var firstBody struct {
		Activities []mcpActivityView `json:"activities"`
		NextCursor string            `json:"nextCursor"`
	}
	if err := json.Unmarshal(first.Body.Bytes(), &firstBody); err != nil {
		t.Fatal(err)
	}
	if len(firstBody.Activities) != 2 || firstBody.NextCursor == "" {
		t.Fatalf("第一页活动=%d cursor=%q", len(firstBody.Activities), firstBody.NextCursor)
	}
	if firstBody.Activities[0].ToolName != "restore_document" || firstBody.Activities[1].ToolName != "update_document" {
		t.Fatalf("第一页顺序错误: %+v", firstBody.Activities)
	}
	if firstBody.Activities[0].TokenName == nil || *firstBody.Activities[0].TokenName != "Codex desktop" ||
		firstBody.Activities[0].DocumentTitle == nil || *firstBody.Activities[0].DocumentTitle != "Activity document" {
		t.Fatalf("关联展示信息缺失: %+v", firstBody.Activities[0])
	}
	if strings.Contains(first.Body.String(), "private body") || strings.Contains(first.Body.String(), "mcp-activity-"+suffix) {
		t.Fatal("活动接口不能泄露正文或令牌原文")
	}

	second := requestPage(firstBody.NextCursor)
	if second.Code != http.StatusOK {
		t.Fatalf("第二页状态=%d body=%s", second.Code, second.Body.String())
	}
	var secondBody struct {
		Activities []mcpActivityView `json:"activities"`
		NextCursor string            `json:"nextCursor"`
	}
	if err := json.Unmarshal(second.Body.Bytes(), &secondBody); err != nil {
		t.Fatal(err)
	}
	if len(secondBody.Activities) != 1 || secondBody.Activities[0].ToolName != "get_document" || secondBody.NextCursor != "" {
		t.Fatalf("第二页错误: %+v cursor=%q", secondBody.Activities, secondBody.NextCursor)
	}

	bad := requestPage("not-a-cursor")
	if bad.Code != http.StatusBadRequest || decodeErrorCode(t, bad) != "invalid_cursor" {
		t.Fatalf("非法 cursor 应返回 400，实际 %d %s", bad.Code, bad.Body.String())
	}
}
