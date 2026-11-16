import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

export async function checkPublication(createClient, url) {
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
    await send("Input.insertText", { text: "给我三个标题建议" });
    await click("发送");
    await wait("window.agentUITest.submissions.length===1 && Object.values(window.agentUITest.server.tasks).flat().some(t=>t.status==='completed')");
    assert.equal(await evaluate("window.agentUITest.publishingCapability"), "1");
    const id = await evaluate("window.agentUITest.seedPublication('wechat')");
    await wait(`document.querySelector('[data-publication="${id}"]')`);
    await evaluate(`document.querySelector('[data-publication="${id}"] button').focus();document.activeElement.click()`);
    await wait("document.querySelector('dialog:modal')?.textContent.includes('这是将发送的文章内容')");
    assert.equal(await evaluate("document.querySelector('dialog:modal').textContent.includes('20 Credits')"), true);
    assert.equal(await evaluate("document.querySelector('dialog:modal').textContent.includes('不会直接对外发布')"), true);
    assert.equal(await evaluate("window.agentUITest.publicationActions.length"), 0, "opening a preview cannot send");
    assert.equal(await evaluate("document.querySelector('dialog:modal').textContent.includes('将携带 GEO 隐藏摘要')"), true);
    assert.equal(await evaluate("[...document.querySelectorAll('dialog:modal details')].find(d=>d.textContent.includes('查看将发送的 GEO 摘要')).open"), false, "GEO details stay collapsed by default");
    await evaluate("[...document.querySelectorAll('dialog:modal summary')].find(s=>s.textContent==='查看将发送的 GEO 摘要').click()");
    assert.equal(await evaluate("[...document.querySelectorAll('dialog:modal details')].find(d=>d.open)?.textContent.includes('我按主题整理资料')"), true);
    const screenshot = await send("Page.captureScreenshot", {format: "png", captureBeyondViewport: false});
    await writeFile(`/tmp/koinote-publication-${url.includes("article=1") ? "article" : "chat"}.png`, Buffer.from(screenshot.data, "base64"));
    await click("暂不发送");
    assert.equal(await evaluate("document.querySelector('dialog:modal')===null"), true);
    assert.equal(await evaluate(`document.activeElement.closest('[data-publication="${id}"]')!==null`), true, "native dialog returns focus");
    assert.equal(await evaluate("window.agentUITest.publicationActions.length"), 0, "closing a preview cannot send");
    await evaluate(`window.agentUITest.holdPublication=true;document.querySelector('[data-publication="${id}"] button').click()`);
    await wait("[...document.querySelectorAll('dialog:modal button')].some(b=>b.textContent==='确认保存草稿'&&!b.disabled)");
    await evaluate("{const b=[...document.querySelectorAll('dialog:modal button')].find(b=>b.textContent==='确认保存草稿');b.click();b.click();}");
    await wait("document.querySelector('dialog:modal').textContent.includes('正在发送')");
    assert.deepEqual(await evaluate("window.agentUITest.publicationActions"), ["confirm"], "double-click submits once");
    await click("关闭");
    await evaluate("window.agentUITest.releasePublication()");
    await wait(`document.querySelector('[data-publication="${id}"]').textContent.includes('草稿已保存')`);
    const custom = await evaluate("window.agentUITest.seedPublication('custom')");
    await wait(`document.querySelector('[data-publication="${custom}"]')`);
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    await evaluate(`window.agentUITest.holdPublication=false;document.querySelector('[data-publication="${custom}"] button').click()`);
    await wait("document.querySelector('dialog:modal')?.textContent.includes('Koinote 不另扣发布 Credits')");
    const bounds = await evaluate("{const r=document.querySelector('dialog:modal').getBoundingClientRect();[r.left,r.right,r.top,r.bottom]}");
    assert.ok(bounds[0] >= 0 && bounds[1] <= 390 && bounds[2] >= 0 && bounds[3] <= 844, "modal fits a narrow viewport");
    await evaluate("document.documentElement.classList.add('dark')");
    assert.equal(await evaluate("getComputedStyle(document.querySelector('dialog:modal')).backgroundColor"), "rgb(20, 19, 15)");
    await click("取消这次发布");
    await wait("document.querySelector('dialog:modal').textContent.includes('已取消')");
    assert.deepEqual(await evaluate("window.agentUITest.publicationActions"), ["confirm", "reject"]);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await wait("!document.querySelector('dialog:modal')");
    await send("Page.reload");
    await wait(`document.querySelector('[data-publication="${id}"]')?.textContent.includes('草稿已保存')`);
    assert.equal(await evaluate(`document.querySelector('[data-publication="${id}"]').textContent.includes('预览并确认')`), false, "finished receipt cannot be sent again");
  } finally { await close(); }
}
