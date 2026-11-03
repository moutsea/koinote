import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

export async function checkProposalDialog({ evaluate, send, wait, click, clickAria }) {
  const firstDoc = "00000000-0000-4000-8000-000000000001";
  const reopenPanel = async () => {
    await evaluate("document.querySelector('.agent-statusbar button').click()");
    await wait("document.querySelector('[data-operation-id]')");
  };
  await evaluate("document.querySelector('textarea').focus()");
  await send("Input.insertText", { text: "还没发送的下一条消息" });
  await clickAria("最大化");
  await click("打开文档");
  await wait("!document.querySelector('.agent-panel-open')");
  assert.equal(await evaluate("window.agentUITest.openedDocuments.at(-1)"), firstDoc);
  await reopenPanel();
  assert.equal(await evaluate("document.querySelector('textarea').value"), "还没发送的下一条消息",
    "opening a document preserves the unsent conversation draft");
  await evaluate("Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(document.querySelector('textarea'),'');document.querySelector('textarea').dispatchEvent(new Event('input',{bubbles:true}))");
  assert.equal(await evaluate("document.querySelector('[aria-label=最大化]') !== null"), true,
    "opening the already active document exits maximized mode and reveals the editor");
  await evaluate("window.agentUITest.switchDoc()");
  await click("打开文档");
  await wait("!document.querySelector('.agent-panel-open')");
  assert.deepEqual(await evaluate("window.agentUITest.openedDocuments"), [firstDoc, firstDoc],
    "a proposal opens its own document, even after the active document changed");
  await reopenPanel();
  const openDiff = async () => {
    await evaluate("document.querySelector('.agent-diff-toggle').focus()");
    await click("查看差异");
    await wait("document.querySelector('.agent-diff-dialog')");
  };
  await openDiff();
  assert.equal(await evaluate("document.querySelector('.agent-diff-dialog').closest('[data-agent-panel]') === null"), true,
    "comparison is portalled outside the small assistant panel");
  assert.equal(await evaluate("window.agentUITest.isModalOpen()"), true);
  assert.equal(await evaluate("document.querySelector('.agent-diff-dialog').contains(document.activeElement)"), true);
  const bounds = await evaluate("(() => {const r=document.querySelector('.agent-diff-dialog').getBoundingClientRect();return {width:r.width,height:r.height};})()");
  assert.ok(bounds.width > 850 && bounds.height > 600, "comparison uses the desktop viewport");
  assert.deepEqual(await evaluate("['.agent-article-preview','.agent-diff-dialog-scroll'].map(s=>document.querySelectorAll(s).length)"), [1,1],
    "one article and one scroll region on desktop");
  assert.equal(await evaluate("document.querySelector('.agent-article-preview').innerText.includes('抵达云南的第一天')"), true);
  assert.equal(await evaluate("document.querySelectorAll('.agent-article-preview > p').length"), 1,
    "the unchanged second paragraph is printed once");
  assert.equal(await evaluate("document.querySelector('[data-change=modified] details').open"), false);
  await evaluate("document.querySelector('[data-change=modified] summary').click()");
  assert.equal(await evaluate("document.querySelector('[data-change=modified] details[open] .agent-old-text').innerText"), "原来的第一段。",
    "the original is available at the location of the replacement");
  await evaluate("[...document.querySelectorAll('.agent-diff-dialog button')].at(-1).focus()");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  assert.equal(await evaluate("document.activeElement === document.querySelector('.agent-diff-dialog button')"), true,
    "Tab stays inside the comparison");
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await wait("!document.querySelector('.agent-diff-dialog')");
  assert.equal(await evaluate("document.activeElement.matches('.agent-diff-toggle')"), true);
  assert.equal(await evaluate("window.agentUITest.isModalOpen()"), false);
  await openDiff();
  await clickAria("关闭");
  await wait("!document.querySelector('.agent-diff-dialog')");
  await openDiff();
  await evaluate("document.querySelector('.agent-diff-backdrop').click()");
  await wait("!document.querySelector('.agent-diff-dialog')");

  const original = await evaluate("({before:window.agentUITest.server.operations[0].before.document.content,after:window.agentUITest.server.operations[0].input.content,titles:[window.agentUITest.server.operations[0].before.document.title,window.agentUITest.server.operations[0].input.title]})");
  const beforeArticle = `## 古城初见

我们从古城开始这段旅程。

![街景](/preview-image.svg "旅途中的第一张照片")

照片后的原文段落。

### 午后漫步

- 沿着石板路慢慢走
- 在街角喝一杯茶

![参考式图片][photo]

参考图片后的段落。

删除这段文字。

保持结尾。

[photo]: /preview-image.svg?reference=1
`;
  const afterArticle = `## 古城初见

抵达云南的第一天，我们从古城开始这段旅程。**放慢脚步**，感受街巷里的日常。

![街景](/preview-image.svg "旅途中的第一张照片")

照片后的修改段落。

### 午后漫步

- 沿着石板路慢慢走
- 在街角喝一杯茶

![参考式图片][photo]

参考图片后的段落。

保持结尾。

<img src="/preview-image.svg?html=1" alt="HTML 图片" onerror="window.previewInjection=1">

HTML 图片后的段落。

![再次出现](/preview-image.svg)

重复图片后的段落。

![第五张](/preview-image.svg?fifth=1)

第五张后的段落。

![自有图床](https://img.koinote.app/u/preview/abcdef12.png)

最后一张后的段落。

[不安全链接](javascript:alert(1))
<script>window.previewInjection=1</script>

[photo]: /preview-image.svg?reference=1
`;
  await evaluate(`window.agentUITest.replaceDiffContent(${JSON.stringify(beforeArticle)},${JSON.stringify(afterArticle)})`);
  await openDiff();
  await wait("[...document.querySelectorAll('.agent-article-preview img')].some(img=>img.complete&&img.naturalWidth>0)");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.agent-article-preview img')].map(img=>img.alt)"),
    ["街景","参考式图片","HTML 图片","再次出现","第五张","自有图床"],
    "unchanged images appear once and new images retain their place in the article");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('.agent-article-preview [data-change]')].map(el=>el.dataset.change)"),
    ["modified","modified","removed","added"], "modifications, deletion and addition stay in document order");
  assert.equal(await evaluate("document.querySelector('[data-change=removed]').nextElementSibling.textContent"), "保持结尾。");
  await evaluate("document.querySelector('[data-change=removed] summary').click()");
  assert.equal(await evaluate("document.querySelector('[data-change=removed] details[open] .agent-old-text').innerText"), "删除这段文字。");
  const imageOrder = await evaluate(`[...document.querySelectorAll('.agent-article-preview p:not(:has(img)), .agent-article-preview img')]
    .filter(el=>!el.closest('details')).map(el=>el.alt??el.textContent.trim())`);
  for (const [image, paragraph] of [["街景", "照片后的修改段落。"], ["参考式图片", "参考图片后的段落。"], ["HTML 图片", "HTML 图片后的段落。"], ["再次出现", "重复图片后的段落。"], ["第五张", "第五张后的段落。"], ["自有图床", "最后一张后的段落。"]]) {
    assert.ok(imageOrder.indexOf(image) >= 0 && imageOrder.indexOf(image) < imageOrder.indexOf(paragraph), `${image} stays before its following paragraph`);
  }
  assert.equal(await evaluate("document.querySelector('.agent-article-preview strong')?.textContent"), "放慢脚步");
  assert.equal(await evaluate("document.querySelector('.agent-article-preview img[alt=自有图床]').getAttribute('src').startsWith('/images/u/preview/')"), true);
  assert.equal(await evaluate("!document.querySelector('.agent-article-preview script, .agent-article-preview [onerror], .agent-article-preview a[href^=javascript]') && window.previewInjection===undefined"), true,
    "rendered HTML keeps images while removing executable content");
  const previewShot = await send("Page.captureScreenshot", { format: "png" });
  await writeFile("/tmp/koinote-agent-article-comparison.png", Buffer.from(previewShot.data, "base64"));
  await clickAria("关闭");
  await evaluate("window.agentUITest.replaceDiffContent(Array.from({length:150},(_,i)=>'旧内容 '+i).join('\\n'),Array.from({length:150},(_,i)=>'新内容 '+i+' '+('很长的段落'.repeat(25))).join('\\n'))");
  await openDiff();
  assert.equal(await evaluate("(() => {let s=document.querySelector('.agent-diff-dialog-scroll');s.scrollTop=s.scrollHeight;return s.scrollHeight>s.clientHeight && s.scrollTop>0;})()"), true,
    "long comparisons scroll independently of the transcript");
  assert.equal(await evaluate("document.querySelectorAll('.agent-diff-dialog-scroll').length"), 1);
  await send("Emulation.setDeviceMetricsOverride", { width: 375, height: 667, deviceScaleFactor: 1, mobile: false });
  assert.equal(await evaluate("(() => {const r=document.querySelector('.agent-diff-dialog').getBoundingClientRect();return r.x>=0&&r.right<=innerWidth&&r.y>=0&&r.bottom<=innerHeight&&[...document.querySelectorAll('.agent-diff-dialog-scroll')].every(s=>s.scrollWidth<=s.clientWidth);})()"), true,
    "narrow screens keep the dialog and long lines within the viewport");
  await clickAria("关闭");
  await send("Emulation.clearDeviceMetricsOverride");
  await evaluate("window.agentUITest.replaceDiffContent('相同的正文。','相同的正文。',['旧标题','新标题'])");
  await openDiff();
  assert.equal(await evaluate("document.querySelector('[data-change=modified] > h1').textContent"), "新标题");
  assert.equal(await evaluate("document.querySelector('[data-change=modified] details h1').textContent"), "旧标题");
  assert.equal(await evaluate("document.querySelectorAll('.agent-article-preview > p').length"), 1);
  await clickAria("关闭");
  await evaluate("window.agentUITest.replaceDiffContent('','新文章的正文。',['','新文章'])");
  await openDiff();
  assert.equal(await evaluate("document.querySelector('[data-change=added] h1').textContent"), "新文章");
  assert.equal(await evaluate("document.querySelector('.agent-article-preview details')"), null,
    "creating a document has no placeholder original");
  await clickAria("关闭");
  const table = "| A | B |\n| --- | --- |\n| x | y |";
  const widths = (value) => `<!-- koinote-table-widths: ${value} -->\n${table}`;
  await evaluate(`window.agentUITest.replaceDiffContent(${JSON.stringify(widths("120,400"))},${JSON.stringify(widths("400,120"))},["表格","表格"])`);
  await openDiff();
  assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-change=modified] > .agent-preview-table col')].map(col=>col.style.width)"), ["400px","120px"]);
  await evaluate("document.querySelector('[data-change=modified] summary').click()");
  assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-change=modified] details[open] col')].map(col=>col.style.width)"), ["120px","400px"]);
  await clickAria("关闭");
  for (const [formula, literal] of [
    ["公式 $x^2$", String.raw`公式 \$x^2\$`],
    ["$$\nx^2\n$$", "`$$ x^2 $$`"],
  ]) {
    await evaluate(`window.agentUITest.replaceDiffContent(${JSON.stringify(formula)},${JSON.stringify(literal)},["公式","公式"])`);
    await openDiff();
    assert.equal(await evaluate("Boolean(document.querySelector('[data-change=modified] details .katex'))"), true);
    assert.equal(await evaluate("Boolean(document.querySelector('[data-change=modified] > :not(details) .katex'))"), false);
    await clickAria("关闭");
  }
  const mathTable = alignment => "公式 $x^2$\n\n| A | B |\n| "+alignment+" | --- |\n| x | y |";
  await evaluate(`window.agentUITest.replaceDiffContent(${JSON.stringify(mathTable(":---"))},${JSON.stringify(mathTable("---:"))},["表格","表格"])`);
  await openDiff();
  assert.equal(await evaluate("document.querySelector('[data-change=modified] > .agent-preview-table th').style.textAlign"),"right");
  assert.equal(await evaluate("document.querySelector('[data-change=modified] details th').style.textAlign"),"left");
  await clickAria("关闭");
  for (const prefix of ["", "公式 $x$\n\n"]) {
    const quotedTable=widths => prefix + "> <!-- koinote-table-widths: " + widths + " -->\n> | A | B |\n> | --- | --- |\n> | x | y |";
    await evaluate(`window.agentUITest.replaceDiffContent(${JSON.stringify(quotedTable("120,400"))},${JSON.stringify(quotedTable("400,120,600"))},["引用表格","引用表格"])`);
    await openDiff();
    assert.deepEqual(await evaluate("[...document.querySelectorAll('[data-change=modified] > blockquote col')].map(col=>col.style.width)"), ["400px","120px"]);
    await clickAria("关闭");
    for (const [before, after] of [["120,400", "120,400,600"], ["0,0", "0,0,600"]]) {
      await evaluate(`window.agentUITest.replaceDiffContent(${JSON.stringify(quotedTable(before))},${JSON.stringify(quotedTable(after))},["引用表格","引用表格"])`);
      await openDiff();
      assert.equal(await evaluate("document.querySelectorAll('.agent-diff-dialog [data-change=modified]').length"), 0);
      await clickAria("关闭");
    }
  }
  const photo = "![同一张图][pic]\n\n[pic]: /preview-image.svg?";
  await evaluate(`window.agentUITest.replaceDiffContent(${JSON.stringify(photo + "old")},${JSON.stringify(photo + "new")},["图片","图片"])`);
  await openDiff();
  assert.equal(await evaluate("document.querySelector('[data-change=modified] > p img').getAttribute('src')"), "/preview-image.svg?new");
  assert.equal(await evaluate("document.querySelector('[data-change=modified] details img').getAttribute('src')"), "/preview-image.svg?old",
    "changing a reference definition is visible at the image position");
  await clickAria("关闭");
  await evaluate(`window.agentUITest.replaceDiffContent(${JSON.stringify(original.before)},${JSON.stringify(original.after)},${JSON.stringify(original.titles)})`);
  await evaluate("window.agentUITest.showLegacyProposal(true)");
  await openDiff();
  assert.equal(await evaluate("document.querySelector('.agent-diff-dialog').textContent.includes('旧版提案正文')"), true,
    "legacy proposals use the same full-size comparison dialog");
  await clickAria("关闭");
  await evaluate("window.agentUITest.showLegacyProposal(false)");
  await openDiff();
  // Open-document also works from the dialog, closing both overlays while
  // preserving the pending operation and the conversation for later review.
  await evaluate("[...document.querySelectorAll('.agent-diff-dialog button')].find(b=>b.textContent==='打开文档').click()");
  await wait("!document.querySelector('.agent-diff-dialog') && !document.querySelector('.agent-panel-open')");
  assert.equal(await evaluate("window.agentUITest.isModalOpen()"), false);
  assert.equal(await evaluate("window.agentUITest.server.operations[0].status"), "pending");
  await reopenPanel();
  await openDiff();
  console.log("proposal dialog: single article with in-place changes, inline images, sanitization, navigation, viewport, scroll, focus, Escape and dismissal passed");
}
