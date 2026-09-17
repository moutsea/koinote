import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { normalizeClipboardHTML } from "./_clipboard_paste_bundle.mjs";

const { window: baseWindow } = parseHTML("<html><head></head><body></body></html>");
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
globalThis.requestAnimationFrame = () => 0;
// ProseMirror parses clipboard HTML in a detached document and reads its styles.
document.implementation = {
  createHTMLDocument() {
    const { document: detached } = parseHTML("<html><head></head><body></body></html>");
    detached.styleSheets = [];
    return detached;
  },
};

const [{ Editor }, { default: StarterKit }, { Markdown }] = await Promise.all([
  import("@tiptap/core"),
  import("@tiptap/starter-kit"),
  import("tiptap-markdown"),
]);

function paste({ html = "", text = "", normalize = true, content } = {}) {
  const element = document.createElement("div");
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    content,
    extensions: [StarterKit, Markdown.configure({ html: false, transformPastedText: true })],
    editorProps: normalize ? { transformPastedHTML: normalizeClipboardHTML } : {},
  });
  editor.view.scrollToSelection = () => {};
  const event = new baseWindow.Event("paste", { cancelable: true, bubbles: true });
  event.clipboardData = { getData: (type) => type === "text/html" ? html : type === "text/plain" ? text : "" };
  editor.view.dispatchEvent(event);
  const json = editor.getJSON();
  editor.destroy();
  element.remove();
  return json;
}

const textNode = (text) => ({ type: "text", text });
const paragraph = (text) => ({ type: "paragraph", ...(text ? { content: [textNode(text)] } : {}) });
const twoParagraphs = { type: "doc", content: [paragraph("first"), paragraph("second")] };
let checks = 0;
function check(label, run) {
  run();
  checks += 1;
  console.log(`PASS ${label}`);
}

check("fixture reproduces an extra paragraph before normalization", () => {
  const result = paste({ html: "<p>first</p>\r\n<p>second</p>", normalize: false });
  assert.equal(result.content.length, 3);
});

for (const separator of ["\r\n", "\n", "\r", "\r\n  \t", " "]) {
  for (const marker of ["", ' data-pm-slice="1 1 []"']) {
    check(`block whitespace ${JSON.stringify(separator)}, internal=${!!marker}`, () => {
      assert.deepEqual(paste({ html: `<p${marker}>first</p>${separator}<p>second</p>` }), twoParagraphs);
    });
  }
}

check("explicit empty paragraphs and hard breaks survive", () => {
  assert.deepEqual(paste({ html: "<p>first</p>\r\n<p><br></p>\r\n<p>second</p>" }), {
    type: "doc", content: [paragraph("first"), paragraph(), paragraph("second")],
  });
  assert.deepEqual(paste({ html: "<p>first<br><br>second</p>" }), {
    type: "doc", content: [{ type: "paragraph", content: [textNode("first"), { type: "hardBreak" }, { type: "hardBreak" }, textNode("second")] }],
  });
});

check("inline spaces and non-breaking spaces survive", () => {
  const html = '<p><strong>first</strong> <em>second</em></p><p>&nbsp;</p>';
  assert.equal(normalizeClipboardHTML(html), html);
  assert.equal(paste({ html }).content[0].content.map((node) => node.text).join(""), "first second");
});

check("code indentation and empty lines survive", () => {
  const html = "<pre><code>first\n\n    second\n</code></pre>\r\n<p>tail</p>";
  const result = paste({ html });
  assert.equal(result.content.length, 2);
  assert.equal(result.content[0].content[0].text, "first\n\n    second\n");
});

check("explicit CSS whitespace preservation survives", () => {
  for (const style of ["pre", "pre-wrap", "pre-line", "break-spaces"]) {
    const html = `<div style="white-space: ${style}"><span>first</span>\r\n<div>second</div></div>`;
    assert.equal(normalizeClipboardHTML(html), html);
  }
});

check("nested lists retain their structure", () => {
  const html = "<ul>\r\n<li><p>first</p>\r\n<ul>\r\n<li><p>nested</p></li>\r\n</ul></li>\r\n<li><p>second</p></li>\r\n</ul>";
  assert.deepEqual(paste({ html }), paste({ html: html.replace(/\r\n/g, ""), normalize: false }));
});

check("standalone table fragments retain rows, cells and slice metadata", () => {
  const html = '<tr data-pm-slice="1 1 -1 []"><td>first</td>\r\n<td>second</td></tr>';
  assert.equal(normalizeClipboardHTML(html), '<tr data-pm-slice="1 1 -1 []"><td>first</td><td>second</td></tr>');
});

check("image sources and internal slice metadata survive", () => {
  const html = '<p data-pm-slice="1 1 []">first</p>\r\n<div><img src="data:image/png;base64,AAAA" alt="sample"></div>';
  assert.equal(normalizeClipboardHTML(html), html.replace("\r\n", ""));
});

check("Windows plain text matches LF for text, Markdown and code", () => {
  for (const text of ["first\nsecond", "first\n\nsecond", "## Heading\n\n- first\n- second", "```js\nfirst\n\n  second\n```", "first  \nsecond"]) {
    assert.deepEqual(paste({ text: text.replace(/\n/g, "\r\n") }), paste({ text }));
  }
  const content = { type: "doc", content: [{ type: "codeBlock" }] };
  assert.deepEqual(paste({ text: "first\r\n\r\n  second", content }), paste({ text: "first\n\n  second", content }));
});

console.log(`clipboard paste: ${checks} checks passed`);
