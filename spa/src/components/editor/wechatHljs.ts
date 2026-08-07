/**
 * 代码高亮的内联配色，供微信导出用。
 *
 * 为什么需要这个文件：编辑器里的高亮颜色来自 globals.css 的 .hljs-* class 规则，
 * 而微信会剥掉 class（wechatInline.ts 也会主动删，留着也没用）。所以导出时必须把
 * 颜色查表写进每个 span 的 style，否则整段代码是同一个颜色 —— 关键字、字符串、
 * 注释全都分不出来。
 *
 * 两套配色而不是一套：15 个主题里代码块底色有浅的（#f2f2f2、#f6f8fa）也有深的
 * （#111、#000、#161b22）。一套配色必然在其中一半上读不清。挑哪套由底色亮度决定，
 * 见 pickHljsPalette。
 */

/** 一套配色：hljs 类名 → 颜色 */
export type HljsPalette = Record<string, string>;

/**
 * 深底配色。取自 globals.css 里那套 GitHub Dark 精简版 —— 与编辑器所见一致，
 * 用户不会因为「导出后颜色变了」而怀疑是不是导错了。
 */
export const HLJS_DARK: HljsPalette = {
  comment: "#8b949e",
  quote: "#8b949e",
  keyword: "#ff7b72",
  "selector-tag": "#ff7b72",
  literal: "#ff7b72",
  type: "#ff7b72",
  string: "#a5d6ff",
  attr: "#a5d6ff",
  "template-tag": "#a5d6ff",
  number: "#79c0ff",
  symbol: "#79c0ff",
  title: "#d2a8ff",
  section: "#d2a8ff",
  variable: "#ffa657",
  name: "#ffa657",
  attribute: "#ffa657",
  built_in: "#ffa657",
  "builtin-name": "#ffa657",
  meta: "#8b949e",
};

/**
 * 浅底配色。GitHub Light 的取色。
 *
 * 不是把深色那套直接调暗：#a5d6ff（深色的字符串蓝）压在 #f6f8fa 上只有 1.4:1，
 * 完全读不出来。浅底需要整套重新取色，每个都往深处走。
 */
export const HLJS_LIGHT: HljsPalette = {
  comment: "#6e7781",
  quote: "#6e7781",
  keyword: "#cf222e",
  "selector-tag": "#cf222e",
  literal: "#0550ae",
  type: "#953800",
  string: "#0a3069",
  attr: "#0550ae",
  "template-tag": "#0a3069",
  number: "#0550ae",
  symbol: "#0550ae",
  title: "#8250df",
  section: "#0550ae",
  variable: "#953800",
  name: "#953800",
  attribute: "#0550ae",
  built_in: "#953800",
  "builtin-name": "#953800",
  meta: "#6e7781",
};

/**
 * 从一段 CSS 声明里取出 background 的颜色值。
 *
 * 只认 background 与 background-color，且只取到第一个分号 —— 主题规则是
 * "background:#111;color:#fff;padding:..." 这种平铺的声明串，不需要完整的 CSS 解析。
 *
 * 取不到时返回 null，调用方据此回落。
 */
export function backgroundFrom(declarations: string): string | null {
  const match = /(?:^|;)\s*background(?:-color)?\s*:\s*([^;]+)/i.exec(declarations);
  if (!match) return null;
  return match[1].trim() || null;
}

/**
 * 判断一个颜色是不是深色。
 *
 * 只认 #rgb / #rrggbb —— 主题里的底色都是十六进制。遇到 var()、rgb()、颜色名一律
 * 返回 null 表示「判断不了」，让调用方决定回落方向，而不是猜一个可能反的结论。
 *
 * 阈值用感知亮度（0.299R + 0.587G + 0.114B）而不是简单平均：人眼对绿最敏感、
 * 对蓝最不敏感，平均值会把 #0000ff 判成中等亮度，实际它看着很深。
 */
export function isDarkColor(color: string): boolean | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!hex) return null;

  let body = hex[1];
  if (body.length === 3) {
    // #abc → #aabbcc
    body = body[0] + body[0] + body[1] + body[1] + body[2] + body[2];
  }
  const r = parseInt(body.slice(0, 2), 16);
  const g = parseInt(body.slice(2, 4), 16);
  const b = parseInt(body.slice(4, 6), 16);

  const luma = 0.299 * r + 0.587 * g + 0.114 * b;
  // 128 是中点。边界附近两套配色都能读，所以不必纠结精确值
  return luma < 128;
}

/**
 * 按代码块的 pre 规则挑配色。
 *
 * 判断不了底色时回落到浅底那套（HLJS_LIGHT）：微信文章绝大多数是白底，
 * 而深色配色压在白底上（#a5d6ff 之类）几乎不可读；反过来浅色配色压在深底上
 * 至少还能勉强分辨。回落要选后果轻的那一边。
 */
export function pickHljsPalette(preDeclarations: string): HljsPalette {
  const background = backgroundFrom(preDeclarations);
  if (!background) return HLJS_LIGHT;
  const dark = isDarkColor(background);
  if (dark === null) return HLJS_LIGHT;
  return dark ? HLJS_DARK : HLJS_LIGHT;
}

/**
 * 从一个元素的 class 串里找出 hljs 的语义类名，返回对应颜色。
 *
 * 传 class 串而不是元素，是为了能脱离 DOM 测试。
 *
 * 有多个 hljs-* 时取第一个能查到颜色的：lowlight 会生成
 * `class="hljs-title function_"` 这种组合，其中只有 hljs-title 是我们表里的键。
 *
 * 注意 hljs-emphasis 与 hljs-strong 不在配色表里 —— 它们表达的是字形（斜体、粗体）
 * 而不是颜色，由 emphasisStyleFor 单独处理。
 */
export function hljsColorFor(
  className: string,
  palette: HljsPalette,
): string | null {
  for (const token of className.split(/\s+/)) {
    if (!token.startsWith("hljs-")) continue;
    const key = token.slice("hljs-".length);
    const color = palette[key];
    if (color) return color;
  }
  return null;
}

/**
 * hljs-emphasis / hljs-strong 对应的字形声明。
 *
 * 这两个与颜色无关，但同样依赖 class 才生效，所以一起在这里内联掉。
 * globals.css 里它们是 font-style: italic / font-weight: 700。
 */
export function emphasisStyleFor(className: string): string {
  const tokens = className.split(/\s+/);
  let out = "";
  if (tokens.includes("hljs-emphasis")) out += "font-style:italic;";
  if (tokens.includes("hljs-strong")) out += "font-weight:700;";
  return out;
}
