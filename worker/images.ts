/**
 * 图床：上传到 R2，读取走公开域名或 Worker 代理。
 *
 * 为什么鉴权要回调 Go：Worker 自己不认识会话 cookie（签名密钥在后端），
 * 所以先带着原始 cookie 打一次 /api/auth/session，拿到用户身份再写 R2。
 * 图片字节本身不经过 VPS。
 */

import { checkFetchTarget } from "./ssrf";

export type ImagesEnv = {
  IMAGES: R2Bucket;
  BACKEND_URL: string;
  IMAGE_PUBLIC_BASE?: string;
  /** 本地模拟 R2 缺图时使用的只读回源；生产环境不配置 */
  IMAGE_READ_FALLBACK_BASE?: string;
  /** 后端调删除端点时用的共享令牌。缺省时删除端点一律 503 */
  BACKEND_INTERNAL_TOKEN?: string;
  /** R2 自定义域名所在 zone。CDN 模式删除对象时用于全局 purge */
  CLOUDFLARE_ZONE_ID?: string;
  /** 仅授予 Zone / Cache Purge 权限的 API token */
  CLOUDFLARE_CACHE_PURGE_TOKEN?: string;
};

const MAX_BYTES = 10 * 1024 * 1024; // 10 MiB
const IMAGE_PURPOSE_HEADER = "x-koinote-image-purpose";
type ImagePurpose = "persistent" | "wechat-export";
type QuotaErrorCode =
  | "image_quota_exceeded"
  | "temporary_image_quota_exceeded";

type RecordUsageResult =
  | { outcome: "ok" }
  | { outcome: "error" }
  | {
      outcome: "quota";
      code: QuotaErrorCode;
      usedBytes?: number;
      documentBytes?: number;
      imageBytes?: number;
      quotaBytes?: number;
    };

// 只放行这几种，且必须与实际文件头一致（见 sniffImageType）
const ALLOWED = new Map<string, string>([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["image/svg+xml", "svg"],
]);

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function errorCode(status: number, code: string, message: string): Response {
  return json(status, { code, error: message });
}

/** 报账请求的超时。后端就在同一片网络里，不该慢 */
const RECORD_TIMEOUT_MS = 5_000;

/**
 * 向后端报账：这个对象归谁、多少字节。
 *
 * 返回结构化结果。超额时必须保留后端错误码，否则主配额与临时导出配额会被折叠，
 * 前端无法给出正确的处理建议。
 *
 * 为什么在写 R2 之后才报账、而不是先问"还够不够"：
 *   先问后写的话，两次调用之间有窗口，并发上传各自都会得到"够"的答复。把判定放在
 *   后端那条 INSERT ... WHERE 里、写完再报，才能让配额判定是原子的。代价是超额时
 *   白写一次 R2，随后删掉 —— 那是超额路径，不是常规路径。
 */
async function recordUsage(
  key: string,
  bytes: number,
  authUserId: string,
  purpose: ImagePurpose,
  env: ImagesEnv,
): Promise<RecordUsageResult> {
  if (!env.BACKEND_INTERNAL_TOKEN) {
    if (purpose === "wechat-export") {
      console.warn("images: BACKEND_INTERNAL_TOKEN 未配置，无法安排临时图片回收");
      return { outcome: "error" };
    }
    // 普通正文图片仍优先可用性：配额是运营诉求，而配置缺失导致所有人不能贴图
    // 是更坏的故障。公式图不能走这条降级，因为没有回收任务就会永久泄漏。
    console.warn("images: BACKEND_INTERNAL_TOKEN 未配置，跳过用量记账");
    return { outcome: "ok" };
  }

  const url = new URL("/api/images/record", env.BACKEND_URL);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RECORD_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // 内部令牌 + 用户头：后端的 authUserIDFromRequest 认这一对
        "X-Koinote-Internal-Token": env.BACKEND_INTERNAL_TOKEN,
        "X-Auth-User-Id": authUserId,
      },
      body: JSON.stringify({ key, bytes, purpose }),
      signal: controller.signal,
    });
    if (resp.status === 409) {
      const fallbackCode: QuotaErrorCode =
        purpose === "wechat-export"
          ? "temporary_image_quota_exceeded"
          : "image_quota_exceeded";
      let body: Record<string, unknown>;
      try {
        body = (await resp.json()) as Record<string, unknown>;
      } catch {
        console.error("images: 记账配额响应不是合法 JSON");
        return { outcome: "quota", code: fallbackCode };
      }
      if (
        body.code !== "image_quota_exceeded" &&
        body.code !== "temporary_image_quota_exceeded"
      ) {
        console.error("images: 记账返回未知配额错误码", body.code);
        return { outcome: "quota", code: fallbackCode };
      }
      const result: RecordUsageResult = {
        outcome: "quota",
        code: body.code,
      };
      for (const field of [
        "usedBytes",
        "documentBytes",
        "imageBytes",
        "quotaBytes",
      ] as const) {
        const value = body[field];
        if (typeof value === "number" && Number.isFinite(value)) {
          result[field] = value;
        }
      }
      return result;
    }
    if (!resp.ok) {
      console.error(`images: 记账失败 ${resp.status}`);
      return { outcome: "error" };
    }
    return { outcome: "ok" };
  } catch (err) {
    console.error("images: 记账请求异常", err);
    return { outcome: "error" };
  } finally {
    clearTimeout(timer);
  }
}

/** 回调后端校验会话，返回 authUserId；未登录返回 null。 */
async function resolveUser(
  request: Request,
  env: ImagesEnv,
): Promise<string | null> {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;

  const sessionURL = new URL("/api/auth/session", env.BACKEND_URL);
  const resp = await fetch(sessionURL, {
    headers: { cookie, accept: "application/json" },
  });
  if (!resp.ok) return null;

  const data = (await resp.json()) as { user?: { authUserId?: string } };
  return data.user?.authUserId ?? null;
}

/**
 * 按文件头判断真实类型，不信任客户端的 Content-Type。
 * 只声明 image/png 却传上来一个 HTML，配上公开 bucket 就是储存型 XSS。
 */
function sniffImageType(bytes: Uint8Array): string | null {
  const startsWith = (...sig: number[]) =>
    sig.every((byte, i) => bytes[i] === byte);

  if (startsWith(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (startsWith(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (startsWith(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  // WEBP: "RIFF" .... "WEBP"
  if (
    startsWith(0x52, 0x49, 0x46, 0x46) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function randomKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function contentHash(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * 校验字节并写入 R2。上传与代抓共用。
 *
 * declared 是「声称的类型」：上传时来自请求头，代抓时来自上游响应头。两条路都必须
 * 与文件头一致才放行 —— 抽出来共用是为了防止其中一条路以后漏掉某道校验。
 */
async function storeImage(
  buffer: ArrayBuffer,
  declared: string,
  authUserId: string,
  env: ImagesEnv,
  purpose: ImagePurpose = "persistent",
): Promise<Response> {
  if (buffer.byteLength === 0) {
    return errorCode(400, "image_empty", "Empty image");
  }
  if (buffer.byteLength > MAX_BYTES) {
    return errorCode(413, "image_too_large", "Image is too large");
  }

  if (declared === "image/svg+xml") {
    // SVG 能内嵌脚本，公开 bucket 下等于储存型 XSS。
    // 直接拒掉比做净化可靠——净化 SVG 是个长期跟绕过赛跑的活。
    return errorCode(415, "image_svg_rejected", "SVG uploads are not allowed");
  }
  if (!ALLOWED.has(declared)) {
    return errorCode(415, "image_type_unsupported", "Unsupported image type");
  }

  const bytes = new Uint8Array(buffer);
  const sniffed = sniffImageType(bytes);
  if (!sniffed) {
    return errorCode(415, "image_type_unsupported", "Unsupported image type");
  }
  if (sniffed !== declared) {
    // 声明与实际不符，一律拒绝，避免类型混淆
    return errorCode(415, "image_type_mismatch", "Image type does not match its content");
  }

  const extension = ALLOWED.get(sniffed)!;
  // key 里带 authUserId 前缀：便于按用户列举与配额统计，也天然隔离
  const stem = purpose === "wechat-export" ? await contentHash(buffer) : randomKey();
  const key = `u/${authUserId}/${stem}.${extension}`;
  const existing = purpose === "wechat-export" ? await env.IMAGES.head(key) : null;

  if (!existing) {
    await env.IMAGES.put(key, buffer, {
      httpMetadata: {
        contentType: sniffed,
        cacheControl: "public, max-age=31536000, immutable",
      },
      customMetadata: { authUserId, purpose },
    });
  }

  // 报账。配额判定在后端（那条 INSERT ... WHERE 是原子的），这里只按结果行事
  const recorded = await recordUsage(
    key,
    buffer.byteLength,
    authUserId,
    purpose,
    env,
  );

  if (recorded.outcome === "quota") {
    // 超额：把刚写的对象删掉，别留下不计入账本的孤儿。
    // 删失败也只能记日志 —— 此时回收队列里没有它（那张表是删文档时才入队的），
    // 所以这是唯一的清理时机，失败就成了真正的孤儿对象
    try {
      await env.IMAGES.delete(key);
    } catch (err) {
      console.error(`images: 超额回滚删除失败，${key} 成为孤儿对象`, err);
    }
    return json(413, {
      code: recorded.code,
      error:
        recorded.code === "temporary_image_quota_exceeded"
          ? "Temporary image quota exceeded"
          : "Storage quota exceeded",
      ...(recorded.usedBytes !== undefined
        ? { usedBytes: recorded.usedBytes }
        : {}),
      ...(recorded.documentBytes !== undefined
        ? { documentBytes: recorded.documentBytes }
        : {}),
      ...(recorded.imageBytes !== undefined
        ? { imageBytes: recorded.imageBytes }
        : {}),
      ...(recorded.quotaBytes !== undefined
        ? { quotaBytes: recorded.quotaBytes }
        : {}),
    });
  }

  if (recorded.outcome === "error") {
    if (purpose === "wechat-export") {
      if (!existing) {
        try {
          await env.IMAGES.delete(key);
        } catch (err) {
          console.error(`images: 临时对象记账失败且回滚失败，${key} 成为孤儿对象`, err);
        }
      }
      return errorCode(
        503,
        "image_record_failed",
        "Could not schedule temporary image cleanup",
      );
    }
    // 报账失败但对象已经写进去了。放行 —— 此时用量会少算这一张。
    // 反过来（删掉并报错）会让后端抖一下就贴不了图，那更糟。
    // 少算的后果是配额略微宽松，且可以靠对账补回来
    console.warn(`images: ${key} 已写入但未计入用量`);
  }

  return json(200, {
    image: {
      key,
      url: publicURL(key, env),
      size: buffer.byteLength,
      contentType: sniffed,
    },
  });
}

/** POST /api/images —— 上传一张图 */
export async function handleImageUpload(
  request: Request,
  env: ImagesEnv,
): Promise<Response> {
  const authUserId = await resolveUser(request, env);
  if (!authUserId) {
    return errorCode(401, "unauthorized", "Not logged in");
  }

  const declared = (request.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  // SVG 要走 storeImage 里那条专门的错误码，不能在这里被当成「不支持的类型」吞掉
  if (!ALLOWED.has(declared)) {
    return errorCode(415, "image_type_unsupported", "Unsupported image type");
  }

  // Content-Length 先挡一道，省得白读大文件
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_BYTES) {
    return errorCode(413, "image_too_large", "Image is too large");
  }

  // 真实长度由 storeImage 再挡一道：Content-Length 可以撒谎
  const buffer = await request.arrayBuffer();
  const purposeHeader = request.headers.get(IMAGE_PURPOSE_HEADER) ?? "persistent";
  if (purposeHeader !== "persistent" && purposeHeader !== "wechat-export") {
    return errorCode(400, "bad_request", "Invalid image purpose");
  }
  return storeImage(buffer, declared, authUserId, env, purposeHeader);
}

/** 代抓时最多跟几跳重定向。图床类地址正常一两跳就到 */
const MAX_REDIRECTS = 3;
/** 上游超时。卡住的目标不能拖着 Worker 的请求配额 */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * POST /api/images/fetch —— 代抓一个外链图片并转存进 R2。
 *
 * 为什么要服务端代抓：浏览器读不到跨站图片的字节（CORS），所以「从网页复制粘贴的图
 * 片转存进图床」在前端做不到。
 *
 * 这个端点是 SSRF 原语，防护见 ssrf.ts。除了地址校验，这里还做三件事：
 *   - 手动跟重定向，每一跳都重新校验（公网 URL 可以 302 到 127.0.0.1）
 *   - 边读边计长度，不信 Content-Length（它可以撒谎，也可能没有）
 *   - 超时，否则慢速上游能一直占着请求
 */
export async function handleImageFetch(
  request: Request,
  env: ImagesEnv,
): Promise<Response> {
  const authUserId = await resolveUser(request, env);
  if (!authUserId) {
    return errorCode(401, "unauthorized", "Not logged in");
  }

  let body: { url?: string };
  try {
    body = (await request.json()) as { url?: string };
  } catch {
    return errorCode(400, "bad_request", "Invalid request");
  }

  const verdict = checkFetchTarget(body.url ?? "");
  if (!verdict.ok) {
    // 原因回给前端只为便于排查，不含任何探测到的内网信息
    return errorCode(400, "image_fetch_rejected", `Refused to fetch: ${verdict.reason}`);
  }

  let target = verdict.url;
  let response: Response | null = null;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let hopResponse: Response;
    try {
      hopResponse = await fetch(target.toString(), {
        method: "GET",
        redirect: "manual", // 自己跟，才能逐跳校验
        headers: {
          // 有些站按 Accept 返回不同格式；也有站没有 UA 就 403
          accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/*,*/*;q=0.5",
          "user-agent": "koinote-image-fetcher",
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch {
      // DNS 失败、连接被拒、超时都到这里。不回传底层错误 —— 那本身就是内网探测信号
      return errorCode(502, "image_fetch_failed", "Could not fetch that image");
    }

    const location = hopResponse.headers.get("location");
    const isRedirect = hopResponse.status >= 300 && hopResponse.status < 400;
    if (!isRedirect || !location) {
      response = hopResponse;
      break;
    }
    if (hop === MAX_REDIRECTS) {
      return errorCode(502, "image_fetch_failed", "Too many redirects");
    }

    // 相对 Location 要按当前地址解析
    let next: string;
    try {
      next = new URL(location, target).toString();
    } catch {
      return errorCode(502, "image_fetch_failed", "Bad redirect");
    }
    // 关键：重定向后的地址重新过一遍校验
    const hopVerdict = checkFetchTarget(next);
    if (!hopVerdict.ok) {
      return errorCode(
        400,
        "image_fetch_rejected",
        `Refused to follow redirect: ${hopVerdict.reason}`,
      );
    }
    target = hopVerdict.url;
  }

  if (!response) {
    return errorCode(502, "image_fetch_failed", "Could not fetch that image");
  }
  if (!response.ok) {
    return errorCode(502, "image_fetch_failed", "Could not fetch that image");
  }

  // Content-Length 若在且超限，直接拒，省得白读
  const advertised = Number(response.headers.get("content-length") ?? "0");
  if (advertised > MAX_BYTES) {
    return errorCode(413, "image_too_large", "Image is too large");
  }

  const buffer = await readCapped(response, MAX_BYTES);
  if (buffer === null) {
    return errorCode(413, "image_too_large", "Image is too large");
  }

  const declared = (response.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();

  // 上游的 Content-Type 常常是错的或缺失的（尤其 CDN 上的图）。storeImage 会按文件头
  // 复核，所以这里在缺失/不认识时改用嗅探结果，而不是直接拒 —— 否则很多正常图抓不回来
  const sniffed = sniffImageType(new Uint8Array(buffer));
  const effective = ALLOWED.has(declared) ? declared : (sniffed ?? declared);

  return storeImage(buffer, effective, authUserId, env);
}

/**
 * 读取响应体，超过 limit 就放弃并返回 null。
 *
 * 不用 arrayBuffer()：那会先把整个响应读进内存，一个声称 1KB 实际发 1GB 的上游就能
 * 把 Worker 打爆。这里边读边算，超了立刻断开。
 */
async function readCapped(
  response: Response,
  limit: number,
): Promise<ArrayBuffer | null> {
  const body = response.body;
  if (!body) return new ArrayBuffer(0);

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }

  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out.buffer;
}

/**
 * 校验并归一 IMAGE_PUBLIC_BASE。配错时返回 null，由调用方回落到 Worker 代理。
 *
 * scheme 用正则显式卡一道，虽然 new URL() 对无 scheme 的输入本来就会抛
 * TypeError（workerd 与 Node 在这点上一致，实测过）。留着它是为了让「必须带
 * https://」成为读代码就看得见的约束，而不是依赖构造器的抛异常行为。
 *
 * 为什么配错不抛错而是回落：回落到 Worker 代理图片照样能显示，只是多消耗一个
 * 请求。抛错会让上传直接失败，那是更坏的结果。代价是「配错了但看起来正常」，
 * 所以另有 /api/images/config 自查端点把 warning 暴露出来。
 */
export function normalizeImageBase(raw: string | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;

  // 必须带 scheme。workerd 会替你补 https:// 而不报错，这里不能依赖它
  if (!/^https?:\/\//i.test(value)) return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!url.hostname) return null;
  // 查询串与 fragment 拼在 key 前面会得到废地址，直接判为配错
  if (url.search || url.hash) return null;

  // 保留 pathname：R2 自定义域名允许挂子路径。去掉末尾斜杠避免出现 //
  const path = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${path}`;
}

export function isCachePurgeConfigured(env: ImagesEnv): boolean {
  return Boolean(
    env.CLOUDFLARE_ZONE_ID?.trim() &&
      env.CLOUDFLARE_CACHE_PURGE_TOKEN?.trim(),
  );
}

type CachePurgeResponse = {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
};

const CACHE_PURGE_TIMEOUT_MS = 10_000;
const CACHE_PURGE_MAX_URLS = 100;
// 与 ImageNodeView 的 MAX_IMAGE_RETRIES 对齐。重试 URL 也可能缓存到 CDN，删除时
// 必须一起 purge，不能只清没有查询串的原始 URL。
const IMAGE_RETRY_CACHE_VARIANTS = 3;

function imageCacheURLs(base: string, key: string): string[] {
  const canonical = `${base}/${key}`;
  const urls = [canonical];
  for (let attempt = 1; attempt <= IMAGE_RETRY_CACHE_VARIANTS; attempt += 1) {
    urls.push(`${canonical}?__koinote_retry=${attempt}`);
  }
  return urls;
}

/** R2 自定义域名的 CDN 缓存不会随对象删除自动失效，必须按公开 URL 全局 purge。 */
async function purgeImageCache(keys: string[], env: ImagesEnv): Promise<boolean> {
  const base = normalizeImageBase(env.IMAGE_PUBLIC_BASE);
  if (!base || keys.length === 0) return true;

  const zoneId = env.CLOUDFLARE_ZONE_ID?.trim();
  const token = env.CLOUDFLARE_CACHE_PURGE_TOKEN?.trim();
  if (!zoneId || !token) return false;

  try {
    const urls = keys.flatMap((key) => imageCacheURLs(base, key));
    for (let offset = 0; offset < urls.length; offset += CACHE_PURGE_MAX_URLS) {
      const files = urls.slice(offset, offset + CACHE_PURGE_MAX_URLS);
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/purge_cache`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ files }),
          signal: AbortSignal.timeout(CACHE_PURGE_TIMEOUT_MS),
        },
      );
      const result = (await response.json()) as CachePurgeResponse;
      if (response.ok && result.success === true) continue;

      console.error(
        JSON.stringify({
          message: "images: CDN cache purge failed",
          status: response.status,
          errors: result.errors ?? [],
          keyCount: keys.length,
          urlCount: urls.length,
        }),
      );
      return false;
    }
    return true;
  } catch (error) {
    console.error(
      JSON.stringify({
        message: "images: CDN cache purge request failed",
        error: error instanceof Error ? error.message : String(error),
        keyCount: keys.length,
      }),
    );
    return false;
  }
}

/** 图片对外 URL：配了自定义域名走 CDN，否则回落到 Worker 代理 */
function publicURL(key: string, env: ImagesEnv): string {
  const base = normalizeImageBase(env.IMAGE_PUBLIC_BASE);
  if (base) return `${base}/${key}`;
  if ((env.IMAGE_PUBLIC_BASE ?? "").trim()) {
    // 配了但没通过校验 —— 日志里留痕，否则只会表现为账单上多出的请求数
    console.warn(
      `IMAGE_PUBLIC_BASE 配置无效，已回落到 Worker 代理: ${env.IMAGE_PUBLIC_BASE}`,
    );
  }
  return `/images/${key}`;
}

/**
 * GET /api/images/config —— 配置自查。
 *
 * 存在的理由：配错时系统回落到 Worker 代理，图片照样显示，
 * 所以「图片能看」证明不了 CDN 生效了。没有这个端点，只能等月底看账单。
 */
export function handleImageConfig(env: ImagesEnv): Response {
  const raw = (env.IMAGE_PUBLIC_BASE ?? "").trim();
  const base = normalizeImageBase(env.IMAGE_PUBLIC_BASE);
  const purgeRequired = base !== null;
  const purgeConfigured = !purgeRequired || isCachePurgeConfigured(env);
  const warning =
    raw && !base
      ? "IMAGE_PUBLIC_BASE 已设置但无效（需形如 https://img.example.com），已回落到 Worker 代理"
      : purgeRequired && !purgeConfigured
        ? "CDN 模式缺少 CLOUDFLARE_ZONE_ID 或 CLOUDFLARE_CACHE_PURGE_TOKEN，图片删除已暂停"
        : null;
  return json(purgeConfigured ? 200 : 503, {
    mode: base ? "cdn" : "worker-proxy",
    base,
    valid: base !== null,
    purgeRequired,
    purgeConfigured,
    warning,
  });
}

/**
 * POST /api/images/delete —— 后端的回收任务调它删 R2 对象。
 *
 * 鉴权用共享令牌而不是会话 cookie：调用方是后端的后台 goroutine，那时早已没有用户请求
 * 上下文了。令牌没配就一律 503 —— 开着一个无鉴权的删除端点比不能回收糟得多。
 *
 * 归属由后端负责判定（它才有数据库）。这里只做一道前缀形状校验兜底，防止传进来
 * `../` 之类的东西。
 */
export async function handleImageDelete(
  request: Request,
  env: ImagesEnv,
): Promise<Response> {
  const expected = (env.BACKEND_INTERNAL_TOKEN ?? "").trim();
  if (!expected) {
    console.warn("BACKEND_INTERNAL_TOKEN 未配置，图片删除端点已禁用");
    return errorCode(503, "not_configured", "Image deletion is not configured");
  }
  const presented = request.headers.get("x-koinote-internal-token") ?? "";
  if (!timingSafeEqual(presented, expected)) {
    return errorCode(401, "unauthorized", "Bad token");
  }

  let body: { keys?: unknown };
  try {
    body = (await request.json()) as { keys?: unknown };
  } catch {
    return errorCode(400, "bad_request", "Invalid request");
  }
  if (!Array.isArray(body.keys)) {
    return errorCode(400, "bad_request", "keys must be an array");
  }
  if (body.keys.length > 100) {
    return errorCode(400, "bad_request", "Too many keys");
  }

  const deleted: string[] = [];
  const rejected: string[] = [];
  for (const raw of body.keys) {
    if (typeof raw !== "string" || !isSafeImageKey(raw)) {
      rejected.push(String(raw));
      continue;
    }
    deleted.push(raw);
  }

  if (deleted.length > 0) {
    const base = normalizeImageBase(env.IMAGE_PUBLIC_BASE);
    if (base && !isCachePurgeConfigured(env)) {
      console.warn("CDN purge 未配置，拒绝删除 R2 对象以免公开地址继续返回陈旧缓存");
      return errorCode(
        503,
        "cache_purge_not_configured",
        "CDN cache purge is not configured",
      );
    }

    // R2 的 delete 对不存在的 key 也算成功，正好符合回收语义（重试要幂等）
    await env.IMAGES.delete(deleted);
    if (!(await purgeImageCache(deleted, env))) {
      // R2 已删但 CDN 清理失败。返回错误让后端保留队列与用量账本；下轮重试
      // R2 delete 与 purge 都是幂等的，恢复后会把这一步补齐。
      return errorCode(502, "cache_purge_failed", "Could not purge CDN cache");
    }
  }

  return json(200, { deleted, rejected });
}

/** key 必须形如 u/<id>/<hex>.<ext>，不含路径穿越 */
export function isSafeImageKey(key: string): boolean {
  if (!key || key.length > 256) return false;
  if (key.includes("..") || key.includes("//")) return false;
  return /^u\/[A-Za-z0-9_-]{1,128}\/[0-9a-f]{8,64}\.(png|jpg|gif|webp)$/.test(key);
}

async function readImageFallback(
  request: Request,
  key: string,
  env: ImagesEnv,
): Promise<Response | null> {
  const base = normalizeImageBase(env.IMAGE_READ_FALLBACK_BASE);
  if (!base || !isSafeImageKey(key)) return null;

  const requestURL = new URL(request.url);
  const sourceURL = `${base}/${key}${requestURL.search}`;
  let source: Response;
  try {
    source = await fetch(sourceURL, { method: request.method });
  } catch {
    return null;
  }
  const contentType = source.headers.get("content-type") ?? "";
  if (!source.ok || !contentType.toLowerCase().startsWith("image/")) {
    await source.body?.cancel();
    return null;
  }

  const headers = new Headers();
  for (const name of ["content-type", "cache-control", "etag", "last-modified"]) {
    const value = source.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("x-content-type-options", "nosniff");
  return new Response(request.method === "HEAD" ? null : source.body, { headers });
}

/** 常量时间比较，避免令牌被逐字符试出来 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * GET /images/<key> —— 未配自定义域名时的回落读取路径。
 * 公开可读（用户已选择公开 bucket 模式），key 随机不可枚举。
 */
export async function handleImageGet(
  request: Request,
  env: ImagesEnv,
): Promise<Response> {
  const url = new URL(request.url);
  const key = decodeURIComponent(url.pathname.replace(/^\/images\//, ""));
  if (!key || key.includes("..")) {
    return new Response("Not found", { status: 404 });
  }

  // HEAD 只需要元数据，不必把对象体拉出来
  if (request.method === "HEAD") {
    const head = await env.IMAGES.head(key);
    if (!head) {
      return (
        (await readImageFallback(request, key, env)) ??
        new Response(null, { status: 404 })
      );
    }
    const headers = new Headers();
    head.writeHttpMetadata(headers);
    headers.set("etag", head.httpEtag);
    headers.set("content-length", String(head.size));
    headers.set("x-content-type-options", "nosniff");
    if (!headers.has("cache-control")) {
      headers.set("cache-control", "public, max-age=31536000, immutable");
    }
    return new Response(null, { headers });
  }

  const object = await env.IMAGES.get(key);
  if (!object) {
    return (
      (await readImageFallback(request, key, env)) ??
      new Response("Not found", { status: 404 })
    );
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  // 防嗅探：即使内容被误判也不会被当作 HTML 执行
  headers.set("x-content-type-options", "nosniff");
  if (!headers.has("cache-control")) {
    headers.set("cache-control", "public, max-age=31536000, immutable");
  }

  return new Response(object.body, { headers });
}
