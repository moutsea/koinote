import {
  AlignmentType,
  BorderStyle,
  Document as DocxDocument,
  ExternalHyperlink,
  Footer,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  LineRuleType,
  PageNumber,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlignTable,
  WidthType,
} from "docx";
import type { ILevelsOptions, ParagraphChild } from "docx";
import type { Editor } from "@tiptap/react";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { fetchAppResource } from "../../api";
import { imageFetchURL } from "./imageLoading";

/**
 * 导出 .docx。
 *
 * 走 ProseMirror 文档树而非解析 Markdown 文本：树里已有确定的结构与标记，
 * 再解析一遍 Markdown 等于把已知信息丢掉重新猜。
 *
 * 明确的降级取舍：
 *  - 公式保留为 LaTeX 源文本。转成 Word 的 OMML 是另一个量级的工作，
 *    而保留源码至少无损、可读、可再加工。
 *  - 代码块使用等宽字体、浅色底与左侧强调线，不做语法高亮着色。
 *  - 图片逐张抓取内嵌；单张失败只留占位行，不让整个导出失败。
 */

const HEADING_LEVELS: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6,
};

const BODY_FONT = {
  ascii: "Arial Unicode MS",
  hAnsi: "Arial Unicode MS",
  eastAsia: "Arial Unicode MS",
  cs: "Arial Unicode MS",
};
const CODE_FONT = {
  ascii: "Consolas",
  hAnsi: "Consolas",
  eastAsia: "Arial Unicode MS",
  cs: "Consolas",
};
const PAGE_WIDTH = 11_906;
const PAGE_HEIGHT = 16_838;
const PAGE_MARGIN = 1_440;
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
const TABLE_CELL_MARGIN_HORIZONTAL = 120;
const MAX_IMAGE_WIDTH = 560;
const MAX_IMAGE_HEIGHT = 720;
const MAX_LIST_DEPTH = 5;
const BODY_LINE_SPACING = 320;
const INK = "1F2328";
const INK_STRONG = "34383F";
const INK_MID = "626872";
const INK_FAINT = "949AA3";
const INK_LINE = "DDD8CB";
const INK_WASH = "F6F4EE";
const PAPER_SOFT = "FDFCF9";
const CINNABAR = "B93B28";
const LINK_BLUE = "0969DA";
const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

type NumberingConfig = {
  reference: string;
  levels: ILevelsOptions[];
};

type DocxBuildContext = {
  fallbacks: { imageFailed: string };
  numbering: NumberingConfig[];
  nextListId: number;
};

type DocxBlock = Paragraph | Table;

function codeFontFor(text: string) {
  return CJK_PATTERN.test(text) ? BODY_FONT : CODE_FONT;
}

/** 行内标记 → TextRun 的样式 */
function inlineRuns(node: ProseMirrorNode): ParagraphChild[] {
  const runs: ParagraphChild[] = [];

  node.forEach((child) => {
    // 行内公式：保留 LaTeX 源码，用等宽字体标出它是公式
    if (child.type.name === "inlineMath") {
      const latex = (child.attrs.latex as string) ?? "";
      runs.push(
        new TextRun({
          text: `$${latex}$`,
          font: CODE_FONT,
          color: INK_STRONG,
          noProof: true,
        }),
      );
      return;
    }

    if (!child.isText) {
      // 硬换行等原子节点
      if (child.type.name === "hardBreak") {
        runs.push(new TextRun({ text: "", break: 1 }));
      }
      return;
    }

    const marks = child.marks.map((m) => m.type.name);
    const linkMark = child.marks.find((m) => m.type.name === "link");
    const href = linkMark?.attrs.href as string | undefined;

    const run = new TextRun({
      text: child.text ?? "",
      bold: marks.includes("bold") || undefined,
      italics: marks.includes("italic") || undefined,
      strike: marks.includes("strike") || undefined,
      underline: marks.includes("underline") ? {} : undefined,
      font: marks.includes("code") ? codeFontFor(child.text ?? "") : undefined,
      color: href ? LINK_BLUE : undefined,
      noProof: marks.includes("code") || undefined,
      shading: marks.includes("code")
        ? { type: ShadingType.CLEAR, fill: "F0F0F0" }
        : undefined,
    });
    runs.push(href ? new ExternalHyperlink({ children: [run], link: href }) : run);
  });

  return runs;
}

/**
 * 按文件头判断图片类型。
 * docx 要求显式声明类型，写错（比如把 JPEG 标成 png）会产出打不开的文档，
 * 所以不能照抄 URL 后缀或服务端声明的 Content-Type。
 */
function sniffImageType(bytes: ArrayBuffer): "png" | "jpg" | "gif" | "bmp" | null {
  const head = new Uint8Array(bytes.slice(0, 12));
  const startsWith = (...sig: number[]) => sig.every((b, i) => head[i] === b);

  if (startsWith(0x89, 0x50, 0x4e, 0x47)) return "png";
  if (startsWith(0xff, 0xd8, 0xff)) return "jpg";
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return "gif";
  if (startsWith(0x42, 0x4d)) return "bmp";
  // WebP 是 RIFF....WEBP。docx v9 的 ImageRun 不支持 webp，
  // 返回 null 走占位降级，比塞进去产出坏文档好。
  return null;
}

/** 抓图片字节。失败返回 null，由调用方降级成占位文字。 */
async function fetchImage(src: string): Promise<ArrayBuffer | null> {
  try {
    const response = await fetchAppResource(imageFetchURL(src), {
      credentials: "include",
    });
    if (!response.ok) return null;
    return await response.arrayBuffer();
  } catch {
    return null;
  }
}

/** 读出图片像素尺寸，按正文宽度等比缩放 */
function imageSize(
  bytes: ArrayBuffer,
  maxWidth = MAX_IMAGE_WIDTH,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const blob = new Blob([bytes]);
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const sourceWidth = img.width || MAX_IMAGE_WIDTH;
      const sourceHeight = img.height || Math.round(sourceWidth * 0.667);
      const scale = Math.min(
        1,
        maxWidth / sourceWidth,
        MAX_IMAGE_HEIGHT / sourceHeight,
      );
      resolve({
        width: Math.max(1, Math.round(sourceWidth * scale)),
        height: Math.max(1, Math.round(sourceHeight * scale)),
      });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      // 读不出尺寸就给个保守默认，不让导出中断
      resolve({ width: 360, height: 240 });
    };
    img.src = url;
  });
}

function listIndent(level: number) {
  return {
    marker: 360 + Math.min(level, MAX_LIST_DEPTH) * 360,
    text: 720 + Math.min(level, MAX_LIST_DEPTH) * 360,
  };
}

function listLevels(ordered: boolean, start: number): ILevelsOptions[] {
  const bulletMarkers = ["•", "◦", "▪"];
  return Array.from({ length: MAX_LIST_DEPTH + 1 }, (_, level) => {
    const indent = listIndent(level);
    return {
      level,
      format: ordered ? LevelFormat.DECIMAL : LevelFormat.BULLET,
      text: ordered ? `%${level + 1}.` : bulletMarkers[level % bulletMarkers.length],
      alignment: AlignmentType.START,
      start,
      style: {
        run: {
          font: BODY_FONT,
          color: INK_STRONG,
        },
        paragraph: {
          indent: { start: indent.text, hanging: indent.text - indent.marker },
          leftTabStop: indent.text,
          spacing: {
            after: 80,
            line: 280,
            lineRule: LineRuleType.AUTO,
          },
        },
      },
    };
  });
}

function registerList(
  context: DocxBuildContext,
  ordered: boolean,
  start: number,
): string {
  const reference = `koinote-${ordered ? "ordered" : "bullet"}-${context.nextListId}`;
  context.nextListId += 1;
  context.numbering.push({ reference, levels: listLevels(ordered, start) });
  return reference;
}

async function listToDocx(
  node: ProseMirrorNode,
  ordered: boolean,
  level: number,
  context: DocxBuildContext,
): Promise<DocxBlock[]> {
  const reference = registerList(
    context,
    ordered,
    Math.max(1, Number(node.attrs.start) || 1),
  );
  const out: DocxBlock[] = [];

  for (let itemIndex = 0; itemIndex < node.childCount; itemIndex += 1) {
    const item = node.child(itemIndex);
    let hasMarker = false;
    for (let childIndex = 0; childIndex < item.childCount; childIndex += 1) {
      const child = item.child(childIndex);
      if (child.type.name === "paragraph") {
        const indent = listIndent(level);
        out.push(
          new Paragraph({
            children: inlineRuns(child),
            ...(hasMarker
              ? { indent: { start: indent.text } }
              : {
                  numbering: {
                    reference,
                    level: Math.min(level, MAX_LIST_DEPTH),
                  },
                }),
            spacing: {
              after: 80,
              line: 280,
              lineRule: LineRuleType.AUTO,
            },
            widowControl: true,
          }),
        );
        hasMarker = true;
        continue;
      }
      out.push(...(await nestedListItemBlockToDocx(child, level + 1, context)));
    }
  }

  return out;
}

async function taskListToDocx(
  node: ProseMirrorNode,
  level: number,
  context: DocxBuildContext,
): Promise<DocxBlock[]> {
  const out: DocxBlock[] = [];
  for (let itemIndex = 0; itemIndex < node.childCount; itemIndex += 1) {
    const item = node.child(itemIndex);
    const checked = Boolean(item.attrs.checked);
    let hasMarker = false;
    for (let childIndex = 0; childIndex < item.childCount; childIndex += 1) {
      const child = item.child(childIndex);
      if (child.type.name === "paragraph") {
        const indent = listIndent(level);
        out.push(
          new Paragraph({
            children: [
              ...(hasMarker
                ? []
                : [
                    new TextRun({
                      text: checked ? "☑\u00a0 " : "☐\u00a0 ",
                      font: BODY_FONT,
                      color: checked ? CINNABAR : INK_MID,
                    }),
                  ]),
              ...inlineRuns(child),
            ],
            indent: hasMarker
              ? { start: indent.text }
              : { start: indent.text, hanging: indent.text - indent.marker },
            spacing: {
              after: 80,
              line: 280,
              lineRule: LineRuleType.AUTO,
            },
            widowControl: true,
          }),
        );
        hasMarker = true;
        continue;
      }
      out.push(...(await nestedListItemBlockToDocx(child, level + 1, context)));
    }
  }
  return out;
}

async function nestedListItemBlockToDocx(
  node: ProseMirrorNode,
  level: number,
  context: DocxBuildContext,
): Promise<DocxBlock[]> {
  if (node.type.name === "bulletList" || node.type.name === "orderedList") {
    return listToDocx(node, node.type.name === "orderedList", level, context);
  }
  if (node.type.name === "taskList") {
    return taskListToDocx(node, level, context);
  }
  return blockToDocx(node, context, listIndent(level).text);
}

function contentWidthForIndent(indentStart: number) {
  return Math.max(1_440, CONTENT_WIDTH - Math.max(0, indentStart));
}

function tableColumnWidths(columnCount: number, contentWidth = CONTENT_WIDTH): number[] {
  const base = Math.floor(contentWidth / columnCount);
  const widths = Array.from({ length: columnCount }, () => base);
  widths[widths.length - 1] += contentWidth - base * columnCount;
  return widths;
}

async function blockToDocx(
  node: ProseMirrorNode,
  context: DocxBuildContext,
  indentStart = 0,
): Promise<DocxBlock[]> {
  const name = node.type.name;
  const contentWidth = contentWidthForIndent(indentStart);
  const paragraphIndent = indentStart > 0 ? { start: indentStart } : undefined;

  if (name === "heading") {
    const level = (node.attrs.level as number) ?? 1;
    return [
      new Paragraph({
        heading: HEADING_LEVELS[level] ?? HeadingLevel.HEADING_6,
        children: inlineRuns(node),
        indent: paragraphIndent,
      }),
    ];
  }

  if (name === "paragraph") {
    return [
      new Paragraph({
        children: inlineRuns(node),
        indent: paragraphIndent,
        widowControl: true,
      }),
    ];
  }

  if (name === "codeBlock") {
    const lines = node.textContent.split("\n");
    return [
      new Table({
        rows: [
          new TableRow({
            children: [
              new TableCell({
                width: { size: contentWidth, type: WidthType.DXA },
                margins: { top: 140, bottom: 140, left: 180, right: 180 },
                shading: { type: ShadingType.CLEAR, fill: "F6F8FA" },
                borders: {
                  top: { style: BorderStyle.NONE },
                  bottom: { style: BorderStyle.NONE },
                  left: { style: BorderStyle.SINGLE, size: 14, color: CINNABAR },
                  right: { style: BorderStyle.NONE },
                },
                children: lines.map(
                  (line) =>
                    new Paragraph({
                      style: "KoinoteCode",
                      children: [
                        new TextRun({
                          text: line || " ",
                          font: codeFontFor(line),
                          size: 19,
                          noProof: true,
                          color: INK_STRONG,
                        }),
                      ],
                    }),
                ),
              }),
            ],
          }),
        ],
        width: { size: contentWidth, type: WidthType.DXA },
        columnWidths: [contentWidth],
        indent:
          indentStart > 0
            ? { size: indentStart, type: WidthType.DXA }
            : undefined,
        layout: TableLayoutType.FIXED,
        borders: {
          top: { style: BorderStyle.NONE },
          bottom: { style: BorderStyle.NONE },
          left: { style: BorderStyle.NONE },
          right: { style: BorderStyle.NONE },
          insideHorizontal: { style: BorderStyle.NONE },
          insideVertical: { style: BorderStyle.NONE },
        },
      }),
    ];
  }

  if (name === "blockMath") {
    return [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({
            text: `$$${(node.attrs.latex as string) ?? ""}$$`,
            font: CODE_FONT,
            color: INK_STRONG,
            noProof: true,
          }),
        ],
        spacing: { before: 120, after: 160 },
        indent: paragraphIndent,
      }),
    ];
  }

  if (name === "blockquote") {
    const out: (Paragraph | Table)[] = [];
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child.type.name !== "paragraph" && child.type.name !== "heading") continue;
      out.push(
        new Paragraph({
          style: "KoinoteQuote",
          children: inlineRuns(child),
          indent:
            indentStart > 0
              ? { start: indentStart + 420, end: 120 }
              : undefined,
        }),
      );
    }
    return out;
  }

  if (name === "bulletList" || name === "orderedList") {
    return listToDocx(node, name === "orderedList", 0, context);
  }

  if (name === "taskList") {
    return taskListToDocx(node, 0, context);
  }

  if (name === "image") {
    const src = (node.attrs.src as string) ?? "";
    const alt = (node.attrs.alt as string) ?? "";
    const bytes = src ? await fetchImage(src) : null;
    const imageType = bytes ? sniffImageType(bytes) : null;
    // 抓不到、或类型不被 docx 支持（如 webp），都降级成占位行
    if (!bytes || !imageType) {
      return [
        new Paragraph({
          children: [
            new TextRun({
              text: `[${context.fallbacks.imageFailed}: ${alt || src}]`,
              italics: true,
              color: INK_FAINT,
              font: BODY_FONT,
            }),
          ],
          indent: paragraphIndent,
        }),
      ];
    }
    const imageMaxWidth = Math.min(
      MAX_IMAGE_WIDTH,
      Math.max(1, Math.floor(contentWidth / 15)),
    );
    const { width, height } = await imageSize(bytes, imageMaxWidth);
    const paragraphs: Paragraph[] = [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 120, after: alt ? 40 : 180 },
        indent: paragraphIndent,
        keepNext: Boolean(alt),
        children: [
          new ImageRun({
            data: bytes,
            transformation: { width, height },
            altText: {
              name: alt || "Koinote image",
              description: alt || src,
            },
            // 类型来自文件头嗅探，不信 URL 后缀也不信服务端声明
            type: imageType,
          }),
        ],
      }),
    ];
    if (alt) {
      paragraphs.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          style: "KoinoteCaption",
          indent: paragraphIndent,
          children: [new TextRun({ text: alt, font: BODY_FONT })],
        }),
      );
    }
    return paragraphs;
  }

  if (name === "table") {
    let columnCount = 0;
    node.forEach((row) => {
      let rowColumns = 0;
      row.forEach((cell) => {
        rowColumns += Math.max(1, Number(cell.attrs.colspan) || 1);
      });
      columnCount = Math.max(columnCount, rowColumns);
    });
    if (columnCount === 0) return [];

    const columnWidths = tableColumnWidths(columnCount, contentWidth);
    const rows: TableRow[] = [];
    node.forEach((row) => {
      const cells: TableCell[] = [];
      let columnIndex = 0;
      let headerRow = true;
      row.forEach((cell) => {
        const columnSpan = Math.max(1, Number(cell.attrs.colspan) || 1);
        const rowSpan = Math.max(1, Number(cell.attrs.rowspan) || 1);
        const cellWidth = columnWidths
          .slice(columnIndex, columnIndex + columnSpan)
          .reduce((sum, width) => sum + width, 0);
        columnIndex += columnSpan;
        headerRow = headerRow && cell.type.name === "tableHeader";
        const children: Paragraph[] = [];
        cell.forEach((block) => {
          children.push(
            new Paragraph({
              style: "KoinoteTableText",
              children: inlineRuns(block),
            }),
          );
        });
        cells.push(
          new TableCell({
            children: children.length > 0 ? children : [new Paragraph("")],
            width: { size: cellWidth, type: WidthType.DXA },
            columnSpan: columnSpan > 1 ? columnSpan : undefined,
            rowSpan: rowSpan > 1 ? rowSpan : undefined,
            verticalAlign: VerticalAlignTable.CENTER,
            margins: {
              top: 100,
              bottom: 100,
              left: TABLE_CELL_MARGIN_HORIZONTAL,
              right: TABLE_CELL_MARGIN_HORIZONTAL,
            },
            shading:
              cell.type.name === "tableHeader"
                ? { type: ShadingType.CLEAR, fill: INK_WASH }
                : undefined,
          }),
        );
      });
      rows.push(
        new TableRow({
          children: cells,
          tableHeader: headerRow,
          cantSplit: true,
        }),
      );
    });
    return rows.length > 0
      ? [
          new Table({
            rows,
            width: { size: contentWidth, type: WidthType.DXA },
            columnWidths,
            indent:
              indentStart > 0
                ? { size: indentStart, type: WidthType.DXA }
                : undefined,
            layout: TableLayoutType.FIXED,
            margins: {
              top: 100,
              bottom: 100,
              left: TABLE_CELL_MARGIN_HORIZONTAL,
              right: TABLE_CELL_MARGIN_HORIZONTAL,
            },
            borders: {
              top: { style: BorderStyle.SINGLE, size: 4, color: INK_LINE },
              bottom: { style: BorderStyle.SINGLE, size: 4, color: INK_LINE },
              left: { style: BorderStyle.SINGLE, size: 4, color: INK_LINE },
              right: { style: BorderStyle.SINGLE, size: 4, color: INK_LINE },
              insideHorizontal: {
                style: BorderStyle.SINGLE,
                size: 4,
                color: INK_LINE,
              },
              insideVertical: {
                style: BorderStyle.SINGLE,
                size: 4,
                color: INK_LINE,
              },
            },
          }),
        ]
      : [];
  }

  if (name === "horizontalRule") {
    return [
      new Paragraph({
        children: [],
        border: {
          bottom: { style: BorderStyle.SINGLE, size: 6, color: INK_LINE, space: 1 },
        },
        spacing: { before: 200, after: 200 },
        indent: paragraphIndent,
      }),
    ];
  }

  // 未识别的块退化成纯文本，不静默丢内容
  const text = node.textContent.trim();
  return text
    ? [
        new Paragraph({
          children: [new TextRun({ text, font: BODY_FONT, color: INK })],
          indent: paragraphIndent,
          widowControl: true,
        }),
      ]
    : [];
}

export async function buildDocx(
  editor: Editor,
  title: string,
  fallbacks: { imageFailed: string },
): Promise<Blob> {
  const blocks: DocxBlock[] = [];
  const context: DocxBuildContext = {
    fallbacks,
    numbering: [],
    nextListId: 1,
  };

  if (title.trim()) {
    blocks.push(
      new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(title)] }),
    );
  }

  const doc = editor.state.doc;
  for (let i = 0; i < doc.childCount; i++) {
    blocks.push(...(await blockToDocx(doc.child(i), context)));
  }

  const docx = new DocxDocument({
    title: title.trim() || undefined,
    creator: "Koinote",
    description: "Exported from Koinote",
    numbering: { config: context.numbering },
    styles: {
      default: {
        document: {
          run: { font: BODY_FONT, size: 22, color: INK, language: { eastAsia: "zh-CN" } },
          paragraph: {
            spacing: {
              after: 140,
              line: BODY_LINE_SPACING,
              lineRule: LineRuleType.AUTO,
            },
          },
        },
        title: {
          run: { font: BODY_FONT, size: 56, bold: true, color: INK },
          paragraph: {
            spacing: { before: 0, after: 320, line: 360, lineRule: LineRuleType.AUTO },
            keepNext: true,
            border: {
              bottom: { style: BorderStyle.SINGLE, size: 10, color: CINNABAR, space: 10 },
            },
          },
        },
        heading1: {
          run: { font: BODY_FONT, size: 34, bold: true, color: CINNABAR },
          paragraph: {
            spacing: { before: 320, after: 160, line: 320, lineRule: LineRuleType.AUTO },
            keepNext: true,
            keepLines: true,
            outlineLevel: 0,
          },
        },
        heading2: {
          run: { font: BODY_FONT, size: 28, bold: true, color: INK_STRONG },
          paragraph: {
            spacing: { before: 260, after: 120, line: 300, lineRule: LineRuleType.AUTO },
            keepNext: true,
            keepLines: true,
            outlineLevel: 1,
          },
        },
        heading3: {
          run: { font: BODY_FONT, size: 24, bold: true, color: INK_STRONG },
          paragraph: {
            spacing: { before: 200, after: 100, line: 290, lineRule: LineRuleType.AUTO },
            keepNext: true,
            keepLines: true,
            outlineLevel: 2,
          },
        },
        heading4: {
          run: { font: BODY_FONT, size: 22, bold: true, color: INK_MID },
          paragraph: {
            spacing: { before: 160, after: 80 },
            keepNext: true,
            keepLines: true,
            outlineLevel: 3,
          },
        },
        heading5: {
          run: { font: BODY_FONT, size: 21, bold: true, color: INK_MID },
          paragraph: {
            spacing: { before: 140, after: 60 },
            keepNext: true,
            keepLines: true,
            outlineLevel: 4,
          },
        },
        heading6: {
          run: { font: BODY_FONT, size: 20, bold: true, color: INK_MID },
          paragraph: {
            spacing: { before: 120, after: 60 },
            keepNext: true,
            keepLines: true,
            outlineLevel: 5,
          },
        },
        hyperlink: {
          run: { font: BODY_FONT, color: LINK_BLUE, underline: {} },
        },
      },
      paragraphStyles: [
        {
          id: "KoinoteQuote",
          name: "Koinote Quote",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { font: BODY_FONT, color: INK_MID, italics: true },
          paragraph: {
            indent: { start: 420, end: 120 },
            spacing: {
              before: 40,
              after: 100,
              line: 300,
              lineRule: LineRuleType.AUTO,
            },
            border: {
              left: { style: BorderStyle.SINGLE, size: 14, color: CINNABAR, space: 14 },
            },
            shading: { type: ShadingType.CLEAR, fill: PAPER_SOFT },
            keepLines: true,
          },
        },
        {
          id: "KoinoteCode",
          name: "Koinote Code",
          basedOn: "Normal",
          next: "KoinoteCode",
          quickFormat: true,
          run: { font: CODE_FONT, size: 19, color: INK_STRONG, noProof: true },
          paragraph: {
            spacing: { before: 0, after: 0, line: 280, lineRule: LineRuleType.AUTO },
            keepLines: true,
          },
        },
        {
          id: "KoinoteCaption",
          name: "Koinote Caption",
          basedOn: "Normal",
          next: "Normal",
          quickFormat: true,
          run: { font: BODY_FONT, size: 18, color: INK_MID, italics: true },
          paragraph: {
            alignment: AlignmentType.CENTER,
            spacing: { before: 0, after: 180, line: 260, lineRule: LineRuleType.AUTO },
            keepLines: true,
          },
        },
        {
          id: "KoinoteTableText",
          name: "Koinote Table Text",
          basedOn: "Normal",
          next: "KoinoteTableText",
          quickFormat: true,
          run: { font: BODY_FONT, size: 20, color: INK },
          paragraph: {
            spacing: { before: 0, after: 40, line: 280, lineRule: LineRuleType.AUTO },
          },
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
            margin: {
              top: PAGE_MARGIN,
              right: PAGE_MARGIN,
              bottom: PAGE_MARGIN,
              left: PAGE_MARGIN,
              header: 708,
              footer: 708,
            },
          },
        },
        footers: {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({
                    children: [PageNumber.CURRENT],
                    font: BODY_FONT,
                    size: 18,
                    color: INK_FAINT,
                  }),
                ],
              }),
            ],
          }),
        },
        children: blocks,
      },
    ],
  });

  return Packer.toBlob(docx);
}
