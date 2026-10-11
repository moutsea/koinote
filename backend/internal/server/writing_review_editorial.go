package server

import "strings"

// Editorial diagnostics are inference, not verified analytics. Keep them bounded
// and grounded in visible excerpts before forwarding them to the line editor.
type writingReviewEditorialContext struct {
	ReaderGoal string                        `json:"readerGoal"`
	Voice      string                        `json:"voice"`
	Priorities []writingReviewEditorialIssue `json:"priorities"`
}

type writingReviewEditorialIssue struct {
	Goal      string `json:"goal"`
	Quote     string `json:"quote"`
	Problem   string `json:"problem"`
	Direction string `json:"direction"`
}

type generatedDocumentReview struct {
	Summary          string                         `json:"summary"`
	EditorialContext *writingReviewEditorialContext `json:"editorialContext"`
	BodySuggestions  *[]generatedBodySuggestion     `json:"bodySuggestions"`
}

func containsWritingReviewTask(tasks []string, name string) bool {
	for _, task := range tasks {
		if task == name {
			return true
		}
	}
	return false
}

func writingReviewAllowedSourceTasks(task writingReviewTaskSpec) map[string]struct{} {
	sources := task.BodyTasks
	if len(sources) == 0 {
		sources = []string{writingReviewSourceTask(task)}
	}
	allowed := make(map[string]struct{}, len(sources))
	for _, source := range sources {
		allowed[source] = struct{}{}
	}
	return allowed
}

func writingReviewScopedBodySchema(limit int, tasks []string) map[string]any {
	schema := writingReviewBodySchema(limit)
	suggestions := schema["properties"].(map[string]any)["bodySuggestions"].(map[string]any)
	item := suggestions["items"].(map[string]any)
	item["properties"].(map[string]any)["sourceTask"] = map[string]any{"type": "string", "enum": tasks}
	item["required"] = []string{"sourceTask", "category", "before", "after", "reason"}
	return schema
}

func writingReviewEditorialContextSchema() map[string]any {
	return map[string]any{
		"type": "object", "additionalProperties": false,
		"required": []string{"readerGoal", "voice", "priorities"},
		"properties": map[string]any{
			"readerGoal": map[string]any{"type": "string", "maxLength": 300},
			"voice":      map[string]any{"type": "string", "maxLength": 300},
			"priorities": map[string]any{"type": "array", "maxItems": 3, "items": map[string]any{
				"type": "object", "additionalProperties": false,
				"required": []string{"goal", "quote", "problem", "direction"},
				"properties": map[string]any{
					"goal":      map[string]any{"type": "string", "enum": []string{"click", "retention", "clarity", "trust", "action"}},
					"quote":     map[string]any{"type": "string", "maxLength": 200},
					"problem":   map[string]any{"type": "string", "maxLength": 300},
					"direction": map[string]any{"type": "string", "maxLength": 300},
				},
			}},
		},
	}
}

func validateWritingReviewEditorialContext(value *writingReviewEditorialContext, content string, blocks []markdownReviewBlock, task writingReviewTaskSpec) *writingReviewEditorialContext {
	if value == nil {
		return nil
	} // Older compatible providers may omit diagnosis.
	if blocks == nil {
		blocks = parseMarkdownReviewBlocks(content)
	}
	result := &writingReviewEditorialContext{
		ReaderGoal: truncateWritingReviewContext(strings.TrimSpace(value.ReaderGoal), 600, false),
		Voice:      truncateWritingReviewContext(strings.TrimSpace(value.Voice), 600, false),
		Priorities: []writingReviewEditorialIssue{},
	}
	seen := map[string]bool{}
	for _, issue := range value.Priorities[:min(len(value.Priorities), 12)] {
		if len(result.Priorities) == 3 {
			break
		}
		switch issue.Goal {
		case "click", "retention", "clarity", "trust", "action":
		default:
			continue
		}
		// A quote in an omitted/partial block is not evidence the reviewer saw.
		if issue.Quote == "" || len(issue.Quote) > 800 || seen[issue.Quote] || countOverlappingOccurrences(content, issue.Quote) != 1 {
			continue
		}
		start := strings.Index(content, issue.Quote)
		if !writingSuggestionRangeAllowedByBlocks(start, start+len(issue.Quote), blocks, task.AllowedBodyBlockIDs, task.AllowedBodyBlockRanges) {
			continue
		}
		issue.Problem = truncateWritingReviewContext(strings.TrimSpace(issue.Problem), 500, false)
		issue.Direction = truncateWritingReviewContext(strings.TrimSpace(issue.Direction), 500, false)
		if issue.Problem == "" || issue.Direction == "" {
			continue
		}
		seen[issue.Quote] = true
		result.Priorities = append(result.Priorities, issue)
	}
	return result
}

// Adapted for article editing from dontbesilent2025/dbskill's dbs-content-value,
// dbs-title-cover-intro, dbs-resonate, dbs-script-flow and dbs-ai-check
// (f24ea08ae4b50660a1575554eb58903fa6d60f01).
// The project owner confirmed permission from the author to use these methods.
// See README's AI optimization section for attribution and upstream references.
const writingReviewEditorialPolicy = `

Editorial standard:
- Apply only the standards relevant to your assigned review task. They do not expand its scope: proofreading alone must not propose engagement or style edits, and layout alone must preserve wording.
- Judge the actual genre. A public article needs a clear reason to click and keep reading; a reference note needs accurate navigation and retrieval. Do not force sales copy, suspense, a CTA or a personal anecdote into every document.
- Identify who would choose to read this and what question, decision or experience brings them here. Treat that audience as an inference unless explicitly supplied. Do not assume every reader is a beginner.
- Follow the reader's order of discovery: title, actual opening, body, ending. Diagnose what the entry alone makes recognizable before using later material to check delivery. Later insight cannot retroactively make a weak opening effective. A specialist audience is not a defect to fix by broadening every article.
- Identify the offered reward: an explanation, decision, usable action, emotional recognition, distinctive story or aesthetic experience. Check where that reward first appears and whether later paragraphs add to it. Distinguish a reason to save a useful procedure, share a recognizable experience, or discuss a consequential disagreement; do not equate these with clicks or force all of them into one article.
- Distinguish a weak subject from weak packaging. A title cannot create useful evidence or an original insight the body does not contain. Preserve a strong, specific observation even when its phrasing is unconventional.
- For resonance, connect the main claim to a recognizable situation using details already in the source. Broad labels such as 'everyone' or an emotion word alone may hide why it matters; do not invent a reader persona, grievance or anecdote to fill that gap. Preserve passages that already establish that connection.
- For continuity, check the last idea of one paragraph against the first idea of the next. Repair the missing relationship from supplied facts, not by adding a decorative transition. Before deleting a detour or compressing repetition, verify that no necessary example, condition or reasoning step is lost.
- For voice, address repeated empty conclusions, interchangeable slogans or unsupported imagined reader reactions only when they impair this passage. Such patterns do not prove AI authorship. Keep deliberate rhetoric, uncertainty and genre-specific structure; do not mechanically ban words, shorten all sentences or invent imperfections to simulate a human.
- Title and opening should agree without merely repeating each other. The opening must independently introduce the actual question or experience and lead naturally into the next paragraph. Stating a conclusion early is valid; empty suspense is not a substitute for further value.
- Explain an edit through the actual passage and the reader's likely difficulty. Name the specific expected benefit (choosing to open, continuing, understanding, trusting, or using the article), and a meaningful tradeoff when there is one. Avoid generic praise and instructions such as 'increase engagement'.
- Attention is earned by relevant, supported specifics. Never add false scarcity, fear, fabricated conflict, authority or certainty. Do not predict CTR, reach, reading completion, platform distribution or commercial results without measured data; a review score is an editorial judgment, not a performance forecast.
- Separate text evidence, inference and missing information. If a stronger version needs an absent result, example or source, say exactly what is missing in the assessment or reason; do not insert guessed details, TODOs or placeholders into replacement text.
- Before returning each edit, compare it with the source: preserve material facts, qualifications, chronology, technical terms, quotations, URLs, code and the author's perspective. Reread the replacement with its neighbors. Remove suggestions that create a new overclaim, duplicate another edit, flatten the author's voice, or require another suggestion to be accepted first.`
