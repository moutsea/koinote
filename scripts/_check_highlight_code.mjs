// 导出物的代码高亮。
//
// 这个套件存在的原因是一个真实的线上 bug：微信导出的代码块完全没有高亮。
// 根因不在配色也不在内联，而是 getHTML() 的产物里从来就没有 hljs span ——
// CodeBlockLowlight 的高亮是 ProseMirror 装饰，只存在于编辑器视图，不进文档。
// 下游所有处理 hljs class 的代码都在空转。
//
// 之前那轮修复没抓到这一点，正是因为没有 DOM 环境、只测了纯函数。所以这里
// 用 linkedom 跑真实 DOM 路径 —— 断言的是「HTML 进、带 span 的 HTML 出」。
import { parseHTML } from "linkedom";
import { highlightCodeBlocks, languageFrom } from "./_highlight_code_bundle.mjs";

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

/** 把一段 body HTML 塞进容器，跑高亮，返回容器与处理数 */
function run(bodyHTML) {
  const { document } = parseHTML(`<div id="root">${bodyHTML}</div>`);
  const root = document.getElementById("root");
  const count = highlightCodeBlocks(root);
  return { root, count, html: root.innerHTML };
}

/**
 * 这是 editor.getHTML() 对代码块的真实产物形状 —— 一个 span 都没有。
 *
 * code 要转义后再拼进 HTML：不转义的话「代码里含 <script>」这类用例在解析阶段
 * 就变成了真的元素，测的就不是 highlightCodeBlocks 了。getHTML() 本身也是转义的。
 */
function codeBlock(language, code) {
  const cls = language ? ` class="language-${language}"` : "";
  return `<pre><code${cls}>${escapeHTML(code)}</code></pre>`;
}

function escapeHTML(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ---------- languageFrom ----------
eq("取语言名", languageFrom("language-python"), "python");
eq("多个 class", languageFrom("foo language-js bar"), "js");
eq("没有语言 class", languageFrom("hljs"), null);
eq("空 class", languageFrom(""), null);
// TipTap 在没有语言时不写这个 class，但空值要挡住，否则会拿 "" 去查注册表
eq("空语言名", languageFrom("language-"), null);
eq("带连字符的语言名", languageFrom("language-objective-c"), "objective-c");

// ---------- 核心：真的产出了 span ----------
//
// 这一组是整个套件的重点。它直接对应用户看到的现象：
// 「就一个灰色的代码框，代码都是文本形式」

{
  const { root, count, html } = run(
    codeBlock("python", "def f(x):\n    return x + 1"),
  );
  eq("处理了 1 个代码块", count, 1);
  ok("产出了 hljs span", root.querySelectorAll("[class*='hljs-']").length > 0, html);
  // 关键字必须被认出来 —— 这是「有没有高亮」最直接的判据
  ok("def 被标为 keyword", /class="hljs-keyword">def</.test(html), html);
  ok("return 被标为 keyword", /hljs-keyword">return</.test(html), html);
}

// 每种主流语言都要真的出 span。少一个就是那门语言的用户看到单色代码。
const LANGUAGE_CASES = [
  ["python", "def f(x):\n    return x", "keyword"],
  ["javascript", "const a = 1;\nfunction f() {}", "keyword"],
  ["typescript", "interface A { b: string }", "keyword"],
  ["go", 'package main\nfunc main() {}', "keyword"],
  ["rust", "fn main() { let x = 1; }", "keyword"],
  ["bash", 'echo "hi"', "built_in"],
  ["json", '{"a": 1}', "attr"],
  ["java", "class A { void b() {} }", "keyword"],
  ["css", "a { color: red; }", "selector-tag"],
  ["sql", "SELECT * FROM t", "keyword"],
  ["xml", '<a href="x">y</a>', "name"],
  ["yaml", "a: 1\nb: two", "attr"],
];

for (const [language, code, expectedToken] of LANGUAGE_CASES) {
  const { root, count, html } = run(codeBlock(language, code));
  eq(`${language}: 处理了 1 块`, count, 1);
  ok(
    `${language}: 产出 span`,
    root.querySelectorAll("[class*='hljs-']").length > 0,
    html,
  );
  ok(
    `${language}: 出现 hljs-${expectedToken}`,
    html.includes(`hljs-${expectedToken}`),
    html,
  );
}

// 语言别名也要走通：Markdown 里写 ```py 很常见。
// 每个别名配一段该语言下确实有 token 的代码 —— 用同一段 "a = 1" 试过，
// 在 sh 下它一个 token 都没有（那是合法的，赋值不是关键字），断言会假失败。
for (const [alias, code] of [
  ["py", "def f(): pass"],
  ["js", "const a = 1;"],
  ["ts", "let a: string;"],
  ["sh", 'echo "hi"'],
  ["yml", "a: 1"],
]) {
  const { count, html } = run(codeBlock(alias, code));
  ok(`别名 ${alias} 被识别`, count === 1, { count, html });
}

// ---------- 代码内容必须一字不差地保留 ----------
//
// 高亮是锦上添花，改动了代码就是数据损坏 —— 严重得多。

const PRESERVE_CASES = [
  ["缩进", "def f():\n    if x:\n        return 1"],
  ["制表符", "def f():\n\treturn 1"],
  ["尖括号", "if (a < b && c > d) {}"],
  ["和号", "a && b & c"],
  ["引号", `const s = "it's \\"quoted\\"";`],
  ["空行", "a = 1\n\nb = 2"],
  ["行尾空格", "a = 1   \nb = 2"],
  ["中文注释", "# 这是中文注释\nx = 1"],
  ["emoji", "s = '🎉'"],
  ["HTML 片段作为代码", "<script>alert(1)</script>"],
  ["长 URL", "u = 'https://example.com/a/b/c?d=e&f=g#h'"],
];

for (const [label, code] of PRESERVE_CASES) {
  const { root } = run(codeBlock("python", code));
  eq(`保留原文：${label}`, root.querySelector("code").textContent, code);
}

// 尖括号必须是转义后的实体，不能变成真的标签 —— 否则用户的代码会被
// 当成 HTML 结构塞进文档
{
  const { root, html } = run(codeBlock("javascript", "if (a < b) {}"));
  ok("尖括号被转义", !html.includes("<b)"), html);
  ok("没有多出元素", root.querySelectorAll("script,b,i").length === 0, html);
}
// 这条最要紧：代码里的 <script> 不能变成真的 script 元素
{
  const { root, html } = run(codeBlock("html", "<script>alert(1)</script>"));
  eq("代码里的 script 没变成元素", root.querySelectorAll("script").length, 0);
  ok("script 以文本形式保留", root.querySelector("code").textContent.includes("<script>"), html);
}

// ---------- 边界 ----------

// 没有语言时走 highlightAuto，仍该出 span —— Markdown 里 ``` 不带语言很常见
{
  const { count, html } = run(codeBlock(null, "def f(x):\n    return x + 1"));
  eq("无语言也处理了", count, 1);
  ok("无语言也出 span", html.includes("hljs-"), html);
}

// 没注册的语言不能抛，也不能丢内容
{
  const code = "x <- 1";
  const { root, count } = run(codeBlock("brainfuck-not-real", code));
  ok("未注册语言不抛异常", true);
  eq("未注册语言保留原文", root.querySelector("code").textContent, code);
  ok("未注册语言不算失败", count >= 0);
}

// 空代码块：不能抛，不能算处理过
{
  const { count } = run("<pre><code></code></pre>");
  eq("空代码块跳过", count, 0);
}
{
  const { count } = run('<pre><code class="language-python"></code></pre>');
  eq("空的带语言代码块跳过", count, 0);
}
// 只有空白的代码块
{
  const { count } = run('<pre><code class="language-python">   \n  </code></pre>');
  ok("纯空白代码块不抛", count === 0 || count === 1);
}

// 没有代码块的文档：一个都不该处理
{
  const { count } = run("<p>正文</p><h1>标题</h1><ul><li>项</li></ul>");
  eq("无代码块时返回 0", count, 0);
}

// 行内 code 不能被碰 —— 它不在 pre 里，给它上色会把正文里的 `foo` 染成代码色。
//
// 用例内容必须是「自动识别下确实会出 token」的代码，否则这组断言是空的：
// 一开始用的是 `npm run dev`，highlightAuto 对它一个 token 都不出，
// 把选择器从 "pre > code" 改成 "code" 也照样全绿 —— 变异测试暴露了这一点。
{
  const { root, count, html } = run(
    "<p>调用 <code>const x = function () {}</code> 即可</p>",
  );
  eq("行内 code 不处理", count, 0);
  eq(
    "行内 code 原文不变",
    root.querySelector("code").textContent,
    "const x = function () {}",
  );
  ok("行内 code 没有 span", !html.includes("hljs-"), html);
}
// 行内 code 与代码块并存时，只处理后者
{
  const { root, count, html } = run(
    "<p>用 <code>const a = 1</code> 声明</p>" + codeBlock("javascript", "const b = 2;"),
  );
  eq("只处理代码块那一个", count, 1);
  const inline = root.querySelector("p code");
  eq("行内 code 仍是纯文本", inline.textContent, "const a = 1");
  ok("行内 code 内没有 span", inline.querySelectorAll("*").length === 0, html);
}

// 多个代码块都要处理
{
  const { count } = run(
    codeBlock("python", "x = 1") +
      "<p>中间的段落</p>" +
      codeBlock("javascript", "const y = 2;") +
      codeBlock("go", "func f() {}"),
  );
  eq("三个代码块都处理", count, 3);
}

// 幂等：跑两遍不能把已高亮的内容再拆一遍
{
  const { document } = parseHTML(
    `<div id="root">${codeBlock("python", "def f():\n    return 1")}</div>`,
  );
  const root = document.getElementById("root");
  const first = highlightCodeBlocks(root);
  const afterFirst = root.innerHTML;
  const second = highlightCodeBlocks(root);
  eq("第一遍处理 1 块", first, 1);
  eq("第二遍处理 0 块", second, 0);
  eq("第二遍没有改动 HTML", root.innerHTML, afterFirst);
}

// 原文保真在幂等之后仍成立
{
  const code = "def f():\n    return 1";
  const { document } = parseHTML(
    `<div id="root">${codeBlock("python", code)}</div>`,
  );
  const root = document.getElementById("root");
  highlightCodeBlocks(root);
  highlightCodeBlocks(root);
  eq("两遍之后原文不变", root.querySelector("code").textContent, code);
}

// ---------- 与下游内联的衔接 ----------
//
// 产出的 class 名必须是 wechatHljs 表里的键能查到的形状，否则颜色仍然查不到 ——
// 高亮出来了但还是单色，是个很容易漏的断链。
{
  const { root } = run(
    codeBlock(
      "python",
      '# 注释\ndef f(x: int) -> str:\n    s = "文本"\n    return s + str(42)',
    ),
  );
  const classes = new Set();
  for (const el of root.querySelectorAll("[class]")) {
    for (const token of el.getAttribute("class").split(/\s+/)) {
      if (token.startsWith("hljs-")) classes.add(token.slice(5));
    }
  }
  ok("产出了多种 token 类型", classes.size >= 3, [...classes]);
  // 这几个是配色表里有的键，实际必须出现，否则等于没上色
  for (const key of ["keyword", "string", "comment"]) {
    ok(`产出 hljs-${key}`, classes.has(key), [...classes]);
  }
}

console.log(`\nhighlight code: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
