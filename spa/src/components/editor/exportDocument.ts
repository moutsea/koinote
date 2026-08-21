import type { Editor } from "@tiptap/react";
import { EXPORT_BASE_CSS, EXPORT_DARK_CSS } from "./exportStyles";
import { highlightCodeBlocks } from "./highlightCode";
import { renderMathInHTML } from "./renderMath";
import { isDesktopRuntime } from "../../desktop/runtime";

/** 文档导出。PDF 走原生打印引擎，保留可选择、可搜索的矢量文字。 */

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

const PRINT_ROOT_ID = "koinote-print-root";

function ensurePdfExtension(path: string): string {
  return path.toLowerCase().endsWith(".pdf") ? path : `${path}.pdf`;
}

function createPrintableSnapshot(source: HTMLElement): HTMLElement {
  document.getElementById(PRINT_ROOT_ID)?.remove();

  const root = document.createElement("main");
  root.id = PRINT_ROOT_ID;

  const editorInstance = source.closest("[data-koinote-editor-instance]");
  const themeStyle = editorInstance?.querySelector(
    "style[data-koinote-document-theme]",
  );
  if (themeStyle) {
    const themeClone = themeStyle.cloneNode(true) as HTMLStyleElement;
    themeClone.textContent =
      themeClone.textContent?.replaceAll(
        /\.dark(?=[\s.:#\[])/g,
        ".koinote-print-dark-disabled",
      ) ?? "";
    root.appendChild(themeClone);
  }

  const documentClone = source.cloneNode(true) as HTMLElement;
  documentClone.removeAttribute("data-koinote-print-source");
  documentClone.classList.add("koinote-print-document");
  documentClone.querySelectorAll<HTMLElement>("[class]").forEach((element) => {
    const darkClasses = Array.from(element.classList).filter((className) =>
      className.startsWith("dark:"),
    );
    element.classList.remove(...darkClasses);
  });
  documentClone
    .querySelectorAll<HTMLElement>(
      ".kn-page-search-match, .kn-page-search-current, .kn-page-search-title-match, .kn-page-search-title-current, [data-page-search-index]",
    )
    .forEach((element) => {
      element.classList.remove(
        "kn-page-search-match",
        "kn-page-search-current",
        "kn-page-search-title-match",
        "kn-page-search-title-current",
      );
      element.removeAttribute("data-page-search-index");
    });

  const title = documentClone.querySelector<HTMLElement>(".kn-doc-title");
  if (title) {
    const titleText = document.createElement("div");
    titleText.className = "koinote-print-title-text";
    titleText.textContent = title.dataset.title ?? "";
    title.replaceChildren(titleText);
  }

  documentClone
    .querySelectorAll<HTMLElement>("figure > button")
    .forEach((button) => {
      const image = document.createElement("div");
      image.className = "koinote-print-image";
      image.replaceChildren(...Array.from(button.childNodes));
      button.replaceWith(image);
    });
  documentClone
    .querySelectorAll('input:not([type="checkbox"]), [role="alert"]')
    .forEach((element) => element.remove());
  documentClone.querySelectorAll<HTMLElement>("[contenteditable]").forEach((element) => {
    element.removeAttribute("contenteditable");
    element.removeAttribute("tabindex");
  });

  root.appendChild(documentClone);
  document.body.appendChild(root);
  document.documentElement.classList.add("koinote-printing");
  document.body.classList.add("koinote-printing");
  return root;
}

function removePrintableSnapshot(root: HTMLElement) {
  root.remove();
  document.documentElement.classList.remove("koinote-printing");
  document.body.classList.remove("koinote-printing");
}

async function settlePrintableLayout(root: HTMLElement) {
  await document.fonts?.ready.catch(() => undefined);
  const images = Array.from(root.querySelectorAll("img"));
  await Promise.race([
    Promise.allSettled(images.map((image) => image.decode())),
    new Promise<void>((resolve) => window.setTimeout(resolve, 10_000)),
  ]);
  await new Promise<void>((resolve) => {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
  });
}

/**
 * 桌面端直接让 WebKit / WebView2 将当前打印布局写成 PDF；网页端受浏览器
 * 权限限制，仍使用系统打印对话框。两条路径都保留矢量文字与 @media print
 * 的分页样式。
 */
export async function exportPDF(
  source: HTMLElement,
  title: string,
  fallback: string,
): Promise<boolean> {
  const filename = `${safeFilename(title, fallback)}.pdf`;

  if (isDesktopRuntime()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const selectedPath = await save({
      defaultPath: filename,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (!selectedPath) return false;

    const root = createPrintableSnapshot(source);
    try {
      await settlePrintableLayout(root);
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("desktop_export_pdf", {
        path: ensurePdfExtension(selectedPath),
      });
    } finally {
      removePrintableSnapshot(root);
    }
    return true;
  }

  const root = createPrintableSnapshot(source);
  let originalTitle: string | null = null;
  let cleaned = false;
  let cleanupTimer = 0;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    window.clearTimeout(cleanupTimer);
    removePrintableSnapshot(root);
    if (originalTitle !== null) document.title = originalTitle;
    window.removeEventListener("afterprint", cleanup);
  };

  try {
    await settlePrintableLayout(root);

    // 打印对话框的默认文件名取自页面标题，改掉它才能得到「文档标题.pdf」
    originalTitle = document.title;
    document.title = safeFilename(title, fallback);
    window.addEventListener("afterprint", cleanup);
    // 部分浏览器不触发 afterprint，兜一个超时避免类名与标题残留
    cleanupTimer = window.setTimeout(cleanup, 60_000);
    window.print();
  } catch (error) {
    cleanup();
    throw error;
  }
  return true;
}
