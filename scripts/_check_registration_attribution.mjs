import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { createHash } from "node:crypto";

const { outputFiles } = await build({
  entryPoints: ["spa/src/registrationAttribution.ts"], bundle: true,
  write: false, format: "esm", platform: "node", logLevel: "error",
});
const source = outputFiles[0].text;
const storageKey = "koinote_registration_first_touch_v1";
const token = "abcdef0123456789abcdef0123456789";
let instance = 0;
async function page(href, referrer = "", storage = new Map()) {
  globalThis.window = {
    location: new URL(href),
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
  };
  globalThis.document = { referrer };
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}#${instance++}`);
  return { module, storage };
}

let current = await page("https://koinote.app/docs?utm_source=search&utm_medium=organic&utm_campaign=launch_2026&search=private", "https://www.google.com/search?q=private");
await current.module.captureRegistrationFirstTouch();
const original = current.storage.get(storageKey);
assert.equal(JSON.parse(original).referrerHost, "www.google.com");
assert.equal(JSON.parse(original).landingPath, "/docs");
assert.equal(original.includes("private"), false);
window.location = new URL(current.module.shareRegistrationHref(`/share/${token}`), "https://koinote.app");
let context = await current.module.registrationContext();
assert.equal(context.firstTouch.utmSource, "search");
assert.equal(context.shareSignupToken, token);
assert.equal(current.storage.get(storageKey), original);

current = await page("https://koinote.app/pricing?utm_source=later", "https://other.test/", current.storage);
await current.module.captureRegistrationFirstTouch();
assert.equal(current.storage.get(storageKey), original, "later visits overwrote first touch");
window.location = new URL(`https://koinote.app/register?redirectTo=${encodeURIComponent(`/share/${token}`)}`);
assert.equal((await current.module.registrationContext()).shareSignupToken, undefined, "redirect alone must not create CTA context");

current = await page(`https://koinote.app/share/${token}?password=private#secret`);
await current.module.captureRegistrationFirstTouch();
context = await current.module.registrationContext();
assert.equal(context.firstTouch.landingPath, "/share/:token");
assert.equal(context.firstTouch.shareSourceKey, createHash("sha256").update(token).digest("hex"));
assert.equal(current.storage.get(storageKey).includes(token), false);
assert.equal(context.shareSignupToken, undefined, "visiting share alone must not create signup context");

for (const invalid of ["bad", "//evil.test/", "/share/../../secret"]) {
  const href = current.module.shareRegistrationHref(invalid);
  assert.equal(new URL(href, "https://koinote.app").searchParams.has("shareSignupToken"), false);
}
for (const [path, expected] of [
  ["/editor/private-id?search=secret", "/editor/:docId"],
  ["/repositories/123", "/repositories/:repositoryId"],
  ["/agent/workspaces/42", "/agent/workspaces/:workspaceId"],
  ["/private-file.docx", undefined], ["/editor/a/b", undefined],
  ["https://koinote.app/docs", undefined], ["//evil.test", undefined],
]) assert.equal(current.module.attributionLandingPath(path), expected);

for (const referrer of ["https://koinote.app/docs", "https://accounts.google.com/", "http://127.0.0.1/", "https://user:password@search.test/query?q=secret"]) {
  current = await page("https://koinote.app/?utm_source=https://evil.test& something=secret", referrer);
  context = await current.module.registrationContext();
  assert.equal(context.firstTouch.utmSource, undefined);
  assert.equal(context.firstTouch.referrerHost, referrer.includes("search.test") ? "search.test" : undefined);
}
current = await page("https://koinote.app/register?error=oauth_denied", "https://github.com/login/oauth/authorize");
assert.equal((await current.module.registrationContext()).firstTouch, undefined);

for (const operation of ["get", "set", "access"]) {
  current = await page(`https://koinote.app/register?shareSignupToken=${token}`);
  if (operation === "access") Object.defineProperty(window, "localStorage", { get() { throw new Error("storage disabled"); } });
  else window.localStorage[operation === "get" ? "getItem" : "setItem"] = () => { throw new Error("storage disabled"); };
  context = await current.module.registrationContext();
  assert.equal(context.firstTouch, undefined);
  assert.equal(context.shareSignupToken, token, "CTA context must survive unavailable storage");
}
for (const bad of ["not-json", "null", "[]", '{"landingPath":"/","capturedAt":"not-a-date"}', '{"landingPath":"/unknown","capturedAt":"2026-11-01T00:00:00Z"}']) {
  current = await page("https://koinote.app/pricing", "", new Map([[storageKey, bad]]));
  assert.equal((await current.module.registrationContext()).firstTouch.landingPath, "/pricing");
}
// 长度与自由文本过滤和服务端契约一致。
current = await page(`https://koinote.app/?utm_source=${"a".repeat(129)}&utm_medium=private+search&utm_campaign=${"b".repeat(128)}`);
context = await current.module.registrationContext();
assert.equal(context.firstTouch.utmSource, undefined);
assert.equal(context.firstTouch.utmMedium, undefined);
assert.equal(context.firstTouch.utmCampaign.length, 128);

// 这些源码断言只核对入口接线，运行时存储行为由上面的实际模块测试覆盖。
const read = (path) => readFileSync(path, "utf8");
assert.match(read("spa/src/main.tsx"), /if \(!desktopRuntime\) void captureRegistrationFirstTouch\(\)/);
assert.match(read("spa/src/pages/LoginPage.tsx"), /await register\(\{\s*\.\.\.\(await registrationContext\(\)\)/);
assert.match(read("spa/src/pages/LoginPage.tsx"), /if \(context.firstTouch\) search.set\("firstTouch", JSON.stringify\(context.firstTouch\)\)/);
assert.match(read("spa/src/pages/LoginPage.tsx"), /if \(context.shareSignupToken\) search.set\("shareSignupToken", context.shareSignupToken\)/);
console.log("registration attribution runtime checks passed (first touch, privacy, CTA context, malformed/disabled storage); entry wiring checked statically");
