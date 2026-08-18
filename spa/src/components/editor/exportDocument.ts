import type { Editor } from "@tiptap/react";
import { EXPORT_BASE_CSS, EXPORT_DARK_CSS } from "./exportStyles";
import { highlightCodeBlocks } from "./highlightCode";
import { renderMathInHTML } from "./renderMath";
import { isDesktopRuntime } from "../../desktop/runtime";

/** 文档导出。PDF 统一走系统打印管道，保留可选择、可搜索的矢量文字。 */

/** 字符串进、字符串出地补高亮。HTML 导出走的是字符串拼接，不经过 DOM 舞台。 */
function withHighlightedCode(html: string): string {
  const holder = document.createElement("div");
  holder.innerHTML = html;
  highlightCodeBlocks(holder);
  return holder.innerHTML;
}

/** 触发浏览器下载。用完即释放 objectURL，否则整页存活期间都占着内存。 */
export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 标题转文件名：剔除路径分隔符与控制字符，避免生成非法文件名 */
export function safeFilename(title: string, fallback: string): string {
  const cleaned = title
    .replace(/\s+/g, " ") // 先归一空白：制表与换行变空格而非被删掉
    .replace(/[\\/:*?"<>|]/g, "") // Windows 文件名非法字符
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "") // 剩下的控制字符
    .replace(/^\.+/, "") // 开头的点：避免生成隐藏文件或 ".."
    .trim()
    .slice(0, 80); // 留余量给扩展名，避免超出文件系统上限
  return cleaned || fallback;
}

// ---------- Markdown ----------

export function exportMarkdown(editor: Editor, title: string, fallback: string) {
  const markdown = editor.storage.markdown.getMarkdown() as string;
  downloadBlob(
    new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
    `${safeFilename(title, fallback)}.md`,
  );
}

// ---------- HTML ----------

/**
 * 自包含 HTML：样式内联，KaTeX 的 CSS 用 CDN 引。
 * 不把 KaTeX 的 24 KB CSS 整段塞进每个导出文件，那样太重且难维护。
 */
function htmlDocument(title: string, bodyHTML: string): string {
  const escapedTitle = title
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapedTitle}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
<style>
  :root { color-scheme: light dark; }
${EXPORT_BASE_CSS}${EXPORT_DARK_CSS}
</style>
</head>
<body>
${bodyHTML}
</body>
</html>`;
}

export function exportHTML(editor: Editor, title: string, fallback: string) {
  const name = safeFilename(title, fallback);
  const heading = title.trim() ? `<h1>${title.replace(/</g, "&lt;")}</h1>\n` : "";
  // 导出的 .html 是静态文件，不执行 JS。公式必须在这里就渲染成 KaTeX 标签，
  // 否则只剩一个带 data-latex 的空元素，打开是空白。
  //
  // 高亮同理：getHTML() 里没有 hljs span，EXPORT_BASE_CSS 的 .hljs-* 规则
  // 无从匹配。不补这一步，导出的 .html 里代码块是整段单色。
  const html = htmlDocument(
    name,
    withHighlightedCode(renderMathInHTML(heading + editor.getHTML())),
  );
  downloadBlob(
    new Blob([html], { type: "text/html;charset=utf-8" }),
    `${name}.html`,
  );
}

// ---------- PDF ----------

/**
 * 走浏览器打印管道。文字是矢量的，可选可搜可复制，但用户要在对话框里
 * 选「另存为 PDF」—— 浏览器不提供绕过对话框直接产出矢量 PDF 的接口。
 * 打印样式见 globals.css 的 @media print 段。
 */
export async function exportPrint(title: string, fallback: string) {
  const root = document.body;
  root.classList.add("koinote-printing");

  // 打印对话框的默认文件名取自页面标题，改掉它才能得到「文档标题.pdf」
  const originalTitle = document.title;
  document.title = safeFilename(title, fallback);

  const cleanup = () => {
    root.classList.remove("koinote-printing");
    document.title = originalTitle;
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  // 部分浏览器不触发 afterprint，兜一个超时避免类名与标题残留
  window.setTimeout(cleanup, 60_000);

  if (isDesktopRuntime()) {
    const { invoke } = await import("@tauri-apps/api/core");
    try {
      await invoke("desktop_print");
    } finally {
      cleanup();
    }
    return;
  }
  window.print();
}
