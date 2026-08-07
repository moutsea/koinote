// 代码块顶部的 Mac 窗口三点。
//
// 这个效果在微信里能不能活，取决于它只依赖已经被证实存活的东西：
// span 上的 color（语法高亮就是靠它活下来的）和 NBSP（缩进靠它）。
// 反过来说，任何依赖 width / height / border-radius / 伪元素的方案都不可信 ——
// 微信剥掉 <style>，而这几条声明是否在内联时存活我们没有证据。
//
// 所以断言的重点是「不依赖不可信的东西」，以及与前两次修复不冲突。
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
  ok("窗口栏存在", !!bar);
  const barStyle = bar.getAttribute("style") ?? "";
  const dots = [...bar.querySelectorAll("span")];
  eq("有三个点", dots.length, 3);

  // 点必须靠 color 显色 —— 那是唯一有实证会存活的属性
  for (const [i, dot] of dots.entries()) {
    const style = dot.getAttribute("style") ?? "";
    ok(`第 ${i + 1} 点有 color`, /color:#[0-9a-f]{6}/i.test(style), style);
    // 内容必须是可见字符，不能靠尺寸撑出来
    ok(`第 ${i + 1} 点有字符内容`, dot.textContent.trim().length > 0, dot.textContent);
  }

  // 不能依赖这些：任何一条被剥掉，方块方案就会消失（零尺寸）或变成直角块。
  //
  // height 要用「前面不是 line-」的写法排除 line-height —— 后者是必需的
  // （压住微信塞的行高），不是尺寸依赖。
  const allStyles = barStyle + dots.map((d) => d.getAttribute("style")).join("");
  for (const [label, pattern] of [
    ["width", /(?:^|;)\s*width:/],
    ["height", /(?:^|;|[^-])\bheight:/],
    ["border-radius", /border-radius:/],
  ]) {
    ok(`不依赖 ${label}`, !pattern.test(allStyles), allStyles);
  }
  // 反过来确认 line-height 确实在（上面那条排除规则不能把它一起排掉）
  ok("line-height 仍在", allStyles.includes("line-height:"), allStyles);
  // 也不能用伪元素（内联时会被静默丢掉）
  ok("不含伪元素写法", !allStyles.includes("::"), allStyles);

  // 三点之间必须是 NBSP：普通空格会被折叠（white-space 已被微信剥掉）
  ok("点之间是 NBSP", bar.textContent.includes(NBSP), JSON.stringify(bar.textContent));
  ok(
    "点之间不是普通空格",
    !/●[ \t]●/.test(bar.textContent),
    JSON.stringify(bar.textContent),
  );

  // 行高必须压住：不写的话微信塞自己的行高，顶部会多出一大片空白
  ok("窗口栏压了行高", barStyle.includes("line-height:1"), barStyle);
  for (const [i, dot] of dots.entries()) {
    ok(
      `第 ${i + 1} 点压了行高`,
      (dot.getAttribute("style") ?? "").includes("line-height:1"),
      dot.getAttribute("style"),
    );
  }
  // display:block 让它独占一行
  ok("窗口栏是 block", barStyle.includes("display:block"), barStyle);
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
  const colors = dots.map((d) =>
    ((d.getAttribute("style") ?? "").match(/color:(#[0-9a-f]{6})/i) ?? [])[1],
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
