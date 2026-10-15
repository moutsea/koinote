import assert from "node:assert/strict";
import { fitHeaderNav } from "./_header_nav_bundle.mjs";

const web = ["editor", "space", "hub", "download", "docs", "pricing"];
const widths = { editor: 50, space: 60, hub: 110, download: 70, docs: 50, pricing: 80 };
const fit = (available, keys = web) => [...fitHeaderNav({ available, keys, widths, moreWidth: 48, gap: 20 })];

// 全部放得下：420 内容 + 5 个间距 100 = 520
assert.deepEqual(fit(520), []);
// 差一点：先收下载，再加「更多」的宽度与间距
assert.deepEqual(fit(519), ["download"]);
// 继续变窄：按 下载 → 文档 → Hub → 我的空间 → 升级 → 编辑器 的顺序收。
// 收起后的需求宽度 = 剩余入口 + 「更多」48 + (项数 - 1) × 20
assert.deepEqual(fit(450), ["download", "docs"]); // 300 + 48 + 80 = 428
assert.deepEqual(fit(300), ["download", "docs", "hub"]); // 190 + 48 + 60 = 298
assert.deepEqual(fit(250), ["download", "docs", "hub", "space"]); // 130 + 48 + 40 = 218
assert.deepEqual(fit(150), ["download", "docs", "hub", "space", "pricing"]); // 50 + 48 + 20 = 118
// 一个都放不下时全部进菜单，只留「更多」
assert.deepEqual(fit(0), ["download", "docs", "hub", "space", "pricing", "editor"]);
// 桌面端没有下载入口：直接从文档开始收
const desktop = ["editor", "space", "hub", "docs", "pricing"];
assert.deepEqual(fit(430, desktop), []); // 350 + 80
assert.deepEqual(fit(429, desktop), ["docs"]); // 300 + 48 + 80 = 428
// 小数像素累加的误差不能让刚好放得下的导航多收一项
assert.equal(fitHeaderNav({ available: 100, keys: ["editor", "space"], widths: { editor: 40.2, space: 40.2 }, moreWidth: 48, gap: 20 }).size, 0);

console.log("header nav checks passed");
