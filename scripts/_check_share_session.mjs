import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { parseHTML } from "linkedom";

const scriptsDir = fileURLToPath(new URL(".", import.meta.url));
const tempDir = mkdtempSync(`${scriptsDir}.share-session-`);
try {
  // 保留真实页面、会话/API 和 React Query；仅替换路由、排版和富文本渲染。
  const mocks = {
    "@tanstack/react-router": `
      import React from 'react';
      export const useParams = () => ({token: 'release-review'});
      export const useNavigate = () => () => {};
      export const useRouterState = ({select}) => select({location:{pathname:'/share/release-review'}});
      export const Link = ({children}) => React.createElement('a', null, children);
    `,
    "@tiptap/react": `
      import React, {useState} from 'react';
      export const useEditor = (options) => useState(() => ({content: options.content}))[0];
      export const EditorContent = ({editor}) => React.createElement('article', null, editor.content);
    `,
    "../components/editor/extensions": "export const createEditorExtensions = () => [];",
    "../components/editor/themeCss": "export const THEME_SCOPE = ''; export const shareContentClass = () => ''; export const themeToCSS = () => '';",
    "../components/editor/markdownImage": "export const normalizeLegacyImageAdjacentHeadings = (content) => content;",
    "../documentTransfer": "export const copySharedDocument = () => { throw new Error('unexpected copy'); };",
    "../i18n": `
      const strings = new Proxy({}, {get: (_, key) => key});
      export const useI18n = () => ({locale:'en', t:{editor:strings,auth:strings,errors:{}}});
      export const interpolate = (text) => text;
    `,
  };
  const result = await build({
    stdin: {
      contents: `export { SharePage } from '../spa/src/pages/SharePage'; export { sessionQueryOptions } from '../spa/src/auth';`,
      resolveDir: scriptsDir,
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    packages: "external",
    jsx: "automatic",
    logLevel: "error",
    plugins: [{
      name: "share-view-dependencies",
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, ({ path }) =>
          Object.hasOwn(mocks, path) ? { path, namespace: "share-test" } : undefined,
        );
        builder.onLoad({ filter: /.*/, namespace: "share-test" }, ({ path }) => ({
          contents: mocks[path], loader: "js", resolveDir: scriptsDir,
        }));
      },
    }],
  });
  const bundlePath = `${tempDir}/bundle.mjs`;
  writeFileSync(bundlePath, result.outputFiles[0].text);

  const { window } = parseHTML("<html><head><title>Test</title></head><body></body></html>");
  globalThis.window = window;
  globalThis.document = window.document;
  window.location = { pathname: "/share/release-review" };
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const [{ default: React, act }, { createRoot }, { QueryClient, QueryClientProvider }, { SharePage, sessionQueryOptions }] = await Promise.all([
    import("react"), import("react-dom/client"), import("@tanstack/react-query"), import(pathToFileURL(bundlePath).href),
  ]);

  const user = { authUserId: "review-user", nickname: "review" };
  const full = { title: "Article", content: "VISIBLE HALF — HIDDEN HALF", isPreview: false, viewCount: 1 };
  const preview = { ...full, content: "VISIBLE HALF", isPreview: true };
  const shareKey = ["share", "release-review", user.authUserId];
  let sessionStatus, protectedShare, delayedVerification, delayedShare, delayedSession;
  const response = (value, status = 200) => new Response(JSON.stringify(value), { status });
  globalThis.fetch = async (path) => {
    if (path === "/api/auth/session") {
      if (delayedSession) {
        const pending = delayedSession;
        delayedSession = null;
        return pending;
      }
      if (sessionStatus === "offline") throw new TypeError("Failed to fetch");
      return sessionStatus === 200 ? response({ user }) : response({ error: "rejected" }, sessionStatus);
    }
    if (path === "/api/share/release-review/verify") {
      if (delayedVerification) return delayedVerification;
      return response({ document: sessionStatus === 200 ? full : preview });
    }
    if (path === "/api/share/release-review") {
      if (delayedShare) {
        const pending = delayedShare;
        delayedShare = null;
        return pending;
      }
      return response(protectedShare ? { requiresPassword: true } : { document: sessionStatus === 200 ? full : preview });
    }
    throw new Error(`unexpected request: ${path}`);
  };

  const flush = async (work = () => {}) => act(async () => {
    await work();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  const waitFor = async (condition) => {
    for (let i = 0; i < 50; i++) {
      await flush();
      if (condition()) return;
    }
    assert.ok(condition(), "page did not reach expected state");
  };
  const hasFull = () => document.body.textContent.includes("HIDDEN HALF");
  const hasPreview = () => document.body.textContent.includes("sharedReadFull");
  const hasGate = () => Boolean(document.querySelector("form"));

  async function scenario(protectedMode, run, initialStatus = 200) {
    sessionStatus = initialStatus;
    protectedShare = protectedMode;
    delayedVerification = delayedShare = delayedSession = null;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const refresh = () => qc.fetchQuery({ ...sessionQueryOptions(qc), staleTime: 0 });
    try {
      await flush(() => root.render(React.createElement(QueryClientProvider, { client: qc }, React.createElement(SharePage))));
      await waitFor(protectedMode ? hasGate : hasFull);
      await run(qc, refresh);
    } finally {
      await flush(() => root.unmount());
      qc.clear();
      container.remove();
    }
  }

  for (const status of [401, 403]) {
    await scenario(false, async (qc, refresh) => {
      sessionStatus = status;
      await flush(refresh);
      await waitFor(hasPreview);
      assert.equal(hasFull(), false);
      assert.equal(qc.getQueryData(["session"]).user, null);
      assert.equal(qc.getQueryData(shareKey), undefined);
      sessionStatus = 200;
      await flush(refresh);
      await waitFor(hasFull);
      assert.equal(hasPreview(), false);
    });
  }

  for (const status of [500, "offline"]) {
    await scenario(false, async (qc, refresh) => {
      sessionStatus = status;
      await flush(() => assert.rejects(refresh));
      assert.equal(qc.getQueryData(["session"]).user.authUserId, user.authUserId);
      assert.equal(hasFull(), true, "temporary failure must keep the current view");
      assert.ok(qc.getQueryData(shareKey));
    });
  }

  await scenario(true, async (_qc, refresh) => {
    await flush(() => document.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
    await waitFor(hasFull);
    sessionStatus = 401;
    await flush(refresh);
    await waitFor(hasGate);
    assert.equal(hasFull(), false, "expired sessions must discard password unlocks");
    sessionStatus = 200;
    await flush(refresh);
    await waitFor(hasGate);
    assert.equal(hasFull(), false, "logging back in must not restore an old unlock");
  });

  await scenario(true, async (_qc, refresh) => {
    let resolveVerification;
    delayedVerification = new Promise((resolve) => { resolveVerification = resolve; });
    await flush(() => document.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
    sessionStatus = 401;
    await flush(refresh);
    await waitFor(hasGate);
    await flush(() => resolveVerification(response({ document: full })));
    assert.equal(hasFull(), false, "late password response must not restore full content");
    sessionStatus = 200;
    await flush(refresh);
    await waitFor(hasGate);
    assert.equal(hasFull(), false);
  });

  await scenario(false, async (qc, refresh) => {
    let resolveShare;
    delayedShare = new Promise((resolve) => { resolveShare = resolve; });
    const pending = qc.refetchQueries({ queryKey: shareKey });
    sessionStatus = 401;
    await flush(refresh);
    await waitFor(hasPreview);
    await flush(() => resolveShare(response({ document: full })));
    await pending;
    assert.equal(hasFull(), false, "late share response must not restore full content");
    assert.equal(qc.getQueryData(shareKey), undefined);
  });

  await scenario(false, async (qc, refresh) => {
    sessionStatus = 401;
    await flush(refresh);
    await waitFor(hasPreview);
    const guestKey = ["share", "release-review", "guest"];
    await flush(() => qc.setQueryData(guestKey, { document: full }));
    await waitFor(hasFull);
    await flush(refresh);
    await waitFor(hasPreview);
    assert.equal(hasFull(), false, "a full response cached under guest must also be discarded");

    let resolveShare;
    delayedShare = new Promise((resolve) => { resolveShare = resolve; });
    const pending = qc.refetchQueries({ queryKey: guestKey });
    await flush(refresh);
    await waitFor(hasPreview);
    await flush(() => resolveShare(response({ document: full })));
    await pending;
    assert.equal(hasFull(), false, "an in-flight guest query must not restore full content or stay loading");
    assert.equal(qc.getQueryData(guestKey).document.isPreview, true);
  });
  for (const initialStatus of [401, 403, 500]) {
    await scenario(true, async (qc, refresh) => {
      if (initialStatus === 500) {
        // 会话端点暂时失败，但口令接口收到的 Cookie 有效。
        delayedVerification = Promise.resolve(response({ document: full }));
      } else {
        // 在另一标签页登录，当前页仍缓存着 60 秒内的匿名会话。
        sessionStatus = 200;
      }
      await flush(() => document.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
      await waitFor(hasFull);
      assert.equal(qc.getQueryData(["session"])?.user ?? null, null);
      const previousVersion = qc.getQueryData(["session"])?.revocationVersion ?? 0;
      sessionStatus = 401;
      await flush(refresh);
      await waitFor(hasGate);
      assert.equal(hasFull(), false, "guest-key password unlock must be revoked on confirmed expiry");
      assert.equal(qc.getQueryData(["session"]).revocationVersion, previousVersion + 1);
      sessionStatus = 200;
      await flush(refresh);
      await waitFor(hasGate);
      assert.equal(hasFull(), false, "re-login must not restore a revoked guest-key unlock");
    }, initialStatus);
  }

  await scenario(true, async (_qc, refresh) => {
    let resolveVerification;
    delayedVerification = new Promise((resolve) => { resolveVerification = resolve; });
    await flush(() => document.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
    await flush(refresh); // user 仍是 null，但这次 401 撤销了旧请求。
    await waitFor(hasGate);
    await flush(() => resolveVerification(response({ document: full })));
    assert.equal(hasFull(), false, "late guest-key password response must not restore full content");
    sessionStatus = 200;
    await flush(refresh);
    await waitFor(hasGate);
    assert.equal(hasFull(), false);
  }, 401);

  await scenario(true, async (qc, refresh) => {
    await flush(() => document.querySelector("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })));
    await waitFor(hasPreview);
    await flush(refresh);
    await waitFor(hasPreview);
    assert.equal(hasGate(), false, "routine anonymous session checks must keep an unlocked half preview");
    const version = qc.getQueryData(["session"]).revocationVersion;
    sessionStatus = 500;
    await flush(() => assert.rejects(refresh));
    assert.equal(qc.getQueryData(["session"]).revocationVersion, version);
    assert.equal(hasPreview(), true);
  }, 401);

  await scenario(false, async (qc) => {
    let resolveSession;
    delayedSession = new Promise((resolve) => { resolveSession = resolve; });
    const pending = qc.refetchQueries({ queryKey: ["session"] });
    await flush(() => qc.cancelQueries({ queryKey: ["session"] }));
    const version = qc.getQueryData(["session"]).revocationVersion;
    await flush(() => resolveSession(response({ error: "expired old request" }, 401)));
    await pending;
    assert.equal(qc.getQueryData(["session"]).revocationVersion, version);
    assert.ok(qc.getQueryData(shareKey), "cancelled session requests must not clear the current share cache");
    assert.equal(hasFull(), true);
  });

  console.log("share session checks passed (expiry, re-login, transient errors, guest-key unlocks, previews, in-flight responses)");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
