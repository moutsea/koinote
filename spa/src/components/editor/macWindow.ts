import { backgroundFrom, isDarkColor } from "./wechatHljs";

/**
 * 代码块顶部的 Mac 窗口红黄绿三点。
 *
 * 为什么要用真实元素而不是伪元素：微信会剥掉 <style>，伪元素没有任何内联等价
 * 写法 —— wechatThemes.ts 开头那条「伪元素一律不能用」的限制就是这个原因。
 * mdnice 在浏览器里用的是 ::before，但它导出到微信的产物同样是插进去的真实元素。
 *
 * 三点用 ● 字符而不是「带宽高和 border-radius 的方块」：
 * 我们已经有确证 —— 语法高亮之所以能在微信里显示，就是因为 span 上的 color
 * 存活。同一条证据保证了彩色字符一定能显示。而 width/height/border-radius
 * 三条里任何一条被剥掉，方块方案就会变成零尺寸（整个消失）或直角块。
 * 用字符则最坏情况只是字体不同导致圆点稍胖稍瘦。
 *
 * 点之间用 NBSP 分隔而不是普通空格：pre 的 white-space 会被微信剥掉（这是实测
 * 结论，见 wechatWhitespace.ts），普通空格会被折叠。
 */

/** macOS 交通灯的标准色 */
const DOTS = ["#ff5f56", "#ffbd2e", "#27c93f"];

/** 点的字号。12px 在微信正文里约等于 mdnice 那个尺寸 */
const DOT_SIZE = "13px";

/**
 * 深色代码块上的点要暗一档。
 *
 * 满饱和的 #ff5f56 压在 #111 上会发光刺眼 —— 深底上亮色的视觉重量比浅底大得多，
 * 三个点会比代码本身更抢眼。真实的 macOS 深色标题栏里交通灯也是压暗的。
 */
const DOTS_DARK = ["#e0443e", "#dea123", "#1aab29"];

/** 标记属性名，与 wechatInline 的保留机制对应 */
const KEEP_ATTR = "data-wechat-keep-style";

/**
 * 不换行空格。
 *
 * 写成转义序列而不是字面的 U+00A0 字符：两者在编辑器里长得一模一样，
 * 打错了肉眼看不出来 —— 这里原本就误写成了普通空格，是断言抓出来的。
 */
const NBSP = "\u00a0";

/** 圆点字符 */
const DOT_CHAR = "●";

/**
 * 按代码块底色挑一组点色。
 *
 * 判断不了底色时按浅底处理：微信文章绝大多数是白底，而这里选错的后果很轻
 * （点略亮或略暗），不值得为它加复杂度。
 */
export function dotsFor(preDeclarations: string): string[] {
  const background = backgroundFrom(preDeclarations);
  if (!background) return DOTS;
  return isDarkColor(background) === true ? DOTS_DARK : DOTS;
}

/**
 * 造一条 Mac 窗口栏。
 *
 * 用 span + display:block 而不是 div/p：
 *   · p 有主题规则，会被套上正文的 margin 与行高
 *   · div 在 pre 里语义上更怪，且同样要靠 display 生效
 * span 走 display:block 是 mdnice 验证过能在微信里生效的写法。
 *
 * line-height:1 是必须的：不写的话微信会塞自己的行高，点上下会多出一大片空白，
 * 代码块顶部凭空长高一截。这与代码 span 逐个写行高是同一个道理。
 */
export function buildMacBar(doc: Document, preDeclarations: string): HTMLElement {
  const bar = doc.createElement("span");
  bar.setAttribute(
    KEEP_ATTR,
    `display:block;margin-bottom:12px;font-size:${DOT_SIZE};line-height:1;`,
  );

  const colors = dotsFor(preDeclarations);
  colors.forEach((color, index) => {
    if (index > 0) bar.appendChild(doc.createTextNode(NBSP));
    const dot = doc.createElement("span");
    // 点自己也要压行高：它们是行内元素，同样会被微信塞行高
    dot.setAttribute(KEEP_ATTR, `color:${color};line-height:1;`);
    dot.textContent = DOT_CHAR;
    bar.appendChild(dot);
  });

  return bar;
}

/**
 * 给 root 里每个代码块插入窗口栏。返回插入的条数。
 *
 * 必须在 inlineWechatStyles 之前调用：那一步会把没有 data-wechat-keep-style
 * 的 span 的 style 清掉（span 没有主题规则），而 KEEP_ATTR 正是它保留内联样式的
 * 通道 —— 公式图片的宽高走的也是这条路。
 *
 * 幂等：已经有窗口栏的代码块跳过。
 */
export function addMacWindows(root: HTMLElement, preDeclarations: string): number {
  const doc = root.ownerDocument;
  if (!doc) return 0;

  let added = 0;
  for (const pre of Array.from(root.querySelectorAll("pre"))) {
    // 已经插过就跳过。判据是第一个子元素不是 code —— 插过之后第一个子元素是 bar
    const first = pre.firstElementChild;
    if (first && first.tagName.toLowerCase() !== "code") continue;
    // 没有 code 的 pre 不是代码块（理论上不会出现，但不该给它加窗口装饰）
    if (!pre.querySelector(":scope > code")) continue;

    pre.insertBefore(buildMacBar(doc, preDeclarations), pre.firstChild);
    added++;
  }
  return added;
}

/**
 * 编辑区用的伪元素版本。
 *
 * 编辑区是真实 CSS，能用伪元素 —— 不必往文档里插元素，那样会污染
 * ProseMirror 的文档模型（用户能把光标移进去、复制时会带出三个 ● 字符）。
 *
 * 所以同一个效果有两套实现：导出用真实元素（微信剥 style），编辑区用伪元素
 * （不污染文档）。视觉尺寸对齐，用户在编辑区看到的和粘出去的是同一个东西。
 *
 * 用 radial-gradient 画点而不是 content:"●●●"：content 只能给整串一个颜色，
 * 三个点的颜色不同就做不到。
 */
export function macWindowCSS(scope: string, dark: boolean): string {
  const colors = dark ? DOTS_DARK : DOTS;
  const layers = colors
    .map(
      (color, index) =>
        `radial-gradient(circle at ${6 + index * 20}px 6px,${color} 5.5px,transparent 6px)`,
    )
    .join(",");
  return `${scope} .ProseMirror pre::before{content:"";display:block;height:12px;margin-bottom:12px;background-image:${layers};background-repeat:no-repeat;}`;
}
