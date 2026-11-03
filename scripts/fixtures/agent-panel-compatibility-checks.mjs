import assert from "node:assert/strict";

const panel = "document.querySelector('[data-agent-panel]')";
const sharedKey = "koinote:agent-panel:agent-ui-test";
const lockName = "koinote:agent-storage:agent-ui-test";
const openEvent = "window.dispatchEvent(new Event('koinote:agent-panel-open'))";
const typeMessage = async (client, text) => {
  await client.evaluate("{const input=document.querySelector('textarea');input.focus();input.setSelectionRange(0,input.value.length);}");
  await client.send("Input.insertText", { text });
};
const newSession = async (client) => {
  await client.wait(panel);
  await client.evaluate("document.querySelector('.agent-statusbar button[aria-expanded=false]')?.click()");
  const count = await client.evaluate("window.agentUITest.server.sessions.length");
  await client.clickAria("新建会话");
  await client.wait(`window.agentUITest.server.sessions.length===${count + 1}
    && JSON.parse(sessionStorage.getItem('koinote:agent-panel-window:agent-ui-test')).active===window.agentUITest.server.sessions[0].id
    && document.querySelector('textarea')?.value===''
    && document.querySelector('select[aria-label="改动权限"]')?.disabled===false`);
};

export async function checkMixedVersionRequests(createClient, url) {
  for (const timing of ["after-restoration", "during-archive-read"]) {
    const old = await createClient();
    const current = await createClient();
    try {
      // Use the frozen pre-IndexedDB cache in a separate tab, not a manual
      // storage record. Its acknowledgements deliberately do not take a lock.
      await old.send("Page.navigate", { url: `${url}&request-cache=v2` });
      await newSession(old);
      const message = `新旧窗口共享草稿：${timing}`;
      await typeMessage(old, message);
      const sessionId = await old.evaluate("window.agentUITest.server.sessions[0].id");
      await old.wait(`JSON.parse(localStorage.getItem('${sharedKey}')).drafts[${JSON.stringify(sessionId)}]===${JSON.stringify(message)}`);
      await current.send("Page.navigate", { url });
      await current.wait(`document.querySelector('textarea')?.value===${JSON.stringify(message)}`);
      await current.evaluate("window.agentUITest.failFirst=false");
      await old.evaluate(`window.agentUITest.failFirst=false;window.agentUITest.holdNextResponse=${timing === "during-archive-read"}`);
      await old.click("发送");
      if (timing === "during-archive-read") {
        await old.wait("window.agentUITest.responseHeld");
        // Pause delivery of the archive result while keeping the real query
        // and transaction. The old tab acknowledges during this async gap.
        await current.evaluate(`{
          const original=IDBDatabase.prototype.transaction;
          IDBDatabase.prototype.transaction=function(...args) {
            const tx=original.apply(this,args);
            if(this.name==='koinote-agent-request-archive' && args[1]==='readonly') {
              IDBDatabase.prototype.transaction=original;
              Object.defineProperty(tx,'oncomplete',{set(handler) {
                tx.addEventListener('complete',event=>{
                  window.archiveReadHeld=true;
                  window.releaseArchiveRead=()=>handler.call(tx,event);
                });
              }});
            }
            return tx;
          };
        }`);
        await current.click("发送");
        await current.wait("window.archiveReadHeld");
        await old.evaluate("window.agentUITest.releaseResponse()");
      }
      await old.wait("document.querySelector('textarea')?.value===''");
      const accepted = await old.evaluate("window.agentUITest.submissions.at(-1)");
      const key = `koinote:agent-request-v2:agent-ui-test:${sessionId}:${accepted.requestId}`;
      assert.equal(await old.evaluate(`JSON.parse(localStorage.getItem(${JSON.stringify(key)})).completed`), true);
      if (timing === "during-archive-read") await current.evaluate("window.releaseArchiveRead()");
      else await current.click("发送");
      await current.wait("document.querySelector('textarea')?.value===''");
      assert.deepEqual(await current.evaluate("window.agentUITest.submissions.at(-1)"), accepted,
        `reuse the entire old-window request ${timing}`);
      assert.equal(await current.evaluate(`window.agentUITest.server.tasks[${JSON.stringify(sessionId)}].length`), 1);
      assert.equal(await current.evaluate(`window.agentUITest.server.sessions.find(s=>s.id===${JSON.stringify(sessionId)}).chargedCredits`), 2);
      assert.equal(await current.evaluate(`localStorage.getItem(${JSON.stringify(key)})`), null,
        "the acknowledged legacy payload is archived instead of accumulating in localStorage");
      // A later intentional turn with identical text is still a new request.
      await typeMessage(current, message);
      await current.click("发送");
      await current.wait("document.querySelector('textarea')?.value===''");
      assert.notEqual(await current.evaluate("window.agentUITest.submissions.at(-1).requestId"), accepted.requestId);
      assert.equal(await current.evaluate(`window.agentUITest.server.tasks[${JSON.stringify(sessionId)}].length`), 2);
      assert.equal(await current.evaluate(`window.agentUITest.server.sessions.find(s=>s.id===${JSON.stringify(sessionId)}).chargedCredits`), 4);
    } finally {
      await current.close();
      await old.close();
    }
  }
}

export async function checkOpenDuringRestore(createClient, url) {
  const client = await createClient();
  const blocker = await createClient();
  try {
    await client.send("Page.navigate", { url });
    await newSession(client);
    await typeMessage(client, "恢复后仍保留的草稿");
    await client.clickAria("隐藏面板");
    await client.wait(`!document.querySelector('textarea') && JSON.parse(localStorage.getItem('${sharedKey}')).open===false`);
    await blocker.send("Page.navigate", { url });
    await blocker.wait(panel);
    // A genuine second window owns the lock throughout reload/restoration.
    await blocker.evaluate(`void navigator.locks.request('${lockName}',()=>new Promise(resolve=>{
      window.restoreLockHeld=true;window.releaseRestoreLock=resolve;
    }))`);
    await blocker.wait("window.restoreLockHeld");
    await client.send("Page.reload");
    await client.wait("window.agentUITest");
    await client.evaluate(`(async()=>{
      for(let i=0;i<100;i++) {
        const locks=await navigator.locks.query();
        if(locks.pending.some(lock=>lock.name==='${lockName}')) return;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      throw new Error('Restoration did not wait for the storage lock');
    })()`);
    assert.equal(await client.evaluate(`Boolean(${panel})`), false);
    await client.evaluate(`${openEvent};${openEvent}`);
    await blocker.evaluate("window.releaseRestoreLock()");
    await client.wait("document.querySelector('textarea')?.value==='恢复后仍保留的草稿'");
    await client.wait(`JSON.parse(localStorage.getItem('${sharedKey}')).open===true`);
    await client.send("Page.reload");
    await client.wait("document.querySelector('textarea')?.value==='恢复后仍保留的草稿'");
    // Consumed events must not force the panel open again after the user hides
    // it. A subsequent fresh event must still work with the loaded component.
    await client.clickAria("隐藏面板");
    await client.wait(`JSON.parse(localStorage.getItem('${sharedKey}')).open===false`);
    await client.evaluate("window.agentUITest.unmount();window.agentUITest.remount()");
    await client.wait(panel);
    assert.equal(await client.evaluate("Boolean(document.querySelector('textarea'))"), false);
    await client.evaluate(openEvent);
    await client.wait("document.querySelector('textarea')?.value==='恢复后仍保留的草稿'");
    await client.clickAria("隐藏面板");
    await client.wait("!document.querySelector('textarea')");
    await client.evaluate(openEvent);
    await client.wait("document.querySelector('textarea')?.value==='恢复后仍保留的草稿'");
    const savedSession = await client.evaluate(`JSON.parse(sessionStorage.getItem('koinote:agent-panel-window:agent-ui-test')).active`);
    await client.clickAria("隐藏面板");
    await client.evaluate("window.agentUITest.openOrganizer()");
    const projectDraft = "document.querySelector('textarea')?.value.includes('按内容主题整理当前项目的文档')";
    await client.wait(projectDraft);
    await client.wait("document.activeElement===document.querySelector('textarea')");
    const count = await client.evaluate("window.agentUITest.server.sessions.length");
    await client.evaluate("window.agentUITest.openOrganizer()");
    assert.equal(await client.evaluate("window.agentUITest.server.sessions.length"), count);
    assert.equal(await client.evaluate("window.agentUITest.submissions.length"), 0);
    await client.evaluate("window.agentUITest.switchDoc()");
    await client.wait("document.querySelector('.agent-context')?.textContent.includes('未附加当前文档')");
    const sent = "请按内容主题整理当前项目的文档，优先归类旅行记录。";
    await typeMessage(client, sent);
    await client.evaluate("window.agentUITest.libraryConflicts=['conflict']");
    await client.click("发送");
    await client.wait("document.body.textContent.includes('文档存在同步冲突')");
    assert.equal(await client.evaluate("window.agentUITest.submissions.length"), 0);
    await client.evaluate("window.agentUITest.failFirst=false;window.agentUITest.libraryConflicts=[]");
    await client.click("发送");
    await client.wait("window.agentUITest.submissions.length===1");
    const submission = await client.evaluate("window.agentUITest.submissions[0]");
    assert.equal(submission.message, sent);
    assert.equal(submission.context, undefined);
    assert.equal(await client.evaluate("window.agentUITest.libraryPreparations"), 2);
    assert.equal(await client.evaluate(`JSON.parse(sessionStorage.getItem('koinote:agent-panel-window:agent-ui-test')).drafts[${JSON.stringify(savedSession)}]`), "恢复后仍保留的草稿");
  } finally {
    await blocker.close();
    await client.close();
  }
}
