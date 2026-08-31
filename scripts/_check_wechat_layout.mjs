import { parseHTML } from "linkedom";
import {
  applyWechatLayoutModules,
  parseWechatLayoutBlocks,
} from "./_wechat_layout_bundle.mjs";
import {
  inspectWechatArticle,
  parseArticleMetadata,
  removeWechatFrontmatterNodes,
} from "./_wechat_preflight_bundle.mjs";

let pass = 0;
let fail = 0;

function ok(label, condition, detail = "") {
  if (condition) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL  ${label}${detail ? ` —— ${detail}` : ""}`);
  }
}

const markdown = `---
title: "Frontmatter 标题"
author: Koinote
summary: 一段摘要
---

## 第一节
## 第二节
## 第三节

:::callout
type: warning
body: 发布前请检查图片。
:::

:::metrics[核心数据]
阅读量 | 42% | 来自最近一轮测试
效率 | 2x | 比原流程更快
:::`;

const parsed = parseArticleMetadata(markdown, "文档标题");
ok("识别 frontmatter 标题", parsed.metadata.title === "Frontmatter 标题");
ok("frontmatter 从正文移除", !parsed.body.includes("author: Koinote"));

const frontmatterDOM = parseHTML('<div id="frontmatter"><h1>Frontmatter 标题</h1><hr><p>title: Frontmatter 标题</p><p>author: Koinote</p><hr><p>正文</p></div>').document;
const frontmatterStage = frontmatterDOM.getElementById("frontmatter");
removeWechatFrontmatterNodes(frontmatterStage);
ok("编辑器把分隔符解析成 hr 时仍移除 frontmatter", frontmatterStage.innerHTML === "<h1>Frontmatter 标题</h1><p>正文</p>");

const setextFrontmatterDOM = parseHTML('<div id="frontmatter"><h1>Frontmatter 标题</h1><hr><h2>title: Frontmatter 标题\nauthor: Koinote\nsummary: 一段摘要</h2><h1>正文标题</h1><p>正文内容</p><hr><p>正文分隔后的内容</p></div>').document;
const setextFrontmatterStage = setextFrontmatterDOM.getElementById("frontmatter");
removeWechatFrontmatterNodes(setextFrontmatterStage);
ok("结束分隔符被 Markdown 解析为 setext 标题时不误删正文", setextFrontmatterStage.innerHTML === "<h1>Frontmatter 标题</h1><h1>正文标题</h1><p>正文内容</p><hr><p>正文分隔后的内容</p>");

const fieldBodyDOM = parseHTML('<div id="frontmatter"><hr><h2>title: Frontmatter 标题</h2><p>title: 正文中的字段样式内容</p><h1>后续正文</h1></div>').document;
const fieldBodyStage = fieldBodyDOM.getElementById("frontmatter");
removeWechatFrontmatterNodes(fieldBodyStage, ["title"]);
ok("正文首段恰好像 frontmatter 字段时仍保留正文", fieldBodyStage.innerHTML === "<p>title: 正文中的字段样式内容</p><h1>后续正文</h1>");

const emptyFrontmatterDOM = parseHTML('<div id="frontmatter"><hr><p>status: 正文内容</p><h1>后续正文</h1></div>').document;
const emptyFrontmatterStage = emptyFrontmatterDOM.getElementById("frontmatter");
removeWechatFrontmatterNodes(emptyFrontmatterStage, []);
ok("空 frontmatter 不会吞掉紧随其后的字段样式正文", emptyFrontmatterStage.innerHTML === "<p>status: 正文内容</p><h1>后续正文</h1>");

const blocks = parseWechatLayoutBlocks(parsed.body);
ok("识别结构化模块", blocks.blocks.length === 2);
ok("未知模块不阻断解析", parseWechatLayoutBlocks(":::unknown\ntext\n:::").diagnostics.some((item) => item.code === "unsupported_module"));
ok("未闭合模块被报告", parseWechatLayoutBlocks(":::quote\ntext").diagnostics.some((item) => item.code === "unclosed_module"));
ok("代码围栏中的示例不被当作模块", parseWechatLayoutBlocks("```markdown\n:::hero\ntitle: 示例\n:::\n```").blocks.length === 0);

const { document } = parseHTML(`<div id="stage"><h2>第一节</h2><h2>第二节</h2><h2>第三节</h2><p>:::callout</p><p>type: warning</p><p>body: 发布前请检查图片。</p><p>:::</p><p>:::metrics[核心数据]</p><p>阅读量 | 42% | 来自最近一轮测试</p><p>效率 | 2x | 比原流程更快</p><p>:::</p></div>`);
globalThis.document = document;
const stage = document.getElementById("stage");
const rendered = applyWechatLayoutModules(stage, parsed.body);
ok("渲染 callout 和 metrics", rendered.rendered === 2);
ok("渲染结果不保留模块标记", !stage.textContent.includes(":::callout") && !stage.textContent.includes(":::metrics"));
ok("渲染结果使用安全元素", stage.querySelectorAll("script").length === 0 && stage.querySelectorAll("section").length >= 2);

const { document: inlineDocument } = parseHTML('<div id="inline"><p>:::callout\ntype: info\nbody: 一段提示\n:::</p></div>');
globalThis.document = inlineDocument;
const inlineStage = inlineDocument.getElementById("inline");
const inlineRendered = applyWechatLayoutModules(inlineStage, ":::callout\ntype: info\nbody: 一段提示\n:::");
ok("同一段落中的模块标记也能渲染", inlineRendered.rendered === 1 && inlineStage.querySelector("section")?.textContent.includes("一段提示"));

const report = inspectWechatArticle(markdown, "文档标题");
ok("检查报告包含标题重复之外的结构信息", report.headings.length === 3 && report.images.total === 0);
ok("长文结构给出目录建议", report.advice.includes("toc"));
ok("数字证据给出 metrics 建议", report.advice.includes("metrics"));

console.log(`wechat layout checks: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
