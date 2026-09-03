import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Schema } from "@tiptap/pm/model";
import { EditorState, NodeSelection, TextSelection } from "@tiptap/pm/state";
import { selectedCodeBlockText } from "./_code_block_copy_bundle.mjs";

const extensions = readFileSync("spa/src/components/editor/extensions.ts", "utf8");
const markdownEditor = readFileSync("spa/src/components/editor/MarkdownEditor.tsx", "utf8");
const codeBlockView = readFileSync("spa/src/components/editor/CodeBlockCopyView.tsx", "utf8");
assert.match(extensions, /enableTabIndentation:\s*true/);
assert.match(extensions, /tabSize:\s*4/);
assert.match(extensions, /editor\.view\.dispatch\(state\.tr\.insertText\(/);
assert.match(extensions, /"Mod-a":/);
assert.match(extensions, /TextSelection\.create\(state\.doc, blockStart, blockEnd\)/);
assert.match(markdownEditor, /editorProps:\s*\{\s*\.\.\.editor\.options\.editorProps,/s);
assert.match(extensions, /selection\.\$from\.sameParent\(selection\.\$to\)/);
assert.match(extensions, /selection\.from === blockStart && selection\.to === blockEnd/);
assert.match(extensions, /if \(blockStart === blockEnd\) \{\s*return false;/);
assert.match(codeBlockView, /role=\{copyState === "failed" \? "alert" : "status"\}/);

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block" },
    codeBlock: { content: "text*", group: "block", code: true },
    text: { group: "inline" },
  },
});
const value = "if (ready) {\n    return value;\n}";
const code = schema.node("codeBlock", null, schema.text(value));
const doc = schema.node("doc", null, [
  code,
  schema.node("paragraph", null, schema.text("tail")),
]);

const textState = EditorState.create({
  doc,
  selection: TextSelection.create(doc, 1, 1 + value.length),
});
assert.equal(selectedCodeBlockText(textState), value);

const nodeState = EditorState.create({
  doc,
  selection: NodeSelection.create(doc, 0),
});
assert.equal(selectedCodeBlockText(nodeState), value);

const otherState = EditorState.create({
  doc,
  selection: TextSelection.create(doc, code.nodeSize + 1, code.nodeSize + 2),
});
assert.equal(selectedCodeBlockText(otherState), null);

console.log("code block copy checks passed");
