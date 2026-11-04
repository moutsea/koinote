import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function checkArticleKoi(createClient,url) {
  const {send,evaluate,wait,click,close}=await createClient();
  const capture = async (name) => {
    const dir = process.env.KOI_ARTICLE_SCREENSHOT_DIR;
    if (!dir) return;
    await mkdir(dir, { recursive: true });
    const clip = await evaluate(`(() => {const {x,y,width,height}=document.querySelector('aside[aria-label="Koi AI"]').getBoundingClientRect();return {x,y,width,height,scale:1}})()`);
    const shot = await send("Page.captureScreenshot", { format:"png", clip });
    await writeFile(join(dir,name+".png"),Buffer.from(shot.data,"base64"));
  };
  try {
    await send("Page.navigate",{url});
    await wait("document.querySelector('[role=dialog][aria-label=\"Koi AI\"] textarea:not(:disabled)')");
    await wait(`document.querySelector('[role=dialog] img[src="/logo.png"]')?.naturalWidth > 0 &&
      document.querySelector('[role=dialog] img[src="/logo-dark.png"]')?.naturalWidth > 0`);
    await capture("article-empty");
    await click("润色表达");
    assert.equal(await evaluate("document.querySelector('textarea').value"),"润色表达");
    assert.equal(await evaluate("window.agentUITest.submissions.length"),0);
    await evaluate("document.querySelector('textarea').select()");
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
    // Reopen an old stopped job with an applied first draft and a cancelled second draft.
    await evaluate(`(() => {
      const key="article-panel-fixture-server", data=JSON.parse(localStorage.getItem(key));
      const task=Object.values(data.tasks).flat()[0], first=data.operations.find(op=>op.taskId===task.id);
      Object.assign(task,{message:"帮我校对这篇文章，修正错别字，再润色一下表达。",status:"cancelled", result:"", taskIntent:undefined});
      first.status="applied"; first.input.explanation="修正了错别字和标点，精简了开头两句，并理顺了段落之间的衔接。原有标题、图片和引用均保留。";
      data.operations.push({...first,id:crypto.randomUUID(),status:"cancelled"});
      localStorage.setItem(key,JSON.stringify(data));
    })()`);
    await send("Page.reload",{});
    await wait("document.querySelector('.koi-article-note')?.textContent.includes('已应用的改动已保留')");
    assert.equal(await evaluate("document.querySelector('.koi-article-archived').open"),false);
    assert.equal(await evaluate("document.querySelectorAll('.koi-article-change[data-status=applied]').length"),1);
    await capture("article-revision");
    await send("Emulation.setDeviceMetricsOverride",{width:360,height:740,deviceScaleFactor:1,mobile:false});
    await evaluate("document.documentElement.classList.add('dark')");
    await wait("document.querySelector('.koi-article-thread').clientWidth<=360");
    assert.equal(await evaluate("document.querySelector('.koi-article-thread').scrollWidth <= document.querySelector('.koi-article-thread').clientWidth"),true);
    await capture("article-mobile-dark");
    console.log("Koi AI article panel passed: instruction, preview, approval, undo and document-bound recovery.");
  } finally {await close();}
}
