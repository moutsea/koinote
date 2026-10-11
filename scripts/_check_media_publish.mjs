// Exercise the real export dialog, metadata parser, HTML renderer and API
// serialization; intercept only HTTP, labels and unrelated destination panels.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { build, stop } from "esbuild";
import { parseHTML } from "linkedom";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const directory = mkdtempSync(new URL("./.media-publish-", import.meta.url).pathname);
const { window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
Object.defineProperty(window.document, "compatMode", { value: "CSS1Compat" });
window.location = { origin: "https://koinote.app", href: "https://koinote.app/editor/test" };
window.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
Object.assign(globalThis, {
  window, document: window.document, Node: window.Node,
  HTMLElement: window.HTMLElement, HTMLImageElement: window.HTMLImageElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
let sent = [], saved = false;
globalThis.fetch = async (url, init) => {
  if (String(url).endsWith("/media/synthetic-platform/publish")) {
    assert.equal(saved, true, "the document must be saved before publishing");
    sent.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ published: true, url: "" }), { status: 200 });
  }
  return new Response("{}", { status: 200 });
};
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
let root;
try {
  const result = await build({
    stdin: {
      contents: `export {MediaExportDialog} from './spa/src/components/editor/WechatDialog';
        export {buildWechatHTML} from './spa/src/components/editor/exportWechat';
        export {buildMediaMarkdown} from './spa/src/components/editor/mediaExportStrategy';`,
      resolveDir: process.cwd(),
    },
    bundle: true, write: false, format: "esm", platform: "node", packages: "external",
    jsx: "automatic", logLevel: "error",
    plugins: [{ name: "publish-test-boundaries", setup(builder) {
      builder.onResolve({ filter: /.*/ }, ({ path, importer }) => {
        if (!importer.endsWith("/WechatDialog.tsx")) return;
        if (path === "../../i18n") return { path: "labels", namespace: "mock" };
        if (/^\.\/(WechatDraftPanel|ZhihuPublishPanel|XPublishPanel|WechatPreflightPanel)$/.test(path)) {
          return { path: path.slice(2), namespace: "mock" };
        }
      });
      builder.onLoad({ filter: /.*/, namespace: "mock" }, ({ path }) => ({
        contents: path === "labels"
          ? `const labels=new Proxy({}, {get:(_,key)=>String(key)});
             export const useI18n=()=>({t:{editor:labels,settingsPage:labels,desktopLocalMode:labels,errors:{}}});`
          : `export const ${path}=()=>null;`,
        loader: "js",
      }));
    }}],
  });
  const bundle = `${directory}/bundle.mjs`;
  writeFileSync(bundle, result.outputFiles[0].text);
  const { MediaExportDialog, buildWechatHTML, buildMediaMarkdown } = await import(pathToFileURL(bundle));
  root = createRoot(document.getElementById("root"));
  const cases = [
    { title: "文章标题", markdown: "正文\n\n## 第二节", html: "<p>正文</p><h2>第二节</h2>", body: "正文\n\n## 第二节", expectedTitle: "文章标题", heading: "第二节" },
    { title: "文档标题", markdown: "---\ntitle: 发布标题\nauthor: 作者\n---\n\n正文", html: "<hr><h2>title: 发布标题\nauthor: 作者</h2><p>正文</p>", body: "\n正文", expectedTitle: "发布标题" },
    { title: "用户标题", markdown: "# 用户标题\n\n正文", html: "<h1>用户标题</h1><p>正文</p>", body: "# 用户标题\n\n正文", expectedTitle: "用户标题", heading: "用户标题" },
  ];
  for (const [index, test] of cases.entries()) {
    sent = []; saved = false;
    const editor = { storage: { markdown: { getMarkdown: () => test.markdown } }, getHTML: () => test.html };
    await act(async () => root.render(React.createElement(QueryClientProvider, { client: queryClient },
      React.createElement(MediaExportDialog, {
        key: index, editor, docId: "synthetic-document", title: test.title,
        themeId: "", member: false, localMode: false, enabledPlatforms: [],
        customPlatforms: [{ platformId: "synthetic-platform", name: "Test API", enabled: true }],
        onBeforeExternalExport: async () => { saved = true; return true; },
        onSaveCover: async () => {}, getCurrentCover: () => null, onClose() {},
      }))));
    const publish = [...document.querySelectorAll("button")].find(button => button.textContent === "mediaCustomSync");
    assert.ok(publish, "custom API sync button must be available");
    await act(async () => publish.click());
    assert.equal(sent.length, 1, document.querySelector('[role="alert"]')?.textContent);
    const payload = sent[0];
    assert.equal(payload.title, test.expectedTitle);
    assert.equal(payload.markdown, test.body);
    const exported = document.createElement("div");
    exported.innerHTML = payload.html;
    assert.equal(exported.querySelectorAll("h1").length, test.html.includes("<h1>") ? 1 : 0,
      "API HTML must preserve authored headings without adding the separate title");
    assert.ok(exported.textContent.includes("正文"));
    if (test.heading) assert.ok(exported.textContent.includes(test.heading));
    if (index === 1) assert.ok(!exported.textContent.includes("发布标题"), "frontmatter stays out of the body");
    assert.equal(payload.coverImageSource, undefined);
  }
  const editor = { storage: { markdown: { getMarkdown: () => "正文" } }, getHTML: () => "<p>正文</p>" };
  const clipboard = await buildWechatHTML(editor, "文章标题", "");
  const parsed = document.createElement("div"); parsed.innerHTML = clipboard.html;
  assert.equal(parsed.querySelector("h1")?.textContent, "文章标题", "copying the full article still includes its title");
  assert.equal(buildMediaMarkdown("文章标题", "正文"), "# 文章标题\n\n正文");
  console.log("Custom API sync sends separate title/body, preserves authored headings and frontmatter, and keeps full-copy titles");
} finally {
  if (root) await act(async () => root.unmount());
  queryClient.clear(); stop(); rmSync(directory, { recursive: true, force: true });
}
