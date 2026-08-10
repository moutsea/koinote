// 图片节点的焦点归还策略。
//
// 起因是个真实的 bug：点图 A → 往下滚 → 点图 B，视图会被拽回 A。
//
// 机制（@tiptap/core 的 focus 命令，本套件下面会把它复刻出来验证）：
// 不带位置调 `focus()` 时，如果当前选区不是文本选区，就走 delayedFocus，
// 而它的 options.scrollIntoView 默认为 true —— 于是滚回当前选区。点过图片之后
// 选区正是那张图的 NodeSelection，所以「滚回当前选区」＝「滚回上一张图」。
//
// 触发链：点 B 的 mousedown → A 的 input 失焦 → A 的 onBlur=commit →
// commit 里 focus() → 滚回 A。用户看到的是"点了 B 却跳回 A"。
//
// 判据：失焦路径不许把焦点/滚动收回编辑器；键盘路径（Enter/Esc/删图）必须收回。
// 这两件事没有类型能表达，只能读源码断言。
import { readFileSync } from "node:fs";

let pass = 0;
let fail = 0;

function ok(label, cond, detail) {
  if (cond) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL  ${label}${detail === undefined ? "" : ` —— ${detail}`}`);
  }
}

const src = readFileSync(
  new URL("../spa/src/components/editor/ImageNodeView.tsx", import.meta.url),
  "utf8",
);

// 去掉注释再扫：注释里正解释着这个 bug，会把讲解当成代码
const bare = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

// ---------- 失焦路径不能抢焦点 ----------
//
// 这是修复的核心。onBlur 必须显式传 refocus:false ——
// 写成 onBlur={commit} 就回到了 bug 现场。
ok(
  "onBlur 提交时不收回焦点",
  /onBlur=\{\(\)\s*=>\s*commit\(\{\s*refocus:\s*false\s*\}\)\}/.test(bare),
  "onBlur 必须显式 refocus:false，写成 onBlur={commit} 就是 bug 现场",
);
ok(
  "onBlur 没有裸绑 commit",
  !/onBlur=\{commit\}/.test(bare),
  "裸绑会走默认收焦点分支，且会把 FocusEvent 当参数传进去",
);

// ---------- 键盘路径要收回焦点 ----------
//
// 回车/Esc/删图之后用户想继续打字，焦点留在已卸载的 input 上等于焦点丢了 ——
// 那时按键全无反应。所以这三条路必须收回。
ok(
  "Enter 提交时收回焦点",
  /commit\(\{\s*refocus:\s*true\s*\}\)/.test(bare),
  "回车是显式确认，焦点该回正文",
);
{
  // cancel（Esc）与 removeImage（退格/删除）各自都要调收焦点
  const cancelBody = /function cancel\(\)\s*\{([\s\S]*?)\n  \}/.exec(bare)?.[1] ?? "";
  ok("Esc 取消后收回焦点", /refocusEditor\(\)/.test(cancelBody), cancelBody);

  const removeBody =
    /function removeImage\(\)\s*\{([\s\S]*?)\n  \}/.exec(bare)?.[1] ?? "";
  ok("删图后收回焦点", /refocusEditor\(\)/.test(removeBody), removeBody);
  // 删图必须先退出编辑态再删，否则 input 随节点卸载 → blur → 对已删节点写属性
  ok(
    "删图前先退出编辑态",
    removeBody.indexOf("setEditing(false)") < removeBody.indexOf("deleteNode()"),
    removeBody,
  );
}

// ---------- commit 的 refocus 必须是显式参数 ----------
//
// 给它一个默认值就会重新埋雷：漏传的地方悄悄拿到默认行为。
{
  const sig = /function commit\(([^)]*)\)/.exec(bare)?.[1] ?? "";
  ok("commit 接收 refocus 参数", /refocus/.test(sig), sig);
  // 解构默认值（`{ refocus = true }`）和可选属性（`refocus?: boolean`）都不行：
  // 两者都让"漏传"变成静默取默认，而默认哪一个都是错的 ——
  // true 回到 bug 现场，false 让键盘操作丢焦点。必须是必填。
  ok(
    "refocus 没有解构默认值",
    !/refocus\s*=/.test(sig),
    sig,
  );
  ok(
    "refocus 不是可选属性",
    !/refocus\s*\?\s*:/.test(sig),
    sig,
  );
  // 所有 commit 调用都必须显式给出 refocus。
  // 排除声明本身（`function commit(...)`）—— 否则参数列表会被当成一处调用。
  const calls = [...bare.matchAll(/(function\s+)?commit\(([^)]*)\)/g)]
    .filter((m) => !m[1])
    .map((m) => m[2].trim());
  ok("确实扫到了 commit 的调用点", calls.length > 0, String(calls.length));
  const bad = calls.filter((c) => !/refocus:\s*(true|false)/.test(c));
  ok("每处 commit 调用都显式传 refocus", bad.length === 0, JSON.stringify(bad));
}

// ---------- focus 调用不能散落 ----------
//
// 收敛到一个 refocusEditor 里，那条「为什么失焦时不能调」的理由才有地方写。
// 散在四处的话，下一个人只会看到一句 editor.commands.focus()，看不出危险。
{
  const raw = [...bare.matchAll(/editor\.commands\.focus\(/g)].length;
  ok(
    "focus 调用收敛在 refocusEditor 一处",
    raw === 1,
    `找到 ${raw} 处裸调 editor.commands.focus(`,
  );
}

// ---------- 复刻 TipTap 的 focus 逻辑，确认机制判断没错 ----------
//
// 上面全是"读源码"式断言，它们只能保证代码长成约定的样子，证明不了那个约定本身
// 是对的。所以把 @tiptap/core focus 命令的关键分支复刻出来跑一遍 ——
// 确认「不带位置 + 非文本选区」真的会触发 scrollIntoView。
{
  // 复刻 node_modules/@tiptap/core/dist/index.js 的 focus(position, options)
  function tiptapFocus({ position = null, selectionIsText, hasFocus }) {
    const options = { scrollIntoView: true };
    const effects = [];
    if (hasFocus && position === null) return effects; // 已聚焦且不指定位置：直接返回
    if (position === null && !selectionIsText) {
      // delayedFocus：view.focus() + 可选 scrollIntoView
      effects.push("view.focus");
      if (options.scrollIntoView) effects.push("scrollIntoView");
      return effects;
    }
    // resolveFocusPosition(null) 返回 null → 回落到当前选区
    effects.push("setSelection", "view.focus");
    if (options.scrollIntoView) effects.push("scrollIntoView");
    return effects;
  }

  // bug 现场：点过图片 → 选区是 NodeSelection（非文本选区），
  // input 失焦时编辑器没有焦点，focus() 不带位置
  const buggy = tiptapFocus({
    position: null,
    selectionIsText: false,
    hasFocus: false,
  });
  ok(
    "非文本选区下 focus() 确实会 scrollIntoView（这就是跳回上一张图的原因）",
    buggy.includes("scrollIntoView"),
    JSON.stringify(buggy),
  );

  // 对照：文本选区下也会滚，只是滚到光标处，视觉上不突兀
  const textCase = tiptapFocus({
    position: null,
    selectionIsText: true,
    hasFocus: false,
  });
  ok(
    "文本选区下同样会滚（所以问题不在选区类型，而在于根本不该调）",
    textCase.includes("scrollIntoView"),
    JSON.stringify(textCase),
  );

  // 所以修法只能是"别调"，而不是"换个位置参数"
  ok(
    "不调 focus 就没有任何滚动副作用",
    tiptapFocus({ position: null, selectionIsText: false, hasFocus: true }).length === 0,
    "已聚焦且 position 为 null 时才提前返回 —— 而失焦那一刻编辑器并没有焦点",
  );
}

// ---------- 与 MarkdownEditor 里那处 focus 的区别 ----------
//
// 标题按回车跳正文用的是 focus("start")：带了位置，走的是另一条分支，
// 滚到文档开头是刻意的。这条断言防止有人"顺手统一"成不带位置的写法。
{
  const editor = readFileSync(
    new URL("../spa/src/components/editor/MarkdownEditor.tsx", import.meta.url),
    "utf8",
  );
  ok(
    "标题跳正文用的是 focus('start')，带位置",
    /focus\("start"\)/.test(editor),
    "不带位置会落回上次光标处，可能在文档中间",
  );
}

// ---------- broken 不能是单向闸门 ----------
//
// onError 置 broken=true 之后必须有路径能清掉它，否则：
//   · 用户点开源码把地址改对，仍然显示"加载失败"，看着像新地址也坏了
//   · 一次偶发失败（弱网、CDN 冷启动）就把一张服务端完好的图永久判死，
//     只有刷新页面能恢复
// 判据是「存在一个依赖 src 的 effect 会 setBroken(false)」。
{
  ok(
    "onError 会置 broken",
    /onError=\{\(\)\s*=>\s*setBroken\(true\)\}/.test(bare),
    "图挂了要显形，否则用户看到的是一个碎图图标",
  );

  // 找出所有 useEffect(...)，看有没有哪个既 setBroken(false) 又以 src 为依赖
  const effects = bare.match(/useEffect\(\s*\(\)\s*=>\s*\{[\s\S]*?\}\s*,\s*\[[^\]]*\]\s*\)/g) ?? [];
  const resetsOnSrc = effects.some((body) => {
    if (!/setBroken\(false\)/.test(body)) return false;
    const deps = body.slice(body.lastIndexOf("["));
    // src 必须在依赖里，否则只在挂载时跑一次，等于没有重置
    return /\bsrc\b/.test(deps);
  });
  ok(
    "src 变化会重置 broken",
    resetsOnSrc,
    "缺这条 broken 就是单向闸门：改对地址也回不来，偶发失败永久判死",
  );
}

console.log(`\n图片焦点：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
