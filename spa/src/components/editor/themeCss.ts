import { findWechatTheme, type WechatThemeRules } from "./wechatThemes";

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
.${THEME_SCOPE} .ProseMirror mark{background:#fff3a3;color:inherit;padding:0 2px;}
.${THEME_SCOPE} .ProseMirror sub,
.${THEME_SCOPE} .ProseMirror sup{font-size:.75em;}
`;

/**
 * hljs 在浅色代码块上的配色（GitHub Light 精简版）。
 *
 * globals.css 里那套是 GitHub Dark，字符串用 #a5d6ff 这类亮色 —— 落在 minimal
 * 的 #f2f2f2 代码块上基本看不见。主题的 pre 底色深浅不一，得按亮度分流。
 */
const HLJS_LIGHT = `
.${THEME_SCOPE} .hljs-comment,.${THEME_SCOPE} .hljs-quote{color:#6a737d;}
.${THEME_SCOPE} .hljs-keyword,.${THEME_SCOPE} .hljs-selector-tag,
.${THEME_SCOPE} .hljs-literal,.${THEME_SCOPE} .hljs-type{color:#d73a49;}
.${THEME_SCOPE} .hljs-string,.${THEME_SCOPE} .hljs-attr,
.${THEME_SCOPE} .hljs-template-tag{color:#032f62;}
.${THEME_SCOPE} .hljs-number,.${THEME_SCOPE} .hljs-symbol{color:#005cc5;}
.${THEME_SCOPE} .hljs-title,.${THEME_SCOPE} .hljs-title.function_,
.${THEME_SCOPE} .hljs-section{color:#6f42c1;}
.${THEME_SCOPE} .hljs-variable,.${THEME_SCOPE} .hljs-name,
.${THEME_SCOPE} .hljs-attribute{color:#e36209;}
.${THEME_SCOPE} .hljs-built_in,.${THEME_SCOPE} .hljs-builtin-name{color:#e36209;}
.${THEME_SCOPE} .hljs-meta{color:#6a737d;}
`;

/** 规则表里需要特殊处理的键，其余按标签名直接拼 */
const SPECIAL = new Set(["body", "pre code"]);

/**
 * 生成整段 CSS。
 *
 * body 规则落到作用域容器自身：字体、字号、行高、背景由子元素继承，这跟导出时
 * 把 body 声明写在最外层 <section> 上是同一个道理。
 */
export function themeToCSS(themeId: string): string {
  if (!themeId) return ""; // 空串 = 不套主题，保留应用默认排版
  const rules = findWechatTheme(themeId).rules as Record<string, string | undefined>;

  const parts: string[] = [
    `.${THEME_SCOPE}{${rules.body ?? ""}}`,
    // ProseMirror 自己有 padding/min-height，别被主题的 body 规则顶掉
    `.${THEME_SCOPE} .ProseMirror{background:transparent;color:inherit;}`,
  ];

  for (const [key, value] of Object.entries(rules)) {
    if (!value || SPECIAL.has(key)) continue;
    parts.push(`.${THEME_SCOPE} .ProseMirror ${key}{${value}}`);
  }

  const preCode = rules["pre code"];
  if (preCode) {
    parts.push(`.${THEME_SCOPE} .ProseMirror pre code{${preCode}}`);
  }

  parts.push(FALLBACK);
  if (isLightBackground(rules.pre)) parts.push(HLJS_LIGHT);

  return parts.join("\n");
}

/**
 * 判断代码块底色是深还是浅。
 *
 * 只认 #rgb / #rrggbb —— 主题里的 pre 背景都是这两种写法。取不到就当深色，
 * 沿用 globals.css 的 GitHub Dark 配色（那是没有主题时的现状，不改更安全）。
 */
function isLightBackground(preRules: string | undefined): boolean {
  const hex = preRules?.match(/background:\s*(#[0-9a-fA-F]{3,6})/)?.[1];
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
