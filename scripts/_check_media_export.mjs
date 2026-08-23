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
const exportMedia = readFileSync(new URL("../spa/src/components/editor/exportMedia.ts", import.meta.url), "utf8");
const exportWechat = readFileSync(new URL("../spa/src/components/editor/exportWechat.ts", import.meta.url), "utf8");
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
  "微信为会员提供 GEO 实验开关",
  /useState\(false\)/.test(dialog) &&
    /t\.editor\.wechatGeoExperiment/.test(dialog) &&
    /type="checkbox"/.test(dialog) &&
    /platform === "wechat" && member && !localMode/.test(dialog),
);
ok(
  "GEO 摘要由 AI 生成后才能嵌入",
  /generateWechatGeoSummary\([\s\S]{0,120}docId,[\s\S]{0,40}title,[\s\S]{0,40}markdown/.test(dialog) &&
    /platform === "wechat" &&\s+member &&\s+!localMode &&\s+geoEnabled &&\s+!geoText\.trim\(\)/.test(dialog),
);
ok(
  "GEO 摘要按文档恢复并保存编辑与开关状态",
  /getWechatGeoSummary\(docId\)/.test(dialog) &&
    /setGeoText\(result\.geo\.text\)/.test(dialog) &&
    /setGeoEnabled\(result\.geo\.enabled\)/.test(dialog) &&
    /updateWechatGeoSummary\(docId, \{ text: geoText \}\)/.test(dialog) &&
    /updateWechatGeoSummary\(docId, \{ enabled: next \}\)/.test(dialog) &&
    /result\.geo\.sourceHash !== sourceHash/.test(dialog),
);
ok(
  "GEO 文本失焦不会吞掉开关点击",
  /disabled=\{busy \|\| geoLoading \|\| geoGenerating\}/.test(dialog) &&
    !/type="checkbox"[\s\S]{0,180}disabled=\{[^}]*geoTextSaving/.test(dialog),
  "文本保存期间应允许用户切换是否嵌入摘要",
);
ok(
  "GEO 开关写入按点击顺序串行化",
  /geoPreferenceQueueRef = useRef<Promise<void>>\(Promise\.resolve\(\)\)/.test(dialog) &&
    /const previousPreferenceSave = geoPreferenceQueueRef\.current/.test(dialog) &&
    /geoPreferenceQueueRef\.current = preferenceSave/.test(dialog) &&
    /version === geoPreferenceVersionRef\.current/.test(dialog),
  "快速连点不能让旧响应覆盖最新选择",
);
ok(
  "GEO 关闭先保存但不会把用户困在弹窗中",
  /async function closeDialog\(\) \{[\s\S]{0,220}if \(!closeSaveFailedRef\.current && !\(await persistGeoText\(\)\)\) \{\s*closeSaveFailedRef\.current = true;\s*return;/.test(dialog) &&
    /closeSaveFailedRef\.current = false;\s*setGeoText\(event\.target\.value\)/.test(dialog) &&
    /if \(e\.key === "Escape"\) \{[\s\S]{0,120}closeDialogRef\.current\(\)/.test(dialog) &&
    (dialog.match(/onClick=\{\(\) => void closeDialog\(\)\}/g) ?? []).length === 2 &&
    /useEffect\(\(\) => \{\s*closeDialogRef\.current = \(\) => \{\s*void closeDialog\(\);\s*\};\s*\}\);/.test(dialog) &&
    /async function generateGeoSummary\(\) \{[\s\S]{0,400}if \(!\(await persistGeoText\(\)\)\) return;/.test(dialog),
  "首次关闭保存失败时提示错误，再次关闭必须允许放弃修改",
);
ok(
  "GEO 关闭保存期间提供反馈并阻止重复提交",
  /closeInFlightRef\.current/.test(dialog) &&
    /setGeoClosing\(true\)/.test(dialog) &&
    /disabled=\{geoClosing\}/.test(dialog) &&
    /geoClosing \? t\.editor\.wechatGeoSaving : t\.editor\.shareClose/.test(dialog),
);
ok(
  "GEO 关闭或卸载会取消仍在生成的付费请求",
  /geoGenerateAbortRef = useRef<AbortController \| null>\(null\)/.test(dialog) &&
    /generateWechatGeoSummary\([\s\S]{0,140}controller\.signal/.test(dialog) &&
    (dialog.match(/geoGenerateAbortRef\.current\?\.abort\(\)/g) ?? []).length >= 2 &&
    /if \(controller\.signal\.aborted\) return;/.test(dialog),
  "离开弹窗后不能继续后台扣 credits",
);
ok(
  "GEO 只传给微信公众号导出",
  /platform === "wechat" && options\.includeWechatGeoCorpus === true/.test(exportMedia),
);
ok(
  "微信导出在标题后用分割线标记隐藏语料",
  /normalizeWechatGeoCorpus\(options\.geoText \?\? ""\)/.test(exportWechat) &&
    /document\.createElement\("hr"\)/.test(exportWechat) &&
    /titleElement\.insertAdjacentElement\("afterend", geoDivider\)/.test(
      exportWechat,
    ) &&
    /stage\.prepend\(geoDivider\)/.test(exportWechat) &&
    /geoDivider\.insertAdjacentHTML\("afterend", geoSection\)/.test(exportWechat) &&
    /wrapWechatBody\(stage\.innerHTML, exportRules\.body\)/.test(exportWechat),
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
  /function runPDFExport\(\)[\s\S]*?exportPDF\(printSource, title, t\.editor\.untitled\)/.test(menu) &&
    /label=\{t\.editor\.exportPDF\}[\s\S]*?onClick=\{runPDFExport\}/.test(menu),
);
ok(
  "忽略并发导出前会清理旧错误",
  /setError\(null\);\s*if \(busyRef\.current\) return;/.test(menu),
  "旧错误不能因为本次点击被 busy 守卫忽略而继续显示",
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
