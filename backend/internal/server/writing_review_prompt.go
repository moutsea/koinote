package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"unicode/utf8"
)

const maxAgentPatchTextBytes = 128 << 10

type generatedWritingReview struct {
	Summary           string                      `json:"summary"`
	TitleScore        int                         `json:"titleScore"`
	TitleAssessment   string                      `json:"titleAssessment"`
	TitleSuggestions  []generatedTitleSuggestion  `json:"titleSuggestions"`
	BodySuggestions   []generatedBodySuggestion   `json:"bodySuggestions"`
	BodyPatches       []generatedBodySuggestion   `json:"bodyPatches"`
	LayoutAssessment  []writingReviewDimension    `json:"layoutAssessment"`
	LayoutSuggestions []generatedLayoutSuggestion `json:"layoutSuggestions"`
}

type generatedTitleSuggestion struct {
	After  string `json:"after"`
	Reason string `json:"reason"`
}

func (suggestion *generatedTitleSuggestion) UnmarshalJSON(data []byte) error {
	var title string
	if err := json.Unmarshal(data, &title); err == nil {
		suggestion.After = title
		suggestion.Reason = ""
		return nil
	}
	type titleSuggestion generatedTitleSuggestion
	var value titleSuggestion
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	*suggestion = generatedTitleSuggestion(value)
	return nil
}

type generatedBodySuggestion struct {
	Category   string `json:"category"`
	Before     string `json:"before"`
	After      string `json:"after"`
	Reason     string `json:"reason"`
	SourceTask string `json:"-"`
}

type generatedLayoutSuggestion struct {
	Category  string   `json:"category"`
	Operation string   `json:"operation"`
	BlockID   string   `json:"blockId"`
	AfterType string   `json:"afterType"`
	Segments  []string `json:"segments"`
	Reason    string   `json:"reason"`
}

type validatedWritingSuggestion struct {
	Target     string
	Kind       string
	Category   string
	SourceTask string
	Operation  string
	Before     string
	After      string
	Reason     string
	Start      int
	End        int
}

type validatedWritingReview struct {
	Summary          string
	HasTitleReview   bool
	HasLayoutReview  bool
	TitleScore       int
	TitleAssessment  string
	LayoutAssessment []writingReviewDimension
	Suggestions      []validatedWritingSuggestion
}

var writingSuggestionCategories = map[string]struct{}{
	"clarity":    {},
	"structure":  {},
	"engagement": {},
	"accuracy":   {},
	"style":      {},
	"conversion": {},
}

// writingReviewValidationScope 收拢一次校验需要的全部作用域约束。之前这些是
// 10 个位置参数，加一个字段就要改掉每个调用点，且 nil 与 nil 之间没有区分度。
type writingReviewValidationScope struct {
	// HasTitleReview / HasLayoutReview 表示本次计划里真的跑了对应的诊断任务。
	// 为 false 时对应的评分不写回，避免把占位值当成模型的结论。
	HasTitleReview  bool
	HasLayoutReview bool

	AllowedBodyCategories  map[string]struct{}
	AllowedBodyBlockIDs    map[string]struct{}
	AllowedBodyBlockRanges map[string][]writingReviewByteRange
	AllowedBodyRange       *writingReviewByteRange
	AllowedLayoutBlockIDs  map[string]struct{}

	DropRejectedSuggestions bool
	SourceTask              string

	// Blocks 是 content 的解析结果。传入可以省掉一次 goldmark 全文解析：
	// 同一份 content 在建计划、每个任务校验、重试、merge 里要走好几遍。
	Blocks []markdownReviewBlock
}

func (scope writingReviewValidationScope) blocks(content string) []markdownReviewBlock {
	if scope.Blocks != nil {
		return scope.Blocks
	}
	return parseMarkdownReviewBlocks(content)
}

func parseAndValidateWritingReviewWithScopes(
	raw []byte,
	title string,
	content string,
	scope writingReviewValidationScope,
) (validatedWritingReview, error) {
	hasTitleReview := scope.HasTitleReview
	allowedBodyCategories := scope.AllowedBodyCategories
	allowedBodyBlockIDs := scope.AllowedBodyBlockIDs
	allowedBodyBlockRanges := scope.AllowedBodyBlockRanges
	allowedBodyRange := scope.AllowedBodyRange
	allowedLayoutBlockIDs := scope.AllowedLayoutBlockIDs
	dropRejectedSuggestions := scope.DropRejectedSuggestions
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.DisallowUnknownFields()
	var generated generatedWritingReview
	if err := decoder.Decode(&generated); err != nil {
		return validatedWritingReview{}, fmt.Errorf("%w: decode review JSON: %v", errAgentLLMInvalidResponse, err)
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return validatedWritingReview{}, fmt.Errorf("%w: review contains trailing JSON", errAgentLLMInvalidResponse)
	}

	generated.Summary = strings.TrimSpace(generated.Summary)
	generated.TitleAssessment = strings.TrimSpace(generated.TitleAssessment)
	if (hasTitleReview && generated.Summary == "") || utf8.RuneCountInString(generated.Summary) > 2_000 {
		return validatedWritingReview{}, fmt.Errorf("%w: invalid review summary", errAgentLLMInvalidResponse)
	}
	if hasTitleReview {
		if generated.TitleScore < 0 || generated.TitleScore > 100 || generated.TitleAssessment == "" ||
			utf8.RuneCountInString(generated.TitleAssessment) > 2_000 {
			return validatedWritingReview{}, fmt.Errorf("%w: invalid title assessment", errAgentLLMInvalidResponse)
		}
	} else if len(generated.TitleSuggestions) > 0 {
		return validatedWritingReview{}, fmt.Errorf("%w: title suggestions are outside this review scope", errAgentLLMInvalidResponse)
	}
	if len(generated.BodySuggestions) > 0 && len(generated.BodyPatches) > 0 {
		return validatedWritingReview{}, fmt.Errorf("%w: review contains both bodySuggestions and bodyPatches", errAgentLLMInvalidResponse)
	}
	if len(generated.BodySuggestions) == 0 {
		generated.BodySuggestions = generated.BodyPatches
	}
	// 只限上限，不再因为"低分却给得太少"整任务作废。那条规则给模型留了一条捷径：
	// 打 60 分零备选永远安全，于是绝大多数文章都拿不到备选标题。
	if len(generated.TitleSuggestions) > 3 {
		return validatedWritingReview{}, fmt.Errorf("%w: too many title suggestions", errAgentLLMInvalidResponse)
	}
	if len(generated.BodySuggestions) > maxAgentBodySuggestions {
		return validatedWritingReview{}, fmt.Errorf("%w: too many body suggestions", errAgentLLMInvalidResponse)
	}
	if len(generated.LayoutSuggestions) > maxAgentLayoutSuggestions {
		return validatedWritingReview{}, fmt.Errorf("%w: too many layout suggestions", errAgentLLMInvalidResponse)
	}
	layoutAssessment, err := normalizeWritingReviewDimensions(generated.LayoutAssessment)
	if err != nil {
		return validatedWritingReview{}, err
	}
	// 本次计划没有结构任务时不能保留这六维。normalizeWritingReviewDimensions 要求
	// 六维齐全，所以占位值必须先造出来通过校验，但落库前要丢掉——否则用户只勾了
	// 「校对」，界面上却出现一张六项满分的能力图，还能据此发起一次付费的深入分析。
	if !scope.HasLayoutReview {
		layoutAssessment = make([]writingReviewDimension, 0)
	}

	validated := validatedWritingReview{
		Summary:          generated.Summary,
		HasTitleReview:   hasTitleReview,
		HasLayoutReview:  scope.HasLayoutReview,
		LayoutAssessment: layoutAssessment,
		Suggestions:      make([]validatedWritingSuggestion, 0, len(generated.TitleSuggestions)+len(generated.BodySuggestions)+len(generated.LayoutSuggestions)),
	}
	if hasTitleReview {
		validated.TitleScore = generated.TitleScore
		validated.TitleAssessment = generated.TitleAssessment
	}
	seenTitles := make(map[string]struct{}, len(generated.TitleSuggestions))
	for _, suggestion := range generated.TitleSuggestions {
		after := strings.TrimSpace(suggestion.After)
		reason := strings.TrimSpace(suggestion.Reason)
		if reason == "" {
			reason = generated.TitleAssessment
		}
		if after == "" || after == strings.TrimSpace(title) || strings.ContainsAny(after, "\r\n") || utf8.RuneCountInString(after) > maxTitleRunes ||
			reason == "" || utf8.RuneCountInString(reason) > 2_000 {
			return validatedWritingReview{}, fmt.Errorf("%w: invalid title suggestion", errAgentLLMInvalidResponse)
		}
		if _, exists := seenTitles[after]; exists {
			return validatedWritingReview{}, fmt.Errorf("%w: duplicate title suggestion", errAgentLLMInvalidResponse)
		}
		seenTitles[after] = struct{}{}
		validated.Suggestions = append(validated.Suggestions, validatedWritingSuggestion{
			Target:     "title",
			Kind:       "content",
			Category:   "title",
			SourceTask: "title",
			Before:     title,
			After:      after,
			Reason:     reason,
			Start:      -1,
			End:        -1,
		})
	}

	blocks := scope.blocks(content)
	bodyRanges := make([]validatedWritingSuggestion, 0, len(generated.BodySuggestions))
	seenBefore := make(map[string]struct{}, len(generated.BodySuggestions))
	for _, suggestion := range generated.BodySuggestions {
		category := strings.ToLower(strings.TrimSpace(suggestion.Category))
		reason := strings.TrimSpace(suggestion.Reason)
		_, defaultCategory := writingSuggestionCategories[category]
		_, focusedCategory := allowedBodyCategories[category]
		if (allowedBodyCategories == nil && !defaultCategory) ||
			(allowedBodyCategories != nil && !focusedCategory) {
			if dropRejectedSuggestions {
				continue
			}
			return validatedWritingReview{}, fmt.Errorf("%w: invalid body suggestion category", errAgentLLMInvalidResponse)
		}
		if suggestion.Before == "" || suggestion.Before == suggestion.After ||
			len(suggestion.Before) > maxAgentPatchTextBytes || len(suggestion.After) > maxAgentPatchTextBytes ||
			reason == "" ||
			utf8.RuneCountInString(reason) > 2_000 {
			if dropRejectedSuggestions {
				continue
			}
			return validatedWritingReview{}, fmt.Errorf("%w: invalid body suggestion", errAgentLLMInvalidResponse)
		}
		if _, exists := seenBefore[suggestion.Before]; exists || countOverlappingOccurrences(content, suggestion.Before) != 1 {
			if dropRejectedSuggestions {
				continue
			}
			return validatedWritingReview{}, fmt.Errorf("%w: body anchor is not exact and unique", errAgentLLMInvalidResponse)
		}
		start := strings.Index(content, suggestion.Before)
		end := start + len(suggestion.Before)
		if !allowedBodyRange.contains(start, end) ||
			!writingSuggestionRangeAllowedByBlocks(
				start, end, blocks, allowedBodyBlockIDs, allowedBodyBlockRanges,
			) {
			if dropRejectedSuggestions {
				continue
			}
			return validatedWritingReview{}, fmt.Errorf("%w: body suggestion uses content outside its prompt scope", errAgentLLMInvalidResponse)
		}
		seenBefore[suggestion.Before] = struct{}{}
		sourceTask := scope.SourceTask
		if suggestion.SourceTask != "" {
			sourceTask = suggestion.SourceTask
		}
		bodyRanges = append(bodyRanges, validatedWritingSuggestion{
			Target:     "body",
			Kind:       "content",
			Category:   category,
			SourceTask: sourceTask,
			Before:     suggestion.Before,
			After:      suggestion.After,
			Reason:     reason,
			Start:      start,
			End:        end,
		})
	}
	// 输入顺序即优先级：全文级建议由 merge 排在最前，重叠时保它、丢掉后面的局部润色。
	acceptedBody := make([]validatedWritingSuggestion, 0, len(bodyRanges))
	for _, candidate := range bodyRanges {
		if writingSuggestionOverlapsAny(candidate, acceptedBody) {
			if dropRejectedSuggestions {
				continue
			}
			return validatedWritingReview{}, fmt.Errorf("%w: body suggestions overlap", errAgentLLMInvalidResponse)
		}
		acceptedBody = append(acceptedBody, candidate)
	}
	bodyRanges = acceptedBody
	sort.Slice(bodyRanges, func(i, j int) bool { return bodyRanges[i].Start < bodyRanges[j].Start })
	layoutRanges := make([]validatedWritingSuggestion, 0, len(generated.LayoutSuggestions))
	blockByID := make(map[string]markdownReviewBlock, len(blocks))
	for _, block := range blocks {
		blockByID[block.ID] = block
	}
	seenLayoutBlocks := make(map[string]struct{}, len(generated.LayoutSuggestions))
	for _, suggestion := range generated.LayoutSuggestions {
		suggestion.Category = strings.ToLower(strings.TrimSpace(suggestion.Category))
		suggestion.Operation = strings.ToLower(strings.TrimSpace(suggestion.Operation))
		suggestion.BlockID = strings.TrimSpace(suggestion.BlockID)
		suggestion.AfterType = strings.ToLower(strings.TrimSpace(suggestion.AfterType))
		suggestion.Reason = strings.TrimSpace(suggestion.Reason)
		if !writingReviewDimensionExists(suggestion.Category) || suggestion.Reason == "" ||
			utf8.RuneCountInString(suggestion.Reason) > 2_000 {
			continue
		}
		if allowedLayoutBlockIDs != nil {
			if _, allowed := allowedLayoutBlockIDs[suggestion.BlockID]; !allowed {
				continue
			}
		}
		if suggestion.Operation == "change_block_type" {
			if suggestion.AfterType == "" || len(suggestion.Segments) != 0 {
				continue
			}
		} else if suggestion.AfterType != "" {
			continue
		}
		block, exists := blockByID[suggestion.BlockID]
		if !exists || !block.Editable {
			continue
		}
		if _, duplicate := seenLayoutBlocks[block.ID]; duplicate {
			continue
		}
		if countOverlappingOccurrences(content, block.Source) != 1 {
			continue
		}
		after, err := markdownLayoutReplacement(block, suggestion)
		if err != nil {
			if errors.Is(err, errAgentLLMInvalidResponse) {
				continue
			}
			return validatedWritingReview{}, err
		}
		if after == block.Source || len(after) > maxAgentPatchTextBytes {
			continue
		}
		candidate := validatedWritingSuggestion{
			Target:     "body",
			Kind:       "layout",
			Category:   suggestion.Category,
			SourceTask: scope.SourceTask,
			Operation:  suggestion.Operation,
			Before:     block.Source,
			After:      after,
			Reason:     suggestion.Reason,
			Start:      block.Start,
			End:        block.End,
		}
		if writingSuggestionOverlapsAny(candidate, bodyRanges) || writingSuggestionOverlapsAny(candidate, layoutRanges) {
			continue
		}
		seenLayoutBlocks[block.ID] = struct{}{}
		layoutRanges = append(layoutRanges, candidate)
	}

	finalContentBytes := len(content)
	boundedBodyRanges := make([]validatedWritingSuggestion, 0, len(bodyRanges))
	for _, suggestion := range bodyRanges {
		nextContentBytes := finalContentBytes + len(suggestion.After) - len(suggestion.Before)
		if nextContentBytes > maxContentBytes {
			if dropRejectedSuggestions {
				continue
			}
			return validatedWritingReview{}, fmt.Errorf("%w: body suggestions exceed document size limit", errAgentLLMInvalidResponse)
		}
		finalContentBytes = nextContentBytes
		boundedBodyRanges = append(boundedBodyRanges, suggestion)
	}
	boundedLayoutRanges := make([]validatedWritingSuggestion, 0, len(layoutRanges))
	for _, suggestion := range layoutRanges {
		nextContentBytes := finalContentBytes + len(suggestion.After) - len(suggestion.Before)
		if nextContentBytes > maxContentBytes {
			if dropRejectedSuggestions {
				continue
			}
			return validatedWritingReview{}, fmt.Errorf("%w: layout suggestions exceed document size limit", errAgentLLMInvalidResponse)
		}
		finalContentBytes = nextContentBytes
		boundedLayoutRanges = append(boundedLayoutRanges, suggestion)
	}
	validated.Suggestions = append(validated.Suggestions, boundedBodyRanges...)
	validated.Suggestions = append(validated.Suggestions, boundedLayoutRanges...)
	return validated, nil
}

func writingSuggestionRangeAllowedByBlocks(
	start int,
	end int,
	blocks []markdownReviewBlock,
	allowedBlockIDs map[string]struct{},
	allowedBlockRanges map[string][]writingReviewByteRange,
) bool {
	if allowedBlockIDs == nil && allowedBlockRanges == nil {
		return true
	}
	overlapped := false
	for _, block := range blocks {
		if start >= block.End || block.Start >= end {
			continue
		}
		overlapped = true
		if allowedBlockIDs != nil {
			if _, allowed := allowedBlockIDs[block.ID]; !allowed {
				return false
			}
		}
		if allowedBlockRanges == nil {
			continue
		}
		overlapStart := max(start, block.Start)
		overlapEnd := min(end, block.End)
		covered := false
		for _, allowedRange := range allowedBlockRanges[block.ID] {
			if allowedRange.contains(overlapStart, overlapEnd) {
				covered = true
				break
			}
		}
		if !covered {
			return false
		}
	}
	if !overlapped {
		return false
	}
	if allowedBlockRanges == nil {
		return true
	}
	return writingReviewRangesCover(start, end, allowedBlockRanges)
}

func writingReviewRangesCover(
	start int,
	end int,
	allowed map[string][]writingReviewByteRange,
) bool {
	if start < 0 || end <= start {
		return false
	}
	cursor := start
	for cursor < end {
		next := cursor
		for _, ranges := range allowed {
			for _, value := range ranges {
				if value.Start <= cursor && value.End > next {
					next = value.End
				}
			}
		}
		if next == cursor {
			return false
		}
		cursor = next
	}
	return true
}

func writingSuggestionOverlapsAny(candidate validatedWritingSuggestion, values []validatedWritingSuggestion) bool {
	for _, value := range values {
		if candidate.Start < value.End && value.Start < candidate.End {
			return true
		}
	}
	return false
}

// strings.Count intentionally ignores overlapping matches. A short anchor such
// as "aa" in "aaa" therefore needs an explicit overlap-aware count: applying
// it at the first match would otherwise make the model's location ambiguous.
func countOverlappingOccurrences(content, needle string) int {
	if needle == "" {
		return 0
	}
	count := 0
	for offset := 0; offset <= len(content)-len(needle); {
		index := strings.Index(content[offset:], needle)
		if index < 0 {
			break
		}
		count++
		offset += index + 1
	}
	return count
}

func requireAgentLLMUsage(provider agentLLMProvider, result agentLLMResult) error {
	if result.InputTokens < 0 || result.OutputTokens < 0 || result.TotalTokens < 0 {
		return errAgentLLMUsageInvalid
	}
	if result.InputTokens == 0 && result.OutputTokens == 0 && result.TotalTokens == 0 {
		if provider.Mode == "builtin" {
			return errAgentLLMUsageMissing
		}
		return nil
	}
	maxInt := int(^uint(0) >> 1)
	if result.InputTokens > maxInt-result.OutputTokens ||
		result.TotalTokens <= 0 || result.TotalTokens != result.InputTokens+result.OutputTokens {
		return errAgentLLMUsageInvalid
	}
	return nil
}
