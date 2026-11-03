import assert from "node:assert/strict";

export async function checkArticleKoi(createClient,url) {
  const {send,evaluate,wait,click,close}=await createClient();
  try {
    await send("Page.navigate",{url});
    await wait("document.querySelector('[role=dialog][aria-label=\"Koi AI\"] textarea:not(:disabled)')");
    await wait(`document.querySelector('[role=dialog] img[src="/logo.png"]')?.naturalWidth > 0 &&
      document.querySelector('[role=dialog] img[src="/logo-dark.png"]')?.naturalWidth > 0`);
    await evaluate("window.agentUITest.failFirst=false;document.querySelector('textarea').focus()");
    await send("Input.insertText",{text:"参考乙文，润色甲文开头"});
    await click("发送");
    await wait("document.querySelector('[role=dialog]').textContent.includes('参考乙文，润色甲文开头') && window.agentUITest.prepared===1");
    const reply = '[role=dialog] [data-task-result]';
    await wait(`document.querySelector('${reply} h2')?.textContent === '修改建议'`);
    assert.equal(await evaluate(`document.querySelector('${reply} li strong')?.textContent`), "保留数字");
    assert.equal(await evaluate(`document.querySelector('${reply} pre code')?.textContent.trim()`), "# 原文示例");
    assert.equal(await evaluate(`document.querySelector('${reply} tbody td')?.textContent`), "第一段");
    assert.equal(await evaluate(`document.querySelector('${reply} iframe') === null`), true);
    await click("查看差异");
    await wait("document.querySelector('.agent-diff-dialog')");
    await send("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
    await wait("!document.querySelector('.agent-diff-dialog') && document.querySelector('[aria-label=\"Koi AI\"] textarea')");
    await click("批准应用");
    await wait("window.agentUITest.applied.length===1 && document.querySelector('[role=dialog]').textContent.includes('撤销改动')");
    await click("撤销改动");
    await wait("document.querySelector('[role=dialog]').textContent.includes('已撤销')");
    await click("切换文章");
    await wait("document.querySelector('[role=dialog]').textContent.includes('乙文') && !document.querySelector('[role=dialog]').textContent.includes('参考乙文，润色甲文开头')");
    await click("切换文章");
    await wait("document.querySelector('[role=dialog]').textContent.includes('参考乙文，润色甲文开头')");
    await wait(`document.querySelector('${reply} h2')?.textContent === '修改建议'`);
    assert.equal(await evaluate("window.agentUITest.submissions.length"),1);
    console.log("Koi AI article panel passed: instruction, preview, approval, undo and document-bound recovery.");
  } finally {await close();}
}
