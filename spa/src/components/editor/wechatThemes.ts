/**
 * 微信公众号主题。
 *
 * 为什么是「标签名 → 声明串」而不是 CSS 文本：
 * 微信编辑器会剥掉 <style> 标签和 class 选择器，样式必须内联到每个元素的
 * style 属性上。既然最终只能按标签查表，就直接以这个形态存，省掉一道 CSS
 * 解析（keepask 那边是从 markdown 里正则抽 CSS 再拍平，多一层容易出错的环节）。
 *
 * 因此有两条硬限制，设计主题时必须避开：
 *   1. 伪元素用不了。keepask 的主题里有 h2:before{content:""} 这类装饰条，
 *      内联时会被静默丢掉 —— 在微信里根本不出现。这里的主题不依赖伪元素。
 *   2. 后代选择器只支持 pre code 一种特例（代码块内的 code 与行内 code 不同）。
 */

export type WechatThemeId =
  | "minimal"
  | "serif"
  | "tech"
  | "warm"
  | "newspaper";

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
  rules: WechatThemeRules;
};

const SANS =
  '-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';
const SERIF =
  'Georgia,"Times New Roman","Songti SC","Noto Serif CJK SC",SimSun,serif';
const MONO = '"SFMono-Regular",Consolas,"Liberation Mono",Menlo,monospace';

/** 表格与图片的公共部分：微信里宽度必须收在容器内，否则会溢出 */
const SHARED = {
  img: "max-width:100%;height:auto;display:block;margin:18px auto;border-radius:4px;",
  table:
    "border-collapse:collapse;width:100%;margin:18px 0;font-size:14px;line-height:1.6;",
};

export const WECHAT_THEMES: WechatTheme[] = [
  {
    id: "minimal",
    name: "极简黑白",
    hint: "默认款，深度长文与方法论",
    rules: {
      body: `font-family:${SANS};font-size:16px;line-height:1.82;color:#2b2b2b;background:#fff;`,
      h1: "font-size:24px;line-height:1.35;font-weight:800;margin:34px 0 24px;color:#111;padding-bottom:16px;border-bottom:1px solid #111;",
      h2: "font-size:19px;line-height:1.45;font-weight:800;margin:42px 0 14px;color:#111;border-left:4px solid #111;padding-left:10px;",
      h3: "font-size:17px;line-height:1.5;font-weight:700;margin:30px 0 10px;color:#222;",
      h4: "font-size:16px;line-height:1.5;font-weight:700;margin:24px 0 8px;color:#333;",
      p: "margin:12px 0;line-height:1.82;",
      blockquote:
        "margin:20px 0;padding:13px 16px;border-left:3px solid #111;background:#f7f7f7;color:#555;",
      ul: "margin:12px 0;padding-left:20px;",
      ol: "margin:12px 0;padding-left:20px;",
      li: "margin:7px 0;line-height:1.82;",
      strong: "font-weight:800;color:#111;",
      em: "font-style:italic;color:#333;",
      code: `font-family:${MONO};background:#f2f2f2;color:#111;padding:2px 6px;border-radius:3px;font-size:14px;`,
      pre: "background:#f2f2f2;color:#111;padding:14px 16px;overflow:auto;font-size:14px;line-height:1.6;border-radius:4px;",
      "pre code": "background:none;padding:0;color:#111;font-size:14px;",
      hr: "border:none;border-top:1px solid #e0e0e0;margin:32px 0;",
      a: "color:#576b95;text-decoration:none;",
      ...SHARED,
      th: "border:1px solid #ddd;padding:8px 10px;background:#f5f5f5;font-weight:700;text-align:left;",
      td: "border:1px solid #ddd;padding:8px 10px;",
    },
  },
  {
    id: "serif",
    name: "杂志衬线",
    hint: "人物稿、品牌故事、深度专题",
    rules: {
      body: `font-family:${SERIF};font-size:16px;line-height:1.94;color:#282828;background:#fff;`,
      h1: "font-size:27px;line-height:1.3;font-weight:700;text-align:center;margin:42px 0 30px;color:#111;",
      h2: "font-size:21px;line-height:1.45;font-weight:700;margin:46px 0 18px;color:#111;text-align:center;",
      h3: "font-size:18px;line-height:1.5;font-weight:700;margin:34px 0 12px;color:#333;text-align:center;",
      h4: "font-size:17px;line-height:1.5;font-weight:700;margin:26px 0 10px;color:#444;text-align:center;",
      p: "margin:15px 0;line-height:1.94;",
      blockquote:
        "margin:26px 0;padding:0 22px;color:#555;font-size:15px;line-height:1.95;text-align:center;font-style:italic;",
      ul: "margin:15px 0;padding-left:22px;",
      ol: "margin:15px 0;padding-left:22px;",
      li: "margin:8px 0;line-height:1.92;",
      strong: "font-weight:800;color:#111;",
      em: "font-style:italic;color:#444;",
      code: `font-family:${MONO};background:#f3f3f3;color:#222;padding:2px 6px;border-radius:2px;font-size:14px;`,
      pre: "background:#f3f3f3;color:#222;padding:14px 16px;overflow:auto;font-size:14px;line-height:1.6;border-radius:2px;",
      "pre code": "background:none;padding:0;color:#222;font-size:14px;",
      hr: "border:none;border-top:1px solid #bdbdbd;margin:36px auto;width:46%;",
      a: "color:#576b95;text-decoration:underline;",
      ...SHARED,
      th: "border:1px solid #d5d5d5;padding:8px 10px;background:#fafafa;font-weight:700;text-align:left;",
      td: "border:1px solid #d5d5d5;padding:8px 10px;",
    },
  },
  {
    id: "tech",
    name: "科技蓝",
    hint: "技术分享、产品发布、教程",
    rules: {
      body: `font-family:${SANS};font-size:16px;line-height:1.78;color:#1f2328;background:#fff;`,
      h1: "font-size:25px;line-height:1.3;font-weight:800;margin:34px 0 22px;color:#0b62d0;padding-bottom:14px;border-bottom:2px solid #0b62d0;",
      h2: "font-size:20px;line-height:1.4;font-weight:800;margin:40px 0 14px;color:#0b62d0;border-left:5px solid #0b62d0;padding-left:11px;",
      h3: "font-size:17px;line-height:1.5;font-weight:700;margin:28px 0 10px;color:#24405c;",
      h4: "font-size:16px;line-height:1.5;font-weight:700;margin:22px 0 8px;color:#3a5a78;",
      p: "margin:13px 0;line-height:1.78;",
      blockquote:
        "margin:20px 0;padding:13px 16px;border-left:4px solid #0b62d0;background:#f0f6fd;color:#3a4a5a;",
      ul: "margin:13px 0;padding-left:20px;",
      ol: "margin:13px 0;padding-left:20px;",
      li: "margin:7px 0;line-height:1.78;",
      strong: "font-weight:800;color:#0b62d0;",
      em: "font-style:italic;color:#3a4a5a;",
      code: `font-family:${MONO};background:#eef3f9;color:#0b62d0;padding:2px 6px;border-radius:3px;font-size:14px;`,
      pre: "background:#0f172a;color:#d6e2f0;padding:15px 17px;overflow:auto;font-size:13px;line-height:1.62;border-radius:6px;",
      "pre code": "background:none;padding:0;color:#d6e2f0;font-size:13px;",
      hr: "border:none;border-top:1px solid #d8e2ee;margin:32px 0;",
      a: "color:#0b62d0;text-decoration:none;",
      ...SHARED,
      th: "border:1px solid #d8e2ee;padding:8px 10px;background:#f0f6fd;font-weight:700;text-align:left;color:#24405c;",
      td: "border:1px solid #d8e2ee;padding:8px 10px;",
    },
  },
  {
    id: "warm",
    name: "暖阳橙",
    hint: "生活随笔、读书笔记、活动公告",
    rules: {
      body: `font-family:${SANS};font-size:16px;line-height:1.86;color:#3a3226;background:#fff;`,
      h1: "font-size:24px;line-height:1.35;font-weight:800;margin:34px 0 22px;color:#c2560f;padding-bottom:14px;border-bottom:2px dashed #e8a06a;",
      h2: "font-size:19px;line-height:1.45;font-weight:800;margin:40px 0 14px;color:#c2560f;background:#fdf1e6;padding:9px 12px;border-radius:4px;",
      h3: "font-size:17px;line-height:1.5;font-weight:700;margin:28px 0 10px;color:#8a4513;",
      h4: "font-size:16px;line-height:1.5;font-weight:700;margin:22px 0 8px;color:#9a5a2a;",
      p: "margin:13px 0;line-height:1.86;",
      blockquote:
        "margin:20px 0;padding:13px 16px;border-left:4px solid #e8a06a;background:#fdf7f1;color:#6a5643;",
      ul: "margin:13px 0;padding-left:20px;",
      ol: "margin:13px 0;padding-left:20px;",
      li: "margin:8px 0;line-height:1.86;",
      strong: "font-weight:800;color:#c2560f;",
      em: "font-style:italic;color:#6a5643;",
      code: `font-family:${MONO};background:#fdf1e6;color:#a8460c;padding:2px 6px;border-radius:3px;font-size:14px;`,
      pre: "background:#fdf7f1;color:#4a3a2a;padding:14px 16px;overflow:auto;font-size:14px;line-height:1.6;border-radius:6px;",
      "pre code": "background:none;padding:0;color:#4a3a2a;font-size:14px;",
      hr: "border:none;border-top:1px dashed #e8c4a0;margin:32px 0;",
      a: "color:#c2560f;text-decoration:none;",
      ...SHARED,
      th: "border:1px solid #ecd9c6;padding:8px 10px;background:#fdf1e6;font-weight:700;text-align:left;color:#8a4513;",
      td: "border:1px solid #ecd9c6;padding:8px 10px;",
    },
  },
  {
    id: "newspaper",
    name: "报刊正文",
    hint: "评论、时事分析、信息密度高的稿件",
    rules: {
      body: `font-family:${SERIF};font-size:16px;line-height:1.8;color:#1a1a1a;background:#fff;`,
      h1: "font-size:26px;line-height:1.25;font-weight:800;margin:32px 0 8px;color:#000;border-bottom:3px double #000;padding-bottom:12px;",
      h2: "font-size:19px;line-height:1.4;font-weight:800;margin:36px 0 12px;color:#000;",
      h3: "font-size:17px;line-height:1.45;font-weight:700;margin:26px 0 8px;color:#1a1a1a;",
      h4: "font-size:16px;line-height:1.45;font-weight:700;margin:20px 0 6px;color:#2a2a2a;",
      p: "margin:11px 0;line-height:1.8;text-align:justify;",
      blockquote:
        "margin:18px 0;padding:10px 14px;border-left:2px solid #666;background:#f6f6f6;color:#444;font-size:15px;",
      ul: "margin:11px 0;padding-left:20px;",
      ol: "margin:11px 0;padding-left:20px;",
      li: "margin:5px 0;line-height:1.78;",
      strong: "font-weight:800;color:#000;",
      em: "font-style:italic;color:#333;",
      code: `font-family:${MONO};background:#eee;color:#111;padding:1px 5px;font-size:14px;`,
      pre: "background:#f6f6f6;color:#111;padding:13px 15px;overflow:auto;font-size:13px;line-height:1.58;border:1px solid #ddd;",
      "pre code": "background:none;padding:0;color:#111;font-size:13px;",
      hr: "border:none;border-top:1px solid #999;margin:28px 0;",
      a: "color:#333;text-decoration:underline;",
      ...SHARED,
      th: "border:1px solid #999;padding:7px 9px;background:#eee;font-weight:700;text-align:left;",
      td: "border:1px solid #999;padding:7px 9px;",
    },
  },
];

export function findWechatTheme(id: string): WechatTheme {
  return WECHAT_THEMES.find((theme) => theme.id === id) ?? WECHAT_THEMES[0];
}
