import type { Editor } from "@tiptap/react";
import { highlightCodeBlocks } from "./highlightCode";
import { addMacWindows } from "./macWindow";
import {
  addWechatImageCaptions,
  auditWechatImages,
  type ImageAudit,
} from "./wechatImages";
import { estimateBytes, inlineWechatStyles, wrapWechatBody } from "./wechatInline";
import { replaceMathWithImages, type MathConversion } from "./wechatMath";
import { findWechatTheme } from "./wechatThemes";
import { structuralizeCodeWhitespace } from "./wechatWhitespace";
import { normalizeWechatExportRules } from "./wechatExportTypography";
import {
  buildWechatGeoSection,
  normalizeWechatGeoCorpus,
} from "./wechatGeo";
import {
  applyWechatLayoutModules,
  type WechatLayoutDiagnostic,
} from "./wechatLayout";
import {
  parseArticleMetadata,
  removeWechatFrontmatterNodes,
} from "./wechatPreflight";

/**
 * 导出为微信公众号可直接粘贴的 HTML。
 *
 * 与另外几种导出的区别：产物不落盘，而是写进剪贴板。用户的实际动作是
 * 「粘贴到公众号编辑器」，下载一个 .html 再打开再全选复制是多余的三步。
 *
 * 这里不做预览：主题的色彩与装饰已经在编辑区生效（themeCss.ts）。导出时只在
 * 相同主题上叠加公众号阅读排版，再把规则转换成内联 style。
 */

export type WechatExportResult = {
  html: string;
  bytes: number;
  math: MathConversion;
  styledElements: number;
  /**
   * 内联了代码高亮的元素数。
   *
   * 传出来是为了能在对话框里区分两种情况：文章本来没有代码块（0 是对的），
   * 还是有代码块但高亮没内联上（0 是 bug）。只看导出的 HTML 分不出这两者。
   */
  highlightedElements: number;
  /**
   * 图片地址的绝对化与可达性统计。
   *
   * unreachable > 0 必须报出来：粘贴那一刻不会失败，微信照样收下这段 HTML，
   * 要等文章预览时才看到裂图 —— 那时用户早已离开我们的页面，无从判断是哪一步错了。
   */
  images: ImageAudit;
  layout: {
    rendered: number;
    names: string[];
    diagnostics: WechatLayoutDiagnostic[];
  };
};

export type WechatExportOptions = {
  includeGeoCorpus?: boolean;
  geoText?: string;
  /** 草稿箱接口已经单独接收标题，正文里不应再重复渲染一个 H1。 */
  includeTitle?: boolean;
};

export async function buildWechatHTML(
  editor: Editor,
  title: string,
  themeId: string,
  options: WechatExportOptions = {},
): Promise<WechatExportResult> {
  const stage = document.createElement("div");
  // 需要真实布局：公式栅格化要量尺寸。挪到视口外，不能 display:none
  stage.style.cssText =
    "position:fixed;left:-10000px;top:0;width:700px;background:#fff;";
  const markdown = editor.storage.markdown.getMarkdown() as string;
  const article = parseArticleMetadata(markdown, title);
  const exportTitle = article.metadata.title || title;
  const hasExportTitle = options.includeTitle !== false && exportTitle.trim().length > 0;
  const heading = hasExportTitle ? `<h1>${escapeHTML(exportTitle)}</h1>` : "";
  stage.innerHTML = heading + editor.getHTML();
  document.body.appendChild(stage);

  const theme = findWechatTheme(themeId);
  const exportRules = normalizeWechatExportRules(theme.rules);

  try {
    const geoCorpus = options.includeGeoCorpus
      ? normalizeWechatGeoCorpus(options.geoText ?? "")
      : "";
    if (article.metadata.hasFrontmatter) {
      removeWechatFrontmatterNodes(stage, article.frontmatterKeys);
    }
    const layout = applyWechatLayoutModules(stage, article.body);
    const geoDivider = geoCorpus ? document.createElement("hr") : null;
    if (geoDivider) {
      const titleElement = hasExportTitle ? stage.firstElementChild : null;
      if (titleElement?.tagName === "H1") {
        titleElement.insertAdjacentElement("afterend", geoDivider);
      } else {
        stage.prepend(geoDivider);
      }
    }
    // 顺序要紧：先把公式换成 img，再内联样式。
    // 反过来的话新插入的 img 拿不到主题的 img 规则。
    const math = await replaceMathWithImages(stage);
    // Markdown 图片的 alt 在公众号里不可见，转成紧跟图片的真实文字。
    // 必须放在公式转换之后，公式图会带跳过标记，避免把 LaTeX 当成图注。
    addWechatImageCaptions(stage);
    // 高亮必须在内联之前：getHTML() 的产物里没有 hljs span（高亮在编辑器里是
    // ProseMirror 装饰，不进文档），得先补出来，内联器才有 class 可读。
    // 详见 highlightCode.ts 的头注。
    highlightCodeBlocks(stage);
    // 再把代码块里的空白改成 NBSP + <br>。实测微信会剥掉 white-space 声明，
    // 只靠 CSS 的话缩进会被空白折叠吃掉 —— 必须让空白本身不需要 CSS 维持。
    // 放在高亮之后：这样它遍历的是已经带 span 的树，逐个文本节点处理，
    // 不会碰到标签和 style 里的空格。见 wechatWhitespace.ts。
    structuralizeCodeWhitespace(stage);
    // Mac 窗口三点。必须在内联之前：它靠 data-wechat-keep-style 把样式带过去，
    // 那是内联器保留内联样式的唯一通道（span 没有主题规则，style 会被清掉）。
    // 用真实元素而不是伪元素 —— 微信剥 <style>，伪元素没有内联等价写法。
    addMacWindows(stage, exportRules.pre ?? "");
    // 图片地址补成绝对的。必须在公式那步之后：公式图也是 img，同样要补
    // （未配 IMAGE_PUBLIC_BASE 时它拿到的也是 /images/<key>）。
    // 放在内联之前是因为内联器会重写 style 但不碰 src，先后其实都行 ——
    // 排在这里只为与"所有 img 都已就位"这个前提对齐。见 wechatImages.ts。
    const images = auditWechatImages(stage, window.location.origin);
    const stats = inlineWechatStyles(stage, exportRules);
    const geoSection = buildWechatGeoSection(geoCorpus);
    if (geoDivider && geoSection) {
      geoDivider.insertAdjacentHTML("afterend", geoSection);
    }
    const html = wrapWechatBody(stage.innerHTML, exportRules.body);
    return {
      html,
      bytes: estimateBytes(html),
      math,
      styledElements: stats.styled,
      highlightedElements: stats.highlighted,
      images,
      layout,
    };
  } finally {
    stage.remove();
  }
}

function escapeHTML(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * 富文本写入剪贴板。
 *
 * 必须同时写 text/html 与 text/plain：只给 html 的话，粘贴到纯文本环境
 * （终端、纯文本编辑器）会得到空内容。
 */
export async function copyRichText(html: string, plain: string): Promise<void> {
  if (navigator.clipboard && "write" in navigator.clipboard) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([plain], { type: "text/plain" }),
        }),
      ]);
      return;
    } catch {
      // 权限被拒或浏览器不支持 ClipboardItem，走下面的兜底
    }
  }

  // 兜底：把 HTML 塞进可编辑元素里选中再 execCommand("copy")。
  // 这条路能保住富文本格式，纯 writeText 只能得到源码字符串。
  const holder = document.createElement("div");
  holder.contentEditable = "true";
  holder.innerHTML = html;
  holder.style.cssText = "position:fixed;left:-10000px;top:0;opacity:0;";
  document.body.appendChild(holder);
  try {
    const range = document.createRange();
    range.selectNodeContents(holder);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    const copied = document.execCommand("copy");
    selection?.removeAllRanges();
    if (!copied) throw new Error("execCommand copy failed");
  } finally {
    holder.remove();
  }
}
