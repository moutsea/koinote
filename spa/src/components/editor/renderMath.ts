import katex from "katex";

/**
 * 把 editor.getHTML() 里的公式占位元素替换成 KaTeX 渲染结果。
 *
 * 为什么需要这一步：@tiptap/extension-mathematics 的 renderHTML 只输出一个
 * 带 data-latex 的空元素（见 dist/index.js 的 renderHTML），公式的可见形态
 * 完全由编辑器内的 nodeview 负责。导出走的是 getHTML()，拿不到 nodeview，
 * 所以不补这一步的话，导出物里公式的位置是空白 —— 静默丢内容。
 */

const INLINE_SELECTOR = '[data-type="inline-math"]';
const BLOCK_SELECTOR = '[data-type="block-math"]';

/** 就地渲染容器内的公式。用于 PDF 那条需要真实布局的路径。 */
export function renderMathInElement(root: HTMLElement) {
  for (const el of root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)) {
    renderOne(el, true);
  }
  for (const el of root.querySelectorAll<HTMLElement>(INLINE_SELECTOR)) {
    renderOne(el, false);
  }
}

function renderOne(el: HTMLElement, displayMode: boolean) {
  const latex = el.getAttribute("data-latex") ?? "";
  if (!latex.trim()) {
    // 空公式：删掉占位元素，别在导出物里留个空洞
    el.remove();
    return;
  }
  try {
    el.innerHTML = katex.renderToString(latex, {
      displayMode,
      // 单条公式写错不该让整个导出失败，红字提示即可 —— 与编辑器内行为一致
      throwOnError: false,
      output: "html", // 不要 MathML：栅格化时它可能被重复绘制成两份
    });
  } catch {
    el.textContent = displayMode ? `$$${latex}$$` : `$${latex}$`;
  }
}

/**
 * 字符串版：给自包含 HTML 导出用。
 * 导出的 .html 是静态文件，不会执行 JS，必须在生成时就把公式变成 KaTeX 标签。
 */
export function renderMathInHTML(html: string): string {
  const holder = document.createElement("div");
  holder.innerHTML = html;
  renderMathInElement(holder);
  return holder.innerHTML;
}
