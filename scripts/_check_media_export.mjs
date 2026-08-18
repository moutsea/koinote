import { readFileSync } from "node:fs";
import { buildMediaMarkdown, mediaExportFormat } from "./_media_export_bundle.mjs";

let pass = 0;
let fail = 0;

function ok(label, condition, detail) {
  if (condition) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL  ${label}${detail ? ` —— ${detail}` : ""}`);
  }
}

const menu = readFileSync(new URL("../spa/src/components/editor/ExportMenu.tsx", import.meta.url), "utf8");
const dialog = readFileSync(new URL("../spa/src/components/editor/WechatDialog.tsx", import.meta.url), "utf8");
const exportDocument = readFileSync(new URL("../spa/src/components/editor/exportDocument.ts", import.meta.url), "utf8");
const desktopLib = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");

ok("微信公众号使用富文本", mediaExportFormat("wechat") === "rich-text");
ok("知乎使用富文本", mediaExportFormat("zhihu") === "rich-text");
ok("掘金使用 Markdown", mediaExportFormat("juejin") === "markdown");
ok(
  "掘金 Markdown 包含文档标题",
  buildMediaMarkdown("一篇文章", "正文内容") === "# 一篇文章\n\n正文内容",
  "标题应作为一级标题放在正文之前",
);
ok(
  "空标题不制造空一级标题",
  buildMediaMarkdown("  ", "正文内容") === "正文内容",
);
ok(
  "导出菜单使用自媒体入口",
  /t\.editor\.mediaExport/.test(menu) && /<MediaExportDialog/.test(menu),
  "菜单不应继续把功能描述成仅微信公众号",
);
ok(
  "平台选择同时包含三种目标",
  /["']wechat["']/.test(dialog) && /["']zhihu["']/.test(dialog) && /["']juejin["']/.test(dialog),
);
ok(
  "富文本和 Markdown 提示分开",
  /mediaRichTextNote/.test(dialog) && /mediaMarkdownNote/.test(dialog),
  "不同平台不能共用误导性的格式说明",
);
ok(
  "客户端打印调用 Tauri 原生命令",
  /isDesktopRuntime\(\)[\s\S]*?invoke\("desktop_print"\)/.test(exportDocument),
  "WKWebView 中直接调用 window.print() 不会打开 macOS 打印面板",
);
ok(
  "网页打印继续使用浏览器管道",
  /if \(isDesktopRuntime\(\)\)[\s\S]*?return;[\s\S]*?window\.print\(\)/.test(exportDocument),
);
ok(
  "导出菜单只保留一个 PDF 入口",
  (menu.match(/label=\{t\.editor\.exportPDF\}/g) ?? []).length === 1 &&
    !/label=\{t\.editor\.exportPrint\}/.test(menu),
  "用户不需要再区分栅格 PDF 与打印 PDF",
);
ok(
  "PDF 统一走可搜索文字的打印管道",
  /label=\{t\.editor\.exportPDF\}[\s\S]*?exportPrint\(title, t\.editor\.untitled\)/.test(menu),
);
ok(
  "Tauri 注册桌面打印命令",
  /fn desktop_print\([\s\S]*?window\.print\(\)/.test(desktopLib) &&
    /desktop_abort_local_mode_import,[\s\S]*?desktop_print,/.test(desktopLib),
);

console.log(`自媒体导出：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
