import { handleAgentRepositoryObject } from "./agentRepositoryObjects";
import { backendHeaders } from "./backend";
import { rateLimitAddress } from "./rateLimitAddress";
/**
 * Koinote Cloudflare Worker
 *
 * 职责（MVP 精简版）：
 *   1. /api/* 和 /health → 反向代理到 Go 后端（BACKEND_URL）
 *   2. 其余请求 → 托管 Vite 打的 SPA 静态资源（ASSETS 绑定，SPA fallback）
 *
 * 分享页会在边缘注入动态 title / OpenGraph 元数据，普通 SPA 路由仍直接走静态资源。
 */

import {
  handleImageConfig,
  handleImageDelete,
  handleImageFetch,
  handleImageGet,
  handleImageUpload,
} from "./images";
import { handleVerificationEmail } from "./email";
import {
  handleDatabaseBackupDownload,
  handleDatabaseBackupStatus,
  handleDatabaseBackupUpload,
} from "./backups";
import { applySecurityHeaders } from "./securityHeaders";
import { classifyPath, handleSeoRequest, renderRepositoryFallback } from "./seo";
import {
  readWechatDraftResponse,
  WECHAT_DRAFT_STREAM_TYPE,
} from "./wechatDraftStream";

export interface Env extends Cloudflare.Env {
  BACKEND_URL: string;
  BACKEND_INTERNAL_TOKEN?: string;
  BACKEND_ORIGIN_TOKEN?: string;
  SECURITY_BLOCKED_IPS?: string;
  CLOUDFLARE_ZONE_ID?: string;
  CLOUDFLARE_CACHE_PURGE_TOKEN?: string;
  IMAGE_PUBLIC_BASE: string;
  BACKUPS: R2Bucket;
}

const API_PREFIXES = ["/api/", "/health"];
// Worker → Go callbacks. The public proxy must never forward these paths.
const WORKER_ONLY_BACKEND_PATHS = new Set(["/api/images/record", "/api/images/admit", "/api/images/rollback"]);
const DESKTOP_RELEASES_URL =
  "https://github.com/moutsea/koinote/releases/latest";
const SHARE_BACKEND_TIMEOUT_MS = 4_000;

function isShareReadRequest(request: Request, url: URL): boolean {
  return (
    ((request.method === "GET" || request.method === "HEAD") &&
      (/^\/share\/[0-9a-f]{32}$/.test(url.pathname) ||
        /^\/api\/share\/[0-9a-f]{32}(?:\/meta)?$/.test(url.pathname))) ||
    (request.method === "POST" && /^\/api\/share\/[0-9a-f]{32}\/verify$/.test(url.pathname))
  );
}

function shareUnavailable(): Response {
  return Response.json(
    { code: "share_unavailable", error: "Share is temporarily busy; please retry shortly" },
    { status: 503, headers: { "Cache-Control": "private, no-store", "Retry-After": "1" } },
  );
}

// A navigation must remain readable even when no SPA assets or origin work are
// allowed. API callers still receive the machine-readable error contract.
function shareFailureResponse(request: Request, status: 429 | 503): Response {
  const headers = {
    "Cache-Control": "private, no-store",
    "Retry-After": status === 429 ? "60" : "1",
    "X-Robots-Tag": "noindex, nofollow",
  };
  const pathname = new URL(request.url).pathname;
  if (!/^\/share\/[0-9a-f]{32}$/.test(pathname)) {
    return Response.json({
      code: status === 429 ? "too_many_requests" : "share_unavailable",
      error: "Share is temporarily busy; please retry shortly",
    }, { status, headers });
  }
  const language = request.headers.get("accept-language")?.split(",", 1)[0]?.trim().split("-", 1)[0];
  const locale = language === "zh" || language === "fr" || language === "ja" ? language : "en";
  const copy = {
    zh: ["分享页面暂时繁忙", status === 429 ? "访问较多，请等待约一分钟后重试。" : "服务暂时不可用，请稍后重试。", "重试", "返回首页"],
    en: ["Share temporarily unavailable", status === 429 ? "There are too many requests. Please wait about a minute and retry." : "The service is temporarily unavailable. Please retry shortly.", "Retry", "Home"],
    fr: ["Partage temporairement indisponible", status === 429 ? "Trop de requêtes. Patientez environ une minute puis réessayez." : "Le service est temporairement indisponible. Réessayez dans un instant.", "Réessayer", "Accueil"],
    ja: ["共有ページは一時的に利用できません", status === 429 ? "アクセスが集中しています。約1分待ってから再試行してください。" : "サービスを一時的に利用できません。少し待って再試行してください。", "再試行", "ホーム"],
  }[locale];
  const html = `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${copy[0]} · Koinote</title><style>body{margin:0;background:#f8f6f1;color:#292822;font:16px/1.7 system-ui,sans-serif}main{max-width:38rem;margin:12vh auto;padding:2rem}h1{font-size:1.6rem}nav{display:flex;flex-wrap:wrap;gap:1rem}a{display:inline-block;padding:.5rem 1rem;border:1px solid #777064;border-radius:.5rem;color:inherit}a:focus-visible{outline:3px solid #a63f2b;outline-offset:3px}</style></head><body><main><h1>${copy[0]}</h1><p>${copy[1]}</p><nav><a href="${pathname}">${copy[2]}</a><a href="/">${copy[3]}</a></nav></main></body></html>`;
  return new Response(request.method === "HEAD" ? null : html, {
    status, headers: { ...headers, "Content-Type": "text/html; charset=utf-8", "Content-Language": locale },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const clientIP = request.headers.get("cf-connecting-ip");
    const blockedIPs = (env.SECURITY_BLOCKED_IPS ?? "").split(",").map(ip => ip.trim()).filter(Boolean);
    if (clientIP && blockedIPs.includes(clientIP)) {
      return applySecurityHeaders(new Response("Forbidden", { status: 403, headers: { "Cache-Control": "no-store" } }), url);
    }
    // Reject abusive sources before session lookups, body reads or external fetches.
    // The Go admission endpoint additionally shares account/global budgets across locations.
    if (request.method === "POST" && (url.pathname === "/api/images" || url.pathname === "/api/images/fetch") && env.IMAGE_WRITE_LIMITER) {
      try {
        const { success } = await env.IMAGE_WRITE_LIMITER.limit({ key: `koinote:image-write:${rateLimitAddress(clientIP)}` });
        if (!success) return applySecurityHeaders(Response.json({ code: "image_rate_limited", error: "Too many image uploads; please retry later" }, {
          status: 429, headers: { "Retry-After": "60", "Cache-Control": "private, no-store" },
        }), url);
      } catch {
        return applySecurityHeaders(Response.json({ code: "image_upload_unavailable", error: "Image uploads are temporarily unavailable" }, {
          status: 503, headers: { "Cache-Control": "private, no-store" },
        }), url);
      }
    }
    // The binding limits work before either metadata or API requests reach Go.
    // It is approximate per Cloudflare location; Go enforces the global budget.
    // Local-only configurations may omit the binding and retain Go's protection.
    if (isShareReadRequest(request, url) && env.SHARE_READ_LIMITER) {
      try {
        const { success } = await env.SHARE_READ_LIMITER.limit({ key: `koinote:share:${rateLimitAddress(clientIP)}` });
        if (!success) {
          return applySecurityHeaders(shareFailureResponse(request, 429), url);
        }
      } catch {
        return applySecurityHeaders(shareFailureResponse(request, 503), url);
      }
    }
    // 安全头在这一层统一加，而不是在每个分支里各加一次：
    // 下面有 7 条返回路径，逐个加迟早漏一条，而漏掉的那条不会有任何报错 ——
    // 只是那个端点静默地少了防护。包在唯一入口上，漏不掉。
    return applySecurityHeaders(await route(request, env), url);
  },
};

/** 路由分发。安全头由上面的 fetch 统一包，这里只管选处理器。 */
async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (
    url.pathname === "/download" &&
    (request.method === "GET" || request.method === "HEAD")
  ) {
    return Response.redirect(DESKTOP_RELEASES_URL, 302);
  }

  if (url.pathname.startsWith("/api/internal/agent-repository-objects/")) {
    return handleAgentRepositoryObject(request, env);
  }

  // 图片上传由 Worker 直接落 R2，不转发给后端——
  // 字节走边缘，不占 VPS 带宽。鉴权仍回调后端校验会话。
  // 必须排在 /api/images 之前：下面那条是精确匹配 POST，
  // 但 API_PREFIXES 里的 /api/ 会把 config 转发给后端。
  if (url.pathname === "/api/images/config" && request.method === "GET") {
    return handleImageConfig(env);
  }
  // 代抓外链图片：从网页/Markdown 粘贴来的图要转存进图床，而浏览器受 CORS
  // 限制读不到跨站字节，只能服务端代抓。防护见 ssrf.ts
  if (url.pathname === "/api/images/fetch" && request.method === "POST") {
    return handleImageFetch(request, env);
  }
  // 回收：后端的后台任务调它删 R2 对象，用内部令牌鉴权而非会话
  if (url.pathname === "/api/images/delete" && request.method === "POST") {
    return handleImageDelete(request, env);
  }
  if (url.pathname === "/api/images" && request.method === "POST") {
    return handleImageUpload(request, env);
  }
  // 后端生成并落库验证码后调用这里发信。只接受内部令牌，浏览器不能直接使用。
  if (
    url.pathname === "/api/internal/email/verification" &&
    request.method === "POST"
  ) {
    return handleVerificationEmail(request, env);
  }
  if (
    url.pathname === "/api/internal/backups" &&
    request.method === "GET"
  ) {
    return handleDatabaseBackupStatus(request, env);
  }
  if (url.pathname.startsWith("/api/internal/backups/database/")) {
    if (request.method === "PUT") {
      return handleDatabaseBackupUpload(request, env);
    }
    if (request.method === "GET") {
      return handleDatabaseBackupDownload(request, env);
    }
  }
  // HEAD 也要走这里：CDN 与浏览器用它做缓存校验，
  // 漏掉的话会落到 SPA 资源处理器，返回 text/html 的假响应。
  if (
    url.pathname.startsWith("/images/") &&
    (request.method === "GET" || request.method === "HEAD")
  ) {
    return handleImageGet(request, env);
  }

  if (
    url.pathname === "/mcp" ||
    API_PREFIXES.some(
      (prefix) => url.pathname === prefix || url.pathname.startsWith(prefix),
    )
  ) {
    return proxyToBackend(request, env);
  }

  if (
    (request.method === "GET" || request.method === "HEAD") &&
    /^\/share\/[0-9a-f]{32}$/.test(url.pathname)
  ) {
    return handleSharePage(request, env);
  }

  // 公开页注入 meta 与静态正文、应用页 noindex、未知路径 404、robots/sitemap。
  // 返回 null 的是普通静态资源（JS/CSS/图片），照常走 ASSETS。
  // 渲染出错就退回原来的静态资源：这些页面以前不经过任何动态逻辑，不能因为
  // SEO 注入出问题而整页 500。
  try {
    const seoResponse = await handleSeoRequest(request, env);
    if (seoResponse) return seoResponse;
  } catch (error) {
    console.error("seo render failed", { path: url.pathname, error: String(error) });
    const failedRoute = classifyPath(url.pathname);
    if (failedRoute?.kind === "repository") return renderRepositoryFallback(failedRoute.id, request, env);
  }

  // 静态资源（SPA），404 交给 not_found_handling: single-page-application
  return env.ASSETS.fetch(request);
}

type ShareMeta = {
  title?: string;
  description?: string;
  imageKey?: string;
  protected?: boolean;
};

function escapeHTML(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function handleSharePage(request: Request, env: Env): Promise<Response> {
  const assetResponse = await env.ASSETS.fetch(request);
  if (!assetResponse.ok || !env.BACKEND_URL) return assetResponse;

  const requestURL = new URL(request.url);
  const token = requestURL.pathname.slice("/share/".length);
  const metaURL = new URL(
    `/api/share/${encodeURIComponent(token)}/meta`,
    env.BACKEND_URL,
  );
  let meta: ShareMeta | null = null;
  try {
    const headers = backendHeaders(env, env.BACKEND_INTERNAL_TOKEN
      ? { "x-koinote-internal-token": env.BACKEND_INTERNAL_TOKEN }
      : undefined);
    const clientIP = request.headers.get("cf-connecting-ip");
    // Match proxyToBackend: Caddy derives X-Forwarded-For from the same-zone
    // subrequest's CF-Connecting-IP, which follows x-real-ip.
    if (clientIP) {
      headers.set("x-forwarded-for", clientIP);
      headers.set("x-real-ip", clientIP);
    }
    const response = await fetch(metaURL, {
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(SHARE_BACKEND_TIMEOUT_MS),
    });
    if (response.ok) meta = (await response.json()) as ShareMeta;
  } catch {
    return assetResponse;
  }
  if (!meta) return assetResponse;

  const protectedShare = meta.protected === true;
  const rawTitle = protectedShare
    ? "受保护的 Koinote 文档"
    : meta.title?.trim() || "Koinote 分享文档";
  const rawDescription = protectedShare
    ? "这是一篇需要访问口令的 Koinote 分享文档。"
    : meta.description?.trim() || "在 Koinote 阅读这篇分享文档。";
  const canonicalURL = `${requestURL.origin}${requestURL.pathname}`;
  const imageBase = (env.IMAGE_PUBLIC_BASE ?? "").trim().replace(/\/+$/, "");
  const imageURL =
    meta.imageKey &&
    /^u\/[A-Za-z0-9_-]{1,128}\/[0-9a-f]{8,64}\.(png|jpg|gif|webp)$/.test(
      meta.imageKey,
    )
      ? imageBase
        ? `${imageBase}/${meta.imageKey}`
        : `${requestURL.origin}/images/${meta.imageKey}`
      : `${requestURL.origin}/og-image.png`;
  const title = escapeHTML(`${rawTitle} — Koinote`);
  const description = escapeHTML(rawDescription);
  const canonical = escapeHTML(canonicalURL);
  const image = escapeHTML(imageURL);
  const tags = [
    `<link rel="canonical" href="${canonical}">`,
    `<meta property="og:type" content="article">`,
    `<meta property="og:site_name" content="Koinote">`,
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${description}">`,
    `<meta property="og:url" content="${canonical}">`,
    `<meta property="og:image" content="${image}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${title}">`,
    `<meta name="twitter:description" content="${description}">`,
    `<meta name="twitter:image" content="${image}">`,
  ].join("\n    ");

  let html = await assetResponse.text();
  html = html.replace(
    /<title>[\s\S]*?<\/title>/i,
    () => `<title>${title}</title>`,
  );
  html = html.replace(
    /<meta\s+name="description"[\s\S]*?>/i,
    () => `<meta name="description" content="${description}">`,
  );
  html = html.replace("</head>", () => `    ${tags}\n  </head>`);

  const headers = new Headers(assetResponse.headers);
  headers.set("content-type", "text/html; charset=UTF-8");
  headers.set("cache-control", "private, no-store");
  headers.set("x-robots-tag", "noindex, nofollow");
  headers.delete("content-length");
  return new Response(html, {
    status: assetResponse.status,
    statusText: assetResponse.statusText,
    headers,
  });
}

async function proxyToBackend(request: Request, env: Env): Promise<Response> {
  if (!env.BACKEND_URL) {
    return new Response("BACKEND_URL is not configured", { status: 500 });
  }

  const incomingUrl = new URL(request.url);
  // The public proxy attaches the internal token below. Backend endpoints that
  // only the Worker itself may call must therefore never be forwarded from the
  // internet. Compare the decoded path because Go routes unescaped segments.
  let decodedPath: string;
  try { decodedPath = decodeURIComponent(incomingUrl.pathname).replace(/\/+$/, ""); }
  catch { decodedPath = ""; }
  if (!decodedPath || WORKER_ONLY_BACKEND_PATHS.has(decodedPath)) {
    return Response.json({ code: "not_found", error: "Not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  const targetUrl = new URL(
    incomingUrl.pathname + incomingUrl.search,
    env.BACKEND_URL,
  );

  const headers = backendHeaders(env, request.headers);
  // 剥掉客户端可伪造的信任头，避免越权
  headers.delete("host");
  headers.delete("x-auth-user-id");
  headers.delete("x-koinote-internal-token");
  headers.delete("x-koinote-worker");
  headers.delete("x-forwarded-for");
  headers.delete("x-real-ip");
  headers.set("x-forwarded-host", incomingUrl.host);
  headers.set("x-forwarded-proto", incomingUrl.protocol.replace(":", ""));
  headers.set("x-koinote-worker", "cloudflare");
  const clientIP = request.headers.get("cf-connecting-ip");
  if (clientIP) {
    headers.set("x-forwarded-for", clientIP);
    headers.set("x-real-ip", clientIP);
  }

  if (env.BACKEND_INTERNAL_TOKEN) {
    headers.set("x-koinote-internal-token", env.BACKEND_INTERNAL_TOKEN);
  }

  const isWechatDraft =
    request.method === "POST" &&
    /^\/api\/documents\/[^/]+\/wechat-draft$/.test(incomingUrl.pathname);
  if (isWechatDraft) headers.set("accept", WECHAT_DRAFT_STREAM_TYPE);

  const shareRead = isShareReadRequest(request, incomingUrl);
  let backendResponse: Response;
  try {
    backendResponse = await fetch(targetUrl, {
      method: request.method,
      headers,
      body:
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : request.body,
      redirect: "manual",
      ...(shareRead
        ? { signal: AbortSignal.timeout(SHARE_BACKEND_TIMEOUT_MS) }
        : isWechatDraft ? { signal: request.signal } : {}),
    });
  } catch (error) {
    if (shareRead) return shareUnavailable();
    throw error;
  }

  if (
    isWechatDraft &&
    backendResponse.headers.get("content-type") === WECHAT_DRAFT_STREAM_TYPE
  ) {
    return readWechatDraftResponse(backendResponse);
  }

  const responseHeaders = new Headers(backendResponse.headers);
  responseHeaders.set("x-koinote-proxy", "cloudflare-worker");
  return new Response(backendResponse.body, {
    status: backendResponse.status,
    statusText: backendResponse.statusText,
    headers: responseHeaders,
  });
}
