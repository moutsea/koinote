package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"koinote/backend/internal/config"
)

func TestDocumentSearchEndToEnd(t *testing.T) {
	pool := newGCTestPool(t)
	app := New(config.Config{SessionSecret: "document-search-secret"}, pool)
	server := httptest.NewServer(app.Routes())
	t.Cleanup(server.Close)

	owner := seedMCPUser(t, pool, app, membershipTierFree)
	other := seedMCPUser(t, pool, app, membershipTierFree)
	bodyDocID := "search-body-" + owner.AuthUserID
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO documents (doc_id, user_id, title, content, trashed_at)
		VALUES
			($1, $2, '普通标题', $3, NULL),
			($4, $2, 'Needle 标题命中', '没有正文命中', NULL),
			($5, $2, '已删除', $3, now()),
			($6, $7, '其他账号', $3, NULL)
	`, bodyDocID, owner.ID, strings.Repeat("前文", 50)+"稀有关键词"+strings.Repeat("后文", 50),
		"search-title-"+owner.AuthUserID, "search-trash-"+owner.AuthUserID,
		"search-other-"+other.AuthUserID, other.ID); err != nil {
		t.Fatalf("插入搜索测试文档: %v", err)
	}

	request := func(query string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest(http.MethodGet, "/api/documents/search?q="+url.QueryEscape(query), nil)
		req.AddCookie(mcpSessionCookie(app, owner.AuthUserID))
		rec := httptest.NewRecorder()
		app.Routes().ServeHTTP(rec, req)
		return rec
	}

	bodyResponse := request("稀有关键词")
	if bodyResponse.Code != http.StatusOK {
		t.Fatalf("正文搜索期望 200，实际 %d: %s", bodyResponse.Code, bodyResponse.Body.String())
	}
	var bodyResults struct {
		Results []documentSearchResult `json:"results"`
	}
	if err := json.Unmarshal(bodyResponse.Body.Bytes(), &bodyResults); err != nil {
		t.Fatal(err)
	}
	if len(bodyResults.Results) != 1 || bodyResults.Results[0].DocID != bodyDocID ||
		bodyResults.Results[0].TitleMatched || !bodyResults.Results[0].ContentMatched ||
		!strings.Contains(bodyResults.Results[0].Snippet, "稀有关键词") {
		t.Fatalf("正文搜索、隔离或摘要异常: %+v", bodyResults.Results)
	}

	titleResponse := request("Needle")
	var titleResults struct {
		Results []documentSearchResult `json:"results"`
	}
	if err := json.Unmarshal(titleResponse.Body.Bytes(), &titleResults); err != nil {
		t.Fatal(err)
	}
	if titleResponse.Code != http.StatusOK || len(titleResults.Results) != 1 ||
		!titleResults.Results[0].TitleMatched || titleResults.Results[0].ContentMatched {
		t.Fatalf("标题搜索异常: code=%d results=%+v", titleResponse.Code, titleResults.Results)
	}
	for _, target := range []string{
		"/api/documents/search?q=",
		"/api/documents/search?q=ok&limit=0",
		"/api/documents/search?q=ok&limit=51",
	} {
		req := httptest.NewRequest(http.MethodGet, target, nil)
		req.AddCookie(mcpSessionCookie(app, owner.AuthUserID))
		rec := httptest.NewRecorder()
		app.Routes().ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s 期望 400，实际 %d", target, rec.Code)
		}
	}
}
