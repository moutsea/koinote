// 标签池的迁移规则校验。边界情形靠手点覆盖不全，尤其淘汰时序与关闭当前标签。
import { readFileSync } from "node:fs";
import {
  EMPTY_TABS,
  LIVE_LIMIT,
  activate,
  close,
  hydrate,
  removeUnavailable,
} from "./_tab_pool_bundle.mjs";

let pass = 0,
  fail = 0;
const eq = (name, got, want) => {
  const g = JSON.stringify(got),
    w = JSON.stringify(want);
  if (g === w) pass++;
  else {
    fail++;
    console.log(`FAIL  ${name}\n      got  ${g}\n      want ${w}`);
  }
};
const ok = (name, cond, detail = "") => {
  if (cond) pass++;
  else {
    fail++;
    console.log(`FAIL  ${name}${detail ? `: ${detail}` : ""}`);
  }
};

// ---------- activate ----------

let s = EMPTY_TABS;
let r = activate(s, "a");
eq("首次打开", r.next, { openTabs: ["a"], liveIds: ["a"], activeDocId: "a" });
eq("首次打开无淘汰", r.evicted, []);

r = activate(r.next, "b");
eq("打开第二篇追加到末尾", r.next.openTabs, ["a", "b"]);
eq("新打开的进池首", r.next.liveIds, ["b", "a"]);

r = activate(r.next, "c");
eq("三篇都在池内", r.next.liveIds, ["c", "b", "a"]);
eq("满池未淘汰", r.evicted, []);

r = activate(r.next, "d");
eq("第四篇挤掉最久未用的", r.next.liveIds, ["d", "c", "b"]);
eq("被挤掉的是 a", r.evicted, ["a"]);
eq("标签栏保留全部四篇", r.next.openTabs, ["a", "b", "c", "d"]);

// 回到已在标签栏但已被淘汰的 a：重新入池，挤掉当前最久的 b
r = activate(r.next, "a");
eq("重新激活已淘汰的标签", r.next.liveIds, ["a", "d", "c"]);
eq("这次挤掉 b", r.evicted, ["b"]);
eq("标签栏顺序不变", r.next.openTabs, ["a", "b", "c", "d"]);

// 激活已在池首的标签：幂等，不产生淘汰
const before = r.next;
r = activate(before, "a");
eq("重复激活当前标签幂等", r.next, before);
eq("重复激活无淘汰", r.evicted, []);

// 当前标签恒在池内
for (const id of ["a", "b", "c", "d"]) {
  const t = activate({ openTabs: ["a", "b", "c", "d"], liveIds: [], activeDocId: null }, id);
  ok(`激活 ${id} 后它在池内`, t.next.liveIds.includes(id));
  ok(`激活 ${id} 后它是当前`, t.next.activeDocId === id);
}

// 池子永不超限
let big = EMPTY_TABS;
for (const id of ["a", "b", "c", "d", "e", "f", "g"]) big = activate(big, id).next;
ok("池子不超上限", big.liveIds.length === LIVE_LIMIT, `实际 ${big.liveIds.length}`);
eq("标签栏累积全部", big.openTabs, ["a", "b", "c", "d", "e", "f", "g"]);

// ---------- close ----------

const four = { openTabs: ["a", "b", "c", "d"], liveIds: ["d", "c", "b"], activeDocId: "d" };

// 关非当前标签：当前不变
r = close(four, "b");
eq("关非当前标签后标签栏", r.next.openTabs, ["a", "c", "d"]);
eq("关非当前标签当前不变", r.next.activeDocId, "d");
ok("关掉的不在池内", !r.next.liveIds.includes("b"));

// 关当前标签：激活右边那个
r = close({ openTabs: ["a", "b", "c"], liveIds: ["b"], activeDocId: "b" }, "b");
eq("关当前后激活右边", r.next.activeDocId, "c");
eq("关当前后标签栏", r.next.openTabs, ["a", "c"]);
ok("新当前在池内", r.next.liveIds.includes("c"));

// 关最右的当前标签：退到左边
r = close({ openTabs: ["a", "b", "c"], liveIds: ["c"], activeDocId: "c" }, "c");
eq("关最右后退到左边", r.next.activeDocId, "b");

// 关唯一标签：清空
r = close({ openTabs: ["a"], liveIds: ["a"], activeDocId: "a" }, "a");
eq("关唯一标签后为空", r.next, { openTabs: [], liveIds: [], activeDocId: null });

// 关不存在的标签：原样返回
const untouched = { openTabs: ["a"], liveIds: ["a"], activeDocId: "a" };
r = close(untouched, "zzz");
eq("关不存在的标签无副作用", r.next, untouched);

// 连续关到空，中途不应出现 activeDocId 不在 openTabs 里的状态
let chain = { openTabs: ["a", "b", "c"], liveIds: ["c", "b", "a"], activeDocId: "b" };
for (const victim of ["b", "c", "a"]) {
  chain = close(chain, victim).next;
  if (chain.activeDocId !== null) {
    ok(
      `连续关闭后当前标签仍在标签栏（关了 ${victim}）`,
      chain.openTabs.includes(chain.activeDocId),
      `active=${chain.activeDocId} tabs=${JSON.stringify(chain.openTabs)}`,
    );
    ok(
      `连续关闭后当前标签在池内（关了 ${victim}）`,
      chain.liveIds.includes(chain.activeDocId),
    );
  }
}
eq("全部关完为空", chain, { openTabs: [], liveIds: [], activeDocId: null });

// ---------- hydrate ----------

eq("恢复会话只挂当前那篇", hydrate(["a", "b", "c"], "b"), {
  openTabs: ["a", "b", "c"],
  liveIds: ["b"],
  activeDocId: "b",
});
eq("活动标签不在列表里时退回第一篇", hydrate(["a", "b"], "zzz"), {
  openTabs: ["a", "b"],
  liveIds: ["a"],
  activeDocId: "a",
});
eq("没有活动标签时取第一篇", hydrate(["a", "b"], null), {
  openTabs: ["a", "b"],
  liveIds: ["a"],
  activeDocId: "a",
});
eq("空列表", hydrate([], null), { openTabs: [], liveIds: [], activeDocId: null });

// ---------- 与最新文档列表对齐 ----------

r = removeUnavailable(
  { openTabs: ["a", "b", "c"], liveIds: ["b", "c"], activeDocId: "b" },
  ["a", "c"],
);
eq("云端删除当前文档后回收标签", r.next.openTabs, ["a", "c"]);
eq("云端删除当前文档后激活相邻标签", r.next.activeDocId, "c");
eq("返回被删除的标签", r.removed, ["b"]);

r = removeUnavailable(
  { openTabs: ["a", "b"], liveIds: ["b", "a"], activeDocId: "b" },
  ["a"],
  ["b"],
);
eq("编辑器内仍有待存内容时保留标签", r.next.openTabs, ["a", "b"]);
eq("受保护标签不会被报告为已删除", r.removed, []);

// 不变量：任何 hydrate 结果里 activeDocId 都在 openTabs 内（或为 null）
for (const [tabs, active] of [
  [["x"], "x"],
  [["x", "y"], "y"],
  [[], "x"],
  [["x"], null],
]) {
  const h = hydrate(tabs, active);
  ok(
    `hydrate 不变量 ${JSON.stringify(tabs)}/${active}`,
    h.activeDocId === null || h.openTabs.includes(h.activeDocId),
  );
}

// ---------- 关闭后重新激活：双击才关闭的那个 bug ----------

// close 之后若又用「已关掉的那个 id」去 activate，标签会被拉回来。
// 这是纯函数层面的正确行为——它无从判断这个 id 刚被关掉。闸门只能在调用方做，
// EditorPage 的 justClosed ref 负责这件事。这几条断言把这个契约钉住。
{
  const start = { openTabs: ["a", "b"], liveIds: ["b", "a"], activeDocId: "b" };
  const closed = close(start, "b").next;
  eq("关掉 b 后标签栏只剩 a", closed.openTabs, ["a"]);
  eq("关掉 b 后当前是 a", closed.activeDocId, "a");

  // 调用方若拿旧的 activeDocId（b）再 activate，b 会回来 —— 必须避免
  const regressed = activate(closed, "b").next;
  ok(
    "用已关闭的 id 再 activate 会把它带回来（故此需要调用方闸门）",
    regressed.openTabs.includes("b"),
    "纯函数不该自己记住关闭历史",
  );

  // 用新的 activeDocId（a）再 activate 才是幂等的
  const correct = activate(closed, "a");
  eq("用新的当前 id 再 activate 幂等", correct.next, closed);
  eq("幂等时无淘汰", correct.evicted, []);
}

// 关掉唯一标签后 activeDocId 为 null，此时调用方不该再 activate 任何东西
{
  const only = close({ openTabs: ["a"], liveIds: ["a"], activeDocId: "a" }, "a").next;
  ok("关掉唯一标签后当前为 null", only.activeDocId === null);
  ok("关掉唯一标签后池子为空", only.liveIds.length === 0);
}

// ---------- 页面接线 ----------

{
  const page = readFileSync(
    new URL("../spa/src/pages/EditorPage.tsx", import.meta.url),
    "utf8",
  );
  const liveEditor = readFileSync(
    new URL("../spa/src/components/editor/LiveEditor.tsx", import.meta.url),
    "utf8",
  );
  const markdownEditor = readFileSync(
    new URL("../spa/src/components/editor/MarkdownEditor.tsx", import.meta.url),
    "utf8",
  );
  ok(
    "活动编辑器与文档 id 绑定",
    /activeEditor\.docId\s*===\s*activeDocId/.test(page) &&
      /return \{ docId, editor: nextEditor \}/.test(page) &&
      /activeEditor\.docId\s*!==\s*activeDocId/.test(page),
  );
  ok(
    "每篇文档单独记忆选区",
    /useRef<Map<string, EditorTabSelection>>\(new Map\(\)\)/.test(page),
  );
  ok(
    "快捷键导航前同步保存当前选区",
    /const rememberActiveEditorSelection = useCallback[\s\S]*?activeEditor\.docId !== activeDocId[\s\S]*?captureEditorTabSelection[\s\S]*?if \(action === "next-tab" \|\| action === "previous-tab"\)[\s\S]*?event\.preventDefault\(\);[\s\S]*?rememberActiveEditorSelection\(\);[\s\S]*?handleSelect\(target\)/.test(
      page,
    ),
  );
  ok(
    "活动编辑器持续监听并注销选区变化",
    /currentEditor\.on\("selectionUpdate", rememberCurrentSelection\)/.test(
      page,
    ) &&
      /currentEditor\.off\("selectionUpdate", rememberCurrentSelection\)/.test(
        page,
      ) &&
      /currentEditor\.on\("blur", rememberBlur\)/.test(page) &&
      /currentEditor\.off\("blur", rememberBlur\)/.test(page) &&
      /queueMicrotask\([\s\S]*?shouldPreserveEditorFocusAfterBlur[\s\S]*?rememberSelection\(false\)/.test(
        page,
      ),
  );
  ok(
    "内部恢复事务不会回写选区记忆",
    /transaction\.getMeta\(EDITOR_TAB_SELECTION_RESTORE_META\)[\s\S]*?return;[\s\S]*?rememberSelection\(\)/.test(
      page,
    ),
  );
  const rememberSelectionBody =
    /const rememberSelection = \([^)]*\) => \{([\s\S]*?)\n    \};/.exec(
      page,
    )?.[1] ?? "";
  ok(
    "逐键选区记忆不扫描标签数组",
    rememberSelectionBody.length > 0 &&
      !/openTabs\.includes/.test(rememberSelectionBody),
    rememberSelectionBody,
  );
  ok(
    "LiveEditor 上报编辑器时携带 docId",
    /onEditorReady\?\.\(docId, editor\)/.test(liveEditor) &&
      /onEditorReady=\{handleEditorReady\}/.test(page),
  );
  ok(
    "隐藏标签不挂载全局主题样式",
    /<MarkdownEditor[\s\S]*?visible=\{visible\}/.test(liveEditor) &&
      /visible\s*=\s*true/.test(markdownEditor) &&
      /\{visible\s*&&\s*themeCSS\s*&&\s*\([\s\S]*?<style\s+data-koinote-document-theme/.test(
        markdownEditor,
      ),
    "每篇文档的主题选择器共用全局作用域，隐藏标签若继续挂 style 会覆盖当前文章",
  );
  const tabBar = readFileSync(
    new URL("../spa/src/components/editor/TabBar.tsx", import.meta.url),
    "utf8",
  );
  ok(
    "标签切换目标会保留正文焦点意图",
    /role="tab"[\s\S]*?data-koinote-editor-tab/.test(tabBar),
  );
  ok(
    "关闭或删除文档会清理选区记忆",
    [...page.matchAll(/editorSelections\.current\.delete\(docId\)/g)].length >=
      2 &&
      /const forgetClosedSelection[\s\S]*?tabStateRef\.current\.openTabs\.includes\(docId\)/.test(
        page,
      ) &&
      !/discardedEditorSelections/.test(page),
  );
  ok(
    "选区只由页面层恢复",
    /restoreEditorTabSelection\(currentEditor, remembered\)/.test(page) &&
      !/TextSelection|setSelection\(selection\)|editor\.view\.focus\(\)/.test(
        liveEditor,
      ),
  );
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
