/**
 * 微信公众号主题，20 套 × 浅色/深色两个变体。
 *
 * ┌─ 新增主题的硬性约束 ────────────────────────────────────────────┐
 * │ 1. rules 与 dark 都必须给。dark 里 body 与 pre 是必填 —— 类型会拦。   │
 * │ 2. dark.body 必须同时声明 background 与 color，且底色确实是深色、    │
 * │    与文字色有足够反差；dark.pre 的底色必须是深色。这三条类型拦不住，  │
 * │    由 npm run test:themes 在运行时拦。                            │
 * │ 3. 只写与浅色不同的声明，其余自动沿用 —— 不要整套复制粘贴，那样改一处 │
 * │    要记得改两处，迟早漂移。                                        │
 * │ 4. 伪元素一律不能用，见下方第 1 条限制。                            │
 * └──────────────────────────────────────────────────────────────┘
 *
 * 两个变体的分工：
 *   · 浅色 (rules)：编辑区、分享页的浅色模式，以及微信导出。公众号的阅读界面
 *     通常是白底；需要保留主题整篇底色的主题可使用 exportBodyBackground。
 *   · 深色 (dark)：只作用于编辑区与分享页的深色模式，不参与导出。
 *
 * 因此深色模式下「所见即所得」有一处让位：你在深色下写，粘出去是浅色版。这是
 * 有意的 —— 另一种做法是深色模式下把编辑区强行留白，那样整个界面更割裂。
 *
 * linear 是唯一一套浅色变体也用深底的（#111114）—— 它仿的是 Linear 的 changelog
 * 页面，深底加紫色强调就是那套设计的身份。编辑器与分享页继续保留这套深底；公众号
 * 导出则可关闭整篇底色，并为正文换成适合白底的文字色。
 *
 * 深底能不能活过微信的过滤器：**能，已实测确认**。保留整篇底色时，导出时底色靠
 * 最外层 <section> 的 background 撑着，微信保留了它。这一条值得写下来 —— 曾经担心过它被剥掉：
 * 那样正文 #d7d7e1 压在白底上只有 1.43:1，而 h1 是纯白压纯白 1.00:1，整篇消失。
 * 已验证不会发生；是否保留整篇底色由主题的 exportBodyBackground 控制。
 * （微信确实会剥 white-space，见 wechatWhitespace.ts —— 但 background 不剥。）
 *
 * 为什么是「标签名 → 声明串」而不是 CSS 文本：
 * 微信编辑器会剥掉 <style> 标签和 class 选择器，样式必须内联到每个元素的
 * style 属性上。既然最终只能按标签查表，就直接以这个形态存，省掉一道 CSS
 * 解析（keepask 那边是从 markdown 里正则抽 CSS 再拍平，多一层容易出错的环节）。
 *
 * 因此有两条硬限制，设计主题时必须避开：
 *   1. 伪元素用不了。内联时会被静默丢掉 —— 在微信里根本不出现。
 *   2. 后代选择器只支持 pre code 一种特例（代码块内的 code 与行内 code 不同）。
 *
 * 这批主题的样式来自 keepask 的 CSS 主题，搬过来时做了三处改造：
 *
 *   a. 伪元素改写成能内联的等价物。原 CSS 里有 6 条：minimal / editorial 的
 *      h2:before 装饰条、linear 的 h2:before 菱形、magazine 的 h1:after 短线与
 *      blockquote:before 引号、stripe 的 li:before 计数器。前 4 条改成
 *      border-left / border-bottom，视觉线索保住了（位置从上方挪到左侧）。
 *      后 2 条无法内联 —— 生成文字的伪元素没有等价写法：
 *        · stripe 的 "01 02 03" 靠 CSS counter，内联没有计数器上下文。
 *          补偿是给 li 加品牌紫左边框，保住「有序步骤」的视觉暗示；真要编号
 *          请用有序列表，ol 走微信自带的 decimal。
 *        · magazine 的大引号字形丢弃，改用上下细线框住引用块 —— 杂志 pull
 *          quote 的常见做法，同样能把引用从正文里拎出来。
 *
 *   b. body 去掉 max-width 和 margin:0 auto。微信正文宽度由平台固定，这两条
 *      不起作用。padding 只给需要面内留白的主题保留；是否在导出时保留 body
 *      背景由 exportBodyBackground 控制，局部元素背景始终保留。
 *
 *   c. 补齐 a / em / img / table / th / td 六个标签。原 CSS 没写，缺了会让
 *      链接、表格在微信里退回浏览器默认样式，图片还会溢出容器。
 */

export type WechatThemeId =
  | "minimal"
  | "medium"
  | "wired"
  | "verge"
  | "stripe"
  | "apple"
  | "ft"
  | "linear"
  | "github"
  | "notion"
  | "magazine"
  | "editorial"
  | "newspaper"
  | "course"
  | "event"
  | "paper"
  | "signal"
  | "notes"
  | "pulse";

/** 分组只用于选择器的分栏展示，不影响导出 */
export type WechatThemeGroup =
  | "推荐默认"
  | "经典媒体"
  | "科技产品"
  | "内容出版"
  | "中文公众号";

/** 分组的展示顺序 */
export const WECHAT_THEME_GROUPS: WechatThemeGroup[] = [
  "推荐默认",
  "经典媒体",
  "科技产品",
  "内容出版",
  "中文公众号",
];

/** 可内联的标签白名单。键必须是标签名，唯一例外是 "pre code"。 */
export type WechatThemeRules = {
  body: string;
  h1: string;
  h2: string;
  h3: string;
  h4?: string;
  p: string;
  blockquote: string;
  ul: string;
  ol?: string;
  li: string;
  strong: string;
  em: string;
  code: string;
  pre: string;
  "pre code": string;
  hr: string;
  a: string;
  img: string;
  table: string;
  th: string;
  td: string;
};

/**
 * 深色变体：只写与浅色不同的那些标签，其余自动沿用浅色。
 *
 * body 与 pre 是必填，不给默认沿用：
 *   · body 决定整块的底色与文字色，不重写就会在深色模式下留一块白板 ——
 *     这正是要解决的问题
 *   · pre 的底色决定代码高亮走哪套配色（themeCss.ts 按亮度分流），浅底代码块
 *     配在深色页面上会突然亮一块
 * 其余标签按需覆盖。新增主题时这两项漏了就是编译错误。
 */
export type WechatThemeDark = Partial<WechatThemeRules> &
  Pick<WechatThemeRules, "body" | "pre">;

export type WechatTheme = {
  id: WechatThemeId;
  /** 主题默认名称；界面展示时优先使用 i18n 中的本地化名称 */
  name: string;
  /** 一句话说明适用场景 */
  hint: string;
  group: WechatThemeGroup;
  /** 浅色变体。微信导出恒定用这一套 —— 公众号阅读界面是白底 */
  rules: WechatThemeRules;
  /** 深色变体。只作用于编辑区与分享页，不参与导出 */
  dark: WechatThemeDark;
  /** 是否在微信公众号导出最外层正文容器上保留背景 */
  exportBodyBackground?: boolean;
  /** 微信公众号导出时覆盖正文文字色，保证去掉深色背景后仍有足够对比度 */
  exportBodyColor?: string;
};

/**
 * 合出某一模式下的完整规则表。
 *
 * 浅色声明在前、深色覆盖在后靠 CSS 后来者优先生效，与 wechatInline 里
 * 「主题规则在前、保留样式在后」是同一个手法。
 */
export function resolveThemeRules(
  theme: WechatTheme,
  mode: "light" | "dark",
): WechatThemeRules {
  if (mode === "light") return theme.rules;
  const merged = { ...theme.rules } as Record<string, string>;
  for (const [tag, value] of Object.entries(theme.dark)) {
    if (value) merged[tag] = `${merged[tag] ?? ""}${value}`;
  }
  return merged as unknown as WechatThemeRules;
}

export const WECHAT_SYSTEM_FONT_STACK =
  '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';
const SANS = WECHAT_SYSTEM_FONT_STACK;
const SERIF =
  'Georgia,"Times New Roman","Songti SC","Noto Serif CJK SC",SimSun,serif';
const SONGTI = '"Songti SC","Noto Serif CJK SC",Georgia,"Times New Roman",SimSun,serif';
const MONO = '"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace';

/**
 * 深色变体的公共底座。
 *
 * surface 直接引用应用自身的 --background，不给具体色值。
 *
 * 试过比应用底色亮一档（#101013），想让编辑区像「同一界面里的一块纸」——
 * 不成立。正文区是居中的定宽列，底色只要和外面差一点，左右就各留一道竖边，
 * 读起来是没对齐的瑕疵而不是层次。深色下对色差的容忍度比浅色低得多。
 *
 * 所以深色变体的底色一律交给 var(--background)：应用底色怎么变它就怎么变，
 * 接缝从根上不存在。代价是 github 的 #0d1117、notion 的 #191919、ft 的暖褐底
 * 这些「有辨识度的底色」在深色下都放弃了 —— 身份改由面内元素承担：代码块、
 * 引用块、标题背景、边框、链接色，那些都还留着各自的主题色。
 */
const DARK = {
  /** 跟随应用底色，杜绝正文区与页面之间的接缝 */
  surface: "var(--background)",
  text: "#e4e4e7",
  /** 次要文字：引用、em、说明 */
  muted: "#a1a1aa",
  border: "#2a2a31",
  /** 代码块底色。必须是深底，否则高亮配色会被判成浅色那套 */
  code: "#17171b",
  codeText: "#d4d4d8",
};

/** 深色下表格与引用的公共写法，20 套里大部分只需要换强调色 */
const darkShared = (accent: string) => ({
  body: `color:${DARK.text};background:${DARK.surface};`,
  pre: `background:${DARK.code};color:${DARK.codeText};`,
  "pre code": `color:${DARK.codeText};`,
  code: `background:${DARK.code};color:${accent};`,
  blockquote: `background:#16161a;border-color:${accent};color:${DARK.muted};`,
  em: `color:${DARK.muted};`,
  hr: `border-color:${DARK.border};`,
  a: `color:${accent};`,
  th: `background:#1b1b20;border-color:${DARK.border};color:${DARK.text};`,
  td: `border-color:${DARK.border};`,
});

/** 图片在微信里必须收宽度，否则溢出容器 */
const IMG = "max-width:100%;height:auto;display:block;margin:18px auto;";
/** 表格同理，另外微信里表格字号比正文小一号更耐看 */
const TABLE =
  "border-collapse:collapse;width:100%;margin:18px 0;font-size:14px;line-height:1.6;";

export const WECHAT_THEMES: WechatTheme[] = [
  {
    id: "minimal",
    name: "极简黑白",
    hint: "默认款，深度长文与方法论",
    group: "推荐默认",
    rules: {
      body: `font-family:${SANS};font-size:16px;line-height:1.82;color:#2b2b2b;background:#fff;`,
      h1: "font-size:24px;line-height:1.35;font-weight:800;margin:34px 0 24px;color:#111;padding-bottom:16px;border-bottom:1px solid #111;",
      h2: "font-size:19px;line-height:1.45;font-weight:800;margin:42px 0 14px;color:#111;border-left:4px solid #111;padding-left:10px;",
      h3: "font-size:17px;line-height:1.5;font-weight:760;margin:30px 0 10px;color:#222;",
      h4: "font-size:16px;line-height:1.5;font-weight:700;margin:24px 0 8px;color:#333;",
      p: "margin:12px 0;line-height:1.82;",
      blockquote:
        "margin:20px 0;padding:13px 16px;border-left:3px solid #111;background:#f7f7f7;color:#555;",
      ul: "margin:12px 0;padding-left:20px;",
      ol: "margin:12px 0;padding-left:20px;",
      li: "margin:7px 0;line-height:1.82;",
      strong: "font-weight:850;color:#111;",
      em: "font-style:italic;color:#333;",
      code: `font-family:${MONO};background:#f2f2f2;color:#111;padding:2px 6px;border-radius:3px;font-size:14px;`,
      pre: "background:#f2f2f2;color:#111;padding:14px 16px;overflow:auto;font-size:14px;line-height:1.6;border-radius:4px;",
      "pre code": "background:none;padding:0;color:#111;font-size:14px;",
      hr: "border:none;border-top:1px solid #e0e0e0;margin:32px 0;",
      a: "color:#576b95;text-decoration:none;",
      img: IMG + "border-radius:4px;",
      table: TABLE,
      th: "border:1px solid #ddd;padding:8px 10px;background:#f5f5f5;font-weight:700;text-align:left;",
      td: "border:1px solid #ddd;padding:8px 10px;",
    },
    dark: {
      ...darkShared("#e4e4e7"),
      // 极简的强调本来就是纯黑，深色下翻成纯白
      h1: `color:#fff;border-color:#52525b;`,
      h2: `color:#fff;border-left-color:#fff;`,
      h3: `color:${DARK.text};`,
      h4: `color:${DARK.muted};`,
      strong: `color:#fff;`,
    },
  },
  {
    id: "medium",
    name: "Medium Essay",
    hint: "个人观点、深度长文、方法论文章",
    group: "经典媒体",
    rules: {
      body: `font-family:${SERIF};font-size:16px;line-height:1.92;color:#242424;background:#fff;`,
      h1: "font-size:28px;line-height:1.28;font-weight:700;margin:42px 0 28px;color:#111;",
      h2: "font-size:22px;line-height:1.35;font-weight:700;margin:52px 0 18px;color:#111;",
      h3: "font-size:18px;line-height:1.45;font-weight:700;margin:34px 0 12px;color:#333;",
      h4: "font-size:17px;line-height:1.5;font-weight:700;margin:26px 0 10px;color:#444;",
      p: "margin:15px 0;line-height:1.92;",
      blockquote:
        "margin:28px 0;padding:0 0 0 22px;border-left:3px solid #242424;color:#444;font-size:17px;line-height:1.86;font-style:italic;",
      ul: "margin:15px 0;padding-left:24px;",
      ol: "margin:15px 0;padding-left:24px;",
      li: "margin:8px 0;line-height:1.9;",
      strong: "font-weight:800;color:#111;",
      em: "font-style:italic;color:#444;",
      code: `font-family:${MONO};background:#f2f2f2;color:#222;padding:2px 6px;border-radius:3px;font-size:14px;`,
      pre: "background:#f2f2f2;color:#222;padding:14px 16px;overflow:auto;font-size:14px;line-height:1.6;",
      "pre code": "background:none;padding:0;color:#222;font-size:14px;",
      hr: "border:none;border-top:1px solid #d8d8d8;margin:40px auto;width:34%;",
      a: "color:#576b95;text-decoration:underline;",
      img: IMG + "border-radius:2px;",
      table: TABLE,
      th: "border:1px solid #d8d8d8;padding:8px 10px;background:#fafafa;font-weight:700;text-align:left;",
      td: "border:1px solid #d8d8d8;padding:8px 10px;",
    },
    dark: {
      // 衬线正文在深色下要略降字重，否则笔画糊在一起
      ...darkShared("#c8c8cd"),
      body: `color:#dcdce0;background:${DARK.surface};`,
      h1: `color:#fff;`,
      h2: `color:#fff;`,
      h3: `color:${DARK.text};`,
      h4: `color:${DARK.muted};`,
      blockquote: `border-color:#71717a;color:${DARK.muted};`,
      strong: `color:#fff;`,
    },
  },
  {
    id: "wired",
    name: "WIRED Feature",
    hint: "AI、科技观点、产品发布、前沿趋势",
    group: "经典媒体",
    rules: {
      body: `font-family:${SANS};font-size:16px;line-height:1.74;color:#111;background:#fff;`,
      h1: "font-size:28px;line-height:1.16;font-weight:950;margin:36px 0 26px;color:#111;border-top:6px solid #111;border-bottom:6px solid #111;padding:16px 0;",
      h2: "font-size:20px;line-height:1.35;font-weight:950;margin:44px 0 14px;color:#111;background:#f5ff00;padding:10px 12px;",
      h3: "font-size:18px;line-height:1.4;font-weight:900;margin:32px 0 10px;color:#111;text-decoration:underline;text-decoration-thickness:4px;text-decoration-color:#00e5ff;text-underline-offset:5px;",
      h4: "font-size:17px;line-height:1.45;font-weight:880;margin:26px 0 8px;color:#111;",
      p: "margin:12px 0;line-height:1.74;",
      blockquote:
        "margin:22px 0;padding:15px 16px;background:#111;color:#fff;border-left:0;font-weight:750;",
      ul: "margin:12px 0;padding-left:0;list-style:none;",
      ol: "margin:12px 0;padding-left:22px;",
      li: "margin:8px 0;line-height:1.72;padding:8px 10px;background:#f2f2f2;border-left:5px solid #111;",
      strong: "font-weight:950;color:#111;background:#f5ff00;",
      em: "font-style:italic;color:#111;",
      code: `font-family:${MONO};background:#111;color:#00e5ff;padding:2px 6px;border-radius:0;font-size:14px;`,
      pre: "background:#111;color:#00e5ff;padding:14px 16px;overflow:auto;font-size:14px;line-height:1.6;",
      "pre code": "background:none;padding:0;color:inherit;",
      hr: "border:none;height:5px;background:#111;margin:34px 0;",
      a: "color:#111;background:#f5ff00;text-decoration:underline;",
      img: IMG + "border:3px solid #111;border-radius:0;",
      table: TABLE,
      th: "border:3px solid #111;padding:8px 10px;background:#111;color:#f5ff00;font-weight:950;text-align:left;",
      td: "border:3px solid #111;padding:8px 10px;",
    },
    dark: {
      // 荧光黄与青本来就是深底上的配色，留着；翻的是「黑框白底」那部分
      body: `color:${DARK.text};background:var(--background);`,
      pre: `background:#000;color:#00e5ff;`,
      "pre code": "color:#00e5ff;",
      h1: "color:#f5ff00;border-color:#f5ff00;",
      h2: "background:#f5ff00;color:#0b0b0c;",
      h3: "color:#fff;",
      h4: "color:#f5ff00;",
      blockquote: "background:#f5ff00;color:#0b0b0c;",
      // 卡片式 li 的浅灰底在深色下要压掉
      li: "background:#16161a;border-left-color:#f5ff00;",
      strong: "background:#f5ff00;color:#0b0b0c;",
      em: `color:${DARK.muted};`,
      code: "background:#000;color:#00e5ff;",
      a: "color:#0b0b0c;background:#f5ff00;",
      hr: "background:#f5ff00;",
      img: "border-color:#f5ff00;",
      th: "background:#f5ff00;color:#0b0b0c;border-color:#f5ff00;",
      td: "border-color:#f5ff00;",
    },
  },
  {
    id: "verge",
    name: "The Verge Briefing",
    hint: "热点解读、产品更新、资讯评论",
    group: "经典媒体",
    exportBodyBackground: false,
    rules: {
      body: `font-family:${SANS};font-size:16px;line-height:1.76;color:#171717;background:#fff7fb;padding:20px 16px;`,
      h1: "font-size:27px;line-height:1.2;font-weight:950;margin:36px 0 24px;color:#fff;background:#111;padding:18px 16px;box-shadow:8px 8px 0 #ff4fd8;",
      h2: "font-size:20px;line-height:1.35;font-weight:900;margin:44px 0 14px;color:#111;padding:10px 12px;background:#bcff2f;",
      h3: "font-size:18px;line-height:1.42;font-weight:880;margin:32px 0 10px;color:#111;border-bottom:3px solid #ff4fd8;padding-bottom:6px;",
      h4: "font-size:17px;line-height:1.45;font-weight:850;margin:26px 0 8px;color:#111;",
      p: "margin:12px 0;line-height:1.76;",
      blockquote:
        "margin:22px 0;padding:14px 16px;border:3px solid #111;background:#fff;color:#111;font-weight:700;",
      ul: "margin:12px 0;padding-left:0;list-style:none;",
      ol: "margin:12px 0;padding-left:22px;",
      li: "margin:8px 0;line-height:1.74;padding:9px 10px;background:#fff;border-left:5px solid #ff4fd8;",
      strong: "font-weight:950;color:#111;background:#bcff2f;",
      em: "font-style:italic;color:#111;",
      code: `font-family:${MONO};background:#111;color:#bcff2f;padding:2px 6px;border-radius:0;font-size:14px;`,
      pre: "background:#111;color:#bcff2f;padding:14px 16px;overflow:auto;font-size:14px;line-height:1.6;",
      "pre code": "background:none;padding:0;color:inherit;",
      hr: "border:none;height:3px;background:#ff4fd8;margin:34px 0;width:70%;",
      a: "color:#111;background:#bcff2f;",
      img: IMG + "border:3px solid #111;border-radius:0;",
      table: TABLE,
      th: "border:3px solid #111;padding:8px 10px;background:#111;color:#bcff2f;font-weight:950;text-align:left;",
      td: "border:3px solid #111;padding:8px 10px;",
    },
    dark: {
      // 粉配柠檬绿在深底上更跳，浅粉背景要换掉
      body: `color:${DARK.text};background:var(--background);padding:20px 16px;`,
      pre: "background:#000;color:#bcff2f;",
      "pre code": "color:#bcff2f;",
      h1: "background:#ff4fd8;color:#0c0a0c;box-shadow:8px 8px 0 #bcff2f;",
      h2: "background:#bcff2f;color:#0c0a0c;",
      h3: "color:#fff;border-bottom-color:#ff4fd8;",
      h4: "color:#ff8ae6;",
      blockquote: "border-color:#ff4fd8;background:#16121a;color:#e9e9ee;",
      li: "background:#16121a;border-left-color:#ff4fd8;",
      strong: "background:#bcff2f;color:#0c0a0c;",
      em: "color:#ff8ae6;",
      code: "background:#000;color:#bcff2f;",
      a: "color:#0c0a0c;background:#bcff2f;",
      hr: "background:#ff4fd8;",
      img: "border-color:#ff4fd8;",
      th: "background:#ff4fd8;color:#0c0a0c;border-color:#ff4fd8;",
      td: "border-color:#ff4fd8;",
    },
  },
  {
    id: "stripe",
    name: "Stripe Docs",
    hint: "教程、工具说明、Agent 工作流文档",
    group: "科技产品",
    exportBodyBackground: false,
    rules: {
      body: `font-family:${SANS};font-size:16px;line-height:1.78;color:#2a2f45;background:#fbfcff;padding:20px 16px;`,
      h1: "font-size:25px;line-height:1.32;font-weight:850;margin:36px 0 24px;color:#0a2540;",
      h2: "font-size:19px;line-height:1.45;font-weight:820;margin:42px 0 14px;color:#0a2540;padding:10px 12px;background:#f1f5ff;border-left:4px solid #635bff;",
      h3: "font-size:17px;line-height:1.5;font-weight:780;margin:30px 0 10px;color:#425466;",
      h4: "font-size:16px;line-height:1.5;font-weight:750;margin:24px 0 8px;color:#556a7c;",
      p: "margin:12px 0;line-height:1.78;",
      blockquote:
        "margin:20px 0;padding:14px 16px;background:#fff;border:1px solid #d9e2f3;border-left:4px solid #635bff;color:#3c4257;",
      ul: "margin:12px 0;padding-left:0;list-style:none;",
      ol: "margin:12px 0;padding-left:22px;",
      li: "margin:8px 0;line-height:1.76;padding:9px 10px;background:#fff;border:1px solid #e5ebf5;border-left:3px solid #635bff;",
      strong: "font-weight:850;color:#0a2540;",
      em: "font-style:italic;color:#3c4257;",
      code: `font-family:${MONO};background:#eef2ff;color:#3b35a8;padding:2px 6px;border-radius:4px;font-size:14px;`,
      pre: "background:#eef2ff;color:#3b35a8;padding:14px 16px;overflow:auto;font-size:14px;line-height:1.6;",
      "pre code": "background:none;padding:0;",
      hr: "border:none;border-top:1px solid #d9e2f3;margin:32px 0;",
      a: "color:#635bff;text-decoration:none;",
      img: IMG + "border-radius:6px;",
      table: TABLE,
      th: "border:1px solid #d9e2f3;padding:8px 10px;background:#f1f5ff;font-weight:700;text-align:left;color:#0a2540;",
      td: "border:1px solid #d9e2f3;padding:8px 10px;",
    },
    dark: {
      ...darkShared("#a5a0ff"),
      // 底色带一点蓝，保住 Stripe 的冷调
      body: `color:#dcdce4;background:var(--background);padding:20px 16px;`,
      h1: "color:#fff;",
      h2: "background:#16161f;color:#c9c5ff;border-left-color:#7c74ff;",
      h3: "color:#b8b8c4;",
      h4: "color:#9c9caa;",
      blockquote: "background:#14141a;border-color:#7c74ff;color:#c4c4d0;",
      li: "background:#14141a;border-color:#26262f;border-left-color:#7c74ff;",
      strong: "color:#fff;",
    },
  },
  {
    id: "apple",
    name: "Apple Newsroom",
    hint: "正式公告、产品介绍、品牌文章",
    group: "经典媒体",
    rules: {
      body: `font-family:${SANS};font-size:16px;line-height:1.82;color:#1d1d1f;background:#fff;`,
      h1: "font-size:30px;line-height:1.16;font-weight:800;text-align:center;margin:42px 0 30px;color:#1d1d1f;",
      h2: "font-size:21px;line-height:1.42;font-weight:750;margin:48px 0 16px;color:#1d1d1f;text-align:center;",
      h3: "font-size:18px;line-height:1.5;font-weight:700;margin:32px 0 10px;color:#424245;",
      h4: "font-size:17px;line-height:1.5;font-weight:700;margin:26px 0 8px;color:#515154;",
      p: "margin:13px 0;line-height:1.82;",
      blockquote:
        "margin:22px 0;padding:16px 18px;background:#f5f5f7;border-left:0;color:#424245;border-radius:10px;",
      ul: "margin:13px 0;padding-left:22px;",
      ol: "margin:13px 0;padding-left:22px;",
      li: "margin:7px 0;line-height:1.82;",
      strong: "font-weight:800;color:#1d1d1f;",
      em: "font-style:italic;color:#515154;",
      code: `font-family:${MONO};background:#f5f5f7;color:#1d1d1f;padding:2px 6px;border-radius:5px;font-size:14px;`,
      pre: "background:#f5f5f7;color:#1d1d1f;padding:14px 16px;overflow:auto;font-size:14px;line-height:1.6;border-radius:10px;",
      "pre code": "background:none;padding:0;",
      hr: "border:none;border-top:1px solid #d2d2d7;margin:36px auto;width:42%;",
      a: "color:#0066cc;text-decoration:none;",
      img: IMG + "border-radius:10px;",
      table: TABLE,
      th: "border:1px solid #d2d2d7;padding:8px 10px;background:#f5f5f7;font-weight:700;text-align:left;",
      td: "border:1px solid #d2d2d7;padding:8px 10px;",
    },
    dark: {
      ...darkShared("#2997ff"),
      // Apple 深色界面的惯用值：近黑底 + #f5f5f7 文字 + #2997ff 链接
      body: "color:#f5f5f7;background:var(--background);",
      h1: "color:#f5f5f7;",
      h2: "color:#f5f5f7;",
      h3: "color:#c7c7cc;",
      h4: "color:#aeaeb2;",
      blockquote: "background:#1c1c1e;color:#c7c7cc;border-radius:10px;",
      pre: "background:#1c1c1e;color:#f5f5f7;border-radius:10px;",
      "pre code": "color:#f5f5f7;",
      code: "background:#1c1c1e;color:#f5f5f7;",
      strong: "color:#f5f5f7;",
      hr: "border-color:#38383a;",
      th: "background:#1c1c1e;border-color:#38383a;color:#f5f5f7;",
      td: "border-color:#38383a;",
    },
  },
  {
    id: "ft",
    name: "FT Analysis",
    hint: "商业分析、市场判断、对标研究",
    group: "经典媒体",
    exportBodyBackground: false,
    rules: {
      body: `font-family:${SERIF};font-size:16px;line-height:1.9;color:#262018;background:#fff1df;padding:20px 16px;`,
      h1: "font-size:27px;line-height:1.3;font-weight:800;margin:38px 0 24px;color:#111;border-bottom:3px double #5a4a36;padding-bottom:14px;",
      h2: "font-size:21px;line-height:1.42;font-weight:800;margin:46px 0 16px;color:#3b2b1d;padding-top:10px;border-top:1px solid #8a7356;",
      h3: "font-size:18px;line-height:1.5;font-weight:750;margin:32px 0 10px;color:#4c3a29;",
      h4: "font-size:17px;line-height:1.5;font-weight:720;margin:26px 0 8px;color:#5a4a36;",
      p: "margin:13px 0;line-height:1.9;",
      blockquote:
        "margin:22px 0;padding:12px 0 12px 18px;border-left:4px solid #8a7356;color:#4f4030;background:#f9e6cf;",
      ul: "margin:13px 0;padding-left:22px;",
      ol: "margin:13px 0;padding-left:22px;",
      li: "margin:7px 0;line-height:1.9;",
      strong: "font-weight:850;color:#111;",
      em: "font-style:italic;color:#4f4030;",
      code: `font-family:${MONO};background:#f5dec4;color:#3b2b1d;padding:2px 6px;border-radius:2px;font-size:14px;`,
      pre: "background:#f5dec4;color:#3b2b1d;padding:14px 16px;overflow:auto;font-size:14px;line-height:1.6;",
      "pre code": "background:none;padding:0;",
      hr: "border:none;border-top:1px solid #8a7356;margin:34px 0;width:58%;",
      a: "color:#5a4a36;text-decoration:none;",
      img: IMG + "border-radius:2px;",
      table: TABLE,
      th: "border:1px solid #8a7356;padding:8px 10px;background:#f5dec4;font-weight:800;text-align:left;color:#3b2b1d;",
      td: "border:1px solid #8a7356;padding:8px 10px;",
    },
    dark: {
      // FT 的身份是那层暖粉底。深色下改成暖褐调，不退成中性灰
      body: "color:#e8ded0;background:var(--background);padding:20px 16px;",
      pre: "background:#1c1611;color:#e8ded0;",
      "pre code": "color:#e8ded0;",
      code: "background:#1c1611;color:#d9a86c;",
      h1: "color:#f5ead8;border-bottom-color:#8a7356;",
      h2: "color:#e8d3b5;border-top-color:#6b5a44;",
      h3: "color:#d4bd9c;",
      h4: "color:#b8a184;",
      blockquote: "background:#1c1611;border-color:#8a7356;color:#cbb99f;",
      strong: "color:#f5ead8;",
      em: "color:#c0ab90;",
      a: "color:#d9a86c;",
      hr: "border-color:#4a3d2e;",
      th: "background:#1c1611;border-color:#4a3d2e;color:#e8d3b5;",
      td: "border-color:#4a3d2e;",
    },
  },
  {
    id: "linear",
    name: "Linear Changelog",
    hint: "版本公告、功能更新、路线图说明",
    group: "科技产品",
    exportBodyBackground: false,
    exportBodyColor: "#24242b",
    rules: {
      body: `font-family:${SANS};font-size:16px;line-height:1.76;color:#d7d7e1;background:#111114;padding:20px 16px;`,
      h1: "font-size:25px;line-height:1.32;font-weight:850;margin:36px 0 24px;color:#fff;",
      h2: "font-size:19px;line-height:1.45;font-weight:820;margin:40px 0 14px;color:#fff;padding:10px 0 10px 10px;border-bottom:1px solid #2b2b33;border-left:3px solid #8b5cf6;",
      h3: "font-size:17px;line-height:1.5;font-weight:780;margin:30px 0 10px;color:#c4b5fd;",
      h4: "font-size:16px;line-height:1.5;font-weight:750;margin:24px 0 8px;color:#b9b9c6;",
      p: "margin:12px 0;line-height:1.76;",
      blockquote:
        "margin:20px 0;padding:14px 16px;background:#19191f;border:1px solid #2b2b33;color:#d7d7e1;",
      ul: "margin:12px 0;padding-left:0;list-style:none;",
      ol: "margin:12px 0;padding-left:22px;",
      li: "margin:8px 0;line-height:1.74;padding:9px 10px;background:#17171c;border-left:3px solid #8b5cf6;",
      strong: "font-weight:850;color:#fff;",
      em: "font-style:italic;color:#b9b9c6;",
      code: `font-family:${MONO};background:#242432;color:#c4b5fd;padding:2px 6px;border-radius:4px;font-size:14px;`,
      pre: "background:#242432;color:#c4b5fd;padding:14px 16px;overflow:auto;font-size:14px;line-height:1.6;",
      "pre code": "background:none;padding:0;",
      hr: "border:none;border-top:1px solid #2b2b33;margin:32px 0;",
      a: "color:#c4b5fd;text-decoration:none;",
      img: IMG + "border-radius:6px;",
      table: TABLE,
      th: "border:1px solid #2b2b33;padding:8px 10px;background:#242432;font-weight:800;text-align:left;color:#c4b5fd;",
      td: "border:1px solid #2b2b33;padding:8px 10px;color:#d7d7e1;",
    },
    dark: {
      // 本来就是深色设计。只把底色往应用底色靠一档，其余照旧
      body: `color:#d7d7e1;background:var(--background);padding:20px 16px;`,
      pre: "background:#1a1a22;color:#c4b5fd;",
    },
  },
  {
    id: "github",
    name: "GitHub README",
    hint: "安装说明、工具介绍、技术文档",
    group: "科技产品",
    rules: {
      body: `font-family:${SANS};font-size:16px;line-height:1.76;color:#24292f;background:#fff;`,
      h1: "font-size:26px;line-height:1.28;font-weight:750;margin:36px 0 22px;color:#24292f;padding-bottom:10px;border-bottom:1px solid #d0d7de;",
      h2: "font-size:20px;line-height:1.45;font-weight:700;margin:38px 0 14px;color:#24292f;padding-bottom:8px;border-bottom:1px solid #d8dee4;",
      h3: "font-size:17px;line-height:1.5;font-weight:700;margin:28px 0 10px;color:#24292f;",
      h4: "font-size:16px;line-height:1.5;font-weight:700;margin:22px 0 8px;color:#24292f;",
      p: "margin:11px 0;line-height:1.76;",
      blockquote:
        "margin:18px 0;padding:8px 16px;border-left:4px solid #d0d7de;color:#57606a;background:#fff;",
      ul: "margin:12px 0;padding-left:24px;",
      ol: "margin:12px 0;padding-left:24px;",
      li: "margin:6px 0;line-height:1.76;",
      strong: "font-weight:750;color:#24292f;",
      em: "font-style:italic;color:#57606a;",
      code: `font-family:${MONO};background:#f6f8fa;color:#24292f;padding:2px 6px;border-radius:4px;font-size:14px;`,
      pre: "background:#f6f8fa;color:#24292f;padding:14px 16px;overflow:auto;font-size:14px;line-height:1.6;",
      "pre code": "background:none;padding:0;",
      hr: "border:none;border-top:1px solid #d0d7de;margin:28px 0;",
      a: "color:#0969da;text-decoration:none;",
      img: IMG + "border-radius:4px;",
      table: TABLE,
      th: "border:1px solid #d0d7de;padding:8px 10px;background:#f6f8fa;font-weight:700;text-align:left;",
      td: "border:1px solid #d0d7de;padding:8px 10px;",
    },
    dark: {
      // 直接用 GitHub Dark 的官方取值，这套主题的辨识度全在配色上
      body: "color:#e6edf3;background:var(--background);",
      pre: "background:#161b22;color:#e6edf3;",
      "pre code": "color:#e6edf3;",
      code: "background:#161b22;color:#e6edf3;",
      h1: "color:#e6edf3;border-bottom-color:#30363d;",
      h2: "color:#e6edf3;border-bottom-color:#21262d;",
      h3: "color:#e6edf3;",
      h4: "color:#c9d1d9;",
      blockquote: "border-color:#30363d;background:#0d1117;color:#8b949e;",
      strong: "color:#e6edf3;",
      em: "color:#8b949e;",
      a: "color:#4493f8;",
      hr: "border-color:#30363d;",
      th: "background:#161b22;border-color:#30363d;color:#e6edf3;",
      td: "border-color:#30363d;",
    },
  },
  {
    id: "notion",
    name: "Notion Memo",
    hint: "学习笔记、内部总结、项目复盘",
    group: "科技产品",
    exportBodyBackground: false,
    rules: {
      body: `font-family:${SANS};font-size:16px;line-height:1.82;color:#37352f;background:#fffefc;padding:20px 16px;`,
      h1: "font-size:27px;line-height:1.28;font-weight:780;margin:38px 0 24px;color:#37352f;",
      h2: "font-size:20px;line-height:1.45;font-weight:720;margin:42px 0 14px;color:#37352f;background:#f7f6f3;padding:10px 12px;",
      h3: "font-size:17px;line-height:1.5;font-weight:720;margin:30px 0 10px;color:#37352f;",
      h4: "font-size:16px;line-height:1.5;font-weight:700;margin:24px 0 8px;color:#4f4d48;",
      p: "margin:12px 0;line-height:1.82;",
      blockquote:
        "margin:20px 0;padding:12px 16px;border-left:3px solid #9b9a97;background:#f7f6f3;color:#4f4d48;",
      ul: "margin:12px 0;padding-left:22px;",
      ol: "margin:12px 0;padding-left:22px;",
      li: "margin:7px 0;line-height:1.82;",
      strong: "font-weight:800;color:#37352f;background:#fff2cc;",
      em: "font-style:italic;color:#4f4d48;",
      code: `font-family:${MONO};background:#f1f1ef;color:#37352f;padding:2px 6px;border-radius:3px;font-size:14px;`,
      pre: "background:#f1f1ef;color:#37352f;padding:14px 16px;overflow:auto;font-size:14px;line-height:1.6;",
      "pre code": "background:none;padding:0;",
      hr: "border:none;border-top:1px solid #e7e6e2;margin:32px 0;",
      a: "color:#37352f;text-decoration:underline;",
      img: IMG + "border-radius:4px;",
      table: TABLE,
      th: "border:1px solid #e7e6e2;padding:8px 10px;background:#f7f6f3;font-weight:700;text-align:left;",
      td: "border:1px solid #e7e6e2;padding:8px 10px;",
    },
    dark: {
      // Notion 深色的实际取值：#191919 底 + #d4d4d4 文字，高亮块换成低饱和棕
      ...darkShared("#a8a29e"),
      body: "color:#d4d4d4;background:var(--background);padding:20px 16px;",
      h1: "color:#eaeaea;",
      h2: "background:#252525;color:#eaeaea;",
      h3: "color:#d4d4d4;",
      h4: "color:#a8a8a8;",
      blockquote: "background:#252525;border-color:#5a5a5a;color:#b4b4b4;",
      pre: "background:#252525;color:#d4d4d4;",
      "pre code": "color:#d4d4d4;",
      code: "background:#252525;color:#d4d4d4;",
      // 浅色下是 #fff2cc 荧光块，深色下亮黄会刺眼
      strong: "background:#3d3527;color:#f5e6c8;",
      hr: "border-color:#2f2f2f;",
      th: "background:#252525;border-color:#2f2f2f;color:#eaeaea;",
      td: "border-color:#2f2f2f;",
    },
  },
  {
    id: "magazine",
    name: "Magazine Feature",
    hint: "人物稿、品牌故事、深度专题",
    group: "内容出版",
    rules: {
      body: `font-family:${SERIF};font-size:16px;line-height:1.94;color:#282828;background:#fff;`,
      h1: "font-size:28px;line-height:1.3;font-weight:700;text-align:center;margin:42px 0 30px;color:#111;border-bottom:1px solid #111;padding-bottom:18px;",
      h2: "font-size:21px;line-height:1.45;font-weight:700;margin:50px 0 18px;color:#111;text-align:center;",
      h3: "font-size:18px;line-height:1.5;font-weight:700;margin:34px 0 12px;color:#333;text-align:center;",
      h4: "font-size:17px;line-height:1.5;font-weight:700;margin:26px 0 10px;color:#444;text-align:center;",
      p: "margin:15px 0;line-height:1.94;",
      // 原 CSS 靠 blockquote:before 摆一个大引号，内联做不到。
      // 换成上下细线框住 —— 杂志 pull quote 的常见处理，同样能拎出引用
      blockquote:
        "margin:26px 0;padding:18px 22px;border-top:1px solid #ddd;border-bottom:1px solid #ddd;color:#555;font-size:15px;line-height:1.95;text-align:center;font-style:italic;",
      ul: "margin:15px 0;padding-left:22px;",
      ol: "margin:15px 0;padding-left:22px;",
      li: "margin:8px 0;line-height:1.92;",
      strong: "font-weight:800;color:#111;",
      em: "font-style:italic;color:#444;",
      code: `font-family:${MONO};background:#f3f3f3;color:#222;padding:2px 6px;border-radius:2px;font-size:14px;`,
      pre: "background:#f3f3f3;color:#222;padding:14px 16px;overflow:auto;font-size:14px;line-height:1.6;",
      "pre code": "background:none;padding:0;",
      hr: "border:none;border-top:1px solid #bdbdbd;margin:36px auto;width:46%;",
      a: "color:#576b95;text-decoration:underline;",
      img: IMG + "margin:22px auto;border-radius:0;",
      table: TABLE,
      th: "border:1px solid #bdbdbd;padding:8px 10px;background:#fafafa;font-weight:700;text-align:left;",
      td: "border:1px solid #bdbdbd;padding:8px 10px;",
    },
    dark: {
      ...darkShared("#c8c8cd"),
      body: "color:#dedede;background:var(--background);",
      h1: "color:#fff;border-bottom-color:#5a5a5a;",
      h2: "color:#fff;",
      h3: "color:#d4d4d4;",
      h4: "color:#b4b4b4;",
      // 上下细线的 pull quote 在深色下要提亮线条才看得见
      blockquote: "border-top-color:#3f3f46;border-bottom-color:#3f3f46;background:transparent;color:#b4b4b4;",
      strong: "color:#fff;",
      hr: "border-color:#4a4a4a;",
    },
  },
  {
    id: "editorial",
    name: "Editorial Column",
    hint: "创作者手记、观点随笔、复盘札记",
    group: "内容出版",
    rules: {
      body: `font-family:${SANS};font-size:16px;line-height:1.92;color:#252525;background:#fff;`,
      h1: "font-size:25px;line-height:1.42;font-weight:650;margin:38px 0 24px;color:#111;",
      h2: "font-size:19px;line-height:1.5;font-weight:700;margin:46px 0 16px;color:#111;border-left:4px solid #111;padding-left:10px;",
      h3: "font-size:17px;line-height:1.55;font-weight:700;margin:32px 0 12px;color:#333;",
      h4: "font-size:16px;line-height:1.55;font-weight:700;margin:24px 0 10px;color:#444;",
      p: "margin:14px 0;line-height:1.92;",
      blockquote:
        "margin:22px 0;padding:0 0 0 18px;border-left:2px solid #222;color:#4f4f4f;font-size:15px;line-height:1.9;",
      ul: "margin:14px 0;padding-left:20px;",
      ol: "margin:14px 0;padding-left:20px;",
      li: "margin:7px 0;line-height:1.9;",
      // 荧光笔效果。微信若不认 linear-gradient 就退化成无底色，不影响可读性
      strong:
        "font-weight:800;color:#111;background:linear-gradient(transparent 62%,#eeeeee 0);",
      em: "font-style:italic;color:#4f4f4f;",
      code: `font-family:${MONO};background:#f5f5f5;color:#222;padding:2px 6px;border-radius:3px;font-size:14px;`,
      pre: "background:#f5f5f5;color:#222;padding:14px 16px;overflow:auto;font-size:14px;line-height:1.6;",
      "pre code": "background:none;padding:0;",
      hr: "border:none;border-top:1px solid #e0e0e0;margin:34px 0;",
      a: "color:#111;text-decoration:underline;",
      img: IMG + "border-radius:3px;",
      table: TABLE,
      th: "border:1px solid #e0e0e0;padding:8px 10px;background:#f5f5f5;font-weight:700;text-align:left;",
      td: "border:1px solid #e0e0e0;padding:8px 10px;",
    },
    dark: {
      ...darkShared("#d4d4d8"),
      h1: "color:#fff;",
      h2: "color:#fff;border-left-color:#fff;",
      h3: "color:#d4d4d8;",
      h4: "color:#a1a1aa;",
      blockquote: "border-color:#71717a;background:transparent;color:#b4b4bb;",
      // 荧光笔渐变在深底上要用深灰，浅灰会盖住文字
      strong: "color:#fff;background:linear-gradient(transparent 62%,#3f3f46 0);",
    },
  },
  {
    id: "newspaper",
    name: "Newspaper Report",
    hint: "调查稿、商业报道、严肃分析",
    group: "内容出版",
    rules: {
      body: `font-family:${SONGTI};font-size:16px;line-height:1.88;color:#202020;background:#fff;`,
      h1: "font-size:25px;line-height:1.36;font-weight:800;margin:34px 0 20px;color:#111;padding:0 0 14px;border-bottom:3px double #111;",
      h2: "font-size:20px;line-height:1.42;font-weight:800;margin:42px 0 14px;color:#111;padding-top:10px;border-top:2px solid #111;",
      h3: "font-size:17px;line-height:1.5;font-weight:800;margin:30px 0 10px;color:#222;",
      h4: "font-size:16px;line-height:1.5;font-weight:800;margin:24px 0 8px;color:#333;",
      p: "margin:12px 0;line-height:1.88;",
      blockquote:
        "margin:20px 0;padding:12px 0 12px 18px;border-left:4px solid #555;color:#444;background:#fafafa;",
      ul: "margin:12px 0;padding-left:21px;",
      ol: "margin:12px 0;padding-left:21px;",
      li: "margin:7px 0;line-height:1.88;",
      strong: "font-weight:800;color:#111;",
      em: "font-style:italic;color:#333;",
      code: `font-family:${MONO};background:#eeeeee;color:#222;padding:2px 6px;border-radius:1px;font-size:14px;`,
      pre: "background:#eeeeee;color:#222;padding:14px 16px;overflow:auto;font-size:14px;line-height:1.6;",
      "pre code": "background:none;padding:0;",
      hr: "border:none;border-top:1px solid #999;margin:30px 0;",
      a: "color:#333;text-decoration:underline;",
      img: IMG + "border-radius:0;",
      table: TABLE,
      th: "border:1px solid #999;padding:7px 9px;background:#eee;font-weight:700;text-align:left;",
      td: "border:1px solid #999;padding:7px 9px;",
    },
    dark: {
      ...darkShared("#c8c8cd"),
      body: "color:#dcdcdc;background:var(--background);",
      // 双线与粗横线是报刊的骨架，深色下必须提亮才留得住
      h1: "color:#fff;border-bottom-color:#8a8a8a;",
      h2: "color:#fff;border-top-color:#8a8a8a;",
      h3: "color:#d4d4d4;",
      h4: "color:#b4b4b4;",
      blockquote: "border-color:#6b6b6b;background:#161616;color:#b4b4b4;",
      strong: "color:#fff;",
      hr: "border-color:#5a5a5a;",
    },
  },
  {
    id: "course",
    name: "课程讲义",
    hint: "课程、教程、学习笔记、操作说明",
    group: "中文公众号",
    rules: {
      body: `font-family:${SANS};font-size:16px;line-height:1.84;color:#272727;background:#fff;`,
      h1: "font-size:24px;line-height:1.38;font-weight:800;text-align:center;margin:34px 0 22px;color:#111;",
      h2: "font-size:19px;line-height:1.45;font-weight:800;margin:40px 0 16px;color:#111;padding:11px 14px;background:#f3f3f3;",
      h3: "font-size:17px;line-height:1.5;font-weight:800;margin:30px 0 10px;color:#111;padding-bottom:6px;border-bottom:1px dotted #aaa;",
      h4: "font-size:16px;line-height:1.5;font-weight:800;margin:24px 0 8px;color:#222;",
      p: "margin:12px 0;line-height:1.84;",
      blockquote:
        "margin:18px 0;padding:14px 16px;background:#f8f8f8;border-top:1px solid #e1e1e1;border-bottom:1px solid #e1e1e1;color:#444;",
      ul: "margin:12px 0;padding-left:20px;",
      ol: "margin:12px 0;padding-left:20px;",
      li: "margin:7px 0;line-height:1.84;",
      strong: "font-weight:850;color:#111;",
      em: "font-style:italic;color:#444;",
      code: `font-family:${MONO};background:#eeeeee;color:#222;padding:2px 6px;border-radius:3px;font-size:14px;`,
      pre: "background:#eeeeee;color:#222;padding:14px 16px;overflow:auto;font-size:14px;line-height:1.6;",
      "pre code": "background:none;padding:0;",
      hr: "border:none;border-top:1px solid #ddd;margin:30px 0;",
      a: "color:#576b95;text-decoration:none;",
      img: IMG + "border-radius:4px;",
      table: TABLE,
      th: "border:1px solid #ddd;padding:8px 10px;background:#f3f3f3;font-weight:700;text-align:left;",
      td: "border:1px solid #ddd;padding:8px 10px;",
    },
    dark: {
      ...darkShared("#7dd3fc"),
      h1: "color:#fff;",
      h2: "background:#1c1c22;color:#fff;",
      h3: "color:#e4e4e7;border-bottom-color:#52525b;",
      h4: "color:#a1a1aa;",
      blockquote:
        "background:#16161a;border-top-color:#2f2f36;border-bottom-color:#2f2f36;color:#b4b4bb;",
      strong: "color:#fff;",
    },
  },
  {
    id: "event",
    name: "活动公告",
    hint: "活动通知、招募、发布公告、转化文",
    group: "中文公众号",
    rules: {
      body: `font-family:${SANS};font-size:16px;line-height:1.78;color:#2c2424;background:#fff;`,
      h1: "font-size:24px;line-height:1.35;font-weight:900;text-align:center;margin:34px 0 20px;color:#8f1f1d;padding:18px 12px;border:2px solid #8f1f1d;background:#fffafa;",
      h2: "font-size:19px;line-height:1.45;font-weight:850;margin:40px 0 14px;color:#8f1f1d;padding:0 0 10px;border-bottom:2px solid #8f1f1d;",
      h3: "font-size:17px;line-height:1.5;font-weight:800;margin:30px 0 10px;color:#4a2a2a;",
      h4: "font-size:16px;line-height:1.5;font-weight:800;margin:24px 0 8px;color:#5a3a3a;",
      p: "margin:12px 0;line-height:1.78;",
      blockquote:
        "margin:18px 0;padding:14px 16px;background:#8f1f1d;color:#fff;border-left:0;",
      ul: "margin:12px 0;padding-left:20px;",
      ol: "margin:12px 0;padding-left:20px;",
      li: "margin:7px 0;line-height:1.78;",
      strong: "font-weight:900;color:#8f1f1d;",
      em: "font-style:italic;color:#6a4a4a;",
      code: `font-family:${MONO};background:#fff0f0;color:#8f1f1d;padding:2px 6px;border-radius:3px;font-size:14px;`,
      pre: "background:#fff0f0;color:#8f1f1d;padding:14px 16px;overflow:auto;font-size:14px;line-height:1.6;",
      "pre code": "background:none;padding:0;",
      hr: "border:none;height:2px;background:#8f1f1d;margin:30px 0;",
      a: "color:#8f1f1d;text-decoration:none;",
      img: IMG + "border-radius:4px;",
      table: TABLE,
      th: "border:1px solid #e8c4c4;padding:8px 10px;background:#fff0f0;font-weight:800;text-align:left;color:#8f1f1d;",
      td: "border:1px solid #e8c4c4;padding:8px 10px;",
    },
    dark: {
      // 深色下 #8f1f1d 这种暗红几乎黑掉，整套红要往亮处提
      body: "color:#e8dcdc;background:var(--background);",
      pre: "background:#1e1414;color:#f0b8b6;",
      "pre code": "color:#f0b8b6;",
      code: "background:#1e1414;color:#ff8a86;",
      h1: "color:#ff8a86;border-color:#ff8a86;background:#1a1212;",
      h2: "color:#ff8a86;border-bottom-color:#ff8a86;",
      h3: "color:#e8c4c2;",
      h4: "color:#c9a4a2;",
      blockquote: "background:#7a1a18;color:#ffe8e7;",
      strong: "color:#ff8a86;",
      em: "color:#c9a4a2;",
      a: "color:#ff8a86;",
      hr: "background:#ff8a86;",
      th: "background:#1e1414;border-color:#4a2c2c;color:#ff8a86;",
      td: "border-color:#4a2c2c;",
    },
  },
  {
    id: "paper",
    name: "Koinote Paper",
    hint: "深度长文、人物故事、经验分享",
    group: "内容出版",
    exportBodyBackground: false,
    rules: {
      body: `font-family:${SERIF};font-size:16px;line-height:1.92;color:#332b26;background:#fffaf1;padding:20px 16px;`,
      h1: "font-size:29px;line-height:1.28;font-weight:800;margin:38px 0 26px;color:#2b211c;padding:0 0 16px;border-bottom:4px solid #c76b45;",
      h2: "font-size:21px;line-height:1.42;font-weight:800;margin:46px 0 16px;color:#3b2921;padding-left:12px;border-left:4px solid #c76b45;",
      h3: "font-size:18px;line-height:1.5;font-weight:750;margin:32px 0 10px;color:#5a4033;",
      h4: "font-size:17px;line-height:1.5;font-weight:700;margin:25px 0 8px;color:#725747;",
      p: "margin:14px 0;line-height:1.92;",
      blockquote:
        "margin:24px 0;padding:16px 18px;border:1px solid #ead8c6;border-left:4px solid #c76b45;background:#fff3e4;color:#654b3d;",
      ul: "margin:14px 0;padding-left:22px;",
      ol: "margin:14px 0;padding-left:22px;",
      li: "margin:8px 0;line-height:1.9;",
      strong: "font-weight:850;color:#2b211c;",
      em: "font-style:italic;color:#725747;",
      code: `font-family:${MONO};background:#f4e7d8;color:#7d432c;padding:2px 6px;border-radius:3px;font-size:14px;`,
      pre: "background:#f4e7d8;color:#4a3024;padding:14px 16px;overflow:auto;font-size:14px;line-height:1.6;border-radius:4px;",
      "pre code": "background:none;padding:0;color:inherit;",
      hr: "border:none;border-top:1px solid #d9bda6;margin:36px auto;width:52%;",
      a: "color:#a94f31;text-decoration:underline;text-decoration-color:#d9a88e;text-underline-offset:3px;",
      img: IMG + "border-radius:2px;",
      table: TABLE,
      th: "border:1px solid #d9bda6;padding:8px 10px;background:#f4e7d8;font-weight:800;text-align:left;color:#4a3024;",
      td: "border:1px solid #d9bda6;padding:8px 10px;",
    },
    dark: {
      ...darkShared("#e7a078"),
      body: `color:#e5d9d0;background:${DARK.surface};padding:20px 16px;`,
      h1: "color:#fff0e5;border-bottom-color:#d9825c;",
      h2: "color:#f3d2c0;border-left-color:#d9825c;",
      h3: "color:#dfbda9;",
      h4: "color:#c7a18c;",
      blockquote: "background:#211914;border-color:#704331;color:#cbb1a1;",
      strong: "color:#fff0e5;",
      em: "color:#c7a18c;",
      code: "background:#211914;color:#e7a078;",
      pre: "background:#211914;color:#e5d9d0;",
      "pre code": "color:#e5d9d0;",
      a: "color:#e7a078;text-decoration-color:#704331;",
      hr: "border-color:#4b3328;",
      th: "background:#211914;border-color:#4b3328;color:#f3d2c0;",
      td: "border-color:#4b3328;",
    },
  },
  {
    id: "signal",
    name: "Koinote Signal",
    hint: "AI 产品、版本更新、工作流拆解",
    group: "科技产品",
    exportBodyBackground: false,
    rules: {
      body: `font-family:${SANS};font-size:16px;line-height:1.78;color:#24334a;background:#f4f8ff;padding:20px 16px;`,
      h1: "font-size:27px;line-height:1.24;font-weight:850;margin:36px 0 24px;color:#102a43;padding:16px 18px;background:#e5f1ff;border-left:6px solid #1677ff;",
      h2: "font-size:20px;line-height:1.4;font-weight:820;margin:42px 0 14px;color:#123c66;padding:10px 12px;background:#e8f5ff;border-bottom:2px solid #36b4d8;",
      h3: "font-size:18px;line-height:1.45;font-weight:800;margin:31px 0 10px;color:#1d5a84;",
      h4: "font-size:17px;line-height:1.5;font-weight:750;margin:25px 0 8px;color:#34708f;",
      p: "margin:12px 0;line-height:1.78;",
      blockquote:
        "margin:21px 0;padding:14px 16px;background:#fff;border:1px solid #cfe1f2;border-left:4px solid #36b4d8;color:#3c5872;",
      ul: "margin:12px 0;padding-left:0;list-style:none;",
      ol: "margin:12px 0;padding-left:22px;",
      li: "margin:8px 0;line-height:1.76;padding:9px 11px;background:#fff;border:1px solid #dce9f6;border-left:3px solid #1677ff;",
      strong: "font-weight:850;color:#102a43;background:#dff4ff;",
      em: "font-style:italic;color:#3c5872;",
      code: `font-family:${MONO};background:#e4efff;color:#1552a0;padding:2px 6px;border-radius:4px;font-size:14px;`,
      pre: "background:#102a43;color:#dff4ff;padding:14px 16px;overflow:auto;font-size:14px;line-height:1.6;border-radius:6px;",
      "pre code": "background:none;padding:0;color:inherit;",
      hr: "border:none;border-top:2px solid #cfe1f2;margin:32px 0;",
      a: "color:#1264c4;text-decoration:none;border-bottom:1px solid #9bc4ef;",
      img: IMG + "border-radius:6px;",
      table: TABLE,
      th: "border:1px solid #cfe1f2;padding:8px 10px;background:#e8f5ff;font-weight:800;text-align:left;color:#123c66;",
      td: "border:1px solid #cfe1f2;padding:8px 10px;",
    },
    dark: {
      ...darkShared("#73c9ff"),
      body: `color:#d8e4f0;background:${DARK.surface};padding:20px 16px;`,
      h1: "color:#e8f5ff;background:#142b43;border-left-color:#4cc9e8;",
      h2: "color:#bfe9ff;background:#152a3c;border-bottom-color:#3b8ca7;",
      h3: "color:#9ed7f4;",
      h4: "color:#83b8d3;",
      blockquote: "background:#14202d;border-color:#3b7186;color:#a9c4d6;",
      li: "background:#14202d;border-color:#243849;border-left-color:#4c9eff;",
      strong: "color:#e8f5ff;background:#19384b;",
      em: "color:#a9c4d6;",
      code: "background:#142b43;color:#73c9ff;",
      pre: "background:#101f30;color:#d8e4f0;",
      "pre code": "color:#d8e4f0;",
      a: "color:#73c9ff;border-bottom-color:#315f78;",
      hr: "border-color:#294252;",
      th: "background:#142b43;border-color:#294252;color:#bfe9ff;",
      td: "border-color:#294252;",
    },
  },
  {
    id: "notes",
    name: "Koinote Notes",
    hint: "知识卡片、教程清单、学习笔记",
    group: "中文公众号",
    exportBodyBackground: false,
    rules: {
      body: `font-family:${SANS};font-size:16px;line-height:1.84;color:#293b34;background:#f4faf6;padding:20px 16px;`,
      h1: "font-size:26px;line-height:1.3;font-weight:850;margin:36px 0 24px;color:#173c2e;text-align:center;padding:14px 12px;border:1px solid #a8d5bd;background:#e6f5eb;border-radius:10px;",
      h2: "font-size:20px;line-height:1.44;font-weight:820;margin:42px 0 14px;color:#1f513d;padding:10px 13px;background:#def1e5;border-radius:7px;",
      h3: "font-size:18px;line-height:1.5;font-weight:800;margin:31px 0 10px;color:#2d694f;",
      h4: "font-size:17px;line-height:1.5;font-weight:750;margin:25px 0 8px;color:#417760;",
      p: "margin:12px 0;line-height:1.84;",
      blockquote:
        "margin:20px 0;padding:14px 16px;background:#fff;border:1px solid #cfe6d7;border-left:4px solid #4caa73;color:#436352;border-radius:6px;",
      ul: "margin:12px 0;padding-left:0;list-style:none;",
      ol: "margin:12px 0;padding-left:22px;",
      li: "margin:8px 0;line-height:1.8;padding:8px 10px;background:#fff;border:1px solid #dceee2;border-radius:5px;",
      strong: "font-weight:850;color:#173c2e;background:#e5f5b8;",
      em: "font-style:italic;color:#436352;",
      code: `font-family:${MONO};background:#e7f3eb;color:#286344;padding:2px 6px;border-radius:4px;font-size:14px;`,
      pre: "background:#173c2e;color:#e3f5e9;padding:14px 16px;overflow:auto;font-size:14px;line-height:1.6;border-radius:7px;",
      "pre code": "background:none;padding:0;color:inherit;",
      hr: "border:none;border-top:1px dashed #a8d5bd;margin:32px 0;",
      a: "color:#28784d;text-decoration:none;border-bottom:1px solid #8bc6a4;",
      img: IMG + "border-radius:7px;",
      table: TABLE,
      th: "border:1px solid #cfe6d7;padding:8px 10px;background:#e6f5eb;font-weight:800;text-align:left;color:#1f513d;",
      td: "border:1px solid #cfe6d7;padding:8px 10px;",
    },
    dark: {
      ...darkShared("#7bd39a"),
      body: `color:#dcebe1;background:${DARK.surface};padding:20px 16px;`,
      h1: "color:#e5f7ea;background:#173c2e;border-color:#4caa73;",
      h2: "color:#c8efd3;background:#19382b;",
      h3: "color:#a4d8b6;",
      h4: "color:#86b99a;",
      blockquote: "background:#15271e;border-color:#3e8e5f;color:#adccb6;",
      li: "background:#15271e;border-color:#294537;",
      strong: "color:#e5f7ea;background:#31452d;",
      em: "color:#adccb6;",
      code: "background:#173c2e;color:#7bd39a;",
      pre: "background:#12271d;color:#dcebe1;",
      "pre code": "color:#dcebe1;",
      a: "color:#7bd39a;border-bottom-color:#356949;",
      hr: "border-color:#315440;",
      th: "background:#173c2e;border-color:#315440;color:#c8efd3;",
      td: "border-color:#315440;",
    },
  },
  {
    id: "pulse",
    name: "Koinote Pulse",
    hint: "活动预告、观点短文、社区通讯",
    group: "推荐默认",
    exportBodyBackground: false,
    rules: {
      body: `font-family:${SANS};font-size:16px;line-height:1.8;color:#34283e;background:#fff7f2;padding:20px 16px;`,
      h1: "font-size:28px;line-height:1.22;font-weight:900;margin:36px 0 24px;color:#fff;padding:18px 16px;background:#34283e;border-left:7px solid #ff6b55;box-shadow:7px 7px 0 #ffd166;",
      h2: "font-size:20px;line-height:1.42;font-weight:850;margin:42px 0 14px;color:#34283e;padding:10px 12px;background:#ffe6d9;border-left:4px solid #ff6b55;",
      h3: "font-size:18px;line-height:1.48;font-weight:820;margin:31px 0 10px;color:#643d61;",
      h4: "font-size:17px;line-height:1.5;font-weight:780;margin:25px 0 8px;color:#76536f;",
      p: "margin:12px 0;line-height:1.8;",
      blockquote:
        "margin:20px 0;padding:15px 16px;background:#34283e;color:#fff3eb;border-left:0;border-radius:7px;",
      ul: "margin:12px 0;padding-left:0;list-style:none;",
      ol: "margin:12px 0;padding-left:22px;",
      li: "margin:8px 0;line-height:1.78;padding:9px 11px;background:#fff;border:1px solid #f2d7c9;border-left:4px solid #ff6b55;border-radius:4px;",
      strong: "font-weight:900;color:#34283e;background:#ffd166;",
      em: "font-style:italic;color:#76536f;",
      code: `font-family:${MONO};background:#f4ded5;color:#8f3f32;padding:2px 6px;border-radius:4px;font-size:14px;`,
      pre: "background:#34283e;color:#ffe6d9;padding:14px 16px;overflow:auto;font-size:14px;line-height:1.6;border-radius:7px;",
      "pre code": "background:none;padding:0;color:inherit;",
      hr: "border:none;height:3px;background:#ff6b55;margin:32px 0;width:64%;",
      a: "color:#b23a48;text-decoration:none;border-bottom:2px solid #ffb5a5;",
      img: IMG + "border-radius:7px;",
      table: TABLE,
      th: "border:1px solid #f2d7c9;padding:8px 10px;background:#ffe6d9;font-weight:850;text-align:left;color:#643d61;",
      td: "border:1px solid #f2d7c9;padding:8px 10px;",
    },
    dark: {
      ...darkShared("#ff9b87"),
      body: `color:#eee0e8;background:${DARK.surface};padding:20px 16px;`,
      h1: "color:#fff3eb;background:#34283e;border-left-color:#ff8874;box-shadow:7px 7px 0 #8e6f2f;",
      h2: "color:#ffe2d5;background:#3a2733;border-left-color:#ff8874;",
      h3: "color:#e2b3d5;",
      h4: "color:#c89fbe;",
      blockquote: "background:#34283e;color:#ffe6d9;",
      li: "background:#1d191f;border-color:#3d303b;border-left-color:#ff8874;",
      strong: "color:#34283e;background:#e5b85b;",
      em: "color:#c89fbe;",
      code: "background:#34283e;color:#ff9b87;",
      pre: "background:#241b2b;color:#ffe0d2;",
      "pre code": "color:#ffe0d2;",
      a: "color:#ff9b87;border-bottom-color:#70413c;",
      hr: "background:#ff8874;",
      th: "background:#34283e;border-color:#4b3548;color:#ffe2d5;",
      td: "border-color:#4b3548;",
    },
  },
];

export function findWechatTheme(id: string): WechatTheme {
  return WECHAT_THEMES.find((theme) => theme.id === id) ?? WECHAT_THEMES[0];
}

/** 返回当前语言的主题名称；未知语言条目回退到主题内置名称。 */
export function getWechatThemeLabel(
  id: string,
  localizedNames?: Readonly<Record<string, string>>,
): string {
  const theme = findWechatTheme(id);
  return localizedNames?.[id] ?? theme.name;
}

/** 按分组归类，供选择器分栏渲染。空分组不返回。 */
export function groupWechatThemes(): {
  group: WechatThemeGroup;
  themes: WechatTheme[];
}[] {
  return WECHAT_THEME_GROUPS.map((group) => ({
    group,
    themes: WECHAT_THEMES.filter((theme) => theme.group === group),
  })).filter((entry) => entry.themes.length > 0);
}
