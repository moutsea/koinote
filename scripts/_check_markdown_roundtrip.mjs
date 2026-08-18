import assert from "node:assert/strict";
import { parseHTML } from "linkedom";

const { window: baseWindow } = parseHTML(
  "<html><head></head><body></body></html>",
);
const NativeDOMParser = baseWindow.DOMParser;

// tiptap-markdown parses fragments as a root <body>. Browsers expose that body
// through document.body; linkedom needs the surrounding <html> in this test.
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

const [
  { Editor },
  { default: StarterKit },
  { Markdown },
  { BlockMarkdownImage, normalizeLegacyImageAdjacentHeadings },
] = await Promise.all([
  import("@tiptap/core"),
  import("@tiptap/starter-kit"),
  import("tiptap-markdown"),
  import("./_markdown_image_bundle.mjs"),
]);

function saveTwice(markdown) {
  const editor = new Editor({
    element: null,
    extensions: [StarterKit, BlockMarkdownImage, Markdown],
  });
  editor.commands.setContent(markdown);
  const initialJSON = editor.getJSON();
  const first = editor.storage.markdown.getMarkdown();
  editor.commands.setContent(first);
  const secondJSON = editor.getJSON();
  const second = editor.storage.markdown.getMarkdown();
  editor.destroy();
  return { first, initialJSON, second, secondJSON };
}

const headingCase = saveTwice("![](https://img.test/a.png)\n\n## 下载\n\n正文");
assert.equal(
  headingCase.first,
  "![](https://img.test/a.png)\n\n## 下载\n\n正文",
);
assert.equal(headingCase.second, headingCase.first);
assert.deepEqual(
  headingCase.secondJSON.content.map((node) => node.type),
  ["image", "heading", "paragraph"],
);
assert.equal(headingCase.secondJSON.content[1].attrs.level, 2);

const paragraphCase = saveTwice(
  '![备注](https://img.test/a\\(1\\).png "标题")\n\n图片后的正文',
);
assert.equal(
  paragraphCase.first,
  '![备注](https://img.test/a\\(1\\).png "标题")\n\n图片后的正文',
);
assert.equal(paragraphCase.second, paragraphCase.first);
assert.deepEqual(
  paragraphCase.secondJSON.content.map((node) => node.type),
  ["image", "paragraph"],
);

const consecutiveImages = saveTwice(
  "![](https://img.test/a.png)\n\n![](https://img.test/b.png)",
);
assert.equal(
  consecutiveImages.first,
  "![](https://img.test/a.png)\n\n![](https://img.test/b.png)",
);
assert.equal(consecutiveImages.second, consecutiveImages.first);
assert.deepEqual(
  consecutiveImages.secondJSON.content.map((node) => node.type),
  ["image", "image"],
);

const legacyBroken = [
  "![](https://img.test/a.png)",
  "",
  "\\## 下载",
  "",
  "正文",
].join("\n");
const legacyNormalized = normalizeLegacyImageAdjacentHeadings(legacyBroken);
assert.equal(
  legacyNormalized,
  "![](https://img.test/a.png)\n\n## 下载\n\n正文",
);
assert.equal(
  normalizeLegacyImageAdjacentHeadings(legacyNormalized),
  legacyNormalized,
);
const legacyRoundTrip = saveTwice(legacyNormalized);
assert.deepEqual(
  legacyRoundTrip.secondJSON.content.map((node) => node.type),
  ["image", "heading", "paragraph"],
);
assert.equal(legacyRoundTrip.secondJSON.content[1].attrs.level, 2);

// 生产数据里真实出现过的形状：旧序列化器把图片与转义标题直接粘在同一行。
// 修复时不只去掉反斜杠，还必须补回块间空行，否则 ## 仍不会被解析成标题。
const legacySameLine =
  "![](https://img.test/a.png)\\## 下载\n\n正文\n\n" +
  "![](https://img.test/b.png)\\## 上公网\n\n更多正文";
const legacySameLineNormalized =
  normalizeLegacyImageAdjacentHeadings(legacySameLine);
assert.equal(
  legacySameLineNormalized,
  "![](https://img.test/a.png)\n\n## 下载\n\n正文\n\n" +
    "![](https://img.test/b.png)\n\n## 上公网\n\n更多正文",
);
const legacySameLineRoundTrip = saveTwice(legacySameLineNormalized);
assert.deepEqual(
  legacySameLineRoundTrip.secondJSON.content.map((node) => node.type),
  ["image", "heading", "paragraph", "image", "heading", "paragraph"],
);
assert.equal(legacySameLineRoundTrip.secondJSON.content[1].attrs.level, 2);
assert.equal(legacySameLineRoundTrip.secondJSON.content[4].attrs.level, 2);

// 另一种历史形状没有反斜杠：图片与标题被序列化到同一行，Markdown
// 解析器会把整行当成图片地址的一部分。兼容层也要把它恢复成两个块。
const legacyUnescapedSameLine =
  "![](https://img.test/a.png)## 下载\n\n正文\n\n" +
  "![](https://img.test/b.png)## 上公网\n\n更多正文";
const legacyUnescapedNormalized = normalizeLegacyImageAdjacentHeadings(
  legacyUnescapedSameLine,
);
assert.equal(
  legacyUnescapedNormalized,
  "![](https://img.test/a.png)\n\n## 下载\n\n正文\n\n" +
    "![](https://img.test/b.png)\n\n## 上公网\n\n更多正文",
);
const legacyUnescapedRoundTrip = saveTwice(legacyUnescapedNormalized);
assert.deepEqual(
  legacyUnescapedRoundTrip.secondJSON.content.map((node) => node.type),
  ["image", "heading", "paragraph", "image", "heading", "paragraph"],
);
assert.equal(legacyUnescapedRoundTrip.secondJSON.content[1].attrs.level, 2);
assert.equal(legacyUnescapedRoundTrip.secondJSON.content[4].attrs.level, 2);

const intentionalEscapedHeading = [
  "普通段落",
  "",
  "\\## 这是 Markdown 示例，不是标题",
].join("\n");
assert.equal(
  normalizeLegacyImageAdjacentHeadings(intentionalEscapedHeading),
  intentionalEscapedHeading,
);

console.log("markdown image round-trip checks passed");
