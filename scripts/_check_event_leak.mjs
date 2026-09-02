// 事件对象泄漏进请求体。
//
// 起因是个真实的 bug：TabBar 的加号写成 onClick={onCreate}，而 onCreate 的实参
// 是 folderId。React 于是把点击事件当成 folderId 传下去，body 里成了
// { folderId: <SyntheticEvent> } —— 那个对象的 view 指向 window，window.window
// 又指回 window，JSON.stringify 撞上循环引用直接抛 TypeError。请求根本没发出去，
// 用户只看到一句「请求失败，请重试」，而后端日志里干干净净什么都没有。
//
// 为什么 TS 查不出来：参数少的函数可以赋给参数多的类型（安全的逆变），所以
// `onCreate: () => void` 这个 prop 类型一旦把参数擦掉，onClick={onCreate} 就完全
// 合法。类型检查在这里是帮凶而不是防线。
//
// 判据不是「有没有参数」而是「参数是不是事件」：
//   onKeyDown={handleKeyDown}  handleKeyDown(e: React.KeyboardEvent)  —— 对的，它就要事件
//   onClick={onCreate}         onCreate(folderId?: string | null)     —— 错的，它要的是别的东西
// 所以只有「第一个参数明显不是事件」的裸绑才算违例。
import { readFileSync, readdirSync, statSync } from "node:fs";

let pass = 0;
let fail = 0;

function ok(label, cond, detail) {
  if (cond) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL  ${label}${detail === undefined ? "" : ` —— ${detail}`}`);
  }
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = `${dir}/${name}`;
    if (statSync(path).isDirectory()) walk(path, out);
    else if (path.endsWith(".tsx")) out.push(path);
  }
  return out;
}

/**
 * 去掉注释再扫。
 *
 * 这一步是被自己坑出来的：上一版直接扫原文，把本文件下面那段解释 bug 的注释里
 * 写的 `onClick={onCreate}` 当成真代码报了违例 —— 一个只存在于注释里的"违例"。
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** 参数类型看着像事件吗 */
function looksLikeEvent(paramText) {
  return (
    /\b(?:React\.)?\w*Event\b/.test(paramText) ||
    // LoginPage / SharePage 用的结构类型：{ preventDefault: () => void }
    /preventDefault/.test(paramText)
  );
}

/**
 * 收集「第一个参数明显不是事件」的回调名。
 *
 * 三种定义形式都要认：prop 类型声明、const 箭头函数（含 useCallback）、function 声明。
 */
function nonEventCallbacks(source) {
  const names = new Set();

  const add = (name, params) => {
    if (!params.trim()) return; // 无参：多传个事件无害
    if (looksLikeEvent(params)) return; // 它本来就要事件
    names.add(name);
  };

  // prop 类型声明：`onCreate: (folderId?: string | null) => void`
  // 不锚定行首 —— 内联的 { onCreate: (...) => void } 也要认
  for (const m of source.matchAll(/\b(on[A-Z]\w*)\??:\s*\(([^)]*)\)\s*=>/g)) {
    add(m[1], m[2]);
  }

  // const fn = (args) => / const fn = useCallback((args) =>
  for (const m of source.matchAll(
    /\bconst\s+(\w+)\s*=\s*(?:useCallback\s*\(\s*)?\(([^)]*)\)\s*(?::[^=]+)?=>/g,
  )) {
    add(m[1], m[2]);
  }

  // function fn(args)
  for (const m of source.matchAll(/\bfunction\s+(\w+)\s*\(([^)]*)\)/g)) {
    add(m[1], m[2]);
  }

  return names;
}

/**
 * 裸绑到 DOM 事件属性上的标识符。
 *
 * 只看小写开头的标签 —— `<ThemePicker onChange={changeTheme} />` 里的 onChange 是
 * 自定义 prop，签名由那个组件自己定（ThemePicker 内部会 e.target.value 解包），
 * 不是 DOM 事件，混进来就是误报。
 */
function bareDomBindings(source) {
  const out = [];
  const EVENTS =
    "onClick|onChange|onInput|onSubmit|onKeyDown|onKeyUp|onBlur|onFocus|onDoubleClick|onMouseDown";
  // 从每个标签的开头扫到结尾，只保留小写开头的标签
  for (const tag of source.matchAll(/<([a-zA-Z][\w.]*)((?:[^<>]|=>|"[^"]*"|'[^']*')*?)\/?>/g)) {
    const [, name, attrs] = tag;
    // 大写开头是自定义组件，onXxx 是它自己的 prop 不是 DOM 事件
    if (name[0] !== name[0].toLowerCase()) continue;
    for (const m of attrs.matchAll(new RegExp(`\\b(${EVENTS})=\\{(\\w+)\\}`, "g"))) {
      out.push({ event: m[1], handler: m[2], tag: name });
    }
  }
  return out;
}

const root = new URL("../spa/src", import.meta.url).pathname;
const files = walk(root);
ok("扫到了 tsx 文件", files.length > 10, String(files.length));

let checked = 0;
for (const file of files) {
  const source = stripComments(readFileSync(file, "utf8"));
  const risky = nonEventCallbacks(source);
  const short = file.slice(root.length + 1);

  for (const { event, handler, tag } of bareDomBindings(source)) {
    // 同名透传是刻意的转发：`onClick={onClick}` 传下去的就是事件本身
    if (handler === event) continue;
    checked += 1;
    ok(
      `${short}: <${tag} ${event}={${handler}}> 会把事件当成 ${handler} 的实参`,
      !risky.has(handler),
      `包一层箭头函数并显式传值，如 ${event}={() => ${handler}(null)}`,
    );
  }
}
ok("确实检查了若干裸绑", checked > 0, String(checked));

// ---------- 反向验证：这套检查真的能抓到那个 bug ----------
//
// 只断言「现在没问题」是不够的 —— 检查逻辑写错了同样全绿。
// 手工喂一段等价于 bug 现场的源码，确认它被判为违例。
{
  const buggy = `
    export function TabBar({ onCreate }: { onCreate: (folderId?: string | null) => void }) {
      return <button type="button" onClick={onCreate} />;
    }
  `;
  ok("认出 onCreate 的参数不是事件", nonEventCallbacks(buggy).has("onCreate"));
  const bindings = bareDomBindings(buggy);
  ok(
    "认出 button 上的裸绑",
    bindings.some((b) => b.handler === "onCreate" && b.tag === "button"),
    JSON.stringify(bindings),
  );
}

{
  // 修好之后不该再判违例
  const fixed = `
    export function TabBar({ onCreate }: { onCreate: (folderId?: string | null) => void }) {
      return <button type="button" onClick={() => onCreate(null)} />;
    }
  `;
  ok("修好的写法不再违例", bareDomBindings(fixed).length === 0, JSON.stringify(bareDomBindings(fixed)));
}

{
  // 无参回调裸绑：允许
  const fine = `
    export function Dialog({ onClose }: { onClose: () => void }) {
      return <button onClick={onClose} />;
    }
  `;
  ok("无参回调不违例", !nonEventCallbacks(fine).has("onClose"));
}

{
  // 参数就是事件：允许。这是 ContextMenu / ResizablePanel 的真实写法
  const eventy = `
    function onMenuKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {}
    const view = <div onKeyDown={onMenuKeyDown} />;
  `;
  ok("要事件的回调不违例", !nonEventCallbacks(eventy).has("onMenuKeyDown"));
}

{
  // 结构类型的事件参数：LoginPage / SharePage 的 submit 写法
  const structural = `
    async function submit(event: { preventDefault: () => void }) {}
    const view = <form onSubmit={submit} />;
  `;
  ok("结构化事件参数不违例", !nonEventCallbacks(structural).has("submit"));
}

{
  // 自定义组件的同名 prop：不是 DOM 事件，不该误报
  const custom = `
    const changeTheme = (next: string) => {};
    const view = <ThemePicker value={x} onChange={changeTheme} />;
  `;
  ok("自定义组件 prop 不被当成 DOM 事件", bareDomBindings(custom).length === 0, JSON.stringify(bareDomBindings(custom)));
  // 但它确实是"参数不是事件"的回调 —— 说明放过它靠的是标签判断，不是签名判断
  ok("changeTheme 本身算参数非事件", nonEventCallbacks(custom).has("changeTheme"));
}

{
  // 注释里的写法不算违例 —— 上一版就栽在这里
  const commented = `
    // 别写成 onClick={onCreate}
    /* 也别写成 onChange={onCreate} */
    export function X({ onCreate }: { onCreate: (id?: string) => void }) {
      return <button onClick={() => onCreate(null)} />;
    }
  `;
  ok(
    "注释里的写法不被判违例",
    bareDomBindings(stripComments(commented)).length === 0,
    JSON.stringify(bareDomBindings(stripComments(commented))),
  );
}

// ---------- prop 签名不能把参数擦掉 ----------
//
// 上面那套扫描有个前提：prop 类型如实写出了参数。如果有人把 TabBar 的
// `onCreate: (folderId?: string | null) => void` 又简写回 `() => void`，
// 扫描会认为它无参而放过裸绑 —— 而 TS 同样放过（参数少的函数可赋给参数多的类型）。
// 那就回到了 bug 现场，且两道防线同时失效。实测过：擦掉签名 + 裸绑，
// 这个套件和 typecheck:spa 都是绿的。
//
// 所以对这条具体的 prop 单独钉一遍：它必须带参数，且与 EditorPage 的
// handleCreate 对得上。
{
  const tabBar = readFileSync(`${root}/components/editor/TabBar.tsx`, "utf8");
  const match = /\bonCreate:\s*\(([^)]*)\)\s*=>/.exec(stripComments(tabBar));
  ok("TabBar 声明了 onCreate 的类型", match !== null);
  ok(
    "TabBar.onCreate 的签名带参数（擦掉会让裸绑重新变得不可见）",
    match !== null && match[1].trim().length > 0,
    match ? JSON.stringify(match[1]) : "未找到",
  );
  ok(
    "TabBar.onCreate 收的是 folderId",
    match !== null && /folderId/.test(match[1]),
    match ? match[1] : "未找到",
  );

  // 与实参方对齐：handleCreate 先保存目标目录，选择模板后再组装请求体。
  const page = stripComments(readFileSync(`${root}/pages/EditorPage.tsx`, "utf8"));
  ok(
    "EditorPage.handleCreate 收 folderId",
    /handleCreate\s*=\s*useCallback\(\s*\(\s*folderId\?/.test(page),
    "签名变了就要同步改 TabBar 的 prop 类型",
  );
  // folderId 必须原样进入模板请求状态，并在真正创建时进入请求体。
  // 这仍然钉住了事件对象可能一路走到 JSON.stringify 的完整通道。
  ok(
    "handleCreate 把 folderId 保存到模板请求",
    /setTemplateRequest\(\{[\s\S]*?folderId:\s*folderId\s*\?\?\s*null,[\s\S]*?fromRoute:\s*false/.test(page),
    "新建流程改动时要保留 folderId 的显式传递",
  );
  ok(
    "模板创建把保存的 folderId 放进 mutate",
    /create\.mutate\(\s*\{[\s\S]*?\.\.\.copy,[\s\S]*?folderId:\s*templateRequest\.folderId/.test(page),
    "模板选择后必须在目标文件夹内直接创建",
  );
}

// ---------- JSON.stringify 对合成事件确实会抛 ----------
//
// 这是整个 bug 的物理机制。钉住它，是为了让「为什么请求根本没发出去」
// 在代码里有据可查，而不是只留在一句注释里。
{
  const win = {};
  win.window = win;
  const el = { tagName: "BUTTON", ownerDocument: { defaultView: win } };
  const syntheticEvent = {
    _reactName: "onClick",
    type: "click",
    view: win,
    target: el,
    currentTarget: el,
  };
  let threw = null;
  try {
    JSON.stringify({ folderId: syntheticEvent });
  } catch (err) {
    threw = err;
  }
  ok("合成事件进 JSON.stringify 会抛 TypeError", threw instanceof TypeError, String(threw));
  ok(
    "抛的是循环引用",
    threw !== null && /[Cc]ircular/.test(String(threw.message)),
    String(threw && threw.message),
  );
  // 对照：正常的 folderId 当然不抛
  ok(
    "正常 folderId 可以序列化",
    JSON.stringify({ folderId: null }) === '{"folderId":null}',
  );
}

console.log(`\n事件泄漏检查：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
