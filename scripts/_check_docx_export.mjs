import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { Editor } from "@tiptap/core";
import Image from "@tiptap/extension-image";
import { TaskItem } from "@tiptap/extension-task-item";
import { TaskList } from "@tiptap/extension-task-list";
import StarterKit from "@tiptap/starter-kit";
import { Schema } from "@tiptap/pm/model";
import { unzipSync } from "fflate";
import { buildDocx } from "./_docx_export_bundle.mjs";

const paragraphs = Array.from({ length: 8 }, (_, index) => ({
  type: "paragraph",
  content: [
    {
      type: "text",
      text: `这是用于验证分页与正文节奏的第 ${index + 1} 段。Koinote should keep English and 中文 mixed text readable across Word and LibreOffice.`,
    },
  ],
}));

const editor = new Editor({
  extensions: [
    StarterKit,
    TaskList,
    TaskItem.configure({ nested: true }),
    Image.configure({ allowBase64: false }),
  ],
  content: {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text: "这是一段导语，包含 " },
          { type: "text", marks: [{ type: "bold" }], text: "重点" },
          { type: "text", text: "、" },
          { type: "text", marks: [{ type: "italic" }], text: "斜体" },
          { type: "text", text: "、" },
          { type: "text", marks: [{ type: "code" }], text: "inline code" },
          { type: "text", text: " 和 " },
          {
            type: "text",
            marks: [{ type: "link", attrs: { href: "https://koinote.app" } }],
            text: "Koinote 链接",
          },
          { type: "text", text: "。" },
        ],
      },
      {
        type: "heading",
        attrs: { level: 1 },
        content: [{ type: "text", text: "一级标题：信息层级" }],
      },
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "二级标题：列表" }],
      },
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "第一项需要清晰的悬挂缩进" }],
              },
            ],
          },
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "第二项包含嵌套列表" }],
              },
              {
                type: "bulletList",
                content: [
                  {
                    type: "listItem",
                    content: [
                      {
                        type: "paragraph",
                        content: [{ type: "text", text: "嵌套项目不能丢失" }],
                      },
                    ],
                  },
                ],
              },
              {
                type: "taskList",
                content: [
                  {
                    type: "taskItem",
                    attrs: { checked: false },
                    content: [
                      {
                        type: "paragraph",
                        content: [{ type: "text", text: "普通列表里的嵌套任务不能丢失" }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        type: "orderedList",
        attrs: { start: 3 },
        content: [
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "有序列表保留起始编号" }],
              },
            ],
          },
        ],
      },
      {
        type: "blockquote",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "排版的目标是让内容更容易理解。" }],
          },
        ],
      },
      {
        type: "codeBlock",
        attrs: { language: "typescript" },
        content: [
          {
            type: "text",
            text: "function greet(name: string) {\n  return `Hello, ${name}`;\n}",
          },
        ],
      },
      {
        type: "taskList",
        content: [
          {
            type: "taskItem",
            attrs: { checked: true },
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "完成排版检查" }],
              },
            ],
          },
          {
            type: "taskItem",
            attrs: { checked: false },
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "验证跨页效果" }],
              },
              {
                type: "bulletList",
                content: [
                  {
                    type: "listItem",
                    content: [
                      {
                        type: "paragraph",
                        content: [{ type: "text", text: "任务列表里的普通子项不能丢失" }],
                      },
                    ],
                  },
                ],
              },
              {
                type: "codeBlock",
                attrs: { language: "text" },
                content: [{ type: "text", text: "nested-list-code-block" }],
              },
              {
                type: "image",
                attrs: { src: "", alt: "嵌套图片占位" },
              },
            ],
          },
        ],
      },
      { type: "horizontalRule" },
      {
        type: "heading",
        attrs: { level: 3 },
        content: [{ type: "text", text: "长文分页" }],
      },
      ...paragraphs,
    ],
  },
});

try {
  const blob = await buildDocx(editor, "Koinote Word 导出排版测试", {
    imageFailed: "导出失败",
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const archive = unzipSync(bytes);
  const text = (path) => new TextDecoder().decode(archive[path]);
  const documentXml = text("word/document.xml");
  const stylesXml = text("word/styles.xml");
  const numberingXml = text("word/numbering.xml");
  const relationshipsXml = text("word/_rels/document.xml.rels");
  const footerXml = text("word/footer1.xml");

  assert.match(documentXml, /Koinote Word 导出排版测试/);
  assert.match(documentXml, /嵌套项目不能丢失/);
  assert.match(documentXml, /普通列表里的嵌套任务不能丢失/);
  assert.match(documentXml, /任务列表里的普通子项不能丢失/);
  assert.match(documentXml, /nested-list-code-block/);
  assert.match(documentXml, /嵌套图片占位/);
  assert.match(documentXml, /w:tblInd w:type="dxa" w:w="1080"/);
  assert.match(documentXml, /w:pgSz w:w="11906" w:h="16838"/);
  assert.match(documentXml, /w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/);
  assert.match(documentXml, /w:hyperlink[^>]+r:id=/);
  assert.match(stylesXml, /w:eastAsia="Arial Unicode MS"/);
  assert.match(stylesXml, /w:ascii="Arial Unicode MS"/);
  assert.match(stylesXml, /w:styleId="KoinoteQuote"/);
  assert.match(stylesXml, /w:styleId="KoinoteCode"/);
  assert.match(stylesXml, /w:styleId="KoinoteCaption"/);
  assert.match(numberingXml, /w:start w:val="3"/);
  assert.match(numberingXml, /w:lvl w:ilvl="1"/);
  assert.match(relationshipsXml, /Target="https:\/\/koinote\.app"/);
  assert.match(footerXml, /PAGE/);

  const tableSchema = new Schema({
    nodes: {
      doc: { content: "block+" },
      text: { group: "inline" },
      paragraph: { group: "block", content: "inline*" },
      table: { group: "block", content: "tableRow+" },
      tableRow: { content: "(tableHeader|tableCell)+" },
      tableHeader: {
        content: "paragraph+",
        attrs: { colspan: { default: 1 }, rowspan: { default: 1 } },
      },
      tableCell: {
        content: "paragraph+",
        attrs: { colspan: { default: 1 }, rowspan: { default: 1 } },
      },
    },
  });
  const tableDocument = tableSchema.nodeFromJSON({
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
                content: [{ type: "paragraph", content: [{ type: "text", text: "项目" }] }],
              },
              {
                type: "tableHeader",
                content: [{ type: "paragraph", content: [{ type: "text", text: "状态" }] }],
              },
            ],
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                attrs: { colspan: 2, rowspan: 1 },
                content: [
                  { type: "paragraph", content: [{ type: "text", text: "跨列内容" }] },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  const tableBlob = await buildDocx(
    { state: { doc: tableDocument } },
    "",
    { imageFailed: "导出失败" },
  );
  const tableArchive = unzipSync(new Uint8Array(await tableBlob.arrayBuffer()));
  const tableXml = new TextDecoder().decode(tableArchive["word/document.xml"]);
  assert.match(tableXml, /w:tblW w:type="dxa" w:w="9026"/);
  assert.match(tableXml, /w:gridCol w:w="4513"/);
  assert.match(tableXml, /w:gridSpan w:val="2"/);
  assert.match(tableXml, /w:tblHeader/);
  assert.match(tableXml, /w:cantSplit/);
  assert.doesNotMatch(tableXml, /w:tblInd/);

  if (process.env.DOCX_FIXTURE_OUTPUT) {
    await writeFile(process.env.DOCX_FIXTURE_OUTPUT, bytes);
  }

  console.log("docx export checks passed");
} finally {
  editor.destroy();
}
