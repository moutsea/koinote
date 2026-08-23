import {
  WECHAT_SYSTEM_FONT_STACK,
  type WechatThemeRules,
} from "./wechatThemes";

export const WECHAT_EXPORT_TYPOGRAPHY = Object.freeze({
  fontFamily: WECHAT_SYSTEM_FONT_STACK,
  bodyFontSize: "15px",
  bodyLineHeight: "1.7",
  letterSpacing: "0.5px",
  paragraphMargin: "16px 0",
  h1FontSize: "20px",
  h2FontSize: "18px",
  h3FontSize: "17px",
  h4FontSize: "16px",
});

function appendDeclarations(source: string, declarations: string): string {
  const separator = source.length > 0 && !source.trimEnd().endsWith(";") ? ";" : "";
  return `${source}${separator}${declarations}`;
}

export function normalizeWechatExportRules(
  rules: WechatThemeRules,
): WechatThemeRules {
  const typography = WECHAT_EXPORT_TYPOGRAPHY;
  const readingLineHeight = `line-height:${typography.bodyLineHeight};`;
  const neutralLetterSpacing = "letter-spacing:0;";

  return {
    ...rules,
    body: appendDeclarations(
      rules.body,
      `font-family:${typography.fontFamily};font-size:${typography.bodyFontSize};${readingLineHeight}letter-spacing:${typography.letterSpacing};`,
    ),
    h1: appendDeclarations(rules.h1, `font-size:${typography.h1FontSize};`),
    h2: appendDeclarations(rules.h2, `font-size:${typography.h2FontSize};`),
    h3: appendDeclarations(rules.h3, `font-size:${typography.h3FontSize};`),
    h4: appendDeclarations(rules.h4 ?? "", `font-size:${typography.h4FontSize};`),
    p: appendDeclarations(
      rules.p,
      `margin:${typography.paragraphMargin};${readingLineHeight}`,
    ),
    blockquote: appendDeclarations(rules.blockquote, readingLineHeight),
    li: appendDeclarations(rules.li, readingLineHeight),
    code: appendDeclarations(rules.code, neutralLetterSpacing),
    pre: appendDeclarations(rules.pre, neutralLetterSpacing),
    "pre code": appendDeclarations(rules["pre code"], neutralLetterSpacing),
    table: appendDeclarations(rules.table, neutralLetterSpacing),
  };
}
