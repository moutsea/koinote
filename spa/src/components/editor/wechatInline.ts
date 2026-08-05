import type { WechatThemeRules } from "./wechatThemes";

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
};

/**
 * 就地改写 root 的子树。
 * 返回统计，便于测试断言「确实做了事」而不是空跑一遍。
 */
export function inlineWechatStyles(
  root: HTMLElement,
  rules: WechatThemeRules,
): InlineStats {
  const stats: InlineStats = { styled: 0, dropped: 0, attrsRemoved: 0 };

  // 先删危险标签。倒序遍历快照，避免边删边遍历漏节点
  const all = Array.from(root.querySelectorAll<HTMLElement>("*"));
  for (const el of all) {
    if (DROP_TAGS.has(el.tagName.toLowerCase())) {
      el.remove();
      stats.dropped++;
    }
  }

  for (const el of Array.from(root.querySelectorAll<HTMLElement>("*"))) {
    const tag = el.tagName.toLowerCase();

    // 代码块内的 code 与行内 code 视觉不同，是唯一需要看父节点的规则
    const key =
      tag === "code" && el.parentElement?.tagName.toLowerCase() === "pre"
        ? "pre code"
        : tag;

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

    if (declarations) {
      // 主题规则在前，保留的内联样式在后 —— 后者优先，才能盖住主题的宽高
      el.setAttribute("style", preserved ? `${declarations}${preserved}` : declarations);
      stats.styled++;
    } else if (preserved) {
      el.setAttribute("style", preserved);
    } else {
      // 没有对应规则的标签（span、div 等）不留空 style 属性
      el.removeAttribute("style");
    }
  }

  return stats;
}

/**
 * 把 body 级样式包在最外层。
 * 微信里没有 <body> 可写，只能套一个 <section> 承载字体、字号、行高，
 * 由子元素继承 —— 这是让正文整体换字体的唯一办法。
 */
export function wrapWechatBody(innerHTML: string, bodyRules: string): string {
  return `<section style="${bodyRules}">${innerHTML}</section>`;
}

/** 粗略估算粘贴体积。微信对单篇有上限，太大时值得提醒。 */
export function estimateBytes(html: string): number {
  return new Blob([html]).size;
}
