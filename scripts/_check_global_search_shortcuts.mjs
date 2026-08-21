import { readFileSync } from "node:fs";
import {
  countQuickOpenDocuments,
  detectGlobalSearchPlatform,
  filterQuickOpenDocuments,
  globalSearchShortcutMode,
  nextGlobalSearchIndex,
} from "./_global_search_core_bundle.mjs";

let pass = 0;
let fail = 0;

function eq(label, actual, expected) {
  const got = JSON.stringify(actual);
  const want = JSON.stringify(expected);
  if (got === want) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL  ${label}: got ${got}, want ${want}`);
  }
}

function event(overrides = {}) {
  return {
    key: "k",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    repeat: false,
    defaultPrevented: false,
    ...overrides,
  };
}

eq("识别 macOS", detectGlobalSearchPlatform("MacIntel", "Safari"), "mac");
eq("识别 Windows", detectGlobalSearchPlatform("Win32", "Chrome"), "other");
eq(
  "既有 Cmd+K 全文搜索",
  globalSearchShortcutMode(event({ metaKey: true }), "mac", false),
  "fulltext",
);
eq(
  "既有 Ctrl+K 全文搜索",
  globalSearchShortcutMode(event({ ctrlKey: true }), "other", false),
  "fulltext",
);
eq(
  "桌面 Cmd+P 快速打开",
  globalSearchShortcutMode(event({ key: "p", metaKey: true }), "mac", true),
  "quick-open",
);
eq(
  "桌面 Ctrl+P 快速打开",
  globalSearchShortcutMode(event({ key: "P", ctrlKey: true }), "other", true),
  "quick-open",
);
eq(
  "桌面 Cmd+Shift+F 全文搜索",
  globalSearchShortcutMode(
    event({ key: "f", metaKey: true, shiftKey: true }),
    "mac",
    true,
  ),
  "fulltext",
);
eq(
  "桌面 Ctrl+Shift+F 全文搜索",
  globalSearchShortcutMode(
    event({ key: "f", ctrlKey: true, shiftKey: true }),
    "other",
    true,
  ),
  "fulltext",
);
eq(
  "浏览器保留 Cmd+P",
  globalSearchShortcutMode(event({ key: "p", metaKey: true }), "mac", false),
  null,
);
eq(
  "浏览器保留 Ctrl+Shift+F",
  globalSearchShortcutMode(
    event({ key: "f", ctrlKey: true, shiftKey: true }),
    "other",
    false,
  ),
  null,
);
eq(
  "macOS 不接管 Ctrl+P",
  globalSearchShortcutMode(event({ key: "p", ctrlKey: true }), "mac", true),
  null,
);
eq(
  "Windows 不接管 Cmd+P",
  globalSearchShortcutMode(event({ key: "p", metaKey: true }), "other", true),
  null,
);

for (const [label, overrides] of [
  ["输入法组合态", { metaKey: true, key: "p", isComposing: true }],
  ["长按重复", { metaKey: true, key: "p", repeat: true }],
  ["Alt 组合", { metaKey: true, key: "p", altKey: true }],
  ["已被处理", { metaKey: true, key: "p", defaultPrevented: true }],
  ["Ctrl 与 Cmd 同按", { metaKey: true, ctrlKey: true, key: "p" }],
]) {
  eq(label, globalSearchShortcutMode(event(overrides), "mac", true), null);
}

const documents = [
  { docId: "a", title: "Weekly report" },
  { docId: "b", title: "Project plan" },
  { docId: "c", title: "Report archive" },
];
eq("空关键词保持文档顺序", filterQuickOpenDocuments(documents, ""), documents);
eq(
  "快速打开按标题过滤且忽略大小写",
  filterQuickOpenDocuments(documents, "REPORT").map((document) => document.docId),
  ["a", "c"],
);
eq(
  "快速打开限制结果数",
  filterQuickOpenDocuments(documents, "", 2).map((document) => document.docId),
  ["a", "b"],
);
eq("零上限返回空", filterQuickOpenDocuments(documents, "", 0), []);
eq("快速打开返回完整匹配数", countQuickOpenDocuments(documents, "report"), 2);

eq("结果向下移动", nextGlobalSearchIndex(0, 3, 1), 1);
eq("结果向下循环", nextGlobalSearchIndex(2, 3, 1), 0);
eq("结果向上循环", nextGlobalSearchIndex(0, 3, -1), 2);
eq("无结果时没有选中项", nextGlobalSearchIndex(0, 0, 1), -1);

const source = readFileSync("spa/src/components/GlobalSearch.tsx", "utf8");
for (const [label, fragment] of [
  ["接入桌面运行时守卫", "globalSearchShortcutMode(event, platform, desktop)"],
  ["快速打开复用文档列表", 'useDocumentList(open && mode === "quick-open")'],
  ["支持方向键选择", 'event.key === "ArrowDown"'],
  ["方向键高亮滚动跟随", 'scrollIntoView({'],
  ["查询变化裁剪旧节点引用", "itemRefs.current.length = items.length"],
  ["滚动 effect 覆盖查询重置", "[activeIndex, items]"],
  ["支持回车打开", 'event.key === "Enter" && activeIndex >= 0'],
  ["截断结果提示继续输入", "t.search.quickOpenMore"],
]) {
  eq(label, source.includes(fragment), true);
}
eq("鼠标悬停不覆盖键盘选中项", source.includes("onMouseEnter="), false);
eq(
  "state updater 中没有滚动副作用",
  source.includes("window.requestAnimationFrame"),
  false,
);

console.log(`\nglobal search shortcuts: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
