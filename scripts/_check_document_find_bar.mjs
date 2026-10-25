import assert from "node:assert/strict";
import { parseHTML } from "linkedom";

const { window } = parseHTML("<html><head></head><body></body></html>");
globalThis.window = window;
globalThis.document = window.document;
globalThis.Node = window.Node;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
document.getSelection = () => null;
window.location = { search: "?lang=en" };
window.requestAnimationFrame = (callback) => setTimeout(callback, 0);
window.HTMLElement.prototype.getClientRects = function () { return this.isConnected ? [{}] : []; };
window.HTMLElement.prototype.scrollIntoView = () => {};
window.HTMLInputElement.prototype.select = () => {};

const [
  { createElement: h, act },
  { createRoot },
  { Editor },
  { default: StarterKit },
  { DocumentFindBar, I18nProvider, PageSearchExtension, documentSearchSnapshot },
] = await Promise.all([
  import("react"),
  import("react-dom/client"),
  import("@tiptap/core"),
  import("@tiptap/starter-kit"),
  import("./_document_find_bar_bundle.mjs"),
]);

async function key(key, modifiers = { metaKey: true }) {
  const event = new window.Event("keydown", { bubbles: true, cancelable: true });
  Object.assign(event, { key, metaKey: false, ctrlKey: false, ...modifiers });
  await act(async () => { window.dispatchEvent(event); });
}

for (const title of ["Title", "cat title"]) {
  for (const mode of ["f", "r"]) {
    for (const change of ["delete-earlier-match", "insert-earlier-match"]) {
      const host = document.body.appendChild(document.createElement("div"));
      const heading = host.appendChild(document.createElement("h1"));
      heading.className = "kn-doc-title";
      heading.textContent = title;
      const editor = new Editor({
        element: host.appendChild(document.createElement("div")),
        extensions: [StarterKit, PageSearchExtension],
        content: { type: "doc", content: ["first", "second", "third"].map((label) => ({ type: "paragraph", content: [{ type: "text", text: `cat ${label}` }] })) },
        editorProps: { handleScrollToSelection: () => true },
      });
      const root = createRoot(host.appendChild(document.createElement("div")));
      await act(async () => {
        root.render(h(I18nProvider, null, h(DocumentFindBar, { editor, title, editorRootRef: { current: host } })));
      });
      const click = async (label) => {
        const button = [...host.querySelectorAll("button")].find((node) => node.getAttribute("aria-label") === label || node.textContent === label);
        assert.ok(button, `missing button: ${label}`);
        await act(async () => { button.click(); });
      };
      const assertTarget = (index, total, titleOffset) => {
        assert.equal(editor.view.dom.querySelector(".kn-page-search-current")?.parentElement.textContent, "cat second");
        assert.deepEqual(documentSearchSnapshot(editor), { activeIndex: index, total });
        assert.equal(host.querySelector('[aria-live="polite"]').textContent, `${index + 1 + titleOffset} / ${total + titleOffset}`);
      };
      editor.commands.setTextSelection({ from: 12, to: 15 });
      await key(mode);
      const offset = mode === "f" && title.includes("cat") ? 1 : 0;
      assertTarget(1, 3, offset);
      await act(async () => {
        if (change === "delete-earlier-match") {
          editor.commands.setTextSelection({ from: 1, to: 4 });
          editor.commands.deleteSelection();
        } else editor.commands.insertContentAt(1, "cat new ");
      });
      const index = change === "delete-earlier-match" ? 0 : 2;
      const total = change === "delete-earlier-match" ? 2 : 4;
      assertTarget(index, total, offset);
      await act(async () => { editor.commands.undo(); });
      assertTarget(1, 3, offset);
      await act(async () => { editor.commands.redo(); });
      assertTarget(index, total, offset);
      const beforeReplace = editor.state.doc.textContent;
      await key("r");
      assertTarget(index, total, 0);
      await click("Replace");
      assert.equal(editor.state.doc.textContent, beforeReplace.replace("cat second", " second"));
      await act(async () => { editor.commands.undo(); });
      assert.equal(editor.state.doc.textContent, beforeReplace);

      if (offset) {
        await key("f");
        for (let remaining = total + 1; documentSearchSnapshot(editor).activeIndex >= 0 && remaining > 0; remaining--) {
          await click("Previous match");
        }
        assert.equal(documentSearchSnapshot(editor).activeIndex, -1);
        await act(async () => { editor.commands.insertContentAt(1, "cat "); });
        assert.equal(documentSearchSnapshot(editor).activeIndex, -1);
        assert.ok(heading.classList.contains("kn-page-search-title-current"));
        assert.equal(host.querySelector('[aria-live="polite"]').textContent, `1 / ${total + 2}`);
      }
      await act(async () => { root.unmount(); });
      editor.destroy();
      host.remove();
      console.log(`PASS live document edits preserve the target and counter (${title}, ${mode}, ${change})`);
    }
  }
}

for (const [original, from, to, expected] of [
  ["ababa", 3, 6, "ab"],
  ["abababa", 3, 6, "abba"],
  ["天地天地天", 3, 6, "天地"],
  ["ababa tail aba", 3, 6, "ab tail aba"],
  ["🐈🐈🐈", 3, 7, "🐈"],
]) {
  const host = document.body.appendChild(document.createElement("div"));
  const editor = new Editor({
    element: host.appendChild(document.createElement("div")),
    extensions: [StarterKit, PageSearchExtension],
    content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: original }] }] },
    editorProps: { handleScrollToSelection: () => true },
  });
  const query = original.slice(from - 1, to - 1);
  const root = createRoot(host.appendChild(document.createElement("div")));
  await act(async () => {
    root.render(h(I18nProvider, null, h(DocumentFindBar, { editor, title: query, editorRootRef: { current: host } })));
  });
  const click = async (label) => {
    const button = [...host.querySelectorAll("button")].find((node) => node.getAttribute("aria-label") === label || node.textContent === label);
    assert.ok(button, `missing button: ${label}`);
    await act(async () => { button.click(); });
  };
  const assertSelectedMatch = () => {
    const current = editor.view.dom.querySelector(".kn-page-search-current");
    assert.equal(current?.textContent, query);
    assert.equal(editor.view.posAtDOM(current, 0), from);
    assert.equal(editor.view.dom.querySelectorAll(".kn-page-search-current").length, 1);
  };
  editor.commands.setTextSelection({ from, to });
  await key("r");
  assertSelectedMatch();
  await key("f");
  assertSelectedMatch();
  await key("r", { ctrlKey: true });
  assertSelectedMatch();
  await click("Previous match");
  await click("Next match");
  assertSelectedMatch();
  await click("Replace");
  assert.equal(editor.state.doc.textContent, expected);
  await act(async () => { editor.commands.undo(); });
  assert.equal(editor.state.doc.textContent, original);
  await act(async () => { editor.commands.redo(); });
  assert.equal(editor.state.doc.textContent, expected);
  await act(async () => { root.unmount(); });
  editor.destroy();
  host.remove();
  console.log(`PASS overlapping selection stays the exact replacement target (${original})`);
}

for (const title of ["Title without a match", "cat title"]) {
  for (const [index, shortcut, modifiers] of [
    [1, "r", { metaKey: true }],
    [2, "r", { ctrlKey: true }],
    [2, "f", { metaKey: true }],
    [2000, "r", { metaKey: true }],
  ]) {
    const count = index > 2 ? index + 1 : 3;
    const original = Array(count).fill("cat").join(" ");
    const host = document.body.appendChild(document.createElement("div"));
    const editor = new Editor({
      element: host.appendChild(document.createElement("div")),
      extensions: [StarterKit, PageSearchExtension],
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: original }] }] },
      editorProps: { handleScrollToSelection: () => true },
    });
    const root = createRoot(host.appendChild(document.createElement("div")));
    await act(async () => {
      root.render(h(I18nProvider, null, h(DocumentFindBar, { editor, title, editorRootRef: { current: host } })));
    });
    const selectMatch = (target) => editor.commands.setTextSelection({ from: 1 + target * 4, to: 4 + target * 4 });
    const assertCurrent = (target) => {
      assert.equal(documentSearchSnapshot(editor).activeIndex, target);
      assert.equal(editor.view.dom.querySelector(".kn-page-search-current")?.getAttribute("data-page-search-index"), String(target));
    };
    selectMatch(index);
    await key(shortcut, modifiers);
    assert.equal(host.querySelector("input").value, "cat");
    assertCurrent(index);
    const offset = shortcut === "f" && title.includes("cat") ? 1 : 0;
    assert.equal(host.querySelector('[aria-live="polite"]').textContent, `${index + 1 + offset} / ${count + offset}`);
    if (shortcut === "f") {
      await key("r", { ctrlKey: true });
      assertCurrent(index);
    }
    // Closing and reopening with the same query must use the new selection.
    await key("Escape", {});
    selectMatch(0);
    await key("r");
    assertCurrent(0);
    await key("Escape", {});
    selectMatch(index);
    await key("r");
    assertCurrent(index);
    const replace = [...host.querySelectorAll("button")].find((node) => node.textContent === "Replace");
    await act(async () => { replace.click(); });
    assert.equal(editor.state.doc.textContent, original.slice(0, index * 4) + original.slice(index * 4 + 3));
    await act(async () => { editor.commands.undo(); });
    assert.equal(editor.state.doc.textContent, original);
    await act(async () => { root.unmount(); });
    editor.destroy();
    host.remove();
    console.log(`PASS opening from body selection preserves the target (${index + 1}, ${shortcut}, ${title})`);
  }
}

for (const title of ["Title without a match", "cat title"]) {
  const host = document.body.appendChild(document.createElement("div"));
  const editor = new Editor({
    element: host.appendChild(document.createElement("div")),
    extensions: [StarterKit, PageSearchExtension],
    content: { type: "doc", content: ["first", "second", "third"].map((label) => ({ type: "paragraph", content: [{ type: "text", text: `cat ${label}` }] })) },
    editorProps: { handleScrollToSelection: () => true },
  });
  const mount = host.appendChild(document.createElement("div"));
  const root = createRoot(mount);
  await act(async () => {
    root.render(h(I18nProvider, null, h(DocumentFindBar, { editor, title, editorRootRef: { current: host } })));
  });
  const click = async (label) => {
    const button = [...host.querySelectorAll("button")].find((node) => node.getAttribute("aria-label") === label || node.textContent === label);
    assert.ok(button, `missing button: ${label}`);
    await act(async () => { button.click(); });
  };
  const assertCurrent = (index) => assert.equal(documentSearchSnapshot(editor).activeIndex, index);

  editor.commands.setTextSelection({ from: 1, to: 4 });
  await key("f");
  await click("Next match");
  await click("Next match");
  assertCurrent(2);

  // The shortcut and disclosure button must preserve the same body match in both directions.
  await key("r");
  assertCurrent(2);
  await click("Find and replace");
  assertCurrent(2);
  await click("Find and replace");
  assertCurrent(2);
  await key("f");
  assertCurrent(2);
  await key("r", { ctrlKey: true });
  assertCurrent(2);
  await click("Replace"); // An empty replacement deletes only the third occurrence.
  assert.equal(editor.state.doc.textContent, "cat firstcat second third");

  // Starting from the title chooses the first replaceable body match.
  if (title.includes("cat")) {
    await key("f");
    await click("Previous match");
    assertCurrent(-1);
    await key("r");
    assertCurrent(0);
  }
  await key("Escape", {});
  assert.equal(host.querySelector('[role="search"]'), null);
  editor.commands.setTextSelection({ from: 5, to: 10 });
  await key("r");
  assert.equal(host.querySelector("input").value, "first");
  assert.deepEqual(documentSearchSnapshot(editor), { total: 1, activeIndex: 0 });

  await act(async () => { root.unmount(); });
  editor.destroy();
  host.remove();
  console.log(`PASS mode switching preserves the body match (${title})`);
}

for (const count of [2000, 2001]) {
  for (const title of ["Title without a match", "cat title"]) {
    const titleOffset = title.includes("cat") ? 1 : 0;
    const original = Array(count).fill("cat").join(" ");
    const host = document.body.appendChild(document.createElement("div"));
    const editor = new Editor({
      element: host.appendChild(document.createElement("div")),
      extensions: [StarterKit, PageSearchExtension],
      content: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: original }] }] },
      editorProps: { handleScrollToSelection: () => true },
    });
    const root = createRoot(host.appendChild(document.createElement("div")));
    await act(async () => {
      root.render(h(I18nProvider, null, h(DocumentFindBar, { editor, title, editorRootRef: { current: host } })));
    });
    const click = async (label) => {
      const button = [...host.querySelectorAll("button")].find((node) => node.getAttribute("aria-label") === label || node.textContent === label);
      assert.ok(button, `missing button: ${label}`);
      await act(async () => { button.click(); });
    };
    const assertCount = (current, total) => assert.equal(host.querySelector('[aria-live="polite"]').textContent, `${current} / ${total}`);
    const assertCurrent = (index) => {
      assert.equal(documentSearchSnapshot(editor).activeIndex, index);
      assert.equal(editor.view.dom.querySelector(".kn-page-search-current")?.getAttribute("data-page-search-index"), String(index));
      assert.ok(editor.view.dom.querySelectorAll(".kn-page-search-match").length <= 2000);
    };

    editor.commands.setTextSelection({ from: 1, to: 4 });
    await key("f");
    assertCount(1 + titleOffset, count + titleOffset);
    if (titleOffset) await click("Previous match");
    await click("Previous match");
    assertCurrent(count - 1);
    assertCount(count + titleOffset, count + titleOffset);
    await click("Previous match");
    assertCurrent(count - 2);
    await click("Next match");
    assertCurrent(count - 1);
    await click("Next match");
    assertCount(1, count + titleOffset);
    await click("Previous match");

    // Entering replace mode keeps a match beyond the first highlight window.
    await key("r");
    assertCurrent(count - 1);
    assertCount(count, count);
    await click("Replace");
    assert.equal(editor.state.doc.textContent, original.slice(0, -3));
    assertCurrent(0);
    assertCount(1, count - 1);
    await act(async () => { editor.commands.undo(); });
    assert.equal(editor.state.doc.textContent, original);
    assertCount(1, count);
    await act(async () => { editor.commands.redo(); });
    assert.equal(editor.state.doc.textContent, original.slice(0, -3));
    assertCount(1, count - 1);

    await act(async () => { root.unmount(); });
    editor.destroy();
    host.remove();
    console.log(`PASS navigation and exact counts at the highlight boundary (${count}, ${title})`);
  }
}
