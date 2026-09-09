package server

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const validAgentReviewJSON = `{
  "summary": "结构清楚，建议压缩开头并增强标题的具体性。",
  "titleScore": 55,
  "titleAssessment": "主题明确，但结果和受众不够具体。",
  "titleSuggestions": [
    {"after": "24 小时部署 Qwen：从本地到公网的完整记录", "reason": "补足时间、对象和结果。"},
    {"after": "一张 4090 跑 Qwen：下载、体验与公网部署", "reason": "直接点出读者最关心的硬件与路径。"}
  ],
  "bodySuggestions": [
    {"category": "clarity", "before": "这是原始句子。", "after": "这是更清楚的句子。", "reason": "减少抽象表达。"}
  ],
  "layoutAssessment": [
    {"id":"hierarchy","label":"层级","score":78,"summary":"标题层级基本清楚。"},
    {"id":"readability","label":"可读性","score":75,"summary":"段落长度适中。"},
    {"id":"emphasis","label":"重点","score":70,"summary":"重点可以更突出。"},
    {"id":"rhythm","label":"节奏","score":76,"summary":"阅读节奏自然。"},
    {"id":"modules","label":"模块","score":72,"summary":"模块划分基本合理。"},
    {"id":"mobile","label":"移动端","score":74,"summary":"适合移动端阅读。"}
  ],
  "layoutSuggestions": []
}`

// validateFullWritingReview 用不设作用域限制的方式校验一份完整审阅结果，覆盖
// 标题、正文、六维都齐全的场景。生产代码走的是分任务校验，每个任务各带自己的
// 作用域；这里只是把作用域全开，验证校验规则本身。
func validateFullWritingReview(
	raw []byte,
	title string,
	content string,
) (validatedWritingReview, error) {
	return parseAndValidateWritingReviewWithScopes(raw, title, content, writingReviewValidationScope{
		HasTitleReview: true, HasLayoutReview: true,
	})
}

// transportTestPrompt 给传输层测试一个形状真实的提示词。这些用例验证的是 HTTP
// 编解码，不是提示词内容，所以直接取生产计划里的标题任务，避免为测试单独维护一份
// 用户永远走不到的提示词。
func transportTestPrompt(t *testing.T) agentLLMPrompt {
	t.Helper()
	plan, err := buildWritingReviewTaskPlan("原标题", "这是原始句子。", "title")
	if err != nil {
		t.Fatalf("build transport test plan: %v", err)
	}
	if len(plan.Tasks) != 1 {
		t.Fatalf("transport test plan tasks = %d, want 1", len(plan.Tasks))
	}
	return plan.Tasks[0].Prompt
}

// 评分标准分散在四个任务提示词里，每个任务只带自己那一份。这里逐个任务断言它的
// 核心规则还在——规则被误删时，用户看到的是模型退回泛泛而谈的建议，没有别的信号。
func TestWritingReviewTaskPromptsCarryTheirRubric(t *testing.T) {
	checksByPrompt := map[string][]string{
		writingReviewTitleSystemPrompt: {
			"promise-to-evidence fit",
			"Never invent authority, figures, urgency, outcomes, pain points, or claims",
			"never inflate it to reduce the work owed by the ranges below",
			"must differ from the others in angle",
		},
		writingReviewBodySystemPrompt: {
			"state what a reader loses without it",
			"recites a generic writing rule",
			"smooth repetitive parallelism",
			`repeated "not X but Y" turns`,
			"Returning none is a valid answer",
		},
		writingReviewDocumentSystemPrompt: {
			"only reviewer that spans sections",
			"impossible to see from inside a single section",
			"Never encode a move or consolidation as coordinated",
			"partial=true",
		},
		writingReviewLayoutSystemPrompt: {
			"hierarchy, readability, emphasis, rhythm, modules, and mobile",
			"without rewriting words",
			"Never change links, images, code, formulas, or factual wording",
		},
		writingReviewProofreadSystemPrompt: {
			"Do not optimize the article's structure, argument, engagement, tone, or paragraph order",
			"uniquely occurring byte-for-byte substring",
		},
	}
	for prompt, checks := range checksByPrompt {
		for _, check := range checks {
			if !strings.Contains(prompt, check) {
				t.Errorf("system prompt starting %q is missing rubric rule %q", prompt[:40], check)
			}
		}
	}
}

func TestCallOpenAIAgentLLMUsesStrictStructuredOutput(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("OpenAI path = %q", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer sk-test" {
			t.Errorf("OpenAI authorization header = %q", r.Header.Get("Authorization"))
		}
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode OpenAI request: %v", err)
		}
		responseFormat, _ := payload["response_format"].(map[string]any)
		if responseFormat["type"] != "json_schema" {
			t.Errorf("OpenAI response format = %#v", responseFormat)
		}
		jsonSchema, _ := responseFormat["json_schema"].(map[string]any)
		if jsonSchema["strict"] != true {
			t.Errorf("OpenAI strict schema = %#v", jsonSchema)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{
				"message":       map[string]any{"content": validAgentReviewJSON},
				"finish_reason": "stop",
			}},
			"usage": map[string]int{
				"prompt_tokens":     1_900,
				"completion_tokens": 301,
				"total_tokens":      2_201,
			},
		})
	}))
	defer server.Close()

	prompt := transportTestPrompt(t)
	provider := agentLLMProvider{
		Mode:         "builtin",
		Protocol:     "openai",
		BaseURL:      server.URL + "/v1",
		APIKey:       "sk-test",
		Model:        "gpt-test",
		StrictOutput: true,
	}
	result, err := callAgentLLM(context.Background(), server.Client(), provider, prompt)
	if err != nil {
		t.Fatalf("call OpenAI agent LLM: %v", err)
	}
	if result.TotalTokens != 2_201 || result.InputTokens != 1_900 || result.OutputTokens != 301 {
		t.Fatalf("OpenAI usage = %+v", result)
	}
	if err := requireAgentLLMUsage(provider, result); err != nil {
		t.Fatalf("require OpenAI usage: %v", err)
	}
	if _, err := validateFullWritingReview(result.JSON, "原标题", "这是原始句子。"); err != nil {
		t.Fatalf("validate OpenAI review: %v", err)
	}
}

func TestCallOpenAICompatibleAgentLLMUsesJSONMode(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload struct {
			Messages []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"messages"`
			ResponseFormat map[string]any `json:"response_format"`
			MaxTokens      int            `json:"max_tokens"`
		}
		_ = json.NewDecoder(r.Body).Decode(&payload)
		if payload.ResponseFormat["type"] != "json_object" {
			t.Errorf("compatible response format = %#v", payload.ResponseFormat)
		}
		if payload.MaxTokens == 0 {
			t.Errorf("compatible request did not use max_tokens: %#v", payload.MaxTokens)
		}
		system := ""
		for _, message := range payload.Messages {
			if message.Role == "system" {
				system = message.Content
			}
		}
		if !strings.Contains(system, `"titleSuggestions"`) || !strings.Contains(system, `"additionalProperties":false`) {
			t.Errorf("compatible system prompt is missing the output schema")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{
				"message":       map[string]any{"content": "```json\n" + validAgentReviewJSON + "\n```"},
				"finish_reason": "stop",
			}},
			"usage": map[string]int{},
		})
	}))
	defer server.Close()

	prompt := transportTestPrompt(t)
	provider := agentLLMProvider{
		Mode:     "byok",
		Protocol: "openai",
		BaseURL:  server.URL + "/v1",
		APIKey:   "sk-test",
		Model:    "compatible-model",
	}
	result, err := callAgentLLM(context.Background(), server.Client(), provider, prompt)
	if err != nil {
		t.Fatalf("call OpenAI-compatible agent LLM: %v", err)
	}
	if err := requireAgentLLMUsage(provider, result); err != nil {
		t.Fatalf("BYOK should not require token usage: %v", err)
	}
	if _, err := validateFullWritingReview(result.JSON, "原标题", "这是原始句子。"); err != nil {
		t.Fatalf("validate compatible review: %v", err)
	}
}

func TestCallAnthropicAgentLLM(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/messages" {
			t.Errorf("Anthropic path = %q", r.URL.Path)
		}
		if r.Header.Get("x-api-key") != "sk-ant-test" || r.Header.Get("anthropic-version") != "2023-06-01" {
			t.Errorf("Anthropic headers = %#v", r.Header)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"content":     []map[string]string{{"type": "text", "text": validAgentReviewJSON}},
			"stop_reason": "end_turn",
			"usage": map[string]int{
				"input_tokens":  1_500,
				"output_tokens": 250,
			},
		})
	}))
	defer server.Close()

	prompt := transportTestPrompt(t)
	provider := agentLLMProvider{
		Mode:     "byok",
		Protocol: "anthropic",
		BaseURL:  server.URL,
		APIKey:   "sk-ant-test",
		Model:    "claude-test",
	}
	result, err := callAgentLLM(context.Background(), server.Client(), provider, prompt)
	if err != nil {
		t.Fatalf("call Anthropic agent LLM: %v", err)
	}
	if result.TotalTokens != 1_750 {
		t.Fatalf("Anthropic usage = %+v", result)
	}
	if _, err := validateFullWritingReview(result.JSON, "原标题", "这是原始句子。"); err != nil {
		t.Fatalf("validate Anthropic review: %v", err)
	}
}

func TestCallAnthropicBuiltinUsesEphemeralPromptCache(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode Anthropic request: %v", err)
		}
		system, ok := payload["system"].([]any)
		if !ok || len(system) != 1 {
			t.Fatalf("builtin Anthropic system blocks = %#v", payload["system"])
		}
		block, ok := system[0].(map[string]any)
		if !ok || block["type"] != "text" || block["text"] == "" {
			t.Fatalf("builtin Anthropic system block = %#v", system[0])
		}
		cacheControl, ok := block["cache_control"].(map[string]any)
		if !ok || cacheControl["type"] != "ephemeral" {
			t.Fatalf("builtin Anthropic cache control = %#v", block["cache_control"])
		}
		w.Header().Set("Content-Type", "text/event-stream")
		streamText, _ := json.Marshal(validAgentReviewJSON)
		_, _ = io.WriteString(w, "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":1500,\"output_tokens\":0}}}\n\n")
		_, _ = io.WriteString(w, "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":"+string(streamText)+"}}\n\n")
		_, _ = io.WriteString(w, "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":250}}\n\n")
		_, _ = io.WriteString(w, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
	}))
	defer server.Close()

	result, err := callAgentLLM(context.Background(), server.Client(), agentLLMProvider{
		Mode: "builtin", Protocol: "anthropic", BaseURL: server.URL,
		APIKey: "sk-ant-test", Model: "claude-sonnet-5",
	}, transportTestPrompt(t))
	if err != nil {
		t.Fatalf("call builtin Anthropic agent LLM: %v", err)
	}
	if result.TotalTokens != 1_750 {
		t.Fatalf("builtin Anthropic usage = %+v", result)
	}
}

func TestCallAnthropicAgentLLMConsumesSSEWithoutVendorExtensions(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode Anthropic request: %v", err)
		}
		if payload["stream"] != true {
			t.Errorf("Anthropic stream flag = %#v", payload["stream"])
		}
		// 任务提示词自带更小的输出上限，不应被放大到全局默认值。
		if payload["max_tokens"] != float64(agentReviewTitleMaxOutputTokens) {
			t.Errorf("Anthropic max_tokens = %#v", payload["max_tokens"])
		}
		system, _ := payload["system"].(string)
		if !strings.Contains(system, `"titleSuggestions"`) || !strings.Contains(system, `"additionalProperties":false`) {
			t.Errorf("Anthropic system prompt is missing the output schema")
		}
		if _, exists := payload["thinking"]; exists {
			t.Errorf("Anthropic-compatible payload unexpectedly enabled thinking: %#v", payload["thinking"])
		}
		if _, exists := payload["output_config"]; exists {
			t.Errorf("Anthropic-compatible payload unexpectedly set output_config: %#v", payload["output_config"])
		}
		if payload["temperature"] != 0.2 {
			t.Errorf("Anthropic temperature = %#v", payload["temperature"])
		}
		if r.Header.Get("Authorization") != "Bearer sk-ant-test" {
			t.Errorf("Anthropic authorization = %q", r.Header.Get("Authorization"))
		}
		w.Header().Set("Content-Type", "text/event-stream")
		streamText, _ := json.Marshal(validAgentReviewJSON)
		_, _ = io.WriteString(w, "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":1500,\"output_tokens\":0}}}\n\n")
		_, _ = io.WriteString(w, "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":"+string(streamText)+"}}\n\n")
		_, _ = io.WriteString(w, "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":250}}\n\n")
		_, _ = io.WriteString(w, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
	}))
	defer server.Close()

	prompt := transportTestPrompt(t)
	provider := agentLLMProvider{
		Mode:     "byok",
		Protocol: "anthropic",
		BaseURL:  server.URL,
		APIKey:   "sk-ant-test",
		Model:    "claude-sonnet-5",
	}
	result, err := callAgentLLM(context.Background(), server.Client(), provider, prompt)
	if err != nil {
		t.Fatalf("call streaming Anthropic agent LLM: %v", err)
	}
	if result.InputTokens != 1_500 || result.OutputTokens != 250 || result.TotalTokens != 1_750 {
		t.Fatalf("streaming Anthropic usage = %+v", result)
	}
	if _, err := validateFullWritingReview(result.JSON, "原标题", "这是原始句子。"); err != nil {
		t.Fatalf("validate streaming Anthropic review: %v", err)
	}
}

func TestCallAnthropicAgentLLMRetriesEmptyStream(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		w.Header().Set("Content-Type", "text/event-stream")
		if requests == 1 {
			_, _ = io.WriteString(w, "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n")
			return
		}
		streamText, _ := json.Marshal(validAgentReviewJSON)
		_, _ = io.WriteString(w, "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":1500,\"output_tokens\":0}}}\n\n")
		_, _ = io.WriteString(w, "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":"+string(streamText)+"}}\n\n")
		_, _ = io.WriteString(w, "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":250}}\n\n")
	}))
	defer server.Close()

	prompt := transportTestPrompt(t)
	result, err := callAgentLLM(context.Background(), server.Client(), agentLLMProvider{
		Mode: "builtin", Protocol: "anthropic", BaseURL: server.URL,
		APIKey: "sk-ant-test", Model: "claude-sonnet-5",
	}, prompt)
	if err != nil {
		t.Fatal(err)
	}
	if requests != 2 || result.TotalTokens != 1_750 {
		t.Fatalf("requests=%d result=%+v", requests, result)
	}
}

func TestParseAnthropicEventStreamReturnsProviderError(t *testing.T) {
	_, err := parseAnthropicEventStream(strings.NewReader(
		"event: error\ndata: {\"type\":\"error\",\"error\":{\"type\":\"rate_limit_error\",\"message\":\"try later\"}}\n\n",
	))
	var providerError *agentLLMHTTPError
	if !errors.As(err, &providerError) || providerError.Status != http.StatusTooManyRequests || providerError.Message != "try later" {
		t.Fatalf("error=%v", err)
	}
}

// 校验失败要重试一次，并把两次调用的 token 累加后一起扣费——漏掉累加等于让用户
// 白拿一次失败调用的额度。
func TestExecuteWritingReviewTaskRetriesInvalidJSONAndSumsUsage(t *testing.T) {
	const validTitleJSON = `{
  "summary": "结构清楚，建议压缩开头并增强标题的具体性。",
  "titleScore": 55,
  "titleAssessment": "主题明确，但结果和受众不够具体。",
  "titleSuggestions": [
    {"after": "24 小时部署 Qwen：从本地到公网的完整记录", "reason": "补足时间、对象和结果。"}
  ]
}`
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		var payload struct {
			Messages []struct {
				Content string `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode retry request: %v", err)
		}
		if requests == 2 && (len(payload.Messages) != 1 || !strings.Contains(payload.Messages[0].Content, "Validator feedback:")) {
			t.Errorf("retry prompt did not include validator feedback: %#v", payload.Messages)
		}
		text := "{"
		inputTokens, outputTokens := 100, 50
		if requests == 2 {
			text = validTitleJSON
			inputTokens, outputTokens = 110, 60
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"content":     []map[string]string{{"type": "text", "text": text}},
			"stop_reason": "end_turn",
			"usage": map[string]int{
				"input_tokens":  inputTokens,
				"output_tokens": outputTokens,
			},
		})
	}))
	defer server.Close()

	const title = "原标题"
	const content = "这是原始句子。"
	plan, err := buildWritingReviewTaskPlan(title, content, "title")
	if err != nil {
		t.Fatal(err)
	}
	result, err := executeWritingReviewTask(
		context.Background(), server.Client(),
		agentLLMProvider{
			Mode: "builtin", Protocol: "anthropic", BaseURL: server.URL,
			APIKey: "sk-ant-test", Model: "claude-sonnet-5",
		},
		plan.Tasks[0], title, content, parseMarkdownReviewBlocks(content),
	)
	if err != nil {
		t.Fatalf("execute writing review task: %v", err)
	}
	if requests != 2 {
		t.Fatalf("provider requests=%d, want 2", requests)
	}
	if result.Usage.InputTokens != 210 || result.Usage.OutputTokens != 110 || result.Usage.TotalTokens != 320 {
		t.Fatalf("combined retry usage=%+v", result.Usage)
	}
	if result.Validated.TitleScore != 55 || len(result.Validated.Suggestions) != 1 {
		t.Fatalf("validated retry review=%+v", result.Validated)
	}
	// 标题任务不评六维，不能把占位分数当成结论落库。
	if len(result.Validated.LayoutAssessment) != 0 {
		t.Fatalf("title task layout assessment=%+v, want empty", result.Validated.LayoutAssessment)
	}
}

func TestParseWritingReviewAcceptsStringTitleSuggestions(t *testing.T) {
	raw := `{
  "summary": "结构清楚，但标题可以更具体。",
  "titleScore": 55,
  "titleAssessment": "当前标题没有明确说明读者收益。",
  "titleSuggestions": ["更具体的标题一", "更具体的标题二"],
  "bodySuggestions": [],
  "layoutAssessment": [
    {"id":"hierarchy","label":"层级","score":80,"summary":"层级清楚。"},
    {"id":"readability","label":"可读性","score":80,"summary":"阅读顺畅。"},
    {"id":"emphasis","label":"重点","score":80,"summary":"重点明确。"},
    {"id":"rhythm","label":"节奏","score":80,"summary":"节奏自然。"},
    {"id":"modules","label":"模块","score":80,"summary":"模块合理。"},
    {"id":"mobile","label":"移动端","score":80,"summary":"移动端友好。"}
  ],
  "layoutSuggestions": []
}`
	review, err := validateFullWritingReview([]byte(raw), "原标题", "正文")
	if err != nil {
		t.Fatalf("parse string title suggestions: %v", err)
	}
	if len(review.Suggestions) != 2 || review.Suggestions[0].After != "更具体的标题一" ||
		review.Suggestions[0].Reason != "当前标题没有明确说明读者收益。" {
		t.Fatalf("normalized title suggestions=%+v", review.Suggestions)
	}
}

func TestParseWritingReviewAcceptsBodyPatchesAlias(t *testing.T) {
	raw := `{
  "summary": "结构清楚，正文有一处可以压缩。",
  "titleScore": 80,
  "titleAssessment": "标题清楚且与正文一致。",
  "titleSuggestions": [],
  "bodyPatches": [{
    "category": "clarity",
    "before": "原始句子。",
    "after": "精简句子。",
    "reason": "删除冗余表达。"
  }],
  "layoutAssessment": [
    {"id":"hierarchy","label":"层级","score":80,"summary":"层级清楚。"},
    {"id":"readability","label":"可读性","score":80,"summary":"阅读顺畅。"},
    {"id":"emphasis","label":"重点","score":80,"summary":"重点明确。"},
    {"id":"rhythm","label":"节奏","score":80,"summary":"节奏自然。"},
    {"id":"modules","label":"模块","score":80,"summary":"模块合理。"},
    {"id":"mobile","label":"移动端","score":80,"summary":"移动端友好。"}
  ],
  "layoutSuggestions": []
}`
	review, err := validateFullWritingReview([]byte(raw), "原标题", "原始句子。")
	if err != nil {
		t.Fatalf("parse bodyPatches alias: %v", err)
	}
	if len(review.Suggestions) != 1 || review.Suggestions[0].After != "精简句子。" {
		t.Fatalf("normalized body patches=%+v", review.Suggestions)
	}
}

func TestParseAndValidateWritingReviewRejectsUnsafePatches(t *testing.T) {
	tests := []struct {
		name    string
		raw     string
		content string
	}{
		{
			// 分数低却不给备选不再判错——那条规则等于告诉模型"打 60 分零备选最安全"。
			// 但备选数量的上限仍然要守住。
			name: "too many title alternatives",
			raw: strings.Replace(
				validAgentReviewJSON,
				`"titleSuggestions": [
    {"after": "24 小时部署 Qwen：从本地到公网的完整记录", "reason": "补足时间、对象和结果。"},
    {"after": "一张 4090 跑 Qwen：下载、体验与公网部署", "reason": "直接点出读者最关心的硬件与路径。"}
  ]`,
				`"titleSuggestions": [
    {"after": "备选一", "reason": "理由一。"},
    {"after": "备选二", "reason": "理由二。"},
    {"after": "备选三", "reason": "理由三。"},
    {"after": "备选四", "reason": "理由四。"}
  ]`,
				1,
			),
			content: "这是原始句子。",
		},
		{
			name:    "non-unique body anchor",
			raw:     validAgentReviewJSON,
			content: "这是原始句子。这是原始句子。",
		},
		{
			name: "overlapping body anchor",
			raw: strings.Replace(
				validAgentReviewJSON,
				`"before": "这是原始句子。"`,
				`"before": "aa"`,
				1,
			),
			content: "aaa",
		},
		{
			name: "overlapping body patches",
			raw: `{
  "summary":"建议做两处修改。",
  "titleScore":55,
  "titleAssessment":"标题需要更具体。",
  "titleSuggestions":[
    {"after":"标题建议一","reason":"更具体。"},
    {"after":"标题建议二","reason":"更明确。"}
  ],
  "bodySuggestions":[
    {"category":"clarity","before":"这是原始句子。","after":"这是新句子。","reason":"更清楚。"},
    {"category":"style","before":"原始句子","after":"原句","reason":"更简洁。"}
  ],
  "layoutAssessment":[
    {"id":"hierarchy","label":"层级","score":80,"summary":"层级清楚。"},
    {"id":"readability","label":"可读性","score":80,"summary":"阅读顺畅。"},
    {"id":"emphasis","label":"重点","score":80,"summary":"重点明确。"},
    {"id":"rhythm","label":"节奏","score":80,"summary":"节奏自然。"},
    {"id":"modules","label":"模块","score":80,"summary":"模块合理。"},
    {"id":"mobile","label":"移动端","score":80,"summary":"移动端友好。"}
  ],
  "layoutSuggestions":[]
}`,
			content: "这是原始句子。",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := validateFullWritingReview([]byte(test.raw), "原标题", test.content)
			if !errors.Is(err, errAgentLLMInvalidResponse) {
				t.Fatalf("error = %v, want invalid response", err)
			}
		})
	}
}

func TestParseAndValidateWritingReviewRejectsOversizedPatches(t *testing.T) {
	tests := []struct {
		name    string
		raw     string
		content string
	}{
		{
			name: "title exceeds document title limit",
			raw: strings.Replace(
				validAgentReviewJSON,
				`"after": "24 小时部署 Qwen：从本地到公网的完整记录"`,
				`"after": "`+strings.Repeat("标题", maxTitleRunes)+`"`,
				1,
			),
			content: "这是原始句子。",
		},
		{
			name: "body anchor exceeds patch limit",
			raw: strings.Replace(
				validAgentReviewJSON,
				`"before": "这是原始句子。"`,
				`"before": "`+strings.Repeat("a", maxAgentPatchTextBytes+1)+`"`,
				1,
			),
			content: "这是原始句子。",
		},
		{
			name: "body replacements cannot exceed document limit",
			raw: strings.Replace(
				strings.Replace(validAgentReviewJSON, `"before": "这是原始句子。"`, `"before": "UNIQUE_ANCHOR"`, 1),
				`"after": "这是更清楚的句子。"`,
				`"after": "`+strings.Repeat("b", 32)+`"`,
				1,
			),
			content: strings.Repeat("a", maxContentBytes-16) + "UNIQUE_ANCHOR",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := validateFullWritingReview([]byte(test.raw), "原标题", test.content)
			if !errors.Is(err, errAgentLLMInvalidResponse) {
				t.Fatalf("error = %v, want invalid response", err)
			}
		})
	}
}

func TestBuiltInAgentLLMRequiresUsage(t *testing.T) {
	tests := []struct {
		name     string
		provider string
		result   agentLLMResult
		wantErr  error
	}{
		{
			name:     "built-in missing usage",
			provider: "builtin",
			result:   agentLLMResult{},
			wantErr:  errAgentLLMUsageMissing,
		},
		{
			name:     "built-in negative input",
			provider: "builtin",
			result:   agentLLMResult{InputTokens: -1, OutputTokens: 2, TotalTokens: 1},
			wantErr:  errAgentLLMUsageInvalid,
		},
		{
			name:     "built-in inconsistent total",
			provider: "builtin",
			result:   agentLLMResult{InputTokens: 2, OutputTokens: 3, TotalTokens: 4},
			wantErr:  errAgentLLMUsageInvalid,
		},
		{
			name:     "byok may omit usage",
			provider: "byok",
			result:   agentLLMResult{},
		},
		{
			name:     "valid usage",
			provider: "builtin",
			result:   agentLLMResult{InputTokens: 2, OutputTokens: 3, TotalTokens: 5},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			err := requireAgentLLMUsage(agentLLMProvider{Mode: test.provider}, test.result)
			if test.wantErr == nil {
				if err != nil {
					t.Fatalf("usage validation error = %v", err)
				}
				return
			}
			if !errors.Is(err, test.wantErr) {
				t.Fatalf("usage validation error = %v, want %v", err, test.wantErr)
			}
		})
	}
}
