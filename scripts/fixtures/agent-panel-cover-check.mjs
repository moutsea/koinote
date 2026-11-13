import assert from "node:assert/strict";

export async function checkCoverGeneration(createClient, url) {
  const { send, evaluate, wait, click, close } = await createClient();
  const download = async () => {
    await wait("[...document.querySelectorAll('button')].some(b=>b.textContent.includes('下载封面') && !b.disabled)");
    await evaluate("[...document.querySelectorAll('button')].find(b=>b.textContent.includes('下载封面')).click()");
  };
  try {
    await send("Page.navigate", { url });
    if (!url.includes("article=1")) {
      await wait("document.querySelector('[data-agent-panel]')");
      await evaluate("document.querySelector('.agent-statusbar button').click()");
      await click("新建会话");
    }
    await wait("document.querySelector('textarea:not(:disabled)')");
    assert.equal(await evaluate("document.body.textContent.includes('20 Credits/张')"), true, "image cost is visible before sending");
    await evaluate("window.agentUITest.failFirst=false;document.querySelector('textarea').focus()");
    await send("Input.insertText", { text: "为这篇文章生成封面，并给我三个标题建议，先不要修改文章" });
    await click("发送");
    const image = "document.querySelector('img[alt=\"Koi 生成的文章封面\"]')";
    await wait(`${image}?.naturalWidth===640`);
    await wait("document.querySelector('[data-task-reply]')?.textContent.includes('把日子写成诗')");
    assert.equal(await evaluate("document.querySelectorAll('[data-task-reply]').length"), 1, "text is shown once alongside the cover");
    assert.equal(await evaluate("window.agentUITest.coverCapability"), "1", "both panels advertise image delivery support");
    assert.equal(await evaluate("document.body.textContent.includes('尚未设为文章封面')"), true);
    assert.equal(await evaluate("document.body.textContent.includes('批准应用')"), false, "generating a cover must not propose article changes");
    await evaluate("window.agentUITest.coverDownloadFail=true");
    await download();
    await wait("document.body.textContent.includes('下载失败，请重试')");
    assert.equal(await evaluate("window.agentUITest.coverDownloads"), 1);
    await evaluate("window.agentUITest.coverDownloadFail=false");
    await send("Page.setDownloadBehavior", { behavior: "deny" });
    await download();
    await wait("window.agentUITest.coverDownloads===2 && !document.body.textContent.includes('下载失败，请重试')");
    for (const [code,label] of [["insufficient_credits","可用 Credits 不足"],["service_unavailable","封面生成服务暂不可用"],["rate_limited","本小时封面生成次数"],["generation_failed","封面生成失败或超时"]]) {
      await evaluate(`window.agentUITest.coverErrorCode=${JSON.stringify(code)};document.querySelector('textarea').focus()`);
      await send("Input.insertText", {text:"重新生成封面，给三个标题建议"});
      await click("发送");
      await wait(`document.body.textContent.includes(${JSON.stringify(label)})`);
      assert.equal(await evaluate("[...document.querySelectorAll('[data-task-reply]')].at(-1).textContent.includes('把日子写成诗')"), true, "a failed image still delivers its text result");
      assert.equal(await evaluate("document.body.textContent.includes('改动结果暂不可用') || document.body.textContent.includes('宿主未提供')"), false, "a failed tool must show its host failure instead of the audit receipt or reload instruction");
    }
    await evaluate("window.agentUITest.coverErrorCode='';window.agentUITest.coverUsageIncomplete=true;document.querySelector('textarea').focus()");
    await send("Input.insertText", {text:"再生成封面"});
    await click("发送");
    await wait("document.body.textContent.includes('生图已扣 20 Credits · 文本费用尚未结算，等待核对。')");
    assert.equal(await evaluate("document.body.textContent.includes('本次未扣费') || document.body.textContent.includes('用量未完整返回，未扣费')"), false);
    await send("Page.navigate", { url: url+"&cover-preview-fail=1" });
    await wait("document.body.textContent.includes('封面预览暂时无法加载')");
    assert.equal(await evaluate("document.body.textContent.includes('山间来信')"), true, "text survives reloading the conversation");
    assert.equal(await evaluate("[...document.querySelectorAll('button')].some(b=>b.textContent.includes('下载封面') && !b.disabled)"), true, "preview failure keeps download available");
    await evaluate("window.agentUITest.failFirst=false;document.querySelector('textarea').focus()");
    await send("Input.insertText", {text:"生成封面，润色文章，再给三个标题建议"});
    await click("发送");
    await wait("[...document.querySelectorAll('button')].some(b=>b.textContent.includes('批准应用'))");
    const replyCount = await evaluate("document.querySelectorAll('[data-task-reply]').length");
    await click("批准应用");
    await wait("[...document.querySelectorAll('button')].some(b=>b.textContent.includes('撤销改动'))");
    assert.equal(await evaluate("document.querySelectorAll('[data-task-reply]').length"), replyCount, "article edits cannot hide the final reply");
    await click("撤销改动");
    await wait("document.body.textContent.includes('已撤销 1 项改动。')");
    assert.equal(await evaluate("[...document.querySelectorAll('[data-task-reply]')].at(-1).textContent.includes('山间来信')"), true, "undo updates host status without discarding text");
  } finally { await close(); }
}
