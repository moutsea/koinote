// 安全响应头。
//
// 上线前审计发现全站一条都没有（只有图片路径设了 nosniff）。缺 CSP 意味着一旦
// 有 XSS 落点就能直接执行脚本；缺 X-Frame-Options 意味着任意站点能把我们的页面
// 套进 iframe 做点击劫持。
//
// 这套断言的重点不是"有没有这几个头"，而是两件容易做错的事：
//   1. CSP 收得太紧会把功能弄坏 —— 主题 CSS 是运行时注入的 <style>，KaTeX 给
//      每个 span 写 style 属性。style-src 不给 'unsafe-inline' 就是公式不显示、
//      主题失效。而那种"坏了"最后往往被整条删掉 CSP 收场，比没加更糟。
//   2. HSTS 在 http 下发会把 localhost 钉成 https，开发机在浏览器里彻底打不开，
//      且 max-age 期间清不掉。
import { applySecurityHeaders } from "./_security_headers_bundle.mjs";

let pass = 0;
let fail = 0;

function ok(label, cond, detail) {
  if (cond) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL  ${label}${detail === undefined ? "" : ` —— ${detail}`}`);
  }
}

/** 造一个响应并过一遍安全头 */
function wrap({ contentType = "text/html; charset=utf-8", protocol = "https:" } = {}) {
  const res = new Response("body", { headers: { "content-type": contentType } });
  return applySecurityHeaders(res, new URL(`${protocol}//koinote.app/`));
}

/** 解析 CSP 成 directive → 值 的映射 */
function parseCSP(header) {
  const out = {};
  for (const part of header.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) out[name] = values;
  }
  return out;
}

// ---------- 固定头 ----------
{
  const h = wrap().headers;
  ok("有 nosniff", h.get("x-content-type-options") === "nosniff", h.get("x-content-type-options"));
  ok("禁止被 iframe 嵌套", h.get("x-frame-options") === "DENY", h.get("x-frame-options"));
  ok(
    "Referrer-Policy 跨站只发源",
    h.get("referrer-policy") === "strict-origin-when-cross-origin",
    h.get("referrer-policy"),
  );
  ok(
    "关掉了摄像头/麦克风/定位权限",
    /camera=\(\)/.test(h.get("permissions-policy") ?? "") &&
      /microphone=\(\)/.test(h.get("permissions-policy") ?? "") &&
      /geolocation=\(\)/.test(h.get("permissions-policy") ?? ""),
    h.get("permissions-policy"),
  );
  ok(
    "COOP 切断 window.opener",
    h.get("cross-origin-opener-policy") === "same-origin",
    h.get("cross-origin-opener-policy"),
  );
}

// ---------- HSTS 只在 https 下发 ----------
//
// 这条是本套件最要紧的一条。在 http 上发 HSTS 会把 localhost 钉成 https，
// 开发机在浏览器里彻底打不开，而且 max-age 期间用户自己清不掉。
{
  const https = wrap({ protocol: "https:" }).headers;
  ok("https 下发 HSTS", (https.get("strict-transport-security") ?? "").includes("max-age="), https.get("strict-transport-security"));
  ok(
    "HSTS 覆盖子域",
    (https.get("strict-transport-security") ?? "").includes("includeSubDomains"),
    https.get("strict-transport-security"),
  );

  const http = wrap({ protocol: "http:" }).headers;
  ok(
    "http 下绝不发 HSTS（否则本地开发机被永久钉成 https）",
    http.get("strict-transport-security") === null,
    http.get("strict-transport-security"),
  );
}

// ---------- CSP 只加在 HTML 上 ----------
{
  const html = wrap({ contentType: "text/html; charset=utf-8" }).headers;
  ok("HTML 响应带 CSP", html.get("content-security-policy") !== null);

  for (const type of ["image/png", "application/javascript", "text/css", "application/json"]) {
    const h = wrap({ contentType: type }).headers;
    ok(`${type} 不带 CSP（CSP 约束的是文档如何加载子资源）`, h.get("content-security-policy") === null);
    // 但固定头仍然要有 —— 尤其图片的 nosniff
    ok(`${type} 仍带 nosniff`, h.get("x-content-type-options") === "nosniff");
  }
}

// ---------- CSP 各指令 ----------
{
  const csp = parseCSP(wrap().headers.get("content-security-policy"));

  // script-src 必须不含 unsafe-inline：这是 CSP 最要紧的一条，挡的正是 XSS
  // 的主要落地方式。SPA 的 JS 全是同源打包产物，没有内联 script，能收到最紧。
  ok("script-src 是 'self'", (csp["script-src"] ?? []).includes("'self'"), String(csp["script-src"]));
  ok(
    "script-src 不含 unsafe-inline（否则 CSP 防 XSS 的意义基本消失）",
    !(csp["script-src"] ?? []).includes("'unsafe-inline'"),
    String(csp["script-src"]),
  );
  ok(
    "script-src 不含 unsafe-eval",
    !(csp["script-src"] ?? []).includes("'unsafe-eval'"),
    String(csp["script-src"]),
  );
  ok(
    "script-src 只额外放行 Cloudflare Web Analytics 脚本域",
    (csp["script-src"] ?? []).includes("https://static.cloudflareinsights.com") &&
      !(csp["script-src"] ?? []).includes("https:"),
    String(csp["script-src"]),
  );

  // style-src 必须含 unsafe-inline，否则主题和公式当场坏掉。
  // 这条断言方向和上面相反 —— 它防的是"有人顺手收紧 CSP 把功能弄坏"。
  ok(
    "style-src 含 unsafe-inline（主题注入 <style>，KaTeX 写 style 属性，收紧会让公式不显示）",
    (csp["style-src"] ?? []).includes("'unsafe-inline'"),
    String(csp["style-src"]),
  );

  // 图床域名由用户自己配（IMAGE_PUBLIC_BASE），且用户能手填外链图，
  // 写死域名会让别人的部署裂图
  ok("img-src 允许 https:", (csp["img-src"] ?? []).includes("https:"), String(csp["img-src"]));
  ok("img-src 允许 data:", (csp["img-src"] ?? []).includes("data:"), String(csp["img-src"]));
  ok(
    "img-src 允许 blob:（导出 PDF 时 html2canvas 的中间产物）",
    (csp["img-src"] ?? []).includes("blob:"),
    String(csp["img-src"]),
  );

  ok("connect-src 保留 self（API 全同源）", (csp["connect-src"] ?? []).includes("'self'"), String(csp["connect-src"]));
  ok(
    "connect-src 放行 Cloudflare Web Analytics 上报域",
    (csp["connect-src"] ?? []).includes("https://cloudflareinsights.com") &&
      !(csp["connect-src"] ?? []).includes("https:"),
    String(csp["connect-src"]),
  );
  ok("object-src 关掉", (csp["object-src"] ?? []).includes("'none'"), String(csp["object-src"]));
  ok(
    "base-uri 限制为 self（防注入 <base> 劫持相对路径）",
    (csp["base-uri"] ?? []).includes("'self'"),
    String(csp["base-uri"]),
  );
  ok("form-action 限制为 self", (csp["form-action"] ?? []).includes("'self'"), String(csp["form-action"]));
  ok(
    "frame-ancestors none（与 X-Frame-Options 双保险）",
    (csp["frame-ancestors"] ?? []).includes("'none'"),
    String(csp["frame-ancestors"]),
  );
  ok("有 default-src 兜底", (csp["default-src"] ?? []).includes("'self'"), String(csp["default-src"]));
}

// ---------- 不能弄坏原响应 ----------
{
  // 状态码、statusText、原有头都要保留 —— 加安全头不该改变响应语义
  const original = new Response("not found", {
    status: 404,
    statusText: "Not Found",
    headers: { "content-type": "text/html", "cache-control": "no-store", etag: '"abc"' },
  });
  const wrapped = applySecurityHeaders(original, new URL("https://koinote.app/"));
  ok("保留状态码", wrapped.status === 404, String(wrapped.status));
  ok("保留 cache-control", wrapped.headers.get("cache-control") === "no-store");
  ok("保留 etag", wrapped.headers.get("etag") === '"abc"');
}

{
  // 响应体必须原样透传
  const wrapped = applySecurityHeaders(
    new Response("hello body", { headers: { "content-type": "text/plain" } }),
    new URL("https://koinote.app/"),
  );
  const text = await wrapped.text();
  ok("响应体原样透传", text === "hello body", text);
}

{
  // immutable headers：从 fetch 拿回来的 Response 头是只读的，
  // 直接 set 会抛 TypeError。这里确认实现是新建 Response 而不是就地改。
  const immutable = new Response("x", {
    headers: { "content-type": "text/html" },
  });
  Object.freeze(immutable);
  let threw = null;
  try {
    applySecurityHeaders(immutable, new URL("https://koinote.app/"));
  } catch (err) {
    threw = err;
  }
  ok("不会因为头只读而抛异常", threw === null, String(threw));
}

console.log(`\n安全响应头：${pass} 通过，${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
