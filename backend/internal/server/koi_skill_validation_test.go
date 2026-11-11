package server

import (
	"bytes"
	"encoding/json"
	"slices"
	"strings"
	"testing"
)

func TestKoiSkillCandidatesValidateRuntimeDeclarations(t *testing.T) {
	for _, tc := range []struct {
		declaration, detail string
	}{
		{"requiredTools: get_document", "invalid_runtime_metadata:requiredTools"},
		{"requiredTools: [get_document]", "tool_namespace_required:get_document"},
		{"requiredTools: [koinote.web_fetch]", "unsupported_tool:koinote.web_fetch"},
		{"requestedCapabilities: [unknown]", "invalid_runtime_metadata:requestedCapabilities"},
		{"files: [missing.md]", "missing_file:missing.md"},
		{"files: [guide.md, guide.md]", "invalid_runtime_metadata:files"},
		{"files: [SKILL.md]", "invalid_runtime_metadata:files"},
		{"files: [../guide.md]", "invalid_runtime_metadata:files"},
		{"files: []", "undeclared_file:guide.md"},
		{"scripts: [build.sh]", "invalid_runtime_metadata:scripts"},
		{"scripts: {run: guide.md}", "invalid_runtime_metadata:scripts"},
		{"scripts: {run: scripts/missing.py}", "missing_file:scripts/missing.py"},
		{"runtime: {pythonRequirements: requirements.lock}", "unsupported_runtime:runtime"},
		{"runtime: python", "unsupported_runtime:runtime"},
		{"metadata: []", "invalid_runtime_metadata:metadata"},
		{"metadata: null", "invalid_runtime_metadata:metadata"},
		{"x-notes: " + strings.Repeat("a", 16<<10), "invalid_runtime_metadata:metadata"},
		{"description: " + strings.Repeat("a", 2001), "invalid_runtime_metadata:description"},
		{"command-dispatch: shell", "invalid_runtime_metadata:command-dispatch"},
		{"command-dispatch: tool\ncommand-tool: get_document", "tool_namespace_required:get_document"},
	} {
		t.Run(strings.SplitN(tc.declaration, ":", 2)[0]+"/"+tc.detail, func(t *testing.T) {
			entry := "---\nname: method\n"
			if !strings.HasPrefix(tc.declaration, "description:") {
				entry += "description: Review a note.\n"
			}
			entry += tc.declaration + "\n---\nRead the guide.\n"
			files := koiCandidateTestFiles(map[string]string{
				"SKILL.md": "# Parent", "method/SKILL.md": entry, "method/guide.md": "Guide",
			})
			before, _ := json.Marshal(files)
			candidates, rejected := koiSkillCandidates(files)
			if len(candidates) != 1 || candidates[0].Directory != "" || candidates[0].FileCount != 1 ||
				len(rejected) != 1 || rejected[0].Directory != "method" || rejected[0].Name != "method" ||
				rejected[0].Reason != "invalid_runtime_metadata" || !slices.Contains(rejected[0].Details, tc.detail) {
				t.Fatalf("invalid child affected its parent or lost the reason %q: %+v %+v", tc.detail, candidates, rejected)
			}
			after, _ := json.Marshal(files)
			if !bytes.Equal(before, after) {
				t.Fatal("validation changed source files")
			}
		})
	}
}

func TestKoiSkillRuntimePathsMatchNativeEnvelope(t *testing.T) {
	for _, filePath := range []string{"references/guide name.md", "references/说明.md", "references/../guide.md", "/guide.md", strings.Repeat("a", 181)} {
		candidates, rejected := koiSkillCandidates(koiCandidateTestFiles(map[string]string{"SKILL.md": "# Method", filePath: "Guide"}))
		if len(candidates) != 0 || len(rejected) != 1 || !slices.Contains(rejected[0].Details, "invalid_file_path:"+filePath) {
			t.Fatalf("native-invalid attachment %q accepted: %+v %+v", filePath, candidates, rejected)
		}
	}
}

func TestKoiSkillInvocationDeclarations(t *testing.T) {
	for _, tc := range []struct {
		name, declaration, detail string
	}{
		{"top user flag", "user-invocable: yes", "invalid_runtime_metadata:user-invocable"},
		{"top model flag", "disable-model-invocation: 1", "invalid_runtime_metadata:disable-model-invocation"},
		{"metadata user flag", "metadata: {user-invocable: [true]}", "invalid_runtime_metadata:metadata.user-invocable"},
		{"metadata model flag", "metadata: {disable-model-invocation: no}", "invalid_runtime_metadata:metadata.disable-model-invocation"},
		{"null flag", "user-invocable: null", "invalid_runtime_metadata:user-invocable"},
		{"metadata dispatch", "metadata: {command-dispatch: shell, command-tool: skill_view}", "invalid_runtime_metadata:command-dispatch"},
		{"metadata namespace", "metadata: {command-dispatch: tool, command-tool: get_document}", "tool_namespace_required:get_document"},
		{"incomplete command", "metadata: {command-tool: skill_view}", "invalid_runtime_metadata:command-dispatch"},
		{"null command", "metadata: {command-dispatch: tool, command-tool: null}", "invalid_runtime_metadata:metadata.command-tool"},
		{"non-string command", "command-tool: [skill_view]", "invalid_runtime_metadata:command-tool"},
		{"tool conflict", "command-dispatch: tool\ncommand-tool: koinote.get_document\nmetadata: {command-tool: web_fetch}", "invalid_runtime_metadata:metadata.command-tool"},
		{"dispatch conflict", "command-dispatch: tool\ncommand-tool: skill_view\nmetadata: {command-dispatch: shell}", "invalid_runtime_metadata:metadata.command-dispatch"},
		{"argument conflict", "command-dispatch: tool\ncommand-tool: skill_view\ncommand-arg-mode: raw\nmetadata: {command-arg-mode: parsed}", "invalid_runtime_metadata:metadata.command-arg-mode"},
		{"metadata argument mode", "metadata: {command-dispatch: tool, command-tool: skill_view, command-arg-mode: parsed}", "invalid_runtime_metadata:command-dispatch"},
		{"boolean values", "user-invocable: false\ndisable-model-invocation: true", ""},
		{"quoted values", "user-invocable: 'true'\nmetadata: {disable-model-invocation: 'false'}", ""},
		{"combined restrictions", "user-invocable: true\ndisable-model-invocation: false\nmetadata: {user-invocable: false, disable-model-invocation: true}", ""},
		{"metadata command", "metadata: {command-dispatch: tool, command-tool: skill_view}", ""},
		{"split command", "command-dispatch: tool\nmetadata: {command-tool: koinote.get_document, command-arg-mode: raw}", ""},
		{"matching command", "command-dispatch: tool\ncommand-tool: skill_view\nmetadata: {command-dispatch: tool, command-tool: skill_view, command-arg-mode: raw}", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			entry := "---\nname: method\ndescription: Review a note.\n" + tc.declaration + "\n---\nRead the note.\n"
			files := koiCandidateTestFiles(map[string]string{"SKILL.md": "# Parent", "method/SKILL.md": entry})
			before, _ := json.Marshal(files)
			candidates, rejected := koiSkillCandidates(files)
			if tc.detail != "" {
				if len(candidates) != 1 || candidates[0].Directory != "" || len(rejected) != 1 || rejected[0].Reason != "invalid_runtime_metadata" || !slices.Contains(rejected[0].Details, tc.detail) {
					t.Fatalf("invalid invocation declaration not isolated: %+v %+v", candidates, rejected)
				}
			} else {
				if len(candidates) != 2 || len(rejected) != 0 {
					t.Fatalf("valid invocation declaration rejected: %+v %+v", candidates, rejected)
				}
				candidate := candidates[1]
				if candidate.Instructions != entry || len(candidate.Files) != 1 || string(candidate.Files[0].Content) != entry {
					t.Fatal("validation changed invocation declarations or source bytes")
				}
			}
			after, _ := json.Marshal(files)
			if !bytes.Equal(before, after) {
				t.Fatal("invocation validation changed source files")
			}
		})
	}
}

func TestKoiSkillRuntimeManifestKeepsProvenanceAndSource(t *testing.T) {
	entry := "\ufeff" + strings.ReplaceAll("---\nname: method\ndescription: Review a note.\nrequiredTools: [koinote.get_document, web_fetch]\nrequestedCapabilities: [workspace.read, network]\nfiles: [LICENSE, references/guide.md, scripts/check.py]\nscripts: {check: scripts/check.py}\nruntime: {}\nuser-invocable: false\ndisable-model-invocation: true\ncommand-dispatch: tool\ncommand-tool: koinote.get_document\ncommand-arg-mode: raw\nmetadata: {author: Example}\n---\nRead the guide.\n", "\n", "\r\n")
	files := koiCandidateTestFiles(map[string]string{
		"LICENSE": "MIT License", "NOTICE.md": "Attribution", "method/LICENSE": "Local license",
		"method/SKILL.md": entry, "method/references/guide.md": "Guide", "method/scripts/check.py": "print('check')",
	})
	candidates, rejected := koiSkillCandidates(files)
	if len(candidates) != 1 || len(rejected) != 0 {
		t.Fatalf("valid native declarations rejected: %+v %+v", candidates, rejected)
	}
	candidate := candidates[0]
	before, _ := json.Marshal(candidate.RawMetadata)
	manifest := agentSkillManifest(candidate.RawMetadata)
	koiIncludeManifestProvenance(manifest, candidate.Files)
	first, _ := json.Marshal(manifest)
	koiIncludeManifestProvenance(manifest, candidate.Files)
	second, _ := json.Marshal(manifest)
	after, _ := json.Marshal(candidate.RawMetadata)
	if !bytes.Equal(before, after) || !bytes.Equal(first, second) || candidate.Instructions != entry {
		t.Fatal("preparing provenance changed source metadata, bytes or repeated output")
	}
	declared := manifest["files"].([]any)
	if len(declared) != len(candidate.Files)-1 || candidate.FileCount != 6 || manifest["userInvocable"] != false || manifest["disableModelInvocation"] != true {
		t.Fatalf("manifest lost members or invocation restrictions: %+v", manifest)
	}
	for _, file := range candidate.Files {
		if file.Path == "SKILL.md" {
			if string(file.Content) != entry {
				t.Fatal("SKILL.md bytes changed")
			}
		} else if !slices.Contains(declared, any(file.Path)) {
			t.Fatalf("file %q missing from runtime manifest", file.Path)
		}
	}
	// With no explicit source list the native runtime infers every attachment.
	implicit := agentSkillManifest(nil)
	koiIncludeManifestProvenance(implicit, candidate.Files)
	if _, exists := implicit["files"]; exists {
		t.Fatal("provenance invented a partial explicit file list")
	}
}
