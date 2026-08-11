// 图片公开基址、CDN purge 配置与删除契约。平台差异部分见 verify_image_base.py。
import {
  handleImageConfig,
  handleImageDelete,
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
const deleteRequest = () =>
  new Request("https://app.example.com/api/images/delete", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-koinote-internal-token": "internal",
    },
    body: JSON.stringify({ keys: [imageKey] }),
  });

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
