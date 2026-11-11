package server

import (
	"bytes"
	"encoding/json"
	"slices"
	"strings"
	"testing"
)

func TestKoiSkillCandidateCompatibility(t *testing.T) {
	for _, tc := range []struct {
		declaration, reason string
		article             bool
	}{
		{"", "", true},
		{"requiredTools: [koinote.get_document]", "", true},
		{"requiredTools: [web_fetch, read_file]", "", false},
		{"allowed-tools: koinote.get_document, web_fetch", "", false},
		{"requiredTools: [sandbox_execute]", "unsupported_tool:sandbox_execute", false},
		{"allowed-tools: shell", "local_command:shell", false},
		{"requestedCapabilities: [workspace.read]", "", true},
		{"requestedCapabilities: [network]", "", false},
		{"requestedCapabilities: [workspace.write]", "unsupported_capability:workspace.write", false},
		{"requestedCapabilities: [memory.read]", "unsupported_capability:memory.read", false},
		{"requestedCapabilities: [external.write]", "unsupported_capability:external.write", false},
		{"metadata: {disable-model-invocation: true}", "model_invocation_disabled", false},
		{"metadata: {disable-model-invocation: false}", "", true},
		{"platforms: [darwin]", "unverified_platform:darwin", false},
		{"metadata: {platforms: [linux]}", "unverified_platform:linux", false},
		{"metadata: {openclaw: {os: [windows]}}", "unverified_platform:windows", false},
		{"platforms: null", "invalid_runtime_metadata:platforms", false},
		{"metadata: {hermes: null}", "invalid_runtime_metadata:metadata.hermes", false},
		{"hermes: {requires_tools: [koinote.get_document]}", "", true},
		{"metadata: {hermes: {requires_tools: [skill_view]}}", "", false},
		{"metadata: {hermes: {requires_tools: [get_document]}}", "unsupported_requirement:get_document", false},
		{"metadata: {hermes: {requires_tools: [terminal]}}", "unsupported_requirement:sandbox_execute", false},
		{"metadata: {hermes: {requires_toolsets: [web]}}", "", false},
		{"metadata: {hermes: {requires_toolsets: [file]}}", "unsupported_requirement:file", false},
		{"metadata: {hermes: {fallback_for_tools: [web_fetch]}}", "fallback_target_available:web_fetch", true},
		{"metadata: {hermes: {fallback_for_toolsets: [browser]}}", "fallback_target_available:browser", true},
		{"metadata: {hermes: {fallback_for_tools: [sandbox_execute]}}", "", true},
		{"metadata: {openclaw: {requires: {bins: [gh]}}}", "unverified_environment:bins (gh)", false},
		{"metadata: {openclaw: {requires: {anyBins: [gh, git]}}}", "unverified_environment:anyBins (gh, git)", false},
		{"metadata: {openclaw: {requires: {env: [TOKEN]}}}", "unverified_environment:env (TOKEN)", false},
		{"metadata: {openclaw: {requires: {config: [browser.enabled]}}}", "unverified_environment:config (browser.enabled)", false},
		{"metadata: {openclaw: {always: true, requires: {bins: [gh]}}}", "", true},
		{"metadata: {openclaw: {always: true, requires: {bins: invalid}}}", "invalid_runtime_metadata:metadata.openclaw.requires.bins", false},
		{"metadata: {openclaw: {always: yes}}", "invalid_runtime_metadata:metadata.openclaw.always", false},
		{"metadata: {command-dispatch: tool, command-tool: skill_view}", "", false},
		{"metadata: {command-dispatch: tool, command-tool: shell}", "unsupported_tool:shell", false},
		{"required_environment_variables: [{name: TOKEN}]", "", true},
		{"metadata: {required_environment_variables: [TOKEN]}", "invalid_runtime_metadata:required_environment_variables", false},
	} {
		t.Run(tc.declaration, func(t *testing.T) {
			entry := "---\nname: method\ndescription: Review a note.\n" + tc.declaration + "\n---\nRead the note.\n"
			files := koiCandidateTestFiles(map[string]string{"SKILL.md": "# Parent", "method/SKILL.md": entry})
			before, _ := json.Marshal(files)
			candidates, rejected := koiSkillCandidates(files)
			if tc.reason != "" {
				if len(candidates) != 1 || candidates[0].Directory != "" || len(rejected) != 1 || rejected[0].Name != "method" || rejected[0].Directory != "method" || rejected[0].Reason != "incompatible" || !slices.Contains(rejected[0].Details, tc.reason) {
					t.Fatalf("incompatible child affected parent or lost %q: %+v %+v", tc.reason, candidates, rejected)
				}
			} else if len(candidates) != 2 || len(rejected) != 0 || !candidates[1].Compatibility.Conversation || candidates[1].Compatibility.Article != tc.article {
				t.Fatalf("unexpected compatibility: %+v %+v", candidates, rejected)
			}
			_, _, raw, _, _, err := koiParseSkillEntry(koiSkillFile{Content: []byte(entry)})
			if err != nil {
				t.Fatal(err)
			}
			compat := koiSkillCompatibilityFor(raw)
			if compat.Article != tc.article {
				t.Fatalf("entry compatibility must be evaluated independently: %+v", compat)
			}
			after, _ := json.Marshal(files)
			if !bytes.Equal(before, after) {
				t.Fatal("compatibility check changed source bytes or declarations")
			}
		})
	}
}

func TestKoiSkillCompatibilityReportsToolsAndScriptLimits(t *testing.T) {
	entry := "---\nname: method\ndescription: Review a note.\nrequiredTools: [web_fetch, web_fetch, koinote.get_document]\nscripts: {check: scripts/check.py}\n---\nRead the note.\n"
	candidates, rejected := koiSkillCandidates(koiCandidateTestFiles(map[string]string{"SKILL.md": entry, "scripts/check.py": "print('check')"}))
	if len(candidates) != 1 || len(rejected) != 0 {
		t.Fatalf("valid package rejected: %+v %+v", candidates, rejected)
	}
	compat := candidates[0].Compatibility
	if !slices.Equal(compat.RequiredTools, []string{"web_fetch", "koinote.get_document"}) || !slices.Contains(compat.Warnings, "scripts_not_executed") || !slices.Contains(compat.Warnings, "article_tool_unavailable:web_fetch") {
		t.Fatalf("tool or script limitations missing: %+v", compat)
	}
	if strings.Contains(string(candidates[0].Files[0].Content), "article_tool_unavailable") {
		t.Fatal("compatibility diagnostics leaked into source files")
	}
}
