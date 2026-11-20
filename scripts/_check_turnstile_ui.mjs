import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const cache = join(homedir(), "Library/Caches/ms-playwright");
const entries = existsSync(cache) ? await readdir(cache) : [];
const binary = process.env.WRITING_TEST_CHROMIUM || entries.filter((x) => x.startsWith("chromium_headless_shell-"))
  .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  .map((x) => join(cache, x, "chrome-headless-shell-mac-arm64/chrome-headless-shell")).find(existsSync);
if (!binary || binary.includes("Google Chrome.app")) throw new Error("Use an independent Chromium headless binary via WRITING_TEST_CHROMIUM");
const directory = await mkdtemp(join(tmpdir(), "koinote-turnstile-ui-"));
const bundle = await build({ entryPoints: ["scripts/fixtures/auth-turnstile.tsx"], bundle: true, write: false, platform: "browser", format: "esm", jsx: "automatic", define: { "import.meta.env": "{}" }, logLevel: "silent" });
const css = (await Promise.all((await readdir("spa/dist/assets")).filter((x) => x.endsWith(".css")).map((x) => readFile(join("spa/dist/assets", x), "utf8")))).join("\n");
const server = createServer((request, response) => {
  if (request.url === "/fixture.js") { response.setHeader("Content-Type", "application/javascript"); response.end(bundle.outputFiles[0].text); }
  else if (request.url === "/fixture.css") { response.setHeader("Content-Type", "text/css"); response.end(css); }
  else if (request.url.endsWith(".png")) { response.writeHead(204); response.end(); }
  else { response.setHeader("Content-Type", "text/html"); response.end('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const child = spawn(binary, ["--disable-gpu", "--no-first-run", "--no-default-browser-check", `--user-data-dir=${directory}`, "--remote-debugging-port=0", "about:blank"], { detached: true, stdio: "ignore" });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket;
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = Number((await readFile(join(directory, "DevToolsActivePort"), "utf8")).split("\n")[0]); if (port) break; } catch {}
    await delay(100);
  }
  assert.ok(port, "headless Chromium must start");
  const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" }).then((r) => r.json());
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let sequence = 0;
  const pending = new Map();
  const errors = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id) { const task = pending.get(message.id); pending.delete(message.id); if (message.error) task.reject(new Error(message.error.message)); else task.resolve(message.result); }
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expression) => { const result = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value; };
  const wait = async (expression) => { for (let i = 0; i < 100; i++) { if (await evaluate(`Boolean(${expression})`)) return; await delay(100); } throw new Error(`Timed out: ${expression}; errors=${errors.join("\n")}`); };
  const click = async (text) => { const selector = `Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(text)}&&!b.disabled)`; await wait(selector); await evaluate(`${selector}.click()`); };
  const fill = async (selector, text) => { await wait(`document.querySelector(${JSON.stringify(selector)})`); await evaluate(`{const input=document.querySelector(${JSON.stringify(selector)});input.focus();input.select();}`); await send("Input.insertText", { text }); };
  const navigate = async (extra = "") => { await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}/?lang=zh&${extra}` }); await wait("window.humanTest&&document.querySelector('form,button[aria-controls]')"); };
  const openRegister = async (extra = "") => { await navigate(extra); await evaluate("document.querySelector('button[aria-controls=\"email-registration-form\"]').click()"); await fill("input[type=email]", "registration@example.test"); };
  await send("Page.enable"); await send("Runtime.enable");

  await openRegister();
  await wait("document.querySelector('.fixture-turnstile')");
  await click("发送验证码");
  await wait("document.querySelector('[role=alert]')?.textContent.includes('人机验证')");
  assert.equal(await evaluate("window.humanTest.requests.length"), 0, "missing challenge never sends email");
  await evaluate("window.humanTest.solve()");
  await wait("!document.querySelector('[role=alert]')");
  await click("发送验证码");
  await wait("window.humanTest.requests.length===1&&window.humanTest.resets===1");
  assert.equal(await evaluate("window.humanTest.requests[0].body.turnstileToken"), "fixture-token-1");
  await click("发送验证码");
  assert.equal(await evaluate("window.humanTest.requests.length"), 1, "resending needs a new challenge token");
  await evaluate("window.humanTest.solve()"); await click("发送验证码");
  await wait("window.humanTest.requests.length===2&&window.humanTest.resets===2");
  assert.equal(await evaluate("window.humanTest.requests[1].body.turnstileToken"), "fixture-token-2");
  await evaluate("window.humanTest.solve();window.humanTest.expire()");
  await click("发送验证码");
  assert.equal(await evaluate("window.humanTest.requests.length"), 2, "expired token never reaches send endpoint");
  await click("重新验证"); await evaluate("window.humanTest.solve();window.humanTest.sendFail=true");
  await click("发送验证码"); await wait("window.humanTest.requests.length===3&&window.humanTest.resets===3");
  await click("发送验证码");
  assert.equal(await evaluate("window.humanTest.requests.length"), 3, "failed send also consumes the challenge");

  await evaluate("window.humanTest.rememberCallback();document.querySelector('p.mt-6 button').click()");
  await click("忘记密码？"); await fill("input[type=email]", "reset@example.test");
  await wait("window.humanTest.actions.at(-1)==='password_reset'");
  await evaluate("window.humanTest.oldCallback('stale-token')"); await click("发送验证码");
  assert.equal(await evaluate("window.humanTest.requests.length"), 3, "unmounted widget cannot authorize a different action");
  await evaluate("window.humanTest.solve()"); await click("发送验证码");
  await wait("window.humanTest.requests.length===4");
  assert.equal(await evaluate("window.humanTest.requests.at(-1).path"), "/api/auth/password-reset-code");

  await navigate("mode=login");
  await fill("input[autocomplete=username]", "legacy@example.test"); await fill("input[type=password]", "fixture-password");
  await evaluate("document.querySelector('form').requestSubmit()");
  await wait("document.querySelector('.fixture-turnstile')");
  assert.equal(await evaluate("window.humanTest.actions.at(-1)"), "email_verification");
  await evaluate("window.humanTest.solve()"); await click("发送验证码");
  await wait("window.humanTest.requests.length===1");
  assert.equal(await evaluate("window.humanTest.requests[0].body.email"), "legacy@example.test");

  await openRegister("config-fail"); await wait("document.querySelector('[role=status]')?.textContent.includes('无法加载')");
  await click("发送验证码"); assert.equal(await evaluate("window.humanTest.requests.length"), 0);
  await evaluate("window.humanTest.configFail=false"); await click("重新验证"); await wait("document.querySelector('.fixture-turnstile')");
  await send("Emulation.setDeviceMetricsOverride", { width: 320, height: 800, deviceScaleFactor: 1, mobile: false });
  await wait("document.querySelector('.fixture-turnstile')?.style.width==='150px'");
  assert.equal(await evaluate("document.querySelector('.fixture-turnstile').getBoundingClientRect().right<=320"), true);

  await openRegister("disabled"); await click("发送验证码"); await wait("window.humanTest.requests.length===1");
  await click("发送验证码"); await wait("window.humanTest.requests.length===2");
  assert.equal(await evaluate("document.querySelector('.fixture-turnstile')===null"), true, "unconfigured development retains mock email flow");
  assert.deepEqual(errors, []);
  console.log("Turnstile UI passed: registration, legacy recovery, password reset, missing/expired/stale tokens, success/failure reset, config retry, development resend and 320px layout. Provider and email APIs were simulated.");
} finally {
  socket?.close();
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    await exited;
  }
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
