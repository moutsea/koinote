package server

import (
	"strings"
	"unicode"
)

// At most 24 search requests before retries. Keep the existing 100-Star floor
// and daily allowance; narrower queries expand relevance rather than volume.
var systemRepositoryDiscoverySearches = []struct {
	query string
	pages int
}{
	{"writing skill in:name,description", 2},
	{"写作 skill in:name,description", 2},
	{"obsidian skill in:name,description", 2},
	{"knowledge skill in:name,description", 2},
	{`"second brain" skill in:name,description`, 2},
	{"humanizer in:name,description", 2},
	{"skills in:name,description", 3},
	{"topic:agent-skills", 3},
	{"topic:claude-skills", 3},
	{"topic:skills", 3},
}

// Classify clear writing/knowledge use cases, leaving general or mixed Agent
// collections alone. Repository names carry more intent than incidental words
// such as "research" in a developer workflow's description.
func systemRepositoryDiscoveryCategory(name, description string) string {
	normalize := func(value string) string {
		return " " + strings.Join(strings.FieldsFunc(strings.ToLower(value), func(r rune) bool {
			return !unicode.IsLetter(r) && !unicode.IsNumber(r)
		}), " ") + " "
	}
	contains := func(text string, terms ...string) bool {
		for _, term := range terms {
			if strings.Contains(text, " "+term+" ") {
				return true
			}
		}
		return false
	}
	n := normalize(name)
	if contains(n, "research", "academic", "paper", "phd", "obsidian", "knowledge", "scholar", "study", "second brain", "learn from materials") {
		return "research"
	}
	if contains(n, "writing", "writer", "humanizer", "humanize", "copywriting", "novelist", "screenwriting", "tech doc") {
		return "writing"
	}
	d := normalize(description)
	if contains(d, "knowledge management", "knowledge base", "knowledge linking", "obsidian", "second brain", "note taking", "literature review", "academic reading", "academic writing", "paper writing", "paper review") ||
		strings.Contains(description, "知识") || strings.Contains(description, "笔记") || strings.Contains(description, "论文") || strings.Contains(description, "文献") {
		return "research"
	}
	if contains(d, "creative writing", "technical writing", "writing skill", "writing skills", "writing style", "writing patterns", "rewrites text", "humanizer", "humanize", "copywriting") ||
		strings.Contains(description, "写作") || strings.Contains(description, "润色") || strings.Contains(description, "去AI味") || strings.Contains(description, "去 AI 味") || strings.Contains(description, "小说") {
		return "writing"
	}
	return "agents"
}
