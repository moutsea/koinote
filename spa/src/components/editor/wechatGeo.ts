export const WECHAT_GEO_MAX_CHARS = 2400;

const WECHAT_GEO_SECTION_STYLE =
  "height:0!important;margin:0!important;padding:0!important;overflow:hidden!important;width:100%;position:absolute!important;visibility:hidden!important;";

function truncateCodePoints(value: string, limit: number): string {
  const codePoints = Array.from(value);
  return codePoints.length <= limit ? value : codePoints.slice(0, limit).join("");
}

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function normalizeWechatGeoCorpus(value: string): string {
  const normalized = value
    .split(/\r?\n/)
    .map(normalizeLine)
    .filter(Boolean)
    .join("\n");
  return truncateCodePoints(normalized, WECHAT_GEO_MAX_CHARS);
}

export async function wechatGeoSourceHash(
  title: string,
  content: string,
): Promise<string> {
  const payload = new TextEncoder().encode(`${title.trim()}\u0000${content}`);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", payload);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function buildWechatGeoSection(corpus: string): string {
  const normalized = normalizeWechatGeoCorpus(corpus);
  if (!normalized) return "";
  return `<section style="${WECHAT_GEO_SECTION_STYLE}"><p style="margin:0!important;padding:0!important;">${escapeHTML(normalized)}</p></section>`;
}

function escapeHTML(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
