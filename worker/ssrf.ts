/**
 * 服务端代抓图片的目标地址校验。
 *
 * 为什么需要这个：浏览器受 CORS 限制读不到跨站图片的字节，所以「把网页上复制来的图
 * 片转存进图床」只能由服务端代抓。而一个「给我个 URL 我去抓」的端点就是 SSRF 原语 ——
 * 攻击者拿它探内网、打云元数据接口（169.254.169.254 上是 IAM 凭证）。
 *
 * 线上 Worker 的 fetch 走 Cloudflare 边缘，本来就到不了你的内网；但 wrangler dev 下
 * fetch 是从本机发出的，localhost 和内网都通。所以校验不能省。
 *
 * 全部做成纯函数：这里判错的代价是内网可达，而错了不会有任何可见症状 —— 只能靠断言。
 */

export type UrlVerdict =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

/** 允许的端口。图片就该在标准端口上，放开其它端口等于送一个内网端口扫描器 */
const ALLOWED_PORTS = new Set(["", "80", "443"]);

/**
 * 判断一段十进制/十六进制/八进制数字是不是 IPv4 的某一段。
 *
 * http://2130706433/ 和 http://0x7f.1/ 都会被解析成 127.0.0.1 —— 只按点分十进制
 * 匹配的话这两种写法能直接绕过。
 */
function parseIPv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length === 0 || parts.length > 4) return null;

  const nums: number[] = [];
  for (const part of parts) {
    if (part === "") return null;
    let value: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) {
      value = parseInt(part.slice(2), 16);
    } else if (/^0[0-7]+$/.test(part)) {
      value = parseInt(part.slice(1), 8);
    } else if (/^\d+$/.test(part)) {
      value = parseInt(part, 10);
    } else {
      return null;
    }
    if (!Number.isFinite(value) || value < 0) return null;
    nums.push(value);
  }

  // a.b.c.d 之外的写法（a、a.b、a.b.c）最后一段是余下字节的合并值
  const last = nums[nums.length - 1];
  const maxLast = 256 ** (4 - nums.length + 1);
  if (last >= maxLast) return null;
  for (const n of nums.slice(0, -1)) {
    if (n > 255) return null;
  }

  const octets = nums.slice(0, -1);
  const rest: number[] = [];
  let remaining = last;
  for (let i = 0; i < 4 - octets.length; i += 1) {
    rest.unshift(remaining % 256);
    remaining = Math.floor(remaining / 256);
  }
  return [...octets, ...rest];
}

/** 私网 / 回环 / 链路本地 / 保留段。这些一律不允许 */
function isBlockedIPv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 私网
  if (a === 127) return true; // 回环
  if (a === 169 && b === 254) return true; // 链路本地，含云元数据 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true; // 私网
  if (a === 192 && b === 168) return true; // 私网
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF 保留
  if (a === 100 && b >= 64 && b <= 127) return true; // 运营商级 NAT
  if (a === 198 && (b === 18 || b === 19)) return true; // 基准测试段
  if (a >= 224) return true; // 组播与保留
  return false;
}

function isBlockedIPv6(host: string): boolean {
  // URL 里的 IPv6 带方括号，去掉再看
  const inner = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (inner === "::1" || inner === "::") return true; // 回环 / 未指定
  if (inner.startsWith("fe80")) return true; // 链路本地
  // fc00::/7 唯一本地地址
  if (/^f[cd]/.test(inner)) return true;

  // IPv4 映射地址：::ffff:127.0.0.1 会绕过上面所有分支，要按内嵌的 v4 再判一次
  const mapped = inner.match(/::ffff:(.+)$/);
  if (mapped) {
    const octets = parseIPv4(mapped[1]);
    if (octets) return isBlockedIPv4(octets);
    // ::ffff:7f00:1 这种十六进制写法
    const hex = mapped[1].match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const high = parseInt(hex[1], 16);
      const low = parseInt(hex[2], 16);
      return isBlockedIPv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
    }
  }
  return false;
}

/**
 * 明确拒掉的主机名。
 *
 * 只挡名字挡不住 DNS rebinding（攻击者自己的域名解析到 127.0.0.1），这里挡的是
 * 顺手就能试的那些。真正的兜底是线上 Worker 的 fetch 出不了 Cloudflare 边缘。
 */
const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata",
  "metadata.google.internal",
  "instance-data",
]);

/**
 * 校验一个待抓取的地址。
 *
 * 重定向的每一跳都要重新过这里 —— 一个公网 URL 可以 302 到 127.0.0.1，只校验首个
 * 地址等于没校验。
 */
export function checkFetchTarget(raw: string): UrlVerdict {
  const value = raw.trim();
  if (!value) return { ok: false, reason: "empty_url" };
  if (value.length > 2048) return { ok: false, reason: "url_too_long" };

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    // data: / file: / blob: / gopher: 之类一律拒
    return { ok: false, reason: "scheme_not_allowed" };
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    return { ok: false, reason: "port_not_allowed" };
  }
  // URL 里带凭证多半是想骗过只看字符串的校验
  if (url.username || url.password) {
    return { ok: false, reason: "credentials_not_allowed" };
  }

  const host = url.hostname.toLowerCase();
  if (!host) return { ok: false, reason: "invalid_url" };
  if (BLOCKED_HOSTNAMES.has(host)) {
    return { ok: false, reason: "host_not_allowed" };
  }
  // .local / .internal / .localhost 这类内网后缀
  if (/\.(local|internal|localhost|home|lan)$/.test(host)) {
    return { ok: false, reason: "host_not_allowed" };
  }

  if (host.includes(":") || host.startsWith("[")) {
    if (isBlockedIPv6(host)) return { ok: false, reason: "private_address" };
    return { ok: true, url };
  }

  const octets = parseIPv4(host);
  if (octets) {
    if (isBlockedIPv4(octets)) return { ok: false, reason: "private_address" };
    return { ok: true, url };
  }

  return { ok: true, url };
}
