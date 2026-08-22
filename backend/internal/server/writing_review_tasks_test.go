package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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
	// 标题、结构、全文、正文各一。全文任务是唯一同时有全局视野和改字权限的角色。
	if len(shortPlan.Tasks) != 4 ||
		countWritingReviewTasks(shortPlan, agentReviewTaskBody) != 1 ||
		countWritingReviewTasks(shortPlan, agentReviewTaskDocument) != 1 {
		t.Fatalf("short task plan=%+v", shortPlan.Tasks)
	}
	for _, task := range shortPlan.Tasks {
		wantWave := agentReviewWaveEdit
		if task.Stage == agentReviewTaskTitle || task.Stage == agentReviewTaskLayout {
			wantWave = agentReviewWaveDiagnose
		}
		if task.Wave != wantWave || task.WantsPriorFindings != (wantWave == agentReviewWaveEdit) {
			t.Fatalf("task %s wave=%d wantsPriorFindings=%v", task.ID, task.Wave, task.WantsPriorFindings)
		}
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

func TestAgentReviewTaskProgressStartsOneWaveAtATime(t *testing.T) {
	plan, err := buildWritingReviewTaskPlan("标题", "第一段。\n\n第二段。")
	if err != nil {
		t.Fatal(err)
	}
	progress := newAgentReviewTaskProgress(plan)
	wantStageOrder := []agentReviewTaskStage{
		agentReviewTaskTitle, agentReviewTaskLayout, agentReviewTaskDocument, agentReviewTaskBody,
	}
	if len(progress.Stages) != len(wantStageOrder) {
		t.Fatalf("progress stages=%+v, want order=%v", progress.Stages, wantStageOrder)
	}
	for index, wantStage := range wantStageOrder {
		if progress.Stages[index].ID != wantStage {
			t.Fatalf("progress stage %d=%s, want %s; progress=%+v", index, progress.Stages[index].ID, wantStage, progress)
		}
	}
	tasksForWave := func(wave int) []writingReviewTaskSpec {
		tasks := make([]writingReviewTaskSpec, 0, len(plan.Tasks))
		for _, task := range plan.Tasks {
			if task.Wave == wave {
				tasks = append(tasks, task)
			}
		}
		return tasks
	}
	assertStatuses := func(want map[agentReviewTaskStage]string) {
		t.Helper()
		for _, stage := range progress.Stages {
			if stage.Status != want[stage.ID] {
				t.Fatalf("stage %s status=%q, want %q; progress=%+v", stage.ID, stage.Status, want[stage.ID], progress)
			}
		}
	}

	progress.start(tasksForWave(agentReviewWaveDiagnose))
	assertStatuses(map[agentReviewTaskStage]string{
		agentReviewTaskTitle: "running", agentReviewTaskLayout: "running",
		agentReviewTaskDocument: "pending", agentReviewTaskBody: "pending",
	})
	progress.start(tasksForWave(agentReviewWaveEdit))
	assertStatuses(map[agentReviewTaskStage]string{
		agentReviewTaskTitle: "running", agentReviewTaskLayout: "running",
		agentReviewTaskDocument: "running", agentReviewTaskBody: "running",
	})
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

func TestWritingReviewSampledBlocksKeepSourcesAndSeparatorsWithinBudget(t *testing.T) {
	blocks := make([]markdownReviewBlock, 800)
	blockIndex := make(map[string]int, len(blocks))
	offset := 0
	for index := range blocks {
		source := fmt.Sprintf("paragraph-%03d-%s", index, strings.Repeat("x", 1_024))
		gap := strings.Repeat("\n", 513)
		id := fmt.Sprintf("block-%d", index+1)
		blocks[index] = markdownReviewBlock{
			ID: id, Kind: "paragraph", Source: source, Editable: true,
			Start: offset, End: offset + len(source), GapAfter: gap,
		}
		blockIndex[id] = index
		offset += len(source) + len(gap)
	}

	tests := []struct {
		name   string
		limit  int
		blocks func() []writingReviewLayoutPromptBlock
	}{
		{name: "layout", limit: agentReviewLayoutSourceBytes, blocks: func() []writingReviewLayoutPromptBlock {
			return writingReviewLayoutBlocks(blocks)
		}},
		{name: "document", limit: agentReviewDocumentSourceBytes, blocks: func() []writingReviewLayoutPromptBlock {
			return writingReviewSampledLayoutBlocks(
				blocks, agentReviewDocumentBlockLimit, agentReviewDocumentSourceBytes,
				agentReviewDocumentDistributedBlocks, agentReviewDocumentLongestBlocks,
			)
		}},
		{name: "deep", limit: agentReviewDeepLayoutSourceBytes, blocks: func() []writingReviewLayoutPromptBlock {
			return writingReviewDeepLayoutBlocks(blocks)
		}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			promptBlocks := test.blocks()
			used := 0
			for position, block := range promptBlocks {
				used += len(block.Source) + len(block.SeparatorAfter)
				if block.SeparatorAfter == "" {
					continue
				}
				index := blockIndex[block.ID]
				if block.Source == "" || block.Partial || position+1 >= len(promptBlocks) ||
					index+1 >= len(blocks) || promptBlocks[position+1].ID != blocks[index+1].ID ||
					promptBlocks[position+1].Source == "" || promptBlocks[position+1].Partial ||
					block.SeparatorAfter != blocks[index].GapAfter {
					t.Fatalf("separator escaped adjacent complete sources: %+v", block)
				}
			}
			if used > test.limit {
				t.Fatalf("prompt source bytes=%d, limit=%d", used, test.limit)
			}
		})
	}
}

func TestDeepWritingReviewUsesSafeExcerptFromOversizedBlock(t *testing.T) {
	anchor := "这是超长段落中唯一且可以安全改写的开头。"
	unseenAnchor := "这是模型没有收到的超长段落结尾。"
	content := anchor + strings.Repeat("后续内容只用于把单个 Markdown 块撑过深入审阅预算。", 3_000) + unseenAnchor
	if len(content) <= agentReviewDeepLayoutSourceBytes {
		t.Fatalf("test content=%d bytes, want more than %d", len(content), agentReviewDeepLayoutSourceBytes)
	}
	plan, err := buildDeepWritingReviewTaskPlan("标题", content, "hierarchy", writingReviewDeepContext{})
	if err != nil {
		t.Fatal(err)
	}
	task := plan.Tasks[0]
	blocks := parseMarkdownReviewBlocks(content)
	if len(blocks) != 1 {
		t.Fatalf("parsed blocks=%d, want one oversized paragraph", len(blocks))
	}
	blockID := blocks[0].ID
	if _, allowed := task.AllowedBodyBlockIDs[blockID]; !allowed {
		t.Fatalf("oversized block excerpt is not available to body suggestions: %+v", task.AllowedBodyBlockIDs)
	}
	allowedRanges := task.AllowedBodyBlockRanges[blockID]
	if len(allowedRanges) != 1 || !allowedRanges[0].contains(0, len(anchor)) ||
		allowedRanges[0].contains(strings.Index(content, unseenAnchor), len(content)) {
		t.Fatalf("unexpected oversized block source ranges: %+v", allowedRanges)
	}
	if _, allowed := task.AllowedLayoutBlockIDs[blockID]; allowed {
		t.Fatalf("partially sampled oversized block must not allow whole-block layout operations")
	}
	if !strings.Contains(task.Prompt.User, `"partial":true`) {
		t.Fatalf("oversized source fragment is not marked partial: %s", task.Prompt.User)
	}
	encoded, err := json.Marshal(map[string]any{
		"bodySuggestions": []map[string]any{{
			"category": "hierarchy", "before": anchor,
			"after":  "这是超长段落中更清楚、且可以安全改写的开头。",
			"reason": "The unique opening can be improved without rewriting unseen text.",
		}},
		"layoutAssessment":  writingReviewTaskDimensionsForTest(),
		"layoutSuggestions": []any{},
	})
	if err != nil {
		t.Fatal(err)
	}
	_, validated, err := parseWritingReviewTaskResult(task, encoded, "标题", content)
	if err != nil {
		t.Fatal(err)
	}
	if len(validated.Suggestions) != 1 || validated.Suggestions[0].Before != anchor {
		t.Fatalf("oversized block excerpt suggestion was not retained: %+v", validated.Suggestions)
	}

	unseenJSON, err := json.Marshal(map[string]any{
		"bodySuggestions": []map[string]any{{
			"category": "hierarchy", "before": unseenAnchor,
			"after":  "这是模型没有收到、因此不能改写的结尾。",
			"reason": "This exact text was outside the supplied fragment.",
		}},
		"layoutAssessment":  writingReviewTaskDimensionsForTest(),
		"layoutSuggestions": []any{},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := parseWritingReviewTaskResult(task, unseenJSON, "标题", content); !errors.Is(err, errAgentLLMInvalidResponse) {
		t.Fatalf("unsupplied suffix error=%v, want invalid response", err)
	}
}

func TestWritingReviewDocumentRejectsUnsuppliedOversizedBlockSuffix(t *testing.T) {
	unseenAnchor := "这是全文任务没有收到的超长段落结尾。"
	content := strings.Repeat("这是一段用于撑过全文任务来源预算的正文。", 5_000) + unseenAnchor
	plan, err := buildWritingReviewTaskPlan("标题", content)
	if err != nil {
		t.Fatal(err)
	}
	var task writingReviewTaskSpec
	for _, candidate := range plan.Tasks {
		if candidate.Stage == agentReviewTaskDocument {
			task = candidate
			break
		}
	}
	if task.ID == "" {
		t.Fatal("whole-document task not found")
	}
	blocks := parseMarkdownReviewBlocks(content)
	if len(blocks) != 1 {
		t.Fatalf("parsed blocks=%d, want one oversized paragraph", len(blocks))
	}
	ranges := task.AllowedBodyBlockRanges[blocks[0].ID]
	if len(ranges) != 1 || ranges[0].contains(strings.Index(content, unseenAnchor), len(content)) {
		t.Fatalf("unexpected whole-document source ranges: %+v", ranges)
	}
	raw, err := json.Marshal(map[string]any{
		"bodySuggestions": []map[string]any{{
			"category": "structure", "before": unseenAnchor,
			"after":  "这是全文任务没有收到、因此不能改写的结尾。",
			"reason": "This exact text was outside the supplied fragment.",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := parseWritingReviewTaskResult(task, raw, "标题", content); !errors.Is(err, errAgentLLMInvalidResponse) {
		t.Fatalf("unsupplied document suffix error=%v, want invalid response", err)
	}
}

func TestBuildDeepWritingReviewTaskPlanSupportsDevelopmentalEdits(t *testing.T) {
	content := "第一段先介绍背景。\n\n这一段才给出文章的核心判断。\n\n## 第二部分\n\n第二段用于验证深入分析建议。"
	plan, err := buildDeepWritingReviewTaskPlan("标题", content, "hierarchy", writingReviewDeepContext{
		Summary: "The first pass found weak hierarchy.",
		Suggestions: []writingReviewDeepPriorSuggestion{{
			Kind: "layout", Category: "hierarchy", Operation: "change_block_type", Before: "第一段", After: "## 第一段", Reason: "Add hierarchy.", Status: "pending",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Mode != agentReviewModeDeep || plan.FocusDimension != "hierarchy" || len(plan.Tasks) != 1 {
		t.Fatalf("unexpected deep plan: %+v", plan)
	}
	progress := newAgentReviewTaskProgress(plan)
	if progress.Mode != agentReviewModeDeep || progress.FocusDimension != "hierarchy" ||
		progress.TotalTasks != 1 || len(progress.Stages) != 1 || progress.Stages[0].ID != agentReviewTaskLayout {
		t.Fatalf("unexpected deep progress: %+v", progress)
	}
	task := plan.Tasks[0]
	if task.Stage != agentReviewTaskLayout || task.FocusDimension != "hierarchy" ||
		task.Prompt.MaxOutputTokens != agentReviewDeepMaxOutputTokens ||
		!strings.Contains(task.Prompt.User, `"focusDimension":"hierarchy"`) ||
		!strings.Contains(task.Prompt.User, `"priorReview"`) ||
		!strings.Contains(task.Prompt.System, "developmental editing") ||
		!strings.Contains(task.Prompt.System, "Do not turn ordinary sentences into h3 headings") {
		t.Fatalf("unexpected deep task: %+v", task)
	}
	if _, allowed := task.AllowedBodyCategories["hierarchy"]; !allowed {
		t.Fatalf("deep task does not allow focused body suggestions: %+v", task.AllowedBodyCategories)
	}

	wrongCategoryJSON, err := json.Marshal(map[string]any{
		"bodySuggestions": []map[string]any{{
			"category": "mobile", "before": "第一段先介绍背景。", "after": "先介绍背景。", "reason": "Wrong dimension.",
		}},
		"layoutAssessment":  writingReviewTaskDimensionsForTest(),
		"layoutSuggestions": []map[string]any{},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := parseWritingReviewTaskResult(task, wrongCategoryJSON, "标题", content); !errors.Is(err, errAgentLLMInvalidResponse) {
		t.Fatalf("wrong focused category error=%v, want invalid response", err)
	}

	validJSON, err := json.Marshal(map[string]any{
		"bodySuggestions": []map[string]any{{
			"category": "hierarchy",
			"before":   "第一段先介绍背景。\n\n这一段才给出文章的核心判断。",
			"after":    "这一段先给出文章的核心判断。\n\n接着用第一段的背景解释这个判断从何而来。",
			"reason":   "把核心判断前置，再用背景承接，让读者先知道这一节要证明什么。",
		}},
		"layoutAssessment": writingReviewTaskDimensionsForTest(),
		"layoutSuggestions": []map[string]any{{
			"category": "hierarchy", "operation": "insert_divider", "blockId": "block-4",
			"afterType": "", "segments": []any{}, "reason": "Separate the opening from the next module.",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	generated, validated, err := parseWritingReviewTaskResult(task, validJSON, "标题", content)
	if err != nil {
		t.Fatal(err)
	}
	if len(validated.Suggestions) != 2 || validated.Suggestions[0].Kind != "content" ||
		validated.Suggestions[0].Category != "hierarchy" || validated.Suggestions[1].Kind != "layout" {
		t.Fatalf("focused suggestions=%+v", validated.Suggestions)
	}
	_, merged, err := mergeWritingReviewTaskResults([]writingReviewTaskResult{{
		Task: task, Generated: generated, Validated: validated,
	}}, "标题", content)
	if err != nil {
		t.Fatal(err)
	}
	if merged.Summary == "" || merged.HasTitleReview || merged.TitleScore != 0 ||
		merged.TitleAssessment != "" || len(merged.Suggestions) != 2 {
		t.Fatalf("merged deep review=%+v", merged)
	}
}

func TestWritingReviewDeepContextKeepsRelevantFocusedSuggestions(t *testing.T) {
	operation := "insert_divider"
	summary := "First-pass summary."
	review := agentReviewView{
		Summary: &summary,
		LayoutAssessment: []writingReviewDimension{
			{ID: "hierarchy", Label: "Hierarchy", Score: 40, Summary: "Weak hierarchy."},
			{ID: "mobile", Label: "Mobile", Score: 70, Summary: "Good mobile flow."},
		},
		Suggestions: []agentReviewSuggestionView{
			{Kind: "layout", Category: "hierarchy", Operation: &operation, Before: "First", After: "First\n\n---", Reason: "Separate modules.", Status: "pending"},
			{Kind: "layout", Category: "mobile", Operation: &operation, Before: "Second", After: "Second\n\n---", Reason: "Mobile break.", Status: "pending"},
			{Target: "body", Kind: "content", Category: "structure", Before: "Third", After: "Updated third", Reason: "Clarify.", Status: "pending"},
			{Target: "body", Kind: "content", Category: "style", Before: "Fourth", After: "Updated fourth", Reason: "Polish.", Status: "pending"},
			{Target: "body", Kind: "content", Category: "hierarchy", Before: "Fifth", After: "Updated fifth", Reason: "Previous deep edit.", Status: "pending"},
		},
	}
	context := writingReviewDeepContextFromReview(review, "hierarchy")
	if context.Summary != summary || context.Dimension == nil || context.Dimension.ID != "hierarchy" ||
		len(context.Suggestions) != 3 || context.Suggestions[0].Reason != "Separate modules." ||
		context.Suggestions[1].Category != "structure" || context.Suggestions[2].Category != "hierarchy" {
		t.Fatalf("unexpected deep context: %+v", context)
	}
}

func TestWritingReviewDeepContextUsesTargetSummaryWhenFocusChanges(t *testing.T) {
	sourceSummary := "The hierarchy pass found a weak section order."
	review := agentReviewView{
		Summary: &sourceSummary,
		TaskProgress: agentReviewTaskProgress{
			Mode: agentReviewModeDeep, FocusDimension: "hierarchy",
		},
		LayoutAssessment: []writingReviewDimension{
			{ID: "hierarchy", Label: "Hierarchy", Score: 45, Summary: "Weak section order."},
			{ID: "mobile", Label: "Mobile", Score: 62, Summary: "Paragraphs are dense on small screens."},
		},
	}

	context := writingReviewDeepContextFromReview(review, "mobile")
	if context.Summary != "Paragraphs are dense on small screens." ||
		context.Dimension == nil || context.Dimension.ID != "mobile" {
		t.Fatalf("cross-dimension deep context reused the source focus: %+v", context)
	}
}

func TestWritingReviewDeepContextBalancesLayoutAndContentSuggestions(t *testing.T) {
	review := agentReviewView{}
	for index := 0; index < 12; index++ {
		review.Suggestions = append(review.Suggestions, agentReviewSuggestionView{
			Target: "body", Kind: "content", Category: "structure",
			Before: fmt.Sprintf("content-before-%d", index),
			After:  fmt.Sprintf("content-after-%d", index),
			Reason: "Improve the argument path.", Status: "pending",
		})
	}
	operation := "insert_divider"
	for index := 0; index < 2; index++ {
		review.Suggestions = append(review.Suggestions, agentReviewSuggestionView{
			Target: "body", Kind: "layout", Category: "hierarchy", Operation: &operation,
			Before: fmt.Sprintf("layout-before-%d", index),
			After:  fmt.Sprintf("layout-after-%d", index),
			Reason: "Separate the article modules.", Status: "pending",
		})
	}

	context := writingReviewDeepContextFromReview(review, "hierarchy")
	hasLayout, hasContent := false, false
	for _, suggestion := range context.Suggestions {
		hasLayout = hasLayout || suggestion.Kind == "layout"
		hasContent = hasContent || suggestion.Kind == "content"
	}
	if !hasLayout || !hasContent || len(context.Suggestions) > agentReviewDeepContextSuggestionLimit {
		t.Fatalf("unbalanced deep context suggestions: %+v", context.Suggestions)
	}
}

func TestWritingReviewDeepContextStaysBounded(t *testing.T) {
	summary := strings.Repeat(`\`, 4_000)
	review := agentReviewView{
		Summary: &summary,
		LayoutAssessment: []writingReviewDimension{{
			ID: "hierarchy", Label: strings.Repeat(`\`, 200), Score: 35,
			Summary: strings.Repeat(`\`, 4_000),
		}},
	}
	for index := 0; index < 20; index++ {
		review.Suggestions = append(review.Suggestions, agentReviewSuggestionView{
			Target: "body", Kind: "content", Category: "hierarchy",
			Before: strings.Repeat(`\`, 4_000) + fmt.Sprintf("before-%d", index),
			After:  strings.Repeat(`\`, 4_000) + fmt.Sprintf("after-%d", index),
			Reason: strings.Repeat(`\`, 4_000) + fmt.Sprintf("reason-%d", index),
			Status: "pending",
		})
	}

	context := writingReviewDeepContextFromReview(review, "hierarchy")
	encoded, err := json.Marshal(context)
	if err != nil {
		t.Fatal(err)
	}
	if len(encoded) > agentReviewDeepContextBytes {
		t.Fatalf("encoded deep context=%d bytes, limit=%d", len(encoded), agentReviewDeepContextBytes)
	}
	if len(context.Suggestions) == 0 || len(context.Suggestions) > agentReviewDeepContextSuggestionLimit {
		t.Fatalf("bounded suggestions=%d", len(context.Suggestions))
	}
	if len(context.Summary) > agentReviewDeepContextSummaryBytes || context.Dimension == nil ||
		len(context.Dimension.Summary) > agentReviewDeepContextDimensionBytes {
		t.Fatalf("unbounded context fields: %+v", context)
	}
	for _, suggestion := range context.Suggestions {
		if len(suggestion.Before) > agentReviewDeepContextPatchBytes ||
			len(suggestion.After) > agentReviewDeepContextPatchBytes ||
			len(suggestion.Reason) > agentReviewDeepContextReasonBytes {
			t.Fatalf("unbounded suggestion: %+v", suggestion)
		}
	}
}

func TestDeepWritingReviewRejectsBodyContentOutsidePromptScope(t *testing.T) {
	paragraphs := make([]string, 220)
	for index := range paragraphs {
		paragraphs[index] = fmt.Sprintf("第 %03d 段：", index) + strings.Repeat("这是一段用于深度结构分析的正文。", 80)
	}
	content := strings.Join(paragraphs, "\n\n")
	plan, err := buildDeepWritingReviewTaskPlan("长文标题", content, "hierarchy", writingReviewDeepContext{})
	if err != nil {
		t.Fatal(err)
	}
	task := plan.Tasks[0]
	blocks := parseMarkdownReviewBlocks(content)
	var unseen markdownReviewBlock
	for _, block := range blocks {
		if _, allowed := task.AllowedBodyBlockIDs[block.ID]; !allowed && block.Editable {
			unseen = block
			break
		}
	}
	if unseen.ID == "" {
		t.Fatal("expected a block whose source was omitted from the deep prompt")
	}
	raw, err := json.Marshal(map[string]any{
		"bodySuggestions": []map[string]any{{
			"category": "hierarchy", "before": unseen.Source,
			"after": unseen.Source + "补充。", "reason": "The model did not receive this source.",
		}},
		"layoutAssessment":  writingReviewTaskDimensionsForTest(),
		"layoutSuggestions": []map[string]any{},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := parseWritingReviewTaskResult(task, raw, "长文标题", content); !errors.Is(err, errAgentLLMInvalidResponse) {
		t.Fatalf("unseen body block error=%v, want invalid response", err)
	}
}

func TestWritingReviewDocumentPromptSupportsExactMultiBlockReplacement(t *testing.T) {
	content := "第一段提出问题。\n\n\n第二段重复了同一个结论。"
	plan, err := buildWritingReviewTaskPlan("标题", content)
	if err != nil {
		t.Fatal(err)
	}
	var task writingReviewTaskSpec
	for _, candidate := range plan.Tasks {
		if candidate.Stage == agentReviewTaskDocument {
			task = candidate
			break
		}
	}
	if task.ID == "" {
		t.Fatal("document task missing")
	}
	prefix := "Review this JSON-encoded whole article and return only the requested document review JSON.\n\nDOCUMENT_ARTICLE:\n"
	var input struct {
		Blocks []writingReviewLayoutPromptBlock `json:"blocks"`
	}
	if err := json.Unmarshal([]byte(strings.TrimPrefix(task.Prompt.User, prefix)), &input); err != nil {
		t.Fatal(err)
	}
	if len(input.Blocks) != 2 || input.Blocks[0].SeparatorAfter != "\n\n\n" {
		t.Fatalf("document prompt omitted exact block separator: %+v", input.Blocks)
	}
	raw, err := json.Marshal(map[string]any{
		"bodySuggestions": []map[string]any{{
			"category": "structure",
			"before":   content,
			"after":    "第一段提出问题，并在第二段直接给出结论。",
			"reason":   "合并重复论证，让结论紧跟问题。",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	_, validated, err := parseWritingReviewTaskResult(task, raw, "标题", content)
	if err != nil {
		t.Fatal(err)
	}
	if len(validated.Suggestions) != 1 || validated.Suggestions[0].Before != content {
		t.Fatalf("multi-block suggestion was not accepted: %+v", validated.Suggestions)
	}
}

func TestWritingReviewDocumentRejectsSeparatorOutsidePromptBudget(t *testing.T) {
	content := "第一段提出问题。\n\n第二段重复结论。"
	blocks := parseMarkdownReviewBlocks(content)
	if len(blocks) != 2 {
		t.Fatalf("parsed blocks=%d, want 2", len(blocks))
	}
	sourceBudget := len(blocks[0].Source) + len(blocks[1].Source)
	promptBlocks := writingReviewSampledLayoutBlocks(blocks, 10, sourceBudget, 2, 0)
	if len(promptBlocks) != 2 || promptBlocks[0].Source == "" || promptBlocks[1].Source == "" ||
		promptBlocks[0].SeparatorAfter != "" {
		t.Fatalf("test requires two sources without their separator: %+v", promptBlocks)
	}
	task := writingReviewTaskSpec{
		ID: "document", Stage: agentReviewTaskDocument,
		AllowedBodyBlockIDs:    writingReviewSourcedBlockIDs(promptBlocks),
		AllowedBodyBlockRanges: writingReviewSourcedBlockRanges(promptBlocks),
	}
	raw, err := json.Marshal(map[string]any{
		"bodySuggestions": []map[string]any{{
			"category": "structure", "before": content,
			"after":  "第一段提出问题，第二段直接给出结论。",
			"reason": "This guesses a separator that was omitted from the prompt.",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := parseWritingReviewTaskResult(task, raw, "标题", content); !errors.Is(err, errAgentLLMInvalidResponse) {
		t.Fatalf("omitted separator error=%v, want invalid response", err)
	}
}

func TestWritingReviewBodyChunkRejectsCrossBlockSeparator(t *testing.T) {
	content := "第一段需要局部审阅。\n\n第二段也需要局部审阅。"
	plan, err := buildWritingReviewTaskPlan("标题", content)
	if err != nil {
		t.Fatal(err)
	}
	var task writingReviewTaskSpec
	for _, candidate := range plan.Tasks {
		if candidate.Stage == agentReviewTaskBody {
			task = candidate
			break
		}
	}
	if task.ID == "" {
		t.Fatal("body task missing")
	}
	raw, err := json.Marshal(map[string]any{
		"bodySuggestions": []map[string]any{{
			"category": "clarity", "before": content,
			"after":  "第一段和第二段合并后更清楚。",
			"reason": "The chunk prompt did not provide the exact bytes between blocks.",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := parseWritingReviewTaskResult(task, raw, "标题", content); !errors.Is(err, errAgentLLMInvalidResponse) {
		t.Fatalf("cross-block body error=%v, want invalid response", err)
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

func TestWritingReviewBodySuggestionLimitsShareGlobalCandidateBudget(t *testing.T) {
	for chunkCount := 1; chunkCount <= agentReviewMaxBodyTasks; chunkCount++ {
		limits := writingReviewBodySuggestionLimits(chunkCount)
		if len(limits) != chunkCount {
			t.Fatalf("chunkCount=%d limits=%v", chunkCount, limits)
		}
		total := 0
		minimum, maximum := limits[0], limits[0]
		for _, limit := range limits {
			if limit < 1 || limit > agentReviewBodyChunkSuggestions {
				t.Fatalf("chunkCount=%d limits=%v, invalid per-chunk budget", chunkCount, limits)
			}
			total += limit
			minimum = min(minimum, limit)
			maximum = max(maximum, limit)
		}
		wantTotal := min(agentReviewMaxBodySuggestions, chunkCount*agentReviewBodyChunkSuggestions)
		if total != wantTotal || maximum-minimum > 1 {
			t.Fatalf("chunkCount=%d limits=%v total=%d want=%d", chunkCount, limits, total, wantTotal)
		}
	}
}

// 全局上限在合并阶段兑现：全文级建议先占位，分块建议按块轮转，
// 避免靠前的块把名额吃光。
func TestMergeWritingReviewBodySuggestionsPrefersDocumentThenRoundRobin(t *testing.T) {
	suggestion := func(id string) generatedBodySuggestion {
		return generatedBodySuggestion{Category: "clarity", Before: id, After: id + "!", Reason: id}
	}
	content := "doc-1 doc-2 a-1 a-2 a-3 b-1 b-2"
	merged := mergeWritingReviewBodySuggestions(
		[]generatedBodySuggestion{suggestion("doc-1"), suggestion("doc-2")},
		[][]generatedBodySuggestion{
			{suggestion("a-1"), suggestion("a-2"), suggestion("a-3")},
			{suggestion("b-1"), suggestion("b-2")},
		},
		content,
		6,
	)
	got := make([]string, 0, len(merged))
	for _, item := range merged {
		got = append(got, item.Before)
	}
	want := []string{"doc-1", "doc-2", "a-1", "b-1", "a-2", "b-2"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("merged order=%v, want %v", got, want)
	}
	if trimmed := mergeWritingReviewBodySuggestions(nil, [][]generatedBodySuggestion{
		{suggestion("a-1"), suggestion("a-2")},
		{suggestion("b-1"), suggestion("b-2")},
	}, content, 3); len(trimmed) != 3 || trimmed[0].Before != "a-1" || trimmed[1].Before != "b-1" || trimmed[2].Before != "a-2" {
		t.Fatalf("trimmed=%+v", trimmed)
	}
}

func TestMergeWritingReviewBodySuggestionsBackfillsAfterCrossTaskOverlap(t *testing.T) {
	content := "开头先介绍背景。\n\n这一段给出结论。\n\n最后补充行动建议。"
	documentSuggestion := generatedBodySuggestion{
		Category: "structure",
		Before:   "开头先介绍背景。\n\n这一段给出结论。",
		After:    "这一段先给出结论。\n\n再介绍必要背景。",
		Reason:   "把结论前置。",
	}
	overlappingChunkSuggestion := generatedBodySuggestion{
		Category: "clarity", Before: "这一段给出结论。", After: "这一段明确给出结论。", Reason: "强化结论。",
	}
	backfillSuggestion := generatedBodySuggestion{
		Category: "engagement", Before: "最后补充行动建议。", After: "最后给出下一步行动建议。", Reason: "明确行动。",
	}
	merged := mergeWritingReviewBodySuggestions(
		[]generatedBodySuggestion{documentSuggestion},
		[][]generatedBodySuggestion{{overlappingChunkSuggestion, backfillSuggestion}},
		content,
		2,
	)
	if len(merged) != 2 || merged[0].Before != documentSuggestion.Before || merged[1].Before != backfillSuggestion.Before {
		t.Fatalf("merged=%+v, want overlapping suggestion skipped and later suggestion backfilled", merged)
	}
}

// 无效建议不能先占住全局额度再被丢掉，否则几个任务各带一条废建议就能把
// 12 条名额吃光，最后一条有效建议也留不下。
func TestMergeWritingReviewTaskResultsDoesNotSpendQuotaOnRejectedSuggestions(t *testing.T) {
	content := "第一段承载第一个锚点。\n\n第二段承载第二个锚点。"
	taskResult := func(id, before, after string) writingReviewTaskResult {
		bad := generatedBodySuggestion{
			Category: "clarity", Before: "文档里不存在的锚点" + id, After: "无关紧要。", Reason: "锚点不存在。",
		}
		good := generatedBodySuggestion{Category: "clarity", Before: before, After: after, Reason: "改写这一段。"}
		return writingReviewTaskResult{
			Task: writingReviewTaskSpec{ID: id, Stage: agentReviewTaskBody},
			// 模型先返回一条废的再返回一条有效的，任务级校验已经把废的滤掉了
			Generated: generatedWritingReview{BodySuggestions: []generatedBodySuggestion{bad, good}},
			Validated: validatedWritingReview{Suggestions: []validatedWritingSuggestion{
				{Target: "body", Kind: "content", Category: "clarity", Before: before, After: after, Reason: "改写这一段。"},
			}},
		}
	}
	results := []writingReviewTaskResult{
		{
			Task: writingReviewTaskSpec{ID: "title", Stage: agentReviewTaskTitle},
			Generated: generatedWritingReview{
				Summary: "Summary.", TitleScore: 80, TitleAssessment: "The title is supported.",
			},
			Validated: validatedWritingReview{HasTitleReview: true},
		},
		taskResult("body-1", "第一段承载第一个锚点。", "第一段先给出结论。"),
		taskResult("body-2", "第二段承载第二个锚点。", "第二段补上证据。"),
		{
			Task:      writingReviewTaskSpec{ID: "layout", Stage: agentReviewTaskLayout},
			Generated: generatedWritingReview{LayoutAssessment: placeholderWritingReviewDimensions()},
		},
	}
	_, merged, err := mergeWritingReviewTaskResults(results, "标题", content)
	if err != nil {
		t.Fatal(err)
	}
	if len(merged.Suggestions) != 2 {
		t.Fatalf("merged suggestions=%+v, want both valid suggestions to survive", merged.Suggestions)
	}
}

// 模型对同一段给出多个方案时，只有第一条能通过重复锚点检查。落选的那几条
// Before 相同，如果按 Before 回原始输出里捞，会把它们一起放回来占额度。
func TestMergeWritingReviewTaskResultsIgnoresRejectedAlternativesWithSameAnchor(t *testing.T) {
	content := "第一段承载唯一的锚点。\n\n第二段保持原样。"
	anchor := "第一段承载唯一的锚点。"
	raw, err := json.Marshal(map[string]any{
		"bodySuggestions": []map[string]any{
			{"category": "clarity", "before": anchor, "after": "第一段先给出结论。", "reason": "方案一：把结论前置。"},
			{"category": "clarity", "before": anchor, "after": "第一段换个说法。", "reason": "方案二：同一段的另一种改法。"},
			{"category": "clarity", "before": anchor, "after": "第一段再换个说法。", "reason": "方案三：同一段的第三种改法。"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	bodyTask := writingReviewTaskSpec{ID: "body-1", Stage: agentReviewTaskBody}
	generated, validated, err := parseWritingReviewTaskResult(bodyTask, raw, "标题", content)
	if err != nil {
		t.Fatal(err)
	}
	if len(validated.Suggestions) != 1 {
		t.Fatalf("task validation kept %d suggestions for one anchor", len(validated.Suggestions))
	}
	accepted := writingReviewAcceptedBodySuggestions(writingReviewTaskResult{
		Task: bodyTask, Generated: generated, Validated: validated,
	})
	if len(accepted) != 1 || accepted[0].After != "第一段先给出结论。" {
		t.Fatalf("accepted=%+v, want only the suggestion that survived task validation", accepted)
	}
}

// 代码、HTML、分隔线在拆分时就被剔掉，模型根本没见过，但它们的字节位置夹在
// 本块首尾之间。只靠区间挡不住，必须同时用块 ID 排除。
func TestWritingReviewBodyChunkRejectsAnchorsInsideSkippedBlocks(t *testing.T) {
	content := "第一段介绍背景。\n\n```js\nconst value = 1\n```\n\n<div>raw</div>\n\n第二段给出结论。"
	plan, err := buildWritingReviewTaskPlan("标题", content)
	if err != nil {
		t.Fatal(err)
	}
	var bodyTask writingReviewTaskSpec
	for _, task := range plan.Tasks {
		if task.Stage == agentReviewTaskBody {
			bodyTask = task
			break
		}
	}
	if bodyTask.ID == "" || bodyTask.AllowedBodyRange == nil || bodyTask.AllowedBodyBlockIDs == nil {
		t.Fatalf("body chunk task must carry both scopes: %+v", bodyTask)
	}

	skipped := make([]markdownReviewBlock, 0, 2)
	for _, block := range parseMarkdownReviewBlocks(content) {
		if block.Kind == "code" || block.Kind == "html" {
			skipped = append(skipped, block)
		}
	}
	if len(skipped) != 2 {
		t.Fatalf("expected the document to contain a code block and an HTML block: %+v", skipped)
	}
	for _, block := range skipped {
		// 区间确实盖住了它们——这正是只靠区间不够的原因
		if !bodyTask.AllowedBodyRange.contains(block.Start, block.End) {
			t.Fatalf("%s block is outside the chunk range, test no longer covers the gap", block.Kind)
		}
		raw, err := json.Marshal(map[string]any{
			"bodySuggestions": []map[string]any{{
				"category": "clarity", "before": block.Source,
				"after": block.Source + "\n", "reason": "模型没有收到这一块。",
			}},
		})
		if err != nil {
			t.Fatal(err)
		}
		if _, _, err := parseWritingReviewTaskResult(bodyTask, raw, "标题", content); !errors.Is(err, errAgentLLMInvalidResponse) {
			t.Fatalf("%s anchor error=%v, want invalid response", block.Kind, err)
		}
	}

	// 跨过被剔除的块去改写同样要拒绝
	spanning := content[strings.Index(content, "第一段介绍背景。"):]
	raw, err := json.Marshal(map[string]any{
		"bodySuggestions": []map[string]any{{
			"category": "structure", "before": spanning,
			"after": "第一段介绍背景。\n\n第二段给出结论。", "reason": "跨过了没收到的代码块。",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := parseWritingReviewTaskResult(bodyTask, raw, "标题", content); !errors.Is(err, errAgentLLMInvalidResponse) {
		t.Fatalf("spanning anchor error=%v, want invalid response", err)
	}

	// 本块内的正常改写仍然放行
	ok, err := json.Marshal(map[string]any{
		"bodySuggestions": []map[string]any{{
			"category": "clarity", "before": "第一段介绍背景。",
			"after": "第一段先给出结论。", "reason": "把结论前置，读者不必等到最后一段。",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	_, validated, err := parseWritingReviewTaskResult(bodyTask, ok, "标题", content)
	if err != nil {
		t.Fatalf("in-scope suggestion must survive: %v", err)
	}
	if len(validated.Suggestions) != 1 {
		t.Fatalf("validated=%+v", validated.Suggestions)
	}
}

// 超长段落被拆给多个任务时，每个任务只该拿到自己那一份的字节区间。
func TestWritingReviewChunkScopesDoNotOverlapAcrossSplitParts(t *testing.T) {
	huge := strings.Repeat("这是一段超过单块上限因而会被拆开的正文。", 3_000)
	content := huge
	blocks := parseMarkdownReviewBlocks(content)
	prepared := prepareWritingReviewBodyBlocks(blocks)
	if len(prepared) < 2 {
		t.Fatalf("test paragraph did not split into parts: %d", len(prepared))
	}
	for _, part := range prepared {
		if content[part.Start:part.End] != part.Source {
			t.Fatalf("part %s byte range does not match its source", part.ID)
		}
	}
	for index := 1; index < len(prepared); index++ {
		if prepared[index].Start != prepared[index-1].End {
			t.Fatalf("parts %s and %s are not contiguous", prepared[index-1].ID, prepared[index].ID)
		}
	}
	firstScope := writingReviewChunkRange(prepared[:1])
	if firstScope.contains(prepared[1].Start, prepared[1].End) {
		t.Fatalf("scope %+v leaked into the next part of the same block", firstScope)
	}
	// 空分块说明整篇没有可审正文，此时任何锚点都是编造的
	if empty := writingReviewChunkRange(nil); empty == nil || empty.contains(0, 1) {
		t.Fatalf("empty chunk scope=%+v, want everything rejected", empty)
	}
}

// 分块任务只该改自己那一块。它能从 outline 和 PRIOR_FINDINGS 里看到别处的标题文字，
// 足以拼出块外的精确锚点。
func TestWritingReviewBodyChunkRejectsAnchorsOutsideItsChunk(t *testing.T) {
	paragraphs := make([]string, 80)
	for index := range paragraphs {
		paragraphs[index] = fmt.Sprintf("第 %02d 段：", index) + strings.Repeat("这是一段用于分块作用域测试的正文。", 60)
	}
	content := strings.Join(paragraphs, "\n\n")
	plan, err := buildWritingReviewTaskPlan("标题", content)
	if err != nil {
		t.Fatal(err)
	}
	var first, second writingReviewTaskSpec
	for _, task := range plan.Tasks {
		if task.Stage != agentReviewTaskBody {
			continue
		}
		if first.ID == "" {
			first = task
			continue
		}
		second = task
		break
	}
	if first.ID == "" || second.ID == "" {
		t.Fatalf("test document did not split into at least two body chunks: %+v", plan.Tasks)
	}
	if first.AllowedBodyRange == nil || second.AllowedBodyRange == nil {
		t.Fatal("body chunk task must carry its own byte-range scope")
	}
	if second.AllowedBodyRange.Start < first.AllowedBodyRange.End {
		t.Fatalf("chunk scopes overlap: %+v vs %+v", first.AllowedBodyRange, second.AllowedBodyRange)
	}
	blocks := parseMarkdownReviewBlocks(content)
	outside := ""
	for _, block := range blocks {
		if block.Editable && !first.AllowedBodyRange.contains(block.Start, block.End) {
			outside = block.Source
			break
		}
	}
	if outside == "" {
		t.Fatal("expected an editable block outside the first chunk")
	}
	raw, err := json.Marshal(map[string]any{
		"bodySuggestions": []map[string]any{
			{"category": "clarity", "before": outside, "after": outside + "补充。", "reason": "这一段不属于本块。"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := parseWritingReviewTaskResult(first, raw, "标题", content); !errors.Is(err, errAgentLLMInvalidResponse) {
		t.Fatalf("out-of-chunk anchor error=%v, want invalid response", err)
	}
}

// 注入到每个 wave 1 任务的首轮诊断必须有硬上界。
func TestWritingReviewPriorFindingsStaysBounded(t *testing.T) {
	dimensions := make([]writingReviewDimension, 0, len(writingReviewDimensionIDs))
	for _, id := range writingReviewDimensionIDs {
		dimensions = append(dimensions, writingReviewDimension{
			ID: id, Label: strings.Repeat("标", 80), Score: 40, Summary: strings.Repeat("很长的维度描述。", 400),
		})
	}
	findings := writingReviewPriorFindingsJSON([]writingReviewTaskResult{
		{
			Task: writingReviewTaskSpec{ID: "title", Stage: agentReviewTaskTitle},
			Validated: validatedWritingReview{
				Summary: strings.Repeat("很长的全局诊断。", 400), TitleScore: 30,
				TitleAssessment: strings.Repeat("很长的标题评价。", 400),
			},
		},
		{
			Task:      writingReviewTaskSpec{ID: "layout", Stage: agentReviewTaskLayout},
			Validated: validatedWritingReview{LayoutAssessment: dimensions},
		},
	})
	if findings == "" {
		t.Fatal("prior findings must survive truncation")
	}
	if len(findings) > agentReviewPriorFindingsBytes {
		t.Fatalf("prior findings bytes=%d, want <= %d", len(findings), agentReviewPriorFindingsBytes)
	}
	if len(findings)+len(writingReviewPriorFindingsPrefix) > agentReviewPriorFindingsTokens {
		t.Fatalf("prior findings exceed the reserved allowance: %d", len(findings))
	}
	var decoded writingReviewPriorFindings
	if err := json.Unmarshal([]byte(findings), &decoded); err != nil {
		t.Fatalf("truncated prior findings must stay valid JSON: %v", err)
	}
	if decoded.TitleScore != 30 || len(decoded.LayoutAssessment) != len(writingReviewDimensionIDs) {
		t.Fatalf("decoded prior findings=%+v", decoded)
	}
}

// 单条不合法只丢这一条，不能连累同一份响应里写对的建议。
func TestWritingReviewTaskDropsOnlyTheRejectedBodySuggestion(t *testing.T) {
	content := "第一段落用于承载可用的锚点。\n\n第二段落保持原样。"
	task := writingReviewTaskSpec{ID: "body-1", Stage: agentReviewTaskBody}
	raw, err := json.Marshal(map[string]any{
		"bodySuggestions": []map[string]any{
			{"category": "clarity", "before": "第一段落用于承载可用的锚点。", "after": "第一段落给出本节要证明的结论。", "reason": "把结论前置。"},
			{"category": "clarity", "before": "文档里根本不存在的锚点。", "after": "无关紧要。", "reason": "锚点不存在。"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	_, validated, err := parseWritingReviewTaskResult(task, raw, "标题", content)
	if err != nil {
		t.Fatalf("one bad anchor must not fail the whole task: %v", err)
	}
	if len(validated.Suggestions) != 1 || validated.Suggestions[0].Before != "第一段落用于承载可用的锚点。" {
		t.Fatalf("validated=%+v", validated.Suggestions)
	}

	allBad, err := json.Marshal(map[string]any{
		"bodySuggestions": []map[string]any{
			{"category": "clarity", "before": "同样不存在的锚点。", "after": "无关紧要。", "reason": "锚点不存在。"},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := parseWritingReviewTaskResult(task, allBad, "标题", content); !errors.Is(err, errAgentLLMInvalidResponse) {
		t.Fatalf("all-rejected error=%v, want invalid response so the task retries", err)
	}
}

// 全文级补丁与局部润色撞在同一段时，保全文级的那条。
func TestValidateWritingReviewKeepsDocumentPatchOverOverlappingChunkEdit(t *testing.T) {
	content := "开头一段先铺垫背景。\n\n这一段才给出结论。"
	documentPatch := generatedBodySuggestion{
		Category: "structure",
		Before:   "开头一段先铺垫背景。\n\n这一段才给出结论。",
		After:    "这一段先给出结论。\n\n再用开头的背景解释它从何而来。",
		Reason:   "结论埋在第二段，读者读完第一段还不知道这节要证明什么。",
	}
	chunkEdit := generatedBodySuggestion{
		Category: "clarity", Before: "这一段才给出结论。", After: "这一段给出结论。", Reason: "去掉多余的语气词。",
	}
	generated := generatedWritingReview{
		Summary: "Summary.", TitleScore: 80, TitleAssessment: "The title is supported.",
		LayoutAssessment: placeholderWritingReviewDimensions(),
		BodySuggestions:  []generatedBodySuggestion{documentPatch, chunkEdit},
	}
	validated, err := validateGeneratedWritingReview(generated, "标题", content, true, nil, nil, nil, nil, nil, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(validated.Suggestions) != 1 || validated.Suggestions[0].Before != documentPatch.Before {
		t.Fatalf("validated=%+v, want the whole-document patch to win", validated.Suggestions)
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
		if _, err := validateGeneratedWritingReview(generated, "Title", content, true, nil, nil, nil, nil, nil, false); err != nil {
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
		// 合并只挑各任务已通过校验的那部分，所以两边都要带上 Validated
		{
			Task:      writingReviewTaskSpec{ID: "body-1", Stage: agentReviewTaskBody},
			Generated: generatedWritingReview{BodySuggestions: []generatedBodySuggestion{first}},
			Validated: validatedWritingReview{Suggestions: []validatedWritingSuggestion{
				{Target: "body", Kind: "content", Category: first.Category, Before: first.Before, After: first.After, Reason: first.Reason},
			}},
		},
		{
			Task:      writingReviewTaskSpec{ID: "body-2", Stage: agentReviewTaskBody},
			Generated: generatedWritingReview{BodySuggestions: []generatedBodySuggestion{second}},
			Validated: validatedWritingReview{Suggestions: []validatedWritingSuggestion{
				{Target: "body", Kind: "content", Category: second.Category, Before: second.Before, After: second.After, Reason: second.Reason},
			}},
		},
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

func TestExecuteWritingReviewTaskPlanStagesWavesAndRetriesOnlyInvalidTask(t *testing.T) {
	// 够长以拆出多个正文块，这样第二波里有足够任务把并发上限跑满。
	paragraphs := make([]string, 60)
	for index := range paragraphs {
		paragraphs[index] = fmt.Sprintf("第 %02d 段：", index) + strings.Repeat("这是一段用于并发测试的正文。", 40)
	}
	content := strings.Join(paragraphs, "\n\n")
	plan, err := buildWritingReviewTaskPlan("A clear title", content)
	if err != nil {
		t.Fatal(err)
	}
	if countWritingReviewTasks(plan, agentReviewTaskDocument) != 1 {
		t.Fatalf("plan must contain exactly one whole-document task: %+v", plan.Tasks)
	}
	if countWritingReviewTasks(plan, agentReviewTaskBody) < 2 {
		t.Fatalf("test document did not split into enough body chunks: %+v", plan.Tasks)
	}

	var inFlight atomic.Int32
	var maximumInFlight atomic.Int32
	var titleRequests atomic.Int32
	var bodyRequests atomic.Int32
	var documentRequests atomic.Int32
	var layoutRequests atomic.Int32
	var totalRequests atomic.Int32
	var diagnosisDone atomic.Bool
	var editWithoutFindings atomic.Int32
	ready := make(chan struct{})
	var readyOnce sync.Once
	providerServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		totalRequests.Add(1)
		var payload struct {
			Messages []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"messages"`
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Errorf("decode task payload: %v", err)
		}
		system, user := "", ""
		for _, message := range payload.Messages {
			if message.Role == "system" {
				system = message.Content
			}
			if message.Role == "user" {
				user = message.Content
			}
		}

		responseText := ""
		editWave := false
		switch {
		case strings.Contains(system, `"titleScore"`):
			titleRequests.Add(1)
			responseText = `{"summary":"The article is already focused.","titleScore":80,"titleAssessment":"The title is clear and supported.","titleSuggestions":[]}`
		case strings.Contains(system, "Other reviewers handle the title"):
			documentRequests.Add(1)
			editWave = true
			responseText = `{"bodySuggestions":[]}`
		case strings.Contains(system, `"bodySuggestions"`):
			editWave = true
			if bodyRequests.Add(1) == 1 {
				responseText = `{}` // 第一个正文任务先返回不合法响应，验证只重试它自己
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

		if editWave {
			if !diagnosisDone.Load() {
				t.Error("edit-wave task started before the diagnosis wave finished")
			}
			if !strings.Contains(user, "PRIOR_FINDINGS:") {
				editWithoutFindings.Add(1)
			}
			// 只有第二波参与并发计数：第一波只有标题和结构两个任务。
			current := inFlight.Add(1)
			defer inFlight.Add(-1)
			for {
				maximum := maximumInFlight.Load()
				if current <= maximum || maximumInFlight.CompareAndSwap(maximum, current) {
					break
				}
			}
			if current >= agentReviewTaskConcurrency {
				readyOnce.Do(func() { close(ready) })
			}
			select {
			case <-ready:
			case <-time.After(3 * time.Second):
				t.Error("edit-wave tasks did not overlap")
			}
		} else if titleRequests.Load() > 0 && layoutRequests.Load() > 0 {
			diagnosisDone.Store(true)
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{{"message": map[string]string{"content": responseText}, "finish_reason": "stop"}},
			"usage":   map[string]int{"prompt_tokens": 100, "completion_tokens": 20, "total_tokens": 120},
		})
	}))
	defer providerServer.Close()

	startedWaves := make([]int, 0, 2)
	result, review, err := executeWritingReviewTaskPlan(
		context.Background(), providerServer.Client(), agentLLMProvider{
			Mode: "byok", Protocol: "openai", BaseURL: providerServer.URL, APIKey: "test", Model: "test",
		}, plan, "A clear title", content, func(tasks []writingReviewTaskSpec) error {
			if len(tasks) == 0 {
				return errors.New("wave start received no tasks")
			}
			wave := tasks[0].Wave
			for _, task := range tasks[1:] {
				if task.Wave != wave {
					return fmt.Errorf("wave start mixed waves %d and %d", wave, task.Wave)
				}
			}
			startedWaves = append(startedWaves, wave)
			return nil
		}, nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(startedWaves) != 2 || startedWaves[0] != agentReviewWaveDiagnose || startedWaves[1] != agentReviewWaveEdit {
		t.Fatalf("wave starts=%v, want diagnose then edit", startedWaves)
	}
	if maximumInFlight.Load() != agentReviewTaskConcurrency {
		t.Fatalf("maximum concurrent edit tasks=%d, want %d", maximumInFlight.Load(), agentReviewTaskConcurrency)
	}
	if editWithoutFindings.Load() != 0 {
		t.Fatalf("%d edit-wave prompts arrived without the first-pass diagnosis", editWithoutFindings.Load())
	}
	if titleRequests.Load() != 1 || layoutRequests.Load() != 1 || documentRequests.Load() != 1 {
		t.Fatalf("request counts title=%d layout=%d document=%d",
			titleRequests.Load(), layoutRequests.Load(), documentRequests.Load())
	}
	// 只有第一个正文任务重试了一次，其余任务各跑一次。
	if want := int32(countWritingReviewTasks(plan, agentReviewTaskBody)) + 1; bodyRequests.Load() != want {
		t.Fatalf("body requests=%d, want %d", bodyRequests.Load(), want)
	}
	if result.TotalTokens != int(totalRequests.Load())*120 ||
		review.TitleScore != 80 || len(review.LayoutAssessment) != len(writingReviewDimensionIDs) {
		t.Fatalf("merged review result=%+v review=%+v requests=%d", result, review, totalRequests.Load())
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
