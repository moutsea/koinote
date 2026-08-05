/**
 * 图床：上传到 R2，读取走公开域名或 Worker 代理。
 *
 * 为什么鉴权要回调 Go：Worker 自己不认识会话 cookie（签名密钥在后端），
 * 所以先带着原始 cookie 打一次 /api/auth/session，拿到用户身份再写 R2。
 * 图片字节本身不经过 VPS。
 */

export type ImagesEnv = {
  IMAGES: R2Bucket;
  BACKEND_URL: string;
  IMAGE_PUBLIC_BASE?: string;
};

const MAX_BYTES = 10 * 1024 * 1024; // 10 MiB

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
  if (!ALLOWED.has(declared)) {
    return errorCode(415, "image_type_unsupported", "Unsupported image type");
  }

  // Content-Length 先挡一道，省得白读大文件
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > MAX_BYTES) {
    return errorCode(413, "image_too_large", "Image is too large");
  }

  const buffer = await request.arrayBuffer();
  // 真实长度再挡一道：Content-Length 可以撒谢
  if (buffer.byteLength === 0) {
    return errorCode(400, "image_empty", "Empty image");
  }
  if (buffer.byteLength > MAX_BYTES) {
    return errorCode(413, "image_too_large", "Image is too large");
  }

  const bytes = new Uint8Array(buffer);
  let contentType = declared;

  if (declared === "image/svg+xml") {
    // SVG 能内嵌脚本，公开 bucket 下等于储存型 XSS。
    // 直接拒掉比做净化可靠——净化 SVG 是个长期跟绕过赛跑的活。
    return errorCode(415, "image_svg_rejected", "SVG uploads are not allowed");
  }

  const sniffed = sniffImageType(bytes);
  if (!sniffed) {
    return errorCode(415, "image_type_unsupported", "Unsupported image type");
  }
  if (sniffed !== declared) {
    // 声明与实际不符，一律按实际类型走且拒绝，避免类型混淆
    return errorCode(415, "image_type_mismatch", "Image type does not match its content");
  }
  contentType = sniffed;

  const extension = ALLOWED.get(contentType)!;
  // key 里带 authUserId 前缀：便于按用户列举与配额统计，也天然隔离
  const key = `u/${authUserId}/${randomKey()}.${extension}`;

  await env.IMAGES.put(key, buffer, {
    httpMetadata: {
      contentType,
      // 内容不可变（key 随机且永不复用），放心长缓存
      cacheControl: "public, max-age=31536000, immutable",
    },
    customMetadata: { authUserId },
  });

  return json(200, {
    image: {
      key,
      url: publicURL(key, env),
      size: buffer.byteLength,
      contentType,
    },
  });
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
  return json(200, {
    mode: base ? "cdn" : "worker-proxy",
    base,
    valid: base !== null,
    warning:
      raw && !base
        ? "IMAGE_PUBLIC_BASE 已设置但无效（需形如 https://img.example.com），已回落到 Worker 代理"
        : null,
  });
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
    if (!head) return new Response(null, { status: 404 });
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
    return new Response("Not found", { status: 404 });
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
