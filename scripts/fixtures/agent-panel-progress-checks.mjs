import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

export async function checkTaskProgress(createClient, url) {
  const client = await createClient();
  const event = (seq, type, name) => ({ seq, event: { type, ...(name ? { toolCall: { name } } : {}) } });
  const events = [
    event(1, "tool.completed", "skill_view"),
    event(2, "tool.completed", "koinote.search_documents"),
    event(3, "tool.completed", "koinote.list_folders"),
    event(4, "tool.started", "koinote.get_document"),
    event(5, "tool.completed", "koinote.get_document"),
    event(6, "model.completed"),
    event(7, "tool.started", "koinote.get_document"),
    event(8, "tool.completed", "koinote.get_document"),
    event(9, "tool.started", "koinote.propose_operations"),
  ].reverse();
  try {
    await client.send("Page.navigate", { url });
    await client.wait("window.agentUITest && document.querySelector('[data-agent-panel]')");
    await client.evaluate("if(!document.querySelector('.agent-panel-open')) document.querySelector('.agent-statusbar button').click()");
    const previous = await client.evaluate("window.agentUITest.layoutStorage.read('agent-ui-test').active");
    await client.clickAria("新建会话");
    await client.wait(`window.agentUITest.layoutStorage.read('agent-ui-test').active!==${JSON.stringify(previous)}`);
    const sessionId = await client.evaluate("window.agentUITest.layoutStorage.read('agent-ui-test').active");
    const taskId = await client.evaluate(`window.agentUITest.seedProgress(${JSON.stringify(sessionId)},${JSON.stringify(events)})`);
    const card = `document.querySelector('[data-agent-progress="${taskId}"]')`;
    await client.wait(`${card}?.textContent.includes('正在准备改动方案')`);
    assert.deepEqual(await client.evaluate(`Array.from(${card}.querySelectorAll('li')).map(e=>e.textContent)`), ["查找相关文档", "查看目录结构", "阅读文档内容", "准备改动方案"]);
    assert.doesNotMatch(await client.evaluate(`${card}.textContent`), /koinote|tool\.|model\.|get_document|propose_operations|已应用/);
    await client.clickAria("最大化");
    await client.evaluate(`${card}.scrollIntoView({block:'center'})`);
    const screenshot = await client.send("Page.captureScreenshot", { format: "png" });
    await writeFile("/tmp/koinote-agent-progress.png", Buffer.from(screenshot.data, "base64"));
    // Old tool events cannot override an authoritative approval checkpoint.
    await client.evaluate(`window.agentUITest.updateProgress(${JSON.stringify(taskId)},${JSON.stringify(events)},'awaiting_approval')`);
    await client.wait(`${card}?.textContent.includes('等待你审批')`);
    assert.equal(await client.evaluate(`${card}.querySelector('.agent-progress-spinner')===null`), true);
    assert.match(await client.evaluate(`${card}.textContent`), /审批后自动继续/);
    await client.send("Page.reload");
    await client.wait(`${card}?.textContent.includes('等待你审批')`);
    const peer = await createClient();
    try {
      await peer.send("Page.navigate", { url });
      await peer.wait(`${card}?.textContent.includes('等待你审批')`);
      const resumed = [event(10, "tool.completed", "koinote.propose_operations"), event(11, "tool.started", "koinote.get_operation_results"), ...events];
      await client.evaluate(`window.agentUITest.updateProgress(${JSON.stringify(taskId)},${JSON.stringify(resumed)},'running')`);
      await client.wait(`${card}?.textContent.includes('正在核对改动状态')`);
      await peer.send("Page.reload");
      await peer.wait(`${card}?.textContent.includes('正在核对改动状态')`);
    } finally { await peer.close(); }
    const unknown = [event(12, "tool.started", "private_server.unrecognized_internal_tool")];
    const nextTask = await client.evaluate(`window.agentUITest.seedProgress(${JSON.stringify(sessionId)},${JSON.stringify(unknown)})`);
    const nextCard = `document.querySelector('[data-agent-progress="${nextTask}"]')`;
    await client.wait(`${nextCard}?.textContent.includes('正在处理任务')`);
    assert.doesNotMatch(await client.evaluate(`${nextCard}.textContent`), /private_server|internal_tool|文档|改动方案/);
    await client.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    const bounds = await client.evaluate(`(()=>{const r=${nextCard}.getBoundingClientRect();return {left:r.left,right:r.right,width:innerWidth}})()`);
    assert.ok(bounds.left >= 0 && bounds.right <= bounds.width, "progress fits narrow layouts");
    await client.send("Page.navigate", { url: url.replace("lang=zh", "lang=en") });
    await client.wait(`${nextCard}?.textContent.includes('Working on your task')`);
    console.log("Agent progress UI passed: readable actions, deduplication, approval/resume, reload/new window, task isolation, unknown tools, narrow layout and English.");
  } finally { await client.close(); }
}
