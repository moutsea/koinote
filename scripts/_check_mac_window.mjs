// 代码块的 Mac 窗口外观：标题栏 + 三点 + 圆角 + 投影。
//
// 上一版这里断言的是「不得出现 width/height/border-radius」，理由是那些声明
// 是否在微信里存活没有证据，只有 color 有（语法高亮靠它活下来）。
// 那个前提已被推翻 —— mdnice 导出到微信的产物里明确带着这些声明且能正常显示，
// 所以现在用真实圆形。字符方案的问题正是尺寸受字体摆布，三个 ● 胖瘦不一。
//
// 断言重点相应改成：三点是真实圆形（有尺寸、有 border-radius:50%、有背景色）、
// 标题栏与代码区同底色连成一块面板、pre 的 padding 被归零（否则标题栏齐不了边）、
// 以及不能破坏前两次修好的高亮与缩进。
//
// 伪元素仍然不能用于导出 —— 那条限制没变，微信剥 <style>。
import { parseHTML } from "linkedom";
import { addMacWindows, buildMacBar, dotsFor, macWindowCSS } from "./_mac_window_bundle.mjs";
import { highlightCodeBlocks } from "./_highlight_code_bundle.mjs";
import { structuralizeCodeWhitespace } from "./_wechat_whitespace_bundle.mjs";
import { inlineWechatStyles } from "./_wechat_inline_bundle.mjs";
import { WECHAT_THEMES, resolveThemeRules } from "./_wechat_themes_bundle.mjs";

let pass = 0;
let fail = 0;

function eq(label, got, want) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g === w) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL  ${label} —— 得到 ${g}，期望 ${w}`);
  }
}

function ok(label, cond, detail) {
  if (cond) pass += 1;
  else {
    fail += 1;
    console.error(
      `FAIL  ${label}${detail === undefined ? "" : ` —— ${JSON.stringify(detail)}`}`,
    );
  }
}

const NBSP = " ";

function escapeHTML(v) {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** 完整导出链路 */
function pipeline(bodyHTML, rules) {
  const { document } = parseHTML(`<div id="s">${bodyHTML}</div>`);
  const root = document.getElementById("s");
  highlightCodeBlocks(root);
  structuralizeCodeWhitespace(root);
  const added = addMacWindows(root, rules.pre ?? "");
  const stats = inlineWechatStyles(root, rules);
  return { root, added, stats, html: root.innerHTML };
}

const CODE = 'def f(x):\n    return "y"';
const BLOCK = `<pre><code class="language-python">${escapeHTML(CODE)}</code></pre>`;

// ---------- dotsFor ----------
{
  const light = dotsFor("background:#f2f2f2;");
  const dark = dotsFor("background:#111;");
  eq("浅底给 3 个颜色", light.length, 3);
  eq("深底给 3 个颜色", dark.length, 3);
  ok("深浅两套不同", JSON.stringify(light) !== JSON.stringify(dark), { light, dark });
  // 三个点必须互不相同 —— 交通灯的意义就在于三色
  for (const [label, set] of [["浅", light], ["深", dark]]) {
    eq(`${label}底三点互不相同`, new Set(set).size, 3);
  }
  // 取不到底色时不能崩，且要有 3 个
  eq("无背景声明也给 3 个", dotsFor("").length, 3);
  eq("var() 底色也给 3 个", dotsFor("background:var(--x);").length, 3);
}

// ---------- 不依赖不可信的 CSS ----------
//
// 这一组是这个效果能否在微信里存活的关键。

{
  const rules = WECHAT_THEMES[0].rules;
  const { root } = pipeline(BLOCK, rules);
  const bar = root.querySelector("pre > span");
  ok("标题栏存在", !!bar);
  const barStyle = bar.getAttribute("style") ?? "";
  const dots = [...bar.querySelectorAll("span")];
  eq("有三个点", dots.length, 3);

  for (const [i, dot] of dots.entries()) {
    const style = dot.getAttribute("style") ?? "";
    const n = i + 1;
    // 圆形三要素：尺寸、50% 圆角、背景色。缺任何一条就不是圆点
    ok(`第 ${n} 点有 width`, /width:\d+px/.test(style), style);
    ok(`第 ${n} 点有 height`, /(?:^|;)height:\d+px/.test(style), style);
    ok(`第 ${n} 点是圆的`, style.includes("border-radius:50%"), style);
    ok(`第 ${n} 点有背景色`, /background:#[0-9a-f]{6}/i.test(style), style);
    // inline-block 才能让 width/height 生效 —— 纯 inline 元素两者都不起作用
    ok(`第 ${n} 点是 inline-block`, style.includes("display:inline-block"), style);
    // 宽高必须相等，否则是椭圆
    const w = Number(/width:(\d+)px/.exec(style)?.[1]);
    const h = Number(/(?:^|;)height:(\d+)px/.exec(style)?.[1]);
    eq(`第 ${n} 点宽高相等`, w, h);
    // 不能有字符内容 —— 圆形靠尺寸撑出来，混进字符会把它顶高
    eq(`第 ${n} 点无文字内容`, dot.textContent, "");
  }

  // 前两个点要有右间距，最后一个不要（否则三点整体偏左，看着不居中）
  eq(
    "前两点有右间距",
    dots
      .slice(0, 2)
      .filter((d) => (d.getAttribute("style") ?? "").includes("margin-right:")).length,
    2,
  );
  ok(
    "最后一点无右间距",
    !(dots[2].getAttribute("style") ?? "").includes("margin-right:"),
    dots[2].getAttribute("style"),
  );

  // 标题栏本身
  ok("标题栏是 block", barStyle.includes("display:block"), barStyle);
  ok("标题栏有高度", /height:\d+px/.test(barStyle), barStyle);
  // font-size:0 防止混进来的空白文本节点用行高把标题栏顶高
  ok("标题栏 font-size 归零", barStyle.includes("font-size:0"), barStyle);
  // 顶部两角圆、底部不圆 —— 它要和下面的代码区连成一块
  ok("标题栏只有上圆角", /border-radius:\S+ \S+ 0 0/.test(barStyle), barStyle);

  // 伪元素在导出里仍然用不了（微信剥 <style>）
  const allStyles = barStyle + dots.map((d) => d.getAttribute("style")).join("");
  ok("不含伪元素写法", !allStyles.includes("::"), allStyles);
}

// ---------- 标题栏与代码区连成一块面板 ----------
//
// 这是「像个窗口」而不是「三个点浮在代码上面」的关键。
for (const theme of WECHAT_THEMES) {
  const { root } = pipeline(BLOCK, theme.rules);
  const pre = root.querySelector("pre");
  const bar = root.querySelector("pre > span");
  const code = root.querySelector("pre > code");
  const preStyle = pre.getAttribute("style") ?? "";
  const barStyle = bar.getAttribute("style") ?? "";
  const codeStyle = code.getAttribute("style") ?? "";

  // 标题栏底色必须与主题的 pre 底色一致，否则中间会出现一条色差横条
  const preBg = /background:(#[0-9a-f]{3,6})/i.exec(theme.rules.pre)?.[1];
  if (preBg) {
    ok(
      `${theme.id}: 标题栏与代码区同底色`,
      barStyle.toLowerCase().includes(`background:${preBg.toLowerCase()}`),
      { barStyle, preBg },
    );
  }

  // pre 的 padding 必须归零 —— 留着的话标题栏会被往里缩一圈，像贴歪的贴纸。
  // 内联顺序是「主题规则 + 补充 + 高亮 + 保留样式」，生效的是最后一个
  const pads = [...preStyle.matchAll(/(?:^|;)padding:([^;]+)/g)].map((m) => m[1]);
  eq(`${theme.id}: pre 最终 padding 为 0`, pads[pads.length - 1], "0");

  // 内边距移到 code 上，且必须 display:block（行内元素的上下 padding 不占布局）
  ok(`${theme.id}: code 是 block`, codeStyle.includes("display:block"), codeStyle);
  const codePads = [...codeStyle.matchAll(/(?:^|;)padding:([^;]+)/g)].map((m) => m[1]);
  ok(
    `${theme.id}: code 有内边距`,
    codePads.length > 0 && codePads[codePads.length - 1] !== "0",
    codeStyle,
  );

  // 圆角与投影落在 pre 上
  ok(`${theme.id}: pre 有圆角`, /border-radius:\d+px;/.test(preStyle), preStyle);
  ok(`${theme.id}: pre 有投影`, preStyle.includes("box-shadow:"), preStyle);
}

// ---------- 位置：必须在 code 之前 ----------
{
  const rules = WECHAT_THEMES[0].rules;
  const { root } = pipeline(BLOCK, rules);
  const pre = root.querySelector("pre");
  eq("第一个子元素是窗口栏", pre.firstElementChild.tagName.toLowerCase(), "span");
  eq("第二个子元素是 code", pre.children[1].tagName.toLowerCase(), "code");
}

// ---------- 每套主题都要有，且颜色随底色分流 ----------
for (const theme of WECHAT_THEMES) {
  const { root, added } = pipeline(BLOCK, theme.rules);
  eq(`${theme.id}: 插了 1 条`, added, 1);
  const dots = [...root.querySelectorAll("pre > span > span")];
  eq(`${theme.id}: 有 3 个点`, dots.length, 3);
  // 点色现在走 background（真实圆形），不是 color（字符方案）
  const colors = dots.map((d) =>
    ((d.getAttribute("style") ?? "").match(/background:(#[0-9a-f]{6})/i) ?? [])[1],
  );
  eq(`${theme.id}: 三点颜色齐全`, colors.filter(Boolean).length, 3);
  eq(`${theme.id}: 三点颜色互不相同`, new Set(colors).size, 3);
}

// ---------- 不能破坏前两次的修复 ----------
{
  const rules = WECHAT_THEMES[0].rules;
  const { root, html } = pipeline(BLOCK, rules);
  // 高亮还在
  ok("高亮颜色还在", /<span style="[^"]*color:#cf222e/.test(html), html.slice(0, 400));
  // 缩进还在（NBSP + br）
  const code = root.querySelector("pre > code");
  ok("代码里有 br", code.querySelectorAll("br").length > 0);
  ok("代码里有 NBSP", code.textContent.includes(NBSP));
  // pre 的 white-space 还在
  ok(
    "pre 仍有 white-space",
    (root.querySelector("pre").getAttribute("style") ?? "").includes("white-space:pre-wrap"),
  );
  // 窗口栏的 ● 不能被算进代码内容 —— 它在 code 外面
  ok("code 内不含 ●", !code.textContent.includes("●"), code.textContent.slice(0, 40));
  // 代码原文可还原（窗口栏在 code 之外，不该影响）
  const restored = code.textContent.replaceAll(NBSP, " ");
  ok("代码原文未被污染", restored.includes('return "y"'), restored);
}

// ---------- 幂等 ----------
{
  const rules = WECHAT_THEMES[0].rules;
  const { document } = parseHTML(`<div id="s">${BLOCK}</div>`);
  const root = document.getElementById("s");
  eq("第一次插入 1 条", addMacWindows(root, rules.pre), 1);
  const after = root.innerHTML;
  eq("第二次插入 0 条", addMacWindows(root, rules.pre), 0);
  eq("第二次不改 HTML", root.innerHTML, after);
  eq("仍只有一条窗口栏", root.querySelectorAll("pre > span").length, 1);
}

// ---------- 边界 ----------
{
  const { document } = parseHTML('<div id="s"><p>没有代码块</p></div>');
  eq("无代码块插 0 条", addMacWindows(document.getElementById("s"), ""), 0);
}
{
  // 没有 code 的 pre 不是代码块，不该加装饰
  const { document } = parseHTML('<div id="s"><pre>裸 pre</pre></div>');
  eq("裸 pre 不加", addMacWindows(document.getElementById("s"), ""), 0);
}
{
  // 多个代码块各加一条
  const { document } = parseHTML(`<div id="s">${BLOCK}<p>中间</p>${BLOCK}</div>`);
  const root = document.getElementById("s");
  eq("两个代码块各一条", addMacWindows(root, ""), 2);
  eq("共两条窗口栏", root.querySelectorAll("pre > span").length, 2);
}
{
  // 行内 code 不该被加
  const { document } = parseHTML('<div id="s"><p>用 <code>a</code> 表示</p></div>');
  const root = document.getElementById("s");
  eq("行内 code 不加", addMacWindows(root, ""), 0);
  eq("段落里没多出 span", root.querySelectorAll("p span").length, 0);
}

// ---------- buildMacBar 直接调用 ----------
{
  const { document } = parseHTML("<div></div>");
  const bar = buildMacBar(document, "background:#111;");
  eq("是 span", bar.tagName.toLowerCase(), "span");
  eq("三个子 span", bar.querySelectorAll("span").length, 3);
  // 深底走暗色那套
  const first = bar.querySelector("span").getAttribute("data-wechat-keep-style");
  ok("深底用暗色点", first.includes("#e0443e"), first);
}
{
  const { document } = parseHTML("<div></div>");
  const bar = buildMacBar(document, "background:#f2f2f2;");
  const first = bar.querySelector("span").getAttribute("data-wechat-keep-style");
  ok("浅底用亮色点", first.includes("#ff5f56"), first);
}

// ---------- 编辑区的伪元素版 ----------
{
  const css = macWindowCSS(".koinote-themed", false);
  ok("是伪元素规则", css.includes("pre::before"), css);
  ok("有 content", css.includes('content:""'), css);
  ok("三个渐变点", (css.match(/radial-gradient/g) ?? []).length === 3, css);
  // 三个颜色都在
  for (const color of ["#ff5f56", "#ffbd2e", "#27c93f"]) {
    ok(`浅色版含 ${color}`, css.includes(color), css);
  }
  const darkCSS = macWindowCSS(".dark .koinote-themed", true);
  for (const color of ["#e0443e", "#dea123", "#1aab29"]) {
    ok(`深色版含 ${color}`, darkCSS.includes(color), darkCSS);
  }
  ok("作用域正确", darkCSS.startsWith(".dark .koinote-themed"), darkCSS);
  // 不能用 content 塞字符 —— 那样三个点只能同色
  ok("没用 content 塞 ●", !css.includes("●"), css);
}

// ---------- 深色变体（编辑区用）也要有点色 ----------
for (const theme of WECHAT_THEMES) {
  const dark = resolveThemeRules(theme, "dark");
  const dots = dotsFor(dark.pre ?? "");
  eq(`${theme.id}/dark: 3 个点色`, dots.length, 3);
  eq(`${theme.id}/dark: 互不相同`, new Set(dots).size, 3);
}

console.log(`\nmac window: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
