const KOINOTE_IMAGE_ORIGIN = "https://img.koinote.app";
const KOINOTE_IMAGE_PATH =
  /^\/u\/([A-Za-z0-9_-]{1,128})\/([0-9a-f]{8,64})\.(png|jpg|gif|webp)$/;

function imageObjectKeyFromPath(pathname: string): string | null {
  const match = KOINOTE_IMAGE_PATH.exec(pathname);
  if (!match) return null;
  return `u/${match[1]}/${match[2]}.${match[3]}`;
}

/**
 * 只从可信 Koinote 图片地址提取 R2 object key。
 *
 * 绝对地址必须精确属于官方图床域名；相对地址必须是本站 Worker 的
 * `/images/u/...` 读取路径。不能只按路径末尾判断，否则任意外站都能伪装成站内图，
 * 诱导桌面客户端出网并污染本地缓存。
 */
export function koinoteImageObjectKey(src: string): string | null {
  const value = src.trim();
  if (!value) return null;
  if (value.startsWith("/images/")) {
    const suffixAt = value.search(/[?#]/);
    const pathname = value.slice(0, suffixAt >= 0 ? suffixAt : value.length);
    return imageObjectKeyFromPath(pathname.slice("/images".length));
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin !== KOINOTE_IMAGE_ORIGIN) return null;
  return imageObjectKeyFromPath(url.pathname);
}

function withRetryQuery(src: string, attempt: number): string {
  const hashAt = src.indexOf("#");
  const beforeHash = hashAt >= 0 ? src.slice(0, hashAt) : src;
  const hash = hashAt >= 0 ? src.slice(hashAt) : "";
  const separator = beforeHash.includes("?") ? "&" : "?";
  return `${beforeHash}${separator}__koinote_retry=${attempt}${hash}`;
}

/**
 * 把 Koinote 自有 CDN 地址映射为网页端使用的同源 Worker R2 读取路径。
 *
 * 某些本地代理会把 img.koinote.app 解析到 fake-IP/ULA 地址。Chrome 会把这种跨域
 * 子资源判为 local address space 并拦截，但同源的 /images/... 不受这条检查影响。
 * 这里只返回读取地址，不修改 TipTap 节点里的 src；正文持久化与导出内容里的地址
 * 仍保留 CDN 地址。
 * 只接受生产图床域名和合法对象 key，避免把任意外站图片误映射到站内路径。
 */
export function sameOriginImageURL(
  src: string,
  proxyOrigin?: string,
): string | null {
  let url: URL;
  try {
    url = new URL(src);
  } catch {
    return null;
  }
  if (url.origin !== KOINOTE_IMAGE_ORIGIN) return null;
  if (!imageObjectKeyFromPath(url.pathname)) return null;
  const path = `/images${url.pathname}${url.search}${url.hash}`;
  const origin = proxyOrigin?.replace(/\/+$/, "");
  return origin ? `${origin}${path}` : path;
}

/**
 * 返回浏览器/桌面客户端读取图片字节时使用的地址。
 *
 * 自有 CDN 没有开放给网页 fetch 的 CORS 响应头，直接读取会失败；改走同源 Worker
 * 代理后，Word/PDF 导出才能把图片真正内嵌。桌面网络层会把相对路径解析到远端
 * Koinote origin，因此网页与客户端可以共用这一条规则。
 */
export function imageFetchURL(src: string): string {
  return sameOriginImageURL(src) ?? src;
}

/**
 * 自有 CDN 图片从首次加载起就走同源代理；其他图片保持原地址，失败重试时绕过缓存。
 * 这里只改实际显示地址，不修改文档里的 src，因此导出内容仍保留 CDN 地址。
 */
export function imageURLForAttempt(
  src: string,
  attempt: number,
  proxyOrigin?: string,
): string {
  const displayURL = sameOriginImageURL(src, proxyOrigin) ?? src;
  if (attempt <= 0 || /^(?:data|blob):/i.test(displayURL)) return displayURL;
  return withRetryQuery(displayURL, attempt);
}
