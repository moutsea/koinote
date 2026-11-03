import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

test("Local credentials require the native proxy for bearer and refresh requests", async () => {
  const { outputFiles } = await build({
    entryPoints: ["spa/src/desktop/transport.ts"], bundle: true, write: false,
    format: "esm", platform: "node", define: { "import.meta.env": '{"VITE_DESKTOP_FLAVOR":"local"}' },
    plugins: [{ name: "native-fixture", setup(builder) {
      builder.onResolve({ filter: /^(@tauri-apps\/api\/core|@tauri-apps\/plugin-http|\.\/localMode)$/ }, ({ path }) =>
        ({ path, namespace: "fixture" }));
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({
        contents: path.endsWith("/core") ? "export const invoke = () => globalThis.localProxy();" :
          path.endsWith("/plugin-http") ? "export const fetch = (...args) => globalThis.localHTTP(...args);" :
          "export const isDesktopLocalModeSelected = () => false;",
      }));
    } }],
  });
  const { desktopRawFetch } = await import("data:text/javascript;base64," + Buffer.from(outputFiles[0].contents).toString("base64"));
  const calls = [];
  globalThis.localHTTP = (...args) => calls.push(args);
  globalThis.localProxy = () => { throw new Error("端口冲突"); };
  const tokenRequest = { method: "POST", body: '{"refreshToken":"test-only"}' };
  await assert.rejects(desktopRawFetch("/api/auth/desktop/token", tokenRequest), /端口冲突/);
  await assert.rejects(desktopRawFetch("/api/agent/sessions", { headers: { Authorization: "Bearer test-only" } }), /端口冲突/);
  assert.equal(calls.length, 0);
  globalThis.localProxy = () => 34567;
  await desktopRawFetch("/api/auth/desktop/token", tokenRequest);
  assert.deepEqual(calls[0][1].proxy, { all: "http://127.0.0.1:34567" });
  assert.equal(calls[0][1].maxRedirections, 0);
});
