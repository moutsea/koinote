import { backgroundFrom, isDarkColor } from "./wechatHljs";

/**
 * 代码块的 Mac 窗口外观：顶部标题栏 + 红黄绿三点 + 圆角 + 投影。
 *
 * 为什么用真实元素而不是伪元素：微信剥掉 <style>，伪元素没有内联等价写法 ——
 * wechatThemes.ts 开头那条「伪元素一律不能用」就是这个原因。
 *
 * ── 关于尺寸类声明能不能用 ──────────────────────────────────────
 * 上一版这里用的是 ● 字符，理由是「width/height/border-radius 是否存活没有证据，
 * 而 color 有（语法高亮靠它活下来）」。那个判断已被推翻：mdnice 导出到微信的
 * 产物里明确带着 height / width / border-radius / box-shadow / background-color /
 * background-position，且实际能正常显示。所以这些声明是可用的，用真实圆形而不是
 * 字符 —— 字符的尺寸受字体摆布，三个 ● 在不同设备上胖瘦不一，这正是它难看的原因。
 *
 * ── 借鉴 mdnice 的几处关键做法 ────────────────────────────────
 *   · 标题栏与代码区同底色，连成一块完整面板（而不是浮在页面底色上的三个点）
 *   · pre 的 padding 归零，内边距移到 code 上 —— 标题栏才能齐边，
 *     否则它会被 pre 的 padding 往里缩一圈，看着像贴歪的贴纸
 *   · 圆角 + 投影。投影是「看起来精致」里权重最大的一条
 * 唯一没照搬的是三点的画法：mdnice 用的是托管在 files.mdnice.com 上的 SVG 背景图。
 * 那是别人家的图床资源，热链不合适，而且多一个外部依赖（图挂了点就没了）。
 * 这里用三个 inline-block 圆形，纯声明，不依赖任何外部资源。
 */

/** macOS 交通灯的标准色 */
const DOTS = ["#ff5f56", "#ffbd2e", "#27c93f"];

/**
 * 深色代码块上的点压暗一档。
 *
 * 满饱和的 #ff5f56 压在 #111 上会发光刺眼 —— 深底上亮色的视觉重量比浅底大得多，
 * 三个点会比代码本身更抢眼。真实的 macOS 深色标题栏里交通灯也是压暗的。
 */
const DOTS_DARK = ["#e0443e", "#dea123", "#1aab29"];

/** 圆点直径。12px 是 macOS 交通灯的真实尺寸 */
const DOT = 12;
/** 点间距。8px 同样取自 macOS */
const GAP = 8;
/** 标题栏高度。mdnice 用 30px，与 macOS 的 28px 标题栏接近 */
const BAR_H = 30;
/** 三点距左边的距离 */
const INSET = 14;
/** 圆角。6px 比 mdnice 的 5px 略圆一点，与站内其他卡片一致 */
const RADIUS = "6px";
/** 代码区内边距。顶部略收，因为上面已经有 30px 标题栏了 */
const CODE_PAD = "12px 16px 16px";

/**
 * 投影。深底用更重的，因为浅投影在深色面板边缘看不出来。
 * 比 mdnice 的 rgba(0,0,0,.55) 收了一档 —— 那个值在浅色文章里偏重。
 */
const SHADOW_LIGHT = "0 2px 10px rgba(0,0,0,0.14)";
const SHADOW_DARK = "0 2px 10px rgba(0,0,0,0.42)";

/** 取不到主题底色时标题栏用的兜底色 */
const FALLBACK_BG = "#f6f8fa";

/** 标记属性名，与 wechatInline 的保留机制对应 */
const KEEP_ATTR = "data-wechat-keep-style";

/** 代码块底色是深色吗。取不到底色时当浅色 —— 微信文章绝大多数是白底 */
function isDarkPre(preDeclarations: string): boolean {
  const background = backgroundFrom(preDeclarations);
  if (!background) return false;
  return isDarkColor(background) === true;
}

/**
 * 按代码块底色挑一组点色。
 *
 * 判断不了底色时按浅底处理，选错的后果很轻（点略亮或略暗）。
 */
export function dotsFor(preDeclarations: string): string[] {
  return isDarkPre(preDeclarations) ? DOTS_DARK : DOTS;
}

/**
 * 造一条标题栏。
 *
 * 用 span 而不是 div/p：p 会被套上正文的 margin 与行高（它有主题规则），
 * div 在 pre 里语义更怪。span 走 display:block 是 mdnice 验证过的写法。
 *
 * font-size:0 是为了让标题栏的高度只由 height 决定 —— 里面万一混进空白文本节点，
 * 它的行高会把标题栏顶高。三个点自己有明确尺寸，不受影响。
 */
export function buildMacBar(doc: Document, preDeclarations: string): HTMLElement {
  const bar = doc.createElement("span");
  const background = backgroundFrom(preDeclarations) ?? FALLBACK_BG;
  bar.setAttribute(
    KEEP_ATTR,
    `display:block;background:${background};height:${BAR_H}px;` +
      `padding:0 0 0 ${INSET}px;margin:0;font-size:0;line-height:${BAR_H}px;` +
      `border-radius:${RADIUS} ${RADIUS} 0 0;`,
  );

  dotsFor(preDeclarations).forEach((color, index) => {
    const dot = doc.createElement("span");
    dot.setAttribute(
      KEEP_ATTR,
      `display:inline-block;width:${DOT}px;height:${DOT}px;` +
        `border-radius:50%;background:${color};vertical-align:middle;` +
        // 最后一个不留右间距，否则三点整体偏左看着不居中
        (index < 2 ? `margin-right:${GAP}px;` : ""),
    );
    bar.appendChild(dot);
  });

  return bar;
}

/**
 * 把 pre 与 code 改造成窗口的外框与内容区。
 *
 * 走 data-wechat-keep-style 而不是直接写 style：内联器拼接的顺序是
 * 「主题规则 + 补充声明 + 高亮 + 保留样式」，保留样式在最后，才能盖住主题的
 * padding 与圆角。直接写 style 会被内联器整个清掉。
 *
 * padding 从 pre 挪到 code 是标题栏能齐边的前提 —— 留在 pre 上的话标题栏
 * 会被往里缩一圈，看着像贴歪的贴纸。
 */
function frameWindow(pre: Element, preDeclarations: string): void {
  const dark = isDarkPre(preDeclarations);
  pre.setAttribute(
    KEEP_ATTR,
    `padding:0;border-radius:${RADIUS};` +
      `box-shadow:${dark ? SHADOW_DARK : SHADOW_LIGHT};`,
  );

  const code = pre.querySelector(":scope > code");
  if (!code) return;
  // display:block 让 padding 真正把代码推开 —— 行内元素的上下 padding 不占布局
  code.setAttribute(
    KEEP_ATTR,
    `display:block;padding:${CODE_PAD};border-radius:0 0 ${RADIUS} ${RADIUS};`,
  );
}

/**
 * 给 root 里每个代码块加上窗口外观。返回处理的代码块数。
 *
 * 必须在 inlineWechatStyles 之前调用 —— 见 frameWindow 的注释。
 *
 * 幂等：已经加过的代码块跳过。
 */
export function addMacWindows(root: HTMLElement, preDeclarations: string): number {
  const doc = root.ownerDocument;
  if (!doc) return 0;

  let added = 0;
  for (const pre of Array.from(root.querySelectorAll("pre"))) {
    // 加过就跳过：加过之后第一个子元素是标题栏而不是 code
    const first = pre.firstElementChild;
    if (first && first.tagName.toLowerCase() !== "code") continue;
    // 没有 code 的 pre 不是代码块，不该加窗口装饰
    if (!pre.querySelector(":scope > code")) continue;

    pre.insertBefore(buildMacBar(doc, preDeclarations), pre.firstChild);
    frameWindow(pre, preDeclarations);
    added++;
  }
  return added;
}

/**
 * 编辑区用的伪元素版本。
 *
 * 编辑区是真实 CSS，用伪元素才不会污染 ProseMirror 的文档模型 ——
 * 插真实元素的话光标能移进去、复制代码会带出标题栏。
 *
 * 所以同一效果两套实现：导出用真实元素（微信剥 style），编辑区用伪元素。
 * 尺寸常量共用，编辑区看到的和粘出去的是同一个东西。
 *
 * 三点用 radial-gradient 画而不是 content:"●●●"：后者只能给整串一个颜色。
 */
export function macWindowCSS(scope: string, dark: boolean): string {
  const colors = dark ? DOTS_DARK : DOTS;
  const layers = colors
    .map((color, index) => {
      const cx = INSET + DOT / 2 + index * (DOT + GAP);
      // 半径处收一点点做抗锯齿，直接 transparent 会有硬边
      return `radial-gradient(circle at ${cx}px ${BAR_H / 2}px,${color} ${DOT / 2}px,transparent ${DOT / 2 + 0.5}px)`;
    })
    .join(",");

  return [
    `${scope} .ProseMirror pre{padding:0;border-radius:${RADIUS};box-shadow:${dark ? SHADOW_DARK : SHADOW_LIGHT};}`,
    `${scope} .ProseMirror pre::before{content:"";display:block;height:${BAR_H}px;background-image:${layers};background-repeat:no-repeat;}`,
    `${scope} .ProseMirror pre code{display:block;padding:${CODE_PAD};}`,
  ].join("\n");
}
