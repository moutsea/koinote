import { macWindowCSS } from "./macWindow";
import {
  findWechatTheme,
  resolveThemeRules,
  type WechatThemeRules,
} from "./wechatThemes";

/**
 * 把主题规则转成作用域 CSS，让编辑区直接显示排版效果。
 *
 * 为什么能复用导出用的规则表：那张表本来就是「标签名 → 声明串」，导出时内联到
 * style 属性，这里拼成选择器。同一份数据两种用法，编辑区看到的和粘贴出去的
 * 就不会漂移 —— 这是把主题搬到主页面的全部意义。
 *
 * 仍然对不上的两处（都不是这层能解决的）：
 *   · 公式在编辑区是 KaTeX 实时渲染，产物里是位图
 *   · 任务列表的复选框是 <input>，会被内联器当危险标签删掉
 */

/** 挂在编辑区外层容器上的 class */
export const THEME_SCOPE = "koinote-themed";

/**
 * 主题没覆盖但文档里会出现的标签。
 *
 * 套主题时要摘掉 Tailwind 的 prose（否则它的 code::before 会给行内代码加上
 * 反引号，还有一堆主题不知道的 margin），摘掉之后这些标签就没人管了。
 */
const FALLBACK = `
.${THEME_SCOPE} .ProseMirror h5,
.${THEME_SCOPE} .ProseMirror h6{font-weight:700;margin:20px 0 8px;}
.${THEME_SCOPE} .ProseMirror s,
.${THEME_SCOPE} .ProseMirror del{text-decoration:line-through;opacity:.75;}
.${THEME_SCOPE} .ProseMirror mark{background:#fff3a3;color:#1a1a1a;padding:0 2px;}
.dark .${THEME_SCOPE} .ProseMirror mark{background:#4a3f1f;color:#f5e6c8;}
.${THEME_SCOPE} .ProseMirror sub,
.${THEME_SCOPE} .ProseMirror sup{font-size:.75em;}
`;

/**
 * hljs 在浅色代码块上的配色（GitHub Light 精简版）。
 *
 * globals.css 里那套是 GitHub Dark，字符串用 #a5d6ff 这类亮色 —— 落在 minimal
 * 的 #f2f2f2 代码块上基本看不见。主题的 pre 底色深浅不一，得按亮度分流。
 */
/** GitHub Light 精简版，用于浅底代码块 */
const HLJS_LIGHT = {
  comment: "#6a737d",
  keyword: "#d73a49",
  string: "#032f62",
  number: "#005cc5",
  title: "#6f42c1",
  variable: "#e36209",
};

/** GitHub Dark 精简版，与 globals.css 里那套一致 */
const HLJS_DARK = {
  comment: "#8b949e",
  keyword: "#ff7b72",
  string: "#a5d6ff",
  number: "#79c0ff",
  title: "#d2a8ff",
  variable: "#ffa657",
};

/** 按作用域前缀生成一套 hljs 配色 */
function hljsCSS(scope: string, c: typeof HLJS_LIGHT): string {
  const s = (names: string[], color: string) =>
    `${names.map((n) => `${scope} .hljs-${n}`).join(",")}{color:${color};}`;
  return [
    s(["comment", "quote"], c.comment),
    s(["keyword", "selector-tag", "literal", "type"], c.keyword),
    s(["string", "attr", "template-tag"], c.string),
    s(["number", "symbol"], c.number),
    s(["title", "title.function_", "section"], c.title),
    s(["variable", "name", "attribute"], c.variable),
    s(["built_in", "builtin-name"], c.variable),
    s(["meta"], c.comment),
  ].join("\n");
}

/** 规则表里需要特殊处理的键，其余按标签名直接拼 */
const SPECIAL = new Set(["body", "pre code"]);

/**
 * 屏幕上正文区的底色一律跟随应用底色。
 *
 * 浅色主题的 body 底色大多是 #fff，而站点底色是宣纸 #f6f4ee ——
 * 正文区是居中的定宽列，底色差这一点点，左右就各留一道竖边，读起来是「没对齐
 * 的瑕疵」而不是层次。深色变体早就是这么处理的（见 wechatThemes.ts 里 DARK.surface
 * 的注释：试过亮一档，不成立），浅色这边漏了。
 *
 * 只改屏幕呈现，不动 theme.rules —— 主题规则仍作为导出基础；导出是否保留最外层
 * body 背景由主题的 exportBodyBackground 单独控制，不能让屏幕适配影响导出物。
 *
 * 例外是本来就用深色底的浅色变体（linear 的 #111114）：那是主题刻意的身份
 * （仿 Linear 的 changelog 页面），而且它的正文字色 #d7d7e1 压在宣纸上只有
 * 1.3:1，换底色会直接读不了。深底能活过微信的过滤器已实测确认，
 * 见 wechatThemes.ts 头注 —— 编辑器无需另做浅色版；公众号导出会按主题策略处理。
 * 判据用亮度而不是主题 id 白名单 —— 后者在新增主题时必然会漏。
 */
function surfaceOverride(bodyRules: string | undefined): string {
  if (!isLightBackground(bodyRules)) return "";
  return "background:var(--background);";
}

/** 生成某一模式下的规则块。scope 决定它挂在浅色还是 .dark 下 */
function blockFor(
  rules: Record<string, string | undefined>,
  scope: string,
): string[] {
  const parts: string[] = [
    // 底色覆盖排在主题声明之后才能生效
    `${scope}{${rules.body ?? ""}${surfaceOverride(rules.body)}}`,
    // ProseMirror 自己有 padding/min-height，别被主题的 body 规则顶掉
    `${scope} .ProseMirror{background:transparent;color:inherit;}`,
  ];

  // 文档标题跟着主题的 h1 走。
  //
  // 标题在导出时就是正文的第一个 h1（见各 export*.ts 的 heading 拼接），
  // 所以编辑区也得用同一套排版，否则「编辑区即预览」在标题这一项上是假的。
  //
  // 规则挂在 .kn-doc-title 容器上而不是里面的 textarea：h1 的声明里既有排版
  // （font-size / line-height）也有盒模型（margin / padding / border，magazine
  // 是上下 6px 实线，popart 有 box-shadow）。挂容器上，边框和底色才能包住整块；
  // textarea 与镜像用 font:inherit 继承排版部分。
  if (rules.h1) {
    parts.push(`${scope} .kn-doc-title{${rules.h1}}`);
    // 首个标题不该顶着工具栏。主题的 h1 margin-top 是给"正文中间的 h1"定的
    // （34~42px），标题在最上面，那个上边距会白留一大片。
    parts.push(`${scope} .kn-doc-title{margin-top:0;}`);
  }

  for (const [key, value] of Object.entries(rules)) {
    if (!value || SPECIAL.has(key)) continue;
    parts.push(`${scope} .ProseMirror ${key}{${value}}`);
  }

  const preCode = rules["pre code"];
  if (preCode) parts.push(`${scope} .ProseMirror pre code{${preCode}}`);

  return parts;
}

/**
 * 生成整段 CSS：浅色块 + .dark 作用域下的深色块。
 *
 * 两套同时输出而不是按当前模式只出一套：应用的深色是 .dark class 切的，切换时
 * 不该重新生成样式表 —— 那会让主题在切换瞬间闪一下。
 *
 * body 规则落到作用域容器自身：字体、字号、行高、背景由子元素继承，这跟导出时
 * 把 body 声明写在最外层 <section> 上是同一个道理。
 */
export function themeToCSS(themeId: string): string {
  if (!themeId) return ""; // 空串 = 不套主题，保留应用默认排版
  const theme = findWechatTheme(themeId);
  const light = theme.rules as unknown as Record<string, string | undefined>;
  const dark = resolveThemeRules(theme, "dark") as unknown as Record<
    string,
    string | undefined
  >;

  const parts = [
    ...blockFor(light, `.${THEME_SCOPE}`),
    ...blockFor(dark, `.dark .${THEME_SCOPE}`),
  ];

  parts.push(FALLBACK);

  // 代码块顶部的 Mac 窗口三点。
  //
  // 编辑区用伪元素，导出用真实元素（见 macWindow.ts）—— 同一效果两套实现是
  // 有意的：这里用伪元素才不会污染 ProseMirror 的文档模型（否则光标能移进去、
  // 复制会带出三个 ● 字符），而微信剥 <style>，那边只能用真实元素。
  parts.push(
    macWindowCSS(`.${THEME_SCOPE}`, !isLightBackground(light.pre)),
    macWindowCSS(`.dark .${THEME_SCOPE}`, !isLightBackground(dark.pre)),
  );

  // 代码高亮按各模式下 pre 的实际底色分流。
  //
  // 两种模式都显式输出，即使某套主题的取值恰好与 globals.css 相同 ——
  // 靠继承的话，globals.css 那套配色一改，这些主题会跟着变，而「它依赖全局配色」
  // 这件事在主题定义里看不出来。
  parts.push(
    hljsCSS(
      `.${THEME_SCOPE}`,
      isLightBackground(light.pre) ? HLJS_LIGHT : HLJS_DARK,
    ),
    hljsCSS(
      `.dark .${THEME_SCOPE}`,
      isLightBackground(dark.pre) ? HLJS_LIGHT : HLJS_DARK,
    ),
  );

  return parts.join("\n");
}

/**
 * 判断代码块底色是深还是浅。
 *
 * 只认 #rgb / #rrggbb —— 主题里的 pre 背景都是这两种写法。取不到就当深色，
 * 沿用 globals.css 的 GitHub Dark 配色（那是没有主题时的现状，不改更安全）。
 *
 * 取最后一个 background 而不是第一个：深色变体是「浅色声明 + 深色声明」拼出来
 * 的，同一个声明串里会出现两次 background，CSS 里生效的是后者。取第一个会把
 * 深色模式全判成浅底，高亮配色整套错。
 */
function isLightBackground(preRules: string | undefined): boolean {
  const matches = preRules?.match(/background:\s*(#[0-9a-fA-F]{3,6})/g);
  const hex = matches?.[matches.length - 1]?.match(/#[0-9a-fA-F]{3,6}/)?.[0];
  if (!hex) return false;
  const full =
    hex.length === 4
      ? `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
      : hex;
  if (full.length !== 7) return false;
  const r = parseInt(full.slice(1, 3), 16);
  const g = parseInt(full.slice(3, 5), 16);
  const b = parseInt(full.slice(5, 7), 16);
  // 感知亮度（ITU-R BT.601）。0.6 这个阈值把 #f2f2f2 归浅、#0f172a 归深
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6;
}

/** 编辑区容器的 class：套主题时摘掉 prose，让主题独占排版话语权 */
export function editorContentClass(themeId: string): string {
  const base = "max-w-none focus:outline-none min-h-[60vh] px-2 py-4";
  return themeId ? base : `prose prose-neutral dark:prose-invert ${base}`;
}

/** 分享页同理，但没有编辑态的最小高度与内边距 */
export function shareContentClass(themeId: string): string {
  const base = "max-w-none focus:outline-none";
  return themeId ? base : `prose prose-neutral dark:prose-invert ${base}`;
}

export type { WechatThemeRules };
