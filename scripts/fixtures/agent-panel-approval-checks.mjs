import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

export async function checkApprovalBatch(createClient, url) {
  const client = await createClient();
  try {
    await client.send("Page.navigate", { url });
    await client.wait("window.agentUITest && document.querySelector('[data-agent-panel]')");
    await client.evaluate("if(!document.querySelector('.agent-panel-open')) document.querySelector('.agent-statusbar button').click()");
    const previous = await client.evaluate("window.agentUITest.layoutStorage.read('agent-ui-test').active");
    await client.clickAria("新建会话");
    await client.wait(`window.agentUITest.layoutStorage.read('agent-ui-test').active!==${JSON.stringify(previous)}`);
    await client.wait("document.querySelector('textarea')");
    const sessionId = await client.evaluate("window.agentUITest.layoutStorage.read('agent-ui-test').active");
    const taskId = await client.evaluate(`window.agentUITest.seedApprovalBatch(${JSON.stringify(sessionId)})`);
    const selector = `[data-approval-task="${taskId}"]`;
    await client.wait(`document.querySelector(${JSON.stringify(selector)})`);
    assert.equal(await client.evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`), 1);
    assert.equal(await client.evaluate(`document.querySelector(${JSON.stringify(selector)}).querySelectorAll('[data-operation-id]').length`), 4);
    assert.equal(await client.evaluate(`Array.from(document.querySelector(${JSON.stringify(selector)}).querySelectorAll('button')).filter(b=>b.textContent.includes('批准')).length`), 1);
    await client.send("Page.reload");
    await client.wait(`document.querySelector(${JSON.stringify(selector)})?.textContent.includes('审批后自动继续')`);
    await client.clickAria("最大化");
    await client.evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:"center"})`);
    const screenshot = await client.send("Page.captureScreenshot", { format: "png" });
    await client.clickAria("恢复大小");
    await writeFile("/tmp/koinote-agent-approval-batch.png", Buffer.from(screenshot.data, "base64"));
    const peer = await createClient();
    try {
      await peer.send("Page.navigate", { url });
      await peer.wait(`document.querySelector(${JSON.stringify(selector)})`);
      await client.evaluate("window.agentUITest.failNextOperation=true");
      await client.click("批准本批并继续");
      await client.wait("document.body.textContent.includes('Approval temporarily unavailable')");
      assert.equal(await client.evaluate(`window.agentUITest.server.operations.filter(o=>o.taskId===${JSON.stringify(taskId)}&&o.status==='pending').length`), 4);
      await client.click("批准本批并继续");
      await client.wait(`!document.querySelector(${JSON.stringify(selector)})`);
      const result = await client.evaluate(`({requests:window.agentUITest.server.approvalRequests.filter(r=>r.taskId===${JSON.stringify(taskId)}), task:window.agentUITest.server.tasks[${JSON.stringify(sessionId)}][0], resumes:window.agentUITest.server.approvalResumes})`);
      assert.deepEqual(result.requests, [{ taskId, count: 4, action: "approve" }]);
      assert.equal(result.task.id, taskId);
      assert.equal(result.task.status, "running");
      assert.equal(result.resumes, 1);
      await client.wait("document.querySelector('[data-folder-tree]').textContent.includes('主题目录 4')");
      await peer.send("Page.reload");
      await peer.wait(`window.agentUITest?.server.tasks[${JSON.stringify(sessionId)}][0].status==='running'`);
      assert.equal(await peer.evaluate(`document.querySelector(${JSON.stringify(selector)}) !== null`), false);
      const rejectedTask = await peer.evaluate(`window.agentUITest.seedApprovalBatch(${JSON.stringify(sessionId)})`);
      await peer.click("拒绝本批");
      await peer.wait(`window.agentUITest.server.operations.filter(o=>o.taskId===${JSON.stringify(rejectedTask)}&&o.status==='rejected').length===4`);
      assert.equal(await peer.evaluate(`window.agentUITest.server.approvalRequests.filter(r=>r.taskId===${JSON.stringify(rejectedTask)}).length`), 1);
      const deleteTask = await peer.evaluate(`window.agentUITest.seedApprovalBatch(${JSON.stringify(sessionId)}, true)`);
      const deletion = `[data-approval-task="${deleteTask}"]`;
      await peer.wait(`document.querySelector(${JSON.stringify(deletion)})?.textContent.includes('删除空文件夹')`);
      const labels = await peer.evaluate(`document.querySelector(${JSON.stringify(deletion)}).textContent`);
      assert.ok(labels.includes("202608") && labels.includes("最近 7 天"));
      assert.equal(await peer.evaluate(`document.querySelector(${JSON.stringify(deletion)}).querySelectorAll('[data-operation-id]').length`), 2);
      assert.equal(labels.includes("打开文档"), false);
      await peer.wait("document.querySelector('[data-folder-tree]').textContent.includes('202608')");
      await peer.click("批准本批并继续");
      const undo = `[data-undo-folder-task="${deleteTask}"]`;
      await peer.wait(`document.querySelector(${JSON.stringify(undo)})`);
      await peer.evaluate(`window.agentUITest.finishNativeOperationTask(${JSON.stringify(deleteTask)})`);
      const resultSelector = `[data-task-result="${deleteTask}"]`;
      const deletedText = "已删除 2 个空文件夹，可在下方撤销。";
      await peer.wait(`document.querySelector(${JSON.stringify(resultSelector)})?.textContent===${JSON.stringify(deletedText)}`);
      assert.doesNotMatch(await peer.evaluate("document.body.textContent"), /koinote\.propose_operations|宿主确认已应用/);
      assert.doesNotMatch(await peer.evaluate(`document.querySelector(${JSON.stringify(resultSelector)}).textContent`), /\/folders\/empty-/);
      assert.match(await peer.evaluate(`window.agentUITest.server.tasks[${JSON.stringify(sessionId)}][0].result`), /koinote\.propose_operations/, "raw audit receipt remains stored");
      await client.send("Page.reload");
      await client.wait(`document.querySelector(${JSON.stringify(resultSelector)})?.textContent===${JSON.stringify(deletedText)}`);
      await peer.wait("!document.querySelector('[data-folder-tree]').textContent.includes('202608')");
      await peer.send("Page.reload");
      await peer.wait(`document.querySelector(${JSON.stringify(resultSelector)})?.textContent===${JSON.stringify(deletedText)}`);
      await peer.evaluate(`document.querySelector(${JSON.stringify(undo)}).click()`);
      await peer.wait(`window.agentUITest.server.operations.filter(o=>o.taskId===${JSON.stringify(deleteTask)}&&o.status==='undone').length===2`);
      await peer.wait(`document.querySelector(${JSON.stringify(resultSelector)})?.textContent==='已撤销 2 项改动。'`);
      assert.deepEqual(await peer.evaluate(`window.agentUITest.server.approvalRequests.filter(r=>r.taskId===${JSON.stringify(deleteTask)})`), [{ taskId: deleteTask, count: 2, action: "approve" }, { taskId: deleteTask, count: 2, action: "undo" }]);
      await peer.wait("document.querySelector('[data-folder-tree]').textContent.includes('202608')");
      await client.send("Page.reload");
      await client.wait(`window.agentUITest?.server.operations.filter(o=>o.taskId===${JSON.stringify(deleteTask)}&&o.status==='undone').length===2`);
      await client.wait(`document.querySelector(${JSON.stringify(resultSelector)})?.textContent==='已撤销 2 项改动。'`);
      assert.equal(await client.evaluate(`document.querySelector(${JSON.stringify(undo)}) !== null`), false);

    } finally { await peer.close(); }
  } finally { await client.close(); }
}
