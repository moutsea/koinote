import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import worker from "./_seo_bundle.mjs";
import { classifyPath, SEO_GUARD_SCRIPT, SEO_GUARD_SCRIPT_HASH } from "./_seo_routes_bundle.mjs";

// 用与 spa/index.html 同形的外壳，确认注入点（title/description/root）都能命中
const shell = readFileSync(new URL("../spa/index.html", import.meta.url), "utf8");
const originalFetch = globalThis.fetch;
const assetRequests = [];

function env(overrides = {}) {
  return {
    BACKEND_URL: "https://backend.example",
    BACKEND_INTERNAL_TOKEN: "internal",
    IMAGE_PUBLIC_BASE: "",
    ASSETS: {
      fetch: async (request) => {
        const url = new URL(request.url);
        assetRequests.push({ path: url.pathname, ifNoneMatch: request.headers.get("if-none-match") });
        // 与真实 ASSETS 一样：ETag 命中就回 304，没有正文
        if (request.headers.get("if-none-match") === '"shell"') {
          return new Response(null, { status: 304, headers: { etag: '"shell"' } });
        }
        if (url.pathname.startsWith("/assets/")) {
          return new Response("console.log(1)", { headers: { "content-type": "text/javascript" } });
        }
        return new Response(shell, { headers: { "content-type": "text/html", etag: '"shell"' } });
      },
    },
    ...overrides,
  };
}

const get = (path, headers = {}) =>
  worker.fetch(new Request(`https://koinote.app${path}`, { headers }), env());

const repositories = [
  { workspaceId: 7, name: "Writer <Skill>", description: "Edits $& drafts", updatedAt: "2026-10-01T00:00:00Z" },
  // 字段类型不对的条目必须被跳过，不能让 escapeHTML / slice 抛错拖垮整页
  { workspaceId: 8, name: null, description: 3, updatedAt: 20261001 },
  { workspaceId: "9", name: "String id" },
];
// sitemap 的仓库清单：远超 Hub 列表一页（12 个）乘以旧的翻页上限（10 页）
const sitemapFeed = [
  { workspaceId: 7, updatedAt: "2026-10-01T08:00:00+08:00" },
  ...Array.from({ length: 180 }, (_, index) => ({ workspaceId: 1000 + index, updatedAt: "2026-09-01T00:00:00Z" })),
  // 类型不对的条目跳过
  { workspaceId: "9" },
  { workspaceId: 0 },
  null,
];
let backendCalls = 0;
globalThis.fetch = async (input, init) => {
  backendCalls++;
  const url = new URL(input.url ?? input);
  const headers = new Headers(init?.headers);
  assert.equal(headers.get("x-koinote-internal-token"), "internal");
  assert.equal(init?.redirect, "manual", "带内部令牌的请求不能跟随跳转");
  if (url.pathname === "/api/agent/repositories/400") {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  if (url.pathname === "/api/agent/repositories/sitemap") {
    return Response.json({ repositories: sitemapFeed });
  }
  if (url.pathname === "/api/agent/repositories") {
    return Response.json({ repositories, nextCursor: null });
  }
  if (url.pathname === "/api/agent/repositories/7") {
    return Response.json({
      repository: { ...repositories[0], license: "MIT", files: [{ path: "SKILL.md" }] },
    });
  }
  if (url.pathname === "/api/billing/pricing") {
    return Response.json({
      pricing: { freeStorageQuotaBytes: 2 * 1024 * 1024 * 1024, lifetimeStorageQuotaBytes: 50 * 1024 * 1024 * 1024 },
    });
  }
  if (url.pathname === "/api/agent/repositories/404") {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  throw new Error(`Unexpected backend request ${url.pathname}`);
};

try {
  // robots.txt / sitemap.xml 不能再落到 SPA 外壳
  const robots = await get("/robots.txt");
  assert.equal(robots.status, 200);
  assert.match(robots.headers.get("content-type"), /text\/plain/);
  const robotsText = await robots.text();
  assert.match(robotsText, /Sitemap: https:\/\/koinote\.app\/sitemap\.xml/);
  // Google 渲染页面时遵守 robots.txt：挡了 /api/ 仓库页和价格页的数据就加载不出来
  assert.doesNotMatch(robotsText, /Disallow: \/api/);
  assert.match(robotsText, /^Disallow: \/mcp\$$/m, "只挡 /mcp 本身，不能连带 /mcp/activity");
  const previewRobots = await (await worker.fetch(new Request("https://koinote.example.workers.dev/robots.txt"), env())).text();
  assert.match(previewRobots, /^Disallow: \/$/m, "workers.dev 预览地址整站不收录");
  const previewPage = await worker.fetch(new Request("https://koinote.example.workers.dev/pricing"), env());
  assert.equal(previewPage.headers.get("x-robots-tag"), "noindex");
  assert.doesNotMatch(robotsText, /Disallow: \/editor/, "应用页靠 noindex，不能被 Disallow 挡住");

  const sitemap = await get("/sitemap.xml");
  assert.match(sitemap.headers.get("content-type"), /application\/xml/);
  const sitemapXml = await sitemap.text();
  for (const path of ["/", "/pricing", "/docs/mcp", "/changelog", "/privacy"]) {
    assert.ok(sitemapXml.includes(`<loc>https://koinote.app${path}</loc>`), `sitemap 缺少 ${path}`);
  }
  assert.ok(sitemapXml.includes("<loc>https://koinote.app/pricing?lang=ja</loc>"));
  assert.ok(sitemapXml.includes('hreflang="zh-CN" href="https://koinote.app/docs?lang=zh"'));
  assert.ok(sitemapXml.includes("<loc>https://koinote.app/repositories/7</loc><lastmod>2026-10-01</lastmod>"));
  assert.equal(
    (sitemapXml.match(/<loc>https:\/\/koinote\.app\/repositories\/\d+<\/loc>/g) ?? []).length,
    181,
    "sitemap 要列出后端给的全部仓库，不能停在前几页",
  );
  assert.doesNotMatch(sitemapXml, /repositories\/(0|9)</, "字段类型不对的仓库不进 sitemap");
  assert.doesNotMatch(sitemapXml, /\/editor|\/settings|\/share\//);

  // 公开页：按语言渲染独立的 meta 与正文
  const zhPricing = await get("/pricing?lang=zh", { "if-none-match": '"shell"' });
  assert.equal(zhPricing.status, 200, "条件请求头要剥掉，否则 304 没有正文可注入");
  assert.equal(zhPricing.headers.get("etag"), null);
  assert.equal(zhPricing.headers.get("x-robots-tag"), null);
  const zhHTML = await zhPricing.text();
  assert.match(zhHTML, /<html lang="zh-CN"/);
  assert.match(zhHTML, /<title>价格 — Koinote<\/title>/);
  assert.match(zhHTML, /<link rel="canonical" href="https:\/\/koinote\.app\/pricing\?lang=zh">/);
  assert.match(zhHTML, /hreflang="x-default" href="https:\/\/koinote\.app\/pricing"/);
  assert.match(zhHTML, /hreflang="ja" href="https:\/\/koinote\.app\/pricing\?lang=ja"/);
  assert.match(zhHTML, /<div id="root"><main class="seo-static"><h1>一次升级，长期安心写作<\/h1>/);
  // 容量来自后端 /api/billing/pricing，而不是写死的数字
  assert.match(zhHTML, /2 GB 云端存储/);
  assert.match(zhHTML, /50 GB 云端存储/);
  assert.doesNotMatch(zhHTML, /500 MB|10 GB/);
  assert.match(zhHTML, /<a href="\/docs\?lang=zh">/, "显式语言的站内链接要带上 lang");
  assert.match(zhHTML, /application\/ld\+json/);
  assert.equal((zhHTML.match(/<title>/g) ?? []).length, 1);
  assert.equal((zhHTML.match(/name="description"/g) ?? []).length, 1);

  // x-default：按 Accept-Language 选语言并声明 Vary
  const enHome = await get("/", { "accept-language": "en-US,en;q=0.9" });
  assert.equal(enHome.headers.get("vary"), "Accept-Language");
  const enHTML = await enHome.text();
  assert.match(enHTML, /<html lang="en"/);
  assert.match(enHTML, /<title>Koinote — Online Markdown Editor<\/title>/);
  assert.match(enHTML, /<link rel="canonical" href="https:\/\/koinote\.app\/">/);
  assert.match(enHTML, /"@type":"SoftwareApplication"/);
  assert.match(enHTML, /<a href="\/pricing">/);

  const weighted = await (await get("/docs", { "accept-language": "en;q=0.4, ja;q=0.9" })).text();
  assert.match(weighted, /<html lang="ja"/);
  const unknownLang = await (await get("/docs?lang=de", { "accept-language": "fr-FR" })).text();
  assert.match(unknownLang, /<html lang="fr"/, "不支持的 lang 参数回落到 Accept-Language");

  // 案例页：正文是页面实际显示的审阅前原文
  const caseHTML = await (await get("/docs/ai-optimization/case?lang=zh")).text();
  assert.match(caseHTML, /<title>烧了一千刀的在线 markdown，开源了 — Koinote<\/title>/);
  assert.match(caseHTML, /<h1>烧了一千刀的在线 markdown，开源了<\/h1>/);
  assert.match(caseHTML, /<img src="https:\/\/koinote\.app\/images\/cases\/ai-optimization\/reader-response\.png" alt="" loading="lazy">/);
  assert.match(caseHTML, /<code>claude<\/code>/);
  assert.match(caseHTML, /"name":"AI 优化指南","item":"https:\/\/koinote\.app\/docs\/ai-optimization"/);

  // 更新日志：渲染真实版本条目，不再只有标题
  const changelogHTML = await (await get("/changelog?lang=zh")).text();
  const latest = /^## \[(\d+\.\d+\.\d+)\]/m.exec(readFileSync(new URL("../CHANGELOG.zh.md", import.meta.url), "utf8"))[1];
  assert.ok(changelogHTML.includes(`<h2>v${latest}</h2>`), "缺少最新版本");
  assert.match(changelogHTML, /<h3>(修复|改进|新增)<\/h3><ul><li>/);
  assert.ok((changelogHTML.match(/<section><h2>v/g) ?? []).length <= 8, "最多渲染 8 个版本");
  assert.doesNotMatch(changelogHTML, /<h2>即将发布<\/h2>/, "空的 Unreleased 不渲染");
  assert.match(changelogHTML, /CHANGELOG\.zh\.md/);
  const enChangelog = await (await get("/changelog?lang=en")).text();
  assert.match(enChangelog, /<h3>(Fixed|Changed|Added)<\/h3>/);
  assert.doesNotMatch(enChangelog, /<h3>(修复|改进|新增)<\/h3>/);

  // 公开仓库：后端数据要转义，替换模式 $& 不能被展开
  const hub = await (await get("/repositories?lang=en")).text();
  assert.ok(hub.includes('<a href="/repositories/7">Writer &lt;Skill&gt;</a> — Edits $&amp; drafts'));
  assert.doesNotMatch(hub, /repositories\/(8|9)"/);
  const repository = await get("/repositories/7?lang=zh");
  assert.equal(repository.status, 200);
  const repositoryHTML = await repository.text();
  assert.match(repositoryHTML, /<title>Writer &lt;Skill&gt; — Skills\/Agent Hub — Koinote<\/title>/);
  assert.match(repositoryHTML, /<link rel="canonical" href="https:\/\/koinote\.app\/repositories\/7">/);
  assert.match(repositoryHTML, /许可证: MIT/);
  assert.match(repositoryHTML, /<li>SKILL\.md<\/li>/);
  assert.equal(repository.headers.get("vary"), null, "显式 lang 的仓库页内容固定");
  const negotiatedRepository = await get("/repositories/7", { "accept-language": "ja" });
  assert.equal(negotiatedRepository.headers.get("vary"), "Accept-Language");
  assert.match(await negotiatedRepository.text(), /<html lang="ja"/);
  const missingRepository = await get("/repositories/404");
  assert.equal(missingRepository.status, 404);
  assert.equal(missingRepository.headers.get("x-robots-tag"), "noindex");
  assert.equal((await get("/repositories/400")).status, 404, "后端判为非法的 ID 不能成为软 404");
  assert.equal((await get("/repositories/0")).status, 404);
  const zeroPadded = await get("/repositories/0007?lang=en");
  assert.equal(zeroPadded.status, 301);
  assert.equal(zeroPadded.headers.get("location"), "https://koinote.app/repositories/7?lang=en");

  // HEAD 没有正文，不该为正文去打后端
  backendCalls = 0;
  for (const path of ["/pricing", "/repositories", "/sitemap.xml"]) {
    await worker.fetch(new Request(`https://koinote.app${path}`, { method: "HEAD" }), env());
  }
  assert.equal(backendCalls, 0, "HEAD 请求打了后端");
  // 价格在 isolate 内缓存：同一后端的第二次渲染不再请求
  await get("/pricing?lang=en");
  backendCalls = 0;
  assert.match(await (await get("/pricing?lang=zh")).text(), /2 GB 云端存储/);
  assert.equal(backendCalls, 0, "价格应命中缓存");

  // 后端不可用时退回普通 SPA，不写错误状态
  globalThis.fetch = async () => { throw new Error("backend down"); };
  // 换一个后端地址，绕开上面的价格缓存
  const offlinePricing = await (
    await worker.fetch(new Request("https://koinote.app/pricing?lang=zh"), env({ BACKEND_URL: "https://down.example" }))
  ).text();
  assert.match(offlinePricing, /500 MB 云端存储/, "后端不可用时用与前端相同的兜底容量");
  assert.match(offlinePricing, /10 GB 云端存储/);
  // 后端挂起：超时后照常出页面，不会一直等
  globalThis.fetch = (_input, init) =>
    new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal.reason)));
  // Node 里 AbortSignal.timeout 的定时器不占事件循环，没有别的定时器时进程会提前退出
  const keepAlive = setTimeout(() => {}, 10_000);
  const started = Date.now();
  const hanging = await worker.fetch(new Request("https://koinote.app/repositories"), env({ BACKEND_URL: "https://slow.example" }));
  clearTimeout(keepAlive);
  assert.equal(hanging.status, 200);
  assert.ok(Date.now() - started < 2500, `后端挂起时等了 ${Date.now() - started}ms`);
  globalThis.fetch = async () => { throw new Error("backend down"); };
  const fallback = await get("/repositories/7");
  assert.equal(fallback.status, 200);
  assert.equal(fallback.headers.get("cache-control"), "no-store");
  assert.match(await fallback.text(), /<div id="root"><\/div>/);

  // 渲染中途抛错：退回原样的静态资源，而不是整页 500
  let shellCalls = 0;
  const flaky = env({
    ASSETS: {
      fetch: async () => {
        shellCalls++;
        if (shellCalls === 1) throw new Error("asset fetch failed");
        return new Response(shell, { headers: { "content-type": "text/html" } });
      },
    },
  });
  const recovered = await worker.fetch(new Request("https://koinote.app/docs"), flaky);
  assert.equal(recovered.status, 200);
  assert.match(await recovered.text(), /<div id="root"><\/div>/);

  // 应用页 noindex，未知路径真正 404，静态资源原样
  for (const path of ["/editor", "/editor/abc", "/settings", "/login", "/space/settings", "/share/not-a-token"]) {
    const response = await get(path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("x-robots-tag"), "noindex", path);
  }
  // 爬虫带旧 ETag 复查以前的软 404：必须拿到 404，而不是 304
  const revalidated = await get("/old-soft-404", { "if-none-match": '"shell"' });
  assert.equal(revalidated.status, 404);
  // 真实静态文件的条件请求仍然 304，浏览器缓存不受影响
  const cachedAsset = await get("/assets/index.js", { "if-none-match": '"shell"' });
  assert.equal(cachedAsset.status, 304);
  const missing = await get("/nonexistent-xyz", { "accept-language": "fr-FR" });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("x-robots-tag"), "noindex");
  const missingHTML = await missing.text();
  assert.match(missingHTML, /<div id="root"><main class="seo-static"><h1>Page introuvable<\/h1>/, "404 仍给 SPA 外壳，并带本地化说明");
  assert.match(missingHTML, /<title>Page introuvable — Koinote<\/title>/);
  assert.match(missingHTML, /<html lang="fr"/);
  assert.doesNotMatch(missingHTML, /rel="canonical"|og:title/, "404 不该带 canonical 或分享卡片");
  assert.equal(missing.headers.get("vary"), "Accept-Language");
  assert.equal((await get("/nope?lang=ja")).headers.get("vary"), null, "显式 lang 的 404 内容固定");
  const missingAsset = await get("/missing-image.png");
  assert.equal(missingAsset.status, 404, "不存在的静态文件不能回 200 的 HTML");
  const script = await get("/assets/index.js");
  assert.equal(script.status, 200);
  assert.equal(script.headers.get("x-robots-tag"), null);

  // 大小写：前端路由不区分大小写，Worker 不能把能打开的页面判成 404
  const upper = await get("/Pricing?lang=ja");
  assert.equal(upper.status, 301);
  assert.equal(upper.headers.get("location"), "https://koinote.app/pricing?lang=ja");
  const upperSlash = await get("/Docs/MCP/");
  assert.equal(upperSlash.headers.get("location"), "https://koinote.app/docs/mcp");
  const upperEditor = await get("/Editor/AbC");
  assert.equal(upperEditor.status, 200, "应用页参数可能区分大小写，不改写、不判 404");
  assert.equal(upperEditor.headers.get("x-robots-tag"), "noindex");

  // 尾斜杠统一到规范地址
  const slash = await get("/pricing/?lang=fr");
  assert.equal(slash.status, 301);
  assert.equal(slash.headers.get("location"), "https://koinote.app/pricing?lang=fr");

  // HEAD 不带正文
  const head = await worker.fetch(new Request("https://koinote.app/pricing", { method: "HEAD" }), env());
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");

  // 公开页的 CSP 仍然生效（安全头在出口统一加）
  const csp = zhPricing.headers.get("content-security-policy") ?? "";
  assert.match(csp, /script-src 'self'/);
  assert.doesNotMatch(csp, /unsafe-inline'[^;]*;\s*worker-src|script-src[^;]*unsafe-inline/, "script-src 不能放开 unsafe-inline");

  // 语言守卫：内联脚本的哈希必须与 CSP 里放行的一致，否则浏览器直接拒绝执行
  const guardHash = `sha256-${createHash("sha256").update(SEO_GUARD_SCRIPT).digest("base64")}`;
  assert.equal(SEO_GUARD_SCRIPT_HASH, guardHash, "seoGuard.ts 改了脚本却没更新哈希");
  assert.ok(csp.includes(`'${guardHash}'`), "CSP 没有放行守卫脚本");
  assert.ok(zhHTML.includes(`<script>${SEO_GUARD_SCRIPT}</script>`));
  assert.match(zhHTML, /<html lang="zh-CN" data-seo-locale="zh"/);
  assert.ok(zhHTML.indexOf("<script>") < zhHTML.indexOf('<main class="seo-static">'), "守卫要在静态正文之前执行");
  assert.match(missingHTML, /data-seo-locale="fr"/);
  assert.ok(missingHTML.includes(`<script>${SEO_GUARD_SCRIPT}</script>`));

  // 守卫逻辑：按 localStorage 与 ?lang 决定是否隐藏静态正文
  const runGuard = (pageLocale, stored, search) => {
    const classes = new Set();
    const sandbox = {
      document: {
        documentElement: {
          getAttribute: (name) => (name === "data-seo-locale" ? pageLocale : null),
          classList: { add: (name) => classes.add(name) },
        },
      },
      window: { localStorage: { getItem: () => stored } },
      location: { search },
    };
    new Function("document", "window", "location", SEO_GUARD_SCRIPT)(sandbox.document, sandbox.window, sandbox.location);
    return classes.has("seo-locale-mismatch");
  };
  assert.equal(runGuard("zh", "en", ""), true, "存过英文、正文是中文：先藏起来");
  assert.equal(runGuard("zh", "zh", ""), false);
  assert.equal(runGuard("zh", null, ""), false, "没存过偏好时前端按浏览器语言，与 Accept-Language 一致");
  assert.equal(runGuard("ja", "en", "?lang=ja"), false, "显式 ?lang 时前端用参数，不会换语言");
  assert.equal(runGuard("zh", "de", ""), false, "存的是不支持的语言时前端不会用它");
} finally {
  globalThis.fetch = originalFetch;
}

// 路由表与 SEO 分类同步：main.tsx 新增路由却没在 seo.ts 登记，会被当成 404。
// 直接调用 Worker 用的 classifyPath，而不是用正则比对源码文本。
const main = readFileSync(new URL("../spa/src/main.tsx", import.meta.url), "utf8");
const routePaths = [...main.matchAll(/path: "(\/[^"]*)"/g)].map((match) => match[1]);
assert.ok(routePaths.length > 20, "没读到路由表");
for (const path of routePaths) {
  // 动态段换成合法样例：仓库 ID 是正整数，其余随便一个片段
  const sample = path.replace(/\$[A-Za-z]+/g, path.startsWith("/repositories/") ? "7" : "x");
  assert.ok(classifyPath(sample), `路由 ${path} 没有在 worker/seo.ts 或 seoMeta.ts 中登记`);
  assert.ok(classifyPath(sample.toUpperCase()), `路由 ${path} 的大写写法会被判成 404`);
}
// editor 的子路由 $docId 挂在 /editor 下
assert.ok(classifyPath("/editor/doc-1"));
assert.equal(classifyPath("/definitely-not-a-route"), null);

console.log("SEO checks passed");
