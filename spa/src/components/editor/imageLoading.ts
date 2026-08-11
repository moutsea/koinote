const KOINOTE_IMAGE_ORIGIN = "https://img.koinote.app";
const KOINOTE_IMAGE_PATH =
  /^\/u\/[A-Za-z0-9_-]{1,128}\/[0-9a-f]{8,64}\.(png|jpg|gif|webp)$/;

function withRetryQuery(src: string, attempt: number): string {
  const hashAt = src.indexOf("#");
  const beforeHash = hashAt >= 0 ? src.slice(0, hashAt) : src;
  const hash = hashAt >= 0 ? src.slice(hashAt) : "";
  const separator = beforeHash.includes("?") ? "&" : "?";
  return `${beforeHash}${separator}__koinote_retry=${attempt}${hash}`;
}

/**
 * Koinote 自有 CDN 加载失败时，改走同源 Worker 的 R2 读取路径。
 *
 * 某些本地代理会把 img.koinote.app 解析到 fake-IP/ULA 地址。Chrome 会把这种跨域
 * 子资源判为 local address space 并拦截，但同源的 /images/... 不受这条检查影响。
 * 只接受生产图床域名和合法对象 key，避免把任意外站图片误映射到站内路径。
 */
export function sameOriginImageFallback(src: string): string | null {
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (url.origin !== KOINOTE_IMAGE_ORIGIN) return null;
  if (!KOINOTE_IMAGE_PATH.test(url.pathname)) return null;
  return `/images${url.pathname}${url.search}${url.hash}`;
}

/**
 * 首次使用文档原地址；失败后的自有 CDN 图片走同源代理，其他图片只绕过失败缓存。
 * 这里只改实际显示地址，不修改文档里的 src。
 */
export function imageURLForAttempt(src: string, attempt: number): string {
  if (attempt <= 0) return src;
  return withRetryQuery(sameOriginImageFallback(src) ?? src, attempt);
}
