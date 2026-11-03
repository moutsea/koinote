import assert from "node:assert/strict";

export async function checkComposerKeyboard(createClient, url) {
  const client = await createClient();
  const { send, evaluate, wait, clickAria } = client;
  const value = () => evaluate("document.querySelector('textarea').value");
  const count = () => evaluate("window.agentUITest.submissions.length");
  const fill = async (text) => {
    await evaluate("{const input=document.querySelector('textarea');input.focus();input.setSelectionRange(0,input.value.length);}");
    await send("Input.insertText", {text});
    await wait(`document.querySelector('textarea').value===${JSON.stringify(text)}`);
  };
  const enter = async (modifiers=0) => {
    await send("Input.dispatchKeyEvent", {type:"keyDown", key:"Enter", code:"Enter", text:"\r", unmodifiedText:"\r", windowsVirtualKeyCode:13, nativeVirtualKeyCode:13, modifiers});
    await send("Input.dispatchKeyEvent", {type:"keyUp", key:"Enter", code:"Enter", windowsVirtualKeyCode:13, nativeVirtualKeyCode:13, modifiers});
  };
  const syntheticEnter = (properties={}) => evaluate(`(() => {
    const event=new KeyboardEvent('keydown', {key:'Enter',code:'Enter',keyCode:13,bubbles:true,cancelable:true,...${JSON.stringify(properties)}});
    document.querySelector('textarea').dispatchEvent(event);
    return event.defaultPrevented;
  })()`);
  try {
    await send("Page.navigate", {url});
    await wait("window.agentUITest && document.querySelector('[data-agent-panel]')");
    await evaluate("if(!document.querySelector('.agent-panel-open')) document.querySelector('.agent-statusbar button').click()");
    const previous = await evaluate("window.agentUITest.layoutStorage.read('agent-ui-test').active");
    await clickAria("新建会话");
    // The previous session may still have a composer while the new tab loads.
    await wait(`window.agentUITest.layoutStorage.read('agent-ui-test').active !== ${JSON.stringify(previous)}
      && document.querySelector('select[aria-label="改动权限"]')?.disabled === false && document.querySelector('textarea')`);
    await evaluate("window.agentUITest.failFirst=false;document.querySelector('textarea').focus()");
    assert.equal(await evaluate("document.querySelector('.agent-send').title"), "Enter 发送 · Ctrl + Enter 换行");
    await enter();
    assert.equal(await count(),0,"empty Enter never sends");
    assert.equal(await value(),"","plain Enter is not a newline");

    await fill("第一行第二行");
    await evaluate("document.querySelector('textarea').setSelectionRange(3,3)");
    await enter(2); // Ctrl
    assert.equal(await value(),"第一行\n第二行","Ctrl+Enter inserts at the caret");
    assert.equal(await evaluate("document.querySelector('textarea').selectionStart"),4);
    await send("Input.insertText", {text:"新"});
    assert.equal(await value(),"第一行\n新第二行","typing continues at the inserted newline");
    await evaluate("document.querySelector('textarea').setSelectionRange(3,5)");
    await enter(2);
    assert.equal(await value(),"第一行\n第二行","Ctrl+Enter replaces the selection");
    assert.equal(await count(),0,"Ctrl+Enter never sends");
    await send("Page.reload");
    await wait("document.querySelector('textarea')?.value==='第一行\\n第二行'");
    await evaluate("window.agentUITest.failFirst=false");

    // Keep the standard Shift+Enter alternative as a native textarea newline.
    await fill("第一行");
    await enter(8); // Shift
    await send("Input.insertText", {text:"第二行"});
    assert.equal(await value(),"第一行\n第二行");
    assert.equal(await count(),0);

    // Independent guards: native composition flag, composition lifecycle, and
    // WebKit's compositionend-before-keydown / keyCode 229 ordering.
    await fill("中文候选词");
    assert.equal(await syntheticEnter({isComposing:true}),false);
    assert.equal(await syntheticEnter({isComposing:true,ctrlKey:true}),false);
    await evaluate("document.querySelector('textarea').dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'词'}))");
    assert.equal(await syntheticEnter(),false,"composition state also protects browsers missing isComposing");
    assert.equal(await count(),0);
    await evaluate("document.querySelector('textarea').dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'词'}))");
    assert.equal(await syntheticEnter({keyCode:229}),false,"WebKit IME confirmation must remain available to the IME");
    assert.equal(await count(),0);
    assert.equal(await value(),"中文候选词");
    assert.equal(await syntheticEnter({repeat:true}),true);
    assert.equal(await count(),0,"holding Enter cannot submit repeatedly");

    await enter();
    await wait("window.agentUITest.submissions.length===1 && document.querySelector('textarea').value===''");
    assert.equal(await evaluate("window.agentUITest.submissions[0].message"),"中文候选词","a subsequent ordinary Enter sends the committed text");

    // Manual insertion must honor maxLength, including replacing a selection.
    await fill("x".repeat(16000));
    await enter(2);
    assert.equal((await value()).length,16000);
    assert.equal((await value()).includes("\n"),false);
    await evaluate("document.querySelector('textarea').setSelectionRange(10,12)");
    await enter(2);
    assert.equal((await value()).length,15999);
    assert.equal((await value()).slice(9,12),"x\nx");

    // No submission during an outstanding request, but the next draft can
    // still be edited with Ctrl+Enter while that request is waiting.
    await fill("等待响应");
    await evaluate("window.agentUITest.holdNextResponse=true;window.agentUITest.responseHeld=false");
    await enter();
    await wait("window.agentUITest.responseHeld");
    await fill("下一条草稿");
    const heldCount=await count();
    await enter();
    assert.equal(await count(),heldCount);
    assert.equal(await value(),"下一条草稿");
    await enter(2);
    await send("Input.insertText", {text:"第二行"});
    assert.equal(await value(),"下一条草稿\n第二行");
    await evaluate("window.agentUITest.releaseResponse()");
    await wait("!document.querySelector('select[aria-label=\"改动权限\"]').disabled");
    assert.equal(await value(),"下一条草稿\n第二行","acknowledgement preserves the newer multiline draft");

    // Losing focus cancels a stale composition flag (e.g. switching chats).
    await evaluate("document.querySelector('textarea').dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true}));document.querySelector('textarea').blur();document.querySelector('textarea').focus()");
    await enter();
    await wait(`window.agentUITest.submissions.length===${heldCount+1} && document.querySelector('textarea').value===''`);
    assert.equal(await evaluate("window.agentUITest.submissions.at(-1).message"),"下一条草稿\n第二行");
    console.log("Koi composer keyboard passed: Enter send, Ctrl+Enter caret/selection/newline persistence, IME/native/WebKit guards, repeat, length limit and busy drafts.");
  } finally { await client.close(); }
}
