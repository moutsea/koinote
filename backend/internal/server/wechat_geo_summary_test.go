package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"koinote/backend/internal/config"
)

func TestWechatGeoSummaryValidation(t *testing.T) {
	generated, err := parseWechatGeoSummary([]byte(`{
		"summary":"文章解释了如何为长文建立清晰结构。",
		"topics":["文章结构","文章结构","移动阅读"],
		"keywords":["公众号排版","长文写作"]
	}`))
	if err != nil {
		t.Fatalf("parse GEO summary: %v", err)
	}
	if len(generated.Topics) != 2 || generated.Topics[0] != "文章结构" {
		t.Fatalf("normalized topics=%v", generated.Topics)
	}
	if text := formatWechatGeoSummary(generated); !strings.Contains(text, "文章结构 · 移动阅读") {
		t.Fatalf("formatted GEO summary=%q", text)
	}
	if _, err := parseWechatGeoSummary([]byte(`{"summary":"","topics":[],"keywords":[]}`)); err == nil {
		t.Fatal("empty GEO summary unexpectedly passed validation")
	}
}

func TestWechatGeoSummaryDropsTermsRepeatedAcrossArrays(t *testing.T) {
	generated, err := parseWechatGeoSummary([]byte(`{
		"summary":"文章比较了 pgvector 与外部向量库在中等规模下的检索延迟。",
		"topics":["向量检索","RAG","移动阅读"],
		"keywords":["rag","向量检索","公众号排版","pgvector"]
	}`))
	if err != nil {
		t.Fatalf("parse GEO summary: %v", err)
	}
	if len(generated.Topics) != 3 {
		t.Fatalf("topics=%v, want all three kept", generated.Topics)
	}
	// "rag" 与 topics 的 "RAG" 只差大小写，"向量检索" 完全相同，两条都该让位给 topics。
	if len(generated.Keywords) != 2 || generated.Keywords[0] != "公众号排版" ||
		generated.Keywords[1] != "pgvector" {
		t.Fatalf("keywords=%v, want only the terms absent from topics", generated.Keywords)
	}
}

func TestWechatGeoSummaryPromptDemandsAuthorVoice(t *testing.T) {
	prompt, err := buildWechatGeoSummaryPrompt("标题", "正文内容。")
	if err != nil {
		t.Fatalf("build GEO prompt: %v", err)
	}
	// 隐藏语料嵌在文章体内，第三方口吻会让抓取方读到「文章里夹了一段旁人的评论」。
	for _, requirement := range []string{
		"continuation of the",
		"Speak as the author",
		"Never write about the document",
		"文章",
		"本文",
		"作者",
		"This article",
	} {
		if !strings.Contains(prompt.System, requirement) {
			t.Fatalf("prompt no longer pins author voice: missing %q", requirement)
		}
	}
}

func TestWechatGeoSummaryPromptDisclosesSampling(t *testing.T) {
	const omitted = "the middle is omitted"

	short, err := buildWechatGeoSummaryPrompt("短文标题", "# 开头\n\n正文内容。")
	if err != nil {
		t.Fatalf("build short GEO prompt: %v", err)
	}
	if strings.Contains(short.User, omitted) {
		t.Fatal("full-content prompt must not claim the middle was omitted")
	}

	long, err := buildWechatGeoSummaryPrompt(
		"长文标题", "# 开头\n\n"+strings.Repeat("开篇内容。", 6_000)+"\n\n# 结尾\n\n收尾内容。",
	)
	if err != nil {
		t.Fatalf("build long GEO prompt: %v", err)
	}
	if !strings.Contains(long.User, omitted) {
		t.Fatalf("sampled prompt hides the omitted middle: %s", long.User[:400])
	}
}

func TestWechatGeoSummaryPromptSamplesLongDocuments(t *testing.T) {
	content := "# 开头\n\n" + strings.Repeat("开篇内容。", 6_000) +
		"\n\n# 结尾\n\nFINAL_GEO_SENTINEL"
	prompt, err := buildWechatGeoSummaryPrompt("长文标题", content)
	if err != nil {
		t.Fatalf("build GEO prompt: %v", err)
	}
	if !strings.Contains(prompt.User, "# 开头") || !strings.Contains(prompt.User, "# 结尾") ||
		!strings.Contains(prompt.User, "FINAL_GEO_SENTINEL") {
		t.Fatalf("sampled prompt misses outline or ending: %s", prompt.User[len(prompt.User)-500:])
	}
	if len(prompt.User) >= len(content) {
		t.Fatalf("long prompt was not sampled: prompt=%d content=%d", len(prompt.User), len(content))
	}
}

func TestWechatGeoSummaryGenerateRequiresMembershipAndChargesBuiltinCredits(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer geo-test-key" {
			t.Fatalf("unexpected GEO provider request: path=%q authorization=%q", r.URL.Path, r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{
				"message": map[string]string{"content": `{
					"summary":"The article explains a practical writing workflow for clearer long-form content.",
					"topics":["writing workflow","content structure","mobile reading"],
					"keywords":["long-form writing","article structure","WeChat publishing","mobile readability","editorial workflow"]
				}`},
				"finish_reason": "stop",
			}},
			"usage": map[string]int{
				"prompt_tokens": 1_000, "completion_tokens": 200, "total_tokens": 1_200,
			},
		})
	}))
	defer provider.Close()

	app, pool, user, document := newAgentReviewCreateTest(t, config.Config{
		SessionSecret:    "wechat-geo-summary-test",
		AgentLLMProtocol: "openai",
		AgentLLMBaseURL:  provider.URL,
		AgentLLMAPIKey:   "geo-test-key",
		AgentLLMModel:    "geo-test-model",
	})
	app.agentLLMHTTPClient = provider.Client()
	grantCreditsForTest(t, pool, user.ID, 5, "wechat-geo-summary")

	response := requestWechatGeoSummary(
		t, app, user.AuthUserID, user.SessionVersion, document.DocID, document.Title, document.Content,
	)
	if response.Code != http.StatusOK {
		t.Fatalf("generate GEO status=%d body=%s", response.Code, response.Body.String())
	}
	var payload struct {
		Geo wechatGeoSummaryView `json:"geo"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatalf("decode GEO response: %v", err)
	}
	if payload.Geo.ProviderMode != "builtin" || payload.Geo.Model != "geo-test-model" ||
		payload.Geo.CreditsCharged != 1 || !strings.Contains(payload.Geo.Text, "writing workflow") ||
		payload.Geo.SourceHash != wechatGeoSummaryFingerprint(document.Title, document.Content) ||
		!payload.Geo.Enabled {
		t.Fatalf("unexpected GEO response: %+v", payload.Geo)
	}
	var reservations int
	if err := pool.QueryRow(context.Background(), `
		SELECT count(*) FROM credit_reservations
		WHERE user_id = $1 AND review_id IS NULL AND status = 'committed'
	`, user.ID).Scan(&reservations); err != nil {
		t.Fatalf("count GEO reservations: %v", err)
	}
	if reservations != 1 {
		t.Fatalf("committed standalone reservations=%d, want 1", reservations)
	}
	stored := requestWechatGeoSummaryGet(t, app, user.AuthUserID, user.SessionVersion, document.DocID)
	if stored.Code != http.StatusOK {
		t.Fatalf("get saved GEO status=%d body=%s", stored.Code, stored.Body.String())
	}
	var storedPayload struct {
		Geo *wechatGeoSummaryView `json:"geo"`
	}
	if err := json.NewDecoder(stored.Body).Decode(&storedPayload); err != nil {
		t.Fatalf("decode saved GEO response: %v", err)
	}
	if storedPayload.Geo == nil || storedPayload.Geo.Text != payload.Geo.Text ||
		storedPayload.Geo.SourceHash != payload.Geo.SourceHash {
		t.Fatalf("saved GEO response=%+v, want generated summary", storedPayload.Geo)
	}
	edited := requestWechatGeoSummaryUpdate(
		t, app, user.AuthUserID, user.SessionVersion, document.DocID, "编辑后的隐藏摘要",
	)
	if edited.Code != http.StatusOK || !strings.Contains(edited.Body.String(), "编辑后的隐藏摘要") {
		t.Fatalf("update saved GEO status=%d body=%s", edited.Code, edited.Body.String())
	}
	disabled := requestWechatGeoSummaryEnabled(
		t, app, user.AuthUserID, user.SessionVersion, document.DocID, false,
	)
	if disabled.Code != http.StatusOK || !strings.Contains(disabled.Body.String(), `"enabled":false`) {
		t.Fatalf("disable saved GEO status=%d body=%s", disabled.Code, disabled.Body.String())
	}
	storedDisabled := requestWechatGeoSummaryGet(t, app, user.AuthUserID, user.SessionVersion, document.DocID)
	if storedDisabled.Code != http.StatusOK || !strings.Contains(storedDisabled.Body.String(), `"enabled":false`) {
		t.Fatalf("get disabled GEO status=%d body=%s", storedDisabled.Code, storedDisabled.Body.String())
	}

	if _, err := pool.Exec(context.Background(), `
		UPDATE users SET membership_tier = 'free' WHERE id = $1
	`, user.ID); err != nil {
		t.Fatalf("downgrade GEO test user: %v", err)
	}
	forbidden := requestWechatGeoSummary(
		t, app, user.AuthUserID, user.SessionVersion, document.DocID, document.Title, document.Content,
	)
	if forbidden.Code != http.StatusForbidden || !strings.Contains(forbidden.Body.String(), "membership_required") {
		t.Fatalf("free GEO status=%d body=%s", forbidden.Code, forbidden.Body.String())
	}
	forbiddenGet := requestWechatGeoSummaryGet(t, app, user.AuthUserID, user.SessionVersion, document.DocID)
	if forbiddenGet.Code != http.StatusForbidden || !strings.Contains(forbiddenGet.Body.String(), "membership_required") {
		t.Fatalf("free saved GEO status=%d body=%s", forbiddenGet.Code, forbiddenGet.Body.String())
	}
}

func TestWechatGeoSummaryGenerateWithBYOKDoesNotUseCredits(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer byok-geo-key" {
			t.Fatalf("unexpected BYOK GEO provider request: path=%q authorization=%q", r.URL.Path, r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{
				"message": map[string]string{"content": `{
					"summary":"文章介绍了如何整理长文结构并改善移动端阅读体验。",
					"topics":["长文结构","移动阅读","编辑流程"],
					"keywords":["公众号写作","文章结构","移动端排版","内容编辑","长文阅读"]
				}`},
				"finish_reason": "stop",
			}},
		})
	}))
	defer provider.Close()

	app, pool, user, document := newAgentReviewCreateTest(t, config.Config{
		SessionSecret:              "wechat-geo-byok-test",
		LLMCredentialEncryptionKey: "wechat-geo-byok-encryption-test",
	})
	app.agentLLMHTTPClient = provider.Client()
	insertAgentReviewChannelForTest(t, app, pool, user.ID, "openai", provider.URL, "byok-geo-model", "byok-geo-key")
	if _, err := pool.Exec(context.Background(), `
		UPDATE users SET agent_provider_mode = 'byok' WHERE id = $1
	`, user.ID); err != nil {
		t.Fatal(err)
	}

	response := requestWechatGeoSummary(
		t, app, user.AuthUserID, user.SessionVersion, document.DocID, document.Title, document.Content,
	)
	if response.Code != http.StatusOK {
		t.Fatalf("generate BYOK GEO status=%d body=%s", response.Code, response.Body.String())
	}
	var payload struct {
		Geo wechatGeoSummaryView `json:"geo"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatalf("decode BYOK GEO response: %v", err)
	}
	if payload.Geo.ProviderMode != "byok" || payload.Geo.Model != "byok-geo-model" || payload.Geo.CreditsCharged != 0 {
		t.Fatalf("unexpected BYOK GEO response: %+v", payload.Geo)
	}
	var reservations int
	if err := pool.QueryRow(context.Background(), `
		SELECT count(*) FROM credit_reservations WHERE user_id = $1
	`, user.ID).Scan(&reservations); err != nil {
		t.Fatalf("count BYOK GEO reservations: %v", err)
	}
	if reservations != 0 {
		t.Fatalf("BYOK GEO reservations=%d, want 0", reservations)
	}
}

func TestWechatGeoSummaryProviderFailureReleasesBuiltinCredits(t *testing.T) {
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "provider unavailable", http.StatusServiceUnavailable)
	}))
	defer provider.Close()

	app, pool, user, document := newAgentReviewCreateTest(t, config.Config{
		SessionSecret:    "wechat-geo-release-test",
		AgentLLMProtocol: "openai",
		AgentLLMBaseURL:  provider.URL,
		AgentLLMAPIKey:   "geo-release-key",
		AgentLLMModel:    "geo-release-model",
	})
	app.agentLLMHTTPClient = provider.Client()
	grantCreditsForTest(t, pool, user.ID, 3, "wechat-geo-release")

	response := requestWechatGeoSummary(
		t, app, user.AuthUserID, user.SessionVersion, document.DocID, document.Title, document.Content,
	)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("failed GEO status=%d body=%s", response.Code, response.Body.String())
	}
	balance, err := app.loadCreditBalance(context.Background(), user.ID)
	if err != nil {
		t.Fatalf("load balance after failed GEO: %v", err)
	}
	if balance != (creditAccountBalance{Balance: 3, Reserved: 0, Available: 3}) {
		t.Fatalf("failed GEO balance=%+v, want untouched balance", balance)
	}
	var active, released int
	if err := pool.QueryRow(context.Background(), `
		SELECT count(*) FILTER (WHERE status = 'active'), count(*) FILTER (WHERE status = 'released')
		FROM credit_reservations
		WHERE user_id = $1 AND review_id IS NULL
	`, user.ID).Scan(&active, &released); err != nil {
		t.Fatalf("count failed GEO reservations: %v", err)
	}
	if active != 0 || released != 1 {
		t.Fatalf("failed GEO reservations active=%d released=%d, want 0/1", active, released)
	}
	var summaries int
	if err := pool.QueryRow(context.Background(), `
		SELECT count(*) FROM document_wechat_geo_summaries summary
		JOIN documents document ON document.id = summary.document_id
		WHERE document.doc_id = $1
	`, document.DocID).Scan(&summaries); err != nil {
		t.Fatalf("count failed GEO summaries: %v", err)
	}
	if summaries != 0 {
		t.Fatalf("failed GEO summaries=%d, want 0", summaries)
	}
}

func requestWechatGeoSummary(
	t *testing.T,
	app *App,
	authUserID string,
	sessionVersion int64,
	docID string,
	title string,
	content string,
) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(map[string]string{"title": title, "content": content})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/documents/"+docID+"/wechat-geo-summary/generate",
		strings.NewReader(string(body)),
	)
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(sessionCookieFor(t, app, authUserID, sessionVersion))
	response := httptest.NewRecorder()
	app.Routes().ServeHTTP(response, request)
	return response
}

func requestWechatGeoSummaryGet(
	t *testing.T,
	app *App,
	authUserID string,
	sessionVersion int64,
	docID string,
) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/api/documents/"+docID+"/wechat-geo-summary", nil)
	request.AddCookie(sessionCookieFor(t, app, authUserID, sessionVersion))
	response := httptest.NewRecorder()
	app.Routes().ServeHTTP(response, request)
	return response
}

func requestWechatGeoSummaryUpdate(
	t *testing.T,
	app *App,
	authUserID string,
	sessionVersion int64,
	docID string,
	text string,
) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(map[string]string{"text": text})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(
		http.MethodPut,
		"/api/documents/"+docID+"/wechat-geo-summary",
		strings.NewReader(string(body)),
	)
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(sessionCookieFor(t, app, authUserID, sessionVersion))
	response := httptest.NewRecorder()
	app.Routes().ServeHTTP(response, request)
	return response
}

func requestWechatGeoSummaryEnabled(
	t *testing.T,
	app *App,
	authUserID string,
	sessionVersion int64,
	docID string,
	enabled bool,
) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(map[string]bool{"enabled": enabled})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(
		http.MethodPut,
		"/api/documents/"+docID+"/wechat-geo-summary",
		strings.NewReader(string(body)),
	)
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(sessionCookieFor(t, app, authUserID, sessionVersion))
	response := httptest.NewRecorder()
	app.Routes().ServeHTTP(response, request)
	return response
}
