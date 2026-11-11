package server

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"

	"gopkg.in/yaml.v3"
)

// These are Koinote parsing and source-read limits, not universal Agent Skills limits.
const (
	koiSkillEntryBytes   = 64 << 10
	koiSkillFileBytes    = 128 << 10
	koiSkillImportBytes  = 8 << 20
	koiSkillImportFiles  = 512
	koiSkillNameMaxRunes = 64
)

var (
	errKoiSkillPackage            = errors.New("skill package is invalid")
	errKoiSkillTooLarge           = errors.New("skill package exceeds Koinote limits")
	errKoiSkillMissingName        = fmt.Errorf("%w: frontmatter name is required", errKoiSkillPackage)
	errKoiSkillMissingDescription = fmt.Errorf("%w: frontmatter description is required", errKoiSkillPackage)
	errKoiSkillEmptyEntry         = fmt.Errorf("%w: SKILL.md body is empty", errKoiSkillPackage)
	koiSkillNamePattern           = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
	koiSkillFrontmatterEndPattern = regexp.MustCompile(`(?m)^(?:---|\.\.\.)[ \t]*$`)
)

// koiSkillFile holds source bytes and their reported metadata during validation.
type koiSkillFile struct {
	Path      string
	Content   []byte
	MimeType  string
	SHA256    string
	SizeBytes int64
	// A rejected source member still establishes package boundaries and ownership.
	RejectionCode string
}

// Parse SKILL.md without rewriting its source. Plain Markdown leaves the name
// unset for the caller to derive. Native entries require name, description and
// a non-empty Markdown body; invalid frontmatter never silently falls back.
func koiParseSkillEntry(file koiSkillFile) (name, description string, raw map[string]any, format, instructions string, err error) {
	if len(file.Content) > koiSkillEntryBytes || file.SizeBytes > koiSkillEntryBytes {
		return "", "", nil, "", "", fmt.Errorf("%w: entry too large", errKoiSkillTooLarge)
	}
	instructions = string(file.Content)
	normalized := strings.ReplaceAll(strings.TrimPrefix(instructions, "\ufeff"), "\r\n", "\n")
	raw = map[string]any{}
	firstLine, remainder, hasLineBreak := strings.Cut(normalized, "\n")
	if !hasLineBreak || strings.TrimRight(firstLine, " \t") != "---" {
		if strings.TrimSpace(normalized) == "" {
			return "", "", nil, "", "", errKoiSkillEmptyEntry
		}
		return "", koiPlainDescription(normalized), raw, "plain-markdown", instructions, nil
	}
	end := koiSkillFrontmatterEndPattern.FindStringIndex(remainder)
	if end == nil {
		return "", "", nil, "", "", fmt.Errorf("%w: unterminated YAML frontmatter", errKoiSkillPackage)
	}
	if yamlErr := yaml.Unmarshal([]byte(remainder[:end[0]]), &raw); yamlErr != nil {
		return "", "", nil, "", "", fmt.Errorf("%w: invalid YAML frontmatter", errKoiSkillPackage)
	}
	if raw == nil {
		raw = map[string]any{}
	}
	if name, err = koiFrontmatterString(raw["name"]); err != nil {
		return "", "", nil, "", "", err
	}
	if description, err = koiFrontmatterString(raw["description"]); err != nil {
		return "", "", nil, "", "", err
	}
	if name == "" {
		return "", "", nil, "", "", errKoiSkillMissingName
	}
	if !koiValidSkillName(name) {
		return "", "", nil, "", "", fmt.Errorf("%w: name must be lowercase letters, digits and single hyphens (at most %d characters)", errKoiSkillPackage, koiSkillNameMaxRunes)
	}
	if description == "" {
		return "", "", nil, "", "", errKoiSkillMissingDescription
	}
	if strings.TrimSpace(remainder[end[1]:]) == "" {
		return "", "", nil, "", "", errKoiSkillEmptyEntry
	}
	return name, strings.TrimSpace(description), raw, "agent-skills", instructions, nil
}

func koiFrontmatterString(value any) (string, error) {
	switch typed := value.(type) {
	case nil:
		return "", nil
	case string:
		return strings.TrimSpace(typed), nil
	default:
		return "", fmt.Errorf("%w: name and description must be strings", errKoiSkillPackage)
	}
}

func koiValidSkillName(name string) bool {
	return name != "" && utf8.RuneCountInString(name) <= koiSkillNameMaxRunes && koiSkillNamePattern.MatchString(name)
}

// A plain Markdown SKILL.md has no declared metadata. Derive a readable
// description from its first prose line without touching the original bytes.
func koiPlainDescription(instructions string) string {
	for _, line := range strings.Split(instructions, "\n") {
		candidate := strings.TrimSpace(strings.TrimLeft(line, "#*>-\t "))
		if candidate == "" || strings.HasPrefix(candidate, "```") || strings.HasPrefix(candidate, "<!--") || strings.HasPrefix(candidate, "---") {
			continue
		}
		if runes := []rune(candidate); len(runes) > 200 {
			return strings.TrimSpace(string(runes[:200])) + "…"
		}
		return candidate
	}
	return ""
}
