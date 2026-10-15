/**
 * 搜索引擎相关的边缘渲染。
 *
 * SPA 的 index.html 只有一个空 <div id="root">：不执行 JS 的爬虫（Bing、
 * 各类 AI 爬虫、社交卡片抓取）看到的每个 URL 都是同一个空壳，Google 也要排进
 * 渲染队列才看得到内容。这里在 Worker 出口按路由补上：
 *
 *   · 公开页：独立的 title / description / canonical / hreflang / OG，
 *     以及一份由 i18n 文案生成的静态正文（React 挂载时会整体替换掉它）
 *   · 应用页（编辑器、设置等）：x-robots-tag: noindex
 *   · 未知路径：仍返回 SPA，但状态码是 404，避免软 404 被当成首页的重复内容
 *   · /robots.txt 与 /sitemap.xml
 *
 * 语言：?lang=zh|en|fr|ja 是各语言的固定地址（hreflang 指向它们）；
 * 不带参数的地址是 x-default，按 Accept-Language 选语言，与前端
 * detectLocale 的规则保持一致，渲染结果才不会和 JS 接管后的页面打架。
 */
import { en } from "../spa/src/i18n/en";
import { fr } from "../spa/src/i18n/fr";
import { ja } from "../spa/src/i18n/ja";
import { zh } from "../spa/src/i18n/zh";
import { LOCALES, type Locale, type Messages } from "../spa/src/i18n/types";
import {
  HTML_LANG,
  PUBLIC_PAGE_PATHS,
  publicPageForPath,
  notFoundTitle,
  publicPageMeta,
  repositoryPageTitle,
  SITE_TAGLINE,
  clipDescription,
  type PublicPage,
} from "../spa/src/seoMeta";
import {
  DEFAULT_FREE_STORAGE_QUOTA_BYTES,
  DEFAULT_LIFETIME_STORAGE_QUOTA_BYTES,
} from "../spa/src/billingCore";
import { CASE_ORIGINAL_MARKDOWN } from "../spa/src/aiOptimizationCase";
import { parseChangelog } from "../spa/src/changelogCore";
import { formatBytes } from "../spa/src/storage";
import { SEO_GUARD_SCRIPT } from "./seoGuard";
// 测试直接核对脚本与 CSP 哈希
export { SEO_GUARD_SCRIPT, SEO_GUARD_SCRIPT_HASH } from "./seoGuard";
// wrangler.jsonc 的 rules 把 .md 当文本模块打包；与前端 ChangelogPage 读同一份文件
import changelogEnglish from "../CHANGELOG.md";
import changelogFrench from "../CHANGELOG.fr.md";
import changelogJapanese from "../CHANGELOG.ja.md";
import changelogChinese from "../CHANGELOG.zh.md";

export interface SeoEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  BACKEND_URL: string;
  BACKEND_INTERNAL_TOKEN?: string;
}

const MESSAGES: Record<Locale, Messages> = { en, zh, fr, ja };
const CHANGELOGS: Record<Locale, { markdown: string; file: string }> = {
  en: { markdown: changelogEnglish, file: "CHANGELOG.md" },
  zh: { markdown: changelogChinese, file: "CHANGELOG.zh.md" },
  fr: { markdown: changelogFrench, file: "CHANGELOG.fr.md" },
  ja: { markdown: changelogJapanese, file: "CHANGELOG.ja.md" },
};
/** 静态正文只放最近几个版本：够爬虫理解页面，又不至于把 HTML 撑到几百 KB */
const CHANGELOG_RELEASES = 8;
const OG_IMAGE_PATH = "/og-image.png";
/** 这些页面以前是纯静态资源，后端慢时宁可少一段正文，也不能拖住首字节 */
const BACKEND_TIMEOUT_MS = 1500;
/** sitemap 的仓库清单是一次性取全量，数据比页面正文多，超时放宽一些 */
const SITEMAP_BACKEND_TIMEOUT_MS = 3000;
/** 价格接口后端自己声明了 max-age=300，isolate 内按同样时长复用 */
const PRICING_CACHE_MS = 5 * 60 * 1000;

// ── 路由分类 ────────────────────────────────────────────────────────────

/**
 * 需要登录或只对本人有意义的页面。与 spa/src/main.tsx 的路由表对应，
 * scripts/_check_seo.mjs 会逐条核对，新增路由漏登记会让测试失败。
 */
// 不区分大小写：前端路由默认 caseSensitive: false，/Editor 照样能打开编辑器，
// 这里若判成 404 就会出现"状态码 404、页面却正常"的错配
const APP_ROUTES: RegExp[] = [
  /^\/editor(?:\/[^/]+)?$/i,
  /^\/login$/i,
  /^\/register$/i,
  /^\/desktop\/authorize$/i,
  /^\/billing\/desktop-return$/i,
  /^\/dashboard$/i,
  /^\/settings$/i,
  /^\/space$/i,
  /^\/space\/settings$/i,
  /^\/agent\/settings$/i,
  /^\/agent\/workspaces$/i,
  /^\/agent\/workspaces\/[^/]+$/i,
  /^\/ai-settings$/i,
  /^\/mcp\/activity$/i,
  /^\/documents$/i,
  /^\/trash$/i,
  /^\/invitations$/i,
  /^\/admin$/i,
  // 合法分享链接（32 位 hex）由 index.ts 的分享页处理器接管；
  // 落到这里的是格式不对的链接，交给前端显示错误即可，同样不收录
  /^\/share\/[^/]+$/i,
];

export type RouteKind =
  | { kind: "public"; page: PublicPage }
  | { kind: "repository"; id: string }
  | { kind: "app" };

export function classifyPath(pathname: string): RouteKind | null {
  const page = publicPageForPath(pathname.toLowerCase());
  if (page) return { kind: "public", page };
  // 前导零（/repositories/007）与 /7 是同一个仓库；0 不是合法 ID
  const repository = /^\/repositories\/0*([1-9]\d{0,14})$/i.exec(pathname);
  if (repository) return { kind: "repository", id: repository[1] };
  if (APP_ROUTES.some((pattern) => pattern.test(pathname))) return { kind: "app" };
  return null;
}

/**
 * 同一页面的规范路径：公开页与仓库页统一成小写、去掉前导零。应用页保持原样，
 * 编辑器的文档 ID 等参数可能区分大小写，不能替用户改。
 */
function canonicalPathFor(route: RouteKind, pathname: string): string {
  if (route.kind === "public") return PUBLIC_PAGE_PATHS[route.page];
  if (route.kind === "repository") return `/repositories/${route.id}`;
  return pathname;
}

// ── 语言 ───────────────────────────────────────────────────────────────

export function requestedLocale(url: URL): Locale | null {
  const value = url.searchParams.get("lang");
  return value && (LOCALES as readonly string[]).includes(value) ? (value as Locale) : null;
}

/** 与 spa/src/i18n/index.tsx 的 detectLocale 同一套规则：zh/fr/ja 前缀，其余 en */
export function acceptLanguageLocale(header: string | null): Locale {
  const ranked = (header ?? "")
    .split(",")
    .map((part, index) => {
      const [tag, ...params] = part.trim().toLowerCase().split(";");
      const q = params.find((p) => p.trim().startsWith("q="));
      const weight = q ? Number(q.trim().slice(2)) : 1;
      return { tag, weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((item) => item.tag && item.weight > 0)
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  const first = ranked[0]?.tag ?? "";
  if (first.startsWith("zh")) return "zh";
  if (first.startsWith("fr")) return "fr";
  if (first.startsWith("ja")) return "ja";
  return "en";
}

// ── HTML 工具 ──────────────────────────────────────────────────────────

export function escapeHTML(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** JSON-LD 里出现 </script> 会提前闭合标签，统一转义尖括号 */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

const p = (text: string) => `<p>${escapeHTML(text)}</p>`;
const h1 = (text: string) => `<h1>${escapeHTML(text)}</h1>`;
const ul = (items: string[]) =>
  items.length ? `<ul>${items.map((item) => `<li>${escapeHTML(item)}</li>`).join("")}</ul>` : "";
const ol = (items: string[]) =>
  items.length ? `<ol>${items.map((item) => `<li>${escapeHTML(item)}</li>`).join("")}</ol>` : "";
const titled = (items: Array<{ title: string; desc: string }>) =>
  `<ul>${items
    .map((item) => `<li><strong>${escapeHTML(item.title)}</strong> — ${escapeHTML(item.desc)}</li>`)
    .join("")}</ul>`;
function section(title: string, ...content: string[]): string {
  return `<section><h2>${escapeHTML(title)}</h2>${content.join("")}</section>`;
}
function link(href: string, text: string): string {
  return `<a href="${escapeHTML(href)}">${escapeHTML(text)}</a>`;
}
/** 更新日志条目里只有行内代码一种标记，与 ChangelogPage 的 InlineEntry 对应 */
function inlineEntry(text: string): string {
  return text
    .split(/(`[^`\n]+`)/g)
    .map((part) =>
      part.length > 1 && part.startsWith("`") && part.endsWith("`")
        ? `<code>${escapeHTML(part.slice(1, -1))}</code>`
        : escapeHTML(part),
    )
    .join("");
}
/** 后端字段按字符串用之前先确认类型：null 或数字进到 escapeHTML 会直接抛错 */
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
/** 案例原文只有段落、行内代码和整行图片三种写法 */
function markdownBlocks(markdown: string): string {
  return markdown
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const image = /^!\[([^\]]*)\]\((https:\/\/[^)\s]+)\)$/.exec(block);
      if (image) {
        return `<p><img src="${escapeHTML(image[2])}" alt="${escapeHTML(image[1])}" loading="lazy"></p>`;
      }
      return `<p>${inlineEntry(block)}</p>`;
    })
    .join("");
}
function positiveBytes(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

// 静态正文只在 JS 接管前显示一瞬间，样式按站点的宣纸/焦墨配色简单排一下，
// 不依赖 Tailwind 类名（不在源码里的类不会被打进 CSS）。CSP 允许内联 style。
// 不跟随 prefers-color-scheme：JS 执行前 <html> 还没有 .dark，页面背景是浅色宣纸，
// 这里若切成浅色文字会在浅底上几乎看不见。
const STATIC_STYLE = `<style>
      .seo-static{box-sizing:border-box;max-width:760px;margin:0 auto;padding:48px 20px 64px;color:#1f2328;font:16px/1.75 system-ui,-apple-system,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
      .seo-static h1{font:600 2rem/1.3 "Songti SC","STSong",serif;margin:0 0 .75rem}
      .seo-static h2{font:600 1.25rem/1.4 "Songti SC","STSong",serif;margin:2rem 0 .5rem}
      .seo-static p,.seo-static li{color:#41464d}
      .seo-static a{color:#b33a2b}
      .seo-static nav ul{display:flex;flex-wrap:wrap;gap:.25rem 1rem;padding:0;list-style:none;font-size:.875rem}
      .seo-static img{max-width:100%;height:auto}
      .seo-locale-mismatch .seo-static{visibility:hidden}
    </style>`;

/** 写在静态正文前面：浏览器解析 body 之前就决定要不要把它藏起来（见 seoGuard.ts） */
const STATIC_HEAD = `<script>${SEO_GUARD_SCRIPT}</script>\n    ${STATIC_STYLE}`;

// ── 页面正文 ───────────────────────────────────────────────────────────

type RenderContext = {
  t: Messages;
  locale: Locale;
  explicitLocale: boolean;
  origin: string;
  env: SeoEnv;
  request: Request;
};

/** 站内链接：显式指定了语言就沿用，爬虫顺着链接才能爬完同一语言的整站 */
function localHref(ctx: RenderContext, path: string): string {
  return ctx.explicitLocale ? `${path}?lang=${ctx.locale}` : path;
}

function siteNav(ctx: RenderContext): string {
  const { t } = ctx;
  const entries: Array<[PublicPage, string]> = [
    ["home", t.footer.home],
    ["pricing", t.footer.pricing],
    ["docs", t.footer.docsCenter],
    ["mcpGuide", t.footer.mcpGuide],
    ["versionGuide", t.footer.versionHistoryGuide],
    ["aiGuide", t.footer.aiGuide],
    ["wechatGuide", t.wechatGuide.eyebrow],
    ["repositories", t.agentWorkspace.publicRepositories],
    ["changelog", t.footer.changelog],
    ["privacy", t.footer.privacy],
    ["terms", t.footer.terms],
    ["cookies", t.footer.cookies],
  ];
  return `<nav><ul>${entries
    .map(([page, label]) => `<li>${link(localHref(ctx, PUBLIC_PAGE_PATHS[page]), label)}</li>`)
    .join("")}</ul></nav>`;
}

async function pageBody(page: PublicPage, ctx: RenderContext): Promise<string> {
  const { t } = ctx;
  switch (page) {
    case "home":
      return [
        p(t.home.badge),
        h1(t.home.title),
        p(t.home.subtitle),
        titled(t.home.features),
        section(t.home.mcp.title, p(t.home.mcp.description), titled(t.home.mcp.steps)),
        `<p>${link("/editor", t.home.ctaStart)} · ${link("/download", t.home.ctaDownload)}</p>`,
      ].join("");
    case "pricing": {
      // 容量的真值在后端，与前端价格页读同一个接口；读不到时用同一组兜底常量
      const quota = await pricingQuota(ctx);
      const free = {
        storage: formatBytes(positiveBytes(quota?.freeStorageQuotaBytes) ?? DEFAULT_FREE_STORAGE_QUOTA_BYTES, ctx.locale),
      };
      const lifetime = {
        storage: formatBytes(
          positiveBytes(quota?.lifetimeStorageQuotaBytes) ?? DEFAULT_LIFETIME_STORAGE_QUOTA_BYTES,
          ctx.locale,
        ),
      };
      return [
        h1(t.pricing.title),
        p(t.pricing.subtitle),
        section(
          `${t.pricing.freeName} · ${t.pricing.freePrice}`,
          p(t.pricing.freeDescription),
          ul(t.pricing.freeFeatures.map((item) => fill(item, free))),
        ),
        section(
          `${t.pricing.lifetimeName} · ${t.pricing.lifetimePeriod}`,
          p(t.pricing.lifetimeDescription),
          ul(t.pricing.lifetimeFeatures.map((item) => fill(item, lifetime))),
        ),
        section(t.pricing.creditsTitle, p(t.pricing.creditsDescription), p(t.pricing.creditsNote)),
        section(
          t.pricing.faqTitle,
          ...t.pricing.faqs.map((faq) => `<h3>${escapeHTML(faq.question)}</h3>${p(faq.answer)}`),
        ),
      ].join("");
    }
    case "docs": {
      const d = t.docsCenter;
      return [
        h1(d.title),
        p(d.subtitle),
        section(d.quickStartTitle, titled(d.quickStartSteps)),
        section(
          d.workflowsTitle,
          ...d.workflows.map((w) => `<h3>${escapeHTML(w.title)}</h3>${p(w.desc)}${ul(w.items)}`),
        ),
        section(d.modesTitle, p(d.modesSubtitle), titled(d.modes)),
        section(
          d.deepDiveTitle,
          `<ul>${[
            [PUBLIC_PAGE_PATHS.aiGuide, d.aiTitle, d.aiDescription],
            [PUBLIC_PAGE_PATHS.mcpGuide, d.mcpTitle, d.mcpDescription],
            [PUBLIC_PAGE_PATHS.versionGuide, d.versionTitle, d.versionDescription],
          ]
            .map(([path, title, desc]) => `<li>${link(localHref(ctx, path), title)} — ${escapeHTML(desc)}</li>`)
            .join("")}</ul>`,
        ),
        section(d.safetyTitle, p(d.safetyBody)),
      ].join("");
    }
    case "mcpGuide": {
      const g = t.mcpGuide;
      return [
        p(g.eyebrow),
        h1(g.title),
        p(g.subtitle),
        section(g.overviewTitle, p(g.overviewBody)),
        section(g.setupTitle, titled(g.setupSteps)),
        section(g.clientsTitle, p(g.clientsSubtitle), ul(g.clientDescriptions)),
        section(g.usageTitle, p(g.usageBody), p(g.verifyLabel), ul(g.prompts)),
        section(g.permissionsTitle, ul(g.permissions)),
      ].join("");
    }
    case "versionGuide": {
      const g = t.versionGuide;
      return [
        p(g.eyebrow),
        h1(g.title),
        p(g.subtitle),
        section(g.overviewTitle, p(g.overviewBody)),
        section(g.availabilityTitle, p(g.availabilityBody)),
        section(g.featuresTitle, titled(g.features)),
        section(g.webTitle, ol(g.webSteps)),
        section(g.mcpTitle, ul(g.mcpRules)),
        section(g.safetyTitle, p(g.safetyBody)),
      ].join("");
    }
    case "aiGuide": {
      const g = t.aiGuide;
      return [
        p(g.eyebrow),
        h1(g.title),
        p(g.subtitle),
        titled(g.checks),
        section(
          g.caseTitle,
          p(g.caseIntro),
          ul(g.caseFacts.map((fact) => `${fact.label}: ${fact.value}`)),
          `<p>${link(localHref(ctx, PUBLIC_PAGE_PATHS.aiCase), g.caseSourceCta)}</p>`,
        ),
        section(g.faqTitle, ...g.faqs.map((faq) => `<h3>${escapeHTML(faq.question)}</h3>${p(faq.answer)}`)),
      ].join("");
    }
    case "aiCase": {
      // 与案例页显示的内容一致：审阅前的原文
      const g = t.aiGuide;
      return [
        p(g.caseOriginalEyebrow),
        h1(g.caseOriginalTitle),
        p(g.caseOriginalDescription),
        `<article>${markdownBlocks(CASE_ORIGINAL_MARKDOWN)}</article>`,
        `<p>${link(localHref(ctx, PUBLIC_PAGE_PATHS.aiGuide), g.caseOriginalBack)}</p>`,
      ].join("");
    }
    case "wechatGuide": {
      const g = t.wechatGuide;
      return [
        p(g.eyebrow),
        h1(g.title),
        p(g.subtitle),
        section(g.prerequisitesTitle, p(g.prerequisitesIntro), ul(g.prerequisites)),
        section(g.platformTitle, p(g.platformIntro), titled(g.platformSteps)),
        section(g.ipTitle, p(g.ipBody)),
        section(g.koinoteTitle, p(g.koinoteIntro), ol(g.koinoteSteps)),
        section(g.billingTitle, p(g.billingBody)),
        section(
          g.troubleshootingTitle,
          ...g.troubleshooting.map((item) => `<h3>${escapeHTML(item.problem)}</h3>${p(item.solution)}`),
        ),
        section(g.securityTitle, p(g.securityBody)),
      ].join("");
    }
    case "changelog": {
      const source = CHANGELOGS[ctx.locale];
      const releases = parseChangelog(source.markdown)
        .filter((release) => release.sections.some((item) => item.entries.length > 0))
        .slice(0, CHANGELOG_RELEASES);
      return [
        p(t.changelog.eyebrow),
        h1(t.changelog.title),
        p(t.changelog.subtitle),
        ...releases.map((release) =>
          [
            `<section><h2>${escapeHTML(
              release.version === "Unreleased" ? t.changelog.unreleased : `v${release.version}`,
            )}</h2>`,
            release.date ? `<p><time datetime="${escapeHTML(release.date)}">${escapeHTML(release.date)}</time></p>` : "",
            ...release.sections
              .filter((item) => item.entries.length > 0)
              .map(
                (item) =>
                  `<h3>${escapeHTML(t.changelog.categories[item.name] ?? item.name)}</h3><ul>${item.entries
                    .map((entry) => `<li>${inlineEntry(entry)}</li>`)
                    .join("")}</ul>`,
              ),
            "</section>",
          ].join(""),
        ),
        `<p>${link(`https://github.com/moutsea/koinote/blob/main/${source.file}`, t.changelog.sourceLink)}</p>`,
      ].join("");
    }
    case "privacy":
    case "terms":
    case "cookies": {
      const doc = t.legal[page];
      return [
        h1(doc.title),
        p(doc.summary),
        ...doc.sections.map((s) => section(s.title, ...s.body.map(p), ul(s.items ?? []))),
      ].join("");
    }
    case "repositories": {
      const labels = t.agentWorkspace;
      const listing = await backendJSON<{ repositories?: RepositorySummary[] }>(
        ctx,
        "/api/agent/repositories?q=",
        { optional: true },
      );
      const items = validRepositories(listing?.status === 200 ? listing.data?.repositories : undefined);
      return [
        p(labels.hubEyebrow),
        h1(labels.publicRepositories),
        p(labels.hubIntro),
        items.length
          ? `<ul>${items
              .map(
                (item) =>
                  `<li>${link(`/repositories/${item.workspaceId}`, item.name)} — ${escapeHTML(
                    text(item.description).trim() || labels.hubNoDescription,
                  )}</li>`,
              )
              .join("")}</ul>`
          : "",
      ].join("");
    }
  }
}

// ── 后端 ───────────────────────────────────────────────────────────────

type RepositorySummary = {
  workspaceId: number;
  name: string;
  description?: string;
  updatedAt?: string;
};

type RepositoryDetail = RepositorySummary & {
  license?: string;
  systemManaged?: boolean;
  files?: Array<{ path: string }>;
};

/** 只保留字段类型正确的条目，后端返回什么都不会让渲染抛错 */
function validRepositories(value: unknown): RepositorySummary[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is RepositorySummary =>
      Boolean(item) && Number.isSafeInteger(item.workspaceId) && item.workspaceId > 0 && text(item.name) !== "",
  );
}

/** sitemap 清单只有 ID 和时间，不像列表条目那样要求有名字 */
function sitemapRepositories(value: unknown): Array<{ workspaceId: number; updatedAt?: unknown }> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is { workspaceId: number; updatedAt?: unknown } =>
      Boolean(item) && Number.isSafeInteger(item.workspaceId) && item.workspaceId > 0,
  );
}

type BackendOptions = {
  /** 只影响正文、不影响状态码的请求：HEAD 没有正文，直接跳过 */
  optional?: boolean;
  timeoutMs?: number;
};

async function backendJSON<T>(
  ctx: { env: SeoEnv; request: Request },
  path: string,
  options: BackendOptions = {},
): Promise<{ status: number; data?: T } | null> {
  if (!ctx.env.BACKEND_URL) return null;
  if (options.optional && ctx.request.method === "HEAD") return null;
  const headers = new Headers({ "x-koinote-worker": "cloudflare" });
  if (ctx.env.BACKEND_INTERNAL_TOKEN) {
    headers.set("x-koinote-internal-token", ctx.env.BACKEND_INTERNAL_TOKEN);
  }
  // 公开仓库接口按 IP 限流；带内部令牌时后端信任这个头，限流落在真实访客上
  const clientIP = ctx.request.headers.get("cf-connecting-ip");
  if (clientIP) headers.set("x-forwarded-for", clientIP);
  try {
    const response = await fetch(new URL(path, ctx.env.BACKEND_URL), {
      headers,
      // 与 proxyToBackend 一致不跟随跳转：跟随跨域 30x 时自定义头（内部令牌）会被带过去
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? BACKEND_TIMEOUT_MS),
    });
    if (!response.ok) return { status: response.status };
    return { status: response.status, data: (await response.json()) as T };
  } catch {
    // 后端慢或挂了时退回普通 SPA，不能让页面跟着失败
    return null;
  }
}

type PricingQuota = { freeStorageQuotaBytes?: number; lifetimeStorageQuotaBytes?: number };
let pricingCache: { backend: string; expires: number; value: PricingQuota } | null = null;

async function pricingQuota(ctx: { env: SeoEnv; request: Request }): Promise<PricingQuota | undefined> {
  const now = Date.now();
  if (pricingCache && pricingCache.backend === ctx.env.BACKEND_URL && pricingCache.expires > now) {
    return pricingCache.value;
  }
  const response = await backendJSON<{ pricing?: PricingQuota }>(ctx, "/api/billing/pricing", { optional: true });
  const value = response?.status === 200 ? response.data?.pricing : undefined;
  if (value && typeof value === "object") {
    pricingCache = { backend: ctx.env.BACKEND_URL, expires: now + PRICING_CACHE_MS, value };
    return value;
  }
  return undefined;
}

// ── 组装 HTML ──────────────────────────────────────────────────────────

type DocumentMeta = {
  locale: Locale;
  title: string;
  description: string;
  canonical: string;
  /** 有多语言版本时给出不带 lang 参数的路径，用来生成 hreflang */
  alternatesPath?: string;
  ogType: "website" | "article";
  jsonLd?: unknown;
  body: string;
};

function renderDocument(template: string, origin: string, meta: DocumentMeta): string {
  const title = escapeHTML(meta.title);
  const description = escapeHTML(meta.description);
  const canonical = escapeHTML(meta.canonical);
  const image = escapeHTML(`${origin}${OG_IMAGE_PATH}`);
  const tags = [`<link rel="canonical" href="${canonical}">`];
  if (meta.alternatesPath !== undefined) {
    for (const locale of LOCALES) {
      tags.push(
        `<link rel="alternate" hreflang="${HTML_LANG[locale]}" href="${escapeHTML(
          `${origin}${meta.alternatesPath}?lang=${locale}`,
        )}">`,
      );
    }
    tags.push(
      `<link rel="alternate" hreflang="x-default" href="${escapeHTML(`${origin}${meta.alternatesPath}`)}">`,
    );
  }
  tags.push(
    `<meta property="og:type" content="${meta.ogType}">`,
    `<meta property="og:site_name" content="Koinote">`,
    `<meta property="og:locale" content="${HTML_LANG[meta.locale].replace("-", "_")}">`,
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${description}">`,
    `<meta property="og:url" content="${canonical}">`,
    `<meta property="og:image" content="${image}">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${title}">`,
    `<meta name="twitter:description" content="${description}">`,
    `<meta name="twitter:image" content="${image}">`,
  );
  if (meta.jsonLd) {
    tags.push(`<script type="application/ld+json">${jsonForScript(meta.jsonLd)}</script>`);
  }
  tags.push(STATIC_HEAD);

  // 替换值一律用函数形式：文案里的 $& / $1 不能被当成正则替换模式
  return template
    .replace(
      /<html([^>]*?)\slang="[^"]*"/i,
      (_m, attrs: string) => `<html${attrs} lang="${HTML_LANG[meta.locale]}" data-seo-locale="${meta.locale}"`,
    )
    .replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${title}</title>`)
    .replace(/<meta\s+name="description"[\s\S]*?>/i, () => `<meta name="description" content="${description}" />`)
    .replace("</head>", () => `    ${tags.join("\n    ")}\n  </head>`)
    .replace(
      /<div id="root"><\/div>/,
      () => `<div id="root"><main class="seo-static">${meta.body}</main></div>`,
    );
}

function structuredData(page: PublicPage, ctx: RenderContext, meta: { title: string; description: string }, url: string) {
  const home = `${ctx.origin}/`;
  if (page === "home") {
    return {
      "@context": "https://schema.org",
      "@graph": [
        {
          "@type": "WebSite",
          name: "Koinote",
          alternateName: ctx.t.footer.brandCn,
          url: home,
          inLanguage: HTML_LANG[ctx.locale],
        },
        {
          "@type": "SoftwareApplication",
          name: "Koinote",
          alternateName: SITE_TAGLINE[ctx.locale],
          url: home,
          description: meta.description,
          applicationCategory: "UtilitiesApplication",
          operatingSystem: "Web, macOS, Windows",
          downloadUrl: `${ctx.origin}/download`,
          image: `${ctx.origin}${OG_IMAGE_PATH}`,
          offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
          publisher: { "@type": "Organization", name: ctx.t.footer.companyName },
        },
      ],
    };
  }
  const crumbs: Array<{ name: string; item: string }> = [{ name: ctx.t.footer.home, item: home }];
  if (PUBLIC_PAGE_PATHS[page].startsWith("/docs/")) {
    crumbs.push({ name: ctx.t.footer.docsCenter, item: `${ctx.origin}${PUBLIC_PAGE_PATHS.docs}` });
  }
  if (page === "aiCase") {
    crumbs.push({ name: ctx.t.footer.aiGuide, item: `${ctx.origin}${PUBLIC_PAGE_PATHS.aiGuide}` });
  }
  crumbs.push({ name: meta.title.replace(/ — Koinote$/, ""), item: url });
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: crumbs.map((crumb, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: crumb.name,
      item: crumb.item,
    })),
  };
}

// ── 请求处理 ───────────────────────────────────────────────────────────

/** 取 SPA 外壳。去掉条件请求头：304 没有正文，后面没法注入 */
async function fetchShell(request: Request, env: SeoEnv): Promise<Response> {
  const headers = new Headers(request.headers);
  for (const name of ["if-none-match", "if-modified-since", "if-match", "if-range", "range"]) {
    headers.delete(name);
  }
  return env.ASSETS.fetch(new Request(new URL("/", request.url), { method: "GET", headers }));
}

function htmlResponse(
  request: Request,
  shell: Response,
  html: string,
  status: number,
  extra: Record<string, string> = {},
): Response {
  const headers = new Headers(shell.headers);
  headers.set("content-type", "text/html; charset=UTF-8");
  // 正文按路由和语言变了，静态资源的 ETag 不再对应
  headers.delete("etag");
  headers.delete("content-length");
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return new Response(request.method === "HEAD" ? null : html, { status, headers });
}

/**
 * 404：仍给 SPA 外壳（前端会渲染 NotFoundPage），但标题、语言和一段静态说明
 * 先在边缘写好，不执行 JS 的访客也看得懂。不加 canonical / OG：这页不该被收录或分享。
 */
function notFoundResponse(request: Request, shell: Response, template: string): Response {
  const url = new URL(request.url);
  const explicit = requestedLocale(url);
  const locale = explicit ?? acceptLanguageLocale(request.headers.get("accept-language"));
  const t = MESSAGES[locale];
  const html = template
    .replace(
      /<html([^>]*?)\slang="[^"]*"/i,
      (_m, attrs: string) => `<html${attrs} lang="${HTML_LANG[locale]}" data-seo-locale="${locale}"`,
    )
    .replace(/<title>[\s\S]*?<\/title>/i, () => `<title>${escapeHTML(notFoundTitle(t))}</title>`)
    .replace("</head>", () => `    ${STATIC_HEAD}\n  </head>`)
    .replace(
      /<div id="root"><\/div>/,
      () =>
        `<div id="root"><main class="seo-static">${h1(t.notFound.title)}${p(t.notFound.description)}<p>${link(
          "/",
          t.notFound.backHome,
        )} · ${link(PUBLIC_PAGE_PATHS.docs, t.notFound.openDocs)}</p></main></div>`,
    );
  return htmlResponse(request, shell, html, 404, {
    "x-robots-tag": "noindex",
    ...(explicit ? {} : { vary: "Accept-Language" }),
  });
}

async function withRobots(request: Request, env: SeoEnv, status: number): Promise<Response> {
  const shell = await fetchShell(request, env);
  if (!shell.ok) return shell;
  return htmlResponse(request, shell, await shell.text(), status, { "x-robots-tag": "noindex" });
}

async function renderPublicPage(page: PublicPage, request: Request, env: SeoEnv): Promise<Response> {
  const url = new URL(request.url);
  const explicit = requestedLocale(url);
  const locale = explicit ?? acceptLanguageLocale(request.headers.get("accept-language"));
  const ctx: RenderContext = {
    t: MESSAGES[locale],
    locale,
    explicitLocale: explicit !== null,
    origin: url.origin,
    env,
    request,
  };
  const path = PUBLIC_PAGE_PATHS[page];
  const canonical = `${url.origin}${path}${explicit ? `?lang=${explicit}` : ""}`;
  const meta = publicPageMeta(page, ctx.t, locale);
  const [shell, body] = await Promise.all([fetchShell(request, env), pageBody(page, ctx)]);
  if (!shell.ok) return shell;
  const html = renderDocument(await shell.text(), url.origin, {
    locale,
    title: meta.title,
    description: meta.description,
    canonical,
    alternatesPath: path,
    ogType: "website",
    jsonLd: structuredData(page, ctx, meta, canonical),
    body: body + siteNav(ctx),
  });
  // x-default 的内容随 Accept-Language 变，告诉缓存别把一种语言发给所有人
  return htmlResponse(request, shell, html, 200, explicit ? {} : { vary: "Accept-Language" });
}

async function renderRepositoryPage(id: string, request: Request, env: SeoEnv): Promise<Response> {
  const url = new URL(request.url);
  const explicit = requestedLocale(url);
  const locale = explicit ?? acceptLanguageLocale(request.headers.get("accept-language"));
  const labels = MESSAGES[locale].agentWorkspace;
  const [shell, detail] = await Promise.all([
    fetchShell(request, env),
    backendJSON<{ repository?: RepositoryDetail }>({ env, request }, `/api/agent/repositories/${id}`),
  ]);
  if (!shell.ok) return shell;
  const template = await shell.text();
  // 后端对不存在、已撤回或格式不对的 ID 返回 404/400
  if (detail?.status === 404 || detail?.status === 400) return notFoundResponse(request, shell, template);
  const repository = detail?.status === 200 ? detail.data?.repository : undefined;
  // 后端暂时不可用：给原样的 SPA，让前端自己重试，别把错误状态写进索引
  if (!repository || !text(repository.name)) {
    return htmlResponse(request, shell, template, 200, { "cache-control": "no-store" });
  }

  const summary = text(repository.description).trim() || labels.hubNoDescription;
  const description = clipDescription(summary);
  const files = (Array.isArray(repository.files) ? repository.files : [])
    .map((file) => text(file?.path))
    .filter(Boolean)
    .slice(0, 50);
  const html = renderDocument(template, url.origin, {
    locale,
    title: repositoryPageTitle(repository.name, MESSAGES[locale]),
    description,
    canonical: `${url.origin}/repositories/${id}`,
    ogType: "article",
    body: [
      p(labels.publicRepositories),
      h1(repository.name),
      p(summary),
      text(repository.license) ? p(`${labels.licenseLabel}: ${text(repository.license)}`) : "",
      files.length ? section(labels.filesTitle, ul(files)) : "",
      `<p>${link(PUBLIC_PAGE_PATHS.repositories, labels.publicRepositories)}</p>`,
    ].join(""),
  });
  return htmlResponse(request, shell, html, 200, explicit ? {} : { vary: "Accept-Language" });
}

function robotsTxt(origin: string, previewHost: boolean): Response {
  const body = previewHost
    ? // workers.dev 预览地址整站不收录，免得和正式域名抢 canonical
      "User-agent: *\nDisallow: /\n"
    : [
        "User-agent: *",
        // 不挡 /api/：Google 渲染页面时同样遵守 robots.txt，挡了之后仓库页、价格页
        // 的数据请求全部失败，渲染结果是报错态。应用页也不在这里挡：被 Disallow 的
        // 页面爬虫看不到 noindex。不收录由响应头负责。
        // 只挡 MCP 端点本身。不加 $ 是前缀匹配，会连 /mcp/activity 一起挡住
        "Disallow: /mcp$",
        "",
        `Sitemap: ${origin}/sitemap.xml`,
        "",
      ].join("\n");
  return new Response(body, {
    headers: { "content-type": "text/plain; charset=UTF-8", "cache-control": "public, max-age=3600" },
  });
}

async function sitemapXml(request: Request, env: SeoEnv): Promise<Response> {
  const origin = new URL(request.url).origin;
  const entries: string[] = [];
  for (const path of Object.values(PUBLIC_PAGE_PATHS)) {
    const alternates = [
      ...LOCALES.map(
        (locale) =>
          `<xhtml:link rel="alternate" hreflang="${HTML_LANG[locale]}" href="${escapeHTML(`${origin}${path}?lang=${locale}`)}"/>`,
      ),
      `<xhtml:link rel="alternate" hreflang="x-default" href="${escapeHTML(`${origin}${path}`)}"/>`,
    ].join("");
    // hreflang 组里的每个 URL 都要各自列出整组 alternates
    for (const loc of [`${origin}${path}`, ...LOCALES.map((locale) => `${origin}${path}?lang=${locale}`)]) {
      entries.push(`<url><loc>${escapeHTML(loc)}</loc>${alternates}</url>`);
    }
  }

  // 后端一次给出全部已公开仓库（/api/agent/repositories/sitemap）。不再翻 Hub 列表：
  // 那个接口每页 12 个、靠游标串行翻，边缘上翻不完整个目录。
  // 部署流程先发后端、验活后才部署 Worker，不需要兼容没有这个接口的旧后端；
  // 取不到时 sitemap 照常输出公开页，只是这一次没有仓库条目。
  const feed = await backendJSON<{ repositories?: unknown }>({ env, request }, "/api/agent/repositories/sitemap", {
    optional: true,
    timeoutMs: SITEMAP_BACKEND_TIMEOUT_MS,
  });
  for (const repository of sitemapRepositories(feed?.status === 200 ? feed.data?.repositories : undefined)) {
    const date = /^\d{4}-\d{2}-\d{2}/.exec(text(repository.updatedAt))?.[0];
    const lastmod = date ? `<lastmod>${date}</lastmod>` : "";
    entries.push(`<url><loc>${escapeHTML(`${origin}/repositories/${repository.workspaceId}`)}</loc>${lastmod}</url>`);
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${entries.join("\n")}
</urlset>
`;
  return new Response(request.method === "HEAD" ? null : xml, {
    headers: { "content-type": "application/xml; charset=UTF-8", "cache-control": "public, max-age=3600" },
  });
}

/**
 * 处理 GET/HEAD 的页面请求。返回 null 表示与 SEO 无关（静态资源等），
 * 由调用方继续走 ASSETS。
 */
export async function handleSeoRequest(request: Request, env: SeoEnv): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const url = new URL(request.url);
  const previewHost = url.hostname.endsWith(".workers.dev");
  const response = await routeSeoRequest(request, env, url, previewHost);
  if (!response || !previewHost) return response;
  const headers = new Headers(response.headers);
  headers.set("x-robots-tag", "noindex");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function routeSeoRequest(
  request: Request,
  env: SeoEnv,
  url: URL,
  previewHost: boolean,
): Promise<Response | null> {
  const { pathname } = url;

  if (pathname === "/robots.txt") return robotsTxt(url.origin, previewHost);
  if (pathname === "/sitemap.xml") return sitemapXml(request, env);

  // /pricing/、/Pricing 与 /pricing 是同一页，301 到规范地址，避免收录出重复 URL
  const trimmed = pathname.length > 1 ? pathname.replace(/\/+$/, "") || "/" : pathname;
  const route = classifyPath(trimmed);
  if (route) {
    const canonical = canonicalPathFor(route, trimmed);
    if (canonical !== pathname) return Response.redirect(`${url.origin}${canonical}${url.search}`, 301);
  }
  if (route?.kind === "public") return renderPublicPage(route.page, request, env);
  if (route?.kind === "repository") return renderRepositoryPage(route.id, request, env);
  if (route?.kind === "app") return withRobots(request, env, 200);

  // 不认识且不带扩展名的路径只可能落到 SPA 兜底。剥掉条件请求头再取外壳：
  // 以前被收录的软 404 地址，爬虫复查时会带旧 ETag，直接转发会拿到 304，
  // 收录永远清不掉。
  if (!/\.[A-Za-z0-9]+$/.test(pathname)) {
    const shell = await fetchShell(request, env);
    if (!shell.ok) return shell;
    return notFoundResponse(request, shell, await shell.text());
  }

  // 带扩展名的可能是真实静态文件（public/ 下的图片等），原样转发，条件请求照常 304；
  // 不存在时 SPA 兜底返回的 index.html 改成 404
  const asset = await env.ASSETS.fetch(request);
  const isShell = (asset.headers.get("content-type") ?? "").includes("text/html");
  if (!isShell || !asset.ok) return asset;
  return notFoundResponse(request, asset, await asset.text());
}
