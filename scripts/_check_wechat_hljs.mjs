// 微信导出的代码高亮配色。
//
// 两套配色都是手写的，没有哪个设计系统替我保证「#0a3069 压在 #f6f8fa 上读得清」。
// 而且这里错了的表现很隐蔽：导出的 HTML 在浏览器里打开可能还行，粘到微信里才发现
// 某种 token 和底色几乎同色 —— 那时已经发出去了。
import {
  HLJS_DARK,
  HLJS_LIGHT,
  backgroundFrom,
  emphasisStyleFor,
  hljsColorFor,
  isDarkColor,
  pickHljsPalette,
} from "./_wechat_hljs_bundle.mjs";

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
    console.error(`FAIL  ${label}${detail === undefined ? "" : ` —— ${JSON.stringify(detail)}`}`);
  }
}

// ---------- 对比度 ----------

function channel(v) {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance(hex) {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2] : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// 主题里真实用到的代码块底色，从 wechatThemes.ts 扫出来的。
// 深浅各取最极端和最接近中点的那几个 —— 边界附近才是配色可能翻车的地方。
const DARK_BACKGROUNDS = ["#000", "#111", "#161b22", "#1c1c1e", "#252525", "#242432"];
const LIGHT_BACKGROUNDS = ["#f2f2f2", "#f6f8fa", "#eef2ff", "#f5dec4", "#eeeeee", "#f5f5f7"];

// 代码高亮是「非正文」的小字号文本，但它承载信息，不能按装饰算。
// 用 4.5:1 会让配色几乎没有可选空间（同一底色上要放七八种能互相区分的颜色），
// 所以取 3:1 —— 与 WCAG 对大字号/非文字元素的要求一致，且这是行业里代码主题的通行做法。
const MIN_RATIO = 3;

for (const [name, palette, backgrounds] of [
  ["深底", HLJS_DARK, DARK_BACKGROUNDS],
  ["浅底", HLJS_LIGHT, LIGHT_BACKGROUNDS],
]) {
  for (const [token, color] of Object.entries(palette)) {
    for (const bg of backgrounds) {
      const ratio = contrast(color, bg);
      ok(
        `${name}: ${token} (${color}) on ${bg} >= ${MIN_RATIO}:1`,
        ratio >= MIN_RATIO,
        `${ratio.toFixed(2)}:1`,
      );
    }
  }
}

// 反向：深色配色压在浅底上确实不可读。
// 这条钉住"两套配色不是可以互换的"—— 如果哪天有人为了省事删掉一套，这里会失败
{
  const ratio = contrast(HLJS_DARK.string, "#f6f8fa");
  ok(
    "深色的 string 压在浅底上读不清（所以必须有两套）",
    ratio < MIN_RATIO,
    `${ratio.toFixed(2)}:1`,
  );
}

// ---------- 两套配色的键必须一致 ----------
//
// 少一个键的表现是：那种 token 在其中一套底色下没有颜色，继承 pre 的默认色，
// 于是看起来"少了一种高亮"—— 很难注意到
{
  const darkKeys = Object.keys(HLJS_DARK).sort();
  const lightKeys = Object.keys(HLJS_LIGHT).sort();
  eq("两套配色的键完全一致", darkKeys, lightKeys);
  ok("配色表非空", darkKeys.length > 0, darkKeys.length);
}

// globals.css 里出现的语义类名都要被覆盖。
// 漏掉的表现是编辑器里有颜色、导出后没有 —— 用户会以为导出坏了
{
  // 与 globals.css 的 .hljs-* 规则对齐（emphasis/strong 不是颜色，单独处理）
  const FROM_CSS = [
    "comment", "quote", "keyword", "selector-tag", "literal", "type",
    "string", "attr", "template-tag", "number", "symbol",
    "title", "section", "variable", "name", "attribute",
    "built_in", "builtin-name", "meta",
  ];
  for (const token of FROM_CSS) {
    ok(`深底覆盖 ${token}`, token in HLJS_DARK, Object.keys(HLJS_DARK));
    ok(`浅底覆盖 ${token}`, token in HLJS_LIGHT, Object.keys(HLJS_LIGHT));
  }
}

// ---------- backgroundFrom ----------
eq("取 background", backgroundFrom("background:#111;color:#fff;"), "#111");
eq("取 background-color", backgroundFrom("background-color:#eee;"), "#eee");
eq("在中间也能取到", backgroundFrom("padding:4px;background:#abc;color:red;"), "#abc");
eq("带空格", backgroundFrom("background :  #123456 ;"), "#123456");
eq("大写属性名", backgroundFrom("BACKGROUND:#fff;"), "#fff");
eq("没有 background 返回 null", backgroundFrom("color:#fff;padding:4px;"), null);
eq("空串返回 null", backgroundFrom(""), null);
// 不能把 background-image 之类误当成颜色的边界：这里只要求不崩、能返回原值
eq("var() 原样返回", backgroundFrom("background:var(--background);"), "var(--background)");
// 关键：不能把 "font-background" 这种假属性名匹配上
eq("不匹配后缀相同的假属性", backgroundFrom("xbackground:#fff;"), null);

// 有多个 background 时必须取最后一个 —— CSS 里生效的是后者。
//
// 这不是假想的输入：深色变体就是「浅色声明 + 深色声明」拼出来的
// （resolveThemeRules），pre 的声明串里必然有两个 background。取第一个会把
// 所有主题的深色变体全判成浅底 —— 高亮配色整套错，Mac 窗口标题栏也用错底色。
eq(
  "多个 background 取最后一个",
  backgroundFrom("background:#f2f2f2;color:#111;background:#17171b;"),
  "#17171b",
);
eq(
  "background-color 与 background 混用也取最后",
  backgroundFrom("background-color:#eee;padding:2px;background:#000;"),
  "#000",
);
// 真实的深色 pre 声明串
eq(
  "真实深色变体的 pre",
  backgroundFrom(
    "background:#f2f2f2;color:#111;padding:14px 16px;font-size:14px;background:#17171b;color:#d4d4d8;",
  ),
  "#17171b",
);
// 取最后一个之后，深浅判定必须跟着对
ok(
  "深色变体被判成深底",
  isDarkColor(
    backgroundFrom("background:#f2f2f2;background:#17171b;") ?? "",
  ) === true,
);

// ---------- isDarkColor ----------
eq("纯黑是深色", isDarkColor("#000000"), true);
eq("纯白不是深色", isDarkColor("#ffffff"), false);
eq("三位缩写：黑", isDarkColor("#000"), true);
eq("三位缩写：白", isDarkColor("#fff"), false);
eq("#111 是深色", isDarkColor("#111"), true);
eq("#f6f8fa 不是深色", isDarkColor("#f6f8fa"), false);
eq("#161b22 是深色", isDarkColor("#161b22"), true);
eq("带空格也能判", isDarkColor("  #000  "), true);
eq("大写十六进制", isDarkColor("#ABCDEF"), false);

// 判断不了的一律 null，而不是猜
eq("var() 判断不了", isDarkColor("var(--background)"), null);
eq("rgb() 判断不了", isDarkColor("rgb(0,0,0)"), null);
eq("颜色名判断不了", isDarkColor("black"), null);
eq("空串判断不了", isDarkColor(""), null);
eq("八位带透明度判断不了", isDarkColor("#11223344"), null);

// 感知亮度而非平均值：纯蓝的平均是 85（会被判成深），但它确实看着深，
// 所以这条两种算法结论相同。真正能区分的是纯绿：平均 85 → 深，
// 感知亮度 150 → 浅。绿底配深色字才是对的
eq("纯绿按感知亮度算是浅色", isDarkColor("#00ff00"), false);
eq("纯蓝是深色", isDarkColor("#0000ff"), true);

// ---------- pickHljsPalette ----------
{
  const darkPre = "background:#111;color:#eee;padding:14px;";
  const lightPre = "background:#f2f2f2;color:#111;padding:14px;";
  ok("深底挑深色配色", pickHljsPalette(darkPre) === HLJS_DARK);
  ok("浅底挑浅色配色", pickHljsPalette(lightPre) === HLJS_LIGHT);

  // 回落方向：判断不了时用浅底那套。微信文章绝大多数白底，
  // 而深色配色压在白底上几乎不可读 —— 回落要选后果轻的一边
  ok("var() 底色回落到浅色", pickHljsPalette("background:var(--background);") === HLJS_LIGHT);
  ok("没写 background 回落到浅色", pickHljsPalette("color:#111;") === HLJS_LIGHT);
  ok("空规则回落到浅色", pickHljsPalette("") === HLJS_LIGHT);
}

// ---------- hljsColorFor ----------
eq("单个类名", hljsColorFor("hljs-keyword", HLJS_DARK), HLJS_DARK.keyword);
// lowlight 会生成 "hljs-title function_" 这种组合，只有 hljs-title 在表里
eq("组合类名取能查到的那个", hljsColorFor("hljs-title function_", HLJS_DARK), HLJS_DARK.title);
eq("前面有非 hljs 类名", hljsColorFor("foo hljs-string", HLJS_DARK), HLJS_DARK.string);
eq("带下划线的键", hljsColorFor("hljs-built_in", HLJS_DARK), HLJS_DARK.built_in);
eq("带连字符的键", hljsColorFor("hljs-selector-tag", HLJS_DARK), HLJS_DARK["selector-tag"]);
eq("不认识的 hljs 类名返回 null", hljsColorFor("hljs-nonexistent", HLJS_DARK), null);
eq("没有 hljs 类名返回 null", hljsColorFor("foo bar", HLJS_DARK), null);
eq("空串返回 null", hljsColorFor("", HLJS_DARK), null);
// 不能把 "hljs" 本身（容器 class）当成 token
eq("裸 hljs 不算 token", hljsColorFor("hljs", HLJS_DARK), null);
// 两套配色查同一个键得到不同颜色 —— 否则说明有一套没起作用
ok(
  "同一 token 在两套配色下颜色不同",
  hljsColorFor("hljs-keyword", HLJS_DARK) !== hljsColorFor("hljs-keyword", HLJS_LIGHT),
);

// ---------- emphasisStyleFor ----------
eq("emphasis 出斜体", emphasisStyleFor("hljs-emphasis"), "font-style:italic;");
eq("strong 出粗体", emphasisStyleFor("hljs-strong"), "font-weight:700;");
eq("两者都有", emphasisStyleFor("hljs-emphasis hljs-strong"), "font-style:italic;font-weight:700;");
eq("都没有返回空串", emphasisStyleFor("hljs-keyword"), "");
eq("空串返回空串", emphasisStyleFor(""), "");
// 这两个不该出现在颜色表里 —— 它们表达字形不是颜色
ok("emphasis 不在配色表里", !("emphasis" in HLJS_DARK));
ok("strong 不在配色表里", !("strong" in HLJS_DARK));

console.log(`\nwechat hljs: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
