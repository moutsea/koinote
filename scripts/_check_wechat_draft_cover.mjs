import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const bundle = await build({
  stdin: {
    contents: 'export { wechatDraftCoverInput } from "./spa/src/components/editor/wechatDraftCover.ts";',
    resolveDir: fileURLToPath(new URL("../", import.meta.url)),
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  logLevel: "silent",
  plugins: [{
    name: "wechat-cover-adapters",
    setup(builder) {
      builder.onResolve({ filter: /\/desktop\/offlineStore$/ }, () => ({ path: "offline", namespace: "wechat-cover-test" }));
      builder.onResolve({ filter: /^\.\.\/\.\.\/api$/ }, () => ({ path: "api", namespace: "wechat-cover-test" }));
      builder.onLoad({ filter: /.*/, namespace: "wechat-cover-test" }, ({ path }) => ({
        contents: path === "offline"
          ? "export const desktopResolveImageSource = (source) => globalThis.__wechatCoverResolve(source);"
          : "export class ApiError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }",
        loader: "js",
      }));
    },
  }],
});
const { wechatDraftCoverInput } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const originalWindow = globalThis.window;
const localSource = "koinote-local-image://12345678-1234-4123-8123-123456789abc";
const dataURL = "data:image/png;base64,Y292ZXI=";
let passed = 0;

try {
  for (const coverMode of ["default", "article", "ai"]) {
    for (const source of ["https://images.example.test/cover.png", dataURL]) {
      const selection = Object.freeze({ coverMode, coverRatio: "3:2", coverImageSource: source, coverPrompt: "original prompt" });
      assert.deepEqual(await wechatDraftCoverInput(selection), { coverMode, coverRatio: "3:2", coverImageSource: source });
      passed += 1;
    }
  }

  globalThis.window = { __TAURI_INTERNALS__: {} };
  let resolveCalls = 0;
  globalThis.__wechatCoverResolve = async (source) => {
    assert.equal(source, localSource);
    resolveCalls += 1;
    return dataURL;
  };
  const savedCover = Object.freeze({ coverMode: "article", coverRatio: "2.35:1", coverImageSource: localSource, coverPrompt: "" });
  assert.deepEqual(await wechatDraftCoverInput(savedCover), { coverMode: "article", coverRatio: "2.35:1", coverImageSource: dataURL });
  assert.equal(savedCover.coverImageSource, localSource);
  assert.equal(resolveCalls, 1);
  passed += 1;

  assert.deepEqual(await wechatDraftCoverInput({ ...savedCover, coverImageSource: "" }), {});
  assert.equal(resolveCalls, 1);
  passed += 1;

  const imageKey = "u/test-user/12345678abcdef00.png";
  assert.equal((await wechatDraftCoverInput({ ...savedCover, coverImageSource: `/images/${imageKey}` })).coverImageSource, `https://img.koinote.app/${imageKey}`);
  passed += 1;

  globalThis.__wechatCoverResolve = async () => null;
  await assert.rejects(wechatDraftCoverInput(savedCover), { code: "wechat_cover_input_invalid" });
  passed += 1;

  const failure = new Error("Local cache unavailable");
  globalThis.__wechatCoverResolve = async () => { throw failure; };
  await assert.rejects(wechatDraftCoverInput(savedCover), (error) => error === failure);
  passed += 1;

  globalThis.window = {};
  await assert.rejects(wechatDraftCoverInput(savedCover), { code: "wechat_cover_input_invalid" });
  passed += 1;
} finally {
  globalThis.window = originalWindow;
  delete globalThis.__wechatCoverResolve;
}

console.log(`公众号草稿封面传输：${passed} 通过，0 失败`);
