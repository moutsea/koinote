import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { parseHTML } from "linkedom";

const scriptsDir = fileURLToPath(new URL(".", import.meta.url));
const tempDir = mkdtempSync(`${scriptsDir}.registration-flow-`);
try {
  const mocks = {
    "../i18n": `
      const strings = new Proxy({}, {get: (_, key) => key});
      export const useI18n = () => ({locale: 'en', t: {auth: strings, errors: strings, common: strings}});
    `,
    "../components/Logo": "export const Logo = () => null;",
    "../components/Ink": `
      import React from 'react';
      export const InkClouds = () => null;
      export const PaperCard = ({children}) => React.createElement('div', null, children);
    `,
    "../components/HumanVerification": "export const HumanVerification = () => null;",
    "./DesktopLoginPage": "export const DesktopLoginPage = () => null;",
  };
  const result = await build({
    stdin: {
      contents: `
        export {LoginPage} from '../spa/src/pages/LoginPage';
        export {captureRegistrationFirstTouch} from '../spa/src/registrationAttribution';
      `,
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
      name: "registration-view",
      setup(builder) {
        builder.onResolve({ filter: /.*/ }, ({ path }) =>
          Object.hasOwn(mocks, path) ? { path, namespace: "registration-test" } : undefined,
        );
        builder.onLoad({ filter: /.*/, namespace: "registration-test" }, ({ path }) => ({
          contents: mocks[path], loader: "js", resolveDir: scriptsDir,
        }));
      },
    }],
  });
  const bundlePath = `${tempDir}/bundle.mjs`;
  writeFileSync(bundlePath, result.outputFiles[0].text);
  const { window } = parseHTML("<html><head></head><body></body></html>");
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const storage = new Map();
  window.localStorage = {
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  };
  const navigations = [];
  function navigate(url) {
    const location = new URL(url, "https://koinote.app");
    location.assign = (target) => navigations.push(target);
    window.location = location;
  }
  navigate("/docs?utm_source=search&utm_medium=organic");
  Object.defineProperty(document, "referrer", {
    value: "https://www.google.com/search?q=private", configurable: true,
  });
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const { LoginPage, captureRegistrationFirstTouch } = await import(pathToFileURL(bundlePath));
  await captureRegistrationFirstTouch();
  const token = "abcdef0123456789abcdef0123456789";
  const payloads = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (url.endsWith("/api/auth/register")) {
      payloads.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ user: { id: 1, authUserId: "registered" } }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`unexpected request ${url}`);
  };
  async function flush(action) {
    await React.act(async () => {
      await action();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  const click = (button) => flush(() => button.dispatchEvent(new window.Event("click", { bubbles: true })));
  function button(text) {
    const value = [...document.querySelectorAll("button")].find((item) => item.textContent.includes(text));
    assert.ok(value, `missing button ${text}`);
    return value;
  }
  async function submit() {
    // 模拟 API 仅检查归因载荷与导航，凭证校验由真实后端数据库用例覆盖。
    await flush(() => document.querySelector("form").dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }),
    ));
  }
  async function scenario(search, run) {
    navigate(`/register${search}`);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await flush(() => root.render(React.createElement(
        QueryClientProvider, { client: queryClient }, React.createElement(LoginPage, { initialMode: "register" }),
      )));
      await run();
    } finally {
      await flush(() => root.unmount());
      queryClient.clear();
      container.remove();
    }
  }
  await scenario(`?redirectTo=${encodeURIComponent(`/share/${token}`)}&shareSignupToken=${token}`, async () => {
    for (const provider of ["Google", "GitHub"]) {
      await click(button(`continueWith${provider}`));
      const destination = new URL(navigations.pop(), "https://koinote.app");
      assert.equal(destination.pathname, `/api/auth/oauth/${provider.toLowerCase()}/start`);
      assert.equal(destination.searchParams.get("shareSignupToken"), token);
      assert.equal(JSON.parse(destination.searchParams.get("firstTouch")).utmSource, "search");
      assert.equal(destination.searchParams.get("redirectTo"), `/share/${token}`);
    }
    await click(document.querySelector('[aria-controls="email-registration-form"]'));
    await submit();
    assert.equal(payloads.at(-1).firstTouch.utmSource, "search");
    assert.equal(payloads.at(-1).shareSignupToken, token);
    assert.equal(navigations.pop(), `/share/${token}`);
  });
  await scenario(`?redirectTo=${encodeURIComponent(`/share/${token}`)}`, async () => {
    await click(button("continueWithGoogle"));
    const destination = new URL(navigations.pop(), "https://koinote.app");
    assert.equal(destination.searchParams.has("shareSignupToken"), false);
  });
  window.localStorage = {
    getItem() { throw new Error("disabled"); },
    setItem() { throw new Error("disabled"); },
  };
  await scenario(`?redirectTo=/docs&shareSignupToken=${token}`, async () => {
    await click(button("continueWithGitHub"));
    const destination = new URL(navigations.pop(), "https://koinote.app");
    assert.equal(destination.searchParams.has("firstTouch"), false);
    assert.equal(destination.searchParams.get("shareSignupToken"), token);
    await click(document.querySelector('[aria-controls="email-registration-form"]'));
    await submit();
    assert.equal(payloads.at(-1).firstTouch, undefined);
    assert.equal(payloads.at(-1).shareSignupToken, token);
    assert.equal(navigations.pop(), "/docs");
  });
  console.log("registration page runtime checks passed (email payload, both OAuth buttons, redirect, independent CTA, disabled storage; API responses mocked)");
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
