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
const markdownEditor = readFileSync(new URL("../spa/src/components/editor/MarkdownEditor.tsx", import.meta.url), "utf8");
const docTitle = readFileSync(new URL("../spa/src/components/editor/DocTitle.tsx", import.meta.url), "utf8");
const globals = readFileSync(new URL("../spa/src/globals.css", import.meta.url), "utf8");
const desktopLib = readFileSync(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const desktopPdf = readFileSync(new URL("../src-tauri/src/pdf_export.rs", import.meta.url), "utf8");

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
  "客户端 PDF 选择保存位置后调用原生导出",
  /isDesktopRuntime\(\)[\s\S]*?save\(\{[\s\S]*?extensions: \["pdf"\][\s\S]*?invoke\("desktop_export_pdf"/.test(
    exportDocument,
  ),
  "客户端不应再跳到打印面板",
);
ok(
  "网页打印继续使用浏览器管道",
  /if \(isDesktopRuntime\(\)\)[\s\S]*?return true;[\s\S]*?window\.print\(\)/.test(
    exportDocument,
  ),
);
ok(
  "导出菜单只保留一个 PDF 入口",
  (menu.match(/label=\{t\.editor\.exportPDF\}/g) ?? []).length === 1 &&
    !/label=\{t\.editor\.exportPrint\}/.test(menu),
  "用户不需要再区分栅格 PDF 与打印 PDF",
);
ok(
  "PDF 统一走可搜索文字的原生管道",
  /label=\{t\.editor\.exportPDF\}[\s\S]*?exportPDF\(printSource, title, t\.editor\.untitled\)/.test(menu),
);
ok(
  "PDF 从当前文档生成独立打印快照",
  /data-koinote-editor-instance/.test(markdownEditor) &&
    /data-koinote-print-source/.test(markdownEditor) &&
    /koinote-doc-title-wrap/.test(docTitle) &&
    /source\.cloneNode\(true\)/.test(exportDocument) &&
    /className\.startsWith\("dark:"\)/.test(exportDocument) &&
    /replaceAll\([\s\S]*?\\\.dark\(\?=\[\\s\.:#\\\[\]\)/.test(exportDocument) &&
    /PRINT_ROOT_ID = "koinote-print-root"/.test(exportDocument),
  "不能直接打印带固定高度和滚动容器的编辑器界面",
);
ok(
  "网页 PDF 布局失败也清理打印快照",
  /const root = createPrintableSnapshot\(source\);[\s\S]*?try \{[\s\S]*?await settlePrintableLayout\(root\);[\s\S]*?\} catch \(error\) \{[\s\S]*?cleanup\(\);[\s\S]*?throw error;/.test(
    exportDocument,
  ),
  "布局、标题和打印调用必须共用异常清理路径",
);
ok(
  "PDF 打印解除视口高度锁并隐藏应用外壳",
  /html\.koinote-printing,[\s\S]*?height: auto !important;[\s\S]*?overflow: visible !important;/.test(globals) &&
    /body > #root \{[\s\S]*?display: none !important;/.test(globals) &&
    /\.koinote-print-document \{[\s\S]*?max-width: none !important;/.test(globals),
  "长文必须由打印引擎跨页排版，不能裁在第一屏",
);
ok(
  "PDF 快照保留图片但移除图片编辑按钮",
  /querySelectorAll<HTMLElement>\("figure > button"\)/.test(exportDocument) &&
    /button\.replaceWith\(image\)/.test(exportDocument),
);
ok(
  "PDF 快照清除页内搜索高亮",
  /\.kn-page-search-match, \.kn-page-search-current/.test(exportDocument) &&
    /removeAttribute\("data-page-search-index"\)/.test(exportDocument),
  "临时查找标记不应出现在导出的 PDF 中",
);
ok(
  "Tauri 注册桌面 PDF 命令",
  /async fn desktop_export_pdf\([\s\S]*?pdf_export::export_pdf/.test(desktopLib) &&
    /desktop_abort_local_mode_import,[\s\S]*?desktop_export_pdf,/.test(desktopLib),
);
ok(
  "macOS PDF 导出不阻塞 WebKit 分页",
  /runOperationModalForWindow_delegate_didRunSelector_contextInfo/.test(desktopPdf) &&
    !/\.runOperation\(\)/.test(desktopPdf),
  "同步 NSPrintOperation 会阻塞主事件循环并持续生成空白页",
);
ok(
  "原生 PDF 等待完整文件并限制异常输出",
  /setPaperSize\(NSSize::new\(595\.28, 841\.89\)\)/.test(desktopPdf) &&
    /tail\.windows\(5\).*b"%%EOF"/.test(desktopPdf) &&
    /MAX_PDF_OUTPUT_BYTES/.test(desktopPdf),
);
ok(
  "PDF 原生错误码映射为本地化提示",
  /catch \(caught\)[\s\S]*?exportErrorText\(caught, t\.editor\.exportFailed, t\.errors\)/.test(menu),
  "客户端不应吞掉原生导出的具体失败原因",
);

console.log(`自媒体导出：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
