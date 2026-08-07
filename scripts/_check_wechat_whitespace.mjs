// 代码块缩进在微信里的存活。
//
// 实测结果：微信剥掉了 white-space 声明，缩进全部消失（高亮还在）。
// 所以缩进不能靠 CSS，必须靠结构 —— 空格换成 U+00A0、换行换成 <br>，
// 两者都不受 white-space 影响。
//
// 这个套件的核心判据不是「HTML 里有没有 NBSP」，而是
// **把 white-space 声明整个删掉之后，缩进还在不在** —— 那才是微信里的真实条件。
import { parseHTML } from "linkedom";
import {
  TAB_WIDTH,
  expandTabs,
  spacesToNbsp,
  structuralizeCodeWhitespace,
  structuralizeWhitespace,
} from "./_wechat_whitespace_bundle.mjs";
import { highlightCodeBlocks } from "./_highlight_code_bundle.mjs";

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

const NBSP = "\u00a0";

function escapeHTML(v) {
  return v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 关键的模拟：把渲染结果里的空白折叠掉，就像微信剥掉 white-space 之后那样。
 *
 * HTML 的默认空白处理规则：连续的空格/制表/换行折叠成一个空格。
 * U+00A0 不参与折叠，<br> 是元素 —— 这正是我们依赖的两点。
 *
 * 返回「读者实际看到的行」。
 */
function renderWithWhitespaceStripped(element) {
  const lines = [];
  let current = "";
  const walk = (node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        // 折叠普通空白（NBSP 不在 \s 里？在。所以要显式排除）
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

/** 跑完整链路：补高亮 → 结构化空白 */
function pipeline(code, language = "python") {
  const { document } = parseHTML(
    `<div id="s"><pre><code class="language-${language}">${escapeHTML(code)}</code></pre></div>`,
  );
  const root = document.getElementById("s");
  highlightCodeBlocks(root);
  const count = structuralizeCodeWhitespace(root);
  return { root, count, code: root.querySelector("code") };
}

// ---------- 纯函数 ----------
eq("单空格换成 NBSP", spacesToNbsp(" "), NBSP);
eq("多空格全换", spacesToNbsp("    x"), NBSP.repeat(4) + "x");
eq("行中的空格也换", spacesToNbsp("a b c"), `a${NBSP}b${NBSP}c`);
eq("没有空格时原样", spacesToNbsp("abc"), "abc");
eq("空串", spacesToNbsp(""), "");
// 不能碰换行 —— 换行由 <br> 处理，在这里被换掉就拆不出行了
eq("不碰换行", spacesToNbsp("a\nb"), "a\nb");

eq("tab 展开成 4 空格", expandTabs("\tx"), "    x");
eq("两个 tab", expandTabs("\t\tx"), "        x");
eq("TAB_WIDTH 是 4", TAB_WIDTH, 4);
eq("没有 tab 时原样", expandTabs("  x"), "  x");

// ---------- 核心：white-space 被剥掉之后缩进还在 ----------
//
// 这一组是整个修复的验收条件。每个用例都在「微信剥掉 white-space」的条件下
// 检查读者看到的行首缩进。

const INDENT_CASES = [
  {
    label: "Python 两级缩进",
    code: 'def f(x):\n    if x > 0:\n        return "yes"\n    return "no"',
    // 每行的行首空白宽度
    indents: [0, 4, 8, 4],
  },
  {
    label: "Python 制表符缩进",
    code: "def f():\n\tif a:\n\t\treturn 1",
    indents: [0, 4, 8],
  },
  {
    label: "深缩进",
    code: "a\n  b\n    c\n      d\n        e",
    indents: [0, 2, 4, 6, 8],
  },
  {
    label: "YAML 嵌套",
    code: "root:\n  child:\n    key: value",
    indents: [0, 2, 4],
    language: "yaml",
  },
  {
    label: "带空行",
    code: "def a():\n    pass\n\ndef b():\n    pass",
    indents: [0, 4, 0, 0, 4],
  },
];

for (const { label, code, indents, language } of INDENT_CASES) {
  const { code: codeEl } = pipeline(code, language ?? "python");
  const lines = renderWithWhitespaceStripped(codeEl);

  eq(`${label}: 行数正确`, lines.length, indents.length);
  indents.forEach((want, i) => {
    const line = lines[i] ?? "";
    // 行首的 NBSP 数就是读者看到的缩进
    const got = (line.match(new RegExp(`^${NBSP}*`)) ?? [""])[0].length;
    eq(`${label}: 第 ${i + 1} 行缩进`, got, want);
  });
  // 折叠之后仍能还原出原文（tab 已展开成空格）
  const restored = lines.map((l) => l.replaceAll(NBSP, " ")).join("\n");
  eq(`${label}: 折叠后原文可还原`, restored, expandTabs(code));
}

// 反证：不做结构化时，同样的条件下缩进确实会没 —— 证明上面那组断言不是空的
{
  const code = "def f():\n    return 1";
  const { document } = parseHTML(
    `<div id="s"><pre><code>${escapeHTML(code)}</code></pre></div>`,
  );
  const root = document.getElementById("s");
  highlightCodeBlocks(root);
  // 故意不调用 structuralizeCodeWhitespace
  const lines = renderWithWhitespaceStripped(root.querySelector("code"));
  eq("反证：不处理时折叠成一行", lines.length, 1);
  ok("反证：缩进确实消失", !lines[0].includes(NBSP), lines);
}

// ---------- 高亮必须完好 ----------
//
// 这次修复不能把上一次修好的高亮弄坏。
{
  const { code: codeEl, root } = pipeline(
    'def greet(name):\n    # 打招呼\n    return f"hi {name}"',
  );
  const spans = [...codeEl.querySelectorAll("span")];
  ok("高亮 span 还在", spans.length > 0, spans.length);
  ok(
    "keyword 还在",
    root.innerHTML.includes("hljs-keyword"),
    root.innerHTML.slice(0, 200),
  );
  // span 内部的空白也要处理到 —— 缩进常常落在 span 里（比如注释前的空格）
  ok("产出了 br", codeEl.querySelectorAll("br").length > 0);
}

// span 内部的缩进（注释、字符串跨行）同样要保住
{
  const { code: codeEl } = pipeline('s = """\n    缩进在字符串里\n"""');
  const lines = renderWithWhitespaceStripped(codeEl);
  const indented = lines.find((l) => l.includes("缩进在字符串里"));
  ok("字符串内的缩进保住", indented?.startsWith(NBSP.repeat(4)), lines);
}

// ---------- 不该碰的地方 ----------

// 行内 code 不处理：它是单行，换成 NBSP 只会让正文断行变差
{
  const { document } = parseHTML(
    '<div id="s"><p>用 <code>a b c</code> 表示</p></div>',
  );
  const root = document.getElementById("s");
  const count = structuralizeCodeWhitespace(root);
  eq("行内 code 不算在内", count, 0);
  eq("行内 code 空格未变", root.querySelector("code").textContent, "a b c");
  ok("行内 code 无 NBSP", !root.innerHTML.includes("&#160;"), root.innerHTML);
}

// 正文段落不受影响
{
  const { document } = parseHTML(
    '<div id="s"><p>这是  正文</p><pre><code>a  b</code></pre></div>',
  );
  const root = document.getElementById("s");
  structuralizeCodeWhitespace(root);
  eq("段落空格未变", root.querySelector("p").textContent, "这是  正文");
  eq("代码块空格已换", root.querySelector("code").textContent, `a${NBSP}${NBSP}b`);
}

// style 属性里的空格不能被换 —— 那会破坏样式
{
  const { document } = parseHTML(
    '<div id="s"><pre><code><span style="color:#fff;line-height:1.6;">a b</span>\n  c</code></pre></div>',
  );
  const root = document.getElementById("s");
  structuralizeCodeWhitespace(root);
  const span = root.querySelector("span");
  eq("style 属性完好", span.getAttribute("style"), "color:#fff;line-height:1.6;");
  eq("span 内文本已换", span.textContent, `a${NBSP}b`);
}
// 属性里带空格的情况（font-family 那种）
{
  const { document } = parseHTML(
    '<div id="s"><pre><code><span style="font-family: Menlo, monospace;">x  y</span></code></pre></div>',
  );
  const root = document.getElementById("s");
  structuralizeCodeWhitespace(root);
  eq(
    "带空格的 style 值完好",
    root.querySelector("span").getAttribute("style"),
    "font-family: Menlo, monospace;",
  );
}

// ---------- 边界 ----------
{
  const { count } = pipeline("");
  ok("空代码块不抛", count >= 0);
}
{
  const { document } = parseHTML('<div id="s"><p>无代码块</p></div>');
  eq("无代码块返回 0", structuralizeCodeWhitespace(document.getElementById("s")), 0);
}
{
  const { count } = pipeline("单行无缩进");
  eq("单行也算处理过", count, 1);
}
// 多个代码块
{
  const { document } = parseHTML(
    '<div id="s"><pre><code>a\n  b</code></pre><pre><code>c\n    d</code></pre></div>',
  );
  const root = document.getElementById("s");
  eq("两个代码块都处理", structuralizeCodeWhitespace(root), 2);
  for (const el of root.querySelectorAll("pre > code")) {
    ok("每个都有 br", el.querySelectorAll("br").length > 0, el.innerHTML);
  }
}
// 直接调用单块版本
{
  const { document } = parseHTML('<div id="s"><code>a\n  b</code></div>');
  const el = document.querySelector("code");
  structuralizeWhitespace(el);
  eq("单块版本产出 br", el.querySelectorAll("br").length, 1);
  eq("单块版本换了空格", el.textContent, `a${NBSP}${NBSP}b`);
}

// 行尾换行不该产出多余的空行
{
  const { code: codeEl } = pipeline("a\nb\n");
  const lines = renderWithWhitespaceStripped(codeEl);
  // "a\nb\n" 是 3 行（最后一行空），这是 split 的正确语义
  eq("尾随换行的行数", lines.length, 3);
  eq("最后一行为空", lines[2], "");
}

// 幂等性：跑两遍不该翻倍 br 或改坏内容
{
  const { document } = parseHTML(
    `<div id="s"><pre><code>${escapeHTML("def f():\n    return 1")}</code></pre></div>`,
  );
  const root = document.getElementById("s");
  structuralizeCodeWhitespace(root);
  const first = root.innerHTML;
  structuralizeCodeWhitespace(root);
  eq("第二遍不改变 HTML", root.innerHTML, first);
}

console.log(`\nwechat whitespace: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
