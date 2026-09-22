import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { parseHTML } from "linkedom";

const { window } = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
const require = createRequire(import.meta.url);
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const textareaValues = new WeakMap();
Object.defineProperties(window.HTMLTextAreaElement.prototype, {
  value: {
    get() { return textareaValues.get(this) ?? this.textContent; },
    set(value) { textareaValues.set(this, String(value)); },
  },
  defaultValue: {
    get() { return this.textContent; },
    set(value) { this.textContent = String(value); },
  },
});
const adapters = {
  i18n: 'const editor = new Proxy({}, { get: (_, key) => key }); export const useI18n = () => ({ t: { editor } });',
  runtime: 'export const isDesktopRuntime = () => globalThis.__coverDesktop; export const desktopAPIOrigin = () => "https://koinote.app";',
  offlineStore: 'export const desktopResolveImageSource = source => globalThis.__coverResolve(source);',
  query: 'export const useQueryClient = () => ({ invalidateQueries: async () => {} });',
  modal: 'export const pushModal = () => () => {};',
  api: 'export class ApiError extends Error {} export const AGENT_CREDITS_QUERY_KEY = ["credits"]; export const WECHAT_COVER_RATIO_PRESETS = ["2.35:1", "1:1"]; export const generateWechatCover = (prompt, ratio) => globalThis.__coverGenerateAI(prompt, ratio); export const uploadImage = file => globalThis.__coverUpload(file);',
  generator: 'export const createDefaultWechatCover = (title, ratio) => globalThis.__coverGenerate(title, ratio);',
  rehost: 'export const dataUriToFile = source => ({ source });',
};
const bundle = await build({
  stdin: {
    contents: `export { createElement, act } from "react";
      export { createRoot } from "react-dom/client";
      export { DocumentCoverPreview } from "./spa/src/components/editor/DocumentCoverPreview";
      export { DocumentCoverDialog } from "./spa/src/components/editor/DocumentCoverDialog";
      export { parseCoverRatio } from "./spa/src/components/editor/coverRatio";`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  define: { "process.env.NODE_ENV": '"development"' },
  plugins: [{
    name: "cover-test-adapters",
    setup(builder) {
      builder.onResolve({ filter: /^react(?:-dom)?(?:\/|$)/ }, ({ path }) => ({ path: pathToFileURL(require.resolve(path)).href, external: true }));
      const modules = [
        [/\/i18n$/, "i18n"], [/\/desktop\/runtime$/, "runtime"], [/\/desktop\/offlineStore$/, "offlineStore"],
        [/^@tanstack\/react-query$/, "query"], [/\/modalStack$/, "modal"], [/\/api$/, "api"],
        [/^\.\/wechatCover$/, "generator"], [/^\.\/rehost$/, "rehost"],
      ];
      for (const [filter, path] of modules) builder.onResolve({ filter }, () => ({ path, namespace: "cover-test" }));
      builder.onLoad({ filter: /.*/, namespace: "cover-test" }, ({ path }) => ({ contents: adapters[path], loader: "js" }));
    },
  }],
});
const { createElement, act, createRoot, DocumentCoverPreview, DocumentCoverDialog, parseCoverRatio } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
for (const ratio of ["0.0:0.0", "0.00:1", "1:0.00", "101:100", "1:100", "100:1", "1.001:1", "invalid"]) {
  assert.equal(parseCoverRatio(ratio), null, `invalid ratio ${ratio}`);
}
for (const ratio of ["2.35:1", "1:1", "3:2", "0.5:1", "32:94", "94:13.6"]) {
  assert.ok(parseCoverRatio(ratio), `valid ratio ${ratio}`);
}

const container = document.getElementById("root");
const root = createRoot(container);
let coverOpened = 0;
const preview = {
  title: "Editable title", coverRatio: "3:2", coverImageSource: "koinote-local-image://missing",
  fallbackTitleClassName: "default-title",
  onChange() {}, onOpenCover() { coverOpened += 1; },
};
globalThis.__coverDesktop = true;
globalThis.__coverResolve = async () => null;
await act(async () => root.render(createElement(DocumentCoverPreview, preview)));
assert.equal(container.querySelector("textarea")?.value, preview.title, "missing local images preserve the title input");
assert.ok(container.querySelector(".default-title textarea"), "failed covers preserve the unthemed title styling");
assert.equal(container.querySelector('[role="status"]')?.textContent, "wechatCoverImageFailed");
await act(async () => container.querySelector("button").click());
assert.equal(coverOpened, 1, "the cover settings remain reachable after image resolution fails");

globalThis.__coverResolve = async () => { throw new Error("decryption failed"); };
await act(async () => root.render(createElement(DocumentCoverPreview, { ...preview, coverImageSource: "koinote-local-image://broken" })));
assert.equal(container.querySelector("textarea")?.value, preview.title, "resolution exceptions preserve the title");

globalThis.__coverDesktop = false;
await act(async () => root.render(createElement(DocumentCoverPreview, { ...preview, coverImageSource: "https://example.test/broken.png" })));
assert.equal(container.querySelector(".default-title"), null, "fallback styling does not affect the cover overlay");
await act(async () => container.querySelector("img").dispatchEvent(new window.Event("error")));
assert.ok(container.querySelector("img"), "remote images get one retry");
await act(async () => container.querySelector("img").dispatchEvent(new window.Event("error")));
assert.equal(container.querySelector("textarea")?.value, preview.title, "network errors fall back to an editable title");
assert.equal(container.querySelector("img"), null);
assert.ok(container.querySelector(".default-title textarea"), "network failures preserve the unthemed title styling");
await act(async () => root.render(createElement(DocumentCoverPreview, { ...preview, coverImageSource: "https://example.test/broken.png", fallbackTitleClassName: "" })));
assert.equal(container.querySelector(".default-title"), null, "themed documents retain their own title styling");

const generations = [];
let uploadedSource;
let savedCover;
globalThis.__coverGenerate = async (title, ratio) => {
  generations.push({ title, ratio });
  return { base64: Buffer.from(title).toString("base64"), mimeType: "image/png", width: 940, height: 400, ratio };
};
globalThis.__coverUpload = async (file) => {
  uploadedSource = file.source;
  return { url: "https://example.test/new-cover.png" };
};
const dialog = {
  title: "New title", member: true, articleImages: [],
  initial: { coverMode: "default", coverRatio: "2.35:1", coverImageSource: "https://example.test/old-title.png", coverPrompt: "" },
  onSave(cover) { savedCover = cover; }, onClose() {},
};
await act(async () => root.render(createElement(DocumentCoverDialog, dialog)));
assert.deepEqual(generations, [{ title: "New title", ratio: "2.35:1" }], "a saved default cover regenerates with the current title");
await act(async () => root.render(createElement(DocumentCoverDialog, { ...dialog, title: "Newest title" })));
assert.equal(generations.at(-1).title, "Newest title");
const saveButton = [...document.querySelectorAll("button")].find(button => button.textContent === "wechatCoverSave");
assert.equal(saveButton.disabled, false);
await act(async () => saveButton.click());
assert.equal(uploadedSource, `data:image/png;base64,${Buffer.from("Newest title").toString("base64")}`);
assert.equal(savedCover.coverImageSource, "https://example.test/new-cover.png", "saving persists the regenerated cover");

uploadedSource = undefined;
savedCover = undefined;
const draftCover = Object.freeze({ coverMode: "ai", coverRatio: "3:2", coverImageSource: "https://example.test/saved-ai.png", coverPrompt: "New AI cover" });
const generatedAI = { base64: Buffer.from("Generated AI cover").toString("base64"), mimeType: "image/png", width: 600, height: 400, ratio: "3:2" };
globalThis.__coverGenerateAI = async (prompt, ratio) => {
  assert.equal(prompt, draftCover.coverPrompt);
  assert.equal(ratio, draftCover.coverRatio);
  return { cover: generatedAI };
};
await act(async () => root.render(createElement(DocumentCoverDialog, { ...dialog, key: "wechat-draft", purpose: "wechat-draft", initial: draftCover })));
const generateButton = [...document.querySelectorAll("button")].find(button => button.textContent === "wechatCoverRegenerate");
await act(async () => generateButton.click());
const useButton = [...document.querySelectorAll("button")].find(button => button.textContent === "wechatCoverUse");
await act(async () => useButton.click());
assert.equal(uploadedSource, undefined, "draft-only covers do not upload to persistent image storage");
assert.equal(savedCover.coverImageSource, `data:image/png;base64,${generatedAI.base64}`, "the draft receives the generated image directly");
assert.equal(draftCover.coverImageSource, "https://example.test/saved-ai.png", "draft selection leaves the original document cover unchanged");
await act(async () => root.unmount());
console.log("document cover rendering and ratio checks passed");
