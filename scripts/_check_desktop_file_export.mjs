import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const bundle = await build({
  stdin: {
    contents: 'export { saveExportBlob } from "./spa/src/components/editor/exportDocument.ts";',
    resolveDir: fileURLToPath(new URL("../", import.meta.url)),
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  logLevel: "silent",
  plugins: [{
    name: "desktop-export-adapters",
    setup(builder) {
      builder.onResolve({ filter: /^@tauri-apps\/(?:plugin-dialog|api\/core)$/ }, (request) => ({
        path: request.path,
        namespace: "desktop-export-test",
      }));
      builder.onLoad({ filter: /.*/, namespace: "desktop-export-test" }, () => ({
        contents: `
          export const save = (...argumentsList) => globalThis.__koinoteExportAdapters.save(...argumentsList);
          export const invoke = (...argumentsList) => globalThis.__koinoteExportAdapters.invoke(...argumentsList);
        `,
        loader: "js",
      }));
    },
  }],
});

const { saveExportBlob } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);
const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const calls = [];
const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0xff, 0x80]);
const blob = new Blob([bytes]);

globalThis.window = { __TAURI_INTERNALS__: {} };

try {
  for (const extension of ["md", "html", "docx", "zip"]) {
    calls.length = 0;
    globalThis.__koinoteExportAdapters = {
      async invoke(command, payload) {
        calls.push("invoke");
        assert.equal(command, "desktop_save_export");
        assert.ok(payload instanceof Uint8Array);
        assert.deepEqual(Array.from(payload), Array.from(bytes));
        const options = arguments[2];
        assert.deepEqual(options, {
          headers: {
            "x-koinote-export-filename": encodeURIComponent(`导出.${extension}`),
            "x-koinote-export-extension": extension,
          },
        });
        return true;
      },
    };
    assert.equal(await saveExportBlob(blob, `导出.${extension}`, extension), true);
    assert.deepEqual(calls, ["invoke"]);
  }

  globalThis.__koinoteExportAdapters = {
    async invoke(_command, payload, options) {
      assert.ok(payload instanceof Uint8Array);
      assert.equal(options.headers["x-koinote-export-filename"], encodeURIComponent("导出.html"));
      assert.equal(options.headers["x-koinote-export-extension"], "html");
      return false;
    },
  };
  assert.equal(await saveExportBlob(blob, "导出.html", "html"), false);

  const failure = new Error("disk full");
  globalThis.__koinoteExportAdapters = {
    async invoke() { throw failure; },
  };
  await assert.rejects(saveExportBlob(blob, "导出.html", "html"), (error) => error === failure);

  let completeWrite;
  let signalWriteStarted;
  const writeStarted = new Promise((resolve) => { signalWriteStarted = resolve; });
  globalThis.__koinoteExportAdapters = {
    invoke() {
      signalWriteStarted();
      return new Promise((resolve) => { completeWrite = resolve; });
    },
  };
  let completed = false;
  const pendingSave = saveExportBlob(blob, "导出.html", "html").then((result) => {
    completed = true;
    return result;
  });
  await writeStarted;
  assert.equal(completed, false);
  completeWrite(true);
  assert.equal(await pendingSave, true);

  calls.length = 0;
  let cleanup;
  const anchor = {
    style: {},
    click() { calls.push("click"); },
    remove() { calls.push("remove"); },
  };
  globalThis.window = { setTimeout(callback) { cleanup = callback; } };
  globalThis.document = {
    createElement(tag) { assert.equal(tag, "a"); return anchor; },
    body: { appendChild(element) { assert.equal(element, anchor); calls.push("append"); } },
  };
  globalThis.__koinoteExportAdapters = {
    invoke() { assert.fail("browser export must not invoke a native command"); },
  };
  assert.equal(await saveExportBlob(blob, "导出.html", "html"), true);
  assert.equal(anchor.download, "导出.html");
  assert.deepEqual(calls, ["append", "click", "remove"]);
  cleanup();
} finally {
  globalThis.window = originalWindow;
  globalThis.document = originalDocument;
  delete globalThis.__koinoteExportAdapters;
}

console.log("desktop file export behavior checks passed");
