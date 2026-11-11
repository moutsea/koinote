package server

import (
	"encoding/json"
	"regexp"
	"strings"
	"unicode/utf16"
)

var koiRuntimeNamePattern = regexp.MustCompile(`^[a-z][a-z0-9._-]{0,127}$`)
var koiRuntimePathPattern = regexp.MustCompile(`^[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*$`)
var koiRuntimeCommandToolPattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_.:-]{0,127}$`)

var koiSkillMCPTools = map[string]bool{
	"get_document": true, "search_documents": true, "list_folders": true,
	"propose_operations": true, "propose_document_change": true,
	"get_conversation": true, "get_operation_results": true, "validate_operation": true,
	"find_skills": true, "load_skill": true, "save_artifact": true,
}

func koiNormalizeToolName(raw string) string {
	name := strings.ToLower(strings.TrimSpace(raw))
	name = strings.TrimPrefix(name, "koinote.")
	name = strings.ReplaceAll(name, "-", "_")
	return name
}

func koiSkillNativeTool(name string) string {
	name = koiNormalizeToolName(name)
	if koiSkillMCPTools[name] {
		return "koinote." + name
	}
	return name
}

func koiRuntimePath(value string) bool {
	if len(value) > 180 || !koiRuntimePathPattern.MatchString(value) {
		return false
	}
	for _, segment := range strings.Split(value, "/") {
		if segment == "." || segment == ".." {
			return false
		}
	}
	return true
}

// Validate package structure before sending an envelope to the native runtime.
// This checks declarations and file integrity only; entry-specific capabilities
// and invocation readiness need separate compatibility checks.
func koiSkillRuntimeIssues(raw map[string]any, name, description string, files []koiSkillFile) []string {
	issues := []string{}
	invalid := func(field string) { issues = append(issues, "invalid_runtime_metadata:"+field) }
	if strings.TrimSpace(name) == "" || len(utf16.Encode([]rune(name))) > 160 {
		invalid("name")
	}
	if strings.TrimSpace(description) == "" || len(utf16.Encode([]rune(description))) > 2000 {
		invalid("description")
	}
	available := map[string]bool{}
	for _, file := range files {
		if !koiRuntimePath(file.Path) {
			issues = append(issues, "invalid_file_path:"+file.Path)
		}
		available[file.Path] = true
	}
	if value, exists := raw["requiredTools"]; exists {
		tools, ok := value.([]any)
		if !ok || len(tools) > 64 {
			invalid("requiredTools")
		} else {
			for _, item := range tools {
				tool, ok := item.(string)
				if !ok || !koiRuntimeNamePattern.MatchString(tool) {
					invalid("requiredTools")
					break
				}
				// The native runtime compares registered tool names exactly. Koi's
				// document tools are MCP tools; a bare name is not an alias there.
				if koiSkillMCPTools[tool] {
					issues = append(issues, "tool_namespace_required:"+tool)
				} else if koiSkillNativeTool(tool) != tool {
					issues = append(issues, "unsupported_tool:"+tool)
				}
			}
		}
	}
	if value, exists := raw["requestedCapabilities"]; exists {
		capabilities, ok := value.([]any)
		allowed := map[string]bool{"workspace.read": true, "workspace.write": true, "memory.read": true, "memory.write": true, "network": true, "external.write": true}
		if !ok || len(capabilities) > len(allowed) {
			invalid("requestedCapabilities")
		} else {
			for _, item := range capabilities {
				capability, ok := item.(string)
				if !ok || !allowed[capability] {
					invalid("requestedCapabilities")
					break
				}
			}
		}
	}
	if value, exists := raw["files"]; exists {
		paths, ok := value.([]any)
		declared := map[string]bool{}
		if !ok || len(paths) > koiSkillMaxFiles {
			invalid("files")
		} else {
			for _, item := range paths {
				member, ok := item.(string)
				if !ok || !koiRuntimePath(member) || member == "SKILL.md" || declared[member] {
					invalid("files")
					continue
				}
				declared[member] = true
				if !available[member] {
					issues = append(issues, "missing_file:"+member)
				}
			}
			for _, file := range files {
				if file.Path != "SKILL.md" && !declared[file.Path] && !strings.HasPrefix(file.Path, "_provenance/") {
					issues = append(issues, "undeclared_file:"+file.Path)
				}
			}
		}
	}
	if value, exists := raw["scripts"]; exists {
		scripts, ok := value.(map[string]any)
		if !ok || len(scripts) > 32 {
			invalid("scripts")
		} else {
			for command, value := range scripts {
				member, ok := value.(string)
				if !ok || len(command) > 64 || !koiRuntimeNamePattern.MatchString(command) || !koiRuntimePath(member) || !strings.HasPrefix(member, "scripts/") {
					invalid("scripts")
					continue
				}
				if !available[member] {
					issues = append(issues, "missing_file:"+member)
				}
			}
		}
	}
	if value, exists := raw["runtime"]; exists {
		// Dependency installation and outbound script networking are outside
		// this integration. An empty native runtime object needs neither.
		runtime, ok := value.(map[string]any)
		if !ok || len(runtime) != 0 {
			issues = append(issues, "unsupported_runtime:runtime")
		}
	}
	if value, exists := raw["metadata"]; exists {
		if _, ok := value.(map[string]any); !ok {
			invalid("metadata")
		}
	}
	metadata := agentSkillManifest(raw)["metadata"]
	if encoded, err := json.Marshal(metadata); err != nil || len(encoded) > 16<<10 {
		invalid("metadata")
	}
	issues = append(issues, koiSkillInvocationIssues(raw)...)
	return issues
}

// Manifest conversion preserves both sources. Match the native runtime's
// invocation format checks before marking a candidate valid: boolean limits
// combine, while repeated command fields must agree exactly.
func koiSkillInvocationIssues(raw map[string]any) []string {
	issues := []string{}
	invalid := func(field string) { issues = append(issues, "invalid_runtime_metadata:"+field) }
	metadata, _ := raw["metadata"].(map[string]any)
	command := map[string]string{}
	commandSet, commandValid := false, true
	for index, source := range []map[string]any{raw, metadata} {
		prefix := ""
		if index == 1 {
			prefix = "metadata."
		}
		for _, field := range []string{"user-invocable", "disable-model-invocation"} {
			if value, exists := source[field]; exists {
				switch typed := value.(type) {
				case bool:
				case string:
					if typed != "true" && typed != "false" {
						invalid(prefix + field)
					}
				default:
					invalid(prefix + field)
				}
			}
		}
		for _, field := range []string{"command-dispatch", "command-tool", "command-arg-mode"} {
			value, exists := source[field]
			if !exists {
				continue
			}
			commandSet = true
			text, ok := value.(string)
			previous, repeated := command[field]
			if !ok || repeated && previous != text {
				invalid(prefix + field)
				commandValid = false
				continue
			}
			command[field] = text
		}
	}
	if commandSet && commandValid {
		tool := command["command-tool"]
		mode, modeSet := command["command-arg-mode"]
		if command["command-dispatch"] != "tool" || !koiRuntimeCommandToolPattern.MatchString(tool) || modeSet && mode != "raw" {
			invalid("command-dispatch")
		} else if koiSkillMCPTools[tool] {
			issues = append(issues, "tool_namespace_required:"+tool)
		}
	}
	return issues
}

// Added ancestor notices are part of the immutable snapshot too. Extend an
// explicit native file list with those paths after its original members have
// passed validation; retain the source declaration in the untouched SKILL.md.
func koiIncludeManifestProvenance(manifest map[string]any, files []koiSkillFile) {
	declared, exists := manifest["files"].([]any)
	if !exists {
		return
	}
	seen := map[string]bool{}
	for _, item := range declared {
		if member, ok := item.(string); ok {
			seen[member] = true
		}
	}
	for _, file := range files {
		if strings.HasPrefix(file.Path, "_provenance/") && !seen[file.Path] {
			declared = append(declared, file.Path)
			seen[file.Path] = true
		}
	}
	manifest["files"] = declared
}
