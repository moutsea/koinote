// 微信导出里代码块的两处修复：高亮内联、代码块补充声明。
//
// 这两件事失败的表现区别很大：
//   - 高亮没内联 → 整段代码一个颜色。难看，但还能读。
//   - white-space 没补上 → 多行代码塌成一行、缩进全丢。Python 直接变废码。
// 后者严重得多，所以它的断言写得更死。
import {
  CODE_BLOCK_EXTRAS,
  highlightStyleFor,
  lineHeightFrom,
} from "./_wechat_inline_bundle.mjs";
import { HLJS_DARK, HLJS_LIGHT } from "./_wechat_hljs_bundle.mjs";

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

// ---------- CODE_BLOCK_EXTRAS ----------
//
// 这三条是这次修复的核心。缺任何一条都有具体后果，逐条钉住。

// 最关键：微信不保证 pre 的默认 white-space 存活。塌掉的话多行代码被压成一行、
// 缩进全丢 —— 缩进丢了 Python 就是废码，而颜色丢了还能读
ok(
  "补了 white-space:pre-wrap",
  CODE_BLOCK_EXTRAS.includes("white-space:pre-wrap"),
  CODE_BLOCK_EXTRAS,
);
// 不能是 nowrap 或 normal：那俩都会让换行塌掉
ok("不是 white-space:nowrap", !CODE_BLOCK_EXTRAS.includes("nowrap"), CODE_BLOCK_EXTRAS);
ok("不是 white-space:normal", !/white-space:\s*normal/.test(CODE_BLOCK_EXTRAS), CODE_BLOCK_EXTRAS);

// 兜住没有空格可断的超长 token（长 URL、base64、压缩过的一行 JS）——
// 只有 pre-wrap 的话它们仍会撑破容器
ok(
  "补了 overflow-wrap:break-word",
  CODE_BLOCK_EXTRAS.includes("overflow-wrap:break-word"),
  CODE_BLOCK_EXTRAS,
);
ok(
  "补了 word-break",
  CODE_BLOCK_EXTRAS.includes("word-break"),
  CODE_BLOCK_EXTRAS,
);

// 形状：必须是可拼接的声明串（每条以分号结尾），因为它会被直接接在主题规则后面
ok("以分号结尾", CODE_BLOCK_EXTRAS.trimEnd().endsWith(";"), CODE_BLOCK_EXTRAS);
ok("不含换行", !/[\n\r]/.test(CODE_BLOCK_EXTRAS), CODE_BLOCK_EXTRAS);
ok("不以分号开头（否则拼出空声明）", !CODE_BLOCK_EXTRAS.startsWith(";"), CODE_BLOCK_EXTRAS);

// ---------- lineHeightFrom ----------
eq("取 line-height", lineHeightFrom("line-height:1.6;"), "1.6");
eq("在中间", lineHeightFrom("padding:4px;line-height:26px;color:red;"), "26px");
eq("带空格", lineHeightFrom("line-height :  1.82 ;"), "1.82");
eq("大写", lineHeightFrom("LINE-HEIGHT:2;"), "2");
eq("没有则 null", lineHeightFrom("color:#fff;"), null);
eq("空串则 null", lineHeightFrom(""), null);
// 不能把 max-line-height 之类的假属性匹配上
eq("不匹配后缀相同的假属性", lineHeightFrom("xline-height:9;"), null);
// 真实的主题 pre 规则
eq(
  "从真实 pre 规则里取",
  lineHeightFrom("background:#f2f2f2;color:#111;padding:14px 16px;overflow:auto;font-size:14px;line-height:1.6;"),
  "1.6",
);

// ---------- highlightStyleFor ----------
const LH = "1.6";

// 没有 hljs class 的元素一律不碰 —— 否则正文里的 span、strong 都会被塞行高
eq("非代码元素返回空串", highlightStyleFor("", HLJS_DARK, LH), "");
eq("普通 class 返回空串", highlightStyleFor("foo bar", HLJS_DARK, LH), "");
// 裸 hljs（代码块容器自己的 class）不算 token，但它含 "hljs-"？不含，所以不该匹配
eq("裸 hljs 返回空串", highlightStyleFor("hljs", HLJS_DARK, LH), "");

// 有颜色的 token：颜色 + 行高
eq(
  "keyword 出颜色和行高",
  highlightStyleFor("hljs-keyword", HLJS_DARK, LH),
  `color:${HLJS_DARK.keyword};line-height:${LH};`,
);
eq(
  "string 出颜色和行高",
  highlightStyleFor("hljs-string", HLJS_DARK, LH),
  `color:${HLJS_DARK.string};line-height:${LH};`,
);

// 两套配色给出不同颜色 —— 否则说明挑配色那步没起作用
ok(
  "浅底配色下颜色不同",
  highlightStyleFor("hljs-keyword", HLJS_LIGHT, LH) !==
    highlightStyleFor("hljs-keyword", HLJS_DARK, LH),
);

// 查不到颜色的 token 仍要有行高：否则那几个 span 的行距和邻居不一样，
// 表现是代码行看着参差不齐
eq(
  "查不到颜色也有行高",
  highlightStyleFor("hljs-punctuation", HLJS_DARK, LH),
  `line-height:${LH};`,
);
ok(
  "查不到颜色时不写 color",
  !highlightStyleFor("hljs-punctuation", HLJS_DARK, LH).includes("color:"),
);

// 组合类名：lowlight 会生成 "hljs-title function_"
eq(
  "组合类名取能查到的那个",
  highlightStyleFor("hljs-title function_", HLJS_DARK, LH),
  `color:${HLJS_DARK.title};line-height:${LH};`,
);

// 字形类：emphasis / strong 与颜色可以并存
eq(
  "emphasis 出斜体和行高",
  highlightStyleFor("hljs-emphasis", HLJS_DARK, LH),
  `font-style:italic;line-height:${LH};`,
);
eq(
  "strong 出粗体和行高",
  highlightStyleFor("hljs-strong", HLJS_DARK, LH),
  `font-weight:700;line-height:${LH};`,
);
eq(
  "颜色与字形并存",
  highlightStyleFor("hljs-keyword hljs-strong", HLJS_DARK, LH),
  `color:${HLJS_DARK.keyword};font-weight:700;line-height:${LH};`,
);

// 行高透传：主题定的值要原样出现，不能被写死成某个常量
for (const lh of ["1.6", "26px", "1.82", "2"]) {
  ok(
    `行高 ${lh} 透传`,
    highlightStyleFor("hljs-keyword", HLJS_DARK, lh).includes(`line-height:${lh};`),
    highlightStyleFor("hljs-keyword", HLJS_DARK, lh),
  );
}

// 每个输出都是可拼接的声明串
for (const cls of [
  "hljs-keyword",
  "hljs-string",
  "hljs-comment",
  "hljs-punctuation",
  "hljs-emphasis",
  "hljs-keyword hljs-strong",
]) {
  const out = highlightStyleFor(cls, HLJS_DARK, LH);
  ok(`"${cls}" 的输出以分号结尾`, out.endsWith(";"), out);
  ok(`"${cls}" 的输出不含换行`, !/[\n\r]/.test(out), out);
  ok(`"${cls}" 的输出不以分号开头`, !out.startsWith(";"), out);
}

console.log(`\nwechat inline: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
