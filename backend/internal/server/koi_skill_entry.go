package server

import (
	"errors"
	"fmt"
	"regexp"
	"strings"
	"unicode/utf8"

	"gopkg.in/yaml.v3"
)

// These are Koinote entry limits, not universal Agent Skills limits.
const (
	koiSkillEntryBytes   = 64 << 10
	koiSkillNameMaxRunes = 64
)

var (
	errKoiSkillPackage  = errors.New("skill package is invalid")
	errKoiSkillTooLarge = errors.New("skill package exceeds Koinote limits")
	koiSkillNamePattern = regexp.MustCompile(`^[a-z0-9]+(?:-[a-z0-9]+)*$`)
)

// koiSkillFile holds source bytes and their reported metadata during validation.
type koiSkillFile struct {
	Path      string
	Content   []byte
	MimeType  string
	SHA256    string
	SizeBytes int64
}

// Parse SKILL.md without rewriting its source. Plain Markdown leaves the name
// unset for the caller to derive; malformed YAML never silently falls back.
// Package validation decides whether missing metadata can be derived.
func koiParseSkillEntry(file koiSkillFile) (name, description string, raw map[string]any, format, instructions string, err error) {
	if len(file.Content) > koiSkillEntryBytes || file.SizeBytes > koiSkillEntryBytes {
		return "", "", nil, "", "", fmt.Errorf("%w: entry too large", errKoiSkillTooLarge)
	}
	instructions = string(file.Content)
	normalized := strings.ReplaceAll(strings.TrimPrefix(instructions, "\ufeff"), "\r\n", "\n")
	raw = map[string]any{}
	if !strings.HasPrefix(normalized, "---\n") {
		return "", koiPlainDescription(normalized), raw, "plain-markdown", instructions, nil
	}
	end := strings.Index(normalized[4:], "\n---")
	if end < 0 {
		return "", "", nil, "", "", fmt.Errorf("%w: unterminated YAML frontmatter", errKoiSkillPackage)
	}
	if yamlErr := yaml.Unmarshal([]byte(normalized[4:4+end]), &raw); yamlErr != nil {
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
	if name != "" && !koiValidSkillName(name) {
		return "", "", nil, "", "", fmt.Errorf("%w: name must be lowercase letters, digits and single hyphens (at most %d characters)", errKoiSkillPackage, koiSkillNameMaxRunes)
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
