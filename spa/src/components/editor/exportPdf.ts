import type { Editor } from "@tiptap/react";
import { safeFilename } from "./exportDocument";
import { EXPORT_BASE_CSS, EXPORT_PDF_CSS } from "./exportStyles";
import { renderMathInElement } from "./renderMath";

/**
 * 一键下载 PDF。
 *
 * 浏览器里能生成矢量文字 PDF 的引擎只挂在打印管道上，绕不开打印对话框。
 * 要做到「点一下就下载」，只剩栅格化这条路：把排好版的 DOM 画成位图再分页塞进 PDF。
 * 代价是文字不可选、不可搜 —— 这是一键下载的必然代价，不是实现偷懒。
 * 需要可选可搜的矢量文字，用导出菜单里的「打印 / 另存为 PDF」。
 *
 * 与 keepask 的 canvas 手绘方案不同，这里栅格化的是真实 DOM：
 * KaTeX 公式、代码高亮、表格边框都由浏览器自己排版，不用手写排版逻辑。
 */

// A4 @96dpi。CSS 像素与 jsPDF 的 pt 之间靠比例换算，不直接混用单位。
const A4_WIDTH_PX = 794;
const A4_HEIGHT_PX = 1123;
const PAGE_PADDING_PX = 56;
/**
 * 栅格倍率。2 倍 ≈ 192 DPI，屏幕阅读与家用打印都够清晰；1.5 倍（144 DPI）
 * 放大后字缘发虚。
 *
 * 代价是体积：实测一页正文约 650 KB、一页高亮代码约 710 KB。压缩等级
 * （FAST/MEDIUM/SLOW）与去掉 alpha 通道都试过，对体积没有影响；唯一有效的
 * 是改用有损 JPEG（省 14%~40%）。这里选无损 PNG —— 中文小字在 JPEG 下
 * 边缘会起振铃，对文档工具来说画质比体积重要。
 */
const SCALE = 2;
const IMAGE_FETCH_TIMEOUT_MS = 10_000;

export async function exportPDF(
  editor: Editor,
  title: string,
  fallback: string,
): Promise<void> {
  // 只有这两个重库值得动态引入；exportDocument 已在主 chunk 里，动态引入无收益
  const { default: html2canvas } = await import("html2canvas-pro");
  const { jsPDF } = await import("jspdf");

  const stage = buildStage(title, editor.getHTML());
  document.body.appendChild(stage);

  try {
    renderMathInElement(stage);
    // 图片必须先转成 data URL：跨域图片会污染 canvas，导致 toDataURL 抛
    // SecurityError，整个导出失败。R2 自定义域名启用后所有图片都是跨域的。
    await inlineImages(stage);
    await waitForAssets(stage);

    const canvas = await html2canvas(stage, {
      scale: SCALE,
      backgroundColor: "#ffffff",
      useCORS: true,
      logging: false,
      // 舞台在视口外，不跟随页面滚动
      scrollX: 0,
      scrollY: 0,
      windowWidth: A4_WIDTH_PX,
    });

    const pdf = new jsPDF({ unit: "pt", format: "a4", compress: true });
    const pageWidthPt = pdf.internal.pageSize.getWidth();
    const pageHeightPt = pdf.internal.pageSize.getHeight();
    const pxToPt = pageWidthPt / (A4_WIDTH_PX * SCALE);

    const slices = sliceIntoPages(
      canvas.height,
      A4_HEIGHT_PX * SCALE,
      collectBreakpoints(stage),
    );

    slices.forEach((slice, index) => {
      if (index > 0) pdf.addPage();
      const pageCanvas = cropCanvas(canvas, slice.top, slice.height);
      pdf.addImage(
        pageCanvas.toDataURL("image/png"),
        "PNG",
        0,
        0,
        pageWidthPt,
        slice.height * pxToPt,
        undefined,
        "FAST",
      );
      // 页码用 jsPDF 的内置字体画，纯数字不涉及 CJK 字体嵌入
      if (slices.length > 1) {
        pdf.setFontSize(9);
        pdf.setTextColor(150);
        pdf.text(
          `${index + 1} / ${slices.length}`,
          pageWidthPt / 2,
          pageHeightPt - 18,
          { align: "center" },
        );
      }
    });

    pdf.save(`${safeFilename(title, fallback)}.pdf`);
  } finally {
    stage.remove();
  }
}

/** 视口外的 A4 舞台。用固定宽度而非屏幕宽度，保证导出结果与窗口大小无关。 */
function buildStage(title: string, bodyHTML: string): HTMLElement {
  const stage = document.createElement("div");
  stage.setAttribute("aria-hidden", "true");
  // 不用 display:none —— 那样元素没有布局，量不到高度也画不出内容
  stage.style.cssText = [
    "position: fixed",
    "left: -10000px",
    "top: 0",
    `width: ${A4_WIDTH_PX}px`,
    `padding: ${PAGE_PADDING_PX}px`,
    "box-sizing: border-box",
    "background: #ffffff",
    "color: #1f2328",
    "z-index: -1",
    "pointer-events: none",
  ].join(";");

  const style = document.createElement("style");
  // 作用域限定在舞台内，避免污染编辑器界面
  style.textContent = scopeCSS(
    EXPORT_BASE_CSS + EXPORT_PDF_CSS,
    ".koinote-pdf-stage",
  );
  stage.className = "koinote-pdf-stage";
  stage.appendChild(style);

  const heading = title.trim() ? `<h1>${escapeHTML(title)}</h1>` : "";
  const content = document.createElement("div");
  content.innerHTML = heading + bodyHTML;
  stage.appendChild(content);
  return stage;
}

function escapeHTML(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** 给每条选择器加前缀。@media / @keyframes 之类的 at-rule 原样保留。 */
function scopeCSS(css: string, prefix: string): string {
  return css.replace(
    /(^|\})\s*([^{}@]+)\{/g,
    (_match, brace: string, selectors: string) => {
      const scoped = selectors
        .split(",")
        .map((sel) => {
          const trimmed = sel.trim();
          if (!trimmed) return trimmed;
          // body/:root 指的就是舞台本身
          if (trimmed === "body" || trimmed === ":root") return prefix;
          return `${prefix} ${trimmed}`;
        })
        .filter(Boolean)
        .join(", ");
      return `${brace} ${scoped}{`;
    },
  );
}

/**
 * 把 <img> 换成 data URL。
 * 跨域图片会让 canvas 变成 tainted，之后 toDataURL 直接抛 SecurityError，
 * 表现是整个导出失败而非少一张图 —— 所以这一步是必须的，不是优化。
 */
async function inlineImages(stage: HTMLElement) {
  const images = Array.from(stage.querySelectorAll("img"));
  await Promise.all(
    images.map(async (img) => {
      const src = img.getAttribute("src") ?? "";
      if (!src || src.startsWith("data:")) return;
      const dataURL = await toDataURL(src);
      if (dataURL) {
        img.setAttribute("src", dataURL);
        return;
      }
      // 取不到就换成占位文字。留着坏图会让 html2canvas 等到超时，
      // 或者在 PDF 里留一个刺眼的破图标。
      const placeholder = document.createElement("p");
      placeholder.textContent = `[${img.getAttribute("alt") || "image"}]`;
      placeholder.style.color = "#8b949e";
      img.replaceWith(placeholder);
    }),
  );
}

async function toDataURL(src: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = window.setTimeout(
    () => controller.abort(),
    IMAGE_FETCH_TIMEOUT_MS,
  );
  try {
    const response = await fetch(src, {
      credentials: "include",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const blob = await response.blob();
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

/** 等字体和图片就位。少了这步，KaTeX 会用后备字体栅格化，公式字形是错的。 */
async function waitForAssets(stage: HTMLElement) {
  const images = Array.from(stage.querySelectorAll("img"));
  await Promise.all([
    document.fonts?.ready ?? Promise.resolve(),
    ...images.map(
      (img) =>
        new Promise<void>((resolve) => {
          if (img.complete && img.naturalWidth > 0) return resolve();
          const done = () => resolve();
          img.addEventListener("load", done, { once: true });
          img.addEventListener("error", done, { once: true });
          window.setTimeout(done, IMAGE_FETCH_TIMEOUT_MS);
        }),
    ),
  ]);
}

/**
 * 可切割位置：各块级元素的上下边界（画布像素）。
 * 只在这些位置分页，避免把一行字横着切成两半 —— 那是纯栅格分页最难看的地方。
 */
function collectBreakpoints(stage: HTMLElement): number[] {
  const stageTop = stage.getBoundingClientRect().top;
  const points = new Set<number>([0]);
  const blocks = stage.querySelectorAll<HTMLElement>(
    "h1,h2,h3,h4,h5,h6,p,pre,blockquote,ul,ol,li,table,tr,hr," +
      'img,figure,[data-type="block-math"],[data-type="taskList"]',
  );
  for (const el of blocks) {
    const rect = el.getBoundingClientRect();
    if (rect.height <= 0) continue;
    points.add(Math.round((rect.top - stageTop) * SCALE));
    points.add(Math.round((rect.bottom - stageTop) * SCALE));
  }
  return Array.from(points).sort((a, b) => a - b);
}

type Slice = { top: number; height: number };

/** 按页高切片，切口对齐到最近的可切割位置。 */
export function sliceIntoPages(
  totalHeight: number,
  pageHeight: number,
  breakpoints: number[],
): Slice[] {
  const slices: Slice[] = [];
  // 单个元素比一页还高时得硬切，这个下限保证每片都有进展、循环必然终止
  const minHeight = Math.max(1, Math.floor(pageHeight * 0.2));
  let top = 0;

  while (top < totalHeight) {
    const remaining = totalHeight - top;
    if (remaining <= pageHeight) {
      slices.push({ top, height: remaining });
      break;
    }
    const idealBottom = top + pageHeight;
    // 落在 (top, idealBottom] 内最靠下的切割点
    let cut = -1;
    let next = -1;
    for (const point of breakpoints) {
      if (point > top + minHeight && point <= idealBottom) cut = point;
      else if (point > idealBottom) {
        next = point;
        break;
      }
    }
    // 若紧跟在切点之后的元素本身就高过一页（长代码块是典型），它无论如何都要
    // 被硬切。此时提前断页只是白扔半页空白，不如把当前页填满。
    const nextBlockOversized = cut > 0 && next > 0 && next - cut > pageHeight;
    const bottom = cut > 0 && !nextBlockOversized ? cut : idealBottom;
    slices.push({ top, height: bottom - top });
    top = bottom;
  }

  return slices;
}

function cropCanvas(
  source: HTMLCanvasElement,
  top: number,
  height: number,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (context) {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(source, 0, -top);
  }
  return canvas;
}
