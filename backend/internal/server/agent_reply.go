package server

import (
	"encoding/json"
	"regexp"
	"strings"
)

// Match the agent-gpt public projection at this boundary too: settlement's
// modelOutput is deliberately private, while its ordinary result is an audit
// receipt. Redact before clipping so a truncated secret cannot escape parsing.
var (
	agentReplySensitiveKey = regexp.MustCompile(`(?i)(api[_-]?key|password|secret|authorization|token|^(set-)?cookie$)`)
	agentReplyUsageCounter = regexp.MustCompile(`(?i)(^|[_-])(input|output|total|max|cached|reasoning)[_-]?tokens$`)
	agentReplyHeaderName   = regexp.MustCompile(`(?i)^((proxy-)?authorization|(set-)?cookie|(x-)?api[-_]key)$`)
	agentReplyHeaderLine   = regexp.MustCompile(`(?i)(^|[\r\n])([ \t]*((proxy-)?authorization|(set-)?cookie)[ \t]*:[ \t]*)[^\r\n]*(\r?\n[ \t]+[^\r\n]*)*`)
	agentReplySecretField  = regexp.MustCompile(`(?i)((?:"?(?:api[_-]?key|(?:access|refresh|session|auth|bearer|id)[_-]?token|token|password|secret|(?:proxy-)?authorization|(?:set-)?cookie)"?)\s*[:=]\s*)("(?:\\[\s\S]|[^"\\])*(?:"|$)|'(?:\\[\s\S]|[^'\\])*(?:'|$)|(?:bearer|basic)\s+[^\s,;]+|[^\s,;]+)`)
	agentReplyJSONPrefix   = regexp.MustCompile(`^\s*(\{|\[\s*(["{\[\]0-9-]|true\b|false\b|null\b))`)
	agentReplyMarkdownLink = regexp.MustCompile(`^\s*\[(\\.|[^\]\r\n\\])+\](\(|\[|:\s)`)
)

func redactAgentReply(text string) string { return redactAgentReplyText(text, 0) }

func redactAgentReplyText(text string, depth int) string {
	if depth >= 6 {
		return "[redacted]"
	}
	if !agentReplyMarkdownLink.MatchString(text) && agentReplyJSONPrefix.MatchString(text) {
		var value any
		decoder := json.NewDecoder(strings.NewReader(text))
		decoder.UseNumber()
		if json.Valid([]byte(text)) && decoder.Decode(&value) == nil {
			changed := false
			value = redactAgentReplyValue(value, depth, &changed)
			if changed {
				raw, _ := json.Marshal(value)
				return string(raw)
			}
			return text
		}
		if agentReplySecretField.MatchString(text) {
			return "[redacted]"
		}
	}
	text = agentReplyHeaderLine.ReplaceAllString(text, "${1}${2}[redacted]")
	return agentReplySecretField.ReplaceAllStringFunc(text, func(match string) string {
		parts := agentReplySecretField.FindStringSubmatch(match)
		if strings.HasPrefix(parts[2], `"`) {
			return parts[1] + `"[redacted]"`
		}
		return parts[1] + "[redacted]"
	})
}

func redactAgentReplyValue(value any, depth int, changed *bool) any {
	switch v := value.(type) {
	case string:
		safe := redactAgentReplyText(v, depth+1)
		*changed = *changed || safe != v
		return safe
	case map[string]any:
		name, _ := v["name"].(string)
		for key, item := range v {
			_, counter := item.(json.Number)
			if agentReplySensitiveKey.MatchString(key) && !(counter && agentReplyUsageCounter.MatchString(key)) || strings.EqualFold(key, "value") && agentReplyHeaderName.MatchString(name) {
				v[key], *changed = "[redacted]", true
			} else {
				v[key] = redactAgentReplyValue(item, depth, changed)
			}
		}
	case []any:
		name := ""
		if len(v) > 0 {
			name, _ = v[0].(string)
		}
		for i, item := range v {
			if i == 1 && agentReplyHeaderName.MatchString(name) {
				v[i], *changed = "[redacted]", true
			} else {
				v[i] = redactAgentReplyValue(item, depth, changed)
			}
		}
	}
	return value
}
