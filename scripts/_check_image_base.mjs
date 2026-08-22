// 图片公开基址、CDN purge 配置与删除契约。平台差异部分见 verify_image_base.py。
import {
  handleImageConfig,
  handleImageDelete,
  handleImageGet,
  handleImageUpload,
  isCachePurgeConfigured,
  normalizeImageBase,
} from "./_image_base_bundle.mjs";

let pass = 0, fail = 0;
const check = (name, got, want) => {
  if (got === want) pass++;
  else { fail++; console.log(`FAIL  ${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); }
};

// 合法：应归一
check("裸域名带 scheme", normalizeImageBase("https://img.example.com"), "https://img.example.com");
check("末尾斜杠去掉", normalizeImageBase("https://img.example.com/"), "https://img.example.com");
check("多个末尾斜杠", normalizeImageBase("https://img.example.com///"), "https://img.example.com");
check("http 也允许", normalizeImageBase("http://img.example.com"), "http://img.example.com");
check("保留子路径", normalizeImageBase("https://img.example.com/assets"), "https://img.example.com/assets");
check("子路径去末尾斜杠", normalizeImageBase("https://img.example.com/assets/"), "https://img.example.com/assets");
check("前后空白", normalizeImageBase("  https://img.example.com  "), "https://img.example.com");
check("带端口", normalizeImageBase("https://img.example.com:8443"), "https://img.example.com:8443");
check("大写 scheme", normalizeImageBase("HTTPS://img.example.com"), "https://img.example.com");

// 非法：应返回 null，由调用方回落到 Worker 代理
check("空串", normalizeImageBase(""), null);
check("纯空白", normalizeImageBase("   "), null);
check("undefined", normalizeImageBase(undefined), null);
check("缺 scheme", normalizeImageBase("img.example.com"), null);
check("缺 scheme 带斜杠", normalizeImageBase("img.example.com/"), null);
check("协议相对", normalizeImageBase("//img.example.com"), null);
check("ftp", normalizeImageBase("ftp://img.example.com"), null);
check("带查询串", normalizeImageBase("https://img.example.com?v=1"), null);
check("带 fragment", normalizeImageBase("https://img.example.com#x"), null);
check("只有 scheme", normalizeImageBase("https://"), null);
check("data URL", normalizeImageBase("data:image/png;base64,AAA"), null);
check("javascript 伪协议", normalizeImageBase("javascript:alert(1)"), null);

// CDN 模式必须同时有 zone 与最小权限 purge token；Worker 代理模式不需要。
check(
  "purge 两项齐全",
  isCachePurgeConfigured({
    CLOUDFLARE_ZONE_ID: "zone",
    CLOUDFLARE_CACHE_PURGE_TOKEN: "token",
  }),
  true,
);
check(
  "purge 缺 token",
  isCachePurgeConfigured({ CLOUDFLARE_ZONE_ID: "zone" }),
  false,
);

{
  const response = handleImageConfig({
    IMAGE_PUBLIC_BASE: "https://img.example.com",
  });
  const body = await response.json();
  check("CDN 缺 purge 配置时自查失败", response.status, 503);
  check("自查指出 purge 未配置", body.purgeConfigured, false);
}

{
  const response = handleImageConfig({
    IMAGE_PUBLIC_BASE: "https://img.example.com",
    CLOUDFLARE_ZONE_ID: "zone",
    CLOUDFLARE_CACHE_PURGE_TOKEN: "token",
  });
  const body = await response.json();
  check("CDN purge 配置齐全时自查成功", response.status, 200);
  check("自查指出 purge 已配置", body.purgeConfigured, true);
}

const imageKey = "u/alice/aaaaaaaa11111111.png";
const publicAliasPath = "cases/ai-optimization/reader-response.png";
const publicImageKey = "public/cases/ai-optimization/reader-response.png";
const publicLegacyKey = "u/google_104742467398561921274/78b22503abbb4824b837fe21ff7ab072.png";
const deleteRequest = (keys = [imageKey]) =>
  new Request("https://app.example.com/api/images/delete", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-koinote-internal-token": "internal",
    },
    body: JSON.stringify({ keys }),
  });

{
  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
  ]);
  const stored = new Map();
  const recorded = [];
  let puts = 0;
  const bucket = {
    head: async (key) => stored.get(key) ?? null,
    put: async (key, value) => {
      puts += 1;
      stored.set(key, { size: value.byteLength });
    },
    delete: async (key) => stored.delete(key),
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/auth/session") {
      return Response.json({ user: { authUserId: "alice" } });
    }
    if (path === "/api/images/record") {
      recorded.push(JSON.parse(String(init?.body)));
      return Response.json({});
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  const upload = () =>
    handleImageUpload(
      new Request("https://app.example.com/api/images", {
        method: "POST",
        headers: {
          cookie: "session=test",
          "content-type": "image/png",
          "x-koinote-image-purpose": "wechat-export",
        },
        body: png,
      }),
      {
        BACKEND_URL: "https://backend.example.com",
        BACKEND_INTERNAL_TOKEN: "internal",
        IMAGES: bucket,
      },
    );
  try {
    const first = await upload();
    const firstBody = await first.json();
    const second = await upload();
    const secondBody = await second.json();
    check("公式图首次上传成功", first.status, 200);
    check("相同公式图再次上传成功", second.status, 200);
    check("相同公式图只写一次 R2", puts, 1);
    check("相同字节跨请求使用同一 key", firstBody.image.key, secondBody.image.key);
    check(
      "内容寻址 key 使用 SHA-256",
      firstBody.image.key.split("/").pop().split(".")[0].length,
      64,
    );
    check("公式图两次都续期", recorded.length, 2);
    check("公式图记账带临时用途", recorded[0].purpose, "wechat-export");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
  ]);
  let deleted = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({ user: { authUserId: "alice" } });
  try {
    const response = await handleImageUpload(
      new Request("https://app.example.com/api/images", {
        method: "POST",
        headers: {
          cookie: "session=test",
          "content-type": "image/png",
          "x-koinote-image-purpose": "wechat-export",
        },
        body: png,
      }),
      {
        BACKEND_URL: "https://backend.example.com",
        IMAGES: {
          head: async () => null,
          put: async () => {},
          delete: async () => {
            deleted += 1;
          },
        },
      },
    );
    check("公式图缺记账令牌时拒绝", response.status, 503);
    check("公式图缺记账令牌时回滚 R2", deleted, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

for (const quotaCase of [
  {
    name: "主配额",
    backend: {
      code: "image_quota_exceeded",
      usedBytes: 500,
      documentBytes: 200,
      imageBytes: 300,
      quotaBytes: 500,
    },
  },
  {
    name: "临时导出配额",
    backend: {
      code: "temporary_image_quota_exceeded",
      quotaBytes: 100,
    },
  },
]) {
  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
  ]);
  let deleted = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/auth/session") {
      return Response.json({ user: { authUserId: "alice" } });
    }
    if (path === "/api/images/record") {
      return Response.json(quotaCase.backend, { status: 409 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const response = await handleImageUpload(
      new Request("https://app.example.com/api/images", {
        method: "POST",
        headers: {
          cookie: "session=test",
          "content-type": "image/png",
          "x-koinote-image-purpose":
            quotaCase.backend.code === "temporary_image_quota_exceeded"
              ? "wechat-export"
              : "persistent",
        },
        body: png,
      }),
      {
        BACKEND_URL: "https://backend.example.com",
        BACKEND_INTERNAL_TOKEN: "internal",
        IMAGES: {
          head: async () => null,
          put: async () => {},
          delete: async () => {
            deleted += 1;
          },
        },
      },
    );
    const body = await response.json();
    check(`${quotaCase.name}上传返回 413`, response.status, 413);
    check(`${quotaCase.name}错误码不被折叠`, body.code, quotaCase.backend.code);
    check(`${quotaCase.name}保留 quotaBytes`, body.quotaBytes, quotaCase.backend.quotaBytes);
    check(`${quotaCase.name}回滚新写入对象`, deleted, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const png = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
  ]);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    if (path === "/api/auth/session") {
      return Response.json({ user: { authUserId: "alice" } });
    }
    if (path === "/api/images/record") {
      return new Response("broken response", { status: 409 });
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  try {
    const response = await handleImageUpload(
      new Request("https://app.example.com/api/images", {
        method: "POST",
        headers: {
          cookie: "session=test",
          "content-type": "image/png",
        },
        body: png,
      }),
      {
        BACKEND_URL: "https://backend.example.com",
        BACKEND_INTERNAL_TOKEN: "internal",
        IMAGES: {
          put: async () => {},
          delete: async () => {},
        },
      },
    );
    const body = await response.json();
    check("损坏的 409 仍拒绝上传", response.status, 413);
    check("损坏的持久配额响应安全回落", body.code, "image_quota_exceeded");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  let r2Deletes = 0;
  const response = await handleImageDelete(deleteRequest(), {
    BACKEND_INTERNAL_TOKEN: "internal",
    IMAGE_PUBLIC_BASE: "https://img.example.com",
    IMAGES: { delete: async () => { r2Deletes += 1; } },
  });
  check("缺 purge 配置时删除返回 503", response.status, 503);
  check("缺 purge 配置时不会先删 R2", r2Deletes, 0);
}

{
  const imageKey = "u/alice/aaaaaaaa11111111.png";
  const originalFetch = globalThis.fetch;
  let fetchedURL = "";
  let fetchedMethod = "";
  globalThis.fetch = async (url, init) => {
    fetchedURL = String(url);
    fetchedMethod = init?.method ?? "GET";
    return new Response(new Uint8Array([137, 80, 78, 71]), {
      headers: {
        "content-type": "image/png",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  };
  try {
    const response = await handleImageGet(
      new Request(`http://localhost:8788/images/${imageKey}?__koinote_retry=1`),
      {
        IMAGE_READ_FALLBACK_BASE: "https://img.koinote.app",
        IMAGES: { get: async () => null },
      },
    );
    check("本地 R2 缺图时回源成功", response.status, 200);
    check("回源保留图片类型", response.headers.get("content-type"), "image/png");
    check(
      "回源地址保留重试参数",
      fetchedURL,
      `https://img.koinote.app/${imageKey}?__koinote_retry=1`,
    );
    check("回源沿用原请求方法", fetchedMethod, "GET");

    fetchedURL = "";
    const aliased = await handleImageGet(
      new Request(`http://localhost:8788/images/${publicAliasPath}`),
      {
        IMAGE_READ_FALLBACK_BASE: "https://img.koinote.app",
        IMAGES: {
          head: async () => null,
          get: async () => null,
        },
      },
    );
    check("公开案例图片别名可读取", aliased.status, 200);
    check(
      "公开案例图片别名解析到既有对象",
      fetchedURL,
      `https://img.koinote.app/${publicLegacyKey}`,
    );

    fetchedURL = "";
    const prototypeKey = await handleImageGet(
      new Request("http://localhost:8788/images/constructor"),
      {
        IMAGE_READ_FALLBACK_BASE: "https://img.koinote.app",
        IMAGES: { get: async () => null },
      },
    );
    check("图片别名查表不命中对象原型链", prototypeKey.status, 404);
    check("对象原型名称不会触发回源", fetchedURL, "");

    fetchedURL = "";
    const rejected = await handleImageGet(
      new Request("http://localhost:8788/images/not-an-owned-image.png"),
      {
        IMAGE_READ_FALLBACK_BASE: "https://img.koinote.app",
        IMAGES: { get: async () => null },
      },
    );
    check("非法 key 不会触发回源", rejected.status, 404);
    check("非法 key 没有外部请求", fetchedURL, "");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

{
  const operations = [];
  const imageObject = (key) => ({
    key,
    size: 4,
    httpEtag: '"etag"',
    httpMetadata: {
      contentType: "image/png",
      cacheControl: "public, max-age=31536000, immutable",
    },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([137, 80, 78, 71]));
        controller.close();
      },
    }),
    writeHttpMetadata(headers) {
      headers.set("content-type", "image/png");
      headers.set("cache-control", "public, max-age=31536000, immutable");
    },
  });
  let publicStored = false;
  const bucket = {
    head: async (key) => publicStored && key === publicImageKey ? imageObject(key) : null,
    get: async (key) => {
      if (key === publicLegacyKey) return imageObject(key);
      if (publicStored && key === publicImageKey) return imageObject(key);
      return null;
    },
    put: async (key) => {
      operations.push(`put:${key}`);
      publicStored = true;
    },
    delete: async (keys) => {
      operations.push(`delete:${Array.isArray(keys) ? keys.join(",") : keys}`);
    },
  };

  const read = await handleImageGet(
    new Request(`http://localhost:8788/images/${publicAliasPath}`),
    { IMAGES: bucket },
  );
  check("公开案例首次读取迁移到公共对象", read.status, 200);
  check("公开案例写入稳定公共 key", operations[0], `put:${publicImageKey}`);

  publicStored = false;
  operations.length = 0;
  const removed = await handleImageDelete(deleteRequest([publicLegacyKey]), {
    BACKEND_INTERNAL_TOKEN: "internal",
    IMAGES: bucket,
  });
  check("旧用户图片删除前先保存公共副本", removed.status, 200);
  check("删除前公共副本先写入", operations[0], `put:${publicImageKey}`);
  check("公共副本写入后才删除旧对象", operations[1], `delete:${publicLegacyKey}`);
}

{
  let deleted = 0;
  const response = await handleImageDelete(deleteRequest([publicLegacyKey]), {
    BACKEND_INTERNAL_TOKEN: "internal",
    IMAGES: {
      head: async () => null,
      get: async () => ({
        body: new ReadableStream(),
        httpMetadata: { contentType: "image/png" },
      }),
      put: async () => {
        throw new Error("R2 write failed");
      },
      delete: async () => {
        deleted += 1;
      },
    },
  });
  check("公共副本迁移失败时删除返回 503", response.status, 503);
  check("公共副本迁移失败时保留旧对象", deleted, 0);
}

{
  const operations = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    operations.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return Response.json({ success: true });
  };
  try {
    const response = await handleImageDelete(deleteRequest(), {
      BACKEND_INTERNAL_TOKEN: "internal",
      IMAGE_PUBLIC_BASE: "https://img.example.com",
      CLOUDFLARE_ZONE_ID: "zone",
      CLOUDFLARE_CACHE_PURGE_TOKEN: "purge-token",
      IMAGES: { delete: async () => { operations.push({ r2: imageKey }); } },
    });
    const body = await response.json();
    check("删除与 purge 成功", response.status, 200);
    check("响应逐项返回 deleted key", JSON.stringify(body.deleted), JSON.stringify([imageKey]));
    check("先删 R2 再 purge", "r2" in operations[0], true);
    check(
      "purge 使用完整公开 URL",
      operations[1].body.files[0],
      `https://img.example.com/${imageKey}`,
    );
    check("purge 同时清理 3 个重试变体", operations[1].body.files.length, 4);
    check(
      "purge 重试变体与前端参数一致",
      operations[1].body.files[3],
      `https://img.example.com/${imageKey}?__koinote_retry=3`,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
