/**
 * 判断哪些图片地址需要转存进图床，纯函数。
 *
 * 背景：粘贴一段网页内容或一段 Markdown 时，里面的 <img src> / ![](url) 指向的是别人
 * 的服务器。不转存的话，对方删图或加防盗链，我们的文档就变成裂图。
 *
 * 抽出来的理由和 tree.ts 一样：判错的表现很隐蔽 —— 少转存一类地址，症状是几个月后
 * 某些文档的图挂掉；多转存一类（把自己的图又抓一遍）则是静默的重复上传和存储浪费。
 * 两种都不会在点击时暴露出来。
 */

/** 我们自己的对象 key 形状，与后端 image_keys.go、Worker isSafeImageKey 一致 */
const OWN_KEY = /\/u\/[A-Za-z0-9_-]{1,128}\/[0-9a-f]{8,64}\.(png|jpg|gif|webp)$/;

/**
 * 这个地址是不是已经在我们的图床里了。
 *
 * 两种形态都算：配了自定义域名的绝对地址，和回落到 Worker 代理的 /images/... 相对
 * 地址。前端读不到 IMAGE_PUBLIC_BASE，所以只按 key 的形状认，不比对域名 ——
 * 代价是别人站上一个恰好长成 /u/<hex>/<64位hex>.png 的地址会被误判为「已在图床」而
 * 不转存。这个形状足够特殊，实际不会撞上。
 */
export function isOwnImage(src: string): boolean {
  const value = src.trim();
  if (!value) return false;
  // 查询串和 fragment 不参与形状判断
  const path = value.split("?")[0].split("#")[0];
  return OWN_KEY.test(path);
}

/** data: URI（粘贴 Word/Google Docs 的内容时常见） */
export function isDataUri(src: string): boolean {
  return /^data:/i.test(src.trim());
}

/**
 * 需要经服务端代抓转存的地址。
 *
 * 只处理 http(s)。blob:/data:/file: 都不走代抓 —— blob 和 data 的字节本来就在本地，
 * 前端自己就能转成 File 上传（见 dataUriToFile）；file: 服务端也读不到。
 */
export function needsRehost(src: string): boolean {
  const value = src.trim();
  if (!value) return false;
  if (isOwnImage(value)) return false;
  if (!/^https?:\/\//i.test(value)) return false;
  return true;
}

/**
 * 从一段 HTML 里抽出所有 img 的 src，按出现顺序、去重。
 *
 * 用正则而不是 DOMParser：这里只要 src 的字面值，而 DOMParser 会把相对地址按当前页
 * 面解析成绝对地址 —— 那会把别人站上的 /photo.png 变成我们站上的地址，抓回来是 404
 * 或者更糟（抓到我们自己的页面）。
 */
export function imageSrcsFromHtml(html: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  // src 可能用单引号、双引号或不带引号
  const pattern = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/gi;
  for (const match of html.matchAll(pattern)) {
    const src = (match[1] ?? match[2] ?? match[3] ?? "").trim();
    if (!src || seen.has(src)) continue;
    seen.add(src);
    out.push(src);
  }
  return out;
}

/**
 * 把 data: URI 转成 File，交给普通上传接口。
 *
 * 为什么要单独处理：编辑器配了 allowBase64: false，粘贴带 base64 图的 HTML 时解析器
 * 会直接把这些节点丢掉 —— 图片无声消失。所以必须在解析前接手。
 *
 * 返回 null 表示这段 data URI 不是我们支持的图片，或者已经损坏。
 */
export function dataUriToFile(uri: string, index = 0): File | null {
  const match = /^data:([^;,]+)(;[^,]*)?,(.*)$/is.exec(uri.trim());
  if (!match) return null;
  const mime = match[1].toLowerCase();
  const isBase64 = (match[2] ?? "").toLowerCase().includes("base64");
  const payload = match[3];
  if (!mime.startsWith("image/")) return null;

  let bytes: Uint8Array;
  try {
    if (isBase64) {
      const binary = atob(payload);
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    } else {
      // 非 base64 的 data URI 是 URL 编码的
      const decoded = decodeURIComponent(payload);
      bytes = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i += 1) bytes[i] = decoded.charCodeAt(i);
    }
  } catch {
    // atob 遇到非法 base64 会抛
    return null;
  }
  if (bytes.byteLength === 0) return null;

  const ext = mime.split("/")[1]?.replace(/[^a-z0-9]/g, "") || "png";
  return new File([bytes as BlobPart], `pasted-${index + 1}.${ext}`, { type: mime });
}

/**
 * 在一段 HTML 里把若干 src 替换掉。
 *
 * 逐个精确替换属性值，而不是全文 replace(old, new)：src 的字面值可能在别处也出现
 * （比如同时写在 a[href] 里），全文替换会连带改掉不该改的地方。
 */
export function replaceImageSrcs(html: string, mapping: Map<string, string>): string {
  if (mapping.size === 0) return html;
  return html.replace(
    /(<img\b[^>]*?\bsrc\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s">]+))/gi,
    (whole, prefix: string, dq?: string, sq?: string, bare?: string) => {
      const src = (dq ?? sq ?? bare ?? "").trim();
      const next = mapping.get(src);
      if (!next) return whole;
      return `${prefix}"${next}"`;
    },
  );
}
