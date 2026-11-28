const storageKey = "koinote_registration_first_touch_v1";
const campaignLabel = /^[A-Za-z0-9_-]{1,128}$/;
const shareToken = /^[a-f0-9]{32}$/;
const sourceKey = /^[a-f0-9]{64}$/;
const hostPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export type RegistrationFirstTouch = {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  referrerHost?: string;
  landingPath: string;
  capturedAt: string;
  shareSourceKey?: string;
};

const staticPaths = new Set([
  "/", "/pricing", "/docs", "/docs/mcp", "/docs/version-history", "/docs/ai-optimization",
  "/docs/ai-optimization/case", "/docs/wechat-official-account", "/changelog", "/editor",
  "/login", "/register", "/desktop/authorize", "/billing/desktop-return", "/dashboard",
  "/settings", "/repositories", "/agent/workspaces", "/space/settings", "/agent/settings",
  "/space", "/ai-settings", "/mcp/activity", "/documents", "/trash", "/invitations",
  "/admin", "/privacy", "/terms", "/cookies",
]);

export function attributionLandingPath(path: string): string | undefined {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return;
  path = path.split(/[?#]/, 1)[0].replace(/\/$/, "") || "/";
  if (staticPaths.has(path)) return path;
  const routes = [
    ["/share/", "/share/:token"], ["/editor/", "/editor/:docId"],
    ["/repositories/", "/repositories/:repositoryId"], ["/agent/workspaces/", "/agent/workspaces/:workspaceId"],
  ];
  for (const [prefix, template] of routes) {
    const segment = path.slice(prefix.length);
    if (path.startsWith(prefix) && segment && !/[/%]/.test(segment)) return template;
  }
}

function label(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  return campaignLabel.test(trimmed) ? trimmed : undefined;
}

function cleanHost(value: unknown): string | undefined {
  if (typeof value !== "string") return;
  const host = value.toLowerCase().replace(/\.$/, "");
  if (host.length > 253 || !hostPattern.test(host) || /^[\d.]+$/.test(host)) return;
  if (host === window.location.hostname || host === "accounts.google.com" || host === "oauth2.googleapis.com") return;
  return host;
}

function readFirstTouch(): RegistrationFirstTouch | undefined {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw || raw.length > 2048) return;
    const value = JSON.parse(raw);
    if (!value || typeof value.landingPath !== "string" || typeof value.capturedAt !== "string") return;
    const landingPath = attributionLandingPath(value.landingPath);
    const capturedAt = Date.parse(value.capturedAt);
    if (!landingPath || !Number.isFinite(capturedAt) || capturedAt < Date.UTC(2020, 0, 1) || capturedAt > Date.now() + 300_000) return;
    return {
      utmSource: label(value.utmSource), utmMedium: label(value.utmMedium), utmCampaign: label(value.utmCampaign),
      referrerHost: cleanHost(value.referrerHost), landingPath, capturedAt: new Date(capturedAt).toISOString(),
      shareSourceKey: landingPath === "/share/:token" && typeof value.shareSourceKey === "string" && sourceKey.test(value.shareSourceKey)
        ? value.shareSourceKey : undefined,
    };
  } catch {
    return;
  }
}

// 首屏先启动采集，注册入口等待同一个 promise，避免摘要尚未完成时丢失首触。
let capture: Promise<void> | undefined;
export function captureRegistrationFirstTouch(): Promise<void> {
  capture ??= captureFirstTouch();
  return capture;
}

async function captureFirstTouch(): Promise<void> {
  try {
    if (readFirstTouch()) return;
    const current = new URL(window.location.href);
    const landingPath = attributionLandingPath(current.pathname);
    if (!landingPath || current.searchParams.get("error")?.startsWith("oauth_")) return;
    let referrerHost: string | undefined;
    try {
      const referrer = new URL(document.referrer);
      if (referrer.protocol === "http:" || referrer.protocol === "https:") referrerHost = cleanHost(referrer.hostname);
    } catch { /* 缺省 referrer 仍是有效的直接访问采集。 */ }
    const first: RegistrationFirstTouch = {
      utmSource: label(current.searchParams.get("utm_source")),
      utmMedium: label(current.searchParams.get("utm_medium")),
      utmCampaign: label(current.searchParams.get("utm_campaign")),
      referrerHost, landingPath, capturedAt: new Date().toISOString(),
    };
    const token = current.pathname.split("/")[2];
    if (landingPath === "/share/:token" && shareToken.test(token) && globalThis.crypto?.subtle) {
      const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
      first.shareSourceKey = Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    // 摘要期间另一个标签页可能已经保存了首触。
    if (!readFirstTouch()) window.localStorage.setItem(storageKey, JSON.stringify(first));
  } catch { /* 存储不可用时省略归因，注册仍正常进行。 */ }
}

export function shareRegistrationHref(path: string): string {
  const search = new URLSearchParams({ redirectTo: path });
  const token = path.match(/^\/share\/([a-f0-9]{32})\/?$/)?.[1];
  if (token) search.set("shareSignupToken", token);
  return `/register?${search}`;
}

export async function registrationContext() {
  await captureRegistrationFirstTouch();
  const token = new URLSearchParams(window.location.search).get("shareSignupToken") ?? "";
  return {
    firstTouch: readFirstTouch(),
    shareSignupToken: shareToken.test(token) ? token : undefined,
  };
}
