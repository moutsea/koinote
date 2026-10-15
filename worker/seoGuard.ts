/**
 * 静态正文的语言守卫，以内联 <script> 写进 Worker 渲染的公开页 <head>。
 *
 * 不带 ?lang 的地址按 Accept-Language 渲染静态正文，但前端优先用 localStorage
 * 里用户选过的语言。两者不一致的回访用户会先看到另一种语言的正文闪一下，再被
 * React 换掉。Worker 读不到 localStorage（Cookie 政策也写明它不发给服务器），
 * 所以在浏览器解析 body 之前由这段脚本比对，不一致就先把静态正文藏起来。
 *
 * 规则与 spa/src/i18n/index.tsx 的 detectLocale 对应：?lang 优先，其次是存过的
 * 合法语言。CSP 不放开 'unsafe-inline'，只按 SHA-256 放行这一段固定文本
 * （securityHeaders.ts）；改脚本必须同步改哈希，scripts/_check_seo.mjs 会核对。
 */
export const SEO_GUARD_SCRIPT =
  "(function(){try{var d=document.documentElement,p=d.getAttribute(\"data-seo-locale\"),s=window.localStorage.getItem(\"koinote-locale\");if(p&&s&&s!==p&&/^(zh|en|fr|ja)$/.test(s)&&!/[?&]lang=(zh|en|fr|ja)(&|$)/.test(location.search))d.classList.add(\"seo-locale-mismatch\")}catch(e){}})();";

export const SEO_GUARD_SCRIPT_HASH = "sha256-5KxPAcAOxNsF+Lz20+DtTTdrZLIxltBX9f2Yy+wgKRw=";
