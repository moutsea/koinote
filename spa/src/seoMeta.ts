// 公开页面的 title / description，前端路由切换与 Worker 边缘渲染共用这一份，
// 避免两边各写一套、改了一边另一边静默过期。
// 只依赖 i18n 的类型，不碰 window/document，Worker 里也能直接引用。
import type { Locale, Messages } from "./i18n/types";

export type PublicPage =
  | "home"
  | "pricing"
  | "docs"
  | "mcpGuide"
  | "versionGuide"
  | "aiGuide"
  | "aiCase"
  | "wechatGuide"
  | "changelog"
  | "privacy"
  | "terms"
  | "cookies"
  | "repositories";

export const PUBLIC_PAGE_PATHS: Record<PublicPage, string> = {
  home: "/",
  pricing: "/pricing",
  docs: "/docs",
  mcpGuide: "/docs/mcp",
  versionGuide: "/docs/version-history",
  aiGuide: "/docs/ai-optimization",
  aiCase: "/docs/ai-optimization/case",
  wechatGuide: "/docs/wechat-official-account",
  changelog: "/changelog",
  privacy: "/privacy",
  terms: "/terms",
  cookies: "/cookies",
  repositories: "/repositories",
};

const PAGE_BY_PATH = new Map(
  Object.entries(PUBLIC_PAGE_PATHS).map(([page, path]) => [path, page as PublicPage]),
);

export function publicPageForPath(pathname: string): PublicPage | null {
  return PAGE_BY_PATH.get(pathname) ?? null;
}

/** 首页标题里的品类词。搜索词靠它命中，i18n 里没有现成的短语。 */
export const SITE_TAGLINE: Record<Locale, string> = {
  zh: "在线 Markdown 编辑器",
  en: "Online Markdown Editor",
  fr: "Éditeur Markdown en ligne",
  ja: "オンライン Markdown エディタ",
};

/** <html lang> 与 hreflang 使用的 BCP 47 代码 */
export const HTML_LANG: Record<Locale, string> = {
  zh: "zh-CN",
  en: "en",
  fr: "fr",
  ja: "ja",
};

export function defaultSiteTitle(locale: Locale): string {
  return `Koinote — ${SITE_TAGLINE[locale]}`;
}

/** 404 页标题。Worker 返回 404 时与前端 NotFoundPage 用同一个 */
export function notFoundTitle(t: Messages): string {
  return `${t.notFound.title} — Koinote`;
}

/** /repositories/$id 的标题。Worker 首屏与仓库页 JS 接管后必须一致 */
export function repositoryPageTitle(name: string, t: Messages): string {
  return `${name} — ${t.agentWorkspace.publicRepositories} — Koinote`;
}

/**
 * 标题和描述由页面组件按数据自己设置的路由（分享页、仓库详情页）。AppShell 的统一
 * 同步不碰这两项，只更新 canonical。这两类页面的 canonical 不带 lang，与 Worker 一致：
 * 正文是用户写的，不随界面语言变。
 */
export function pageOwnsMeta(pathname: string): boolean {
  return /^\/share\/[^/]+$/.test(pathname) || /^\/repositories\/\d+$/.test(pathname);
}

/** 搜索结果摘要通常截在 150–160 字符左右，超出部分直接被省略 */
export function clipDescription(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function page(name: string, headline: string | null, description: string) {
  return {
    title: `${headline ? `${name} · ${headline}` : name} — Koinote`,
    description: clipDescription(description),
  };
}

export function publicPageMeta(
  target: PublicPage,
  t: Messages,
  locale: Locale,
): { title: string; description: string } {
  switch (target) {
    case "home":
      return { title: defaultSiteTitle(locale), description: clipDescription(t.home.subtitle) };
    case "pricing":
      return page(t.footer.pricing, null, t.pricing.subtitle);
    case "docs":
      return page(t.footer.docsCenter, t.docsCenter.title, t.docsCenter.subtitle);
    case "mcpGuide":
      return page(t.footer.mcpGuide, t.mcpGuide.title, t.mcpGuide.subtitle);
    case "versionGuide":
      return page(t.footer.versionHistoryGuide, t.versionGuide.title, t.versionGuide.subtitle);
    case "aiGuide":
      return page(t.footer.aiGuide, t.aiGuide.title, t.aiGuide.subtitle);
    case "aiCase":
      return page(t.aiGuide.caseOriginalTitle, null, t.aiGuide.caseOriginalDescription);
    case "wechatGuide":
      return page(t.wechatGuide.eyebrow, t.wechatGuide.title, t.wechatGuide.subtitle);
    case "changelog":
      return page(t.changelog.title, null, t.changelog.subtitle);
    case "privacy":
    case "terms":
    case "cookies":
      return page(t.legal[target].title, null, t.legal[target].summary);
    case "repositories":
      return page(
        t.agentWorkspace.publicRepositories,
        t.agentWorkspace.hubEyebrow,
        t.agentWorkspace.hubIntro,
      );
  }
}
