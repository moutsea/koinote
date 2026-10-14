import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { parseHTML } from "linkedom";

const require = createRequire(import.meta.url);
const { window } = parseHTML("<html><body><div id='root'></div></body></html>");
Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, Event: window.Event, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(globalThis, "navigator", { value: { userAgent: "Node.js" }, configurable: true });
let desktop = true, local = false, flavor = "production", installed = "1.1.2", save = true, readFails = false;
let announcements = [];
let resolveCheck, rejectCheck;
const calls = { check: 0, read: [], save: 0, download: 0, install: 0, relaunch: 0 };
const update = { currentVersion: "1.1.2", version: "1.1.3", body: "更新说明", close: async () => {},
  download: async progress => { calls.download++; progress({ event: "Started", data: { contentLength: 100 } }); progress({ event: "Progress", data: { chunkLength: 100 } }); },
  install: async () => { calls.install++; },
};
globalThis.__upgradeTest = {
  desktop: () => desktop, local: () => local, flavor: () => flavor, version: async () => installed,
  unread: async () => structuredClone({ announcements }),
  read: async id => { calls.read.push(id); if (readFails) throw new Error("offline receipt"); announcements = announcements.filter(a => a.id !== id); return {}; },
  check: () => { calls.check++; return new Promise((resolve, reject) => { resolveCheck = resolve; rejectCheck = reject; }); },
  save: async () => { calls.save++; return save; }, relaunch: async () => { calls.relaunch++; },
};
const adapters = {
  "../api": "export const getUnreadAnnouncements=globalThis.__upgradeTest.unread; export const markAnnouncementRead=globalThis.__upgradeTest.read;",
  "../i18n": "export const useI18n=()=>({t:globalThis.__upgradeLabels,locale:'zh'}); export const interpolate=(s,v)=>s.replace(/\\{(\\w+)\\}/g,(_,k)=>String(v[k]));",
  "../desktop/runtime": "export const isDesktopRuntime=globalThis.__upgradeTest.desktop; export const desktopFlavor=globalThis.__upgradeTest.flavor;",
  "../desktop/localMode": "export const isDesktopLocalModeSelected=globalThis.__upgradeTest.local;",
  "../desktop/logoutGuard": "export const prepareDesktopLogout=globalThis.__upgradeTest.save;",
  "../modalStack": "export const pushModal=()=>()=>{};",
  "@tauri-apps/api/app": "export const getVersion=globalThis.__upgradeTest.version;",
  "@tauri-apps/plugin-process": "export const relaunch=globalThis.__upgradeTest.relaunch;",
  "@tauri-apps/plugin-updater": "export const check=globalThis.__upgradeTest.check;",
  "@tanstack/react-router": "import {createElement} from 'react'; export const Link=({to,...props})=>createElement('a',{href:to,...props});",
  "lucide-react": "const Icon=()=>null; export const BellRing=Icon, Download=Icon, History=Icon, X=Icon, LoaderCircle=Icon, RefreshCw=Icon;",
};
const bundle = await build({
  stdin: { contents: `export {createElement,act} from 'react'; export {createRoot} from 'react-dom/client'; export {QueryClient,QueryClientProvider} from '@tanstack/react-query';
    export {AnnouncementDialog} from './spa/src/components/AnnouncementDialog'; export {DesktopUpdater} from './spa/src/components/DesktopUpdater';
    export * from './spa/src/desktop/updaterEvents'; export {zh} from './spa/src/i18n/zh';`, resolveDir: process.cwd() },
  bundle: true, platform: "node", format: "esm", write: false, jsx: "automatic",
  plugins: [{ name: "upgrade-adapters", setup(builder) {
    builder.onResolve({ filter: /.*/ }, ({ path }) => Object.hasOwn(adapters, path) ? { path, namespace: "upgrade-test" } : undefined);
    builder.onLoad({ filter: /.*/, namespace: "upgrade-test" }, ({ path }) => ({ contents: adapters[path] }));
    builder.onResolve({ filter: /^(?:react(?:-dom)?(?:\/|$)|@tanstack\/react-query$)/ }, ({ path }) => ({ path: pathToFileURL(require.resolve(path)).href, external: true }));
  } }],
});
const { createElement, act, createRoot, QueryClient, QueryClientProvider, AnnouncementDialog, DesktopUpdater, zh, requestDesktopUpdateCheck, consumeDesktopUpdateCheck, isNewerDesktopRelease } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
globalThis.__upgradeLabels = zh;
const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } } });
const root = createRoot(document.getElementById("root"));
const render = (notice, updater) => act(async () => root.render(createElement(QueryClientProvider, { client }, notice && createElement(AnnouncementDialog), updater && createElement(DesktopUpdater))));
const button = text => [...document.querySelectorAll("button")].find(b => b.textContent === text);
const waitFor = async predicate => { for (let i = 0; i < 150; i++) { if (predicate()) return; await act(async () => new Promise(resolve => setTimeout(resolve, 10))); } assert.fail("upgrade UI did not reach expected state"); };
const click = async text => { const target = button(text); assert.ok(target, text); assert.ok(!target.disabled); await act(async () => target.click()); };
const reset = async () => { await act(async () => root.render(null)); client.clear(); consumeDesktopUpdateCheck(); };
const release = { id: 1, kind: "release", version: "1.1.3", translation: { title: "Koinote 1.1.3 新功能", summary: "改进分类与客户端升级", highlights: ["修正自动归档目录的分类参考", "在版本提醒中直接进入升级"] } };
try {
  for (const [next, current, expected] of [["1.1.3", "1.1.2", true], ["1.10.0", "1.9.9", true], ["1.1.3", "1.1.3", false], ["1.1.2", "1.1.3", false], ["1.1.3", "1.1.3-beta.2", true], ["1.1.3-beta.10", "1.1.3-beta.2", true], ["1.1.3-beta", "1.1.3", false], ["1.1.3+build", "1.1.3", false], ["bad", "1.1.2", false]]) {
    assert.equal(isNewerDesktopRelease(next, current), expected, `${next} > ${current}`);
  }
  for (const scenario of ["web", "local-mode", "local-flavor", "manual", "same", "older"]) {
    await reset(); desktop = scenario !== "web"; local = scenario === "local-mode"; flavor = scenario === "local-flavor" ? "local" : "production";
    installed = scenario === "same" ? "1.1.3" : scenario === "older" ? "1.2.0" : "1.1.2";
    announcements = [{ ...release, kind: scenario === "manual" ? "manual" : "release" }];
    await render(true, false); await waitFor(() => button(zh.announcements.acknowledge));
    await act(async () => new Promise(resolve => setTimeout(resolve, 20)));
    assert.ok(!button(zh.announcements.upgradeNow), scenario);
  }
  await reset(); desktop = true; local = false; flavor = "production"; installed = "1.1.2";
  announcements = [release, { ...release, id: 2, version: "1.1.1" }]; readFails = true;
  await render(true, false); await waitFor(() => button(zh.announcements.upgradeNow));
  await click(zh.announcements.upgradeNow);
  assert.ok(!document.querySelector('[role="alertdialog"]'), "read receipt failure must not leave a notice over the updater");
  await render(true, true); await waitFor(() => calls.check === 1);
  assert.ok(document.body.textContent.includes(zh.desktopUpdate.checking), "lazy updater must consume the queued click");
  await act(async () => resolveCheck(update)); await waitFor(() => button(zh.desktopUpdate.downloadAndRestart));
  save = false; await click(zh.desktopUpdate.downloadAndRestart);
  await waitFor(() => document.body.textContent.includes(zh.desktopUpdate.saveFailedDescription));
  assert.equal(calls.download, 0); assert.equal(calls.install, 0); assert.equal(calls.relaunch, 0);
  save = true;
  const retry = button(zh.desktopUpdate.retry); const checksBeforeInstall = calls.check;
  await act(async () => { retry.click(); retry.click(); requestDesktopUpdateCheck(); });
  await waitFor(() => calls.relaunch === 1);
  assert.equal(calls.check, checksBeforeInstall, "checks cannot replace an update while installation is preparing");
  assert.equal(calls.download, 1); assert.equal(calls.install, 1);
  // A manual click during a silent check must surface both no-update and error results.
  for (const outcome of ["current", "failed"]) {
    await reset(); const before = calls.check;
    await render(false, true);
    await act(async () => window.dispatchEvent(new Event("focus")));
    await waitFor(() => calls.check === before + 1);
    await act(async () => requestDesktopUpdateCheck());
    assert.equal(calls.check, before + 1, "checks must coalesce");
    assert.ok(document.body.textContent.includes(zh.desktopUpdate.checking));
    await act(async () => outcome === "current" ? resolveCheck(null) : rejectCheck(new Error("offline")));
    await waitFor(() => document.body.textContent.includes(outcome === "current" ? zh.desktopUpdate.currentTitle : zh.desktopUpdate.failedTitle));
  }
  console.log("Announcement upgrade: visibility, queued clicks, concurrent checks, save guard and install/relaunch passed");
} finally { await act(async () => root.unmount()); client.clear(); }
