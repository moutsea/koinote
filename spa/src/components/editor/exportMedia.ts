import type { Editor } from "@tiptap/react";
import { buildWechatHTML, copyRichText, type WechatExportResult } from "./exportWechat";
import { buildMediaMarkdown, mediaExportFormat, type MediaPlatform } from "./mediaExportStrategy";

export { mediaExportFormat, type MediaPlatform } from "./mediaExportStrategy";

export type MediaExportOptions = {
  includeWechatGeoCorpus?: boolean;
  wechatGeoText?: string;
};

export async function exportToMedia(
  platform: MediaPlatform,
  editor: Editor,
  title: string,
  themeId: string,
  options: MediaExportOptions = {},
): Promise<WechatExportResult | null> {
  const markdown = editor.storage.markdown.getMarkdown() as string;
  if (mediaExportFormat(platform) === "markdown") {
    await copyPlainText(buildMediaMarkdown(title, markdown));
    return null;
  }

  const result = await buildWechatHTML(editor, title, themeId, {
    includeGeoCorpus:
      platform === "wechat" && options.includeWechatGeoCorpus === true,
    geoText: options.wechatGeoText,
  });
  await copyRichText(result.html, markdown);
  return result;
}

async function copyPlainText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // 权限被拒或浏览器实现不完整时，继续走选中文本的兼容路径。
    }
  }

  const holder = document.createElement("textarea");
  holder.value = value;
  holder.style.cssText = "position:fixed;left:-10000px;top:0;opacity:0;";
  document.body.appendChild(holder);
  try {
    holder.select();
    if (!document.execCommand("copy")) throw new Error("execCommand copy failed");
  } finally {
    holder.remove();
  }
}
