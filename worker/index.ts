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
import { applySecurityHeaders } from "./securityHeaders";

export interface Env extends Cloudflare.Env {
  BACKEND_URL: string;
  BACKEND_INTERNAL_TOKEN?: string;
  CLOUDFLARE_ZONE_ID?: string;
  CLOUDFLARE_CACHE_PURGE_TOKEN?: string;
  IMAGE_PUBLIC_BASE: string;
}

const API_PREFIXES = ["/api/", "/health"];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // 安全头在这一层统一加，而不是在每个分支里各加一次：
    // 下面有 7 条返回路径，逐个加迟早漏一条，而漏掉的那条不会有任何报错 ——
    // 只是那个端点静默地少了防护。包在唯一入口上，漏不掉。
    return applySecurityHeaders(await route(request, env), url);
  },
};

/** 路由分发。安全头由上面的 fetch 统一包，这里只管选处理器。 */
async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

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
    request.method === "GET" &&
    /^\/share\/[0-9a-f]{32}$/.test(url.pathname)
  ) {
    return handleSharePage(request, env);
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
    const response = await fetch(metaURL, {
      headers: env.BACKEND_INTERNAL_TOKEN
        ? { "x-koinote-internal-token": env.BACKEND_INTERNAL_TOKEN }
        : undefined,
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
      : `${requestURL.origin}/apple-touch-icon.png`;
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
  const targetUrl = new URL(
    incomingUrl.pathname + incomingUrl.search,
    env.BACKEND_URL,
  );

  const headers = new Headers(request.headers);
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

  const backendResponse = await fetch(targetUrl, {
    method: request.method,
    headers,
    body:
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : request.body,
    redirect: "manual",
  });

  const responseHeaders = new Headers(backendResponse.headers);
  responseHeaders.set("x-koinote-proxy", "cloudflare-worker");
  return new Response(backendResponse.body, {
    status: backendResponse.status,
    statusText: backendResponse.statusText,
    headers: responseHeaders,
  });
}
