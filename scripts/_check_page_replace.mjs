import assert from "node:assert/strict";
import { parseHTML } from "linkedom";

const { window } = parseHTML("<html><head></head><body></body></html>");
globalThis.window = window;
globalThis.document = window.document;
globalThis.Node = window.Node;
// linkedom has no browser selection; these tests exercise document transactions.
document.getSelection = () => null;

const [
  { Editor },
  { default: StarterKit },
  { Table, TableRow, TableHeader, TableCell },
  { undoDepth },
  { Step, StepMap, Mapping },
  { Decoration, DecorationSet },
  { PageSearchExtension, setDocumentSearchQuery, activateDocumentSearchMatch, documentSearchSnapshot, replaceDocumentSearch },
] = await Promise.all([
  import("@tiptap/core"),
  import("@tiptap/starter-kit"),
  import("@tiptap/extension-table"),
  import("@tiptap/pm/history"),
  import("@tiptap/pm/transform"),
  import("@tiptap/pm/view"),
  import("./_page_search_bundle.mjs"),
]);

const text = (value, marks) => ({ type: "text", text: value, ...(marks ? { marks } : {}) });
const paragraph = (...content) => ({ type: "paragraph", content });
function createEditor(content, editable = true) {
  const editor = new Editor({
    element: document.body.appendChild(document.createElement("div")),
    extensions: [StarterKit, PageSearchExtension, Table, TableRow, TableHeader, TableCell],
    content: { type: "doc", content },
    editable,
    editorProps: { handleScrollToSelection: () => true },
  });
  editor.view.dispatch(editor.state.tr.setMeta("addToHistory", false));
  return editor;
}
function test(name, run) {
  run();
  console.log(`PASS ${name}`);
}

test("live edits track the same text at both boundaries and through formatting", () => {
  for (const [position, inserted, expectedFrom] of [[1, "cat ", 11], [7, "cat ", 11], [10, " cat", 7]]) {
    const editor = createEditor([paragraph(text("cat A cat B cat C"))]);
    setDocumentSearchQuery(editor, "cat", { from: 7, to: 10 });
    editor.view.dispatch(editor.state.tr.insertText(inserted, position).setMeta("addToHistory", false));
    let current = editor.view.dom.querySelector(".kn-page-search-current");
    assert.equal(editor.view.posAtDOM(current, 0), expectedFrom);
    editor.view.dispatch(editor.state.tr.addMark(expectedFrom, expectedFrom + 3, editor.schema.marks.bold.create()));
    current = editor.view.dom.querySelector(".kn-page-search-current");
    assert.equal(editor.view.posAtDOM(current, 0), expectedFrom);
    const before = editor.state.doc.textContent;
    replaceDocumentSearch(editor, "X");
    assert.equal(editor.state.doc.textContent, before.slice(0, expectedFrom - 1) + "X" + before.slice(expectedFrom + 2));
    editor.destroy();
  }
});

test("editing away the current match selects its successor or wraps at the end", () => {
  for (const [selected, removeFrom, removeTo, expectedFrom, expectedIndex] of [
    [1, 7, 10, 10, 1],
    [2, 13, 16, 1, 0],
    [1, 1, 18, null, -1],
  ]) {
    const editor = createEditor([paragraph(text("cat A cat B cat C"))]);
    setDocumentSearchQuery(editor, "cat");
    activateDocumentSearchMatch(editor, selected);
    editor.view.dispatch(editor.state.tr.delete(removeFrom, removeTo));
    assert.equal(documentSearchSnapshot(editor).activeIndex, expectedIndex);
    const current = editor.view.dom.querySelector(".kn-page-search-current");
    if (expectedFrom === null) {
      assert.equal(current, null);
      assert.equal(documentSearchSnapshot(editor).total, 0);
    } else {
      assert.equal(editor.view.posAtDOM(current, 0), expectedFrom);
      assert.equal(current.textContent, "cat");
    }
    editor.destroy();
  }
});

test("overlapping current ranges survive insertions and deletions before them", () => {
  const editor = createEditor([paragraph(text("abababa tail aba"))]);
  setDocumentSearchQuery(editor, "aba", { from: 3, to: 6 });
  editor.view.dispatch(editor.state.tr.insertText("ab", 1).setMeta("addToHistory", false));
  assert.equal(documentSearchSnapshot(editor).activeIndex, 2);
  assert.equal(editor.view.posAtDOM(editor.view.dom.querySelector(".kn-page-search-current"), 0), 5);
  editor.view.dispatch(editor.state.tr.delete(1, 3).setMeta("addToHistory", false));
  assert.equal(documentSearchSnapshot(editor).activeIndex, 1);
  assert.equal(editor.view.posAtDOM(editor.view.dom.querySelector(".kn-page-search-current"), 0), 3);
  replaceDocumentSearch(editor, "X");
  assert.equal(editor.state.doc.textContent, "abXba tail aba");
  editor.commands.undo();
  assert.equal(editor.state.doc.textContent, "abababa tail aba");
  editor.destroy();
});

test("mapped targets stay visible beyond the highlight window", () => {
  const original = Array(2001).fill("cat").join(" ");
  const editor = createEditor([paragraph(text(original))]);
  setDocumentSearchQuery(editor, "cat", { from: 8001, to: 8004 });
  editor.view.dispatch(editor.state.tr.insertText("cat ", 1).setMeta("addToHistory", false));
  assert.deepEqual(documentSearchSnapshot(editor), { total: 2002, activeIndex: 2001 });
  assert.equal(editor.view.posAtDOM(editor.view.dom.querySelector(".kn-page-search-current"), 0), 8005);
  assert.ok(editor.view.dom.querySelectorAll(".kn-page-search-match").length <= 2000);
  editor.view.dispatch(editor.state.tr.delete(1, 5).setMeta("addToHistory", false));
  assert.deepEqual(documentSearchSnapshot(editor), { total: 2001, activeIndex: 2000 });
  replaceDocumentSearch(editor, "X");
  assert.equal(editor.state.doc.textContent, original.slice(0, -3) + "X");
  editor.commands.undo();
  assert.equal(editor.state.doc.textContent, original);
  editor.destroy();
});

test("replace all keeps left-to-right non-overlapping semantics for overlapping queries", () => {
  for (const [original, query, selection] of [
    ["ababa", "aba", { from: 3, to: 6 }],
    ["abababa", "aba", { from: 3, to: 6 }],
    ["aaaaaa", "aa", { from: 2, to: 4 }],
    ["aAaAa", "aa", { from: 2, to: 4 }],
    ["天地天地天", "天地天", { from: 3, to: 6 }],
    ["🐈🐈🐈", "🐈🐈", { from: 3, to: 7 }],
  ]) {
    for (const replacement of ["", "X", query, "$&"]) {
      const editor = createEditor([paragraph(text(original))]);
      setDocumentSearchQuery(editor, query, selection);
      const pattern = new RegExp(query, "giu");
      const expected = original.replace(pattern, () => replacement);
      const expectedCount = [...original.matchAll(pattern)].length;
      assert.equal(replaceDocumentSearch(editor, replacement, true).replaced, expectedCount);
      assert.equal(editor.state.doc.textContent, expected);
      assert.equal(undoDepth(editor.state), expected === original ? 0 : 1);
      if (expected !== original) {
        editor.commands.undo();
        assert.equal(editor.state.doc.textContent, original);
        editor.commands.redo();
        assert.equal(editor.state.doc.textContent, expected);
      }
      editor.destroy();
    }
  }
});

test("overlapping matches retain exact positions across marks and hard breaks", () => {
  const editor = createEditor([paragraph(
    text("ab", [{ type: "bold" }]), text("ab", [{ type: "italic" }]), text("a", [{ type: "bold" }]),
    { type: "hardBreak" }, text("ababa", [{ type: "code" }]),
  )]);
  const original = editor.getJSON();
  assert.equal(setDocumentSearchQuery(editor, "aba").total, 4);
  for (const [index, from] of [1, 3, 7, 9].entries()) {
    activateDocumentSearchMatch(editor, index);
    const current = [...editor.view.dom.querySelectorAll(".kn-page-search-current")];
    assert.equal(editor.view.posAtDOM(current[0], 0), from);
    assert.equal(current.map((node) => node.textContent).join(""), "aba");
  }
  assert.equal(setDocumentSearchQuery(editor, "aba", { from: 3, to: 6 }).activeIndex, 1);
  replaceDocumentSearch(editor, "X");
  assert.equal(editor.state.doc.textContent, "abXababa");
  assert.deepEqual(editor.getJSON().content[0].content.slice(0, 3), [
    text("ab", [{ type: "bold" }]), text("X", [{ type: "italic" }]), { type: "hardBreak" },
  ]);
  editor.commands.undo();
  assert.deepEqual(editor.getJSON(), original);
  // A partial range must not be treated as an exact selected match.
  assert.equal(setDocumentSearchQuery(editor, "aba", { from: 3, to: 5 }).activeIndex, -1);
  editor.destroy();
});

test("overlapping navigation stays exact and bounded across highlight windows", () => {
  const original = "a".repeat(6003);
  const editor = createEditor([paragraph(text(original))]);
  assert.equal(setDocumentSearchQuery(editor, "aa").total, 6002);
  for (const index of [0, 1999, 2000, 3999, 4000, 6001]) {
    activateDocumentSearchMatch(editor, index);
    const current = editor.view.dom.querySelector(".kn-page-search-current");
    assert.equal(current?.textContent, "aa");
    assert.equal(editor.view.posAtDOM(current, 0), index + 1);
    assert.equal(editor.view.dom.querySelectorAll(".kn-page-search-current").length, 1);
    assert.ok(editor.view.dom.querySelectorAll(".kn-page-search-match").length <= 2000);
  }
  assert.equal(replaceDocumentSearch(editor, "X", true).replaced, 3001);
  assert.equal(editor.state.doc.textContent, "X".repeat(3001) + "a");
  editor.commands.undo();
  assert.equal(editor.state.doc.textContent, original);
  editor.destroy();
});

test("single replacement advances through live matches and supports deletion", () => {
  const editor = createEditor([paragraph(text("猫 猫 猫"))]);
  setDocumentSearchQuery(editor, "猫");
  assert.equal(replaceDocumentSearch(editor, "狗").replaced, 1);
  assert.equal(editor.state.doc.textContent, "狗 猫 猫");
  assert.deepEqual(documentSearchSnapshot(editor), { total: 2, activeIndex: 0 });
  replaceDocumentSearch(editor, "");
  assert.equal(editor.state.doc.textContent, "狗  猫");
  replaceDocumentSearch(editor, "🐟");
  assert.equal(editor.state.doc.textContent, "狗  🐟");
  assert.equal(documentSearchSnapshot(editor).total, 0);
  editor.commands.undo();
  assert.equal(editor.state.doc.textContent, "狗  猫");
  editor.destroy();
});

test("single replacement advances past the highlight cap before wrapping", () => {
  for (const replacement of ["CAT", "catcat", "cat"]) {
    const editor = createEditor([paragraph(text(Array(2001).fill("cat").join(" ")))]);
    setDocumentSearchQuery(editor, "cat");
    activateDocumentSearchMatch(editor, 1999);
    replaceDocumentSearch(editor, replacement);
    const expectedIndex = replacement === "catcat" ? 2001 : 2000;
    assert.equal(documentSearchSnapshot(editor).activeIndex, expectedIndex);
    assert.equal(documentSearchSnapshot(editor).total, expectedIndex + 1);
    assert.equal(editor.view.dom.querySelector(".kn-page-search-current")?.getAttribute("data-page-search-index"), String(expectedIndex));
    assert.ok(editor.view.dom.querySelectorAll(".kn-page-search-match").length <= 2000);
    replaceDocumentSearch(editor, "dog");
    assert.ok(editor.state.doc.textContent.endsWith(`${replacement} dog`));
    assert.equal(documentSearchSnapshot(editor).activeIndex, 0);
    editor.commands.undo();
    assert.ok(editor.state.doc.textContent.endsWith(`${replacement} cat`));
    editor.commands.redo();
    assert.ok(editor.state.doc.textContent.endsWith(`${replacement} dog`));
    editor.destroy();
  }
});

test("every search result is navigable while only a bounded window is highlighted", () => {
  const editor = createEditor([paragraph(text(Array(4005).fill("cat").join(" ")))]);
  assert.equal(setDocumentSearchQuery(editor, "cat").total, 4005);
  for (const index of [0, 1999, 2000, 3999, 4000, 4004, 0]) {
    assert.equal(activateDocumentSearchMatch(editor, index).activeIndex, index);
    const current = editor.view.dom.querySelector(".kn-page-search-current");
    assert.equal(current?.getAttribute("data-page-search-index"), String(index));
    assert.equal(current?.textContent, "cat");
    assert.ok(editor.view.dom.querySelectorAll(".kn-page-search-match").length <= 2000);
  }
  editor.destroy();
});

test("replace all includes matches beyond the highlight cap and is one undo step", () => {
  const original = Array(2005).fill("cat").join(" ");
  const editor = createEditor([paragraph(text(original))]);
  assert.equal(setDocumentSearchQuery(editor, "cat").total, 2005);
  assert.equal(replaceDocumentSearch(editor, "小猫", true).replaced, 2005);
  assert.equal(editor.state.doc.textContent, Array(2005).fill("小猫").join(" "));
  assert.equal(undoDepth(editor.state), 1);
  editor.commands.undo();
  assert.equal(editor.state.doc.textContent, original);
  editor.commands.redo();
  assert.equal(editor.state.doc.textContent, Array(2005).fill("小猫").join(" "));
  editor.destroy();
});

test("replacement containing the query runs once over original matches", () => {
  const editor = createEditor([paragraph(text("cat cat"))]);
  setDocumentSearchQuery(editor, "cat");
  replaceDocumentSearch(editor, "catcat");
  assert.equal(editor.state.doc.textContent, "catcat cat");
  assert.equal(documentSearchSnapshot(editor).activeIndex, 2);
  assert.equal(replaceDocumentSearch(editor, "catcat", true).replaced, 3);
  assert.equal(editor.state.doc.textContent, "catcatcatcat catcat");
  editor.destroy();
});

test("cross-mark matching preserves surrounding formatting and the starting mark", () => {
  const editor = createEditor([paragraph(
    text("before ", [{ type: "italic" }]),
    text("foo", [{ type: "bold" }]),
    text("bar", [{ type: "italic" }]),
    text(" after", [{ type: "link", attrs: { href: "https://example.com/foobar" } }]),
  )]);
  const original = editor.getJSON();
  assert.equal(setDocumentSearchQuery(editor, "foobar").total, 1);
  replaceDocumentSearch(editor, "baz");
  const content = editor.getJSON().content[0].content;
  assert.equal(content[1].text, "baz");
  assert.deepEqual(content[1].marks, [{ type: "bold" }]);
  assert.equal(content[0].marks[0].type, "italic");
  assert.equal(content[2].marks[0].attrs.href, "https://example.com/foobar");
  editor.commands.undo();
  assert.deepEqual(editor.getJSON(), original);
  editor.destroy();
});

test("headings, lists, code and table cells retain their structure", () => {
  const content = [
    { type: "heading", attrs: { level: 2 }, content: [text("cat")] },
    { type: "bulletList", content: [{ type: "listItem", content: [paragraph(text("cat"))] }] },
    { type: "codeBlock", content: [text("cat")] },
    { type: "table", content: [{ type: "tableRow", content: [{ type: "tableCell", content: [paragraph(text("cat"))] }] }] },
  ];
  const editor = createEditor(content);
  const original = editor.getJSON();
  setDocumentSearchQuery(editor, "CAT");
  assert.equal(replaceDocumentSearch(editor, "dog", true).replaced, 4);
  assert.equal(JSON.stringify(editor.getJSON()), JSON.stringify(original).replaceAll('"cat"', '"dog"'));
  editor.destroy();
});

test("matches never bridge hard breaks or block boundaries", () => {
  const editor = createEditor([paragraph(text("foo"), { type: "hardBreak" }, text("bar")), paragraph(text("foo")), paragraph(text("bar"))]);
  const original = editor.getJSON();
  assert.equal(setDocumentSearchQuery(editor, "foobar").total, 0);
  assert.equal(replaceDocumentSearch(editor, "bad", true).replaced, 0);
  assert.equal(setDocumentSearchQuery(editor, "foo\u0000bar").total, 0);
  assert.deepEqual(editor.getJSON(), original);
  editor.destroy();
});

test("literal whitespace, regexp characters and dollar signs stay literal", () => {
  const editor = createEditor([paragraph(text("a+b a.b a+b"))]);
  setDocumentSearchQuery(editor, "a+b");
  replaceDocumentSearch(editor, "$&", true);
  assert.equal(editor.state.doc.textContent, "$& a.b $&");
  setDocumentSearchQuery(editor, " ");
  replaceDocumentSearch(editor, "", true);
  assert.equal(editor.state.doc.textContent, "$&a.b$&");
  editor.destroy();
});

test("replacement wraps after the selected last match and uses fresh document ranges", () => {
  const editor = createEditor([paragraph(text("cat cat cat"))]);
  setDocumentSearchQuery(editor, "cat");
  activateDocumentSearchMatch(editor, 2);
  replaceDocumentSearch(editor, "dog");
  assert.equal(editor.state.doc.textContent, "cat cat dog");
  assert.equal(documentSearchSnapshot(editor).activeIndex, 0);
  editor.commands.insertContentAt(1, "prefix ");
  replaceDocumentSearch(editor, "fox");
  assert.equal(editor.state.doc.textContent, "prefix fox cat dog");
  editor.destroy();
});

test("read-only, no-match and no-op replacements do not alter content or history", () => {
  const editor = createEditor([paragraph(text("foo", [{ type: "bold" }]), text("bar"))]);
  const original = editor.getJSON();
  assert.equal(replaceDocumentSearch(editor, "x", true).replaced, 0);
  setDocumentSearchQuery(editor, "foobar");
  replaceDocumentSearch(editor, "foobar", true);
  assert.deepEqual(editor.getJSON(), original);
  assert.equal(undoDepth(editor.state), 0);
  editor.setEditable(false);
  assert.equal(replaceDocumentSearch(editor, "x", true).replaced, 0);
  assert.deepEqual(editor.getJSON(), original);
  editor.destroy();
});

test("typing before and after replacement has separate undo entries", () => {
  const editor = createEditor([paragraph(text("cat"))]);
  editor.commands.insertContentAt(4, "!");
  setDocumentSearchQuery(editor, "cat");
  replaceDocumentSearch(editor, "dog", true);
  editor.commands.insertContentAt(5, "?");
  editor.commands.undo();
  assert.equal(editor.state.doc.textContent, "dog!");
  editor.commands.undo();
  assert.equal(editor.state.doc.textContent, "cat!");
  editor.commands.undo();
  assert.equal(editor.state.doc.textContent, "cat");
  editor.destroy();
});

test("10,000 replacements stay bounded and preserve untouched selections and decorations", () => {
  const count = 10000;
  const original = Array(count).fill("cat keep").join(" ");
  const editor = createEditor([paragraph(text(original))]);
  const from = original.indexOf("keep", original.length / 2) + 1;
  editor.commands.setTextSelection({ from, to: from + 4 });
  const originalDoc = editor.state.doc;
  const decorations = DecorationSet.create(originalDoc, [Decoration.inline(from, from + 4, { class: "keep" })]);
  setDocumentSearchQuery(editor, "cat");
  const changed = [];
  editor.on("transaction", ({ transaction }) => {
    if (transaction.docChanged) changed.push(transaction);
  });
  const started = performance.now();
  assert.equal(replaceDocumentSearch(editor, "kitten", true).replaced, count);
  const elapsed = performance.now() - started;
  assert.equal(editor.state.doc.textContent, original.replaceAll("cat", "kitten"));
  assert.equal(changed.length, 1);
  // A structural bound catches the quadratic implementation without a flaky wall-clock threshold.
  assert.ok(changed[0].steps.length <= 2, "bulk replacement must not create a step per match");
  assert.equal(editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to), "keep");
  assert.equal(changed[0].mapping.mapResult(from).deleted, false);
  const mapped = decorations.map(changed[0].mapping, editor.state.doc).find();
  assert.equal(mapped.length, 1);
  assert.equal(editor.state.doc.textBetween(mapped[0].from, mapped[0].to), "keep");
  const restoredStep = Step.fromJSON(editor.schema, changed[0].steps[0].toJSON());
  assert.ok(restoredStep.apply(originalDoc).doc.eq(editor.state.doc));
  assert.equal(undoDepth(editor.state), 1);
  editor.commands.undo();
  assert.equal(editor.state.doc.textContent, original);
  assert.equal(editor.state.selection.from, from);
  editor.commands.redo();
  assert.equal(editor.state.doc.textContent, original.replaceAll("cat", "kitten"));
  console.log(`10,000 replacements: ${Math.round(elapsed)} ms`);
  editor.destroy();
});

test("bulk replacements retain mixed marks, atoms, empty blocks and untouched content", () => {
  const editor = createEditor([
    paragraph(text("cat", [{ type: "bold" }]), text(" KEEP ", [{ type: "italic" }]), text("c", [{ type: "code" }]), text("at"), { type: "hardBreak" }, text("cat", [{ type: "link", attrs: { href: "https://example.com" } }])),
    paragraph(),
    paragraph(text("Cat cat untouched")),
  ]);
  const original = editor.getJSON();
  setDocumentSearchQuery(editor, "cat");
  assert.equal(replaceDocumentSearch(editor, "🐈", true).replaced, 5);
  const content = editor.getJSON().content[0].content;
  assert.equal(content[0].text, "🐈");
  assert.deepEqual(content[0].marks, [{ type: "bold" }]);
  assert.deepEqual(content[1], original.content[0].content[1]);
  assert.deepEqual(content[2], { type: "text", marks: [{ type: "code" }], text: "🐈" });
  assert.deepEqual(content[3], { type: "hardBreak" });
  assert.equal(content[4].marks[0].attrs.href, "https://example.com");
  assert.equal(editor.getJSON().content[1].type, "paragraph");
  assert.equal(editor.getJSON().content[2].content[0].text, "🐈 🐈 untouched");
  editor.commands.undo();
  assert.deepEqual(editor.getJSON(), original);
  editor.commands.redo();
  assert.equal(editor.state.doc.textContent, "🐈 KEEP 🐈🐈🐈 🐈 untouched");
  editor.destroy();
});

test("bulk deletion and history remapping keep changes made outside history", () => {
  const editor = createEditor([paragraph(text("cat KEEP cat")), paragraph(text("cat"))]);
  setDocumentSearchQuery(editor, "cat");
  replaceDocumentSearch(editor, "", true);
  assert.equal(editor.state.doc.textContent, " KEEP ");
  editor.view.dispatch(editor.state.tr.insertText("prefix ", 1).setMeta("addToHistory", false));
  editor.commands.undo();
  assert.equal(editor.state.doc.textContent, "prefix cat KEEP catcat");
  editor.commands.redo();
  assert.equal(editor.state.doc.textContent, "prefix  KEEP ");
  editor.destroy();
});

test("undoing adjacent replacements preserves untouched highlights and inverse position maps", () => {
  for (const replacement of ["", "x", "kitten", "catcat"]) {
    for (const original of ["catcatKEEP", "KEEPcatcat", "catcatKEEPcatcat", "catcatKEEP catcat END"]) {
      const editor = createEditor([paragraph(text(original))]);
      let change;
      editor.on("transaction", ({ transaction }) => {
        if (transaction.docChanged) change = transaction;
      });
      setDocumentSearchQuery(editor, "cat");
      replaceDocumentSearch(editor, replacement, true);
      const deletion = change;
      const keptFrom = editor.state.doc.textContent.indexOf("KEEP") + 1;
      const decorations = DecorationSet.create(editor.state.doc, [Decoration.inline(keptFrom, keptFrom + 4, { class: "keep" })]);
      const step = deletion.steps[0];
      const inverse = step.invert(deletion.docs[0]);
      const expectedInverseMap = step.getMap().invert();
      const actualInverseMap = Step.fromJSON(editor.schema, inverse.toJSON()).getMap();
      for (let position = 0; position <= editor.state.doc.content.size; position++) {
        for (const assoc of [-1, 1]) {
          assert.equal(actualInverseMap.map(position, assoc), expectedInverseMap.map(position, assoc));
        }
      }
      // History uses mirrored maps to recover positions inside replaced ranges.
      const roundTrip = new Mapping();
      roundTrip.appendMap(step.getMap());
      roundTrip.appendMap(actualInverseMap, 0);
      for (let position = 0; position <= deletion.docs[0].content.size; position++) {
        assert.equal(roundTrip.map(position), position);
      }
      for (let cycle = 0; cycle < 2; cycle++) {
        editor.commands.undo();
        assert.equal(editor.state.doc.textContent, original);
        const mapped = decorations.map(change.mapping, editor.state.doc).find();
        assert.equal(mapped.length, 1);
        assert.equal(editor.state.doc.textBetween(mapped[0].from, mapped[0].to), "KEEP");
        assert.equal(mapped[0].from, original.indexOf("KEEP") + 1);
        editor.commands.redo();
        assert.equal(editor.state.doc.textContent, original.replaceAll("cat", replacement));
      }
      editor.destroy();
    }
  }
});

test("single and bulk replacement stay literal through undo, redo and serialization", () => {
  for (const all of [false, true]) {
    const editor = createEditor([paragraph(text("cat cat "))]);
    const original = editor.getJSON();
    setDocumentSearchQuery(editor, "cat");
    let change;
    editor.on("transaction", ({ transaction }) => {
      if (transaction.docChanged) change = transaction;
    });
    replaceDocumentSearch(editor, "https://example.com ", all);
    const replaced = editor.getJSON();
    assert.deepEqual(replaced.content[0].content, [text(all ? "https://example.com  https://example.com  " : "https://example.com  cat ")]);
    const serialized = change.steps[0].toJSON();
    for (let cycle = 0; cycle < 2; cycle++) {
      editor.commands.undo();
      assert.deepEqual(editor.getJSON(), original);
      editor.commands.redo();
      assert.deepEqual(editor.getJSON(), replaced);
    }
    editor.commands.undo();
    editor.view.dispatch(editor.state.tr.step(Step.fromJSON(editor.schema, serialized)));
    assert.deepEqual(editor.getJSON(), replaced);
    editor.destroy();
  }
});

test("undo restores literal URLs while subsequent normal typing still creates links", () => {
  for (const all of [false, true]) {
    const editor = createEditor([paragraph(text("https://example.com https://example.com "))]);
    const original = editor.getJSON();
    setDocumentSearchQuery(editor, "https://example.com");
    replaceDocumentSearch(editor, "cat ", all);
    editor.commands.undo();
    assert.deepEqual(editor.getJSON(), original);
    editor.commands.redo();
    editor.commands.insertContentAt(1, "https://other.example.com ");
    assert.equal(editor.getJSON().content[0].content[0].marks[0].type, "link");
    assert.equal(editor.getJSON().content[0].content[0].marks[0].attrs.href, "https://other.example.com");
    editor.destroy();
  }
});

test("undo and redo preserve edits in the gap between adjacent replacement groups", () => {
  const original = "catcatKEEPcatcat";
  for (const replacement of ["", "x", "kitten"]) {
    for (let offset = 1; offset < 4; offset++) {
      const editor = createEditor([paragraph(text(original))]);
      setDocumentSearchQuery(editor, "cat");
      replaceDocumentSearch(editor, replacement, true);
      const from = editor.state.doc.textContent.indexOf("KEEP") + 1 + offset;
      editor.view.dispatch(editor.state.tr.insertText("!", from).setMeta("addToHistory", false));
      const kept = "KEEP".slice(0, offset) + "!" + "KEEP".slice(offset);
      for (let cycle = 0; cycle < 2; cycle++) {
        editor.commands.undo();
        assert.equal(editor.state.doc.textContent, `catcat${kept}catcat`);
        editor.commands.redo();
        assert.equal(editor.state.doc.textContent, `${replacement.repeat(2)}${kept}${replacement.repeat(2)}`);
      }
      editor.destroy();
    }
  }
});

test("deleting the entire gap outside history keeps mirrored selection recovery valid", () => {
  const original = "catcatKEEPcatcat";
  for (const replacement of ["", "x", "longer"]) {
    for (const cursor of [2, 5, 12, 15, 17]) {
      const editor = createEditor([paragraph(text(original))]);
      editor.commands.setTextSelection(cursor);
      setDocumentSearchQuery(editor, "cat");
      replaceDocumentSearch(editor, replacement, true);
      const from = editor.state.doc.textContent.indexOf("KEEP") + 1;
      editor.view.dispatch(editor.state.tr.delete(from, from + 4).setMeta("addToHistory", false));
      for (let cycle = 0; cycle < 2; cycle++) {
        editor.commands.undo();
        assert.equal(editor.state.doc.textContent, "catcatcatcat");
        assert.equal(editor.state.selection.from, cursor < 7 ? cursor : cursor - 4);
        editor.commands.redo();
        assert.equal(editor.state.doc.textContent, replacement.repeat(4));
      }
      editor.destroy();
    }
  }
});

test("removing an earlier replacement outside history does not shift recovery indexes", () => {
  const editor = createEditor([paragraph(text("P cat KEEP cat"))]);
  editor.commands.setTextSelection(13);
  setDocumentSearchQuery(editor, "cat");
  replaceDocumentSearch(editor, "dog", true);
  editor.view.dispatch(editor.state.tr.delete(1, 8).setMeta("addToHistory", false));
  for (let cycle = 0; cycle < 2; cycle++) {
    editor.commands.undo();
    assert.equal(editor.state.doc.textContent, "EEP cat");
    assert.equal(editor.state.selection.from, 6);
    editor.commands.redo();
    assert.equal(editor.state.doc.textContent, "EEP dog");
  }
  editor.destroy();
});

test("non-touching batch maps retain ProseMirror mapping flags and recovery encoding", () => {
  const original = "cat x cat y cat";
  for (const replacement of ["", "x", "kitten"]) {
    const editor = createEditor([paragraph(text(original))]);
    let change;
    editor.on("transaction", ({ transaction }) => {
      if (transaction.docChanged) change = transaction;
    });
    setDocumentSearchQuery(editor, "cat");
    replaceDocumentSearch(editor, replacement, true);
    const actual = change.steps[0].getMap();
    const standard = new StepMap([...original.matchAll(/cat/g)].flatMap((match) => [match.index + 1, 3, replacement.length]));
    for (const [a, b, size] of [[actual, standard, change.docs[0].content.size], [actual.invert(), standard.invert(), editor.state.doc.content.size]]) {
      for (let position = 0; position <= size; position++) {
        for (const assoc of [-1, 1]) {
          assert.deepEqual(a.mapResult(position, assoc), b.mapResult(position, assoc));
        }
      }
    }
    editor.destroy();
  }
});

test("undoing adjacent deletions across batches keeps the trailing highlight exact", () => {
  const original = "cat".repeat(20000) + "KEEP";
  const editor = createEditor([paragraph(text(original))]);
  let change;
  editor.on("transaction", ({ transaction }) => {
    if (transaction.docChanged) change = transaction;
  });
  setDocumentSearchQuery(editor, "cat");
  replaceDocumentSearch(editor, "", true);
  assert.equal(editor.state.doc.textContent, "KEEP");
  assert.ok(change.steps.length > 1);
  const decorations = DecorationSet.create(editor.state.doc, [Decoration.inline(1, 5, { class: "keep" })]);
  editor.commands.undo();
  assert.equal(editor.state.doc.textContent, original);
  const mapped = decorations.map(change.mapping, editor.state.doc).find();
  assert.equal(mapped.length, 1);
  assert.equal(mapped[0].from, original.indexOf("KEEP") + 1);
  assert.equal(editor.state.doc.textBetween(mapped[0].from, mapped[0].to), "KEEP");
  editor.commands.redo();
  assert.equal(editor.state.doc.textContent, "KEEP");
  editor.destroy();
});

test("replacement across batch boundaries remains a single undoable operation", () => {
  const count = 20000;
  const original = "cat ".repeat(count);
  const editor = createEditor([paragraph(text(original))]);
  setDocumentSearchQuery(editor, "cat");
  const changed = [];
  editor.on("transaction", ({ transaction }) => {
    if (transaction.docChanged) changed.push(transaction);
  });
  assert.equal(replaceDocumentSearch(editor, "kitten", true).replaced, count);
  assert.equal(editor.state.doc.textContent, "kitten ".repeat(count));
  assert.equal(changed.length, 1);
  assert.ok(changed[0].steps.length < 10);
  assert.equal(undoDepth(editor.state), 1);
  editor.commands.undo();
  assert.equal(editor.state.doc.textContent, original);
  editor.commands.redo();
  assert.equal(editor.state.doc.textContent, "kitten ".repeat(count));
  editor.destroy();
});
