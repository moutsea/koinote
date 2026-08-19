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

func TestWritingReviewPromptIncludesEditorialRubric(t *testing.T) {
	prompt, err := buildWritingReviewPrompt(
		"标题",
		"这是一篇有事实依据的文章。",
	)
	if err != nil {
		t.Fatal(err)
	}
	checks := []string{
		"Diagnose the article's actual value, evidence, audience, and central promise before polishing wording",
		"Make the opening work independently",
		"Optimize for mobile long-form reading",
		"smooth repetitive parallelism",
		"repeated \"not X but Y\" turns",
		"promise-to-evidence fit",
		"cognitive contrast",
		"curiosity gap",
		"Never invent authority, figures, urgency, outcomes, or pain points",
		"meaningfully different supported angles",
	}
	for _, check := range checks {
		if !strings.Contains(prompt.System, check) {
			t.Errorf("writing review system prompt is missing rubric rule %q", check)
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

	prompt, err := buildWritingReviewPrompt("原标题", "这是原始句子。")
	if err != nil {
		t.Fatal(err)
	}
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
	if _, err := parseAndValidateWritingReview(result.JSON, "原标题", "这是原始句子。"); err != nil {
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
		if !strings.Contains(system, `"bodySuggestions"`) || !strings.Contains(system, `"additionalProperties":false`) {
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

	prompt, _ := buildWritingReviewPrompt("原标题", "这是原始句子。")
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
	if _, err := parseAndValidateWritingReview(result.JSON, "原标题", "这是原始句子。"); err != nil {
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

	prompt, _ := buildWritingReviewPrompt("原标题", "这是原始句子。")
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
	if _, err := parseAndValidateWritingReview(result.JSON, "原标题", "这是原始句子。"); err != nil {
		t.Fatalf("validate Anthropic review: %v", err)
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
		if payload["max_tokens"] != float64(agentLLMAnthropicMaxOutputTokens) {
			t.Errorf("Anthropic max_tokens = %#v", payload["max_tokens"])
		}
		system, _ := payload["system"].(string)
		if !strings.Contains(system, `"bodySuggestions"`) || !strings.Contains(system, `"additionalProperties":false`) {
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

	prompt, _ := buildWritingReviewPrompt("原标题", "这是原始句子。")
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
	if _, err := parseAndValidateWritingReview(result.JSON, "原标题", "这是原始句子。"); err != nil {
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

	prompt, _ := buildWritingReviewPrompt("原标题", "这是原始句子。")
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

func TestGenerateValidatedWritingReviewRetriesInvalidJSON(t *testing.T) {
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
			text = validAgentReviewJSON
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

	prompt, _ := buildWritingReviewPrompt("原标题", "这是原始句子。")
	provider := agentLLMProvider{
		Mode: "builtin", Protocol: "anthropic", BaseURL: server.URL,
		APIKey: "sk-ant-test", Model: "claude-sonnet-5",
	}
	result, review, err := generateValidatedWritingReview(
		context.Background(), server.Client(), provider, prompt, "原标题", "这是原始句子。",
	)
	if err != nil {
		t.Fatalf("generate validated review: %v", err)
	}
	if requests != 2 {
		t.Fatalf("provider requests=%d, want 2", requests)
	}
	if result.InputTokens != 210 || result.OutputTokens != 110 || result.TotalTokens != 320 {
		t.Fatalf("combined retry usage=%+v", result)
	}
	if review.TitleScore != 55 || len(review.Suggestions) != 3 {
		t.Fatalf("validated retry review=%+v", review)
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
	review, err := parseAndValidateWritingReview([]byte(raw), "原标题", "正文")
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
	review, err := parseAndValidateWritingReview([]byte(raw), "原标题", "原始句子。")
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
			name: "low title score without alternatives",
			raw: strings.Replace(
				validAgentReviewJSON,
				`"titleSuggestions": [
    {"after": "24 小时部署 Qwen：从本地到公网的完整记录", "reason": "补足时间、对象和结果。"},
    {"after": "一张 4090 跑 Qwen：下载、体验与公网部署", "reason": "直接点出读者最关心的硬件与路径。"}
  ]`,
				`"titleSuggestions": []`,
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
			_, err := parseAndValidateWritingReview([]byte(test.raw), "原标题", test.content)
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
			_, err := parseAndValidateWritingReview([]byte(test.raw), "原标题", test.content)
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
