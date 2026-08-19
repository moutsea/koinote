package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"koinote/backend/internal/config"
	"koinote/backend/internal/model"
)

func TestAgentReviewCreateProviderAndCredits(t *testing.T) {
	t.Run("built-in provider charges reported token usage", func(t *testing.T) {
		provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer builtin-test-key" {
				t.Fatalf("unexpected built-in provider request: path=%q authorization=%q", r.URL.Path, r.Header.Get("Authorization"))
			}
			writeOpenAIAgentReviewResponse(t, w, "Ordinary title", "The first paragraph is too long.", 2_800, 1_200)
		}))
		defer provider.Close()

		app, pool, user, document := newAgentReviewCreateTest(t, config.Config{
			SessionSecret:    "agent-review-builtin-test",
			AgentLLMProtocol: "openai",
			AgentLLMBaseURL:  provider.URL,
			AgentLLMAPIKey:   "builtin-test-key",
			AgentLLMModel:    "test-openai-model",
		})
		app.agentLLMHTTPClient = provider.Client()
		grantCreditsForTest(t, pool, user.ID, 20, "agent-review-builtin")

		response := requestAgentReviewCreate(t, app, user, document.DocID, `{"providerMode":"builtin"}`)
		if response.Code != http.StatusAccepted {
			t.Fatalf("create built-in review status=%d body=%s", response.Code, response.Body.String())
		}
		initial := decodeAgentReviewResponse(t, response)
		if initial.Status != "running" {
			t.Fatalf("initial built-in review status=%q, want running", initial.Status)
		}
		review := waitForAgentReviewStatus(t, app, user.ID, initial.ReviewID, "ready")
		if review.Status != "ready" || review.CreditsCharged != 2 || review.TotalTokens != 4_000 {
			t.Fatalf("unexpected built-in review: %+v", review)
		}
		if review.TitleScore == nil || *review.TitleScore != 55 || len(review.Suggestions) != 3 {
			t.Fatalf("title score or suggestions missing: %+v", review)
		}
		balance, err := app.loadCreditBalance(context.Background(), user.ID)
		if err != nil {
			t.Fatal(err)
		}
		if balance != (creditAccountBalance{Balance: 18, Reserved: 0, Available: 18}) {
			t.Fatalf("built-in balance=%+v, want 18 available and no reservation", balance)
		}
	})

	t.Run("BYOK Anthropic succeeds without credits", func(t *testing.T) {
		provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/v1/messages" || r.Header.Get("x-api-key") != "byok-test-key" {
				t.Fatalf("unexpected BYOK provider request: path=%q api-key=%q", r.URL.Path, r.Header.Get("x-api-key"))
			}
			writeAnthropicAgentReviewResponse(t, w, "Ordinary title", "The first paragraph is too long.", 1_500, 600)
		}))
		defer provider.Close()

		app, pool, user, document := newAgentReviewCreateTest(t, config.Config{
			SessionSecret:              "agent-review-byok-test",
			LLMCredentialEncryptionKey: "agent-review-byok-encryption-test",
		})
		app.agentLLMHTTPClient = provider.Client()
		channelID := insertAgentReviewChannelForTest(t, app, pool, user.ID, "anthropic", provider.URL, "test-claude-model", "byok-test-key")
		if _, err := pool.Exec(context.Background(), `
			UPDATE users SET agent_provider_mode = 'byok' WHERE id = $1
		`, user.ID); err != nil {
			t.Fatal(err)
		}

		response := requestAgentReviewCreate(
			t, app, user, document.DocID, `{}`,
		)
		if response.Code != http.StatusAccepted {
			t.Fatalf("create BYOK review status=%d body=%s", response.Code, response.Body.String())
		}
		initial := decodeAgentReviewResponse(t, response)
		review := waitForAgentReviewStatus(t, app, user.ID, initial.ReviewID, "ready")
		if review.Status != "ready" || review.ProviderProtocol != "anthropic" ||
			review.CreditsCharged != 0 || review.TotalTokens != 2_100 {
			t.Fatalf("unexpected BYOK review: %+v", review)
		}
		if review.ChannelID == nil || *review.ChannelID != channelID {
			t.Fatalf("review channel=%v, want %s", review.ChannelID, channelID)
		}
		balance, err := app.loadCreditBalance(context.Background(), user.ID)
		if err != nil {
			t.Fatal(err)
		}
		if balance != (creditAccountBalance{}) {
			t.Fatalf("BYOK consumed credits: %+v", balance)
		}
		var reservations int
		if err := pool.QueryRow(context.Background(), `
			SELECT count(*) FROM credit_reservations reservation
			JOIN agent_reviews review ON review.id = reservation.review_id
			WHERE review.review_id = $1
		`, review.ReviewID).Scan(&reservations); err != nil {
			t.Fatal(err)
		}
		if reservations != 0 {
			t.Fatalf("BYOK created %d credit reservations", reservations)
		}
	})

	t.Run("provider failure releases reservation", func(t *testing.T) {
		provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"error":{"message":"provider unavailable"}}`))
		}))
		defer provider.Close()

		app, pool, user, document := newAgentReviewCreateTest(t, config.Config{
			SessionSecret:    "agent-review-failure-test",
			AgentLLMProtocol: "openai",
			AgentLLMBaseURL:  provider.URL,
			AgentLLMAPIKey:   "builtin-test-key",
			AgentLLMModel:    "test-openai-model",
		})
		app.agentLLMHTTPClient = provider.Client()
		grantCreditsForTest(t, pool, user.ID, 20, "agent-review-failure")

		response := requestAgentReviewCreate(t, app, user, document.DocID, `{"providerMode":"builtin"}`)
		if response.Code != http.StatusAccepted {
			t.Fatalf("provider failure create status=%d body=%s", response.Code, response.Body.String())
		}
		initial := decodeAgentReviewResponse(t, response)
		failed := waitForAgentReviewStatus(t, app, user.ID, initial.ReviewID, "failed")
		if failed.ErrorCode == nil || *failed.ErrorCode != "provider_http_error" {
			t.Fatalf("provider failure review=%+v", failed)
		}
		balance, err := app.loadCreditBalance(context.Background(), user.ID)
		if err != nil {
			t.Fatal(err)
		}
		if balance != (creditAccountBalance{Balance: 20, Reserved: 0, Available: 20}) {
			t.Fatalf("failed review did not release credits: %+v", balance)
		}
		var status, errorCode string
		var activeReservations int
		if err := pool.QueryRow(context.Background(), `
			SELECT review.status, review.error_code,
			       count(*) FILTER (WHERE reservation.status = 'active')
			FROM agent_reviews review
			LEFT JOIN credit_reservations reservation ON reservation.review_id = review.id
			WHERE review.document_id = (SELECT id FROM documents WHERE doc_id = $1)
			GROUP BY review.id
		`, document.DocID).Scan(&status, &errorCode, &activeReservations); err != nil {
			t.Fatal(err)
		}
		if status != "failed" || errorCode != "provider_http_error" || activeReservations != 0 {
			t.Fatalf("failed review status=%q code=%q active reservations=%d", status, errorCode, activeReservations)
		}
	})

	t.Run("document change during provider call marks review stale", func(t *testing.T) {
		requestStarted := make(chan struct{})
		releaseResponse := make(chan struct{})
		provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			close(requestStarted)
			<-releaseResponse
			writeOpenAIAgentReviewResponse(t, w, "Ordinary title", "The first paragraph is too long.", 1_400, 600)
		}))
		defer provider.Close()

		app, pool, user, document := newAgentReviewCreateTest(t, config.Config{
			SessionSecret:    "agent-review-stale-test",
			AgentLLMProtocol: "openai",
			AgentLLMBaseURL:  provider.URL,
			AgentLLMAPIKey:   "builtin-test-key",
			AgentLLMModel:    "test-openai-model",
		})
		app.agentLLMHTTPClient = provider.Client()
		grantCreditsForTest(t, pool, user.ID, 20, "agent-review-stale")

		response := requestAgentReviewCreate(t, app, user, document.DocID, `{"providerMode":"builtin"}`)
		if response.Code != http.StatusAccepted {
			t.Fatalf("stale review create status=%d body=%s", response.Code, response.Body.String())
		}
		initial := decodeAgentReviewResponse(t, response)
		select {
		case <-requestStarted:
		case <-time.After(5 * time.Second):
			t.Fatal("provider request did not start")
		}
		updated, err := app.updateDocument(context.Background(), updateDocumentParams{
			User: user, DocID: document.DocID, Title: document.Title, Theme: document.Theme,
			Content:          "The user changed the document while the review was running.",
			ExpectedRevision: document.Revision, Source: documentSourceWeb,
		})
		if err != nil {
			t.Fatal(err)
		}
		close(releaseResponse)
		review := waitForAgentReviewStatus(t, app, user.ID, initial.ReviewID, "stale")
		if review.Status != "stale" || review.BaseRevision != document.Revision || review.DocumentRevision != updated.Revision {
			t.Fatalf("concurrent update did not mark review stale: %+v", review)
		}
		balance, err := app.loadCreditBalance(context.Background(), user.ID)
		if err != nil {
			t.Fatal(err)
		}
		if balance != (creditAccountBalance{Balance: 19, Reserved: 0, Available: 19}) {
			t.Fatalf("completed stale review charge mismatch: %+v", balance)
		}
	})
}

func TestAgentReviewGetExpiresOrphanedRunningReview(t *testing.T) {
	app, pool, user, document := newAgentReviewCreateTest(t, config.Config{
		SessionSecret: "agent-review-expiry-test",
	})
	ctx := context.Background()
	insertRunning := func(createdAt time.Time) string {
		t.Helper()
		reviewID, err := randomUUID()
		if err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `
			INSERT INTO agent_reviews (
				review_id, user_id, document_id, base_revision, current_revision,
				provider_mode, provider_protocol, model, status, created_at, updated_at
			)
			SELECT $1, $2, id, $3, $3, 'byok', 'anthropic', 'test-model',
			       'running', $4, $4
			FROM documents WHERE doc_id = $5 AND user_id = $2
		`, reviewID, user.ID, document.Revision, createdAt, document.DocID); err != nil {
			t.Fatal(err)
		}
		return reviewID
	}

	staleReviewID := insertRunning(time.Now().UTC().Add(-agentReviewStaleAfter - time.Minute))
	freshReviewID := insertRunning(time.Now().UTC())
	request := httptest.NewRequest(http.MethodGet, "/api/agent/reviews/"+staleReviewID, nil)
	request.AddCookie(sessionCookieFor(t, app, user.AuthUserID, user.SessionVersion))
	response := httptest.NewRecorder()
	app.Routes().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("expired review get status=%d body=%s", response.Code, response.Body.String())
	}
	review := decodeAgentReviewResponse(t, response)
	if review.Status != "failed" || review.ErrorCode == nil || *review.ErrorCode != "review_timeout" || review.CompletedAt == nil {
		t.Fatalf("expired review was not reclaimed: %+v", review)
	}
	var freshStatus string
	if err := pool.QueryRow(ctx, `
		SELECT status FROM agent_reviews WHERE review_id = $1 AND user_id = $2
	`, freshReviewID, user.ID).Scan(&freshStatus); err != nil {
		t.Fatal(err)
	}
	if freshStatus != "running" {
		t.Fatalf("fresh review status=%q, want running", freshStatus)
	}
}

func newAgentReviewCreateTest(
	t *testing.T,
	cfg config.Config,
) (*App, *pgxpool.Pool, model.User, model.Document) {
	t.Helper()
	pool, userID := newCreditTestUser(t)
	if _, err := pool.Exec(context.Background(), `
		UPDATE users SET membership_tier = 'lifetime' WHERE id = $1
	`, userID); err != nil {
		t.Fatal(err)
	}
	app := New(cfg, pool)
	user := loadAgentReviewTestUser(t, app, pool, userID)
	document, err := app.createDocument(context.Background(), createDocumentParams{
		User:    user,
		Title:   "Ordinary title",
		Content: "The first paragraph is too long.\n\nThe second paragraph is clear.",
	})
	if err != nil {
		t.Fatal(err)
	}
	return app, pool, user, document
}

func insertAgentReviewChannelForTest(
	t *testing.T,
	app *App,
	pool *pgxpool.Pool,
	userID int,
	protocol string,
	baseURL string,
	modelName string,
	apiKey string,
) string {
	t.Helper()
	channelID, err := randomUUID()
	if err != nil {
		t.Fatal(err)
	}
	ciphertext, err := app.encryptLLMCredential(channelID, apiKey)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO llm_channels (
			channel_id, user_id, name, protocol, base_url, model,
			api_key_ciphertext, api_key_hint, is_default
		)
		VALUES ($1, $2, 'Test channel', $3, $4, $5, $6, $7, true)
	`, channelID, userID, protocol, baseURL, modelName, ciphertext, llmAPIKeyHint(apiKey)); err != nil {
		t.Fatal(err)
	}
	return channelID
}

func requestAgentReviewCreate(
	t *testing.T,
	app *App,
	user model.User,
	docID string,
	body string,
) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/documents/"+docID+"/agent-reviews",
		strings.NewReader(body),
	)
	request.Header.Set("Content-Type", "application/json")
	request.AddCookie(sessionCookieFor(t, app, user.AuthUserID, user.SessionVersion))
	response := httptest.NewRecorder()
	app.Routes().ServeHTTP(response, request)
	return response
}

func decodeAgentReviewResponse(t *testing.T, response *httptest.ResponseRecorder) agentReviewView {
	t.Helper()
	var payload struct {
		Review agentReviewView `json:"review"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatalf("decode agent review response: %v; body=%s", err, response.Body.String())
	}
	return payload.Review
}

func waitForAgentReviewStatus(
	t *testing.T,
	app *App,
	userID int,
	reviewID string,
	wantStatus string,
) agentReviewView {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		review, err := app.loadAgentReview(context.Background(), userID, reviewID, true)
		if err != nil {
			t.Fatalf("load agent review %s: %v", reviewID, err)
		}
		if review.Status == wantStatus {
			return review
		}
		if review.Status != "running" {
			t.Fatalf("agent review %s status=%q, want %q", reviewID, review.Status, wantStatus)
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("agent review %s did not reach %q", reviewID, wantStatus)
	return agentReviewView{}
}

func agentReviewJSONForTest(title, bodyBefore string) string {
	encoded, _ := json.Marshal(map[string]any{
		"summary":         "The article can be clearer and more specific.",
		"titleScore":      55,
		"titleAssessment": "The title is understandable but not specific enough.",
		"titleSuggestions": []map[string]string{
			{"after": "A specific and credible title", "reason": "It states the concrete value."},
			{"after": "A clearer alternative title", "reason": "It helps the target reader understand the topic."},
		},
		"bodySuggestions": []map[string]string{
			{
				"category": "clarity",
				"before":   bodyBefore,
				"after":    "The first paragraph is concise.",
				"reason":   "This removes unnecessary wording without changing the claim.",
			},
		},
		"layoutAssessment":  testWritingLayoutAssessment(),
		"layoutSuggestions": []any{},
	})
	_ = title
	return string(encoded)
}

func testWritingLayoutAssessment() []map[string]any {
	result := make([]map[string]any, 0, len(writingReviewDimensionIDs))
	for _, id := range writingReviewDimensionIDs {
		result = append(result, map[string]any{
			"id": id, "label": id, "score": 80, "summary": "The layout is sound.",
		})
	}
	return result
}

func writeOpenAIAgentReviewResponse(
	t *testing.T,
	w http.ResponseWriter,
	title string,
	bodyBefore string,
	inputTokens int,
	outputTokens int,
) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]any{
		"choices": []map[string]any{
			{
				"message":       map[string]string{"content": agentReviewJSONForTest(title, bodyBefore)},
				"finish_reason": "stop",
			},
		},
		"usage": map[string]int{
			"prompt_tokens":     inputTokens,
			"completion_tokens": outputTokens,
			"total_tokens":      inputTokens + outputTokens,
		},
	}); err != nil {
		t.Errorf("encode OpenAI test response: %v", err)
	}
}

func writeAnthropicAgentReviewResponse(
	t *testing.T,
	w http.ResponseWriter,
	title string,
	bodyBefore string,
	inputTokens int,
	outputTokens int,
) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(map[string]any{
		"content": []map[string]string{
			{"type": "text", "text": agentReviewJSONForTest(title, bodyBefore)},
		},
		"stop_reason": "end_turn",
		"usage": map[string]int{
			"input_tokens":  inputTokens,
			"output_tokens": outputTokens,
		},
	}); err != nil {
		t.Errorf("encode Anthropic test response: %v", err)
	}
}

func TestAgentReviewSuggestionMutations(t *testing.T) {
	pool, userID := newCreditTestUser(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `
		UPDATE users
		SET membership_tier = 'lifetime', document_history_enabled = false
		WHERE id = $1
	`, userID); err != nil {
		t.Fatal(err)
	}
	app := New(config.Config{SessionSecret: "agent-review-mutation-test"}, pool)
	user := loadAgentReviewTestUser(t, app, pool, userID)

	t.Run("单条落实与标题候选互斥", func(t *testing.T) {
		doc, err := app.createDocument(ctx, createDocumentParams{
			User: user, Title: "普通标题", Content: "第一段需要精简。\n\n第二段需要调整。",
		})
		if err != nil {
			t.Fatal(err)
		}
		reviewID, suggestions := insertReadyAgentReviewForTest(t, pool, user.ID, doc, []lockedAgentSuggestion{
			{Target: "title", Before: doc.Title, After: "更具体的标题"},
			{Target: "title", Before: doc.Title, After: "另一个标题"},
			{Target: "body", Before: "第一段需要精简。", After: "第一段更精炼。"},
			{Target: "body", Before: "第二段需要调整。", After: "第二段已经调整。"},
		})

		first, err := app.applyAgentReviewSuggestion(ctx, user, reviewID, suggestions[2], doc.Revision)
		if err != nil {
			t.Fatal(err)
		}
		if first.Document.Revision != 2 || first.Document.Content != "第一段更精炼。\n\n第二段需要调整。" ||
			first.Review.Status != "partially_applied" {
			t.Fatalf("首次落实结果异常: document=%+v review=%+v", first.Document, first.Review)
		}

		second, err := app.applyAgentReviewSuggestion(ctx, user, reviewID, suggestions[0], first.Document.Revision)
		if err != nil {
			t.Fatal(err)
		}
		if second.Document.Title != "更具体的标题" || second.Document.Revision != 3 {
			t.Fatalf("标题落实结果异常: %+v", second.Document)
		}
		statuses := suggestionStatusesForTest(t, pool, reviewID)
		if statuses[suggestions[0]] != "applied" || statuses[suggestions[1]] != "dismissed" {
			t.Fatalf("标题候选没有互斥关闭: %+v", statuses)
		}

		final, err := app.applyAllAgentReviewSuggestions(ctx, user, reviewID, second.Document.Revision)
		if err != nil {
			t.Fatal(err)
		}
		if final.Document.Revision != 4 || final.Review.Status != "applied" ||
			final.Document.Content != "第一段更精炼。\n\n第二段已经调整。" {
			t.Fatalf("最终落实结果异常: document=%+v review=%+v", final.Document, final.Review)
		}
		assertAgentHistoryForTest(t, pool, doc.DocID, []int64{1, 2, 3})
	})

	t.Run("一键落实选择第一条标题建议并倒序应用正文", func(t *testing.T) {
		doc, err := app.createDocument(ctx, createDocumentParams{
			User: user, Title: "原始标题", Content: "甲段落。\n\n乙段落。",
		})
		if err != nil {
			t.Fatal(err)
		}
		reviewID, suggestions := insertReadyAgentReviewForTest(t, pool, user.ID, doc, []lockedAgentSuggestion{
			{Target: "title", Before: doc.Title, After: "首选标题"},
			{Target: "title", Before: doc.Title, After: "备选标题"},
			{Target: "body", Before: "甲段落。", After: "甲段落已优化。"},
			{Target: "body", Before: "乙段落。", After: "乙段落已优化。"},
		})
		result, err := app.applyAllAgentReviewSuggestions(ctx, user, reviewID, doc.Revision)
		if err != nil {
			t.Fatal(err)
		}
		if result.Document.Title != "首选标题" ||
			result.Document.Content != "甲段落已优化。\n\n乙段落已优化。" ||
			result.Document.Revision != 2 || result.Review.Status != "applied" {
			t.Fatalf("一键落实结果异常: document=%+v review=%+v", result.Document, result.Review)
		}
		statuses := suggestionStatusesForTest(t, pool, reviewID)
		if statuses[suggestions[0]] != "applied" || statuses[suggestions[1]] != "dismissed" ||
			statuses[suggestions[2]] != "applied" || statuses[suggestions[3]] != "applied" {
			t.Fatalf("一键落实状态异常: %+v", statuses)
		}
		assertAgentHistoryForTest(t, pool, doc.DocID, []int64{1})
	})

	t.Run("结构排版建议沿用版本历史与逐条落实", func(t *testing.T) {
		doc, err := app.createDocument(ctx, createDocumentParams{
			User: user, Title: "排版测试", Content: "第一句。第二句。",
		})
		if err != nil {
			t.Fatal(err)
		}
		reviewID, suggestions := insertReadyAgentReviewForTest(t, pool, user.ID, doc, []lockedAgentSuggestion{{
			Target: "body", Kind: "layout", Operation: "split_paragraph",
			Before: "第一句。第二句。", After: "第一句。\n\n第二句。",
		}})
		result, err := app.applyAgentReviewSuggestion(ctx, user, reviewID, suggestions[0], doc.Revision)
		if err != nil {
			t.Fatal(err)
		}
		if result.Document.Content != "第一句。\n\n第二句。" || result.Document.Revision != 2 || result.Review.Status != "applied" {
			t.Fatalf("结构建议落实结果异常: document=%+v review=%+v", result.Document, result.Review)
		}
		if len(result.Review.Suggestions) != 1 || result.Review.Suggestions[0].Kind != "layout" ||
			result.Review.Suggestions[0].Operation == nil || *result.Review.Suggestions[0].Operation != "split_paragraph" {
			t.Fatalf("结构建议审计字段异常: %+v", result.Review.Suggestions)
		}
		assertAgentHistoryForTest(t, pool, doc.DocID, []int64{1})
	})

	t.Run("外部改动后 review 进入 stale", func(t *testing.T) {
		doc, err := app.createDocument(ctx, createDocumentParams{
			User: user, Title: "并发标题", Content: "等待优化。",
		})
		if err != nil {
			t.Fatal(err)
		}
		reviewID, suggestions := insertReadyAgentReviewForTest(t, pool, user.ID, doc, []lockedAgentSuggestion{
			{Target: "body", Before: "等待优化。", After: "优化完成。"},
		})
		updated, err := app.updateDocument(ctx, updateDocumentParams{
			User: user, DocID: doc.DocID, Title: doc.Title, Theme: doc.Theme,
			Content: "用户已经修改。", ExpectedRevision: doc.Revision, Source: documentSourceWeb,
		})
		if err != nil {
			t.Fatal(err)
		}
		_, err = app.applyAgentReviewSuggestion(ctx, user, reviewID, suggestions[0], updated.Revision)
		if !errors.Is(err, errAgentReviewStale) {
			t.Fatalf("外部改动后错误=%v，期望 stale", err)
		}
		var status string
		if err := pool.QueryRow(ctx, `SELECT status FROM agent_reviews WHERE review_id = $1`, reviewID).Scan(&status); err != nil {
			t.Fatal(err)
		}
		if status != "stale" {
			t.Fatalf("review status=%q，期望 stale", status)
		}
	})

	t.Run("跨用户不可读取或落实", func(t *testing.T) {
		doc, err := app.createDocument(ctx, createDocumentParams{User: user, Title: "隔离", Content: "原文。"})
		if err != nil {
			t.Fatal(err)
		}
		reviewID, suggestions := insertReadyAgentReviewForTest(t, pool, user.ID, doc, []lockedAgentSuggestion{
			{Target: "body", Before: "原文。", After: "修改。"},
		})
		other := insertAgentReviewTestUser(t, pool)
		_, err = app.applyAgentReviewSuggestion(ctx, other, reviewID, suggestions[0], doc.Revision)
		if !errors.Is(err, errAgentReviewNotFound) {
			t.Fatalf("跨用户落实错误=%v，期望 not found", err)
		}
	})
}

func loadAgentReviewTestUser(t *testing.T, app *App, pool *pgxpool.Pool, userID int) model.User {
	t.Helper()
	var authUserID string
	if err := pool.QueryRow(context.Background(), `SELECT auth_user_id FROM users WHERE id = $1`, userID).Scan(&authUserID); err != nil {
		t.Fatal(err)
	}
	user, err := app.getUserByAuthUserID(context.Background(), authUserID)
	if err != nil {
		t.Fatal(err)
	}
	return user
}

func insertAgentReviewTestUser(t *testing.T, pool *pgxpool.Pool) model.User {
	t.Helper()
	suffix, err := randomHex(8)
	if err != nil {
		t.Fatal(err)
	}
	var userID int
	if err := pool.QueryRow(context.Background(), `
		INSERT INTO users (auth_user_id, email, is_verified, membership_tier)
		VALUES ($1, $2, true, 'lifetime')
		RETURNING id
	`, "agent-other-"+suffix, "agent-other-"+suffix+"@example.test").Scan(&userID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `DELETE FROM users WHERE id = $1`, userID)
	})
	app := New(config.Config{SessionSecret: "agent-review-other-test"}, pool)
	return loadAgentReviewTestUser(t, app, pool, userID)
}

func insertReadyAgentReviewForTest(
	t *testing.T,
	pool *pgxpool.Pool,
	userID int,
	document model.Document,
	suggestions []lockedAgentSuggestion,
) (string, []string) {
	t.Helper()
	reviewID, err := randomUUID()
	if err != nil {
		t.Fatal(err)
	}
	var reviewDatabaseID int64
	if err := pool.QueryRow(context.Background(), `
		INSERT INTO agent_reviews (
			review_id, user_id, document_id, base_revision, current_revision,
			provider_mode, provider_protocol, model, status, summary,
			title_score, title_assessment, completed_at
		)
		SELECT $1, $2, id, $3, $3, 'byok', 'openai', 'test-model', 'ready',
		       '测试总结', 50, '测试标题评分', now()
		FROM documents WHERE doc_id = $4 AND user_id = $2
		RETURNING id
	`, reviewID, userID, document.Revision, document.DocID).Scan(&reviewDatabaseID); err != nil {
		t.Fatal(err)
	}
	ids := make([]string, 0, len(suggestions))
	for ordinal, suggestion := range suggestions {
		id, err := randomUUID()
		if err != nil {
			t.Fatal(err)
		}
		kind := suggestion.Kind
		if kind == "" {
			kind = "content"
		}
		category := "clarity"
		if suggestion.Target == "title" {
			category = "title"
		} else if kind == "layout" {
			category = "readability"
		}
		var operation any
		if suggestion.Operation != "" {
			operation = suggestion.Operation
		}
		if _, err := pool.Exec(context.Background(), `
			INSERT INTO agent_review_suggestions (
				suggestion_id, review_id, ordinal, target, suggestion_kind,
				category, operation, before_text, after_text, reason
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, '测试理由')
		`, id, reviewDatabaseID, ordinal, suggestion.Target, kind, category, operation, suggestion.Before, suggestion.After); err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	return reviewID, ids
}

func suggestionStatusesForTest(t *testing.T, pool *pgxpool.Pool, reviewID string) map[string]string {
	t.Helper()
	rows, err := pool.Query(context.Background(), `
		SELECT suggestion.suggestion_id, suggestion.status
		FROM agent_review_suggestions suggestion
		JOIN agent_reviews review ON review.id = suggestion.review_id
		WHERE review.review_id = $1
	`, reviewID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	result := make(map[string]string)
	for rows.Next() {
		var id string
		var status string
		if err := rows.Scan(&id, &status); err != nil {
			t.Fatal(err)
		}
		result[id] = status
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return result
}

func assertAgentHistoryForTest(t *testing.T, pool *pgxpool.Pool, docID string, revisions []int64) {
	t.Helper()
	rows, err := pool.Query(context.Background(), `
		SELECT version.revision, version.source
		FROM document_versions version
		JOIN documents document ON document.id = version.document_id
		WHERE document.doc_id = $1
		ORDER BY version.revision
	`, docID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	actual := make([]int64, 0)
	for rows.Next() {
		var revision int64
		var source string
		if err := rows.Scan(&revision, &source); err != nil {
			t.Fatal(err)
		}
		if source != "agent" {
			t.Fatalf("历史来源=%q，期望 agent", source)
		}
		actual = append(actual, revision)
	}
	if len(actual) != len(revisions) {
		t.Fatalf("历史 revisions=%v，期望 %v", actual, revisions)
	}
	for index := range actual {
		if actual[index] != revisions[index] {
			t.Fatalf("历史 revisions=%v，期望 %v", actual, revisions)
		}
	}
}
