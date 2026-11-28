import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { build, stop } from "esbuild";
import { parseHTML } from "linkedom";
import worker from "./_seo_bundle.mjs";

// 执行真实 HomePage 和 I18nProvider。登录与路由由内存适配器提供，浏览器布局另行验收。
const require = createRequire(import.meta.url);
const { window } = parseHTML("<html><head></head><body><div id='root'></div></body></html>");
const storage = new Map();
Object.assign(window, {
  location: new URL("https://koinote.app/"),
  localStorage: {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  },
});
Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, "navigator", {
  value: { language: "en-US", userAgent: "Node.js" }, configurable: true,
});
globalThis.__homeRoute = { pathname: "/", searchStr: "" };

const bundle = await build({
  stdin: {
    contents: `export { createElement, act, StrictMode } from "react";
      export { createRoot } from "react-dom/client";
      export { HomePage } from "./spa/src/pages/HomePage";
      export { AppFooter } from "./spa/src/components/AppFooter";
      export { I18nProvider, useI18n } from "./spa/src/i18n";
      export { publicPageMeta, homeStructuredData, PAGE_STRUCTURED_DATA_ID } from "./spa/src/seoMeta";
      export { en } from "./spa/src/i18n/en";
      export { zh } from "./spa/src/i18n/zh";
      export { fr } from "./spa/src/i18n/fr";
      export { ja } from "./spa/src/i18n/ja";`,
    resolveDir: process.cwd(),
  },
  bundle: true, format: "esm", platform: "node", mainFields: ["module", "main"], write: false, jsx: "automatic",
  plugins: [{ name: "home-test-adapters", setup(builder) {
    const adapters = {
      "../auth": "export const useCurrentUser = () => undefined;",
      "../desktop/menu": "export const syncDesktopMenuLocale = async () => {};",
      "@tanstack/react-router": `import { createElement } from "react";
        export const useRouterState = ({ select }) => select({ location: globalThis.__homeRoute });
        export const Link = ({ to, children, ...props }) => createElement("a", { ...props, href: to }, children);`,
    };
    builder.onResolve({ filter: /.*/ }, ({ path }) => Object.hasOwn(adapters, path) ? { path, namespace: "home-test" } : undefined);
    builder.onLoad({ filter: /.*/, namespace: "home-test" }, ({ path }) => ({ contents: adapters[path] }));
    builder.onResolve({ filter: /^react(?:-dom)?(?:\/|$)/ }, ({ path }) => ({ path: pathToFileURL(require.resolve(path)).href, external: true }));
  } }],
});
const temporary = mkdtempSync(join(tmpdir(), "koinote-home-dom-"));
const fixture = join(temporary, "home.mjs");
writeFileSync(fixture, bundle.outputFiles[0].text);
const { createElement, act, StrictMode, createRoot, HomePage, AppFooter, I18nProvider, useI18n, publicPageMeta, homeStructuredData, PAGE_STRUCTURED_DATA_ID, en, zh, fr, ja } =
  await import(pathToFileURL(fixture).href);
const messages = { en, zh, fr, ja };
let localeControl;
function CaptureLocale() {
  localeControl = useI18n();
  return null;
}
const shell = readFileSync(new URL("../spa/index.html", import.meta.url), "utf8");
const env = { BACKEND_URL: "https://backend.example", ASSETS: { fetch: async () => new Response(shell, { headers: { "content-type": "text/html" } }) } };
const initialHTML = await (await worker.fetch(new Request("https://koinote.app/?lang=en"), env)).text();
let cases = 0;

try {
  // 包含不同语言的 Worker 首屏、纯 SPA 外壳，以及从其他公开页面进入首页的已有 metadata。
  for (const seed of [initialHTML, shell, shell.replace("</head>", '<meta property="og:title" content="Pricing"><script type="application/ld+json" id="koinote-page-structured-data">{"@type":"BreadcrumbList"}</script></head>')]) {
    for (const initialLocale of Object.keys(messages)) {
      const { document: seeded } = parseHTML(seed);
      document.head.innerHTML = seeded.head.innerHTML;
      document.body.innerHTML = '<div id="root"></div>';
      const initialHead = document.head.innerHTML;
      window.location = new URL(`https://koinote.app/?lang=${initialLocale}`);
      globalThis.__homeRoute.searchStr = window.location.search;
      storage.set("koinote-locale", "ja");
      const root = createRoot(document.getElementById("root"));
      await act(async () => root.render(createElement(StrictMode, null,
        createElement(I18nProvider, null, createElement(CaptureLocale), createElement(HomePage), createElement(AppFooter)))));
      assert.equal(localeControl.locale, initialLocale, "显式语言优先于已保存偏好");
      for (const locale of [initialLocale, ...Object.keys(messages)]) {
        await act(async () => localeControl.setLocale(locale));
        const t = messages[locale];
        const meta = publicPageMeta("home", t, locale);
        assert.equal(document.querySelector("h1").textContent, t.home.title);
        assert.equal(document.querySelector("footer p").textContent, t.home.subtitle, "页脚必须复用同一产品定位摘要");
        for (const field of ["subtitle", "access", "desktop"]) assert.ok(document.body.textContent.includes(t.home[field]));
        for (const feature of t.home.features) assert.ok(document.body.textContent.includes(feature.desc));
        for (const [selector, expected] of [
          ['meta[property="og:title"]', meta.title],
          ['meta[property="og:description"]', meta.description],
          ['meta[property="og:url"]', window.location.href],
          ['meta[name="twitter:title"]', meta.title],
        ]) {
          assert.equal(document.querySelectorAll(selector).length, 1);
          assert.equal(document.querySelector(selector).getAttribute("content"), expected);
        }
        assert.equal(document.querySelectorAll('script[type="application/ld+json"]').length, 1);
        assert.deepEqual(JSON.parse(document.getElementById(PAGE_STRUCTURED_DATA_ID).textContent), homeStructuredData(t, locale, window.location.origin));
        for (const path of ["/editor", "/register", "/pricing", "/docs/mcp"]) assert.ok(document.querySelector(`a[href="${path}"]`));
        cases++;
      }
      await act(async () => root.unmount());
      assert.equal(document.head.innerHTML, initialHead, "离开首页后还原已有页面 metadata，并移除临时新增项");
    }
  }
  console.log(`HomePage DOM checks passed (${cases} locale renders, 12 mount/unmount scenarios)`);
} finally {
  stop();
  rmSync(temporary, { recursive: true, force: true });
}
