import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  { TableCell, TableHeader, TableRow },
  { Markdown },
  { MarkdownTable },
  { BlockMarkdownImage, normalizeLegacyImageAdjacentHeadings },
] = await Promise.all([
  import("@tiptap/core"),
  import("@tiptap/starter-kit"),
  import("@tiptap/extension-table"),
  import("tiptap-markdown"),
  import("./_markdown_table_bundle.mjs"),
  import("./_markdown_image_bundle.mjs"),
]);

function saveTwice(markdown) {
  const editor = new Editor({
    element: null,
    extensions: [
      StarterKit,
      MarkdownTable,
      TableRow,
      TableHeader,
      TableCell,
      BlockMarkdownImage,
      Markdown.configure({ html: false }),
    ],
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

function saveDocumentTwice(json) {
  const editor = new Editor({
    element: null,
    extensions: [
      StarterKit,
      MarkdownTable,
      TableRow,
      TableHeader,
      TableCell,
      BlockMarkdownImage,
      Markdown.configure({ html: false }),
    ],
  });
  editor.commands.setContent(json);
  const first = editor.storage.markdown.getMarkdown();
  const firstJSON = editor.getJSON();
  editor.commands.setContent(first);
  const second = editor.storage.markdown.getMarkdown();
  const secondJSON = editor.getJSON();
  editor.destroy();
  return { first, firstJSON, second, secondJSON };
}

const extensionsSource = readFileSync(
  new URL("../spa/src/components/editor/extensions.ts", import.meta.url),
  "utf8",
);
assert.match(extensionsSource, /MarkdownTable/);
assert.match(
  extensionsSource,
  /MarkdownTable\.configure\([\s\S]*?\),\s*TableRow,\s*TableHeader,\s*TableCell,/,
);

const tableCase = saveTwice(
  "| 名称 | 数量 | 备注 |\n| :--- | ---: | :---: |\n| 铅笔 | 2 | 日常使用 |\n| 橡皮 | 1 | 备用 |");
assert.equal(
  tableCase.first,
  "| 名称 | 数量 | 备注 |\n| :-- | --: | :--: |\n| 铅笔 | 2 | 日常使用 |\n| 橡皮 | 1 | 备用 |\n",
);
assert.equal(tableCase.second, tableCase.first);
assert.deepEqual(tableCase.secondJSON.content.map((node) => node.type), ["table"]);
assert.deepEqual(
  tableCase.secondJSON.content[0].content[0].content.map((cell) => cell.type),
  ["tableHeader", "tableHeader", "tableHeader"],
);
assert.equal(
  tableCase.secondJSON.content[0].content[1].content[0].content[0].content[0].text,
  "铅笔",
);

const escapedPipeTable = saveTwice(
  "| 名称 | 说明 |\n| --- | --- |\n| 项目 | 含有 \\| 分隔符 |",
);
assert.match(escapedPipeTable.first, /含有 \\\| 分隔符/);
assert.equal(escapedPipeTable.second, escapedPipeTable.first);

function tableWithCellText(text) {
  return saveDocumentTwice({
    type: "doc",
    content: [
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableHeader",
                content: [{ type: "paragraph", content: [{ type: "text", text: "标题" }] }],
              },
              {
                type: "tableHeader",
                content: [{ type: "paragraph", content: [{ type: "text", text: "内容" }] }],
              },
            ],
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                content: [{ type: "paragraph", content: [{ type: "text", text }] }],
              },
              {
                type: "tableCell",
                content: [{ type: "paragraph", content: [{ type: "text", text: "旁边" }] }],
              },
            ],
          },
        ],
      },
    ],
  });
}

for (const text of ["a|b", "a\\|b", "a\\\\|b"]) {
  const pipeCase = tableWithCellText(text);
  assert.equal(pipeCase.second, pipeCase.first);
  assert.equal(
    pipeCase.secondJSON.content[0].content[1].content[0].content[0].content[0].text,
    text,
  );
}

const complexTable = saveDocumentTwice({
  type: "doc",
  content: [
    {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            {
              type: "tableHeader",
              content: [{ type: "paragraph", content: [{ type: "text", text: "标题" }] }],
            },
            {
              type: "tableHeader",
              content: [{ type: "paragraph", content: [{ type: "text", text: "内容" }] }],
            },
          ],
        },
        {
          type: "tableRow",
          content: [
            {
              type: "tableCell",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "第一段" }] },
                { type: "paragraph", content: [{ type: "text", text: "第二段" }] },
              ],
            },
            {
              type: "tableCell",
              content: [
                {
                  type: "paragraph",
                  content: [
                    { type: "text", text: "上" },
                    { type: "hardBreak" },
                    { type: "text", text: "下" },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: "tableRow",
          content: [
            {
              type: "tableCell",
              content: [
                {
                  type: "image",
                  attrs: { src: "https://i.test/a.png", alt: "alt", title: null },
                },
              ],
            },
            {
              type: "tableCell",
              content: [{ type: "paragraph", content: [{ type: "text", text: "文本" }] }],
            },
          ],
        },
      ],
    },
  ],
});
assert.doesNotMatch(complexTable.first, /\[(?:table|hardBreak)\]/);
assert.match(complexTable.first, /第一段 第二段/);
assert.match(complexTable.first, /上 下/);
assert.match(complexTable.first, /!\[alt\]\(https:\/\/i\.test\/a\.png\)/);
assert.equal(complexTable.second, complexTable.first);

const colspanTable = saveDocumentTwice({
  type: "doc",
  content: [
    {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            {
              type: "tableHeader",
              attrs: { colspan: 2 },
              content: [{ type: "paragraph", content: [{ type: "text", text: "跨列标题" }] }],
            },
          ],
        },
        {
          type: "tableRow",
          content: [
            { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "左" }] }] },
            { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "右" }] }] },
          ],
        },
      ],
    },
  ],
});
assert.doesNotMatch(colspanTable.first, /\[table\]/);
assert.match(colspanTable.first, /跨列标题/);
assert.equal(colspanTable.second, colspanTable.first);

const rowspanTable = saveDocumentTwice({
  type: "doc",
  content: [
    {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            {
              type: "tableHeader",
              content: [{ type: "paragraph", content: [{ type: "text", text: "标题 1" }] }],
            },
            {
              type: "tableHeader",
              content: [{ type: "paragraph", content: [{ type: "text", text: "标题 2" }] }],
            },
          ],
        },
        {
          type: "tableRow",
          content: [
            {
              type: "tableCell",
              attrs: { rowspan: 2 },
              content: [{ type: "paragraph", content: [{ type: "text", text: "跨两行" }] }],
            },
            {
              type: "tableCell",
              content: [{ type: "paragraph", content: [{ type: "text", text: "b1" }] }],
            },
          ],
        },
        {
          type: "tableRow",
          content: [
            {
              type: "tableCell",
              content: [{ type: "paragraph", content: [{ type: "text", text: "b2" }] }],
            },
          ],
        },
      ],
    },
  ],
});
assert.match(rowspanTable.first, /\|  \| b2 \|/);
assert.equal(rowspanTable.second, rowspanTable.first);

const emptyHeaderTable = saveDocumentTwice({
  type: "doc",
  content: [
    {
      type: "table",
      content: [
        { type: "tableRow", content: [] },
        {
          type: "tableRow",
          content: [
            { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "左" }] }] },
            { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "右" }] }] },
          ],
        },
      ],
    },
  ],
});
assert.match(emptyHeaderTable.first, /^\|  \|  \|\n\| --- \| --- \|/);
assert.equal(emptyHeaderTable.second, emptyHeaderTable.first);

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

console.log("markdown round-trip checks passed");
