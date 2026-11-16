import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

export async function checkGeoApproval(createClient, url) {
  const { send, evaluate, wait, click, close } = await createClient();
  try {
    await send("Page.navigate", { url });
    if (!url.includes("article=1")) {
      await wait("document.querySelector('[data-agent-panel]')");
      await evaluate("document.querySelector('.agent-statusbar button').click()");
      await click("新建会话");
    }
    await wait("document.querySelector('textarea:not(:disabled)')");
    await evaluate("window.agentUITest.failFirst=false;document.querySelector('textarea').focus()");
    await send("Input.insertText", { text: "生成 GEO 隐藏摘要" });
    await click("发送");
    await wait("window.agentUITest.submissions.length===1 && Object.values(window.agentUITest.server.tasks).flat().some(t=>t.status==='completed')");
    assert.equal(await evaluate("window.agentUITest.geoCapability"), "1");
    await evaluate("window.agentUITest.seedGeoOperation()");
    await wait("document.body.textContent.includes('本次生成已扣 3 Credits')");
    assert.equal(await evaluate("document.body.textContent.includes('GEO 隐藏摘要')"), true);
    assert.equal(await evaluate("[...document.querySelectorAll('.agent-proposal button')].some(b=>b.textContent==='要求调整')"), false);
    await click("查看差异");
    await wait("document.querySelector('.agent-diff-dialog')?.textContent.includes('尚无 GEO 隐藏摘要')");
    assert.equal(await evaluate("document.querySelector('.agent-diff-dialog').textContent.includes('状态：已启用')"), true);
    assert.equal(await evaluate("document.querySelector('.agent-diff-dialog').textContent.includes('<span hidden>这份摘要需要用户审阅</span>')"), true);
    assert.equal(await evaluate("document.querySelector('.agent-diff-dialog pre').nextElementSibling?.tagName==='A'"), false);
    assert.equal(await evaluate("document.querySelector('.agent-diff-dialog pre').parentElement.parentElement.querySelector('a,span[hidden]')===null"), true, "hidden summary must be reviewed literally");
    assert.equal(await evaluate("document.querySelector('.agent-diff-dialog').textContent.includes('不退还生成费用')"), true);
    assert.equal(await evaluate("window.agentUITest.applied.length"), 0, "preview does not apply");
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    const bounds = await evaluate("{const r=document.querySelector('.agent-diff-dialog').getBoundingClientRect();[r.left,r.right,r.top,r.bottom]}");
    assert.ok(bounds[0] >= 0 && bounds[1] <= 390 && bounds[2] >= 0 && bounds[3] <= 844);
    const screenshot = await send("Page.captureScreenshot", {format: "png", captureBeyondViewport: false});
    await writeFile(`/tmp/koinote-geo-${url.includes("article=1") ? "article" : "chat"}.png`, Buffer.from(screenshot.data, "base64"));
    await evaluate("[...document.querySelectorAll('.agent-diff-dialog button')].find(b=>b.textContent==='批准应用').click()");
    await wait("document.querySelector('.agent-diff-dialog')===null || document.querySelector('.agent-diff-dialog').textContent.includes('撤销改动')");
    if (await evaluate("!!document.querySelector('.agent-diff-dialog')")) {
      await evaluate("document.querySelector('.agent-diff-dialog button[aria-label]').click()");
    }
    await click("撤销改动");
    await wait("document.body.textContent.includes('已撤销')");
    assert.equal(await evaluate("window.agentUITest.applied.length"), 2);
  } finally { await close(); }
}
