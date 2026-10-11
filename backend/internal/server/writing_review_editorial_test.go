package server

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"
)

func TestEditorialParagraphPlanCoversBodyWithSharedBudget(t *testing.T) {
	paragraphs := make([]string, 80)
	for i := range paragraphs {
		paragraphs[i] = fmt.Sprintf("第%d段：", i) + strings.Repeat("文章中的具体观察。", 100)
	}
	content := strings.Join(paragraphs, "\n\n")
	for _, selected := range [][]string{{"paragraph"}, {"proofread"}, {"paragraph", "proofread"}} {
		t.Run(strings.Join(selected, "+"), func(t *testing.T) {
			plan, err := buildWritingReviewTaskPlan("标题", content, selected...)
			if err != nil {
				t.Fatal(err)
			}
			wantDocument := 0
			if containsWritingReviewTask(selected, "paragraph") {
				wantDocument = 1
			}
			chunks := splitWritingReviewBodyBlocks(parseMarkdownReviewBlocks(content))
			if len(plan.Tasks) != len(chunks)+wantDocument {
				t.Fatalf("calls=%d, want %d chunks + %d document", len(plan.Tasks), len(chunks), wantDocument)
			}
			budget, covered := 0, strings.Builder{}
			for _, task := range plan.Tasks {
				if task.Stage != agentReviewTaskBody {
					continue
				}
				input := editorialChunkInputForTest(t, task)
				for _, block := range input.Blocks {
					covered.WriteString(block.Source)
				}
				if strings.Contains(task.Prompt.System, "Koinote's line editor") != (wantDocument == 1) {
					t.Fatal("paragraph selection did not select the line editor")
				}
				schema := task.Prompt.Schema["properties"].(map[string]any)["bodySuggestions"].(map[string]any)
				budget += schema["maxItems"].(int)
				item := schema["items"].(map[string]any)
				sources := item["properties"].(map[string]any)["sourceTask"].(map[string]any)["enum"].([]string)
				if len(sources) != len(selected) {
					t.Fatalf("allowed sources=%v, selected=%v", sources, selected)
				}
				for _, source := range sources {
					if !containsWritingReviewTask(selected, source) {
						t.Fatalf("unexpected source %s", source)
					}
				}
			}
			if budget != agentReviewMaxBodySuggestions || covered.String() != strings.Join(paragraphs, "") {
				t.Fatalf("body coverage or shared candidate budget changed: budget=%d", budget)
			}
		})
	}
}

type editorialChunkInput struct {
	Blocks         []markdownReviewBlock `json:"blocks"`
	ReadOnlyBefore string                `json:"readOnlyBefore"`
	ReadOnlyAfter  string                `json:"readOnlyAfter"`
}

func editorialChunkInputForTest(t *testing.T, task writingReviewTaskSpec) editorialChunkInput {
	t.Helper()
	_, encoded, found := strings.Cut(task.Prompt.User, "DOCUMENT_CHUNK:\n")
	if !found {
		t.Fatal("missing chunk input")
	}
	var input editorialChunkInput
	if err := json.Unmarshal([]byte(encoded), &input); err != nil {
		t.Fatal(err)
	}
	return input
}

func TestEditorialAdjacentContextIsReadOnly(t *testing.T) {
	content := strings.Repeat("前文🙂", 400) + "上文独有结尾。\n\n当前段落。\n\n下文独有开头。" + strings.Repeat("后文🙂", 400)
	blocks := parseMarkdownReviewBlocks(content)
	chunk := blocks[1:2]
	prompt, err := buildWritingReviewBodyPrompt("标题", content, nil, chunk, 1, 3, 3, []string{"paragraph"})
	if err != nil {
		t.Fatal(err)
	}
	task := writingReviewTaskSpec{Stage: agentReviewTaskBody, BodyTasks: []string{"paragraph"}, Prompt: prompt,
		AllowedBodyRange: writingReviewChunkRange(chunk), AllowedBodyBlockIDs: writingReviewChunkBlockIDs(chunk),
		AllowedBodyBlockRanges: writingReviewChunkBlockRanges(chunk)}
	input := editorialChunkInputForTest(t, task)
	if !strings.HasSuffix(input.ReadOnlyBefore, "上文独有结尾。\n\n") || !strings.HasPrefix(input.ReadOnlyAfter, "\n\n下文独有开头。") {
		t.Fatal("context did not retain the closest neighbors")
	}
	if !utf8.ValidString(input.ReadOnlyBefore+input.ReadOnlyAfter) || len(input.ReadOnlyBefore) > 1024 || len(input.ReadOnlyAfter) > 1024 {
		t.Fatal("neighbor context must be bounded UTF-8")
	}
	suggestions := []generatedBodySuggestion{}
	for _, before := range []string{"上文独有结尾。", "当前段落。", "下文独有开头。"} {
		suggestions = append(suggestions, generatedBodySuggestion{SourceTask: "paragraph", Category: "clarity", Before: before, After: before + "改。", Reason: "具体理由。"})
	}
	raw, _ := json.Marshal(map[string]any{"bodySuggestions": suggestions})
	_, validated, err := parseWritingReviewTaskResult(task, raw, "标题", content, blocks)
	if err != nil || len(validated.Suggestions) != 1 || validated.Suggestions[0].Before != "当前段落。" {
		t.Fatalf("neighbor edit escaped its scope: %+v, %v", validated, err)
	}
}

func TestEditorialDiagnosisQuotesMustBeVisibleAndUnique(t *testing.T) {
	content := "可见证据。隐藏后缀。\n\n未发送段落。\n\n重复。\n\n重复。"
	blocks := parseMarkdownReviewBlocks(content)
	first := blocks[0]
	task := writingReviewTaskSpec{Stage: agentReviewTaskDocument,
		AllowedBodyBlockIDs:    map[string]struct{}{first.ID: {}},
		AllowedBodyBlockRanges: map[string][]writingReviewByteRange{first.ID: {{Start: first.Start, End: first.Start + len("可见证据。")}}}}
	value := &writingReviewEditorialContext{ReaderGoal: "推测是初次接触该问题的读者", Voice: "保留第一人称观察"}
	for _, quote := range []string{"捏造引文", "重复。", "未发送段落。", "隐藏后缀。", "可见证据。", "可见证据。"} {
		value.Priorities = append(value.Priorities, writingReviewEditorialIssue{Goal: "retention", Quote: quote, Problem: "读者难以判断收益", Direction: "用已有细节说明收益"})
	}
	raw, _ := json.Marshal(map[string]any{"summary": "开头需要更具体。", "editorialContext": value, "bodySuggestions": []any{}})
	generated, _, err := parseWritingReviewTaskResult(task, raw, "标题", content, blocks)
	if err != nil {
		t.Fatal(err)
	}
	if generated.EditorialContext == nil || len(generated.EditorialContext.Priorities) != 1 || generated.EditorialContext.Priorities[0].Quote != "可见证据。" {
		t.Fatalf("ungrounded diagnostic forwarded: %+v", generated.EditorialContext)
	}
}

func TestEditorialMixedSourcesAndDiagnosisSurviveMerge(t *testing.T) {
	content := "开头只谈背景。\n\n正文有错字。"
	plan, err := buildWritingReviewTaskPlan("标题", content, "paragraph", "proofread")
	if err != nil {
		t.Fatal(err)
	}
	results := []writingReviewTaskResult{}
	for _, task := range plan.Tasks {
		payload := map[string]any{"bodySuggestions": []any{}}
		if task.Stage == agentReviewTaskDocument {
			payload["summary"] = "首段只谈背景，读者看不到本文回答什么。\n先交代实际问题，保留正文的具体案例。"
		} else {
			payload["bodySuggestions"] = []generatedBodySuggestion{
				{SourceTask: "paragraph", Category: "engagement", Before: "开头只谈背景。", After: "先说明读者的问题。", Reason: "开头需要让读者识别当前问题。"},
				// Same anchor, rejected duplicate: must not change the accepted source.
				{SourceTask: "proofread", Category: "clarity", Before: "开头只谈背景。", After: "第二个替换。", Reason: "重复锚点。"},
				{SourceTask: "structure", Category: "clarity", Before: "正文有错字。", After: "越权替换。", Reason: "未选择的任务。"},
				{SourceTask: "proofread", Category: "accuracy", Before: "正文有错字。", After: "正文无错字。", Reason: "修正错字。"},
			}
		}
		raw, _ := json.Marshal(payload)
		generated, validated, err := parseWritingReviewTaskResult(task, raw, "标题", content, parseMarkdownReviewBlocks(content))
		if err != nil {
			t.Fatal(err)
		}
		results = append(results, writingReviewTaskResult{Task: task, Generated: generated, Validated: validated})
	}
	// A later title result must not replace the fuller article diagnosis.
	results = append(results, writingReviewTaskResult{Task: writingReviewTaskSpec{Stage: agentReviewTaskTitle}, Generated: generatedWritingReview{Summary: "标题摘要", TitleScore: 90, TitleAssessment: "标题清楚"}})
	_, merged, err := mergeWritingReviewTaskResults(results, "标题", content, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(merged.Summary, "首段只谈背景") || len(merged.Suggestions) != 2 {
		t.Fatalf("lost editorial diagnosis or suggestions: %+v", merged)
	}
	wantSources := map[string]string{"开头只谈背景。": "paragraph", "正文有错字。": "proofread"}
	for _, suggestion := range merged.Suggestions {
		if suggestion.SourceTask != wantSources[suggestion.Before] {
			t.Fatalf("source classification lost: %+v", suggestion)
		}
	}
}

func TestEditorialHandoffPrefersDiagnosisWithinReservation(t *testing.T) {
	for _, text := range []string{strings.Repeat("具体观察", 200), strings.Repeat("<&\x00", 400)} {
		editorial := &writingReviewEditorialContext{ReaderGoal: text[:600], Voice: text[:600]}
		for i := 0; i < 3; i++ {
			editorial.Priorities = append(editorial.Priorities, writingReviewEditorialIssue{Goal: "clarity", Quote: text[:600], Problem: text[:480], Direction: text[:480]})
		}
		dimensions := placeholderWritingReviewDimensions()
		for i := range dimensions {
			dimensions[i].Summary = text
		}
		findings := writingReviewPriorFindingsJSON([]writingReviewTaskResult{
			{Task: writingReviewTaskSpec{Stage: agentReviewTaskTitle}, Validated: validatedWritingReview{Summary: text, TitleAssessment: text}},
			{Task: writingReviewTaskSpec{Stage: agentReviewTaskLayout}, Validated: validatedWritingReview{LayoutAssessment: dimensions}},
			{Task: writingReviewTaskSpec{Stage: agentReviewTaskDocument}, Generated: generatedWritingReview{EditorialContext: editorial}},
		})
		var decoded writingReviewPriorFindings
		if err := json.Unmarshal([]byte(findings), &decoded); err != nil {
			t.Fatal(err)
		}
		if len(findings) > agentReviewPriorFindingsBytes || len(findings)+len(writingReviewPriorFindingsPrefix) > agentReviewPriorFindingsTokens {
			t.Fatal("handoff exceeds context/credit reservation")
		}
		if decoded.EditorialContext == nil || (text[0] != '<' && len(decoded.EditorialContext.Priorities) != 3) {
			t.Fatal("ordinary bounded diagnosis was dropped")
		}
		if len(editorial.Priorities) != 3 {
			t.Fatal("handoff trimming mutated the original result")
		}
	}
}
