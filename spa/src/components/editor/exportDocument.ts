import type { Editor } from "@tiptap/react";

/**
 * 文档导出。
 *
 * PDF 走浏览器原生打印而非 jsPDF：jsPDF 要嵌 CJK 字体才能显示中文，
 * 常见做法是把文字栅格化成图片塞进 PDF——那样文字不可选、不可搜、体积大。
 * 对一个以文字为主的 Markdown 编辑器，这个代价不该付。
 * 打印路径下文字可选、CJK 正常、KaTeX 与代码高亮直接复用现有样式。
 */

/** 触发浏览器下载。用完即释放 objectURL，否则整页存活期间都占着内存。 */
function download(blob: Blob, filename: string) {
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
  download(
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
  body {
    max-width: 46rem; margin: 0 auto; padding: 3rem 1.25rem;
    font: 16px/1.75 -apple-system, BlinkMacSystemFont, "Segoe UI",
          "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
    color: #1f2328; background: #fff;
  }
  h1, h2, h3, h4 { line-height: 1.3; margin: 1.6em 0 0.6em; }
  h1 { font-size: 1.9em; }
  h2 { font-size: 1.5em; }
  h3 { font-size: 1.25em; }
  p, ul, ol, blockquote, table { margin: 0.85em 0; }
  a { color: #0969da; }
  img { max-width: 100%; height: auto; }
  blockquote {
    margin-left: 0; padding-left: 1em;
    border-left: 3px solid #d0d7de; color: #57606a;
  }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.9em; background: rgba(175,184,193,0.2);
    padding: 0.15em 0.35em; border-radius: 4px;
  }
  pre {
    background: #0d1117; color: #e6edf3; padding: 1em;
    border-radius: 8px; overflow-x: auto;
  }
  pre code { background: none; padding: 0; color: inherit; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #d0d7de; padding: 0.5em 0.75em; text-align: left; }
  th { background: rgba(175,184,193,0.15); }
  ul[data-type="taskList"] { list-style: none; padding-left: 0; }
  ul[data-type="taskList"] li { display: flex; gap: 0.5em; align-items: flex-start; }
  hr { border: none; border-top: 1px solid #d0d7de; margin: 2em 0; }
  /* 代码高亮配色，与编辑器一致 */
  .hljs-comment, .hljs-quote { color: #8b949e; }
  .hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-type { color: #ff7b72; }
  .hljs-string, .hljs-attr, .hljs-template-tag { color: #a5d6ff; }
  .hljs-number, .hljs-symbol { color: #79c0ff; }
  .hljs-title, .hljs-title.function_, .hljs-section { color: #d2a8ff; }
  .hljs-variable, .hljs-name, .hljs-attribute { color: #ffa657; }
  @media (prefers-color-scheme: dark) {
    body { color: #e6edf3; background: #0d1117; }
    a { color: #58a6ff; }
    blockquote { border-left-color: #30363d; color: #8b949e; }
    th, td { border-color: #30363d; }
    hr { border-top-color: #30363d; }
  }
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
  const html = htmlDocument(name, heading + editor.getHTML());
  download(
    new Blob([html], { type: "text/html;charset=utf-8" }),
    `${name}.html`,
  );
}

// ---------- PDF ----------

/**
 * 借浏览器打印导出 PDF。用户在打印对话框里选「另存为 PDF」。
 * 打印样式见 globals.css 的 @media print 段。
 */
export function exportPDF() {
  const root = document.body;
  root.classList.add("koinote-printing");

  const cleanup = () => {
    root.classList.remove("koinote-printing");
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  // 部分浏览器不触发 afterprint，兜一个超时避免类名残留
  window.setTimeout(cleanup, 60_000);

  window.print();
}
