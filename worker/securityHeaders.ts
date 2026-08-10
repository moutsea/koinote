/**
 * 安全响应头。
 *
 * 上线前审计发现全站一个都没有（只有图片路径设了 nosniff）。加在 Worker 出口
 * 是因为它是所有响应的唯一出口 —— 代理给后端的、R2 里的图、SPA 静态资源，
 * 三条路都从这里出去，一处加完全覆盖。写在后端就漏掉后两条。
 *
 * 每一条的取值都不是抄模板，理由见各自注释。尤其 CSP —— 抄一份严格模板上线，
 * 结果是公式不显示、主题失效，那比没有 CSP 更糟（会被当成"功能坏了"而整条删掉）。
 */

/**
 * Content-Security-Policy。
 *
 * script-src 'self'：SPA 的 JS 全部来自同源打包产物，没有 CDN 脚本、没有内联
 * <script>。所以这里能收到最紧，不需要 'unsafe-inline' —— 这是 CSP 最要紧的一条，
 * 挡住的正是 XSS 的主要落地方式。
 *
 * style-src 需要 'unsafe-inline'，两个真实原因，都不是偷懒：
 *   1. 主题 CSS 是运行时注入的 <style> 标签（MarkdownEditor 里的 {themeCSS}）——
 *      主题随文档变，不可能预先算出 hash。
 *   2. KaTeX 渲染公式时给每个 span 写 style 属性（那套排版靠 position 拼），
 *      这是它的工作方式，改不了。
 * 代价说清楚：CSS 注入仍可能（比如伪装点击区域），但没有脚本执行能力。
 *
 * img-src 放开到 https: 与 data:，因为：
 *   · 图床域名是用户自己配的（IMAGE_PUBLIC_BASE），写死任何域名都会让别人的
 *     部署裂图
 *   · 用户能手填外链图片地址（ImageNodeView 里改 Markdown 源码即可）
 *   · blob: 是导出 PDF 时 html2canvas 的中间产物
 * 图片没有脚本能力，放开的风险主要是隐私（外链图能记录读者 IP）——
 * 而那本来就是用户自己贴外链的选择。
 *
 * connect-src 'self'：所有 API 都同源（/api/* 由 Worker 代理）。
 *
 * frame-ancestors 'none' 比 X-Frame-Options 更强也更现代，但两个都发 ——
 * 老浏览器只认后者。
 *
 * object-src 'none'：不用 Flash/Java applet 之类，关掉这个古老的攻击面。
 * base-uri 'self'：防止注入 <base> 把相对路径整体劫持到别的域。
 * form-action 'self'：表单只能提交回本站。
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

/**
 * 与内容无关的固定头。
 *
 * HSTS 只在 https 下发（见 applySecurityHeaders）：在 http 上发它没有意义，
 * 而本地 wrangler dev 走 http，无条件发会把 localhost 也钉成 https ——
 * 那会让开发机在浏览器里彻底打不开，且 max-age 期间清不掉。
 */
const BASE_HEADERS: Record<string, string> = {
  // 防 MIME 嗅探：即使 Content-Type 被误判也不会被当作 HTML 执行
  "x-content-type-options": "nosniff",
  // 不许被嵌进 iframe。缺这条别人能把我们的页面套进自己站里做点击劫持
  "x-frame-options": "DENY",
  // 跨站跳转时只发源，不发完整路径 —— 文档 URL 里可能有分享 token
  "referrer-policy": "strict-origin-when-cross-origin",
  // 关掉不用的强权限。默认是允许的，不显式关掉就等于开着
  "permissions-policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  // 跨域打开时切断 window.opener 关系，防 tabnabbing
  "cross-origin-opener-policy": "same-origin",
};

const HSTS = "max-age=31536000; includeSubDomains";

/**
 * 给响应加上安全头，返回新的 Response。
 *
 * 为什么要新建 Response 而不是改原来的：从 fetch / ASSETS.fetch 拿回来的
 * Response 的 headers 是 immutable 的，直接 set 会抛 TypeError。
 *
 * 已有的同名头会被覆盖（后端如果也发了 CSP，以这里为准）——
 * 出口统一，避免两处各发一份互相打架。
 */
export function applySecurityHeaders(response: Response, url: URL): Response {
  const headers = new Headers(response.headers);

  for (const [name, value] of Object.entries(BASE_HEADERS)) {
    headers.set(name, value);
  }

  // CSP 只加在 HTML 文档上。
  //
  // 图片、JS、CSS 响应上带 CSP 没有意义（它约束的是文档如何加载子资源），
  // 而给图片带 default-src 'self' 反而可能被某些浏览器理解成限制自身 ——
  // 更重要的是 R2 的图片响应体积小、数量大，白搭几百字节头。
  const contentType = headers.get("content-type") ?? "";
  if (contentType.includes("text/html")) {
    headers.set("content-security-policy", CSP);
  }

  // HSTS 只在 https 下发，理由见 BASE_HEADERS 上方注释
  if (url.protocol === "https:") {
    headers.set("strict-transport-security", HSTS);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
