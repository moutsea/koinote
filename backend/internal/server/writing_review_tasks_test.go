package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestBuildWritingReviewTaskPlanSplitsOnlyLongBodies(t *testing.T) {
	shortPlan, err := buildWritingReviewTaskPlan("标题", "第一段。\n\n第二段。")
	if err != nil {
		t.Fatal(err)
	}
	if len(shortPlan.Tasks) != 3 || countWritingReviewTasks(shortPlan, agentReviewTaskBody) != 1 {
		t.Fatalf("short task plan=%+v", shortPlan.Tasks)
	}

	paragraph := strings.Repeat("这是一段需要审阅但不能被重复发送的正文。", 900)
	longContent := strings.Join([]string{paragraph, paragraph + "甲", paragraph + "乙", paragraph + "丙"}, "\n\n")
	longPlan, err := buildWritingReviewTaskPlan("长文标题", longContent)
	if err != nil {
		t.Fatal(err)
	}
	if bodyTasks := countWritingReviewTasks(longPlan, agentReviewTaskBody); bodyTasks <= 1 || bodyTasks > agentReviewMaxBodyTasks {
		t.Fatalf("long body task count=%d", bodyTasks)
	}
	chunks := splitWritingReviewBodyBlocks(parseMarkdownReviewBlocks(longContent))
	joined := strings.Builder{}
	for _, chunk := range chunks {
		for _, block := range chunk {
			joined.WriteString(block.Source)
		}
	}
	if joined.String() != strings.ReplaceAll(longContent, "\n\n", "") {
		t.Fatalf("body chunks did not preserve every Markdown block exactly")
	}
}

func TestWritingReviewLayoutBlocksBoundExtremeDocuments(t *testing.T) {
	blocks := make([]markdownReviewBlock, 2_000)
	for index := range blocks {
		blocks[index] = markdownReviewBlock{
			ID: "block", Kind: "paragraph", Source: "short", Editable: true,
		}
	}
	result := writingReviewLayoutBlocks(blocks)
	if len(result) > agentReviewLayoutBlockLimit {
		t.Fatalf("layout prompt blocks=%d, limit=%d", len(result), agentReviewLayoutBlockLimit)
	}
	if len(result) < agentReviewLayoutBlockLimit-5 {
		t.Fatalf("layout sampling unexpectedly sparse: %d", len(result))
	}
}

func TestWritingReviewLayoutRejectsBlocksWithoutPromptSource(t *testing.T) {
	paragraphs := make([]string, 220)
	for index := range paragraphs {
		paragraphs[index] = strings.Repeat("正文内容", 120) + string(rune('甲'+index%20))
	}
	content := strings.Join(paragraphs, "\n\n")
	plan, err := buildWritingReviewTaskPlan("标题", content)
	if err != nil {
		t.Fatal(err)
	}
	var layoutTask writingReviewTaskSpec
	for _, task := range plan.Tasks {
		if task.Stage == agentReviewTaskLayout {
			layoutTask = task
			break
		}
	}
	blocks := parseMarkdownReviewBlocks(content)
	var unseen markdownReviewBlock
	for _, block := range blocks {
		if _, allowed := layoutTask.AllowedLayoutBlockIDs[block.ID]; !allowed && block.Editable {
			unseen = block
			break
		}
	}
	if unseen.ID == "" {
		t.Fatal("test document did not produce an editable block outside the layout prompt source scope")
	}
	layoutJSON, err := json.Marshal(map[string]any{
		"layoutAssessment": writingReviewTaskDimensionsForTest(),
		"layoutSuggestions": []map[string]any{{
			"category": "hierarchy", "operation": "change_block_type", "blockId": unseen.ID,
			"afterType": "h3", "segments": []any{}, "reason": "This reason is fabricated without source text.",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	generated, validated, err := parseWritingReviewTaskResult(layoutTask, layoutJSON, "标题", content)
	if err != nil {
		t.Fatal(err)
	}
	if len(validated.Suggestions) != 0 {
		t.Fatalf("single layout task accepted unseen block %s: %+v", unseen.ID, validated.Suggestions)
	}

	mergedResults := []writingReviewTaskResult{
		{
			Task: writingReviewTaskSpec{ID: "title", Stage: agentReviewTaskTitle},
			Generated: generatedWritingReview{
				Summary: "Summary.", TitleScore: 80, TitleAssessment: "The title is supported.",
			},
		},
		{Task: writingReviewTaskSpec{ID: "body-1", Stage: agentReviewTaskBody}, Generated: generatedWritingReview{}},
		{Task: layoutTask, Generated: generated},
	}
	_, merged, err := mergeWritingReviewTaskResults(mergedResults, "标题", content)
	if err != nil {
		t.Fatal(err)
	}
	if len(merged.Suggestions) != 0 {
		t.Fatalf("merged review accepted unseen block %s: %+v", unseen.ID, merged.Suggestions)
	}
}

func TestWritingReviewBodySuggestionLimitsDistributeRemainder(t *testing.T) {
	for chunkCount := 1; chunkCount <= agentReviewMaxBodyTasks; chunkCount++ {
		limits := writingReviewBodySuggestionLimits(chunkCount)
		total := 0
		minimum, maximum := agentReviewMaxBodySuggestions, 0
		for _, limit := range limits {
			total += limit
			minimum = min(minimum, limit)
			maximum = max(maximum, limit)
		}
		if total != agentReviewMaxBodySuggestions || maximum-minimum > 1 || minimum < 1 {
			t.Fatalf("chunkCount=%d limits=%v total=%d", chunkCount, limits, total)
		}
	}
}

func TestMergeWritingReviewTaskResultsDropsSuggestionsBeyondDocumentLimit(t *testing.T) {
	const growthBytes = 15
	anchorOne := "UNIQUE_ANCHOR_ONE"
	anchorTwo := "UNIQUE_ANCHOR_TWO"
	paddingBytes := maxContentBytes - 20 - len(anchorOne) - len(anchorTwo) - 4
	content := anchorOne + "\n\n" + strings.Repeat("x", paddingBytes) + "\n\n" + anchorTwo
	if len(content) != maxContentBytes-20 {
		t.Fatalf("content bytes=%d, want %d", len(content), maxContentBytes-20)
	}

	first := generatedBodySuggestion{
		Category: "clarity", Before: anchorOne, After: anchorOne + strings.Repeat("a", growthBytes), Reason: "Clarify the opening.",
	}
	second := generatedBodySuggestion{
		Category: "style", Before: anchorTwo, After: anchorTwo + strings.Repeat("b", growthBytes), Reason: "Improve the ending.",
	}
	for _, suggestion := range []generatedBodySuggestion{first, second} {
		generated := generatedWritingReview{
			Summary: "Summary.", TitleScore: 100, TitleAssessment: "The title is supported.",
			LayoutAssessment: placeholderWritingReviewDimensions(), BodySuggestions: []generatedBodySuggestion{suggestion},
		}
		if _, err := validateGeneratedWritingReview(generated, "Title", content, nil, false); err != nil {
			t.Fatalf("individual suggestion should fit: %v", err)
		}
	}

	results := []writingReviewTaskResult{
		{
			Task: writingReviewTaskSpec{ID: "title", Stage: agentReviewTaskTitle},
			Generated: generatedWritingReview{
				Summary: "Summary.", TitleScore: 100, TitleAssessment: "The title is supported.",
			},
		},
		{Task: writingReviewTaskSpec{ID: "body-1", Stage: agentReviewTaskBody}, Generated: generatedWritingReview{BodySuggestions: []generatedBodySuggestion{first}}},
		{Task: writingReviewTaskSpec{ID: "body-2", Stage: agentReviewTaskBody}, Generated: generatedWritingReview{BodySuggestions: []generatedBodySuggestion{second}}},
		{
			Task:      writingReviewTaskSpec{ID: "layout", Stage: agentReviewTaskLayout},
			Generated: generatedWritingReview{LayoutAssessment: placeholderWritingReviewDimensions()},
		},
	}
	_, merged, err := mergeWritingReviewTaskResults(results, "Title", content)
	if err != nil {
		t.Fatal(err)
	}
	if len(merged.Suggestions) != 1 || merged.Suggestions[0].Before != anchorOne {
		t.Fatalf("merged suggestions=%+v, want only first fitting suggestion", merged.Suggestions)
	}
}

func TestExecuteWritingReviewTaskPlanRunsConcurrentlyAndRetriesOnlyInvalidTask(t *testing.T) {
	plan, err := buildWritingReviewTaskPlan("A clear title", "A concise paragraph.")
	if err != nil {
		t.Fatal(err)
	}
	var inFlight atomic.Int32
	var maximumInFlight atomic.Int32
	var titleRequests atomic.Int32
	var bodyRequests atomic.Int32
	var layoutRequests atomic.Int32
	ready := make(chan struct{})
	var readyOnce sync.Once
	providerServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		current := inFlight.Add(1)
		defer inFlight.Add(-1)
		for {
			maximum := maximumInFlight.Load()
			if current <= maximum || maximumInFlight.CompareAndSwap(maximum, current) {
				break
			}
		}
		if current >= 3 {
			readyOnce.Do(func() { close(ready) })
		}
		select {
		case <-ready:
		case <-time.After(2 * time.Second):
			t.Error("three review tasks did not overlap")
		}

		var payload struct {
			Messages []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode task payload: %v", err)
		}
		system := ""
		for _, message := range payload.Messages {
			if message.Role == "system" {
				system = message.Content
			}
		}
		responseText := ""
		switch {
		case strings.Contains(system, `"titleScore"`):
			titleRequests.Add(1)
			responseText = `{"summary":"The article is already focused.","titleScore":80,"titleAssessment":"The title is clear and supported.","titleSuggestions":[]}`
		case strings.Contains(system, `"bodySuggestions"`):
			if bodyRequests.Add(1) == 1 {
				responseText = `{}`
			} else {
				responseText = `{"bodySuggestions":[]}`
			}
		case strings.Contains(system, `"layoutAssessment"`):
			layoutRequests.Add(1)
			encoded, _ := json.Marshal(map[string]any{
				"layoutAssessment": writingReviewTaskDimensionsForTest(), "layoutSuggestions": []any{},
			})
			responseText = string(encoded)
		default:
			t.Errorf("unknown task schema: %s", system)
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"message": map[string]string{"content": responseText}, "finish_reason": "stop"}},
			"usage":   map[string]int{"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120},
		})
	}))
	defer providerServer.Close()

	result, review, err := executeWritingReviewTaskPlan(
		context.Background(), providerServer.Client(), agentLLMProvider{
			Mode: "byok", Protocol: "openai", BaseURL: providerServer.URL, APIKey: "test", Model: "test",
		}, plan, "A clear title", "A concise paragraph.", nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if maximumInFlight.Load() != 3 {
		t.Fatalf("maximum concurrent tasks=%d, want 3", maximumInFlight.Load())
	}
	if titleRequests.Load() != 1 || bodyRequests.Load() != 2 || layoutRequests.Load() != 1 {
		t.Fatalf("request counts title=%d body=%d layout=%d", titleRequests.Load(), bodyRequests.Load(), layoutRequests.Load())
	}
	if result.TotalTokens != 480 || review.TitleScore != 80 || len(review.LayoutAssessment) != len(writingReviewDimensionIDs) {
		t.Fatalf("merged review result=%+v review=%+v", result, review)
	}
}

func countWritingReviewTasks(plan writingReviewTaskPlan, stage agentReviewTaskStage) int {
	count := 0
	for _, task := range plan.Tasks {
		if task.Stage == stage {
			count++
		}
	}
	return count
}

func writingReviewTaskDimensionsForTest() []map[string]any {
	values := make([]map[string]any, 0, len(writingReviewDimensionIDs))
	for _, id := range writingReviewDimensionIDs {
		values = append(values, map[string]any{"id": id, "label": id, "score": 80, "summary": "Sound."})
	}
	return values
}
