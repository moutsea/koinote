// 文档标题的自增高。
//
// 高度靠「CSS 网格 + ::after 镜像」得来：镜像里放同一份文本，用同一套排版量出
// 高度，textarea 被拉满。没有 JS 参与，所以换主题、改窗宽、系统缩放都自动跟上。
//
// 代价是它依赖几条不写在任何类型里的 CSS 约束，破掉任何一条的表现都很隐蔽：
//   · 两边排版不一致 → 镜像量出的行数不对 → 长标题被截掉半行
//   · 不在同一个网格单元 → 镜像把内容顶下去，标题下方多出一块空白
//   · 镜像可见 → 文字重影
//   · textarea 没去掉 resize/overflow → 出现一个拖了就被覆盖的坏手柄
//
// 这些都不是运行时错误，typecheck 也管不到 —— 只能读 CSS 断言。
import { readFileSync } from "node:fs";
import { shouldLeaveTitleOnEnter } from "./_doc_title_keyboard_bundle.mjs";

let pass = 0;
let fail = 0;

function ok(label, cond, detail) {
  if (cond) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL  ${label}${detail === undefined ? "" : ` —— ${detail}`}`);
  }
}

function read(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

const css = read("spa/src/globals.css");
const tsx = read("spa/src/components/editor/DocTitle.tsx");

/**
 * 取某个选择器的声明块。
 *
 * 必须整串精确匹配选择器列表，不能只匹配到其中一项：`.kn-doc-title::after`
 * 同时出现在自己的规则里和 `.kn-doc-title > textarea, .kn-doc-title::after`
 * 那条合并规则里，且两处都在行首。松散匹配会先撞上合并规则，然后断言「镜像
 * 没有 content」—— 一个纯粹由匹配错误造出来的失败。（第一版就是这么错的。）
 */
// 先去掉注释再拆规则：注释就贴在选择器前面，不剥掉的话它会被并进选择器串里，
// 比对必然失败。（第二版栽在这里。）
const cssBare = css.replace(/\/\*[\s\S]*?\*\//g, "");

function block(selector) {
  const want = selector.replace(/\s+/g, " ").trim();
  // 把 CSS 拆成「选择器列表 { 声明 }」，逐条比对归一后的选择器
  for (const m of cssBare.matchAll(/([^{}@]+)\{([^}]*)\}/g)) {
    if (m[1].replace(/\s+/g, " ").trim() === want) return m[2];
  }
  return null;
}

// ---------- 网格容器 ----------
const container = block(".kn-doc-title");
ok(".kn-doc-title 有规则", container !== null);
ok(
  ".kn-doc-title 是网格（镜像与 textarea 要叠在同一单元里）",
  container !== null && /display:\s*grid/.test(container),
  container ?? "",
);

// ---------- 排版必须一对一致 ----------
//
// 这是最要紧的一条：镜像和 textarea 的排版差任何一点，量出来的行数就不对。
// 所以两者必须写在同一个规则里 —— 分开写就迟早有人只改一边。
const paired = block(".kn-doc-title > textarea,\n.kn-doc-title::after");
ok(
  "textarea 与 ::after 的排版写在同一条规则里（分开写必然漂移）",
  paired !== null,
  "期望 `.kn-doc-title > textarea, .kn-doc-title::after` 合并成一条",
);

for (const prop of [
  "font", // font:inherit 一次带走 family/size/weight/style
  "letter-spacing",
  "line-height",
  "white-space",
  "overflow-wrap",
  "padding",
  "border",
  "margin",
]) {
  ok(
    `共享规则里声明了 ${prop}（两边排版必须一致）`,
    paired !== null && new RegExp(`(?:^|;|\\s)${prop}\\s*:`).test(paired),
    paired ?? "",
  );
}

ok(
  "两者占同一个网格单元",
  paired !== null && /grid-area:\s*1\s*\/\s*1/.test(paired),
  paired ?? "",
);
ok(
  "折行方式是 pre-wrap（保留空格且允许折行）",
  paired !== null && /white-space:\s*pre-wrap/.test(paired),
  paired ?? "",
);

// ---------- 镜像本身 ----------
const mirror = block(".kn-doc-title::after");
ok("::after 有独立规则", mirror !== null);
ok(
  "镜像读的是 data-title",
  mirror !== null && /content:\s*attr\(data-title\)/.test(mirror),
  mirror ?? "",
);
// 末尾那个空格：光标停在行尾时要给它留出宽度，否则最后一行会抖
ok(
  "镜像末尾补了一个空格",
  mirror !== null && /attr\(data-title\)\s*["']\s["']/.test(mirror),
  mirror ?? "",
);
// visibility:hidden 而不是 display:none —— 后者不占位，高度就撑不起来了
ok(
  "镜像用 visibility:hidden（display:none 不占位，高度会塌）",
  mirror !== null && /visibility:\s*hidden/.test(mirror),
  mirror ?? "",
);
ok(
  "镜像不参与 display:none",
  mirror !== null && !/display:\s*none/.test(mirror),
  mirror ?? "",
);
ok(
  "镜像点不到也选不中",
  mirror !== null &&
    /pointer-events:\s*none/.test(mirror) &&
    /user-select:\s*none/.test(mirror),
  mirror ?? "",
);

// ---------- textarea ----------
const area = block(".kn-doc-title > textarea");
ok("textarea 有独立规则", area !== null);
ok(
  "去掉 resize 手柄（高度由镜像决定，拖了会被立刻覆盖）",
  area !== null && /resize:\s*none/.test(area),
  area ?? "",
);
ok(
  "overflow:hidden（高度已经刚好，不该再出滚动条）",
  area !== null && /overflow:\s*hidden/.test(area),
  area ?? "",
);
ok(
  "宽度撑满，否则镜像与它的折行位置不同",
  area !== null && /width:\s*100%/.test(area),
  area ?? "",
);
ok(
  "颜色继承（主题的 h1 color 挂在容器上）",
  area !== null && /color:\s*inherit/.test(area),
  area ?? "",
);

// ---------- 组件侧的约定 ----------
ok(
  "data-title 传给了镜像容器",
  /data-title=\{value\}/.test(tsx),
  "镜像靠 attr(data-title) 读文本，没传就永远量不出高度",
);
ok(
  "用 textarea 而不是 input（input 永远单行，长标题只能横向滚）",
  /<textarea/.test(tsx) && !/<input/.test(tsx),
  tsx.slice(0, 0),
);
// 换行必须剥掉：标题最终是一个 h1，留着换行在产物里表达不出来
ok(
  "onChange 里剥掉换行",
  /replace\(\/\[\\r\\n\]\+\/g/.test(tsx),
  "粘贴多行文本时会带进换行",
);
ok(
  "回车不插换行而是交给 onEnter",
  /e\.preventDefault\(\)/.test(tsx) && /onEnter\?\.\(\)/.test(tsx),
  tsx.slice(0, 0),
);
ok(
  "普通回车会离开标题",
  shouldLeaveTitleOnEnter({ key: "Enter", isComposing: false, keyCode: 13 }),
);
ok(
  "输入法组合态的回车留在标题中",
  !shouldLeaveTitleOnEnter({ key: "Enter", isComposing: true, keyCode: 13 }),
);
ok(
  "兼容 keyCode 229 的输入法确认键",
  !shouldLeaveTitleOnEnter({ key: "Enter", isComposing: false, keyCode: 229 }),
);
ok(
  "非回车键不会离开标题",
  !shouldLeaveTitleOnEnter({ key: "Process", isComposing: false, keyCode: 229 }),
);
ok(
  "组件把浏览器组合态和兼容键码交给统一判断",
  /isComposing:\s*e\.nativeEvent\.isComposing/.test(tsx) &&
    /keyCode:\s*e\.keyCode/.test(tsx),
  "缺少输入法状态会让确认候选词的回车误跳到正文",
);
// 无障碍：placeholder 不是可访问名，必须另有 aria-label
ok(
  "有 aria-label",
  /aria-label=\{t\.editor\.titlePlaceholder\}/.test(tsx),
  "placeholder 不能当可访问名用",
);

// ---------- 与正文左边缘对齐 ----------
//
// 内缩写在外层 div 上而不是 .kn-doc-title 上：主题的 h1 规则带 padding
// （popart 是 18px 16px），选择器权重比 Tailwind 的类高，会把内缩顶掉 ——
// 标题左边缘就比正文往外凸。
ok(
  "内缩挂在外层容器上，不在 .kn-doc-title 上",
  /className="[^"]*\bpx-2\b[^"]*"/.test(tsx),
  "与 editorContentClass 的 px-2 对齐",
);
{
  const editorContent = read("spa/src/components/editor/themeCss.ts");
  const m = /const base = "([^"]*)"/.exec(editorContent);
  ok(
    "正文的内缩确实是 px-2（对不上就要同步改标题那侧）",
    m !== null && m[1].includes("px-2"),
    m ? m[1] : "未找到 editorContentClass 的 base",
  );
}

console.log(`\n文档标题：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
