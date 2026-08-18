package server

import (
	"encoding/json"
	"testing"
)

func TestParseMarkdownReviewBlocksPreservesEditableSource(t *testing.T) {
	content := "# 主标题\n\n第一段。第二句。\n\n小标题\n---\n\n- 列表一\n- 列表二"
	blocks := parseMarkdownReviewBlocks(content)
	if len(blocks) != 4 {
		t.Fatalf("blocks=%+v", blocks)
	}
	if blocks[0].Kind != "heading" || blocks[0].Level != 1 || blocks[0].Source != "# 主标题" || blocks[0].Text != "主标题" {
		t.Fatalf("ATX heading=%+v", blocks[0])
	}
	if blocks[1].Kind != "paragraph" || blocks[1].Source != "第一段。第二句。" || !blocks[1].Editable {
		t.Fatalf("paragraph=%+v", blocks[1])
	}
	if blocks[2].Kind != "heading" || blocks[2].Level != 2 || blocks[2].Source != "小标题\n---" || blocks[2].Text != "小标题" {
		t.Fatalf("setext heading=%+v", blocks[2])
	}
	if blocks[3].Kind != "list" || blocks[3].Editable {
		t.Fatalf("list=%+v", blocks[3])
	}
}

func TestParseMarkdownReviewBlocksKeepsATXHeadingAndDividerSeparate(t *testing.T) {
	blocks := parseMarkdownReviewBlocks("# 主标题\n\n---\n\n正文")
	if len(blocks) != 3 || blocks[0].Source != "# 主标题" || blocks[1].Kind != "divider" ||
		blocks[1].Source != "---" || blocks[0].NextKind != "divider" {
		t.Fatalf("blocks=%+v", blocks)
	}
	if _, err := markdownLayoutReplacement(blocks[0], generatedLayoutSuggestion{Operation: "insert_divider"}); err == nil {
		t.Fatal("heading immediately before a divider accepted a duplicate divider")
	}
}

func TestMarkdownLayoutReplacementUsesTypedOperations(t *testing.T) {
	paragraph := parseMarkdownReviewBlocks("第一句。第二句。")[0]
	tests := []struct {
		name       string
		suggestion generatedLayoutSuggestion
		want       string
	}{
		{name: "heading", suggestion: generatedLayoutSuggestion{Operation: "change_block_type", AfterType: "h2"}, want: "## 第一句。第二句。"},
		{name: "split", suggestion: generatedLayoutSuggestion{Operation: "split_paragraph", Segments: []string{"第一句。", "第二句。"}}, want: "第一句。\n\n第二句。"},
		{name: "list", suggestion: generatedLayoutSuggestion{Operation: "convert_to_list", Segments: []string{"第一句。", "第二句。"}}, want: "- 第一句。\n- 第二句。"},
		{name: "emphasis", suggestion: generatedLayoutSuggestion{Operation: "emphasize_block"}, want: "> **第一句。第二句。**"},
		{name: "divider", suggestion: generatedLayoutSuggestion{Operation: "insert_divider"}, want: "第一句。第二句。\n\n---"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := markdownLayoutReplacement(paragraph, test.suggestion)
			if err != nil {
				t.Fatal(err)
			}
			if got != test.want {
				t.Fatalf("replacement=%q, want %q", got, test.want)
			}
		})
	}
}

func TestMarkdownLayoutReplacementRejectsNestedStrongEmphasis(t *testing.T) {
	for _, content := range []string{"This is **important** text", "This is __important__ text"} {
		paragraph := parseMarkdownReviewBlocks(content)[0]
		if _, err := markdownLayoutReplacement(paragraph, generatedLayoutSuggestion{Operation: "emphasize_block"}); err == nil {
			t.Fatalf("emphasize_block accepted nested strong markup in %q", content)
		}
	}
}

func TestParseWritingReviewBuildsLayoutSuggestion(t *testing.T) {
	raw, err := json.Marshal(map[string]any{
		"summary":          "正文清楚，长段落适合拆开。",
		"titleScore":       80,
		"titleAssessment":  "标题清楚。",
		"titleSuggestions": []any{},
		"bodySuggestions":  []any{},
		"layoutAssessment": testWritingLayoutAssessment(),
		"layoutSuggestions": []map[string]any{{
			"category": "readability", "operation": "split_paragraph", "blockId": "block-1",
			"afterType": "", "segments": []string{"第一句。", "第二句。"}, "reason": "移动端更容易扫读。",
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	review, err := parseAndValidateWritingReview(raw, "标题", "第一句。第二句。")
	if err != nil {
		t.Fatal(err)
	}
	if len(review.LayoutAssessment) != 6 || len(review.Suggestions) != 1 {
		t.Fatalf("review=%+v", review)
	}
	suggestion := review.Suggestions[0]
	if suggestion.Kind != "layout" || suggestion.Operation != "split_paragraph" || suggestion.After != "第一句。\n\n第二句。" {
		t.Fatalf("suggestion=%+v", suggestion)
	}
}

func TestParseWritingReviewSkipsInvalidLayoutSuggestion(t *testing.T) {
	raw, err := json.Marshal(map[string]any{
		"summary":          "正文清楚，但排版建议需要筛选。",
		"titleScore":       80,
		"titleAssessment":  "标题清楚。",
		"titleSuggestions": []any{},
		"bodySuggestions":  []any{},
		"layoutAssessment": testWritingLayoutAssessment(),
		"layoutSuggestions": []map[string]any{
			{
				"category": "readability", "operation": "split_paragraph", "blockId": "block-1",
				"afterType": "", "segments": []string{"内容不匹配。", "不能应用。"}, "reason": "这条建议不安全。",
			},
			{
				"category": "readability", "operation": "split_paragraph", "blockId": "block-2",
				"afterType": "", "segments": []string{"第三句。", "第四句。"}, "reason": "移动端更容易扫读。",
			},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	review, err := parseAndValidateWritingReview(raw, "标题", "第一句。第二句。\n\n第三句。第四句。")
	if err != nil {
		t.Fatal(err)
	}
	if len(review.Suggestions) != 1 || review.Suggestions[0].Before != "第三句。第四句。" ||
		review.Suggestions[0].After != "第三句。\n\n第四句。" {
		t.Fatalf("review=%+v", review)
	}
}
