// 标签池的迁移规则校验。边界情形靠手点覆盖不全，尤其淘汰时序与关闭当前标签。
import {
  EMPTY_TABS,
  LIVE_LIMIT,
  activate,
  close,
  hydrate,
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
