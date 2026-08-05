/**
 * Koinote Cloudflare Worker
 *
 * 职责（MVP 精简版）：
 *   1. /api/* 和 /health → 反向代理到 Go 后端（BACKEND_URL）
 *   2. 其余请求 → 托管 Vite 打的 SPA 静态资源（ASSETS 绑定，SPA fallback）
 *
 * SEO 元数据注入、sitemap 等留到后续阶段，先保证代理与托管跑通。
 */

import { handleImageConfig, handleImageGet, handleImageUpload } from "./images";

type AssetFetcher = {
  fetch(request: Request): Promise<Response> | Response;
};

export interface Env {
  ASSETS: AssetFetcher;
  BACKEND_URL: string;
  BACKEND_INTERNAL_TOKEN?: string;
  IMAGES: R2Bucket;
  IMAGE_PUBLIC_BASE?: string;
}

const API_PREFIXES = ["/api/", "/health"];

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 图片上传由 Worker 直接落 R2，不转发给后端——
    // 字节走边缘，不占 VPS 带宽。鉴权仍回调后端校验会话。
    // 必须排在 /api/images 之前：下面那条是精确匹配 POST，
    // 但 API_PREFIXES 里的 /api/ 会把 config 转发给后端。
    if (url.pathname === "/api/images/config" && request.method === "GET") {
      return handleImageConfig(env);
    }
    if (url.pathname === "/api/images" && request.method === "POST") {
      return handleImageUpload(request, env);
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
      API_PREFIXES.some(
        (prefix) => url.pathname === prefix || url.pathname.startsWith(prefix),
      )
    ) {
      return proxyToBackend(request, env);
    }

    // 静态资源（SPA），404 交给 not_found_handling: single-page-application
    return env.ASSETS.fetch(request);
  },
};

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
