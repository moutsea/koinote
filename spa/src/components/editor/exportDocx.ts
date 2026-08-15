import {
  AlignmentType,
  BorderStyle,
  Document as DocxDocument,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";
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
 *  - 代码块只给等宽字体加浅灰底，不做语法高亮着色。
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

const ORDERED_NUMBERING = "koinote-ordered";
const MAX_IMAGE_WIDTH = 520; // 磅，A4 正文宽度上限

/** 行内标记 → TextRun 的样式 */
function inlineRuns(node: ProseMirrorNode): TextRun[] {
  const runs: TextRun[] = [];

  node.forEach((child) => {
    // 行内公式：保留 LaTeX 源码，用等宽字体标出它是公式
    if (child.type.name === "inlineMath") {
      const latex = (child.attrs.latex as string) ?? "";
      runs.push(new TextRun({ text: `$${latex}$`, font: "Consolas" }));
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

    runs.push(
      new TextRun({
        text: child.text ?? "",
        bold: marks.includes("bold"),
        italics: marks.includes("italic"),
        strike: marks.includes("strike"),
        underline: marks.includes("underline") ? {} : undefined,
        font: marks.includes("code") ? "Consolas" : undefined,
        shading: marks.includes("code")
          ? { type: ShadingType.CLEAR, fill: "F0F0F0" }
          : undefined,
        // Word 的超链接需要额外结构，这里退而把地址附在文字后，
        // 至少纸面与屏幕上都能看到指向哪里
        color: href ? "0563C1" : undefined,
      }),
    );
    if (href && href !== child.text) {
      runs.push(new TextRun({ text: ` (${href})`, size: 18, color: "666666" }));
    }
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
function imageSize(bytes: ArrayBuffer): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const blob = new Blob([bytes]);
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const ratio = img.height / (img.width || 1);
      const width = Math.min(img.width || MAX_IMAGE_WIDTH, MAX_IMAGE_WIDTH);
      resolve({ width, height: Math.round(width * ratio) });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      // 读不出尺寸就给个保守默认，不让导出中断
      resolve({ width: 360, height: 240 });
    };
    img.src = url;
  });
}

async function blockToDocx(
  node: ProseMirrorNode,
  fallbacks: { imageFailed: string },
): Promise<(Paragraph | Table)[]> {
  const name = node.type.name;

  if (name === "heading") {
    const level = (node.attrs.level as number) ?? 1;
    return [
      new Paragraph({
        heading: HEADING_LEVELS[level] ?? HeadingLevel.HEADING_6,
        children: inlineRuns(node),
      }),
    ];
  }

  if (name === "paragraph") {
    return [new Paragraph({ children: inlineRuns(node), spacing: { after: 160 } })];
  }

  if (name === "codeBlock") {
    // 每行一个段落：Word 里单段内的换行不会保留缩进结构
    const lines = node.textContent.split("\n");
    return lines.map(
      (line, index) =>
        new Paragraph({
          children: [new TextRun({ text: line || " ", font: "Consolas", size: 19 })],
          shading: { type: ShadingType.CLEAR, fill: "F6F8FA" },
          spacing: index === lines.length - 1 ? { after: 160 } : undefined,
        }),
    );
  }

  if (name === "blockMath") {
    return [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({
            text: `$$${(node.attrs.latex as string) ?? ""}$$`,
            font: "Consolas",
          }),
        ],
        spacing: { before: 120, after: 160 },
      }),
    ];
  }

  if (name === "blockquote") {
    const out: (Paragraph | Table)[] = [];
    for (let i = 0; i < node.childCount; i++) {
      out.push(
        new Paragraph({
          children: inlineRuns(node.child(i)),
          indent: { left: 480 },
          border: {
            left: { style: BorderStyle.SINGLE, size: 12, color: "D0D7DE", space: 12 },
          },
        }),
      );
    }
    return out;
  }

  if (name === "bulletList" || name === "orderedList") {
    const ordered = name === "orderedList";
    const out: Paragraph[] = [];
    node.forEach((item) => {
      item.forEach((child) => {
        if (child.type.name !== "paragraph") return;
        out.push(
          new Paragraph({
            children: inlineRuns(child),
            ...(ordered
              ? { numbering: { reference: ORDERED_NUMBERING, level: 0 } }
              : { bullet: { level: 0 } }),
          }),
        );
      });
    });
    return out;
  }

  if (name === "taskList") {
    const out: Paragraph[] = [];
    node.forEach((item) => {
      const checked = Boolean(item.attrs.checked);
      item.forEach((child) => {
        if (child.type.name !== "paragraph") return;
        out.push(
          new Paragraph({
            children: [
              new TextRun({ text: checked ? "☑ " : "☐ " }),
              ...inlineRuns(child),
            ],
            indent: { left: 360 },
          }),
        );
      });
    });
    return out;
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
              text: `[${fallbacks.imageFailed}: ${alt || src}]`,
              italics: true,
              color: "999999",
            }),
          ],
        }),
      ];
    }
    const { width, height } = await imageSize(bytes);
    const paragraphs: Paragraph[] = [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new ImageRun({
            data: bytes,
            transformation: { width, height },
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
          children: [new TextRun({ text: alt, size: 18, color: "666666" })],
          spacing: { after: 160 },
        }),
      );
    }
    return paragraphs;
  }

  if (name === "table") {
    const rows: TableRow[] = [];
    node.forEach((row) => {
      const cells: TableCell[] = [];
      row.forEach((cell) => {
        const children: Paragraph[] = [];
        cell.forEach((block) => {
          children.push(new Paragraph({ children: inlineRuns(block) }));
        });
        cells.push(
          new TableCell({
            children: children.length > 0 ? children : [new Paragraph("")],
            shading:
              cell.type.name === "tableHeader"
                ? { type: ShadingType.CLEAR, fill: "F2F2F2" }
                : undefined,
          }),
        );
      });
      rows.push(new TableRow({ children: cells }));
    });
    return rows.length > 0
      ? [new Table({ rows, width: { size: 100, type: WidthType.PERCENTAGE } })]
      : [];
  }

  if (name === "horizontalRule") {
    return [
      new Paragraph({
        children: [],
        border: {
          bottom: { style: BorderStyle.SINGLE, size: 6, color: "D0D7DE", space: 1 },
        },
        spacing: { before: 200, after: 200 },
      }),
    ];
  }

  // 未识别的块退化成纯文本，不静默丢内容
  const text = node.textContent.trim();
  return text ? [new Paragraph({ children: [new TextRun(text)] })] : [];
}

export async function buildDocx(
  editor: Editor,
  title: string,
  fallbacks: { imageFailed: string },
): Promise<Blob> {
  const blocks: (Paragraph | Table)[] = [];

  if (title.trim()) {
    blocks.push(
      new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(title)] }),
    );
  }

  const doc = editor.state.doc;
  for (let i = 0; i < doc.childCount; i++) {
    blocks.push(...(await blockToDocx(doc.child(i), fallbacks)));
  }

  const docx = new DocxDocument({
    numbering: {
      config: [
        {
          reference: ORDERED_NUMBERING,
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: "%1.",
              alignment: AlignmentType.START,
            },
          ],
        },
      ],
    },
    styles: {
      default: {
        document: {
          run: { font: "Calibri", size: 22 },
          paragraph: { spacing: { line: 320 } },
        },
      },
    },
    sections: [{ children: blocks }],
  });

  return Packer.toBlob(docx);
}
