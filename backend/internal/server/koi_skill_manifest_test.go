package server

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestAgentSkillManifestPreservesParsedMetadata(t *testing.T) {
	entry := "---\nname: review\ndescription: Review a note.\nlicense: Apache-2.0\nallowed-tools: koinote.get_document\nmetadata:\n  author: Acme\n  license: MIT\n  openclaw:\n    requires:\n      env: [SERVICE_TOKEN]\n---\n# Review\n"
	_, _, fields, _, _, err := koiParseSkillEntry(koiSkillFile{Content: []byte(entry)})
	if err != nil {
		t.Fatal(err)
	}
	before, err := json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	manifest := agentSkillManifest(fields)
	metadata, ok := manifest["metadata"].(map[string]any)
	if !ok || metadata["author"] != "Acme" || metadata["license"] != "Apache-2.0" || metadata["allowed-tools"] != "koinote.get_document" || !reflect.DeepEqual(metadata["openclaw"], fields["metadata"].(map[string]any)["openclaw"]) {
		t.Fatalf("extension declarations were lost: %+v", metadata)
	}
	after, err := json.Marshal(fields)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatalf("building a manifest changed parsed source metadata: %s, %v", after, err)
	}
	if second := agentSkillManifest(fields); !reflect.DeepEqual(manifest, second) {
		t.Fatal("repeated conversion changed the manifest")
	}
	if empty := agentSkillManifest(nil); len(empty) != 2 || empty["format"] != "agent-gpt.skill/v1" || empty["entrypoint"] != "SKILL.md" {
		t.Fatalf("empty fields need only the base envelope: %+v", empty)
	}
}

func TestAutomaticSkillPackagePreservesDeclarations(t *testing.T) {
	entry := "\ufeff" + strings.ReplaceAll("---\nid: upstream-id\nversion: 2.0.0\nname: review\ndescription: Review a note.\nrequiredTools: [koinote.get_document]\nrequestedCapabilities: [workspace.read]\nfiles: [references/guide.md]\nscripts: {check: scripts/check.py}\nruntime: {python: '3.12'}\nuser-invocable: false\ndisable-model-invocation: true\ncommand-dispatch: tool\ncommand-tool: koinote.get_document\ncommand-arg-mode: raw\nmetadata: {author: Acme}\nlicense: MIT\n---\n# Review\nRead the reference.\n", "\n", "\r\n")
	raw, err := json.Marshal(map[string]any{
		"instructions": entry,
		"files":        []map[string]string{{"path": "references/guide.md", "content": "Review guide"}},
		"scope":        "workspace",
	})
	if err != nil {
		t.Fatal(err)
	}
	decode := func(repositoryID int64, path string, input json.RawMessage) (map[string]any, map[string]any) {
		t.Helper()
		output, err := automaticSkillPackage(input, repositoryID, path)
		if err != nil {
			t.Fatal(err)
		}
		var pkg map[string]any
		if err := json.Unmarshal(output, &pkg); err != nil {
			t.Fatal(err)
		}
		manifest, ok := pkg["manifest"].(map[string]any)
		if !ok {
			t.Fatal("missing manifest")
		}
		return pkg, manifest
	}
	pkg, manifest := decode(42, "review/SKILL.md", raw)
	if pkg["instructions"] != entry || pkg["scope"] != "workspace" || !reflect.DeepEqual(pkg["files"], []any{map[string]any{"path": "references/guide.md", "content": "Review guide"}}) {
		t.Fatal("packaging changed source instructions, attachments or scope")
	}
	if manifest["name"] != "review" || manifest["description"] != "Review a note." || manifest["userInvocable"] != false || manifest["disableModelInvocation"] != true || manifest["commandDispatch"] != "tool" || manifest["commandTool"] != "koinote.get_document" || manifest["commandArgMode"] != "raw" {
		t.Fatalf("invocation policies were lost: %+v", manifest)
	}
	if !reflect.DeepEqual(manifest["requiredTools"], []any{"koinote.get_document"}) || !reflect.DeepEqual(manifest["requestedCapabilities"], []any{"workspace.read"}) || !reflect.DeepEqual(manifest["files"], []any{"references/guide.md"}) || !reflect.DeepEqual(manifest["scripts"], map[string]any{"check": "scripts/check.py"}) || !reflect.DeepEqual(manifest["runtime"], map[string]any{"python": "3.12"}) || !reflect.DeepEqual(manifest["metadata"], map[string]any{"author": "Acme", "license": "MIT"}) {
		t.Fatalf("native declarations were changed: %+v", manifest)
	}
	_, repeated := decode(42, "review/SKILL.md", raw)
	_, otherRepository := decode(43, "review/SKILL.md", raw)
	_, otherPath := decode(42, "other/SKILL.md", raw)
	changedRaw := bytes.Replace(raw, []byte("Review guide"), []byte("Updated guide"), 1)
	_, updated := decode(42, "review/SKILL.md", changedRaw)
	if manifest["id"] == "upstream-id" || manifest["version"] == "2.0.0" || !reflect.DeepEqual(manifest, repeated) || manifest["id"] == otherRepository["id"] || manifest["id"] == otherPath["id"] || manifest["id"] != updated["id"] || manifest["version"] == updated["version"] {
		t.Fatal("package identity or content-version isolation changed")
	}
}
