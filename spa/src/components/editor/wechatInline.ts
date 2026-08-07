import type { WechatThemeRules } from "./wechatThemes";
import {
  emphasisStyleFor,
  hljsColorFor,
  pickHljsPalette,
  type HljsPalette,
} from "./wechatHljs";

/**
 * 把主题样式内联到每个元素的 style 属性上，并清掉微信不接受的东西。
 *
 * 微信公众号编辑器的行为决定了这里的每一条：
 *   - 剥掉 <style> 与外链 CSS ⇒ 样式只能进 style 属性
 *   - 剥掉 class / id ⇒ 选择器只能是标签名；代码高亮（hljs-*）必然失效
 *   - 剥掉 <script> 等 ⇒ 直接删掉，不留残骸
 */

/** 微信会剥掉或存在风险的标签，整个子树一起删 */
const DROP_TAGS = new Set([
  "script",
  "style",
  "link",
  "iframe",
  "object",
  "embed",
  "form",
  "input",
  "button",
  "noscript",
]);

/** 保留的属性。其余一律删 —— class 会被微信剥掉，留着只是让 HTML 变大 */
const KEEP_ATTRS = new Set(["src", "href", "alt", "colspan", "rowspan", "style"]);

export type InlineStats = {
  styled: number;
  dropped: number;
  attrsRemoved: number;
  /** 内联了高亮颜色的元素数。为 0 说明代码块的高亮全丢了 */
  highlighted: number;
};

/** 主题的 pre 规则里没写 line-height 时用这个 */
const DEFAULT_CODE_LINE_HEIGHT = "1.6";

/**
 * 代码块必须补的声明。
 *
 * 统一在这里加而不是写进 15 个主题的 pre 规则里：那样加新主题时必然会漏，
 * 而漏掉的后果很重 —— 见下面每一条。
 *
 * white-space:pre-wrap 是这三条里最关键的。微信不保证 pre 的默认 white-space 存活，
 * 塌掉的话多行代码会被压成一行、缩进全部丢失 —— Python 直接变成废码。
 * 颜色丢了还能读，缩进丢了不能。
 *
 * 选折行（pre-wrap）而不是横向滚动（overflow:auto）：微信里代码块的横向滚动在手机上
 * 和页面滚动打架，基本没法用。长行折行至少读得下去。
 *
 * overflow-wrap:break-word 兜住没有空格可断的超长 token（长 URL、base64、
 * 压缩过的一行 JS）—— 只有 pre-wrap 的话它们仍会撑破容器。
 */
export const CODE_BLOCK_EXTRAS =
  "white-space:pre-wrap;overflow-wrap:break-word;word-break:break-all;";

/**
 * 从声明串里取 line-height。
 *
 * 代码块的行高要逐个 span 重复写一遍（微信会给行内元素塞自己的行高），
 * 所以得先知道主题定的是多少。
 */
export function lineHeightFrom(declarations: string): string | null {
  const match = /(?:^|;)\s*line-height\s*:\s*([^;]+)/i.exec(declarations);
  if (!match) return null;
  return match[1].trim() || null;
}

/**
 * 一个 class 串对应的高亮样式。没有 hljs class 时返回空串。
 *
 * 判据是有 hljs-* class，而那只有 lowlight 会生成，所以不必再看是否在 pre 里。
 *
 * 接 class 串而不是元素：这样它是个纯函数，能脱离 DOM 断言 ——
 * 而这段逻辑（查色、字形、行高三者的组合）正是最值得钉的部分。
 */
export function highlightStyleFor(
  className: string,
  palette: HljsPalette,
  lineHeight: string,
): string {
  if (!className.includes("hljs-")) return "";

  let style = "";
  const color = hljsColorFor(className, palette);
  if (color) style += `color:${color};`;
  style += emphasisStyleFor(className);
  // 行高无条件写：查不到颜色的 token（hljs-punctuation 之类）同样需要压住行高，
  // 否则那几个 span 的行距会和邻居不一样
  style += `line-height:${lineHeight};`;
  return style;
}

/**
 * 就地改写 root 的子树。
 * 返回统计，便于测试断言「确实做了事」而不是空跑一遍。
 */
export function inlineWechatStyles(
  root: HTMLElement,
  rules: WechatThemeRules,
): InlineStats {
  const stats: InlineStats = { styled: 0, dropped: 0, attrsRemoved: 0, highlighted: 0 };

  // 先删危险标签。倒序遍历快照，避免边删边遍历漏节点
  const all = Array.from(root.querySelectorAll<HTMLElement>("*"));
  for (const el of all) {
    if (DROP_TAGS.has(el.tagName.toLowerCase())) {
      el.remove();
      stats.dropped++;
    }
  }

  // 代码高亮的配色按代码块底色挑，整篇一次定好 —— 主题是全篇统一的
  const palette = pickHljsPalette(rules.pre ?? "");
  // 代码行的行高，逐个 span 压住。微信会给行内元素塞自己的行高，
  // 不显式写的话代码行距会参差
  const codeLineHeight = lineHeightFrom(rules.pre ?? "") ?? DEFAULT_CODE_LINE_HEIGHT;

  for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
    const tag = el.tagName.toLowerCase();

    // 代码块内的 code 与行内 code 视觉不同，是唯一需要看父节点的规则
    const key =
      tag === "code" && el.parentElement?.tagName.toLowerCase() === "pre"
        ? "pre code"
        : tag;

    // 高亮样式必须在删 class 之前读出来 —— 下面那个循环会把 class 删掉
    const highlight = highlightStyleFor(
      el.getAttribute("class") ?? "",
      palette,
      codeLineHeight,
    );

    const declarations = (rules as Record<string, string | undefined>)[key];

    // 已有的内联样式要保留一部分：公式图片的宽高是渲染时算出来的，
    // 主题规则不知道具体数值，覆盖掉会让公式变形。
    const preserved = el.getAttribute("data-wechat-keep-style");

    for (const name of Array.from(el.getAttributeNames())) {
      if (name === "data-wechat-keep-style") {
        el.removeAttribute(name);
        continue;
      }
      if (!KEEP_ATTRS.has(name)) {
        el.removeAttribute(name);
        stats.attrsRemoved++;
      }
    }

    // pre 与 pre code 都要补：微信在两层上都可能塞自己的 white-space
    const extras = key === "pre" || key === "pre code" ? CODE_BLOCK_EXTRAS : "";

    // 顺序：主题规则 → 补充声明 → 高亮 → 保留的内联样式。
    // 高亮在主题之后，因为 pre code 的 color 是整块的默认色，
    // 单个 token 的颜色必须能盖住它
    const combined =
      (declarations ?? "") + extras + highlight + (preserved ?? "");

    if (combined) {
      el.setAttribute("style", combined);
      if (declarations) stats.styled++;
      if (highlight) stats.highlighted++;
    } else {
      // 没有任何样式的标签（普通 div 等）不留空 style 属性
      el.removeAttribute("style");
    }
  }

  return stats;
}

/**
 * 把 body 级样式包在最外层。
 * 微信里没有 <body> 可写，只能套一个 <section> 承载字体、字号、行高，
 * 由子元素继承 —— 这是让正文整体换字体的唯一办法。
 *
 * bodyRules 必须转义双引号：字体栈里全是 "PingFang SC"、"Microsoft YaHei"
 * 这种带引号的族名，直接插进 style="..." 会被第一个双引号提前截断 ——
 * 属性到那里就结束了，后面的 font-size / line-height / color 全部丢失，
 * 剩下的片段还会被解析成一堆垃圾属性。30 个主题变体的 body 规则无一例外。
 */
export function wrapWechatBody(innerHTML: string, bodyRules: string): string {
  return `<section style="${escapeAttr(bodyRules)}">${innerHTML}</section>`;
}

/**
 * 转义要放进双引号属性值里的字符串。
 *
 * & 必须先转，否则会把后面产生的 &quot; 再转一次成 &amp;quot;。
 */
function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

/** 粗略估算粘贴体积。微信对单篇有上限，太大时值得提醒。 */
export function estimateBytes(html: string): number {
  return new Blob([html]).size;
}
