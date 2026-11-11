package server

import (
	"slices"
	"strings"
)

type koiSkillCompatibility struct {
	Conversation  bool     `json:"conversation"`
	Article       bool     `json:"article"`
	Reasons       []string `json:"reasons"`
	Warnings      []string `json:"warnings,omitempty"`
	RequiredTools []string `json:"requiredTools,omitempty"`
}

// These declarations request authority that a hosted Skill cannot grant.
var koiSkillUnsupportedCapabilities = map[string]string{
	"filesystem_write": "file_system_write", "filesystem": "file_system_write",
	"external_write": "external_write", "publish": "external_write",
	"credentials": "credential_required", "secrets": "credential_required", "oauth": "credential_required",
	"browser_control": "interactive_browser", "computer_use": "interactive_browser",
	"shell": "local_command", "terminal": "local_command", "process": "local_command",
	"mcp": "external_mcp", "packages": "dependency_install",
}

func koiDeclaredTools(raw map[string]any) (tools, capabilities []string) {
	collect := func(value any, into *[]string) {
		switch typed := value.(type) {
		case string:
			*into = append(*into, strings.FieldsFunc(typed, func(r rune) bool {
				return r == ',' || r == ';' || r == ' ' || r == '\n' || r == '\t'
			})...)
		case []any:
			for _, item := range typed {
				if text, ok := item.(string); ok && strings.TrimSpace(text) != "" {
					*into = append(*into, text)
				}
			}
		}
	}
	for _, key := range []string{"requiredTools", "required_tools", "allowed-tools", "allowedTools", "tools"} {
		collect(raw[key], &tools)
	}
	for _, key := range []string{"requestedCapabilities", "requested_capabilities", "capabilities"} {
		collect(raw[key], &capabilities)
	}
	return tools, capabilities
}

// Assess validated declarations against current entry policies. This is not
// installation authorization or a promise that article Skill loading is enabled.
func koiSkillCompatibilityFor(raw map[string]any) koiSkillCompatibility {
	compat := koiSkillCompatibility{Reasons: []string{}}
	add := func(list *[]string, value string) {
		if !slices.Contains(*list, value) {
			*list = append(*list, value)
		}
	}
	conversation, article := map[string]bool{}, map[string]bool{}
	for _, name := range agentEntryTools(false, true) {
		conversation[name] = true
	}
	for _, name := range agentEntryTools(true, true) {
		article[name] = true
	}
	articleAvailable := true
	tools, capabilities := koiDeclaredTools(raw)
	for _, declared := range tools {
		name := koiNormalizeToolName(declared)
		if reason, unsupported := koiSkillUnsupportedCapabilities[name]; unsupported {
			add(&compat.Reasons, reason+":"+name)
			articleAvailable = false
			continue
		}
		native := koiSkillNativeTool(declared)
		if !conversation[native] {
			add(&compat.Reasons, "unsupported_tool:"+name)
		} else {
			add(&compat.RequiredTools, native)
		}
		if !article[native] {
			articleAvailable = false
			add(&compat.Warnings, "article_tool_unavailable:"+name)
		}
	}
	for _, declared := range capabilities {
		name := strings.ToLower(strings.TrimSpace(declared))
		switch name {
		case "workspace.read":
		case "network":
			articleAvailable = false
			add(&compat.Warnings, "article_capability_unavailable:"+name)
		default:
			articleAvailable = false
			if reason, unsupported := koiSkillUnsupportedCapabilities[koiNormalizeToolName(name)]; unsupported {
				add(&compat.Reasons, reason+":"+name)
			} else {
				add(&compat.Reasons, "unsupported_capability:"+name)
			}
		}
	}
	for _, issue := range koiSkillNativeRequirements(raw, conversation) {
		add(&compat.Reasons, issue)
	}
	for _, issue := range koiSkillNativeRequirements(raw, article) {
		articleAvailable = false
		if !slices.Contains(compat.Reasons, issue) {
			_, detail, _ := strings.Cut(issue, ":")
			add(&compat.Warnings, "article_requirement_unavailable:"+detail)
		}
	}
	if scripts, ok := raw["scripts"].(map[string]any); ok && len(scripts) > 0 {
		add(&compat.Warnings, "scripts_not_executed")
	}
	compat.Conversation = len(compat.Reasons) == 0
	compat.Article = articleAvailable
	return compat
}
