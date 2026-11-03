import { checkArticleKoi } from "./fixtures/article-koi-check.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { build } from "esbuild";
import { checkLocalDevRestart } from "./fixtures/agent-local-restart-check.mjs";
import { checkMixedVersionRequests, checkOpenDuringRestore } from "./fixtures/agent-panel-compatibility-checks.mjs";
import { checkProposalDialog } from "./fixtures/agent-panel-diff-checks.mjs";
import { checkApprovalBatch } from "./fixtures/agent-panel-approval-checks.mjs";
import { checkTaskProgress } from "./fixtures/agent-panel-progress-checks.mjs";
import { checkComposerKeyboard } from "./fixtures/agent-panel-keyboard-checks.mjs";

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
const temp = await mkdtemp(join(tmpdir(), "koinote-agent-panel-ui-"));
await build({
  entryPoints: ["scripts/fixtures/agent-bottom-panel.tsx"],
  outfile: join(temp, "fixture.js"),
  bundle: true,
  platform: "browser",
  format: "esm",
  jsx: "automatic",
  define: { "import.meta.env": "{}" },
  logLevel: "silent",
  // The tree read by the desktop UI is a separate snapshot. Refreshing the
  // React query alone must never make a simulated server write visible.
  plugins: [{ name: "desktop-tree", setup(builder) {
    builder.onResolve({ filter: /^\.\.\/desktop\/(runtime|offlineStore)$/ }, ({ path, importer }) =>
      importer.endsWith("/AgentBottomPanel.tsx") ? { path, namespace: "desktop-tree" } : undefined);
    builder.onLoad({ filter: /.*/, namespace: "desktop-tree" }, ({ path }) => ({
      contents: path.endsWith("runtime") ? "export const isDesktopRuntime = () => true;" :
        `export const syncDesktopNow = options => window.agentUITest.pullTree(options);
         export const desktopPrepareLibraryForOrganization = async () => {
           window.agentUITest.libraryPreparations++;
           return window.agentUITest.libraryConflicts;
         };`,
    }));
  } }],
});
await build({
  entryPoints: ["scripts/fixtures/agent-bottom-panel.tsx"],
  outfile: join(temp, "fixture-v2.js"),
  bundle: true,
  platform: "browser",
  format: "esm",
  jsx: "automatic",
  define: { "import.meta.env": "{}" },
  logLevel: "silent",
  plugins: [{
    name: "legacy-request-cache",
    setup(builder) {
      builder.onLoad({ filter: /\/spa\/src\/agentRequestCache\.ts$/ }, async () => ({
        contents: await readFile("scripts/fixtures/agent-request-cache-v2.ts", "utf8"),
        loader: "ts",
        resolveDir: resolve("scripts/fixtures"),
      }));
    },
  }],
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
const legacyJS = await readFile(join(temp, "fixture-v2.js"));
const logos = new Map(
  await Promise.all(
    ["/logo.png", "/logo-dark.png"].map(async (path) => [
      path,
      await readFile(resolve("public", path.slice(1))),
    ]),
  ),
);
const server = createServer((req, res) => {
  if (req.url.startsWith("/preview-image.svg") || req.url.startsWith("/images/u/preview/abcdef12.png")) {
    res.setHeader("Content-Type", "image/svg+xml");
    res.end('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="240" viewBox="0 0 640 240"><rect width="640" height="240" fill="#e6eee5"/><path d="M0 200 170 70 300 180 430 40 640 210V240H0Z" fill="#789883"/><circle cx="110" cy="55" r="23" fill="#ebc580"/></svg>');
  } else if (logos.has(req.url)) {
    res.setHeader("Content-Type", "image/png");
    res.end(logos.get(req.url));
  } else if (req.url === "/fixture.js") {
    res.setHeader("Content-Type", "text/javascript");
    res.end(js);
  } else if (req.url === "/fixture-v2.js") {
    res.setHeader("Content-Type", "text/javascript");
    res.end(legacyJS);
  } else if (req.url === "/fixture.css") {
    res.setHeader("Content-Type", "text/css");
    res.end(css);
  } else {
    res.setHeader("Content-Type", "text/html");
    res.end(
      '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>'
        .replace("/fixture.js", req.url.includes("request-cache=v2") ? "/fixture-v2.js" : "/fixture.js"),
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
const sockets = new Set();
const errors = [];
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
  const createClient = async () => {
    const target = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, {
      method: "PUT",
    }).then((r) => r.json());
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    sockets.add(ws);
    await new Promise((r, j) => {
      ws.addEventListener("open", r, { once: true });
      ws.addEventListener("error", j, { once: true });
    });
    let seq = 0;
    const pending = new Map();
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
      if (r.exceptionDetails)
        throw new Error(
          r.exceptionDetails.exception?.description ?? r.exceptionDetails.text,
        );
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
      await wait(
        `Array.from(document.querySelectorAll('button')).some(b=>b.textContent===${JSON.stringify(label)} && !b.disabled)`,
      );
      await evaluate(
        `Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(label)}).click()`,
      );
    };
    await send("Runtime.enable");
    await send("Page.enable");
    const clickAria = async (label) => {
      await wait(
        `document.querySelector('button[aria-label='+JSON.stringify(${JSON.stringify(label)})+']')?.disabled === false`,
      );
      return evaluate(
        `document.querySelector('button[aria-label='+JSON.stringify(${JSON.stringify(label)})+']').click()`,
      );
    };
    return {
      send, evaluate, wait, click, clickAria,
      async close() {
        ws.close();
        sockets.delete(ws);
        await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`);
      },
    };
  };
  if (process.env.ARTICLE_KOI_UI_ONLY === "1") {
    await checkArticleKoi(createClient,`http://127.0.0.1:${server.address().port}/?lang=zh&article=1`);
    assert.deepEqual(errors, []);
  } else if (process.env.AGENT_LOCAL_RESTART_ONLY === "1") {
    await checkLocalDevRestart(createClient, temp);
    assert.deepEqual(errors, []);
  } else if (process.env.AGENT_KEYBOARD_UI_ONLY === "1") {
    await checkComposerKeyboard(createClient, `http://127.0.0.1:${server.address().port}/?lang=zh`);
    assert.deepEqual(errors, []);
  } else if (process.env.AGENT_PROGRESS_UI_ONLY === "1") {
    await checkTaskProgress(createClient, `http://127.0.0.1:${server.address().port}/?lang=zh`);
    assert.deepEqual(errors, []);
  } else if (process.env.AGENT_APPROVAL_UI_ONLY === "1") {
    await checkApprovalBatch(createClient, `http://127.0.0.1:${server.address().port}/?lang=zh`);
    assert.deepEqual(errors, []);
    console.log("Agent grouped approval UI passed");
  } else {
  await checkArticleKoi(createClient,`http://127.0.0.1:${server.address().port}/?lang=zh&article=1`);
  const primary = await createClient();
  const { send, evaluate, wait, click, clickAria } = primary;
  await send("Page.navigate", {
    url: `http://127.0.0.1:${server.address().port}/?lang=zh`,
  });
  await wait("document.querySelector('[data-agent-panel]')");
  await evaluate(
    "document.querySelector('.agent-statusbar button').click()",
  );
  await clickAria("新建会话");
  await wait("document.querySelector('textarea')");
  await wait(
    "[...document.querySelectorAll('.agent-avatar img')].every(img => img.complete && img.naturalWidth > 0)",
  );
  assert.equal(
    await evaluate(
      "Boolean(document.querySelector('[data-agent-panel] .lucide-bot'))",
    ),
    false,
    "assistant uses the existing brand logo, not a robot icon",
  );
  await click("整理我的文档");
  const organizeDraft = await evaluate("document.querySelector('textarea').value");
  assert.match(organizeDraft, /按内容主题整理当前项目的文档/);
  assert.match(organizeDraft, /需要移动的文档及其目标文件夹/);
  assert.match(organizeDraft, /保留所有文档的标题和正文/);
  assert.equal(await evaluate("window.agentUITest.submissions.length"), 0,
    "organizing starter fills an editable instruction without sending it");
  assert.equal(await evaluate("document.querySelector('.agent-skill-select') === null"), true);
  await evaluate("document.querySelector('textarea').focus(); document.querySelector('textarea').select()");
  await send("Input.insertText", { text: "帮我修改这篇文章的开头" });
  await click("发送");
  await wait(
    "document.body.textContent.includes('Temporary connection failure')",
  );
  await click("发送");
  await wait("document.querySelector('[data-operation-id]')");
  let state = await evaluate("window.agentUITest");
  assert.equal(state.submissions.length, 2);
  assert.equal(
    state.submissions[0].requestId,
    state.submissions[1].requestId,
    "retry uses the same request ID",
  );
  assert.deepEqual(Object.keys(state.submissions[1].context).sort(), [
    "path",
    "title",
  ]);
  assert.equal(state.submissions[1].context.title, "云南旅行记录");
  assert.equal(state.applied.length, 0, "review waits for user confirmation");
  await checkProposalDialog(primary);
  await evaluate(
    `for(let i=0;i<11;i++) document.querySelector('[role="separator"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}));`,
  );
  await delay(200);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(
    "/tmp/koinote-agent-bottom-panel-diff.png",
    Buffer.from(shot.data, "base64"),
  );
  await clickAria("关闭");
  await evaluate(
    "document.querySelector('.agent-transcript').scrollTop = 0; document.activeElement.blur()",
  );
  await delay(150);
  const overview = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(
    "/tmp/koinote-agent-bottom-panel.png",
    Buffer.from(overview.data, "base64"),
  );
  await evaluate("document.documentElement.classList.add('dark')");
  await delay(150);
  assert.equal(
    await evaluate(
      "[...document.querySelectorAll('.agent-avatar img')].filter(img => getComputedStyle(img).display !== 'none').every(img => img.getAttribute('src') === '/logo-dark.png')",
    ),
    true,
    "dark theme uses the matching reversed logo",
  );
  const dark = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(
    "/tmp/koinote-agent-bottom-panel-dark.png",
    Buffer.from(dark.data, "base64"),
  );
  await evaluate("document.documentElement.classList.remove('dark')");
  await evaluate(
    `let s=document.querySelector('select[aria-label="改动权限"]');s.value='full';s.dispatchEvent(new Event('change',{bubbles:true}));`,
  );
  await wait("window.agentUITest.server.sessions[0].permission==='full'");
  assert.equal(
    await evaluate("window.agentUITest.server.operations[0].status"),
    "pending",
    "changing permission cannot silently apply an existing proposal",
  );
  await click("查看差异");
  await wait("document.querySelector('.agent-diff-dialog')");
  await evaluate("window.agentUITest.failNextOperation=true; [...document.querySelectorAll('.agent-diff-dialog button')].find(b=>b.textContent==='批准应用').click()");
  await wait("document.querySelector('.agent-diff-dialog [role=alert]')?.textContent.includes('Approval temporarily unavailable')");
  assert.equal(await evaluate("window.agentUITest.server.operations[0].status"), "pending");
  await wait("[...document.querySelectorAll('.agent-diff-dialog button')].find(b=>b.textContent==='批准应用')?.disabled===false");
  await evaluate("[...document.querySelectorAll('.agent-diff-dialog button')].find(b=>b.textContent==='批准应用').click()");
  await wait("document.body.textContent.includes('撤销改动')");
  assert.equal(await evaluate("document.querySelector('.agent-diff-dialog').textContent.includes('撤销改动')"), true,
    "approval from the dialog updates its actions without applying twice");
  await clickAria("关闭");
  await click("撤销改动");
  await wait("window.agentUITest.server.operations[0].status==='undone'");
  await clickAria("新建会话");
  await wait(
    "document.querySelectorAll('[role=tab]').length===2 && document.querySelector('select[aria-label=\"改动权限\"]')?.value==='review'",
  );
  assert.equal(
    await evaluate("document.querySelector('.agent-skill-select') === null"),
    true,
    "new chats discover Skills automatically",
  );
  await evaluate("document.querySelector('textarea').focus()");
  await send("Input.insertText", { text: "第二个会话的草稿" });
  await wait("document.querySelector('[data-folder-tree]').dataset.loading==='false'");
  const beforeBackgroundFetches = await evaluate("window.agentUITest.folderFetches");
  await evaluate(
    "window.agentUITest.startBackgroundTask(window.agentUITest.server.sessions[1].id)",
  );
  await wait("document.body.textContent.includes('· 1 任务执行中')");
  await wait(`window.agentUITest.folderFetches>${beforeBackgroundFetches} && document.querySelector('[data-folder-tree]').dataset.loading==='false'`);
  const backgroundActivity = await evaluate(
    "({active:window.agentUITest.server.sessions[1].activeTasks,pending:window.agentUITest.server.sessions[1].pendingOperations})",
  );
  await evaluate(
    "window.agentUITest.applyBackgroundFolder(window.agentUITest.server.sessions[1].id)",
  );
  await wait(
    "document.querySelector('[data-folder-tree]').textContent.includes('后台生成文件夹')",
  );
  assert.equal(
    await evaluate("document.querySelector('textarea').value"),
    "第二个会话的草稿",
    "background auto-apply refreshes the file tree before task completion",
  );
  assert.deepEqual(
    await evaluate(
      "({active:window.agentUITest.server.sessions[1].activeTasks,pending:window.agentUITest.server.sessions[1].pendingOperations})",
    ),
    backgroundActivity,
    "refresh must not depend on a running/pending count change",
  );
  assert.equal(
    await evaluate(
      "document.querySelector('.agent-transcript').textContent.includes('后台创建完成')",
    ),
    false,
    "background conversation remains inactive",
  );
  await evaluate(
    "window.agentUITest.completeBackgroundTask(window.agentUITest.server.sessions[1].id)",
  );
  await evaluate("document.querySelectorAll('[role=tab]')[0].click()");
  await wait("document.querySelector('textarea')?.value===''");
  assert.equal(
    await evaluate("document.querySelector('.agent-skill-select') === null"),
    true,
    "returning to a chat does not expose Skill selection",
  );
  await evaluate("document.querySelectorAll('[role=tab]')[1].click()");
  await wait("document.querySelector('textarea')?.value==='第二个会话的草稿'");
  await clickAria("关闭标签，保留历史: 新会话");
  await wait("document.querySelectorAll('[role=tab]').length===1");
  assert.equal(
    await evaluate("window.agentUITest.server.sessions.length"),
    2,
    "closing a tab preserves cloud history",
  );
  await clickAria("会话历史");
  await wait("document.querySelector('aside')");
  await evaluate(
    "Array.from(document.querySelectorAll('aside button')).find(b=>b.textContent==='新会话').click()",
  );
  await wait("document.querySelector('textarea')?.value==='第二个会话的草稿'");
  await evaluate("window.agentUITest.switchDoc()");
  await wait("document.body.textContent.includes('当前文档: 产品介绍')");
  await click("发送");
  await wait("window.agentUITest.submissions.length===3");
  state = await evaluate("window.agentUITest");
  assert.equal(state.submissions[2].context.title, "产品介绍");
  assert.equal(
    state.submissions[1].context.title,
    "云南旅行记录",
    "new focus cannot retarget an earlier task",
  );
  await wait("document.querySelector('[data-operation-id]')");
  await clickAria("隐藏面板");
  await wait("!document.querySelector('textarea')");
  await send("Page.reload");
  await wait("document.querySelector('[data-agent-panel]')");
  assert.equal(
    await evaluate("Boolean(document.querySelector('textarea'))"),
    false,
    "hidden state survives restart",
  );
  await evaluate("document.querySelector('[data-agent-panel] button').click()");
  await wait(
    "document.querySelectorAll('[role=tab]').length===2 && document.querySelector('[data-operation-id]')",
  );
  await send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await delay(200);
  assert.equal(
    await evaluate("document.documentElement.scrollWidth<=innerWidth+1"),
    true,
    "panel fits a narrow window",
  );
  assert.equal(await evaluate("document.querySelector('.agent-manage-skills') === null"), true,
    "the composer does not ask users to manage or select Skills");
  const mobile = await send("Page.captureScreenshot", { format: "png" });
  await writeFile(
    "/tmp/koinote-agent-bottom-panel-mobile.png",
    Buffer.from(mobile.data, "base64"),
  );
  await clickAria("会话历史");
  await wait("document.querySelector('aside button')");
  await evaluate(
    "Array.from(document.querySelectorAll('aside button')).find(b=>b.textContent==='删除会话').click()",
  );
  await wait("document.querySelector('[role=dialog]')");
  await click("确认删除");
  await wait("window.agentUITest.server.sessions.length===1");
  await evaluate(
    "document.querySelector('main').parentElement.style.height='auto';document.querySelector('main').style.minHeight='2000px';window.scrollTo(0,0)",
  );
  await delay(100);
  assert.ok(
    await evaluate(
      "document.querySelector('[data-agent-panel]').getBoundingClientRect().bottom<=innerHeight+1",
    ),
    "panel remains at viewport bottom on a long page",
  );
  const newTestSession = async (client = primary) => {
    const { evaluate, clickAria, wait } = client;
    const tabCount = await evaluate(
      "document.querySelectorAll('[role=tab]').length",
    );
    await clickAria("新建会话");
    await wait(
      `document.querySelectorAll('[role=tab]').length===${tabCount + 1} && document.querySelector('textarea')?.value==='' && document.querySelector('select[aria-label="改动权限"]')?.disabled === false`,
    );
  };
  for (const restart of [false, true]) {
    await newTestSession();
    await evaluate(`{
      window.agentUITest.failFirst = false;
      window.agentUITest.loseNextResponse = true;
      window.agentUITest.server.documentTitles['00000000-0000-4000-8000-000000000001']='Original title';
      window.agentUITest.switchDoc('00000000-0000-4000-8000-000000000001');
      let permission=document.querySelector('select[aria-label="改动权限"]');
      permission.value='full';permission.dispatchEvent(new Event('change',{bubbles:true}));
    }`);
    await wait("window.agentUITest.server.sessions[0].permission==='full'");
    await evaluate("document.querySelector('textarea').focus()");
    await send("Input.insertText", { text: "修改文章标题和开头" });
    await click("发送");
    await wait(
      "document.body.textContent.includes('Accepted response was lost') && document.body.textContent.includes('Agent renamed article')",
    );
    const accepted = await evaluate("window.agentUITest.submissions.at(-1)");
    const sessionID = await evaluate("window.agentUITest.server.sessions[0].id");
    if (restart) {
      // Persist the previous client format too: retries must work after upgrading.
      await evaluate(`{
        const key='koinote:agent-request-v2:agent-ui-test:'+${JSON.stringify(sessionID)}+':'+${JSON.stringify(accepted.requestId)};
        const pending=JSON.parse(localStorage.getItem(key));
        const {requestId,...payload}=pending.input;
        pending.fingerprint=JSON.stringify(payload);
        delete pending.draftId;
        const layoutKey='koinote:agent-panel:agent-ui-test';
        const layout=JSON.parse(localStorage.getItem(layoutKey));
        delete layout.draftIds;
        localStorage.setItem(layoutKey,JSON.stringify(layout));
        sessionStorage.removeItem('koinote:agent-panel-window:agent-ui-test');
        localStorage.setItem('koinote:agent-requests:agent-ui-test',JSON.stringify([[${JSON.stringify(sessionID)},pending]]));
        localStorage.removeItem(key);sessionStorage.removeItem(key);
      }`);
      await send("Page.reload");
      await wait(
        "document.querySelector('textarea')?.value==='修改文章标题和开头' && document.body.textContent.includes('Agent renamed article')",
      );
    }
    await click("发送");
    await wait("document.querySelector('textarea')?.value===''");
    assert.deepEqual(
      await evaluate("window.agentUITest.submissions.at(-1)"),
      accepted,
      `lost-response retry preserves the entire accepted request (restart=${restart})`,
    );
    assert.equal(
      await evaluate(
        `window.agentUITest.server.tasks[${JSON.stringify(sessionID)}].length`,
      ),
      1,
      "retry must not create another paid task",
    );
    assert.equal(
      await evaluate(
        `window.agentUITest.server.sessions.find(s=>s.id===${JSON.stringify(sessionID)}).chargedCredits`,
      ),
      2,
      "retry must not charge twice",
    );
    if (restart) {
      // Completing a migrated request must not resurrect it from the old cache.
      await send("Page.reload");
      await wait("document.querySelector('textarea')?.value===''");
      await evaluate("window.agentUITest.failFirst=false;document.querySelector('textarea').focus()");
      await send("Input.insertText", { text: accepted.message });
      await click("发送");
      await wait("document.querySelector('textarea')?.value===''");
      assert.notEqual(await evaluate("window.agentUITest.submissions.at(-1).requestId"), accepted.requestId);
      assert.equal(await evaluate(`window.agentUITest.server.tasks[${JSON.stringify(sessionID)}].length`), 2);
    }
  }
  // A selected-Skill request from an older window must keep its original wire
  // payload after upgrading, including after another window archives it.
  for (const restart of [false, true]) {
    await newTestSession();
    await evaluate("window.agentUITest.failFirst=false;window.agentUITest.loseNextResponse=true;window.agentUITest.switchDoc('00000000-0000-4000-8000-000000000001');document.querySelector('textarea').focus()");
    await send("Input.insertText", { text: "旧版选择 Skill 后发送的消息" });
    const legacy = await evaluate(`(async () => {
      const layout=window.agentUITest.layoutStorage.read('agent-ui-test');
      const request=await window.agentUITest.requestCache().prepare(layout.active, {
        message:'旧版选择 Skill 后发送的消息',
        context:{title:'升级前的标题',path:'/documents/00000000-0000-4000-8000-000000000001'},
        skillRepositoryId:7,skillPath:'writing/SKILL.md'
      }, layout.draftIds[layout.active]);
      return request;
    })()`);
    await click("发送");
    await wait("document.body.textContent.includes('Accepted response was lost')");
    assert.deepEqual(await evaluate("window.agentUITest.submissions.at(-1)"), legacy.input,
      "automatic loading must not change an older in-flight request");
    // Simulate a peer receiving the acknowledgement before this draft recovers.
    await evaluate(`window.agentUITest.requestCache().complete(${JSON.stringify(legacy)})`);
    const retry = restart ? await createClient() : primary;
    try {
      await retry.send(restart ? "Page.navigate" : "Page.reload", restart ? {url:`http://127.0.0.1:${server.address().port}/?lang=zh`} : {});
      await retry.wait("document.querySelector('textarea')?.value==='旧版选择 Skill 后发送的消息'");
      await retry.evaluate("window.agentUITest.failFirst=false");
      await retry.click("发送");
      await retry.wait("document.querySelector('textarea')?.value===''");
      assert.deepEqual(await retry.evaluate("window.agentUITest.submissions.at(-1)"), legacy.input);
      await retry.evaluate("document.querySelector('textarea').focus()");
      await retry.send("Input.insertText", {text:legacy.input.message});
      await retry.click("发送");
      await retry.wait("document.querySelector('textarea')?.value===''");
      const followup=await retry.evaluate("window.agentUITest.submissions.at(-1)");
      assert.notEqual(followup.requestId,legacy.input.requestId);
      assert.equal(followup.skillRepositoryId,0);
      assert.equal(followup.skillPath,"");
      assert.equal(await retry.evaluate(`window.agentUITest.server.tasks[${JSON.stringify(legacy.sessionId)}].length`),2);
    } finally { if(restart) {await retry.close();await send("Page.reload");await wait("document.querySelector('textarea')");} }
  }
  for (const change of ["message", "document"]) {
    await newTestSession();
    await evaluate(
      "window.agentUITest.failFirst=true;window.agentUITest.switchDoc('00000000-0000-4000-8000-000000000001');document.querySelector('textarea').focus()",
    );
    await send("Input.insertText", { text: "原始请求" });
    await click("发送");
    await wait("document.body.textContent.includes('Temporary connection failure')");
    const failed = await evaluate("window.agentUITest.submissions.at(-1)");
    if (change === "message") {
      await evaluate(
        "{let input=document.querySelector('textarea');input.focus();input.setSelectionRange(0,input.value.length)}",
      );
      await send("Input.insertText", { text: "改成新的请求" });
    } else if (change === "document") {
      await evaluate("window.agentUITest.switchDoc()");
      await wait("document.body.textContent.includes('当前文档: 产品介绍')");
    }
    await click("发送");
    await wait("document.querySelector('textarea')?.value===''");
    const retried = await evaluate("window.agentUITest.submissions.at(-1)");
    assert.notEqual(
      retried.requestId,
      failed.requestId,
      `${change} change creates a new request`,
    );
  }
  for (const scenario of ["persisted", "legacy", "legacy-session", "legacy-fresh", "legacy-session-fresh", "cancelled"]) {
    await newTestSession();
    assert.equal(
      await evaluate("document.body.textContent.includes('正在调整上一份提案')"),
      false,
      "adjustments are isolated between sessions",
    );
    await evaluate("window.agentUITest.failFirst=false;document.querySelector('textarea').focus()");
    await send("Input.insertText", { text: "初始提案" });
    await click("发送");
    await wait("document.querySelector('textarea')?.value===''");
    await click("要求调整");
    await evaluate("document.querySelector('textarea').focus()");
    await send("Input.insertText", { text: "进一步调整开头" });
    if (scenario === "persisted") {
      await send("Page.reload");
      await wait("document.querySelector('textarea')?.value==='进一步调整开头' && document.body.textContent.includes('正在调整上一份提案')");
    }
    await evaluate(`{
      let permission=document.querySelector('select[aria-label="改动权限"]');
      permission.value='full';permission.dispatchEvent(new Event('change',{bubbles:true}));
    }`);
    await wait("window.agentUITest.server.sessions[0].permission==='full'");
    await evaluate(`window.agentUITest.failFirst=${scenario === "cancelled"};window.agentUITest.loseNextResponse=${scenario !== "cancelled"}`);
    await click("发送");
    await wait(`document.body.textContent.includes(${JSON.stringify(scenario === "cancelled" ? "Temporary connection failure" : "Accepted response was lost")})`);
    const original = await evaluate("window.agentUITest.submissions.at(-1)");
    const sessionID = await evaluate("window.agentUITest.server.sessions[0].id");
    assert.ok(original.supersedeTaskId, "adjustment carries its previous task");
    if (scenario.startsWith("legacy")) {
      await evaluate(`{
        const key='koinote:agent-panel:agent-ui-test';
        const layout=JSON.parse(localStorage.getItem(key));
        delete layout.adjusting;delete layout.ignored;delete layout.draftIds;
        localStorage.setItem(key,JSON.stringify(layout));
        sessionStorage.removeItem('koinote:agent-panel-window:agent-ui-test');
        const input=${JSON.stringify(original)};
        const {requestId,...payload}=input;
        const pending={fingerprint:JSON.stringify(payload),input};
        if (${JSON.stringify(scenario)}.startsWith('legacy-session'))
          localStorage.setItem('koinote:agent-request:agent-ui-test:'+${JSON.stringify(sessionID)},JSON.stringify(pending));
        else
          localStorage.setItem('koinote:agent-requests:agent-ui-test',JSON.stringify([[${JSON.stringify(sessionID)},pending]]));
        const requestKey='koinote:agent-request-v2:agent-ui-test:'+${JSON.stringify(sessionID)}+':'+input.requestId;
        localStorage.removeItem(requestKey);sessionStorage.removeItem(requestKey);
      }`);
    } else if (scenario === "cancelled") {
      await click("取消调整");
      await wait("!document.body.textContent.includes('正在调整上一份提案')");
    }
    // Exercise both reload and a genuinely new window with no private snapshot.
    const recovery = scenario.endsWith("-fresh") ? await createClient() : primary;
    try {
      if (recovery === primary) await recovery.send("Page.reload");
      else await recovery.send("Page.navigate", {url: `http://127.0.0.1:${server.address().port}/?lang=zh`});
      await recovery.wait("document.querySelector('textarea')?.value==='进一步调整开头'");
      assert.equal(
        await recovery.evaluate("document.body.textContent.includes('正在调整上一份提案')"),
        scenario !== "cancelled",
        "restore adjustment intent, but respect explicit cancellation",
      );
      if (scenario === "legacy" || scenario === "legacy-session") {
        // Both windows restore the same legacy draft before either retries.
        // The peer's acknowledgement must not discard this window's request ID.
        const peer = await createClient();
        try {
          await peer.send("Page.navigate", {url: `http://127.0.0.1:${server.address().port}/?lang=zh`});
          await peer.wait("document.querySelector('textarea')?.value==='进一步调整开头' && document.body.textContent.includes('正在调整上一份提案')");
          await peer.click("发送");
          await peer.wait("document.querySelector('textarea')?.value===''");
          assert.deepEqual(await peer.evaluate("window.agentUITest.submissions.at(-1)"), original);
        } finally { await peer.close(); }
        await recovery.send("Page.reload");
        await recovery.wait("document.querySelector('textarea')?.value==='进一步调整开头' && document.body.textContent.includes('正在调整上一份提案')");
      }
      await recovery.evaluate("window.agentUITest.failFirst=false");
      await recovery.click("发送");
      await recovery.wait("document.querySelector('textarea')?.value===''");
      const retried = await recovery.evaluate("window.agentUITest.submissions.at(-1)");
      if (scenario === "cancelled") {
        assert.notEqual(retried.requestId, original.requestId);
        assert.equal(retried.supersedeTaskId, undefined);
      } else {
        assert.deepEqual(retried, original, `${scenario} adjustment retry preserves the complete request`);
      }
      assert.equal(
        await recovery.evaluate(`window.agentUITest.server.tasks[${JSON.stringify(sessionID)}].length`),
        2,
        "one original task and one adjustment, without a duplicate",
      );
      assert.equal(
        await recovery.evaluate(`window.agentUITest.server.sessions.find(s=>s.id===${JSON.stringify(sessionID)}).chargedCredits`),
        4,
        "adjustment is charged only once",
      );
    } finally {
      if (recovery !== primary) await recovery.close();
    }
    await send("Page.reload");
    await wait("document.querySelector('textarea')?.value===''");
    assert.equal(
      await evaluate("document.body.textContent.includes('正在调整上一份提案')"),
      false,
      "successful submission clears the persisted adjustment",
    );
    if (scenario.startsWith("legacy")) {
      // Reload in the original window reads its private snapshot. A brand-new
      // window must also see the migrated draft and target cleared in shared state.
      const fresh = await createClient();
      try {
        await fresh.send("Page.navigate", {url: `http://127.0.0.1:${server.address().port}/?lang=zh`});
        await fresh.wait("document.querySelector('textarea')");
        assert.equal(await fresh.evaluate("document.querySelector('textarea').value"), "",
          "a fresh window must not resurrect a successfully submitted legacy adjustment");
        assert.equal(await fresh.evaluate("document.body.textContent.includes('正在调整上一份提案')"), false);
        assert.equal(await fresh.evaluate(`window.agentUITest.server.tasks[${JSON.stringify(sessionID)}].length`), 2);
        assert.equal(await fresh.evaluate(`window.agentUITest.server.sessions.find(s=>s.id===${JSON.stringify(sessionID)}).chargedCredits`), 4);
      } finally { await fresh.close(); }
    }
  }
  await newTestSession();
  await evaluate("window.agentUITest.failFirst=false;window.agentUITest.loseNextResponse=true");
  await clickAria("移除当前文档上下文");
  await evaluate("document.querySelector('textarea').focus()");
  await send("Input.insertText", { text: "不附加文章的新任务" });
  await click("发送");
  await wait("document.body.textContent.includes('Accepted response was lost')");
  const detached = await evaluate("window.agentUITest.submissions.at(-1)");
  assert.equal(detached.context, undefined);
  await send("Page.reload");
  await wait("document.querySelector('textarea')?.value==='不附加文章的新任务'");
  assert.ok(await evaluate("document.body.textContent.includes('未附加当前文档')"));
  await evaluate("window.agentUITest.failFirst=false");
  await click("发送");
  await wait("document.querySelector('textarea')?.value===''");
  assert.deepEqual(await evaluate("window.agentUITest.submissions.at(-1)"), detached);

  // Restoring context is an explicit choice and survives another reload.
  await send("Page.reload");
  await wait("document.querySelector('textarea')?.value===''");
  await evaluate("window.agentUITest.switchDoc()");
  await wait("document.querySelector('.agent-context').textContent.includes('当前文档: 产品介绍')");
  await evaluate("window.agentUITest.switchDoc('00000000-0000-4000-8000-000000000001')");
  await wait("document.querySelector('.agent-context').textContent.includes('未附加当前文档')");
  await clickAria("附加当前文档");
  await wait("document.querySelector('.agent-context').textContent.includes('当前文档:')");
  await send("Page.reload");
  await wait("document.querySelector('textarea') && document.querySelector('.agent-context').textContent.includes('当前文档:')");
  await evaluate("window.agentUITest.failFirst=false;document.querySelector('textarea').focus()");
  await send("Input.insertText", { text: "重新附加当前文章" });
  await click("发送");
  await wait("document.querySelector('textarea')?.value===''");
  const reattached = await evaluate("window.agentUITest.submissions.at(-1)");
  assert.equal(reattached.context.path, "/documents/00000000-0000-4000-8000-000000000001");
  assert.notEqual(reattached.requestId, detached.requestId, "reattaching context creates a new request intent");
  await evaluate("{const clear=window.agentUITest.switchDoc('00000000-0000-4000-8000-000000000001');clear();}");
  await wait("document.querySelector('.agent-context').textContent.includes('未附加当前文档')");
  assert.equal(
    await evaluate("Boolean(document.querySelector('button[aria-label=\"附加当前文档\"]'))"),
    false,
    "no attachment action without a valid focused document",
  );
  await evaluate("window.agentUITest.switchDoc('00000000-0000-4000-8000-000000000001')");

  for (const responseTiming of ["before-remount", "after-remount"]) {
    await newTestSession();
    await evaluate("window.agentUITest.failFirst=false;window.agentUITest.holdNextResponse=true;window.agentUITest.responseHeld=false;document.querySelector('textarea').focus()");
    await send("Input.insertText", { text: "退出账号期间的请求" });
    await click("发送");
    await wait("window.agentUITest.responseHeld");
    const accepted = await evaluate("window.agentUITest.submissions.at(-1)");
    const sessionID = await evaluate("window.agentUITest.server.sessions[0].id");
    await evaluate("window.agentUITest.unmount()");
    await wait("!document.querySelector('[data-agent-panel]')");
    if (responseTiming === "before-remount") {
      await evaluate("window.agentUITest.releaseResponse()");
      assert.deepEqual(
        await evaluate(`window.agentUITest.pendingRequests().find(r=>r.input.requestId===${JSON.stringify(accepted.requestId)})?.input`),
        accepted,
        "a response after logout must preserve the original retry request",
      );
    }
    await evaluate("window.agentUITest.remount()");
    await wait("document.querySelector('textarea')?.value==='退出账号期间的请求'");
    await click("发送");
    await wait("document.querySelector('textarea')?.value===''");
    assert.deepEqual(await evaluate("window.agentUITest.submissions.at(-1)"), accepted);
    assert.equal(
      await evaluate(`window.agentUITest.server.tasks[${JSON.stringify(sessionID)}].length`),
      1,
      "relogin retry creates no duplicate task",
    );
    assert.equal(
      await evaluate(`window.agentUITest.server.sessions.find(s=>s.id===${JSON.stringify(sessionID)}).chargedCredits`),
      2,
      "relogin retry is charged only once",
    );
    if (responseTiming === "after-remount") {
      await evaluate("window.agentUITest.failFirst=true;document.querySelector('textarea').focus()");
      await send("Input.insertText", { text: "重新登录后的新请求" });
      await click("发送");
      await wait("document.body.textContent.includes('Temporary connection failure')");
      const nextRequest = await evaluate("window.agentUITest.submissions.at(-1)");
      const nextCache = await evaluate(`JSON.stringify(window.agentUITest.pendingRequests().find(r=>r.input.requestId===${JSON.stringify(nextRequest.requestId)}))`);
      assert.notEqual(nextRequest.requestId, accepted.requestId);
      await evaluate("window.agentUITest.releaseResponse()");
      assert.equal(
        await evaluate(`JSON.stringify(window.agentUITest.pendingRequests().find(r=>r.input.requestId===${JSON.stringify(nextRequest.requestId)}))`),
        nextCache,
        "the old instance must not erase a new instance's pending request",
      );
      await send("Page.reload");
      await wait("document.querySelector('textarea')?.value==='重新登录后的新请求'");
      await evaluate("window.agentUITest.failFirst=false");
      await click("发送");
      await wait("document.querySelector('textarea')?.value===''");
      assert.deepEqual(await evaluate("window.agentUITest.submissions.at(-1)"), nextRequest);
      assert.equal(
        await evaluate(`window.agentUITest.server.tasks[${JSON.stringify(sessionID)}].length`),
        2,
        "one original task and one genuinely new request",
      );
    }
  }

  // Both clients mount before either submits, so neither starts with the other
  // client's pending requests. Real tabs have separate heaps and shared storage.
  for (const peerLosesResponse of [false, true]) {
    await newTestSession();
    const originalMessage = `跨窗口保留原请求 ${peerLosesResponse}`;
    const peerMessage = `另一窗口的独立请求 ${peerLosesResponse}`;
    await evaluate("document.querySelector('textarea').focus()");
    await send("Input.insertText", { text: originalMessage });
    await wait(`JSON.parse(localStorage.getItem('koinote:agent-panel:agent-ui-test')).drafts[JSON.parse(localStorage.getItem('koinote:agent-panel:agent-ui-test')).active]===${JSON.stringify(originalMessage)}`);
    const peer = await createClient();
    try {
      await peer.send("Page.navigate", {
        url: `http://127.0.0.1:${server.address().port}/?lang=zh`,
      });
      await peer.wait(`document.querySelector('textarea')?.value===${JSON.stringify(originalMessage)}`);
      await evaluate("window.agentUITest.failFirst=false;window.agentUITest.loseNextResponse=true");
      await click("发送");
      await wait("document.body.textContent.includes('Accepted response was lost')");
      const accepted = await evaluate("window.agentUITest.submissions.at(-1)");
      const sessionID = await evaluate("window.agentUITest.server.sessions[0].id");
      if (peerLosesResponse) {
        // Previous per-session records must also survive another window's writes.
        await evaluate(`{
          const key='koinote:agent-request-v2:agent-ui-test:'+${JSON.stringify(sessionID)}+':'+${JSON.stringify(accepted.requestId)};
          const pending=JSON.parse(localStorage.getItem(key));
          localStorage.setItem('koinote:agent-request:agent-ui-test:'+${JSON.stringify(sessionID)},JSON.stringify(pending));
          localStorage.removeItem(key);sessionStorage.removeItem(key);
        }`);
      }

      await newTestSession(peer);
      await peer.evaluate(`window.agentUITest.failFirst=false;window.agentUITest.loseNextResponse=${peerLosesResponse};document.querySelector('textarea').focus()`);
      await peer.send("Input.insertText", { text: peerMessage });
      await peer.click("发送");
      await peer.wait(peerLosesResponse
        ? "document.body.textContent.includes('Accepted response was lost')"
        : "document.querySelector('textarea')?.value===''");
      const peerAccepted = await peer.evaluate("window.agentUITest.submissions.at(-1)");
      const peerSessionID = await peer.evaluate("window.agentUITest.server.sessions[0].id");

      await send("Page.reload");
      await wait(`Array.from(document.querySelectorAll('[role=tab]')).some(b=>b.textContent===${JSON.stringify(originalMessage)})`);
      await evaluate(`Array.from(document.querySelectorAll('[role=tab]')).find(b=>b.textContent===${JSON.stringify(originalMessage)}).click()`);
      await wait(`document.querySelector('textarea')?.value===${JSON.stringify(originalMessage)}`);
      await evaluate("window.agentUITest.failFirst=false");
      await click("发送");
      await wait("document.querySelector('textarea')?.value===''");
      assert.deepEqual(
        await evaluate("window.agentUITest.submissions.at(-1)"), accepted,
        "another live window must not replace the original retry request",
      );
      assert.equal(await evaluate(`window.agentUITest.server.tasks[${JSON.stringify(sessionID)}].length`), 1);
      assert.equal(await evaluate(`window.agentUITest.server.sessions.find(s=>s.id===${JSON.stringify(sessionID)}).chargedCredits`), 2);

      if (peerLosesResponse) {
        // Completing A must also preserve B's pending request across a reload.
        await peer.send("Page.reload");
        await peer.wait(`Array.from(document.querySelectorAll('[role=tab]')).some(b=>b.textContent===${JSON.stringify(peerMessage)})`);
        await peer.evaluate(`Array.from(document.querySelectorAll('[role=tab]')).find(b=>b.textContent===${JSON.stringify(peerMessage)}).click()`);
        await peer.wait(`document.querySelector('textarea')?.value===${JSON.stringify(peerMessage)}`);
        await peer.evaluate("window.agentUITest.failFirst=false");
        await peer.click("发送");
        await peer.wait("document.querySelector('textarea')?.value===''");
        assert.deepEqual(await peer.evaluate("window.agentUITest.submissions.at(-1)"), peerAccepted);
        assert.equal(await peer.evaluate(`window.agentUITest.server.tasks[${JSON.stringify(peerSessionID)}].length`), 1);
        assert.equal(await peer.evaluate(`window.agentUITest.server.sessions.find(s=>s.id===${JSON.stringify(peerSessionID)}).chargedCredits`), 2);
      }
    } finally {
      await peer.close();
    }
  }

  // A second window must read a request saved after mount. Once it starts a
  // newer request, the first window's late success must not delete that record.
  await newTestSession();
  await evaluate("document.querySelector('textarea').focus()");
  await send("Input.insertText", { text: "跨窗口同一会话重试" });
  await wait("localStorage.getItem('koinote:agent-panel:agent-ui-test').includes('跨窗口同一会话重试')");
  const peer = await createClient();
  try {
    await peer.send("Page.navigate", {
      url: `http://127.0.0.1:${server.address().port}/?lang=zh`,
    });
    await peer.wait("document.querySelector('textarea')?.value==='跨窗口同一会话重试'");
    await evaluate("window.agentUITest.failFirst=false;window.agentUITest.holdNextResponse=true;window.agentUITest.responseHeld=false");
    await click("发送");
    await wait("window.agentUITest.responseHeld");
    const accepted = await evaluate("window.agentUITest.submissions.at(-1)");
    const sessionID = await evaluate("window.agentUITest.server.sessions[0].id");
    await peer.evaluate("window.agentUITest.failFirst=false");
    await peer.click("发送");
    await peer.wait("document.querySelector('textarea')?.value===''");
    assert.deepEqual(await peer.evaluate("window.agentUITest.submissions.at(-1)"), accepted);
    assert.equal(await peer.evaluate(`window.agentUITest.server.tasks[${JSON.stringify(sessionID)}].length`), 1);
    assert.equal(await peer.evaluate(`window.agentUITest.server.sessions.find(s=>s.id===${JSON.stringify(sessionID)}).chargedCredits`), 2);

    await peer.evaluate("window.agentUITest.failFirst=true;document.querySelector('textarea').focus()");
    await peer.send("Input.insertText", { text: "另一窗口的后续新请求" });
    await peer.click("发送");
    await peer.wait("document.body.textContent.includes('Temporary connection failure')");
    const nextRequest = await peer.evaluate("window.agentUITest.submissions.at(-1)");
    await evaluate("window.agentUITest.releaseResponse()");
    assert.deepEqual(
      await peer.evaluate(`window.agentUITest.pendingRequests().find(r=>r.input.requestId===${JSON.stringify(nextRequest.requestId)})?.input`),
      nextRequest,
      "a late response in a live window must not erase another window's newer request",
    );
    await peer.send("Page.reload");
    await peer.wait("document.querySelector('textarea')?.value==='另一窗口的后续新请求'");
    await peer.evaluate("window.agentUITest.failFirst=false");
    await peer.click("发送");
    await peer.wait("document.querySelector('textarea')?.value===''");
    assert.deepEqual(await peer.evaluate("window.agentUITest.submissions.at(-1)"), nextRequest);
    assert.equal(await peer.evaluate(`window.agentUITest.server.tasks[${JSON.stringify(sessionID)}].length`), 2);
  } finally {
    await peer.close();
  }

  // Two different unresolved intents in the same session must coexist. Test
  // both a live retry (the regression) and restoring both windows after reload.
  for (const restart of [false, true]) {
    await newTestSession();
    const messageA = `同会话窗口 A 的原请求 ${restart}`;
    const messageB = `同会话窗口 B 的不同请求 ${restart}`;
    await evaluate("document.querySelector('textarea').focus()");
    await send("Input.insertText", { text: messageA });
    await wait(`localStorage.getItem('koinote:agent-panel:agent-ui-test').includes(${JSON.stringify(messageA)})`);
    const peer = await createClient();
    try {
      await peer.send("Page.navigate", {url: `http://127.0.0.1:${server.address().port}/?lang=zh`});
      await peer.wait(`document.querySelector('textarea')?.value===${JSON.stringify(messageA)}`);
      await evaluate("window.agentUITest.failFirst=false;window.agentUITest.loseNextResponse=true");
      await click("发送");
      await wait("document.body.textContent.includes('Accepted response was lost')");
      const accepted = await evaluate("window.agentUITest.submissions.at(-1)");
      const sessionID = await evaluate("window.agentUITest.server.sessions[0].id");
      await peer.evaluate("{const input=document.querySelector('textarea');input.focus();input.setSelectionRange(0,input.value.length);window.agentUITest.failFirst=true;}");
      await peer.send("Input.insertText", {text: messageB});
      await peer.click("发送");
      await peer.wait("document.body.textContent.includes('Temporary connection failure')");
      const other = await peer.evaluate("window.agentUITest.submissions.at(-1)");
      assert.equal(await evaluate(`window.agentUITest.pendingRequests().filter(r=>r.sessionId===${JSON.stringify(sessionID)}).length`), 2);
      if (restart) {
        await send("Page.reload");
        await wait(`document.querySelector('textarea')?.value===${JSON.stringify(messageA)}`);
      }
      await click("发送");
      await wait("document.querySelector('textarea')?.value===''");
      assert.deepEqual(await evaluate("window.agentUITest.submissions.at(-1)"), accepted,
        "a different shared request must not replace A's matching original request");
      assert.equal(await evaluate(`window.agentUITest.server.tasks[${JSON.stringify(sessionID)}].length`), 1);
      assert.equal(await evaluate(`window.agentUITest.server.sessions.find(s=>s.id===${JSON.stringify(sessionID)}).chargedCredits`), 2);
      assert.deepEqual(await evaluate(`window.agentUITest.pendingRequests().find(r=>r.input.requestId===${JSON.stringify(other.requestId)})?.input`), other);

      await peer.send("Page.reload");
      await peer.wait(`document.querySelector('textarea')?.value===${JSON.stringify(messageB)}`);
      await peer.evaluate("window.agentUITest.failFirst=false");
      await peer.click("发送");
      await peer.wait("document.querySelector('textarea')?.value===''");
      assert.deepEqual(await peer.evaluate("window.agentUITest.submissions.at(-1)"), other);
      assert.equal(await peer.evaluate(`window.agentUITest.server.tasks[${JSON.stringify(sessionID)}].length`), 2);
      assert.equal(await peer.evaluate(`window.agentUITest.server.sessions.find(s=>s.id===${JSON.stringify(sessionID)}).chargedCredits`), 4);
      assert.equal(await peer.evaluate(`window.agentUITest.pendingRequests().filter(r=>r.sessionId===${JSON.stringify(sessionID)}).length`), 0);
    } finally { await peer.close(); }
  }

  // Hiding a stale panel must preserve another window's unsent composer, both
  // in that window and in the shared fallback used when opening a new window.
  await newTestSession();
  await evaluate("document.querySelector('textarea').focus()");
  await send("Input.insertText", {text: "窗口 A 保留自己的草稿"});
  await wait("localStorage.getItem('koinote:agent-panel:agent-ui-test').includes('窗口 A 保留自己的草稿')");
  const draftPeer = await createClient();
  try {
    await draftPeer.send("Page.navigate", {url: `http://127.0.0.1:${server.address().port}/?lang=zh`});
    await draftPeer.wait("document.querySelector('textarea')?.value==='窗口 A 保留自己的草稿'");
    await draftPeer.evaluate("{const input=document.querySelector('textarea');input.focus();input.setSelectionRange(0,input.value.length);}");
    await draftPeer.send("Input.insertText", {text: "窗口 B 尚未发送的新草稿"});
    await draftPeer.clickAria("移除当前文档上下文");
    await draftPeer.wait("localStorage.getItem('koinote:agent-panel:agent-ui-test').includes('窗口 B 尚未发送的新草稿')");
    await evaluate("document.querySelector('.agent-statusbar button').click()");
    await wait("!document.querySelector('textarea') && JSON.parse(localStorage.getItem('koinote:agent-panel:agent-ui-test')).open===false");
    await draftPeer.send("Page.reload");
    await draftPeer.wait("document.querySelector('textarea')?.value==='窗口 B 尚未发送的新草稿'");
    assert.equal(await draftPeer.evaluate("document.querySelector('.agent-context').textContent.includes('未附加当前文档')"), true);
    const fresh = await createClient();
    try {
      await fresh.send("Page.navigate", {url: `http://127.0.0.1:${server.address().port}/?lang=zh`});
      await fresh.wait("document.querySelector('[data-agent-panel]')");
      await fresh.evaluate("document.querySelector('.agent-statusbar button').click()");
      await fresh.wait("document.querySelector('textarea')?.value==='窗口 B 尚未发送的新草稿'");
    } finally { await fresh.close(); }
    await send("Page.reload");
    await wait("document.querySelector('[data-agent-panel]')");
    await evaluate("document.querySelector('.agent-statusbar button').click()");
    await wait("document.querySelector('textarea')?.value==='窗口 A 保留自己的草稿'");
    // A real subsequent edit must become the shared fallback as one composer;
    // it must not inherit B's removed-context choice.
    await evaluate("{const input=document.querySelector('textarea');input.focus();input.setSelectionRange(0,input.value.length);}");
    await send("Input.insertText", {text: "窗口 A 后续明确编辑的草稿"});
    await wait("localStorage.getItem('koinote:agent-panel:agent-ui-test').includes('窗口 A 后续明确编辑的草稿')");
    const latest = await createClient();
    try {
      await latest.send("Page.navigate", {url: `http://127.0.0.1:${server.address().port}/?lang=zh`});
      await latest.wait("document.querySelector('textarea')?.value==='窗口 A 后续明确编辑的草稿'");
      assert.equal(await latest.evaluate("document.querySelector('.agent-context').textContent.includes('当前文档:')"), true);
    } finally { await latest.close(); }
    await draftPeer.send("Page.reload");
    await draftPeer.wait("document.querySelector('textarea')?.value==='窗口 B 尚未发送的新草稿'");
  } finally { await draftPeer.close(); }

  // One window acknowledging an accepted request cannot invalidate the other
  // window's still-unacknowledged request when that window reloads.
  await newTestSession();
  await evaluate("document.querySelector('textarea').focus()");
  await send("Input.insertText", {text: "另一窗口确认后仍可刷新重试"});
  await wait("localStorage.getItem('koinote:agent-panel:agent-ui-test').includes('另一窗口确认后仍可刷新重试')");
  const completedPeer = await createClient();
  try {
    await completedPeer.send("Page.navigate", {url: `http://127.0.0.1:${server.address().port}/?lang=zh`});
    await completedPeer.wait("document.querySelector('textarea')?.value==='另一窗口确认后仍可刷新重试'");
    await evaluate("window.agentUITest.failFirst=false;window.agentUITest.holdNextResponse=true;window.agentUITest.responseHeld=false");
    await click("发送");
    await wait("window.agentUITest.responseHeld");
    const accepted = await evaluate("window.agentUITest.submissions.at(-1)");
    const sessionID = await evaluate("window.agentUITest.server.sessions[0].id");
    await completedPeer.click("发送");
    await completedPeer.wait("document.querySelector('textarea')?.value===''");
    await send("Page.reload");
    await wait("document.querySelector('textarea')?.value==='另一窗口确认后仍可刷新重试'");
    await click("发送");
    await wait("document.querySelector('textarea')?.value===''");
    assert.deepEqual(await evaluate("window.agentUITest.submissions.at(-1)"), accepted);
    assert.equal(await evaluate(`window.agentUITest.server.tasks[${JSON.stringify(sessionID)}].length`), 1);
    assert.equal(await evaluate(`window.agentUITest.server.sessions.find(s=>s.id===${JSON.stringify(sessionID)}).chargedCredits`), 2);
  } finally { await completedPeer.close(); }

  await newTestSession();
  await evaluate("window.agentUITest.failFirst=false;document.querySelector('textarea').focus()");
  await send("Input.insertText", {text: "同窗口调整初始提案"});
  await click("发送");
  await wait("document.querySelector('textarea')?.value===''");
  await click("要求调整");
  await evaluate("window.agentUITest.holdNextResponse=true;window.agentUITest.responseHeld=false;document.querySelector('textarea').focus()");
  await send("Input.insertText", {text: "已发送的调整内容"});
  await click("发送");
  await wait("window.agentUITest.responseHeld");
  const adjustment = await evaluate("window.agentUITest.submissions.at(-1).supersedeTaskId");
  await evaluate("{const input=document.querySelector('textarea');input.focus();input.setSelectionRange(0,input.value.length);}");
  await send("Input.insertText", {text: "等待响应期间继续编辑的调整"});
  await evaluate("window.agentUITest.releaseResponse()");
  await wait("document.querySelector('select[aria-label=\"改动权限\"]').disabled===false");
  await send("Page.reload");
  await wait("document.querySelector('textarea')?.value==='等待响应期间继续编辑的调整'");
  assert.equal(await evaluate("document.body.textContent.includes('正在调整上一份提案')"), true);
  await evaluate("window.agentUITest.failFirst=false");
  await click("发送");
  await wait("document.querySelector('textarea')?.value===''");
  assert.equal(await evaluate("window.agentUITest.submissions.at(-1).supersedeTaskId"), adjustment);

  // Undoing a temporary edit restores the submitted draft's retry identity.
  // After acknowledgement, explicitly typing the same text is a new turn.
  for (const { restart, loseResponse, restoreAfterError } of [false, true].flatMap((restart) => [
    { restart, loseResponse: false, restoreAfterError: false },
    { restart, loseResponse: true, restoreAfterError: false },
    { restart, loseResponse: true, restoreAfterError: true },
  ]
  )) {
    await newTestSession();
    await evaluate(`window.agentUITest.failFirst=false;window.agentUITest.holdNextResponse=true;window.agentUITest.responseHeld=false;window.agentUITest.loseHeldResponse=${loseResponse};document.querySelector('textarea').focus()`);
    await send("Input.insertText", {text: "修改后撤回原文"});
    await click("发送");
    await wait("window.agentUITest.responseHeld");
    const accepted = await evaluate("window.agentUITest.submissions.at(-1)");
    const sessionID = await evaluate("window.agentUITest.server.sessions[0].id");
    for (const text of ["修改后撤回原文！", "修改后撤回原文"]) {
      if (text === "修改后撤回原文" && restoreAfterError) {
        await evaluate("window.agentUITest.releaseResponse()");
        await wait("document.body.textContent.includes('Accepted held response was lost')");
        if (restart) {
          await send("Page.reload");
          await wait("document.querySelector('textarea')?.value==='修改后撤回原文！'");
          const recovered = await createClient();
          try {
            await recovered.send("Page.navigate", {url: `http://127.0.0.1:${server.address().port}/?lang=zh`});
            await recovered.wait("document.querySelector('textarea')?.value==='修改后撤回原文！'");
            await recovered.evaluate("{const input=document.querySelector('textarea');input.focus();input.setSelectionRange(0,input.value.length);}");
            await recovered.send("Input.insertText", {text: "修改后撤回原文"});
            await recovered.click("发送");
            await recovered.wait("document.querySelector('textarea')?.value===''");
            assert.deepEqual(await recovered.evaluate("window.agentUITest.submissions.at(-1)"), accepted,
              "a fresh window restores the failed draft's original retry association");
          } finally { await recovered.close(); }
        }
      }
      await evaluate("{const input=document.querySelector('textarea');input.focus();input.setSelectionRange(0,input.value.length);}");
      await send("Input.insertText", {text});
    }
    if (!restoreAfterError) {
      await evaluate("window.agentUITest.releaseResponse()");
      await wait(loseResponse
        ? "document.body.textContent.includes('Accepted held response was lost')"
        : "document.querySelector('textarea')?.value===''");
    }
    if (restart && !restoreAfterError) {
      await send("Page.reload");
      await wait(`document.querySelector('textarea')?.value===${JSON.stringify(loseResponse ? "修改后撤回原文" : "")}`);
    }
    if (loseResponse) {
      await click("发送");
      await wait("document.querySelector('textarea')?.value===''");
      assert.deepEqual(await evaluate("window.agentUITest.submissions.at(-1)"), accepted,
        `undoing edits preserves the complete retry (restart=${restart}, restoreAfterError=${restoreAfterError})`);
    }
    assert.equal(await evaluate(`window.agentUITest.server.tasks[${JSON.stringify(sessionID)}].length`), 1);
    assert.equal(await evaluate(`window.agentUITest.server.sessions.find(s=>s.id===${JSON.stringify(sessionID)}).chargedCredits`), 2);
    await evaluate("window.agentUITest.failFirst=false;document.querySelector('textarea').focus()");
    await send("Input.insertText", {text: "修改后撤回原文"});
    await click("发送");
    await wait("document.querySelector('textarea')?.value===''");
    assert.notEqual(await evaluate("window.agentUITest.submissions.at(-1).requestId"), accepted.requestId,
      "a later identical message must not reuse a completed request");
    assert.equal(await evaluate(`window.agentUITest.server.tasks[${JSON.stringify(sessionID)}].length`), 2);
    assert.equal(await evaluate(`window.agentUITest.server.sessions.find(s=>s.id===${JSON.stringify(sessionID)}).chargedCredits`), 4);
  }

  // A successful intervening turn ends this window's old draft. Reusing its
  // text later must create a new task, while a peer with the old draft can retry.
  for (const { restart, timing } of [false, true].flatMap((restart) =>
    ["after-response", "while-pending", "cleared-while-pending"].map((timing) => ({ restart, timing })),
  )) {
    await newTestSession();
    await evaluate("window.agentUITest.failFirst=false;document.querySelector('textarea').focus()");
    await send("Input.insertText", {text: "继续"});
    await wait("JSON.parse(localStorage.getItem('koinote:agent-panel:agent-ui-test')).drafts[JSON.parse(localStorage.getItem('koinote:agent-panel:agent-ui-test')).active]==='继续'");
    const peer = await createClient();
    try {
      await peer.send("Page.navigate", {url: `http://127.0.0.1:${server.address().port}/?lang=zh`});
      await peer.wait("document.querySelector('textarea')?.value==='继续'");
      await evaluate("window.agentUITest.loseNextResponse=true");
      await click("发送");
      await wait("document.body.textContent.includes('Accepted response was lost')");
      const original = await evaluate("window.agentUITest.submissions.at(-1)");
      const sessionID = await evaluate("window.agentUITest.server.sessions[0].id");
      const readDraftId = `JSON.parse(sessionStorage.getItem('koinote:agent-panel-window:agent-ui-test')).draftIds[${JSON.stringify(sessionID)}]`;
      const originalDraftId = await evaluate(readDraftId);
      await evaluate("{const input=document.querySelector('textarea');input.focus();input.setSelectionRange(0,input.value.length);}");
      await send("Input.insertText", {text: "改用另一种表述"});
      if (timing !== "after-response")
        await evaluate("window.agentUITest.holdNextResponse=true;window.agentUITest.responseHeld=false");
      await click("发送");
      if (timing === "after-response") {
        await wait("document.querySelector('textarea')?.value===''");
        if (restart) {
          await send("Page.reload");
          await wait("document.querySelector('textarea')?.value===''");
        }
      } else {
        await wait("window.agentUITest.responseHeld");
      }
      await evaluate("{const input=document.querySelector('textarea');input.focus();input.setSelectionRange(0,input.value.length);}");
      if (timing === "cleared-while-pending") {
        await send("Input.insertText", {text: ""});
        await wait("document.querySelector('textarea')?.value===''");
      }
      await send("Input.insertText", {text: "继续"});
      await wait("JSON.parse(sessionStorage.getItem('koinote:agent-panel-window:agent-ui-test')).drafts[JSON.parse(sessionStorage.getItem('koinote:agent-panel-window:agent-ui-test')).active]==='继续'");
      const queuedDraftId = await evaluate(readDraftId);
      if (timing !== "after-response") {
        await evaluate("window.agentUITest.releaseResponse()");
        await wait("document.querySelector('select[aria-label=\"改动权限\"]').disabled===false");
        if (timing === "cleared-while-pending")
          assert.equal(await evaluate(readDraftId), queuedDraftId,
            "a late response must preserve a draft identity already started by the user");
      }
      assert.notEqual(await evaluate(readDraftId), originalDraftId,
        `the queued draft must belong to a new turn (${timing}, restart=${restart})`);
      const fresh = await createClient();
      try {
        await fresh.send("Page.navigate", {url: `http://127.0.0.1:${server.address().port}/?lang=zh`});
        await fresh.wait("document.querySelector('textarea')?.value==='继续'");
        assert.equal(await fresh.evaluate(readDraftId), await evaluate(readDraftId),
          "a fresh window restores the queued draft's new identity");
      } finally { await fresh.close(); }
      if (restart) {
        await wait("JSON.parse(sessionStorage.getItem('koinote:agent-panel-window:agent-ui-test')).drafts[JSON.parse(sessionStorage.getItem('koinote:agent-panel-window:agent-ui-test')).active]==='继续'");
        await send("Page.reload");
        await wait("document.querySelector('textarea')?.value==='继续'");
      }
      await evaluate("window.agentUITest.failFirst=false");
      await click("发送");
      await wait("document.querySelector('textarea')?.value===''");
      const next = await evaluate("window.agentUITest.submissions.at(-1)");
      assert.notEqual(next.requestId, original.requestId,
        `the same text in a later turn must get a new request ID (${timing}, restart=${restart})`);
      assert.equal(await evaluate(`window.agentUITest.server.tasks[${JSON.stringify(sessionID)}].length`), 3);
      assert.equal(await evaluate(`window.agentUITest.server.sessions.find(s=>s.id===${JSON.stringify(sessionID)}).chargedCredits`), 6);

      if (!restart && timing === "after-response") {
        // An explicit cancellation in another window differs from a missing
        // legacy field, even though both normalize to an empty adjustment map.
        await evaluate(`{
          const account='agent-migration-probe';
          const raw={open:true,height:420,tabs:['legacy'],active:'legacy',drafts:{legacy:'旧版调整草稿'},skills:{},scroll:{}};
          localStorage.setItem('koinote:agent-panel:'+account,JSON.stringify(raw));
          const snapshot=window.agentUITest.layoutStorage.snapshot(account);
          window.migrationProbe={account,snapshot,restored:window.agentUITest.layoutStorage.read(account,{legacy:'previous-task'},snapshot)};
        }`);
        await peer.evaluate(`{
          const key='koinote:agent-panel:agent-migration-probe';
          const raw=JSON.parse(localStorage.getItem(key));
          raw.adjusting={};
          localStorage.setItem(key,JSON.stringify(raw));
        }`);
        await evaluate("{const p=window.migrationProbe;window.agentUITest.layoutStorage.save(p.account,p.restored,p.snapshot.layout,{sharedRaw:p.snapshot.sharedRaw});}");
        await evaluate("navigator.locks.request('koinote:agent-storage:agent-migration-probe',()=>null)");
        assert.deepEqual(await evaluate("JSON.parse(localStorage.getItem('koinote:agent-panel:agent-migration-probe')).adjusting"), {},
          "legacy migration must not resurrect another window's explicit cancellation");
        await evaluate("localStorage.removeItem('koinote:agent-panel:agent-migration-probe');sessionStorage.removeItem('koinote:agent-panel-window:agent-migration-probe');delete window.migrationProbe;");
      }
      // Clearing another window's old records would hide the new-turn bug but
      // break real retries. Reload the peer and prove its original ID still works.
      await peer.send("Page.reload");
      await peer.wait("document.querySelector('textarea')?.value==='继续'");
      await peer.click("发送");
      await peer.wait("document.querySelector('textarea')?.value===''");
      assert.deepEqual(await peer.evaluate("window.agentUITest.submissions.at(-1)"), original);
      assert.equal(await peer.evaluate(`window.agentUITest.server.tasks[${JSON.stringify(sessionID)}].length`), 3);
      assert.equal(await peer.evaluate(`window.agentUITest.server.sessions.find(s=>s.id===${JSON.stringify(sessionID)}).chargedCredits`), 6);
    } finally { await peer.close(); }
  }
  // A queued draft can be submitted in another window before the original
  // window receives its previous response. It must already have a stable turn
  // identity, distinct from any earlier pending request with the same text.
  for (const { restart, sameText, peerLosesResponse } of [false, true].flatMap((restart) =>
    [false, true].flatMap((sameText) =>
      [false, true].map((peerLosesResponse) => ({ restart, sameText, peerLosesResponse }))),
  )) {
    await newTestSession();
    await evaluate("window.agentUITest.failFirst=false;document.querySelector('textarea').focus()");
    const nextMessage = "跨窗口提前输入的下一条消息";
    let earlier;
    if (sameText) {
      await send("Input.insertText", {text: nextMessage});
      await evaluate("window.agentUITest.loseNextResponse=true");
      await click("发送");
      await wait("document.body.textContent.includes('Accepted response was lost')");
      earlier = await evaluate("window.agentUITest.submissions.at(-1)");
    }
    await evaluate("{const input=document.querySelector('textarea');input.focus();input.setSelectionRange(0,input.value.length);window.agentUITest.holdNextResponse=true;window.agentUITest.responseHeld=false;}");
    await send("Input.insertText", {text: "等待上一条响应"});
    await click("发送");
    await wait("window.agentUITest.responseHeld");
    const sessionID = await evaluate("window.agentUITest.server.sessions[0].id");
    await evaluate("{const input=document.querySelector('textarea');input.focus();input.setSelectionRange(0,input.value.length);}");
    await send("Input.insertText", {text: nextMessage});
    await wait(`JSON.parse(localStorage.getItem('koinote:agent-panel:agent-ui-test')).drafts[${JSON.stringify(sessionID)}]===${JSON.stringify(nextMessage)}`);
    const peer = await createClient();
    try {
      await peer.send("Page.navigate", {url: `http://127.0.0.1:${server.address().port}/?lang=zh`});
      await peer.wait(`document.querySelector('textarea')?.value===${JSON.stringify(nextMessage)}`);
      await peer.evaluate(`window.agentUITest.failFirst=false;window.agentUITest.loseNextResponse=${peerLosesResponse}`);
      await peer.click("发送");
      await peer.wait(peerLosesResponse
        ? "document.body.textContent.includes('Accepted response was lost')"
        : "document.querySelector('textarea')?.value===''");
      const accepted = await peer.evaluate("window.agentUITest.submissions.at(-1)");
      if (sameText) assert.notEqual(accepted.requestId, earlier.requestId,
        "the queued turn must not replay an older identical message, even before the previous response arrives");
      // Returning to queued text after undo must keep the identity the peer used.
      for (const text of ["等待上一条响应", nextMessage]) {
        await evaluate("{const input=document.querySelector('textarea');input.focus();input.setSelectionRange(0,input.value.length);}");
        await send("Input.insertText", {text});
      }
      await evaluate("window.agentUITest.releaseResponse()");
      await wait("document.querySelector('select[aria-label=\"改动权限\"]').disabled===false");
      if (restart) {
        await send("Page.reload");
        await wait(`document.querySelector('textarea')?.value===${JSON.stringify(nextMessage)}`);
      }
      await evaluate("window.agentUITest.failFirst=false");
      await click("发送");
      await wait("document.querySelector('textarea')?.value===''");
      assert.deepEqual(await evaluate("window.agentUITest.submissions.at(-1)"), accepted,
        `the late response must preserve the peer's request (restart=${restart}, sameText=${sameText}, peerLosesResponse=${peerLosesResponse})`);
      const taskCount = sameText ? 3 : 2;
      assert.equal(await evaluate(`window.agentUITest.server.tasks[${JSON.stringify(sessionID)}].length`), taskCount);
      assert.equal(await evaluate(`window.agentUITest.server.sessions.find(s=>s.id===${JSON.stringify(sessionID)}).chargedCredits`), taskCount * 2);
      if (peerLosesResponse) {
        await peer.send("Page.reload");
        await peer.wait(`document.querySelector('textarea')?.value===${JSON.stringify(nextMessage)}`);
        await peer.click("发送");
        await peer.wait("document.querySelector('textarea')?.value===''");
        assert.deepEqual(await peer.evaluate("window.agentUITest.submissions.at(-1)"), accepted);
        assert.equal(await peer.evaluate(`window.agentUITest.server.tasks[${JSON.stringify(sessionID)}].length`), taskCount);
        assert.equal(await peer.evaluate(`window.agentUITest.server.sessions.find(s=>s.id===${JSON.stringify(sessionID)}).chargedCredits`), taskCount * 2);
      }
      assert.equal(await evaluate(`window.agentUITest.pendingRequests().some(r=>r.input.requestId===${JSON.stringify(accepted.requestId)})`), false,
        "completed replay information must not appear as an unresolved request");
    } finally { await peer.close(); }
  }

  // A late response must not publish this window's queued composer over a
  // peer's newer edits, including its document context choice.
  await newTestSession();
  await evaluate("window.agentUITest.failFirst=false;window.agentUITest.holdNextResponse=true;window.agentUITest.responseHeld=false;document.querySelector('textarea').focus()");
  await send("Input.insertText", {text: "等待确认的请求"});
  await click("发送");
  await wait("window.agentUITest.responseHeld");
  const queuedSessionID = await evaluate("window.agentUITest.server.sessions[0].id");
  await evaluate("{const input=document.querySelector('textarea');input.focus();input.setSelectionRange(0,input.value.length);}");
  await send("Input.insertText", {text: "本窗口提前输入的下一条消息"});
  await wait("localStorage.getItem('koinote:agent-panel:agent-ui-test').includes('本窗口提前输入的下一条消息')");
  const newerPeer = await createClient();
  try {
    await newerPeer.send("Page.navigate", {url: `http://127.0.0.1:${server.address().port}/?lang=zh`});
    await newerPeer.wait("document.querySelector('textarea')?.value==='本窗口提前输入的下一条消息'");
    await newerPeer.evaluate("{const input=document.querySelector('textarea');input.focus();input.setSelectionRange(0,input.value.length);}");
    await newerPeer.send("Input.insertText", {text: "另一窗口后续编辑的草稿"});
    await newerPeer.clickAria("移除当前文档上下文");
    await newerPeer.wait(`JSON.parse(localStorage.getItem('koinote:agent-panel:agent-ui-test')).ignored[${JSON.stringify(queuedSessionID)}]`);
    const readSharedComposer = `(() => {
      const layout=JSON.parse(localStorage.getItem('koinote:agent-panel:agent-ui-test'));
      return Object.fromEntries(['drafts','draftIds','skills','adjusting','ignored'].map(field=>[field,layout[field][${JSON.stringify(queuedSessionID)}]]));
    })()`;
    const newerComposer = await newerPeer.evaluate(readSharedComposer);
    await evaluate("window.agentUITest.releaseResponse()");
    await wait("document.querySelector('select[aria-label=\"改动权限\"]').disabled===false");
    assert.deepEqual(await evaluate(readSharedComposer), newerComposer,
      "a late response must not overwrite another window's newer composer when rotating its own draft identity");
    const fresh = await createClient();
    try {
      await fresh.send("Page.navigate", {url: `http://127.0.0.1:${server.address().port}/?lang=zh`});
      await fresh.wait("document.querySelector('textarea')?.value==='另一窗口后续编辑的草稿'");
      assert.equal(await fresh.evaluate("document.querySelector('.agent-context').textContent.includes('未附加当前文档')"), true);
    } finally { await fresh.close(); }
    await send("Page.reload");
    await wait("document.querySelector('textarea')?.value==='本窗口提前输入的下一条消息'");
    await evaluate("window.agentUITest.failFirst=false");
    await click("发送");
    await wait("document.querySelector('textarea')?.value===''");
    assert.equal(await evaluate(`window.agentUITest.server.tasks[${JSON.stringify(queuedSessionID)}].length`), 2);
    assert.equal(await evaluate(`window.agentUITest.server.sessions.find(s=>s.id===${JSON.stringify(queuedSessionID)}).chargedCredits`), 4);
    assert.deepEqual(await evaluate(readSharedComposer), newerComposer,
      "submitting this window's retained draft still preserves the peer's unsent composer");
  } finally { await newerPeer.close(); }
  // Reproduce a browser already near its localStorage quota with completed
  // v2 history. Migrate before saving new drafts, without dropping live retries.
  await newTestSession();
  await evaluate("window.agentUITest.failFirst=false;window.agentUITest.loseNextResponse=true;document.querySelector('textarea').focus()");
  await send("Input.insertText", {text: "容量回收期间保留的重试"});
  await click("发送");
  await wait("document.body.textContent.includes('Accepted response was lost')");
  const quotaPending = await evaluate("window.agentUITest.submissions.at(-1)");
  const quotaSessionID = await evaluate("window.agentUITest.server.sessions[0].id");
  const quotaPeer = await createClient();
  try {
    await quotaPeer.send("Page.navigate", {url: `http://127.0.0.1:${server.address().port}/?lang=zh`});
    await quotaPeer.wait("document.querySelector('textarea')?.value==='容量回收期间保留的重试'");
    const history = await evaluate(`(() => {
      const sessionId=crypto.randomUUID();
      let first, count=0;
      const write=(length)=>{
        const input={message:'x'.repeat(length),skillRepositoryId:0,skillPath:'',requestId:crypto.randomUUID()};
        const record={sessionId,draftId:crypto.randomUUID(),input,
          fingerprint:JSON.stringify([input.message,'',0,'','']),completed:true};
        try {
          localStorage.setItem('koinote:agent-request-v2:agent-ui-test:'+sessionId+':'+input.requestId,JSON.stringify(record));
          first??=record;count++;return true;
        } catch { return false; }
      };
      for(let i=0;i<256;i++) if(!write(16000)) break;
      for(let i=0;i<200;i++) if(!write(300)) break;
      return {sessionId,first,count};
    })()`);
    assert.ok(history.count > 50, "seed substantial completed history using the real browser quota");
    await send("Page.reload");
    await wait("document.querySelector('textarea')?.value==='容量回收期间保留的重试'");
    assert.equal(await evaluate(`window.agentUITest.pendingRequests().some(r=>r.input.requestId===${JSON.stringify(quotaPending.requestId)})`), true,
      "migration must preserve unresolved requests");
    const historyResult = await evaluate(`(async()=>{
      const cache=window.agentUITest.requestCache();
      const first=${JSON.stringify(history.first)};
      const {requestId,...payload}=first.input;
      const replay=await cache.prepare(first.sessionId,payload,first.draftId);
      await cache.complete(replay);
      for(let i=0;i<256;i++) {
        const request=await cache.prepare(first.sessionId,{message:'y'.repeat(16000),skillRepositoryId:0,skillPath:''},crypto.randomUUID());
        await cache.complete(request);
      }
      const keys=Object.keys(localStorage).filter(k=>k.startsWith('koinote:agent-request-v2:agent-ui-test:'));
      return {replay:replay.input,characters:keys.reduce((sum,key)=>sum+key.length+localStorage.getItem(key).length,0)};
    })()`);
    assert.deepEqual(historyResult.replay, history.first.input, "migrated old payloads remain replayable");
    assert.ok(historyResult.characters < 100000,
      "hundreds of completed long requests must not accumulate full payloads in localStorage");
    const quotaDraft = "历史请求很多时仍能保存草稿".repeat(200);
    await evaluate("{const input=document.querySelector('textarea');input.focus();input.setSelectionRange(0,input.value.length);}");
    await send("Input.insertText", {text: quotaDraft});
    await wait(`JSON.parse(localStorage.getItem('koinote:agent-panel:agent-ui-test')).drafts[${JSON.stringify(quotaSessionID)}]===${JSON.stringify(quotaDraft)}`);
    await send("Page.reload");
    await wait(`document.querySelector('textarea')?.value===${JSON.stringify(quotaDraft)}`);
    await quotaPeer.send("Page.reload");
    await quotaPeer.wait("document.querySelector('textarea')?.value==='容量回收期间保留的重试'");
    await quotaPeer.click("发送");
    await quotaPeer.wait("document.querySelector('textarea')?.value===''");
    assert.deepEqual(await quotaPeer.evaluate("window.agentUITest.submissions.at(-1)"), quotaPending);
    assert.equal(await quotaPeer.evaluate(`window.agentUITest.server.tasks[${JSON.stringify(quotaSessionID)}].length`), 1);
    assert.equal(await quotaPeer.evaluate(`window.agentUITest.server.sessions.find(s=>s.id===${JSON.stringify(quotaSessionID)}).chargedCredits`), 2);
    const fresh = await createClient();
    try {
      await fresh.send("Page.navigate", {url: `http://127.0.0.1:${server.address().port}/?lang=zh`});
      await fresh.wait(`document.querySelector('textarea')?.value===${JSON.stringify(quotaDraft)}`);
      const archivedReplay = await fresh.evaluate(`(async()=>{
        const cache=window.agentUITest.requestCache();
        const first=${JSON.stringify(history.first)};
        const {requestId,...payload}=first.input;
        const request=await cache.prepare(first.sessionId,payload,first.draftId);
        await cache.complete(request);
        await cache.clearSession(first.sessionId);
        return {input:request.input,remaining:await window.agentUITest.archivedRequests(first.sessionId,first.draftId)};
      })()`);
      assert.deepEqual(archivedReplay.input, history.first.input,
        "a new window can replay an old completed request after substantial newer history");
      assert.deepEqual(archivedReplay.remaining, [], "session deletion also clears its archive");
    } finally { await fresh.close(); }
  } finally { await quotaPeer.close(); }
  const compatibilityURL = `http://127.0.0.1:${server.address().port}/?lang=zh`;
  await checkMixedVersionRequests(createClient, compatibilityURL);
  await checkOpenDuringRestore(createClient, compatibilityURL);
  await checkLocalDevRestart(createClient, temp);
  await checkApprovalBatch(createClient, compatibilityURL);
  await checkTaskProgress(createClient, compatibilityURL);
  await checkComposerKeyboard(createClient, compatibilityURL);
  assert.deepEqual(errors, []);
  console.log(
    "Agent bottom panel UI passed: metadata-only context, retry after title changes/restarts/logout, late-response isolation, cross-window retry/cache isolation/legacy recovery, mixed-version deduplication, open during async restoration, concurrent intents, later identical messages, legacy adjustment in fresh windows, window drafts and late-response reload, persisted/legacy/cancelled adjustments, context removal/restoration, changed request intent, independent drafts, background refresh before completion, permissions, review/undo, hidden/reopened tabs, cloud history, deletion and narrow layout. Screenshots: /tmp/koinote-agent-bottom-panel.png and /tmp/koinote-agent-bottom-panel-mobile.png",
  );
  }
} finally {
  for (const socket of sockets) socket.close();
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
