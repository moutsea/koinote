import type { Editor } from "@tiptap/react";
import { estimateBytes, inlineWechatStyles, wrapWechatBody } from "./wechatInline";
import { replaceMathWithImages, type MathConversion } from "./wechatMath";
import { findWechatTheme } from "./wechatThemes";

/**
 * 导出为微信公众号可直接粘贴的 HTML。
 *
 * 与另外几种导出的区别：产物不落盘，而是写进剪贴板。用户的实际动作是
 * 「粘贴到公众号编辑器」，下载一个 .html 再打开再全选复制是多余的三步。
 *
 * 这里不做预览：主题已经在编辑区生效（themeCss.ts），编辑区就是预览。导出只是
 * 把同一套规则从 CSS 换成内联 style，没有第二种可能的样子需要先看一眼。
 */

export type WechatExportResult = {
  html: string;
  bytes: number;
  math: MathConversion;
  styledElements: number;
};

export async function buildWechatHTML(
  editor: Editor,
  title: string,
  themeId: string,
): Promise<WechatExportResult> {
  const stage = document.createElement("div");
  // 需要真实布局：公式栅格化要量尺寸。挪到视口外，不能 display:none
  stage.style.cssText =
    "position:fixed;left:-10000px;top:0;width:700px;background:#fff;";
  const heading = title.trim() ? `<h1>${escapeHTML(title)}</h1>` : "";
  stage.innerHTML = heading + editor.getHTML();
  document.body.appendChild(stage);

  try {
    // 顺序要紧：先把公式换成 img，再内联样式。
    // 反过来的话新插入的 img 拿不到主题的 img 规则。
    const math = await replaceMathWithImages(stage);
    const theme = findWechatTheme(themeId);
    const stats = inlineWechatStyles(stage, theme.rules);
    const html = wrapWechatBody(stage.innerHTML, theme.rules.body);
    return {
      html,
      bytes: estimateBytes(html),
      math,
      styledElements: stats.styled,
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
