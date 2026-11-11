package server

// Map parsed frontmatter into the native package envelope without changing the
// source metadata. Identity is supplied by the caller; extensions and invocation
// declarations retain their values for validation by the native runtime.
func agentSkillManifest(fields map[string]any) map[string]any {
	manifest := map[string]any{"format": "agent-gpt.skill/v1", "entrypoint": "SKILL.md"}
	known := map[string]string{"name": "name", "description": "description", "requiredTools": "requiredTools", "requestedCapabilities": "requestedCapabilities", "files": "files", "scripts": "scripts", "runtime": "runtime", "user-invocable": "userInvocable", "disable-model-invocation": "disableModelInvocation", "command-dispatch": "commandDispatch", "command-tool": "commandTool", "command-arg-mode": "commandArgMode"}
	metadata := map[string]any{}
	if original, ok := fields["metadata"].(map[string]any); ok {
		for key, value := range original {
			metadata[key] = value
		}
	}
	for key, value := range fields {
		if target, ok := known[key]; ok {
			manifest[target] = value
		} else if key != "id" && key != "version" && key != "metadata" {
			metadata[key] = value
		}
	}
	if len(metadata) > 0 {
		manifest["metadata"] = metadata
	}
	return manifest
}
