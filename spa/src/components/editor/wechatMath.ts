import katex from "katex";
import {
  ApiError,
  TEMPORARY_IMAGE_QUOTA_CODE,
  uploadImage,
} from "../../api";

/**
 * 把公式换成图片。
 *
 * 为什么必须换：KaTeX 的产物是几百个带 class 的 <span> 靠 position 拼出来的
 * 排版，微信会把 class 全部剥掉 —— 剩下一堆错位的散字，比不显示更糟。
 *
 * 为什么走 R2 上传而不是 base64 data URL：微信在粘贴时会抓取外部图片转存到
 * 自己的服务器（你文档里的普通图片就是这么工作的），而 data URL 是否被接受
 * 无法确认。用已经验证过的路径。
 */

/** 栅格倍率。公式字号本就小，低于 3 倍在手机上发虚。 */
const MATH_SCALE = 3;

type UploadedMathImage = { url: string; width: number; height: number };

export type MathConversion = {
  total: number;
  converted: number;
  failed: number;
  temporaryQuotaFailed: number;
};

/**
 * 就地把 root 里的公式元素替换成 <img>。
 *
 * 失败的公式降级成 LaTeX 源码文本而不是留空 —— 读者至少知道这里有个公式，
 * 而不是看到一段莫名的空白。
 */
export async function replaceMathWithImages(
  root: HTMLElement,
): Promise<MathConversion> {
  const nodes = Array.from(
    root.querySelectorAll<HTMLElement>(
      '[data-type="inline-math"],[data-type="block-math"]',
    ),
  );
  const result: MathConversion = {
    total: nodes.length,
    converted: 0,
    failed: 0,
    temporaryQuotaFailed: 0,
  };
  if (nodes.length === 0) return result;

  const { default: html2canvas } = await import("html2canvas-pro");
  const uploadCache = new Map<string, UploadedMathImage>();

  for (const node of nodes) {
    const latex = node.getAttribute("data-latex") ?? "";
    const isBlock = node.getAttribute("data-type") === "block-math";
    if (!latex.trim()) {
      node.remove();
      continue;
    }

    try {
      const img = await renderMathImage(html2canvas, latex, isBlock, uploadCache);
      node.replaceWith(img);
      result.converted++;
    } catch (error) {
      result.failed++;
      if (
        error instanceof ApiError &&
        error.code === TEMPORARY_IMAGE_QUOTA_CODE
      ) {
        result.temporaryQuotaFailed++;
      }
      node.replaceWith(latexFallback(latex, isBlock));
    }
  }

  return result;
}

async function renderMathImage(
  html2canvas: (el: HTMLElement, opts?: Record<string, unknown>) => Promise<HTMLCanvasElement>,
  latex: string,
  isBlock: boolean,
  uploadCache: Map<string, UploadedMathImage>,
): Promise<HTMLElement> {
  // 缓存键要带 displayMode：同一段 LaTeX 行内与块级的排版不同，不能混用
  const cacheKey = `${isBlock ? "block" : "inline"}::${latex}`;
  const cached = uploadCache.get(cacheKey);
  if (cached) {
    return buildMathImg(latex, isBlock, cached.url, cached.width, cached.height);
  }

  // 舞台必须有布局才能被栅格化，所以挪到视口外而不是 display:none
  const stage = document.createElement("div");
  stage.style.cssText =
    "position:fixed;left:-10000px;top:0;background:#ffffff;" +
    "padding:2px 4px;display:inline-block;";
  stage.innerHTML = katex.renderToString(latex, {
    displayMode: isBlock,
    throwOnError: true, // 这里要抛：错误公式该走降级分支，不该产出一张红字图
    output: "html",
  });
  document.body.appendChild(stage);

  try {
    // 字体没就位就栅格化，公式会用后备字形 —— 显示得出来但字是错的
    await (document.fonts?.ready ?? Promise.resolve());

    const rect = stage.getBoundingClientRect();
    const canvas = await html2canvas(stage, {
      scale: MATH_SCALE,
      backgroundColor: "#ffffff",
      logging: false,
    });

    const blob = await canvasToBlob(canvas);
    const uploaded = await uploadImage(
      new File([blob], `formula-${Date.now()}.png`, { type: "image/png" }),
      "wechat-export",
    );

    const w = Math.max(1, Math.round(rect.width));
    const h = Math.max(1, Math.round(rect.height));
    uploadCache.set(cacheKey, { url: uploaded.url, width: w, height: h });
    return buildMathImg(latex, isBlock, uploaded.url, w, h);
  } finally {
    stage.remove();
  }
}

/**
 * 组装公式 <img>。
 *
 * 显示尺寸用 CSS 尺寸而非画布尺寸，否则会按 3 倍大小铺出来。
 * 走 data-wechat-keep-style 传递，让内联器把它排在主题规则之后生效
 * —— 主题的 img 规则里有 height:auto，顺序反了公式就会被压扁。
 */
function buildMathImg(
  latex: string,
  isBlock: boolean,
  url: string,
  w: number,
  h: number,
): HTMLElement {
  const img = document.createElement("img");
  img.setAttribute("src", url);
  img.setAttribute("alt", latex);
  if (isBlock) {
    img.setAttribute(
      "data-wechat-keep-style",
      `width:${w}px;height:${h}px;max-width:100%;display:block;margin:18px auto;`,
    );
    const wrapper = document.createElement("p");
    wrapper.style.textAlign = "center";
    wrapper.appendChild(img);
    return wrapper;
  }
  img.setAttribute(
    "data-wechat-keep-style",
    `width:${w}px;height:${h}px;display:inline-block;vertical-align:middle;margin:0 2px;`,
  );
  return img;
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("canvas.toBlob returned null"));
    }, "image/png");
  });
}

/** 降级：保留 LaTeX 源码，读者能看出这里原本是公式 */
function latexFallback(latex: string, isBlock: boolean): HTMLElement {
  const el = document.createElement(isBlock ? "p" : "code");
  el.textContent = isBlock ? `$$${latex}$$` : `$${latex}$`;
  return el;
}
