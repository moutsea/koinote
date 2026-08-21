import { readFileSync } from "node:fs";
import {
  findTextMatches,
  isPageSearchShortcut,
  nextPageSearchIndex,
} from "./_page_search_core_bundle.mjs";

let pass = 0;
let fail = 0;

function ok(label, condition, detail = "") {
  if (condition) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL  ${label}${detail ? ` —— ${detail}` : ""}`);
  }
}

function equal(label, actual, expected) {
  ok(label, JSON.stringify(actual) === JSON.stringify(expected), `${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}

equal("中文关键词返回全部位置", findTextMatches("页内搜索，搜索当前页", "搜索"), [
  { from: 2, to: 4 },
  { from: 5, to: 7 },
]);
equal("英文搜索忽略大小写", findTextMatches("Koinote koiNOTE", "koinote"), [
  { from: 0, to: 7 },
  { from: 8, to: 15 },
]);
equal("正则特殊字符按字面量查找", findTextMatches("a+b a.b a+b", "a+b"), [
  { from: 0, to: 3 },
  { from: 8, to: 11 },
]);
equal("空关键词不搜索", findTextMatches("anything", "  "), []);
equal("搜索结果尊重上限", findTextMatches("aaaa", "a", 2), [
  { from: 0, to: 1 },
  { from: 1, to: 2 },
]);

ok("Cmd+F 打开页内搜索", isPageSearchShortcut({ key: "f", metaKey: true, ctrlKey: false }));
ok("Ctrl+F 打开页内搜索", isPageSearchShortcut({ key: "F", metaKey: false, ctrlKey: true }));
ok("输入法组合期间不接管", !isPageSearchShortcut({ key: "f", metaKey: true, ctrlKey: false, isComposing: true }));
ok("Alt+Ctrl+F 不接管", !isPageSearchShortcut({ key: "f", metaKey: false, ctrlKey: true, altKey: true }));
ok("Cmd+Shift+F 不接管", !isPageSearchShortcut({ key: "f", metaKey: true, ctrlKey: false, shiftKey: true }));

ok("下一个结果循环回开头", nextPageSearchIndex(2, 3, 1) === 0);
ok("上一个结果循环到末尾", nextPageSearchIndex(0, 3, -1) === 2);
ok("空结果保持 -1", nextPageSearchIndex(0, 0, 1) === -1);
ok("初次向后选择第一项", nextPageSearchIndex(-1, 3, 1) === 0);
ok("初次向前选择末项", nextPageSearchIndex(-1, 3, -1) === 2);

const bar = readFileSync(new URL("../spa/src/components/editor/DocumentFindBar.tsx", import.meta.url), "utf8");
const extension = readFileSync(new URL("../spa/src/components/editor/pageSearch.ts", import.meta.url), "utf8");
const extensions = readFileSync(new URL("../spa/src/components/editor/extensions.ts", import.meta.url), "utf8");
const editor = readFileSync(new URL("../spa/src/components/editor/MarkdownEditor.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../spa/src/globals.css", import.meta.url), "utf8");

ok("快捷键仅由可见编辑器接管", /getClientRects\(\)\.length/.test(bar));
ok("Enter 与 Shift+Enter 切换结果", /event\.shiftKey \? -1 : 1/.test(bar));
ok("Escape 关闭并清理高亮", /event\.key === "Escape"[\s\S]*?close\(\)/.test(bar) && /clearDocumentSearch/.test(bar));
ok("正文搜索使用 ProseMirror decorations", /Decoration\.inline/.test(extension) && /DecorationSet\.create/.test(extension));
ok("行内格式拆分后仍可跨节点匹配", /block\.descendants/.test(extension) && /documentFrom/.test(extension));
ok("搜索扩展注册进编辑器", /PageSearchExtension/.test(extensions));
ok("查找栏挂在当前编辑器实例", /<DocumentFindBar/.test(editor) && /editorRootRef/.test(editor));
ok("普通与当前结果样式分开", /\.kn-page-search-match/.test(css) && /\.kn-page-search-current/.test(css));

console.log(`页内搜索：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
