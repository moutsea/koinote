/**
 * 微信公众号主题，15 套。
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
 *      不起作用。padding 只给背景非纯白的主题保留（verge / stripe / ft /
 *      linear / notion），让染色面板有留白；纯白背景的主题留着 padding 只会
 *      把正文往里缩，和微信自身的边距叠成双重缩进。
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
  | "event";

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

export type WechatTheme = {
  id: WechatThemeId;
  /** 主题名，四语言共用 —— 风格名不翻译，译了反而认不出 */
  name: string;
  /** 一句话说明适用场景 */
  hint: string;
  group: WechatThemeGroup;
  rules: WechatThemeRules;
};

const SANS =
  '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';
const SERIF =
  'Georgia,"Times New Roman","Songti SC","Noto Serif CJK SC",SimSun,serif';
const SONGTI = '"Songti SC","Noto Serif CJK SC",Georgia,"Times New Roman",SimSun,serif';
const MONO = '"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace';

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
  },
  {
    id: "verge",
    name: "The Verge Briefing",
    hint: "热点解读、产品更新、资讯评论",
    group: "经典媒体",
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
  },
  {
    id: "stripe",
    name: "Stripe Docs",
    hint: "教程、工具说明、Agent 工作流文档",
    group: "科技产品",
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
  },
  {
    id: "ft",
    name: "FT Analysis",
    hint: "商业分析、市场判断、对标研究",
    group: "经典媒体",
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
  },
  {
    id: "linear",
    name: "Linear Changelog",
    hint: "版本公告、功能更新、路线图说明",
    group: "科技产品",
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
  },
  {
    id: "notion",
    name: "Notion Memo",
    hint: "学习笔记、内部总结、项目复盘",
    group: "科技产品",
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
  },
];

export function findWechatTheme(id: string): WechatTheme {
  return WECHAT_THEMES.find((theme) => theme.id === id) ?? WECHAT_THEMES[0];
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
