import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { build } from "esbuild";

// Dedicated headless executable, temporary profile, detached child, ephemeral
// debugging port. Never launch or terminate the user's Google Chrome app.
const cache = join(homedir(), "Library/Caches/ms-playwright");
const installed = existsSync(cache) ? await readdir(cache) : [];
const binary =
  process.env.WRITING_TEST_CHROMIUM ||
  installed
    .filter((x) => x.startsWith("chromium_headless_shell-"))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((x) =>
      join(cache, x, "chrome-headless-shell-mac-arm64/chrome-headless-shell"),
    )
    .find(existsSync);
if (!binary || binary.includes("Google Chrome.app"))
  throw new Error(
    "Set WRITING_TEST_CHROMIUM to an independent Chromium headless binary",
  );
const temp = await mkdtemp(join(tmpdir(), "koinote-writing-ui-"));
await build({
  entryPoints: ["scripts/fixtures/writing-agent.tsx"],
  outfile: join(temp, "fixture.js"),
  bundle: true,
  platform: "browser",
  format: "esm",
  jsx: "automatic",
  define: { "import.meta.env": "{}" },
  logLevel: "silent",
});
const cssFiles = (await readdir("spa/dist/assets")).filter((x) =>
  x.endsWith(".css"),
);
const css = (
  await Promise.all(
    cssFiles.map((x) => readFile(join("spa/dist/assets", x), "utf8")),
  )
).join("\n");
const js = await readFile(join(temp, "fixture.js"));
const server = createServer((req, res) => {
  if (req.url === "/fixture.js") {
    res.setHeader("Content-Type", "text/javascript");
    res.end(js);
  } else if (req.url === "/fixture.css") {
    res.setHeader("Content-Type", "text/css");
    res.end(css);
  } else {
    res.setHeader("Content-Type", "text/html");
    res.end(
      '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
    );
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = spawn(
  binary,
  [
    `--user-data-dir=${temp}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--window-size=1200,900",
    "about:blank",
  ],
  { detached: true, stdio: "ignore" },
);
let ws;
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try {
      port = Number(
        (await readFile(join(temp, "DevToolsActivePort"), "utf8")).split(
          "\n",
        )[0],
      );
      break;
    } catch {
      await delay(100);
    }
  }
  if (!port) throw new Error("Chromium did not start");
  const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
    method: "PUT",
  }).then((r) => r.json());
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.addEventListener("open", r, { once: true });
    ws.addEventListener("error", j, { once: true });
  });
  let seq = 0;
  const pending = new Map();
  const errors = [];
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        msg.error
          ? p.reject(new Error(msg.error.message))
          : p.resolve(msg.result);
      }
    } else if (msg.method === "Runtime.exceptionThrown")
      errors.push(
        msg.params.exceptionDetails.text +
          " " +
          (msg.params.exceptionDetails.exception?.description ?? ""),
      );
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
    return r.result.value;
  };
  const wait = async (expression) => {
    for (let i = 0; i < 100; i++) {
      if (await evaluate(`Boolean(${expression})`)) return;
      await delay(100);
    }
    throw new Error(
      "Timed out: " + expression + " errors=" + errors.join("\n"),
    );
  };
  const click = async (label) => {
    await evaluate(
      `Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(label)}).click()`,
    );
  };
  await send("Runtime.enable");
  await send("Page.enable");
  for (const conflict of [false, true]) {
    await send("Page.navigate", {
      url: `http://127.0.0.1:${server.address().port}/?lang=zh${conflict ? "&conflict=1" : ""}`,
    });
    await wait(
      "document.querySelector('select option[value]:not([value=\"\"])')",
    );
    await evaluate(
      `document.querySelector('select').value=JSON.stringify([7,'writing/SKILL.md']);document.querySelector('select').dispatchEvent(new Event('change',{bubbles:true}));document.querySelector('textarea').focus()`,
    );
    await send("Input.insertText", { text: "改进文章" });
    await click("开始任务");
    await wait(
      "document.body.textContent.includes('Temporary connection failure')",
    );
    await click("开始任务");
    await wait("document.body.textContent.includes('确认应用修改')");
    await wait("document.querySelector('[data-agent-progress]')?.textContent.includes('阅读文档内容')");
    const progress = await evaluate("document.querySelector('[data-agent-progress]').textContent");
    assert.match(progress, /任务已完成/);
    assert.doesNotMatch(progress, /koinote|get_document|tool\.completed/);
    const before = await evaluate("window.writingUITest");
    assert.equal(before.submissions.length, 2);
    assert.equal(
      before.submissions[0].requestId,
      before.submissions[1].requestId,
      "network retry must reuse request id",
    );
    assert.equal(before.submissions[1].skillRepositoryId, 7);
    assert.equal(
      before.applied.length,
      0,
      "proposal must wait for confirmation",
    );
    assert.equal(
      await evaluate(
        "document.body.textContent.includes('原来的第一段。') && document.body.textContent.includes('修改后的第一段。')",
      ),
      true,
    );
    if (!conflict) {
      const shot = await send("Page.captureScreenshot", { format: "png" });
      await writeFile(
        "/tmp/koinote-writing-agent-ui.png",
        Buffer.from(shot.data, "base64"),
      );
    }
    await click("确认应用修改");
    await wait(
      conflict
        ? "document.body.textContent.includes('文章已变化')"
        : "window.writingUITest.accepted",
    );
    const after = await evaluate("window.writingUITest");
    assert.equal(after.applied.length, 1);
    assert.equal(after.applied[0].proposalHash, "proposal-hash");
    assert.equal(after.applied[0].expectedRevision, 4);
    assert.equal(after.accepted, !conflict);
  }
  assert.deepEqual(errors, []);
  console.log(
    "Writing Agent UI: retry idempotency, Skill selection, diff/confirmation and conflict checks passed. Screenshot: /tmp/koinote-writing-agent-ui.png",
  );
} finally {
  ws?.close();
  if (browser.pid) {
    browser.kill("SIGTERM");
    await Promise.race([
      new Promise((r) => browser.once("exit", r)),
      delay(2000),
    ]);
  }
  await new Promise((r) => server.close(r));
  await rm(temp, { recursive: true, force: true });
}
