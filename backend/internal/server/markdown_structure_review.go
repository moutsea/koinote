package server

import (
	"bytes"
	"fmt"
	"regexp"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/text"
)

const maxAgentLayoutSuggestions = 12

var (
	markdownSetextUnderlinePattern = regexp.MustCompile(`^[ \t]{0,3}(?:=+|-+)[ \t]*\r?$`)
	markdownATXHeadingPattern      = regexp.MustCompile(`^[ \t]{0,3}#{1,6}(?:[ \t]|$)`)
	markdownThematicBreakPattern   = regexp.MustCompile(`^[ \t]{0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})\r?$`)
	writingReviewDimensionIDs      = []string{"hierarchy", "readability", "emphasis", "rhythm", "modules", "mobile"}
)

type writingReviewDimension struct {
	ID      string `json:"id"`
	Label   string `json:"label"`
	Score   int    `json:"score"`
	Summary string `json:"summary"`
}

type markdownReviewBlock struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`
	Level    int    `json:"level,omitempty"`
	Source   string `json:"source"`
	Editable bool   `json:"editable"`
	Start    int    `json:"-"`
	End      int    `json:"-"`
	Text     string `json:"-"`
	NextKind string `json:"-"`
	GapAfter string `json:"-"`
}

func parseMarkdownReviewBlocks(content string) []markdownReviewBlock {
	source := []byte(content)
	document := goldmark.DefaultParser().Parse(text.NewReader(source))
	blocks := make([]markdownReviewBlock, 0, document.ChildCount())
	searchStart := 0
	for node := document.FirstChild(); node != nil; node = node.NextSibling() {
		start, end, ok := markdownNodeSourceRange(source, node)
		kind := markdownReviewNodeKind(node)
		if !ok && kind == "divider" {
			start, end, ok = findMarkdownThematicBreak(source, searchStart)
		}
		if !ok || start >= end {
			continue
		}
		block := markdownReviewBlock{
			ID:       fmt.Sprintf("block-%d", len(blocks)+1),
			Kind:     kind,
			Source:   string(source[start:end]),
			Editable: kind == "paragraph" || kind == "heading",
			Start:    start,
			End:      end,
		}
		if heading, ok := node.(*ast.Heading); ok {
			block.Level = heading.Level
			block.Text = string(heading.Lines().Value(source))
			if !markdownATXHeadingPattern.Match(source[start:end]) {
				if nextEnd := markdownSetextHeadingEnd(source, end); nextEnd > end {
					block.End = nextEnd
					block.Source = string(source[start:nextEnd])
				}
			}
		} else {
			block.Text = block.Source
		}
		blocks = append(blocks, block)
		searchStart = block.End
	}
	for index := range blocks {
		if index+1 < len(blocks) {
			blocks[index].NextKind = blocks[index+1].Kind
			if blocks[index].End <= blocks[index+1].Start {
				blocks[index].GapAfter = string(source[blocks[index].End:blocks[index+1].Start])
			}
		}
	}
	return blocks
}

func findMarkdownThematicBreak(source []byte, searchStart int) (int, int, bool) {
	cursor := min(max(searchStart, 0), len(source))
	if cursor > 0 && cursor < len(source) && source[cursor] == '\n' {
		cursor++
	}
	for cursor < len(source) {
		end := markdownLineEnd(source, cursor)
		if markdownThematicBreakPattern.Match(source[cursor:end]) {
			return cursor, end, true
		}
		if end >= len(source) {
			break
		}
		cursor = end + 1
	}
	return 0, 0, false
}

func markdownReviewNodeKind(node ast.Node) string {
	switch node.Kind() {
	case ast.KindHeading:
		return "heading"
	case ast.KindParagraph:
		return "paragraph"
	case ast.KindList:
		return "list"
	case ast.KindBlockquote:
		return "blockquote"
	case ast.KindFencedCodeBlock, ast.KindCodeBlock:
		return "code"
	case ast.KindThematicBreak:
		return "divider"
	case ast.KindHTMLBlock:
		return "html"
	default:
		return "other"
	}
}

func markdownNodeSourceRange(source []byte, node ast.Node) (int, int, bool) {
	start := len(source)
	end := -1
	_ = ast.Walk(node, func(current ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering || current.Type() == ast.TypeInline {
			return ast.WalkContinue, nil
		}
		lines := current.Lines()
		for index := 0; index < lines.Len(); index++ {
			segment := lines.At(index)
			if segment.Start < start {
				start = segment.Start
			}
			if segment.Stop > end {
				end = segment.Stop
			}
		}
		return ast.WalkContinue, nil
	})
	if end < 0 {
		return 0, 0, false
	}
	start = markdownLineStart(source, start)
	end = markdownLineEnd(source, end)
	return start, end, start < end
}

func markdownLineStart(source []byte, position int) int {
	position = min(max(position, 0), len(source))
	if index := bytes.LastIndexByte(source[:position], '\n'); index >= 0 {
		return index + 1
	}
	return 0
}

func markdownLineEnd(source []byte, position int) int {
	position = min(max(position, 0), len(source))
	if index := bytes.IndexByte(source[position:], '\n'); index >= 0 {
		return position + index
	}
	return len(source)
}

func markdownSetextHeadingEnd(source []byte, contentEnd int) int {
	if contentEnd >= len(source) || source[contentEnd] != '\n' {
		return contentEnd
	}
	nextStart := contentEnd + 1
	nextEnd := markdownLineEnd(source, nextStart)
	if markdownSetextUnderlinePattern.Match(source[nextStart:nextEnd]) {
		return nextEnd
	}
	return contentEnd
}

func normalizeWritingReviewDimensions(values []writingReviewDimension) ([]writingReviewDimension, error) {
	byID := make(map[string]writingReviewDimension, len(values))
	for _, value := range values {
		value.ID = strings.ToLower(strings.TrimSpace(value.ID))
		value.Label = strings.TrimSpace(value.Label)
		value.Summary = strings.TrimSpace(value.Summary)
		if !writingReviewDimensionExists(value.ID) || value.Label == "" || value.Summary == "" ||
			value.Score < 0 || value.Score > 100 || len([]rune(value.Label)) > 80 || len([]rune(value.Summary)) > 1_000 {
			return nil, fmt.Errorf("%w: invalid layout assessment", errAgentLLMInvalidResponse)
		}
		if _, exists := byID[value.ID]; exists {
			return nil, fmt.Errorf("%w: duplicate layout assessment", errAgentLLMInvalidResponse)
		}
		byID[value.ID] = value
	}
	result := make([]writingReviewDimension, 0, len(writingReviewDimensionIDs))
	for _, id := range writingReviewDimensionIDs {
		value, ok := byID[id]
		if !ok {
			return nil, fmt.Errorf("%w: layout assessment is missing %s", errAgentLLMInvalidResponse, id)
		}
		result = append(result, value)
	}
	return result, nil
}

func writingReviewDimensionExists(value string) bool {
	for _, id := range writingReviewDimensionIDs {
		if value == id {
			return true
		}
	}
	return false
}

func markdownLayoutReplacement(block markdownReviewBlock, suggestion generatedLayoutSuggestion) (string, error) {
	switch suggestion.Operation {
	case "change_block_type":
		return changeMarkdownBlockType(block, suggestion.AfterType)
	case "split_paragraph":
		if block.Kind != "paragraph" || len(suggestion.Segments) < 2 || len(suggestion.Segments) > 4 ||
			strings.Join(suggestion.Segments, "") != block.Source {
			return "", errorsInvalidLayoutSuggestion()
		}
		for _, segment := range suggestion.Segments {
			if strings.TrimSpace(segment) == "" {
				return "", errorsInvalidLayoutSuggestion()
			}
		}
		return strings.Join(suggestion.Segments, "\n\n"), nil
	case "convert_to_list":
		if block.Kind != "paragraph" || len(suggestion.Segments) < 2 || len(suggestion.Segments) > 6 ||
			strings.Join(suggestion.Segments, "") != block.Source {
			return "", errorsInvalidLayoutSuggestion()
		}
		items := make([]string, 0, len(suggestion.Segments))
		for _, segment := range suggestion.Segments {
			if strings.TrimSpace(segment) == "" {
				return "", errorsInvalidLayoutSuggestion()
			}
			items = append(items, "- "+strings.ReplaceAll(segment, "\n", "\n  "))
		}
		return strings.Join(items, "\n"), nil
	case "emphasize_block":
		if block.Kind != "paragraph" || strings.Contains(block.Source, "\n") || strings.TrimSpace(block.Source) != block.Source ||
			strings.Contains(block.Source, "**") || strings.Contains(block.Source, "__") {
			return "", errorsInvalidLayoutSuggestion()
		}
		return "> **" + block.Source + "**", nil
	case "insert_divider":
		if !block.Editable || block.NextKind == "divider" {
			return "", errorsInvalidLayoutSuggestion()
		}
		return block.Source + "\n\n---", nil
	default:
		return "", errorsInvalidLayoutSuggestion()
	}
}

func changeMarkdownBlockType(block markdownReviewBlock, afterType string) (string, error) {
	afterType = strings.ToLower(strings.TrimSpace(afterType))
	if !block.Editable || block.Text == "" {
		return "", errorsInvalidLayoutSuggestion()
	}
	switch afterType {
	case "p":
		if block.Kind != "heading" {
			return "", errorsInvalidLayoutSuggestion()
		}
		return block.Text, nil
	case "h2", "h3":
		if strings.Contains(block.Text, "\n") {
			return "", errorsInvalidLayoutSuggestion()
		}
		level := 2
		if afterType == "h3" {
			level = 3
		}
		if block.Kind == "heading" && block.Level == level {
			return "", errorsInvalidLayoutSuggestion()
		}
		return strings.Repeat("#", level) + " " + block.Text, nil
	case "blockquote":
		return "> " + strings.ReplaceAll(block.Text, "\n", "\n> "), nil
	default:
		return "", errorsInvalidLayoutSuggestion()
	}
}

func errorsInvalidLayoutSuggestion() error {
	return fmt.Errorf("%w: invalid layout suggestion", errAgentLLMInvalidResponse)
}
