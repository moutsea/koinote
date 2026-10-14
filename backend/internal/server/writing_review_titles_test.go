package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"unicode/utf8"

	"koinote/backend/internal/config"
)

func TestTitleReviewReadsMiddleAndNonParagraphEvidence(t *testing.T) {
	content := strings.Repeat("开头背景。", 600) + "\n\n## 结果\n\n中间实验的耗时从 45 分钟降到 12 分钟。\n\n- 列表案例：保持原有质量。\n\n| 对比 | 结果 |\n|---|---|\n| 表格案例 | 12 分钟 |\n\n> 引文案例：仍需人工复核。\n\n" + strings.Repeat("结尾说明。", 600)
	plan, err := buildWritingReviewTaskPlan("我的实验", content, "title")
	if err != nil || len(plan.Tasks) != 1 {
		t.Fatalf("title-only review should use one call: %v", err)
	}
	var input struct {
		Sources        []writingReviewTitleSource `json:"sources"`
		SourceCoverage string                     `json:"sourceCoverage"`
	}
	_, encoded, _ := strings.Cut(plan.Tasks[0].Prompt.User, "DOCUMENT_CONTEXT:\n")
	if err := json.Unmarshal([]byte(encoded), &input); err != nil {
		t.Fatal(err)
	}
	blocks := parseMarkdownReviewBlocks(content)
	if input.SourceCoverage != "complete" || len(input.Sources) != len(blocks) {
		t.Fatalf("ordinary article must retain every block: %+v", input)
	}
	for i, block := range blocks {
		if input.Sources[i].Source != block.Source || input.Sources[i].Partial {
			t.Fatalf("block %s lost its evidence", block.ID)
		}
	}
	for _, quote := range []string{"中间实验的耗时从 45 分钟降到 12 分钟。", "列表案例：保持原有质量。", "表格案例", "引文案例：仍需人工复核。"} {
		candidate := titleCandidateForTest(quote)
		if accepted, dropped := validateWritingReviewTitleCandidates([]generatedTitleCandidate{candidate}, "我的实验", blocks); len(accepted) != 1 || dropped != 0 {
			t.Fatalf("visible middle/list/table/quote rejected: %s", quote)
		}
	}
}

func TestTitleReviewSamplingIsBoundedAndDistributed(t *testing.T) {
	source := "开头标记" + strings.Repeat("甲🙂", 10_000) + "中间标记" + strings.Repeat("乙🙂", 10_000) + "结尾标记"
	for _, count := range []int{0, 1, 12, 256, 2000} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			blocks := make([]markdownReviewBlock, count)
			for i := range blocks {
				blocks[i] = markdownReviewBlock{ID: fmt.Sprintf("block-%d", i), Kind: "paragraph", Source: source}
			}
			sources, sampled := writingReviewTitleSources(blocks)
			if sampled != (count > 0) {
				t.Fatal("source coverage misreported")
			}
			bytes := 0
			for _, source := range sources {
				bytes += len(source.Source)
				if !utf8.ValidString(source.Source) || !source.Partial {
					t.Fatal("partial source must remain valid UTF-8 and be identified")
				}
			}
			encoded, _ := json.Marshal(sources)
			if bytes > agentReviewTitleSourceBytes || len(sources) > 3*agentReviewTitleBlockLimit || len(encoded) > 160<<10 {
				t.Fatalf("unbounded context: source=%d JSON=%d excerpts=%d", bytes, len(encoded), len(sources))
			}
			if count > 0 && (!strings.Contains(sources[0].Source, "开头标记") || !strings.Contains(sources[len(sources)-1].Source, "结尾标记")) {
				t.Fatal("sampling lost the ends of the article")
			}
			if count == 1 && !strings.Contains(sources[1].Source, "中间标记") {
				t.Fatal("a single long paragraph lost its middle")
			}
		})
	}
}

func titleCandidateForTest(quote string) generatedTitleCandidate {
	return generatedTitleCandidate{After: "从 45 分钟到 12 分钟：一次工作流实验", Angle: "具体的实验结果", Reason: "让正在压缩处理时间的读者看到实验价值。", Comparison: "比原标题更具体；强调单次结果，保留适用条件。", Evidence: []string{quote}}
}

func TestTitleReviewValidatesEvidenceAndComparisonAtEveryScore(t *testing.T) {
	const content = "中间实验的耗时从 45 分钟降到 12 分钟。"
	blocks := parseMarkdownReviewBlocks(content)
	plan, err := buildWritingReviewTaskPlan("我的实验", content, "title")
	if err != nil {
		t.Fatal(err)
	}
	for _, score := range []int{45, 70, 85, 95, 100} {
		candidate := titleCandidateForTest(content)
		raw, _ := json.Marshal(generatedTitleReview{Summary: "用实测结果吸引相关读者。", TitleScore: score, TitleAssessment: "原标题保留个人语气，但没有呈现实测结果。", TitleSuggestions: []generatedTitleCandidate{candidate}})
		generated, validated, err := parseWritingReviewTaskResult(plan.Tasks[0], raw, "我的实验", content, blocks)
		if err != nil || len(validated.Suggestions) != 1 || validated.TitleScore != score {
			t.Fatalf("score %d blocked a supported alternative: %v", score, err)
		}
		if !strings.Contains(validated.Suggestions[0].Reason, candidate.Comparison) || !strings.Contains(validated.Suggestions[0].Reason, content) {
			t.Fatal("existing UI contract lost comparison or evidence")
		}
		_, merged, err := mergeWritingReviewTaskResults([]writingReviewTaskResult{{Task: plan.Tasks[0], Generated: generated, Validated: validated}}, "我的实验", content, blocks)
		if err != nil || len(merged.Suggestions) != 1 || merged.Suggestions[0].Reason != validated.Suggestions[0].Reason {
			t.Fatalf("title evidence did not survive result merge: %v", err)
		}
	}
	for _, test := range []struct {
		name   string
		change func(*generatedTitleCandidate)
	}{
		{"invented quote", func(c *generatedTitleCandidate) { c.Evidence = []string{"效率提高了十倍。"} }},
		{"missing evidence", func(c *generatedTitleCandidate) { c.Evidence = nil }},
		{"duplicate evidence", func(c *generatedTitleCandidate) { c.Evidence = []string{content, content} }},
		{"missing comparison", func(c *generatedTitleCandidate) { c.Comparison = " " }},
		{"missing angle", func(c *generatedTitleCandidate) { c.Angle = "" }},
		{"oversized reason", func(c *generatedTitleCandidate) { c.Reason = strings.Repeat("字", 401) }},
		{"empty title", func(c *generatedTitleCandidate) { c.After = " " }},
		{"unchanged title", func(c *generatedTitleCandidate) { c.After = " 我的实验 " }},
		{"multiline title", func(c *generatedTitleCandidate) { c.After = "第一行\n第二行" }},
		{"oversized title", func(c *generatedTitleCandidate) { c.After = strings.Repeat("字", maxTitleRunes+1) }},
	} {
		t.Run(test.name, func(t *testing.T) {
			candidate := titleCandidateForTest(content)
			test.change(&candidate)
			valid := titleCandidateForTest(content)
			accepted, dropped := validateWritingReviewTitleCandidates([]generatedTitleCandidate{candidate, valid}, "我的实验", blocks)
			if len(accepted) != 1 || accepted[0].After != valid.After || dropped != 1 {
				t.Fatalf("bad candidate must not discard or shadow its valid sibling: accepted=%+v dropped=%d", accepted, dropped)
			}
		})
	}
}

func TestTitleReviewKeepsDistinctCandidatesWithinLimit(t *testing.T) {
	const content = "中间实验的耗时从 45 分钟降到 12 分钟。"
	first := titleCandidateForTest(content)
	first.Angle = "Reader value"
	duplicateAngle := first
	duplicateAngle.After = "另一个标题"
	duplicateAngle.Angle = " reader   VALUE "
	duplicateTitle := first
	duplicateTitle.Angle = "另一个角度"
	candidates := []generatedTitleCandidate{first, duplicateAngle, duplicateTitle}
	for i := 2; i <= 4; i++ {
		candidate := titleCandidateForTest(content)
		candidate.After = fmt.Sprintf("标题 %d", i)
		candidate.Angle = fmt.Sprintf("角度 %d", i)
		candidates = append(candidates, candidate)
	}
	accepted, dropped := validateWritingReviewTitleCandidates(candidates, "我的实验", parseMarkdownReviewBlocks(content))
	if len(accepted) != 3 || dropped != 3 || accepted[0].After != first.After || accepted[1].After != "标题 2" || accepted[2].After != "标题 3" {
		t.Fatalf("duplicates must not use a slot, and extra valid candidates must not abort: accepted=%+v dropped=%d", accepted, dropped)
	}
}

func TestTitleReviewRejectsEvidenceFromOmittedText(t *testing.T) {
	content := strings.Repeat("甲", 20_000) + "未送出的重要数字。" + strings.Repeat("乙", 60_000)
	blocks := parseMarkdownReviewBlocks(content)
	sources, sampled := writingReviewTitleSources(blocks)
	if !sampled {
		t.Fatal("expected sampling")
	}
	for _, source := range sources {
		if strings.Contains(source.Source, "未送出的重要数字。") {
			t.Fatal("test setup must place evidence in omitted text")
		}
	}
	accepted, dropped := validateWritingReviewTitleCandidates([]generatedTitleCandidate{titleCandidateForTest("未送出的重要数字。")}, "我的实验", blocks)
	if len(accepted) != 0 || dropped != 1 {
		t.Fatalf("unseen source became title evidence: %+v", accepted)
	}
}

func TestTitleReviewDropsMalformedItemsButKeepsEnvelopeValidation(t *testing.T) {
	const title = "我的实验"
	const content = "中间实验的耗时从 45 分钟降到 12 分钟。"
	plan, err := buildWritingReviewTaskPlan(title, content, "title")
	if err != nil {
		t.Fatal(err)
	}
	valid, _ := json.Marshal(titleCandidateForTest(content))
	for _, invalid := range []string{
		`null`, `"a title"`, `42`, `[]`, `{}`, `{"after":42}`,
		strings.Replace(string(valid), `"evidence":[`, `"unknown":true,"evidence":[`, 1),
		strings.Replace(string(valid), `"evidence":["`+content+`"]`, `"evidence":"`+content+`"`, 1),
	} {
		t.Run(invalid, func(t *testing.T) {
			raw := []byte(fmt.Sprintf(`{"summary":"实验结果值得呈现。","titleScore":90,"titleAssessment":"原标题仍有改进空间。","titleSuggestions":[%s,%s]}`, invalid, valid))
			generated, validated, err := parseWritingReviewTaskResult(plan.Tasks[0], raw, title, content, nil)
			if err != nil || len(validated.Suggestions) != 1 || validated.DroppedTitleSuggestions != 1 {
				t.Fatalf("malformed item aborted or contaminated the title task: %+v, %v", validated, err)
			}
			_, merged, err := mergeWritingReviewTaskResults([]writingReviewTaskResult{{Task: plan.Tasks[0], Generated: generated, Validated: validated}}, title, content, nil)
			if err != nil || len(merged.Suggestions) != 1 {
				t.Fatalf("merge reintroduced a rejected item: %+v, %v", merged, err)
			}
		})
	}
	for _, invalid := range []string{
		`{`,
		`{"summary":"ok","titleScore":101,"titleAssessment":"ok","titleSuggestions":[]}`,
		`{"summary":"ok","titleScore":90,"titleAssessment":"","titleSuggestions":[]}`,
		`{"summary":"ok","titleScore":90,"titleAssessment":"ok","titleSuggestions":{}}`,
		`{"summary":"ok","titleScore":90,"titleAssessment":"ok","titleSuggestions":[],"unknown":true}`,
	} {
		if _, _, err := parseWritingReviewTaskResult(plan.Tasks[0], []byte(invalid), title, content, nil); !errors.Is(err, errAgentLLMInvalidResponse) {
			t.Fatalf("invalid task envelope accepted: %s: %v", invalid, err)
		}
	}
}

// Exercise the API, both review waves, final merge, accounting and persisted
// results: a rejected title candidate must not cause failAgentReview to erase
// valid suggestions or stop the later body review from running.
func TestTitleReviewBadCandidatesDoNotFailWholeReview(t *testing.T) {
	const bodyBefore = "The first paragraph is too long."
	for _, test := range []struct {
		name       string
		keepValid  bool
		retryJSON  bool
		wantTitles int
	}{
		{name: "mixed candidates", keepValid: true, wantTitles: 1},
		{name: "all candidates rejected"},
		{name: "invalid JSON then mixed candidates", keepValid: true, retryJSON: true, wantTitles: 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			var titleCalls, bodyCalls, layoutCalls atomic.Int32
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var payload struct {
					Messages []struct {
						Role    string `json:"role"`
						Content string `json:"content"`
					} `json:"messages"`
					ResponseFormat json.RawMessage `json:"response_format"`
				}
				if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
					t.Error(err)
					http.Error(w, "invalid request", http.StatusBadRequest)
					return
				}
				system, user := string(payload.ResponseFormat), ""
				for _, message := range payload.Messages {
					if message.Role == "system" {
						system += message.Content
					} else if message.Role == "user" {
						user = message.Content
					}
				}
				responseText := agentReviewTaskJSONForTest(system, "Ordinary title", bodyBefore)
				switch {
				case strings.Contains(system, `"titleScore"`):
					call := titleCalls.Add(1)
					if !strings.Contains(user, bodyBefore) {
						t.Error("title task lost source evidence")
					}
					if test.retryJSON && call == 1 {
						responseText = "{"
					} else {
						invalid := titleCandidateForTest("A fabricated source quote.")
						candidates := []generatedTitleCandidate{invalid}
						if test.keepValid {
							candidates = append(candidates, titleCandidateForTest(bodyBefore))
						}
						raw, _ := json.Marshal(generatedTitleReview{Summary: "Keep the concrete observations.", TitleScore: 90,
							TitleAssessment: "The original title could be more specific.", TitleSuggestions: candidates})
						responseText = string(raw)
					}
				case strings.Contains(system, `"bodySuggestions"`):
					bodyCalls.Add(1)
				case strings.Contains(system, `"layoutAssessment"`):
					layoutCalls.Add(1)
				default:
					t.Error("unknown review task")
				}
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{
					"choices": []any{map[string]any{"message": map[string]string{"content": responseText}, "finish_reason": "stop"}},
					"usage":   map[string]int{"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150},
				})
			}))
			defer provider.Close()
			app, pool, user, document := newAgentReviewCreateTest(t, config.Config{
				SessionSecret: "title-filter-test", AgentLLMProtocol: "openai", AgentLLMBaseURL: provider.URL,
				AgentLLMAPIKey: "test-only", AgentLLMModel: "test-model",
			})
			app.agentLLMHTTPClient = provider.Client()
			grantCreditsForTest(t, pool, user.ID, 100, "title-filter-test")
			response := requestAgentReviewCreate(t, app, user, document.DocID, `{"providerMode":"builtin"}`)
			if response.Code != http.StatusAccepted {
				t.Fatalf("create status=%d: %s", response.Code, response.Body.String())
			}
			initial := decodeAgentReviewResponse(t, response)
			review := waitForAgentReviewStatus(t, app, user.ID, initial.ReviewID, "ready")
			wantTitleCalls := int32(1)
			if test.retryJSON {
				wantTitleCalls++
			}
			if titleCalls.Load() != wantTitleCalls || bodyCalls.Load() != 2 || layoutCalls.Load() != 1 {
				t.Fatalf("unexpected retries or cancelled tasks: title=%d body=%d layout=%d", titleCalls.Load(), bodyCalls.Load(), layoutCalls.Load())
			}
			if review.TotalTokens != int(wantTitleCalls+3)*150 || review.TaskProgress.CompletedTasks != 4 || review.TaskProgress.TotalTasks != 4 {
				t.Fatalf("review lost usage or task completion: %+v", review)
			}
			titles, bodies := 0, 0
			for _, suggestion := range review.Suggestions {
				if strings.Contains(suggestion.Reason, "fabricated") {
					t.Fatal("bad title persisted")
				}
				switch suggestion.Target {
				case "title":
					titles++
				case "body":
					bodies++
				}
			}
			if titles != test.wantTitles || bodies != 1 || len(review.LayoutAssessment) != len(writingReviewDimensionIDs) || review.TitleScore == nil || *review.TitleScore != 90 {
				t.Fatalf("valid suggestions or assessments were lost: %+v", review)
			}
			balance, err := app.loadCreditBalance(context.Background(), user.ID)
			if err != nil || balance.Reserved != 0 || balance.Balance != 100-int64(review.CreditsCharged) {
				t.Fatalf("review did not settle credits: %+v, %v", balance, err)
			}
		})
	}
}
