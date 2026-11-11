package server

import (
	"regexp"
	"strings"
)

var koiRequirementName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.:+-]{0,127}$`)
var koiEnvironmentName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)

// Check native readiness declarations after manifest/invocation format validation.
// The hosted integration cannot attest to local OS, binary,
// environment or config inventories; never label such requirements executable.
func koiSkillNativeRequirements(raw map[string]any, tools map[string]bool) []string {
	issues := []string{}
	invalid := func(field string) { issues = append(issues, "invalid_runtime_metadata:"+field) }
	get := func(source map[string]any, key string) any {
		value, exists := source[key]
		if exists && value == nil {
			return struct{}{}
		}
		return value
	}
	object := func(value any, field string) map[string]any {
		if value == nil {
			return nil
		}
		result, ok := value.(map[string]any)
		if !ok {
			invalid(field)
		}
		return result
	}
	names := func(value any, field string, pattern *regexp.Regexp) []string {
		if value == nil {
			return nil
		}
		list, ok := value.([]any)
		if !ok || len(list) > 64 {
			invalid(field)
			return nil
		}
		result := []string{}
		for _, item := range list {
			name, ok := item.(string)
			if !ok || !pattern.MatchString(name) {
				invalid(field)
				return nil
			}
			result = append(result, name)
		}
		return result
	}
	platform := func(value any, field string) {
		if value == nil {
			return
		}
		platforms := names(value, field, koiRequirementName)
		if len(platforms) == 0 {
			invalid(field)
			return
		}
		for _, name := range platforms {
			switch name {
			case "darwin", "macos", "linux", "win32", "windows":
			default:
				invalid(field)
				return
			}
		}
		issues = append(issues, "unverified_platform:"+strings.Join(platforms, ", "))
	}
	setup := func(value any) {
		if value == nil {
			return
		}
		list, ok := value.([]any)
		if !ok || len(list) > 64 {
			invalid("required_environment_variables")
			return
		}
		for _, item := range list {
			entry := object(item, "required_environment_variables")
			names([]any{get(entry, "name")}, "required_environment_variables.name", koiEnvironmentName)
		}
		// Setup hints are non-blocking in the native runtime, not credentials
		// that this integration should ask a user to paste into chat.
	}
	hasTool := func(name string) bool {
		return tools[name]
	}
	toolsets := map[string]bool{"terminal": hasTool("sandbox_execute"), "browser": hasTool("browser_markdown"), "web": hasTool("web_search"), "file": hasTool("read_file") && hasTool("write_file"), "memory": hasTool("remember_memory"), "skills": hasTool("skill_view")}
	// The manifest copies extension fields from raw into metadata. Checking raw
	// and the original metadata covers both without checking those copies again.
	sources := []map[string]any{raw, object(get(raw, "metadata"), "metadata")}
	for _, source := range sources {
		if value := source["disable-model-invocation"]; value == true || value == "true" {
			issues = append(issues, "model_invocation_disabled")
		}
		if tool, ok := source["command-tool"].(string); ok && !hasTool(tool) {
			issues = append(issues, "unsupported_tool:"+tool)
		}
	}
	for index, source := range sources {
		field := "platforms"
		if index == 1 {
			field = "metadata.platforms"
		}
		platform(get(source, "platforms"), field)
		setup(get(source, "required_environment_variables"))
		hermes := object(get(source, "hermes"), "metadata.hermes")
		for _, field := range []string{"requires_tools", "fallback_for_tools", "requires_toolsets", "fallback_for_toolsets"} {
			for _, name := range names(get(hermes, field), "metadata.hermes."+field, koiRequirementName) {
				available := false
				if strings.HasSuffix(field, "toolsets") {
					available = toolsets[name]
				} else {
					if name == "terminal" || name == "execute_code" {
						name = "sandbox_execute"
					}
					available = hasTool(name)
				}
				if strings.HasPrefix(field, "requires_") && !available {
					issues = append(issues, "unsupported_requirement:"+name)
				}
				if strings.HasPrefix(field, "fallback_") && available {
					issues = append(issues, "fallback_target_available:"+name)
				}
			}
		}
		claw := object(get(source, "openclaw"), "metadata.openclaw")
		platform(get(claw, "os"), "metadata.openclaw.os")
		if value, exists := claw["always"]; exists && value != true && value != false {
			invalid("metadata.openclaw.always")
		}
		requires := object(get(claw, "requires"), "metadata.openclaw.requires")
		for _, field := range []string{"bins", "anyBins", "env", "config"} {
			pattern := koiRequirementName
			if field == "env" {
				pattern = koiEnvironmentName
			}
			values := names(get(requires, field), "metadata.openclaw.requires."+field, pattern)
			if len(values) > 0 && claw["always"] != true {
				issues = append(issues, "unverified_environment:"+field+" ("+strings.Join(values, ", ")+")")
			}
		}
	}
	return issues
}
