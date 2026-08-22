package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const (
	agentLLMMaxOutputTokens          = 8_192
	agentLLMAnthropicMaxOutputTokens = 8_192
	agentLLMMaxResponseBytes         = 2 << 20
	maxAgentBodySuggestions          = 40
)

var (
	errAgentLLMInvalidResponse = errors.New("agent LLM returned an invalid response")
	errAgentLLMEmptyResponse   = fmt.Errorf("%w: model response has no text", errAgentLLMInvalidResponse)
	errAgentLLMUsageMissing    = errors.New("agent LLM response is missing token usage")
	errAgentLLMUsageInvalid    = errors.New("agent LLM response has invalid token usage")
)

type agentLLMProvider struct {
	Mode         string
	Protocol     string
	BaseURL      string
	APIKey       string
	Model        string
	StrictOutput bool
	SafeEndpoint bool
}

type agentLLMPrompt struct {
	System          string
	User            string
	Schema          map[string]any
	MaxOutputTokens int
	// 0 表示沿用默认。打分要稳定所以低温，提改写建议是发散任务，低温会让模型
	// 反复落到同一批最安全的改法上；锚点出错由逐条丢弃的校验兜住。
	Temperature float64
}

const agentLLMDefaultTemperature = 0.2

func agentLLMTemperature(prompt agentLLMPrompt) float64 {
	if prompt.Temperature > 0 {
		return prompt.Temperature
	}
	return agentLLMDefaultTemperature
}

type agentLLMResult struct {
	JSON         []byte
	InputTokens  int
	OutputTokens int
	TotalTokens  int
}

type agentLLMHTTPError struct {
	Status  int
	Message string
}

func (e *agentLLMHTTPError) Error() string {
	return fmt.Sprintf("agent LLM HTTP %d: %s", e.Status, e.Message)
}

func callAgentLLM(
	ctx context.Context,
	httpClient *http.Client,
	provider agentLLMProvider,
	prompt agentLLMPrompt,
) (agentLLMResult, error) {
	if httpClient == nil {
		if provider.SafeEndpoint {
			httpClient = newSafeLLMHTTPClient()
		} else {
			httpClient = newTrustedLLMHTTPClient()
		}
	}
	for attempt := 0; attempt < 2; attempt++ {
		result, err := callAgentLLMOnce(ctx, httpClient, provider, prompt)
		if err == nil || !isRetryableAgentLLMError(err) || attempt == 1 {
			return result, err
		}
		timer := time.NewTimer(750 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return agentLLMResult{}, ctx.Err()
		case <-timer.C:
		}
	}
	panic("unreachable")
}

func callAgentLLMOnce(
	ctx context.Context,
	httpClient *http.Client,
	provider agentLLMProvider,
	prompt agentLLMPrompt,
) (agentLLMResult, error) {
	switch provider.Protocol {
	case "openai":
		return callOpenAIAgentLLM(ctx, httpClient, provider, prompt)
	case "anthropic":
		return callAnthropicAgentLLM(ctx, httpClient, provider, prompt)
	default:
		return agentLLMResult{}, fmt.Errorf("unsupported agent LLM protocol %q", provider.Protocol)
	}
}

func isRetryableAgentLLMError(err error) bool {
	if errors.Is(err, errAgentLLMEmptyResponse) {
		return true
	}
	var providerError *agentLLMHTTPError
	if !errors.As(err, &providerError) {
		return false
	}
	return providerError.Status == http.StatusRequestTimeout ||
		providerError.Status == http.StatusTooManyRequests ||
		providerError.Status >= http.StatusInternalServerError
}

func newTrustedLLMHTTPClient() *http.Client {
	return &http.Client{
		Timeout: llmRequestTimeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return errors.New("LLM endpoint redirects are disabled")
		},
	}
}

func callOpenAIAgentLLM(
	ctx context.Context,
	httpClient *http.Client,
	provider agentLLMProvider,
	prompt agentLLMPrompt,
) (agentLLMResult, error) {
	endpoint, err := agentLLMEndpoint(provider.BaseURL, provider.Protocol)
	if err != nil {
		return agentLLMResult{}, err
	}
	systemPrompt := prompt.System
	if !provider.StrictOutput && len(prompt.Schema) > 0 {
		schemaJSON, err := json.Marshal(prompt.Schema)
		if err != nil {
			return agentLLMResult{}, fmt.Errorf("encode OpenAI-compatible output schema: %w", err)
		}
		systemPrompt += "\n\nThe response must conform to this exact JSON Schema:\n" + string(schemaJSON)
	}
	maxOutputTokens := agentLLMPromptOutputLimit(prompt, agentLLMMaxOutputTokens)
	payload := map[string]any{
		"model": provider.Model,
		"messages": []map[string]string{
			{"role": "system", "content": systemPrompt},
			{"role": "user", "content": prompt.User},
		},
		"temperature": agentLLMTemperature(prompt),
	}
	if provider.StrictOutput {
		payload["max_completion_tokens"] = maxOutputTokens
		payload["response_format"] = map[string]any{
			"type": "json_schema",
			"json_schema": map[string]any{
				"name":   "koinote_writing_review",
				"strict": true,
				"schema": prompt.Schema,
			},
		}
	} else {
		payload["max_tokens"] = maxOutputTokens
		payload["response_format"] = map[string]string{"type": "json_object"}
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return agentLLMResult{}, fmt.Errorf("encode OpenAI request: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return agentLLMResult{}, fmt.Errorf("create OpenAI request: %w", err)
	}
	request.Header.Set("Authorization", "Bearer "+provider.APIKey)
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "application/json")

	responseBody, err := doBoundedLLMRequest(httpClient, request)
	if err != nil {
		return agentLLMResult{}, err
	}
	var response struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
				Refusal string `json:"refusal"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
			TotalTokens      int `json:"total_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(responseBody, &response); err != nil {
		return agentLLMResult{}, fmt.Errorf("%w: decode OpenAI response: %v", errAgentLLMInvalidResponse, err)
	}
	if len(response.Choices) != 1 {
		return agentLLMResult{}, fmt.Errorf("%w: OpenAI response has no single choice", errAgentLLMInvalidResponse)
	}
	if strings.TrimSpace(response.Choices[0].Message.Content) == "" {
		if refusal := strings.TrimSpace(response.Choices[0].Message.Refusal); refusal != "" {
			return agentLLMResult{}, fmt.Errorf("%w: model refusal", errAgentLLMInvalidResponse)
		}
		return agentLLMResult{}, fmt.Errorf("%w: OpenAI response has no content", errAgentLLMInvalidResponse)
	}
	if response.Choices[0].FinishReason == "length" {
		return agentLLMResult{}, fmt.Errorf("%w: OpenAI response was truncated", errAgentLLMInvalidResponse)
	}
	if response.Usage.TotalTokens == 0 {
		response.Usage.TotalTokens = response.Usage.PromptTokens + response.Usage.CompletionTokens
	}
	return agentLLMResult{
		JSON:         []byte(stripJSONCodeFence(response.Choices[0].Message.Content)),
		InputTokens:  response.Usage.PromptTokens,
		OutputTokens: response.Usage.CompletionTokens,
		TotalTokens:  response.Usage.TotalTokens,
	}, nil
}

func callAnthropicAgentLLM(
	ctx context.Context,
	httpClient *http.Client,
	provider agentLLMProvider,
	prompt agentLLMPrompt,
) (agentLLMResult, error) {
	endpoint, err := agentLLMEndpoint(provider.BaseURL, provider.Protocol)
	if err != nil {
		return agentLLMResult{}, err
	}
	systemPrompt := prompt.System
	if len(prompt.Schema) > 0 {
		schemaJSON, err := json.Marshal(prompt.Schema)
		if err != nil {
			return agentLLMResult{}, fmt.Errorf("encode Anthropic output schema: %w", err)
		}
		systemPrompt += "\n\nThe response must conform to this exact JSON Schema:\n" + string(schemaJSON)
	}
	maxOutputTokens := agentLLMPromptOutputLimit(prompt, agentLLMAnthropicMaxOutputTokens)
	payload := map[string]any{
		"model":       provider.Model,
		"max_tokens":  maxOutputTokens,
		"stream":      true,
		"temperature": agentLLMTemperature(prompt),
		"system":      systemPrompt,
		"messages": []map[string]string{
			{"role": "user", "content": prompt.User},
		},
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return agentLLMResult{}, fmt.Errorf("encode Anthropic request: %w", err)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return agentLLMResult{}, fmt.Errorf("create Anthropic request: %w", err)
	}
	request.Header.Set("x-api-key", provider.APIKey)
	request.Header.Set("Authorization", "Bearer "+provider.APIKey)
	request.Header.Set("anthropic-version", "2023-06-01")
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept", "text/event-stream, application/json")

	responseBody, inputTokens, outputTokens, stopReason, streamed, err := doAnthropicLLMRequest(httpClient, request)
	if err != nil {
		return agentLLMResult{}, err
	}
	if streamed {
		if stopReason == "max_tokens" {
			return agentLLMResult{}, fmt.Errorf("%w: Anthropic response was truncated", errAgentLLMInvalidResponse)
		}
		if strings.TrimSpace(string(responseBody)) == "" {
			return agentLLMResult{}, errAgentLLMEmptyResponse
		}
		return agentLLMResult{
			JSON:         []byte(stripJSONCodeFence(string(responseBody))),
			InputTokens:  inputTokens,
			OutputTokens: outputTokens,
			TotalTokens:  inputTokens + outputTokens,
		}, nil
	}
	var response struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		StopReason string `json:"stop_reason"`
		Usage      struct {
			InputTokens  int `json:"input_tokens"`
			OutputTokens int `json:"output_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(responseBody, &response); err != nil {
		return agentLLMResult{}, fmt.Errorf("%w: decode Anthropic response: %v", errAgentLLMInvalidResponse, err)
	}
	if stopReason == "" {
		stopReason = response.StopReason
	}
	if stopReason == "max_tokens" {
		return agentLLMResult{}, fmt.Errorf("%w: Anthropic response was truncated", errAgentLLMInvalidResponse)
	}
	var content strings.Builder
	for _, block := range response.Content {
		if block.Type == "text" {
			content.WriteString(block.Text)
		}
	}
	if strings.TrimSpace(content.String()) == "" {
		return agentLLMResult{}, errAgentLLMEmptyResponse
	}
	return agentLLMResult{
		JSON:         []byte(stripJSONCodeFence(content.String())),
		InputTokens:  maxInt(inputTokens, response.Usage.InputTokens),
		OutputTokens: maxInt(outputTokens, response.Usage.OutputTokens),
		TotalTokens:  maxInt(inputTokens, response.Usage.InputTokens) + maxInt(outputTokens, response.Usage.OutputTokens),
	}, nil
}

func agentLLMPromptOutputLimit(prompt agentLLMPrompt, fallback int) int {
	if prompt.MaxOutputTokens > 0 && prompt.MaxOutputTokens < fallback {
		return prompt.MaxOutputTokens
	}
	return fallback
}

type anthropicStreamResult struct {
	Text         string
	InputTokens  int
	OutputTokens int
	StopReason   string
}

// doAnthropicLLMRequest consumes Anthropic's SSE response while it is being
// generated. Some compatible gateways otherwise wait until the complete model
// response is ready before sending anything, which can hit the HTTP timeout.
// A JSON response is still accepted for gateways that ignore stream=true.
func doAnthropicLLMRequest(client *http.Client, request *http.Request) ([]byte, int, int, string, bool, error) {
	response, err := client.Do(request)
	if err != nil {
		return nil, 0, 0, "", false, fmt.Errorf("call agent LLM: %w", err)
	}
	defer response.Body.Close()

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		body, err := io.ReadAll(io.LimitReader(response.Body, agentLLMMaxResponseBytes+1))
		if err != nil {
			return nil, 0, 0, "", false, fmt.Errorf("read agent LLM error response: %w", err)
		}
		return nil, 0, 0, "", false, agentLLMHTTPErrorFromBody(response.StatusCode, body)
	}
	if strings.Contains(strings.ToLower(response.Header.Get("Content-Type")), "text/event-stream") {
		stream, err := parseAnthropicEventStream(response.Body)
		if err != nil {
			return nil, 0, 0, "", true, err
		}
		return []byte(stream.Text), stream.InputTokens, stream.OutputTokens, stream.StopReason, true, nil
	}

	body, err := io.ReadAll(io.LimitReader(response.Body, agentLLMMaxResponseBytes+1))
	if err == nil {
		if len(body) > agentLLMMaxResponseBytes {
			return nil, 0, 0, "", false, fmt.Errorf("%w: response exceeds %d bytes", errAgentLLMInvalidResponse, agentLLMMaxResponseBytes)
		}
		return body, 0, 0, "", false, nil
	}
	return nil, 0, 0, "", false, fmt.Errorf("read agent LLM response: %w", err)
}

func parseAnthropicEventStream(reader io.Reader) (anthropicStreamResult, error) {
	scanner := bufio.NewScanner(reader)
	scanner.Buffer(make([]byte, 4<<10), agentLLMMaxResponseBytes)
	result := anthropicStreamResult{}
	eventData := strings.Builder{}

	flush := func() error {
		if eventData.Len() == 0 {
			return nil
		}
		data := eventData.String()
		eventData.Reset()
		if data == "[DONE]" {
			return nil
		}
		var event struct {
			Type  string `json:"type"`
			Error *struct {
				Type    string `json:"type"`
				Message string `json:"message"`
			} `json:"error"`
			Delta struct {
				Type       string `json:"type"`
				Text       string `json:"text"`
				StopReason string `json:"stop_reason"`
			} `json:"delta"`
			Message struct {
				Usage struct {
					InputTokens  int `json:"input_tokens"`
					OutputTokens int `json:"output_tokens"`
				} `json:"usage"`
			} `json:"message"`
			Usage struct {
				InputTokens  int `json:"input_tokens"`
				OutputTokens int `json:"output_tokens"`
			} `json:"usage"`
		}
		if err := json.Unmarshal([]byte(data), &event); err != nil {
			return fmt.Errorf("%w: decode Anthropic stream event: %v", errAgentLLMInvalidResponse, err)
		}
		if event.Error != nil {
			return anthropicStreamHTTPError(event.Error.Type, event.Error.Message)
		}
		if event.Type == "message_start" {
			result.InputTokens = event.Message.Usage.InputTokens
			result.OutputTokens = event.Message.Usage.OutputTokens
		}
		if event.Type == "content_block_delta" && event.Delta.Type == "text_delta" {
			result.Text += event.Delta.Text
			if len(result.Text) > agentLLMMaxResponseBytes {
				return fmt.Errorf("%w: response exceeds %d bytes", errAgentLLMInvalidResponse, agentLLMMaxResponseBytes)
			}
		}
		if event.Type == "message_delta" {
			result.StopReason = event.Delta.StopReason
			if event.Usage.InputTokens > 0 {
				result.InputTokens = event.Usage.InputTokens
			}
			if event.Usage.OutputTokens > 0 {
				result.OutputTokens = event.Usage.OutputTokens
			}
		}
		return nil
	}

	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		switch {
		case line == "":
			if err := flush(); err != nil {
				return anthropicStreamResult{}, err
			}
		case strings.HasPrefix(line, "data:"):
			if eventData.Len() > 0 {
				eventData.WriteByte('\n')
			}
			eventData.WriteString(strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	if err := scanner.Err(); err != nil {
		return anthropicStreamResult{}, fmt.Errorf("read Anthropic stream: %w", err)
	}
	if err := flush(); err != nil {
		return anthropicStreamResult{}, err
	}
	if strings.TrimSpace(result.Text) == "" {
		return anthropicStreamResult{}, errAgentLLMEmptyResponse
	}
	return result, nil
}

func anthropicStreamHTTPError(errorType, message string) error {
	status := http.StatusBadGateway
	switch strings.ToLower(strings.TrimSpace(errorType)) {
	case "authentication_error":
		status = http.StatusUnauthorized
	case "permission_error":
		status = http.StatusForbidden
	case "not_found_error":
		status = http.StatusNotFound
	case "request_too_large":
		status = http.StatusRequestEntityTooLarge
	case "rate_limit_error":
		status = http.StatusTooManyRequests
	case "invalid_request_error":
		status = http.StatusBadRequest
	case "api_error", "overloaded_error":
		status = http.StatusBadGateway
	}
	message = strings.TrimSpace(message)
	if message == "" {
		message = "Anthropic stream error"
	}
	if len(message) > 500 {
		message = message[:500]
	}
	return &agentLLMHTTPError{Status: status, Message: message}
}

func maxInt(values ...int) int {
	maximum := 0
	for _, value := range values {
		if value > maximum {
			maximum = value
		}
	}
	return maximum
}

func doBoundedLLMRequest(client *http.Client, request *http.Request) ([]byte, error) {
	response, err := client.Do(request)
	if err != nil {
		return nil, fmt.Errorf("call agent LLM: %w", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, agentLLMMaxResponseBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read agent LLM response: %w", err)
	}
	if len(body) > agentLLMMaxResponseBytes {
		return nil, fmt.Errorf("%w: response exceeds %d bytes", errAgentLLMInvalidResponse, agentLLMMaxResponseBytes)
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, agentLLMHTTPErrorFromBody(response.StatusCode, body)
	}
	return body, nil
}

func agentLLMHTTPErrorFromBody(status int, body []byte) error {
	message := strings.TrimSpace(string(body))
	var envelope struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(body, &envelope) == nil && strings.TrimSpace(envelope.Error.Message) != "" {
		message = strings.TrimSpace(envelope.Error.Message)
	}
	if len(message) > 500 {
		message = message[:500]
	}
	return &agentLLMHTTPError{Status: status, Message: message}
}

func agentLLMEndpoint(baseURL, protocol string) (string, error) {
	parsed, err := url.Parse(strings.TrimRight(strings.TrimSpace(baseURL), "/"))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "", errors.New("invalid agent LLM base URL")
	}
	path := strings.TrimRight(parsed.Path, "/")
	switch protocol {
	case "openai":
		switch {
		case strings.HasSuffix(path, "/chat/completions"):
		case path == "":
			path = "/v1/chat/completions"
		default:
			path += "/chat/completions"
		}
	case "anthropic":
		switch {
		case strings.HasSuffix(path, "/messages"):
		case path == "":
			path = "/v1/messages"
		default:
			path += "/messages"
		}
	default:
		return "", fmt.Errorf("unsupported agent LLM protocol %q", protocol)
	}
	parsed.Path = path
	parsed.RawPath = ""
	return parsed.String(), nil
}
