import assert from "node:assert/strict";
import { parseHTML } from "linkedom";

const { window: baseWindow } = parseHTML(
  "<html><head></head><body></body></html>",
);
const NativeDOMParser = baseWindow.DOMParser;

class FragmentDOMParser extends NativeDOMParser {
  parseFromString(value, type) {
    return super.parseFromString(`<html>${value}</html>`, type);
  }
}

const testWindow = Object.create(baseWindow);
Object.defineProperty(testWindow, "DOMParser", { value: FragmentDOMParser });
globalThis.window = testWindow;
globalThis.document = baseWindow.document;
globalThis.Node = baseWindow.Node;
globalThis.requestAnimationFrame = (callback) => {
  callback(0);
  return 0;
};

const [{ Editor }, { default: StarterKit }, { Markdown }, { InlineCode }] =
  await Promise.all([
    import("@tiptap/core"),
    import("@tiptap/starter-kit"),
    import("tiptap-markdown"),
    import("./_inline_code_bundle.mjs"),
  ]);

function createEditor() {
  const element = baseWindow.document.createElement("div");
  baseWindow.document.body.appendChild(element);
  return new Editor({
    element,
    extensions: [
      StarterKit.configure({ code: false, codeBlock: false }),
      InlineCode,
      Markdown.configure({ html: false }),
    ],
  });
}

function typeText(editor, text) {
  for (const character of text) {
    const { from, to } = editor.state.selection;
    const handled = editor.view.someProp("handleTextInput", (handler) =>
      handler(editor.view, from, to, character),
    );
    if (!handled) {
      editor.view.dispatch(editor.state.tr.insertText(character, from, to));
    }
  }
}

const typed = createEditor();
typeText(typed, "`自由之路`");
assert.deepEqual(typed.getJSON().content[0].content, [
  { type: "text", marks: [{ type: "code" }], text: "自由之路" },
]);
assert.equal(typed.storage.markdown.getMarkdown(), "`自由之路`");
typed.destroy();

const selected = createEditor();
selected.commands.setContent("自由之路");
selected.commands.setTextSelection({ from: 1, to: 5 });
const keydown = {
  key: "`",
  keyCode: 192,
  code: "Backquote",
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
};
const handled = selected.view.someProp("handleKeyDown", (handler) =>
  handler(selected.view, keydown),
);
assert.equal(handled, true);
assert.deepEqual(selected.getJSON().content[0].content, [
  { type: "text", marks: [{ type: "code" }], text: "自由之路" },
]);
assert.equal(selected.storage.markdown.getMarkdown(), "`自由之路`");
selected.destroy();

console.log("inline code checks passed");
