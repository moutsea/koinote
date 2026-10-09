import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { parseHTML } from "linkedom";

const { window } = parseHTML("<!doctype html><html><body><div id='root'></div></body></html>");
const require = createRequire(import.meta.url);
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
const recoveryStorage = new Map();
window.localStorage = {
  getItem: key => recoveryStorage.get(key) ?? null,
  setItem: (key, value) => recoveryStorage.set(key, value),
  removeItem: key => recoveryStorage.delete(key),
};
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
  i18n: 'const editor = new Proxy({}, { get: (_, key) => key }); export const useI18n = () => ({ t: { editor, errors: {} } });',
  runtime: 'export const isDesktopRuntime = () => globalThis.__coverDesktop; export const desktopAPIOrigin = () => "https://koinote.app";',
  offlineStore: 'export const desktopResolveImageSource = source => globalThis.__coverResolve(source);',
  query: 'export const useQueryClient = () => ({ invalidateQueries: async () => {} });',
  modal: 'export const pushModal = () => () => {};',
  api: `export class ApiError extends Error {}
    export const AGENT_CREDITS_QUERY_KEY = ["credits"];
    export const WECHAT_COVER_RATIO_PRESETS = ["2.35:1", "1:1"];
    export const generateWechatCover = (prompt, ratio, signal, reference) => globalThis.__coverGenerateAI(prompt, ratio, signal, reference);
    export const uploadImage = (file, purpose) => globalThis.__coverUpload(file, purpose);
    export const releaseUnusedImages = keys => globalThis.__coverRelease(keys);
    export const getDocument = id => globalThis.__coverGetDocument(id);
    export const prepareWechatDraftDocument = id => globalThis.__coverPrepareDocument(id);
    export const createWechatDraft = (id, input) => globalThis.__coverPublishDraft(id, input);
    export const getWechatOfficialAccounts = async () => ({ accounts: [] });`,
  documents: 'export const useSaveDocument = () => ({ mutateAsync: input => globalThis.__coverPersistDocument(input) });',
  router: 'export const Link = () => null;',
  generator: 'export const createDefaultWechatCover = (title, ratio) => globalThis.__coverGenerate(title, ratio);',
};
const bundle = await build({
  stdin: {
    contents: `export { createElement, act, useEffect, useState } from "react";
      export { createRoot } from "react-dom/client";
      export { DocumentCoverPreview } from "./spa/src/components/editor/DocumentCoverPreview";
      export { DocumentCoverDialog } from "./spa/src/components/editor/DocumentCoverDialog";
      export { WechatDraftPanel } from "./spa/src/components/editor/WechatDraftPanel";
      export { useDocumentSaver } from "./spa/src/components/editor/useDocumentSaver";
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
        [/^@tanstack\/react-router$/, "router"], [/\/documents$/, "documents"],
        [/^\.\/wechatCover$/, "generator"],
      ];
      for (const [filter, path] of modules) builder.onResolve({ filter }, () => ({ path, namespace: "cover-test" }));
      builder.onLoad({ filter: /.*/, namespace: "cover-test" }, ({ path }) => ({ contents: adapters[path], loader: "js" }));
    },
  }],
});
const { createElement, act, useEffect, useState, createRoot, DocumentCoverPreview, DocumentCoverDialog, WechatDraftPanel, useDocumentSaver, parseCoverRatio } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
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
const uploads = [];
const releaseRequests = [];
const released = [];
const publishedDrafts = [];
const savedDocuments = new Map();
const events = [];
const embeddedImage = "data:image/png;base64,Y292ZXI=";
const otherEmbeddedImage = "data:image/png;base64,b3RoZXI=";
let rejectSave = false;
let rejectGet = false;
let rejectUpload = false;
let saveGate;
let uploadGate;
let prepareDocument = async () => {};
let draftImageSource = "https://example.test/article.png";
let documentSaver;
let controls;
let activeDocId;
let uploadAttempts = 0;
let saveAttempts = 0;
const initialDocument = {
  title: "Cover title", content: "Original body", theme: "", revision: 1,
  coverMode: "default", coverRatio: "2.35:1", coverImageSource: "", coverPrompt: "",
};
const uploadedSource = image => `data:${image.contentType};base64,${image.bytes.toString("base64")}`;
const buttonWithText = text => [...document.querySelectorAll("button")].find(button => button.textContent === text);
const click = async text => {
  const button = buttonWithText(text);
  assert.ok(button, `button exists: ${text}`);
  assert.equal(button.disabled, false, `button enabled: ${text}`);
  await act(async () => button.click());
};
const chooseMode = async index => act(async () => document.querySelectorAll('[role="radio"]')[index].click());
const closeCover = async () => act(async () => document.querySelector('[aria-label="shareClose"]').click());

globalThis.__coverGenerate = async (title, ratio) => {
  generations.push({ title, ratio });
  return { base64: Buffer.from(`${title}:${ratio}`).toString("base64"), mimeType: "image/png", width: 940, height: 400, ratio };
};
globalThis.__coverGenerateAI = async (prompt, ratio) => ({
  cover: { base64: Buffer.from(`AI:${prompt}`).toString("base64"), mimeType: "image/png", width: 600, height: 400, ratio },
});
globalThis.__coverUpload = async (file, purpose) => {
  assert.equal(purpose, "persistent");
  uploadAttempts += 1;
  if (rejectUpload) throw new Error("upload failed");
  const key = `u/test-user/${uploadAttempts.toString(16).padStart(8, "0")}.png`;
  const source = globalThis.__coverDesktop ? `koinote-local-image://cover-${uploadAttempts}` : `https://img.koinote.app/${key}`;
  const image = { key: globalThis.__coverDesktop ? source : key, url: source, contentType: file.type, size: file.size, bytes: Buffer.from(await file.arrayBuffer()) };
  uploads.push(image);
  if (uploadGate) await uploadGate;
  return image;
};
globalThis.__coverRelease = async keys => {
  releaseRequests.push(...keys);
  for (const key of keys) {
    const image = uploads.find(upload => upload.key === key);
    if (![...savedDocuments.values()].some(doc => doc.coverImageSource === image?.url || doc.content.includes(image?.url))) released.push(key);
  }
};
globalThis.__coverGetDocument = async id => {
  events.push("read-cover");
  if (rejectGet) throw new Error("read failed");
  assert.ok(savedDocuments.has(id));
  return { document: { ...savedDocuments.get(id) } };
};
globalThis.__coverPersistDocument = async input => {
  events.push("save-document");
  saveAttempts += 1;
  if (saveGate) await saveGate;
  if (rejectSave) throw new Error("save failed");
  const current = savedDocuments.get(input.docId);
  assert.equal(input.expectedRevision, current.revision);
  assert.doesNotMatch(input.coverImageSource ?? "", /^data:/i, "document API never receives an embedded image");
  const image = uploads.find(upload => upload.url === input.coverImageSource);
  assert.equal(image && released.includes(image.key), image ? false : undefined, "pending saves must not reference released images");
  const document = { ...current, ...input, revision: current.revision + 1 };
  savedDocuments.set(input.docId, document);
  return { document: { ...document } };
};
globalThis.__coverPrepareDocument = async id => {
  events.push("sync-document");
  assert.equal(documentSaver.isDirty(id), false, "draft preparation starts after editor saves complete");
  await prepareDocument(id);
};
globalThis.__coverPublishDraft = async (id, input) => {
  // The real API performs desktop preparation again before sending its request.
  await globalThis.__coverPrepareDocument(id);
  assert.equal(input.coverImageSource ?? "", savedDocuments.get(id).coverImageSource, "publish uses the latest saved cover");
  publishedDrafts.push({ id, ...input });
  return { draft: { mediaId: "saved-draft" } };
};
function EditorHarness({ docId }) {
  const saver = useDocumentSaver();
  documentSaver = saver;
  const [headerOpen, setHeaderOpen] = useState(false);
  const [draftOpen, setDraftOpen] = useState(true);
  controls = { setHeaderOpen, setDraftOpen };
  useEffect(() => saver.seed(docId, savedDocuments.get(docId)), [docId, saver.seed]);
  const current = saver.peek(docId) ?? savedDocuments.get(docId);
  const cover = saver.getCover(docId) ?? current;
  const articleImages = [
    { src: "https://example.test/article.png", alt: "Article image" },
    { src: embeddedImage, alt: "Embedded image" },
    { src: otherEmbeddedImage, alt: "Other embedded image" },
    { src: "DATA:image/png;BASE64,Y292ZXI=", alt: "Uppercase embedded image" },
    { src: "data:image/png;base64,%%%", alt: "Broken image" },
  ];
  const saveCover = (next, signal) => saver.saveCover(docId, next, signal);
  return createElement("div", null,
    headerOpen && createElement(DocumentCoverDialog, {
      title: current.title, member: true, articleImages, initial: cover,
      onSave: saveCover, onClose: () => setHeaderOpen(false),
    }),
    draftOpen && createElement(WechatDraftPanel, {
      accounts: [{ accountId: "wechat-account", label: "Test account", isDefault: true }],
      docId, title: current.title, member: true, disabled: false, articleImages,
      prepareHTML: async () => {
        events.push("prepare-html");
        return `<p><img src="${draftImageSource}"></p>`;
      },
      onSaveCover: saveCover,
      getCurrentCover: () => saver.getCover(docId),
      onBeforeExternalExport: () => saver.flush(docId),
    }),
  );
}
async function newDocument(name, patch = {}) {
  await act(async () => root.render(null));
  rejectSave = rejectGet = rejectUpload = false;
  saveGate = uploadGate = undefined;
  prepareDocument = async () => {};
  draftImageSource = "https://example.test/article.png";
  globalThis.__coverDesktop = false;
  const id = `cover-${name}`;
  savedDocuments.set(id, { ...initialDocument, ...patch, docId: id });
  activeDocId = id;
  await act(async () => root.render(createElement(EditorHarness, { docId: id })));
  return id;
}
const stored = () => savedDocuments.get(activeDocId);

// The header uses the same persistent saver as the draft panel and waits for I/O.
await newDocument("header", { title: "New title", coverImageSource: "https://example.test/old-title.png" });
await act(async () => controls.setHeaderOpen(true));
assert.deepEqual(generations.at(-1), { title: "New title", ratio: "2.35:1" });
await act(async () => {
  documentSaver.queue(activeDocId, { title: "Newest title" });
  assert.equal(await documentSaver.flush(activeDocId), true);
});
assert.equal(generations.at(-1).title, "Newest title");
let finishSave;
saveGate = new Promise(resolve => { finishSave = resolve; });
await click("wechatCoverSave");
assert.ok(document.querySelector('[role="dialog"]'));
assert.equal(buttonWithText("wechatCoverSave").disabled, true);
assert.equal(stored().coverImageSource, "https://example.test/old-title.png");
await act(async () => { finishSave(); await saveGate; });
saveGate = undefined;
assert.equal(document.querySelector('[role="dialog"]'), null);
assert.equal(stored().coverImageSource, uploads.at(-1).url);
assert.equal(uploadedSource(uploads.at(-1)), `data:image/png;base64,${Buffer.from("Newest title:2.35:1").toString("base64")}`);

// Real data URI parsing covers lowercase/uppercase schemes and rejects malformed images.
for (const label of ["Embedded image", "Uppercase embedded image", "Broken image", "Article image"]) {
  await newDocument(label);
  await click("wechatCoverSet");
  await chooseMode(1);
  await click(label);
  const uploadCount = uploads.length;
  const beforeSave = saveAttempts;
  await click("wechatCoverSave");
  if (label === "Broken image") {
    assert.equal(uploads.length, uploadCount);
    assert.equal(saveAttempts, beforeSave);
    assert.equal(document.querySelector('[role="alert"]').textContent, "wechatCoverSaveFailed");
  } else if (label === "Article image") {
    assert.equal(uploads.length, uploadCount);
    assert.equal(stored().coverImageSource, "https://example.test/article.png");
  } else {
    assert.equal(uploads.length, uploadCount + 1);
    assert.equal(uploads.at(-1).bytes.toString(), "cover");
    assert.equal(stored().coverImageSource, uploads.at(-1).url);
  }
}

// Default and AI uploads survive closing/reopening the entire draft panel, or
// changing between draft settings and the editor header, without another upload.
for (const mode of ["default", "ai"]) {
  await newDocument(`retry-${mode}`, mode === "ai" ? { coverMode: "ai", coverPrompt: "Mountains" } : {});
  await click("wechatCoverSet");
  if (mode === "ai") await click("wechatCoverGenerate");
  rejectSave = true;
  const count = uploads.length;
  await click("wechatCoverSave");
  const retained = uploads.at(-1);
  await click("wechatCoverSave");
  assert.equal(uploads.length, count + 1, "an in-place retry reuses the upload");
  await closeCover();
  await act(async () => controls.setDraftOpen(false));
  await act(async () => controls.setDraftOpen(true));
  await click("wechatCoverChange");
  await click("wechatCoverSave");
  assert.equal(uploads.length, count + 1, "reopening the draft retains the upload and the selected cover mode");
  await closeCover();
  rejectSave = false;
  await act(async () => controls.setHeaderOpen(true));
  await click("wechatCoverSave");
  assert.equal(uploads.length, count + 1, "the document header shares the upload cache");
  assert.equal(stored().coverImageSource, retained.url);
  assert.equal(stored().coverMode, mode);
  assert.equal(released.includes(retained.key), false);
  await act(async () => {
    documentSaver.queue(activeDocId, { content: "Body changed after saving cover" });
    assert.equal(await documentSaver.flush(activeDocId), true);
  });
  assert.equal(stored().coverImageSource, retained.url);
}

// A superseded failed upload is reclaimed after replacement is safely saved.
await newDocument("replacement");
await click("wechatCoverSet");
rejectSave = true;
await click("wechatCoverSave");
const superseded = uploads.at(-1);
await closeCover();
await click("wechatCoverChange");
await chooseMode(1);
await click("Embedded image");
await click("wechatCoverSave");
const retained = uploads.at(-1);
await closeCover();
assert.equal(released.includes(superseded.key), false, "failed uploads remain reusable until persistence settles");
assert.equal(released.includes(retained.key), false);
rejectSave = false;
await act(async () => assert.equal(await documentSaver.flush(activeDocId), true));
assert.equal(released.includes(superseded.key), true);
assert.equal(released.includes(retained.key), false);
assert.equal(stored().coverImageSource, retained.url);

// A failed cover save followed by direct publishing first retries document I/O.
// Desktop preparation then maps the local image; the request must use that URL.
await newDocument("publish-recovery", { coverImageSource: "https://example.test/previous-cover.png" });
globalThis.__coverDesktop = true;
globalThis.__coverResolve = async () => embeddedImage;
const localBodyImage = "koinote-local-image://00000000-0000-4000-8000-000000000001";
const mappedBodyImage = "https://img.koinote.app/u/test-user/bbbbbbbb.png";
draftImageSource = localBodyImage;
await click("wechatCoverChange");
rejectSave = true;
await click("wechatCoverSave");
const localCover = documentSaver.getCover(activeDocId).coverImageSource;
assert.match(localCover, /^koinote-local-image:/);
await closeCover();
const beforePublish = publishedDrafts.length;
events.length = 0;
await click("wechatDraftCreate");
assert.equal(document.querySelector('[role="alert"]').textContent, "saveFailed");
assert.equal(publishedDrafts.length, beforePublish);
assert.equal(events.includes("sync-document"), false, "failed editor persistence blocks publishing");
rejectSave = false;
const mappedCover = "https://img.koinote.app/u/test-user/aaaaaaaa.png";
prepareDocument = async id => {
  if (savedDocuments.get(id).coverImageSource === localCover) {
    savedDocuments.get(id).coverImageSource = mappedCover;
    documentSaver.applyImageMapping(id, localCover, mappedCover);
  }
  if (draftImageSource === localBodyImage) draftImageSource = mappedBodyImage;
};
events.length = 0;
await click("wechatDraftCreate");
assert.equal(publishedDrafts.length, beforePublish + 1);
assert.equal(publishedDrafts.at(-1).coverImageSource, mappedCover);
assert.ok(publishedDrafts.at(-1).html.includes(mappedBodyImage));
assert.ok(!publishedDrafts.at(-1).html.includes("koinote-local-image://"));
assert.ok(events.indexOf("read-cover") > events.indexOf("sync-document"));
assert.ok(events.indexOf("prepare-html") > events.indexOf("sync-document"));
assert.ok(buttonWithText("wechatDraftCreated"));
await click("wechatCoverChange");
await closeCover();
assert.ok(buttonWithText("wechatDraftCreated"), "closing unchanged cover settings preserves duplicate-publish protection");

// Fresh cover lookup failures must stop publishing rather than fall back to stale state.
await newDocument("read-failure");
rejectGet = true;
const publishCount = publishedDrafts.length;
await click("wechatDraftCreate");
assert.equal(publishedDrafts.length, publishCount);
assert.equal(document.querySelector('[role="alert"]').textContent, "wechatDraftCreateFailed");
rejectGet = false;
await click("wechatDraftCreate");
assert.equal(publishedDrafts.length, publishCount + 1, "articles with no cover still publish");

// Upload failures are retryable; aborted dialogs cannot save late upload results.
await newDocument("upload-failure");
await click("wechatCoverSet");
rejectUpload = true;
const failedCount = uploadAttempts;
await click("wechatCoverSave");
rejectUpload = false;
await click("wechatCoverSave");
assert.equal(uploadAttempts, failedCount + 2);
assert.equal(stored().coverImageSource, uploads.at(-1).url);
await newDocument("unmount-upload");
let finishUpload;
uploadGate = new Promise(resolve => { finishUpload = resolve; });
await click("wechatCoverSet");
const savesBeforeUnmount = saveAttempts;
await click("wechatCoverSave");
const orphan = uploads.at(-1);
await act(async () => controls.setDraftOpen(false));
await act(async () => { finishUpload(); await uploadGate; });
uploadGate = undefined;
assert.equal(saveAttempts, savesBeforeUnmount);
assert.equal(stored().coverImageSource, "");
assert.ok(released.includes(orphan.key));

// Concurrent users share an upload; canceling one must not delete another's image.
await newDocument("concurrent-upload");
uploadGate = new Promise(resolve => { finishUpload = resolve; });
const firstAbort = new AbortController();
const secondAbort = new AbortController();
const embeddedCover = { ...documentSaver.getCover(activeDocId), coverMode: "article", coverImageSource: embeddedImage };
const concurrentCount = uploads.length;
let firstSave, secondSave;
await act(async () => {
  firstSave = documentSaver.saveCover(activeDocId, embeddedCover, firstAbort.signal).catch(error => error);
  secondSave = documentSaver.saveCover(activeDocId, embeddedCover, secondAbort.signal);
});
await act(async () => {
  firstAbort.abort();
  finishUpload();
  assert.equal((await firstSave).name, "AbortError");
  await secondSave;
});
uploadGate = undefined;
assert.equal(uploads.length, concurrentCount + 1);
assert.equal(released.includes(uploads.at(-1).key), false);
assert.equal(stored().coverImageSource, uploads.at(-1).url);

// Closing a tab or accepting a remote version keeps uploads referenced by that
// version, even when desktop sync has changed the URL but kept the local key.
for (const action of ["forget", "acceptRemote"]) {
  for (const reference of ["cover", "body"]) {
    await newDocument(`${action}-${reference}`);
    globalThis.__coverDesktop = true;
    await act(async () => documentSaver.saveCover(activeDocId, embeddedCover, new AbortController().signal));
    const image = uploads.at(-1);
    const localKey = image.key;
    const remoteURL = `https://img.koinote.app/u/test-user/${uploadAttempts.toString(16).padStart(8, "0")}.png`;
    stored().coverImageSource = remoteURL;
    await act(async () => documentSaver.applyImageMapping(activeDocId, localKey, remoteURL));
    if (reference === "body") {
      await act(async () => {
        documentSaver.queue(activeDocId, { content: `![image](${remoteURL})`, coverImageSource: "" });
        assert.equal(await documentSaver.flush(activeDocId), true);
      });
    }
    await act(async () => {
      if (action === "forget") await documentSaver.forget(activeDocId);
      else documentSaver.acceptRemote(activeDocId, stored());
    });
    assert.equal(releaseRequests.includes(localKey), false, `${action} preserves the ${reference} upload`);
  }
}

// An upload can finish after accepting another version. Its late cleanup must
// also respect references in the replacement entry.
await newDocument("accept-remote-during-upload");
uploadGate = new Promise(resolve => { finishUpload = resolve; });
let lateSave;
await act(async () => {
  lateSave = documentSaver.saveCover(activeDocId, embeddedCover, new AbortController().signal).catch(error => error);
});
const lateImage = uploads.at(-1);
stored().coverImageSource = lateImage.url;
await act(async () => documentSaver.acceptRemote(activeDocId, stored()));
await act(async () => {
  finishUpload();
  assert.equal((await lateSave).message, "document_not_loaded");
});
uploadGate = undefined;
assert.equal(releaseRequests.includes(lateImage.key), false, "late cleanup preserves the accepted remote cover");

// Upload ownership is isolated per document, and explicit discard frees failed uploads.
await newDocument("discard");
rejectSave = true;
await act(async () => assert.rejects(documentSaver.saveCover(activeDocId, embeddedCover, new AbortController().signal)));
const discarded = uploads.at(-1);
await act(async () => documentSaver.acceptRemote(activeDocId, stored()));
assert.ok(released.includes(discarded.key));
rejectSave = false;
// Reference files stay local until generation; closing aborts late reads and requests.
const referenceReaders=[];
globalThis.FileReader=class {
  readAsDataURL(file){ this.file=file;referenceReaders.push(this); }
  abort(){ this.aborted=true; }
};
const referenceCalls=[];
globalThis.__coverGenerateAI=async(prompt,ratio,signal,reference)=>{
  referenceCalls.push({prompt,ratio,signal,reference});
  return {cover:{base64:Buffer.from('generated').toString('base64'),mimeType:'image/png',width:600,height:400,ratio}};
};
await act(async()=>root.render(null));
const referenceProps={title:'Reference cover',member:true,articleImages:[],initial:{coverMode:'ai',coverRatio:'1:1',coverImageSource:'',coverPrompt:'Follow the reference palette'},onSave:async()=>{},onClose(){}};
await act(async()=>root.render(createElement(DocumentCoverDialog,referenceProps)));
function propsFor(element){assert.ok(Boolean(element));return element[Object.keys(element).find(key=>key.startsWith('__reactProps'))];}
async function selectReference(file){await act(async()=>propsFor(document.querySelector('input[type="file"]')).onChange({target:{files:[file],value:'selected'}}));}
await selectReference({type:'image/svg+xml',size:20,name:'unsafe.svg'});
assert.equal(document.querySelector('[role="alert"]').textContent,'wechatCoverReferenceInvalid');
assert.equal(referenceReaders.length,0);
await selectReference({type:'image/png',size:5*1024*1024+1,name:'large.png'});
assert.equal(referenceReaders.length,0);
await selectReference({type:'image/png',size:100,name:'reference.png'});
assert.equal(buttonWithText('wechatCoverGenerate').disabled,true,'generation waits for the selected reference');
const referenceSource='data:image/png;base64,cmVmZXJlbmNl';
await act(async()=>{const reader=referenceReaders.at(-1);reader.result=referenceSource;reader.onload();});
assert.equal(document.querySelector('img[alt="wechatCoverReferencePreview"]')?.getAttribute('src'),referenceSource);
assert.equal(referenceCalls.length,0,'selection does not send the reference');
await click('wechatCoverGenerate');assert.equal(referenceCalls.at(-1).reference,referenceSource);
await act(async()=>document.querySelector('[aria-label="wechatCoverReferenceRemove"]').click());
await click('wechatCoverRegenerate');assert.equal(referenceCalls.at(-1).reference,undefined,'removed reference is not reused');
await selectReference({type:'image/png',size:100,name:'late.png'});
const lateReader=referenceReaders.at(-1);
await act(async()=>root.render(null));assert.equal(lateReader.aborted,true);
await act(async()=>{lateReader.result=referenceSource;lateReader.onload();});
assert.equal(document.querySelector('[role="dialog"]'),null,'late file reads do not reopen a closed dialog');
await act(async()=>root.render(createElement(DocumentCoverDialog,referenceProps)));
let finishReferenceGeneration;
globalThis.__coverGenerateAI=async(prompt,ratio,signal)=>{referenceCalls.push({signal});return new Promise(resolve=>{finishReferenceGeneration=resolve;});};
await click('wechatCoverGenerate');
await act(async()=>root.render(null));assert.equal(referenceCalls.at(-1).signal.aborted,true);
await act(async()=>finishReferenceGeneration({cover:{base64:'aGk=',mimeType:'image/png',ratio:'1:1',width:1,height:1}}));
assert.equal(document.querySelector('[role="dialog"]'),null);
await act(async () => root.unmount());
console.log("document cover rendering, shared upload lifecycle, publish recovery and ratio checks passed");
