// 微信导出的端到端链路：getHTML 的产物 → 补高亮 → 内联样式 → 可粘贴的 HTML。
//
// 为什么要有这个套件（而不是只测各环节的纯函数）：上一轮修复正是因为只测了
// 纯函数而漏掉了真正的 bug —— 每一环单独都对，但「补高亮」这一环根本不存在，
// 内联器拿到的 class 永远是空串。这类断链只有把整条链跑通才能发现。
//
// 断言的最终对象是「粘到微信里的那串 HTML」本身：里面必须有带颜色的 span。
import { parseHTML } from "linkedom";
import { highlightCodeBlocks } from "./_highlight_code_bundle.mjs";
import { inlineWechatStyles, wrapWechatBody } from "./_wechat_inline_bundle.mjs";
import { WECHAT_THEMES, resolveThemeRules } from "./_wechat_themes_bundle.mjs";
import { structuralizeCodeWhitespace } from "./_wechat_whitespace_bundle.mjs";

const NBSP = " ";

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

function escapeHTML(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 复刻 exportWechat.ts 的流程。
 *
 * 顺序与产品代码一致：先补高亮，再内联。公式那步依赖 canvas，跳过。
 */
function exportPipeline(bodyHTML, rules) {
  const { document } = parseHTML(`<div id="stage">${bodyHTML}</div>`);
  const stage = document.getElementById("stage");
  const highlighted = highlightCodeBlocks(stage);
  structuralizeCodeWhitespace(stage);
  const stats = inlineWechatStyles(stage, rules);
  return { html: wrapWechatBody(stage.innerHTML, rules.body), stats, highlighted, stage };
}

/**
 * 模拟微信剥掉 white-space 之后读者看到的行。
 *
 * 实测微信确实会剥 —— 所以这才是产物要面对的真实条件，
 * 只断言「HTML 里有 white-space 声明」是不够的。
 */
function renderWithWhitespaceStripped(element) {
  const lines = [];
  let current = "";
  const walk = (node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        current += (child.nodeValue ?? "").replace(/[ \t\n\r]+/g, " ");
      } else if (child.nodeType === 1) {
        if (child.tagName.toLowerCase() === "br") {
          lines.push(current);
          current = "";
        } else {
          walk(child);
        }
      }
    }
  };
  walk(element);
  lines.push(current);
  return lines;
}

const PY = 'def greet(name):\n    # 打招呼\n    return f"hello {name}"';
const PY_BLOCK = `<pre><code class="language-python">${escapeHTML(PY)}</code></pre>`;

// ---------- 核心：产物里真的有带颜色的 span ----------
//
// 这一条直接对应用户报的现象：「就一个灰色的代码框，代码都是文本形式」。
{
  const rules = WECHAT_THEMES[0].rules;
  const { html, stats, highlighted } = exportPipeline(PY_BLOCK, rules);

  eq("补了 1 个代码块的高亮", highlighted, 1);
  ok("有元素内联了高亮", stats.highlighted > 0, stats);
  // 最终产物里必须有 color —— 这是「有没有高亮」唯一算数的判据
  ok("产物含带 color 的 span", /<span style="[^"]*color:#/.test(html), html.slice(0, 600));
  // class 必须已被剥掉：留着微信也会删，而且白占体积
  ok("产物不含 class 属性", !/class=/.test(html), html.slice(0, 600));
  // 也不该残留 hljs 字样
  ok("产物不含 hljs", !html.includes("hljs"), html.slice(0, 600));
}

// 每套主题（含深浅两个变体）都要真的出颜色。
// 漏掉任何一套，就是那套主题的用户看到单色代码 —— 而这正是最初 bug 的表现。
for (const theme of WECHAT_THEMES) {
  for (const variant of ["light", "dark"]) {
    const rules = variant === "dark" ? resolveThemeRules(theme, true) : theme.rules;
    const { html, stats } = exportPipeline(PY_BLOCK, rules);
    const colors = [...html.matchAll(/color:(#[0-9a-f]{3,6})/gi)].map((m) => m[1]);
    ok(
      `${theme.id}/${variant}: 内联了高亮`,
      stats.highlighted > 0,
      stats,
    );
    ok(
      `${theme.id}/${variant}: 产物里有多种颜色`,
      new Set(colors.map((c) => c.toLowerCase())).size >= 2,
      colors,
    );
  }
}

// ---------- 代码原文不能被链路改坏 ----------
//
// 走完全链路之后重新解析产物，还原出的代码必须与输入等价。
//
// 「等价」而不是「全等」：换行现在是 <br> 元素、空格是 NBSP、tab 展开成 4 空格 ——
// 这是为了让缩进不依赖 CSS 而有意做的转换（见 wechatWhitespace.ts）。
// 所以比较前要把这三样还原回去。除此之外一个字符都不该变。
for (const code of [
  PY,
  "def f():\n\tif a < b and c > d:\n\t\treturn 1",
  'const s = "a & b";\nif (x < y) {}',
  "# 中文注释\nx = '🎉'",
  "u = 'https://example.com/a?b=c&d=e'",
  "s = '  两端留白  '",
]) {
  const rules = WECHAT_THEMES[0].rules;
  const { html } = exportPipeline(
    `<pre><code class="language-python">${escapeHTML(code)}</code></pre>`,
    rules,
  );
  const { document } = parseHTML(`<div id="c">${html}</div>`);
  const restored = renderWithWhitespaceStripped(document.querySelector("code"))
    .join("\n")
    .replaceAll(NBSP, " ");
  // tab 已被有意展开成 4 空格，期望值也照此归一
  const expected = code.replace(/\t/g, "    ");
  eq(`端到端保留原文：${JSON.stringify(code.slice(0, 24))}`, restored, expected);
}

// ---------- 三条修复必须同时在产物里 ----------
{
  const rules = WECHAT_THEMES[0].rules;
  const { html, stage } = exportPipeline(PY_BLOCK, rules);

  // 1. 换行不塌 —— 最严重的一条，缩进丢了 Python 就是废码
  const pre = stage.querySelector("pre");
  ok(
    "pre 上有 white-space:pre-wrap",
    (pre.getAttribute("style") ?? "").includes("white-space:pre-wrap"),
    pre.getAttribute("style"),
  );
  const preCode = stage.querySelector("pre > code");
  ok(
    "pre code 上也有 white-space:pre-wrap",
    (preCode.getAttribute("style") ?? "").includes("white-space:pre-wrap"),
    preCode.getAttribute("style"),
  );

  // 2. 每个高亮 span 都要写行高 —— 微信会给行内元素塞自己的行高
  const spans = [...stage.querySelectorAll("pre span")];
  ok("产出了 span", spans.length > 0);
  const withoutLineHeight = spans.filter(
    (s) => !(s.getAttribute("style") ?? "").includes("line-height:"),
  );
  eq("每个 span 都有 line-height", withoutLineHeight.length, 0);

  // 3. 颜色
  const withColor = spans.filter((s) =>
    (s.getAttribute("style") ?? "").includes("color:"),
  );
  ok("有 span 带 color", withColor.length > 0, spans.length);

  // 主题的 pre 底色仍在 —— 高亮不能把它冲掉
  ok("pre 保留主题底色", (pre.getAttribute("style") ?? "").includes("background:"), pre.getAttribute("style"));
  ok("产物是 section 包裹", html.startsWith("<section style="), html.slice(0, 40));
}

// ---------- 顺序敏感性 ----------
//
// 高亮必须在内联之前。反过来的话 class 已被删干净，高亮出的 span 拿不到
// 任何 style —— 有 span 但没颜色，和没高亮一样。这一条钉住那个顺序。
{
  const rules = WECHAT_THEMES[0].rules;
  const { document } = parseHTML(`<div id="stage">${PY_BLOCK}</div>`);
  const stage = document.getElementById("stage");
  // 故意反序
  inlineWechatStyles(stage, rules);
  highlightCodeBlocks(stage);
  const html = stage.innerHTML;
  const spans = [...stage.querySelectorAll("pre span")];
  ok("反序时确实产出了 span", spans.length > 0, spans.length);
  const colored = spans.filter((s) => (s.getAttribute("style") ?? "").includes("color:"));
  // 这是反序的后果：span 在，颜色没有。断言它确实坏掉，以此证明顺序是有意义的
  eq("反序则 span 全无颜色（证明顺序要紧）", colored.length, 0);
  ok("反序产物里没有 color 的 span", !/<span style="[^"]*color:/.test(html), html.slice(0, 300));
}

// ---------- 缩进在 white-space 被剥掉之后仍然存在 ----------
//
// 实测微信剥掉了 white-space，缩进全丢（高亮还在）。所以缩进必须靠结构维持：
// NBSP + <br>。这一组在「声明已被剥掉」的条件下断言，那才是真实条件。
//
// 每套主题都要过：主题只影响颜色和底色，但漏测的话某套主题万一改了 pre 规则
// 就会静默失效。
for (const theme of WECHAT_THEMES) {
  const rules = theme.rules;
  const { stage } = exportPipeline(
    `<pre><code class="language-python">${escapeHTML(
      'def f(x):\n    if x:\n        return "y"',
    )}</code></pre>`,
    rules,
  );
  const lines = renderWithWhitespaceStripped(stage.querySelector("pre > code"));
  eq(`${theme.id}: 折叠后仍是 3 行`, lines.length, 3);
  eq(
    `${theme.id}: 第 2 行缩进 4`,
    (lines[1].match(new RegExp(`^${NBSP}*`)) ?? [""])[0].length,
    4,
  );
  eq(
    `${theme.id}: 第 3 行缩进 8`,
    (lines[2].match(new RegExp(`^${NBSP}*`)) ?? [""])[0].length,
    8,
  );
}

// 缩进与高亮必须同时成立 —— 这次修复不能把上次修好的高亮弄坏
{
  const rules = WECHAT_THEMES[0].rules;
  const { stage, html } = exportPipeline(
    `<pre><code class="language-python">${escapeHTML(
      'def f():\n    # 注释\n    return "s"',
    )}</code></pre>`,
    rules,
  );
  const lines = renderWithWhitespaceStripped(stage.querySelector("pre > code"));
  ok("缩进还在", lines[1].startsWith(NBSP.repeat(4)), lines);
  ok("颜色还在", /<span style="[^"]*color:#/.test(html), html.slice(0, 400));
  ok("产出了 br", stage.querySelectorAll("pre br").length > 0);
}

// ---------- 最外层 section 的 style 不能被字体栈截断 ----------
//
// 这是查高亮时撞见的另一个 bug：主题的 body 规则里字体栈全是 "PingFang SC"
// 这种带双引号的族名，未转义地插进 style="..." 会在第一个双引号处提前收尾 ——
// font-size / line-height / color 全丢，剩下的片段还会变成一堆垃圾属性。
// 30 个主题变体无一例外，表现是整篇正文的字号行距都不对。
for (const theme of WECHAT_THEMES) {
  for (const variant of ["light", "dark"]) {
    const rules = variant === "dark" ? resolveThemeRules(theme, true) : theme.rules;
    const html = wrapWechatBody("<p>正文</p>", rules.body);
    const { document } = parseHTML(`<div id="c">${html}</div>`);
    const section = document.querySelector("section");

    // 重新解析后 style 必须与输入完全一致
    eq(`${theme.id}/${variant}: section style 完整往返`, section.getAttribute("style"), rules.body);
    // 只能有 style 一个属性 —— 多出来的都是被截断后误解析的碎片
    eq(`${theme.id}/${variant}: section 只有 style 属性`, section.getAttributeNames().length, 1);
    // 字号与行高必须真的在里面：它们排在字体栈之后，是最容易被截掉的
    for (const decl of ["font-size", "line-height"]) {
      const expected = rules.body.includes(decl);
      eq(
        `${theme.id}/${variant}: ${decl} 存活`,
        (section.getAttribute("style") ?? "").includes(decl),
        expected,
      );
    }
  }
}

// ---------- 无代码块的文档不受影响 ----------
{
  const rules = WECHAT_THEMES[0].rules;
  const { stats, highlighted, html } = exportPipeline(
    "<h1>标题</h1><p>正文段落</p><ul><li>要点</li></ul>",
    rules,
  );
  eq("没有代码块时补 0 个", highlighted, 0);
  eq("没有代码块时内联 0 个高亮", stats.highlighted, 0);
  ok("正文仍被内联样式", stats.styled > 0, stats);
  ok("标题有样式", /<h1 style="/.test(html), html.slice(0, 200));
}

// ---------- 多代码块、混排 ----------
{
  const rules = WECHAT_THEMES[0].rules;
  const { html, highlighted } = exportPipeline(
    PY_BLOCK +
      "<p>中间说明</p>" +
      `<pre><code class="language-javascript">${escapeHTML("const a = 1;")}</code></pre>` +
      "<p>用 <code>inline</code> 表示行内</p>",
    rules,
  );
  eq("两个代码块都补了", highlighted, 2);
  const { document } = parseHTML(`<div id="c">${html}</div>`);
  eq("产物里有两个 pre", document.querySelectorAll("pre").length, 2);
  for (const pre of document.querySelectorAll("pre")) {
    ok("每个 pre 内都有带色 span", /color:/.test(pre.innerHTML), pre.innerHTML.slice(0, 200));
  }
}

console.log(`\nwechat export e2e: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
