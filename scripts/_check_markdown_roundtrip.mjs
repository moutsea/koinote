import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";

const { window: baseWindow } = parseHTML(
  "<html><head></head><body></body></html>",
);
const NativeDOMParser = baseWindow.DOMParser;

// tiptap-markdown parses fragments as a root <body>. Browsers expose that body
// through document.body; linkedom needs the surrounding <html> in this test.
class FragmentDOMParser extends NativeDOMParser {
  parseFromString(value, type) {
    return super.parseFromString(`<html>${value}</html>`, type);
  }
}

const testWindow = Object.create(baseWindow);
Object.defineProperty(testWindow, "DOMParser", { value: FragmentDOMParser });
globalThis.window = testWindow;
globalThis.document = baseWindow.document;
globalThis.Node = baseWindow.Node;
globalThis.requestAnimationFrame = (callback) => {
  callback(0);
  return 0;
};

const [
  { Editor },
  { default: StarterKit },
  { TableCell, TableHeader, TableRow },
  { CellSelection, tableEditingKey },
  { EditorState, TextSelection },
  { Fragment },
  { closeHistory },
  { Markdown },
  { MarkdownTable, shouldDelegateTableMouseDown },
  { BlockMarkdownImage, normalizeLegacyImageAdjacentHeadings },
  {
    clearSelectedTableCells,
    clearTableAxis,
    hasTableHeaderRow,
    insertTableMatrix,
    resizeTable,
    selectCurrentTableColumn,
    selectCurrentTableRow,
    setTableColumnAlignment,
    shouldInterceptTablePaste,
    tableDimensions,
    tableMatrixFromClipboard,
    tableResizeLosesContent,
    tableSelectionToMarkdown,
  },
] = await Promise.all([
  import("@tiptap/core"),
  import("@tiptap/starter-kit"),
  import("@tiptap/extension-table"),
  import("@tiptap/pm/tables"),
  import("@tiptap/pm/state"),
  import("@tiptap/pm/model"),
  import("@tiptap/pm/history"),
  import("tiptap-markdown"),
  import("./_markdown_table_bundle.mjs"),
  import("./_markdown_image_bundle.mjs"),
  import("./_table_actions_bundle.mjs"),
]);

function saveTwice(markdown) {
  const editor = new Editor({
    element: null,
    extensions: [
      StarterKit,
      MarkdownTable,
      TableRow,
      TableHeader,
      TableCell,
      BlockMarkdownImage,
      Markdown.configure({ html: false }),
    ],
  });
  editor.commands.setContent(markdown);
  const initialJSON = editor.getJSON();
  const first = editor.storage.markdown.getMarkdown();
  editor.commands.setContent(first);
  const secondJSON = editor.getJSON();
  const second = editor.storage.markdown.getMarkdown();
  editor.destroy();
  return { first, initialJSON, second, secondJSON };
}

function saveDocumentTwice(json) {
  const editor = new Editor({
    element: null,
    extensions: [
      StarterKit,
      MarkdownTable,
      TableRow,
      TableHeader,
      TableCell,
      BlockMarkdownImage,
      Markdown.configure({ html: false }),
    ],
  });
  editor.commands.setContent(json);
  const first = editor.storage.markdown.getMarkdown();
  const firstJSON = editor.getJSON();
  editor.commands.setContent(first);
  const second = editor.storage.markdown.getMarkdown();
  const secondJSON = editor.getJSON();
  editor.destroy();
  return { first, firstJSON, second, secondJSON };
}

function tableActionEditor(
  markdown = "| A | B |\n| --- | --- |\n| a1 | b1 |\n| a2 | b2 |",
) {
  const element = baseWindow.document.createElement("div");
  baseWindow.document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: [
      StarterKit,
      MarkdownTable,
      TableRow,
      TableHeader,
      TableCell,
      BlockMarkdownImage,
      Markdown.configure({ html: false }),
    ],
  });
  editor.view.scrollToSelection = () => {};
  editor.commands.setContent(markdown);
  return { editor, element };
}

function selectTableCell(editor, text) {
  let position = null;
  editor.state.doc.descendants((node, nodePosition) => {
    if (
      position === null &&
      (node.type.name === "tableCell" || node.type.name === "tableHeader") &&
      node.textContent === text
    ) {
      position = nodePosition;
    }
  });
  assert.notEqual(position, null);
  editor.commands.setTextSelection(position + 2);
}

function tableCellPosition(editor, text) {
  const positions = tableCellPositions(editor, text);
  assert.notEqual(positions.length, 0);
  return positions[0];
}

function tableCellPositions(editor, text) {
  const positions = [];
  editor.state.doc.descendants((node, nodePosition) => {
    const role = node.type.spec.tableRole;
    if (
      (role === "cell" || role === "header_cell") &&
      node.textContent === text
    ) {
      positions.push(nodePosition);
    }
  });
  return positions;
}

function tableCellPositionAt(editor, tableIndex, rowIndex, cellIndex) {
  let tableStart = 0;
  for (let index = 0; index < tableIndex; index += 1) {
    tableStart += editor.state.doc.child(index).nodeSize;
  }
  const table = editor.state.doc.child(tableIndex);
  let rowStart = tableStart + 1;
  for (let index = 0; index < rowIndex; index += 1) {
    rowStart += table.child(index).nodeSize;
  }
  const row = table.child(rowIndex);
  let cellStart = rowStart + 1;
  for (let index = 0; index < cellIndex; index += 1) {
    cellStart += row.child(index).nodeSize;
  }
  return cellStart;
}

function tableMouseEvent(type, clientX, clientY = 0) {
  const event = new baseWindow.Event(type, {
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperties(event, {
    button: { value: 0 },
    clientX: { value: clientX },
    clientY: { value: clientY },
    shiftKey: { value: false },
  });
  return event;
}

function tableMouseDownHandler(editor) {
  const tablePlugin = editor.state.plugins.find(
    (plugin) => plugin.spec.key === tableEditingKey,
  );
  assert.ok(tablePlugin);
  const handler = tablePlugin.props.handleDOMEvents?.mousedown;
  assert.equal(typeof handler, "function");
  return handler;
}

function stubTableCoordinates(editor, coordinates) {
  editor.view.posAtCoords = ({ left }) => {
    const position = coordinates.get(left);
    if (position === undefined) return null;
    return { inside: position + 1, pos: position + 1 };
  };
}

function typeText(editor, text) {
  for (const character of text) {
    const { from, to } = editor.state.selection;
    const handled = editor.view.someProp("handleTextInput", (handler) =>
      handler(editor.view, from, to, character),
    );
    if (!handled) {
      editor.view.dispatch(editor.state.tr.insertText(character, from, to));
    }
  }
}

function pressEnter(editor) {
  return editor.view.someProp("handleKeyDown", (handler) =>
    handler(editor.view, { key: "Enter" }),
  );
}

const extensionsSource = readFileSync(
  new URL("../spa/src/components/editor/extensions.ts", import.meta.url),
  "utf8",
);
const markdownEditorSource = readFileSync(
  new URL("../spa/src/components/editor/MarkdownEditor.tsx", import.meta.url),
  "utf8",
);
const markdownTableSource = readFileSync(
  new URL("../spa/src/components/editor/markdownTable.ts", import.meta.url),
  "utf8",
);
const editorToolbarSource = readFileSync(
  new URL("../spa/src/components/editor/EditorToolbar.tsx", import.meta.url),
  "utf8",
);
const tableContextToolbarSource = readFileSync(
  new URL("../spa/src/components/editor/TableContextToolbar.tsx", import.meta.url),
  "utf8",
);
assert.match(extensionsSource, /MarkdownTable/);
assert.match(
  extensionsSource,
  /MarkdownTable\.configure\([\s\S]*?\),\s*TableRow,\s*TableHeader,\s*TableCell,/,
);
assert.match(markdownEditorSource, /<TableContextToolbar editor=\{editor\} \/>/);
assert.match(editorToolbarSource, /useEditorState\(/);
assert.match(editorToolbarSource, /const tableActive[\s\S]*isActive\("table"\)/);
assert.match(
  markdownEditorSource,
  /const shouldIntercept = shouldInterceptTablePaste\([\s\S]*?\);\s*const matrix = shouldIntercept\s*\?\s*tableMatrixFromClipboard\(/,
);
assert.match(markdownEditorSource, /tableSelectionToMarkdown\(instance, slice\)/);
assert.match(tableContextToolbarSource, /const TABLE_RESIZE_PICKER_SIZE = 8/);
assert.match(tableContextToolbarSource, /role="grid" aria-label=\{t\.editor\.toolbar\.tableResize\}/);
assert.match(tableContextToolbarSource, /data-table-resize-row=\{row\}/);
assert.doesNotMatch(tableContextToolbarSource, /type="number"/);
assert.match(
  tableContextToolbarSource,
  /mountedRef\.current = true;[\s\S]*mountedRef\.current = false;/,
);
assert.match(
  editorToolbarSource,
  /tabIndex=\{row === selected\.rows && col === selected\.cols \? 0 : -1\}/,
);
assert.equal(shouldInterceptTablePaste("codeBlock"), false);
assert.equal(shouldInterceptTablePaste("paragraph"), true);
assert.equal(shouldDelegateTableMouseDown({ button: 0, shiftKey: false }), false);
assert.equal(shouldDelegateTableMouseDown({ button: 0, shiftKey: true }), true);
assert.equal(
  shouldDelegateTableMouseDown({ button: 0, shiftKey: false, ctrlKey: true }),
  true,
);
assert.equal(
  shouldDelegateTableMouseDown({ button: 0, shiftKey: false, metaKey: true }),
  true,
);
assert.match(markdownTableSource, /handleTableDragMouseDown\(view, mouseEvent\)/);
assert.match(markdownTableSource, /inSameTable\(anchorCell, headCell\)/);
assert.doesNotMatch(markdownTableSource, /headCell\.node\(-1\) !== anchorCell\.node\(-1\)/);
assert.match(markdownTableSource, /setMeta\(tableEditingKey, anchorCell\.pos\)/);
for (const command of [
  "addRowBefore",
  "addRowAfter",
  "addColumnBefore",
  "addColumnAfter",
  "deleteRow",
  "deleteColumn",
  "deleteTable",
  "toggleHeaderRow",
]) {
  assert.match(tableContextToolbarSource, new RegExp(`editor\\.commands\\.${command}\\(`));
}
for (const alignment of ["left", "center", "right"]) {
  assert.match(
    tableContextToolbarSource,
    new RegExp(`setTableColumnAlignment\\(editor, \"${alignment}\"\\)`),
  );
}

const headerOnlyTableElement = baseWindow.document.createElement("div");
baseWindow.document.body.appendChild(headerOnlyTableElement);
const headerOnlyTableEditor = new Editor({
  element: headerOnlyTableElement,
  extensions: [
    StarterKit,
    MarkdownTable,
    TableRow,
    TableHeader,
    TableCell,
    BlockMarkdownImage,
    Markdown.configure({ html: false }),
  ],
});
headerOnlyTableEditor.view.scrollToSelection = () => {};
typeText(headerOnlyTableEditor, "| col1 | col2 |");
assert.equal(pressEnter(headerOnlyTableEditor), true);
assert.equal(headerOnlyTableEditor.state.doc.firstChild.type.name, "table");
assert.deepEqual(
  headerOnlyTableEditor.state.doc.firstChild.firstChild.content.content.map(
    (cell) => cell.textContent,
  ),
  ["col1", "col2"],
);
assert.equal(
  headerOnlyTableEditor.state.selection.$from.node(-1).type.name,
  "tableCell",
);
headerOnlyTableEditor.destroy();
headerOnlyTableElement.remove();

const typedTableElement = baseWindow.document.createElement("div");
baseWindow.document.body.appendChild(typedTableElement);
const typedTableEditor = new Editor({
  element: typedTableElement,
  extensions: [
    StarterKit,
    MarkdownTable,
    TableRow,
    TableHeader,
    TableCell,
    BlockMarkdownImage,
    Markdown.configure({ html: false }),
  ],
});
typedTableEditor.view.scrollToSelection = () => {};
typeText(typedTableEditor, "| 姓名 | 年龄 |");
typedTableEditor.commands.splitBlock();
typeText(typedTableEditor, "| --- | --- |");
assert.equal(pressEnter(typedTableEditor), true);
assert.equal(typedTableEditor.state.doc.firstChild.type.name, "table");
assert.deepEqual(
  typedTableEditor.state.doc.firstChild.firstChild.content.content.map(
    (cell) => cell.textContent,
  ),
  ["姓名", "年龄"],
);
assert.equal(
  typedTableEditor.state.selection.$from.parent.type.name,
  "paragraph",
);
assert.equal(
  typedTableEditor.state.selection.$from.node(-1).type.name,
  "tableCell",
);
assert.equal(typedTableEditor.state.selection.$from.parent.textContent, "");
typedTableEditor.destroy();
typedTableElement.remove();

const midHeaderElement = baseWindow.document.createElement("div");
baseWindow.document.body.appendChild(midHeaderElement);
const midHeaderEditor = new Editor({
  element: midHeaderElement,
  extensions: [
    StarterKit,
    MarkdownTable,
    TableRow,
    TableHeader,
    TableCell,
    BlockMarkdownImage,
    Markdown.configure({ html: false }),
  ],
});
midHeaderEditor.view.scrollToSelection = () => {};
const midHeaderText = "| 姓名 | 年龄 | 这段说明本该留在下一行";
midHeaderEditor.commands.setContent(midHeaderText);
const midHeaderPrefix = "| 姓名 | 年龄 |";
midHeaderEditor.commands.setTextSelection(midHeaderPrefix.length + 1);
assert.equal(pressEnter(midHeaderEditor), true);
assert.deepEqual(
  Array.from({ length: midHeaderEditor.state.doc.childCount }, (_, index) =>
    midHeaderEditor.state.doc.child(index).textContent,
  ),
  [midHeaderPrefix, " 这段说明本该留在下一行"],
);
assert.equal(midHeaderEditor.state.doc.firstChild.type.name, "paragraph");
midHeaderEditor.destroy();
midHeaderElement.remove();

const nestedHeaderElement = baseWindow.document.createElement("div");
baseWindow.document.body.appendChild(nestedHeaderElement);
const nestedHeaderEditor = new Editor({
  element: nestedHeaderElement,
  extensions: [
    StarterKit,
    MarkdownTable,
    TableRow,
    TableHeader,
    TableCell,
    BlockMarkdownImage,
    Markdown.configure({ html: false }),
  ],
});
nestedHeaderEditor.view.scrollToSelection = () => {};
nestedHeaderEditor.commands.setContent("- | A | B |");
nestedHeaderEditor.commands.setTextSelection(
  nestedHeaderEditor.state.doc.content.size - 1,
);
assert.equal(pressEnter(nestedHeaderEditor), true);
let nestedHasTable = false;
nestedHeaderEditor.state.doc.descendants((node) => {
  if (node.type.name === "table") nestedHasTable = true;
});
assert.equal(nestedHasTable, false);
assert.equal(nestedHeaderEditor.state.doc.firstChild.type.name, "bulletList");
assert.match(nestedHeaderEditor.state.doc.textContent, /\| A \| B \|/);
nestedHeaderEditor.destroy();
nestedHeaderElement.remove();

const alignedInputElement = baseWindow.document.createElement("div");
baseWindow.document.body.appendChild(alignedInputElement);
const alignedInputEditor = new Editor({
  element: alignedInputElement,
  extensions: [
    StarterKit,
    MarkdownTable,
    TableRow,
    TableHeader,
    TableCell,
    BlockMarkdownImage,
    Markdown.configure({ html: false }),
  ],
});
alignedInputEditor.view.scrollToSelection = () => {};
typeText(alignedInputEditor, "| a | b |");
alignedInputEditor.commands.splitBlock();
typeText(alignedInputEditor, "| :-- | --: |");
assert.equal(pressEnter(alignedInputEditor), true);
assert.equal(alignedInputEditor.state.doc.firstChild.type.name, "table");
alignedInputEditor.destroy();
alignedInputElement.remove();

const duplicateInputElement = baseWindow.document.createElement("div");
baseWindow.document.body.appendChild(duplicateInputElement);
const duplicateInputEditor = new Editor({
  element: duplicateInputElement,
  extensions: [
    StarterKit,
    MarkdownTable,
    TableRow,
    TableHeader,
    TableCell,
    BlockMarkdownImage,
    Markdown.configure({ html: false }),
  ],
});
duplicateInputEditor.view.scrollToSelection = () => {};
const duplicateSchema = duplicateInputEditor.state.schema;
const paragraph = (text) =>
  duplicateSchema.nodes.paragraph.create(null, duplicateSchema.text(text));
const duplicatePrefix = paragraph("前置正文");
const duplicateHeader = paragraph("| a | b |");
const duplicateDelimiter = paragraph("| --- | --- |");
const duplicateMiddle = paragraph("重要正文不可丢");
const duplicateDoc = duplicateSchema.nodes.doc.create(
  null,
  Fragment.fromArray([
    duplicatePrefix,
    duplicateHeader,
    duplicateDelimiter,
    duplicateMiddle,
    duplicateHeader,
    duplicateDelimiter,
  ]),
);
let duplicateDelimiterOffset = 0;
duplicateDoc.forEach((node, offset, index) => {
  if (index === 5) duplicateDelimiterOffset = offset;
});
duplicateInputEditor.view.updateState(
  EditorState.create({
    doc: duplicateDoc,
    selection: TextSelection.create(
      duplicateDoc,
      duplicateDelimiterOffset + 1 + duplicateDelimiter.textContent.length,
    ),
    plugins: duplicateInputEditor.state.plugins,
  }),
);
assert.equal(duplicateInputEditor.state.doc.child(1), duplicateInputEditor.state.doc.child(4));
assert.equal(duplicateInputEditor.state.doc.child(2), duplicateInputEditor.state.doc.child(5));
assert.equal(pressEnter(duplicateInputEditor), true);
assert.deepEqual(
  Array.from({ length: duplicateInputEditor.state.doc.childCount }, (_, index) =>
    duplicateInputEditor.state.doc.child(index).type.name,
  ).slice(0, 5),
  ["paragraph", "paragraph", "paragraph", "paragraph", "table"],
);
assert.equal(duplicateInputEditor.state.doc.child(0).textContent, "前置正文");
assert.equal(duplicateInputEditor.state.doc.child(3).textContent, "重要正文不可丢");
duplicateInputEditor.destroy();
duplicateInputElement.remove();

const clearRowCase = tableActionEditor();
selectTableCell(clearRowCase.editor, "a2");
assert.equal(clearTableAxis(clearRowCase.editor, "row"), true);
assert.deepEqual(
  clearRowCase.editor.state.doc.firstChild.child(2).content.content.map(
    (cell) => cell.textContent,
  ),
  ["", ""],
);
assert.deepEqual(
  clearRowCase.editor.state.doc.firstChild.child(1).content.content.map(
    (cell) => cell.textContent,
  ),
  ["a1", "b1"],
);
clearRowCase.editor.destroy();
clearRowCase.element.remove();

const clearColumnCase = tableActionEditor();
selectTableCell(clearColumnCase.editor, "b2");
assert.equal(clearTableAxis(clearColumnCase.editor, "column"), true);
assert.deepEqual(
  clearColumnCase.editor.state.doc.firstChild.child(1).content.content.map(
    (cell) => cell.textContent,
  ),
  ["a1", ""],
);
assert.deepEqual(
  clearColumnCase.editor.state.doc.firstChild.child(2).content.content.map(
    (cell) => cell.textContent,
  ),
  ["a2", ""],
);
clearColumnCase.editor.destroy();
clearColumnCase.element.remove();

const headerStatusCase = tableActionEditor();
assert.equal(hasTableHeaderRow(headerStatusCase.editor), true);
headerStatusCase.editor.destroy();
headerStatusCase.element.remove();

const alignmentEditor = tableActionEditor();
selectTableCell(alignmentEditor.editor, "b2");
assert.equal(setTableColumnAlignment(alignmentEditor.editor, "center"), true);
assert.deepEqual(
  alignmentEditor.editor.state.doc.firstChild.content.content.map((row) =>
    row.content.content.map((cell) => cell.attrs.align),
  ),
  [
    [null, "center"],
    [null, "center"],
    [null, "center"],
  ],
);
assert.equal(
  alignmentEditor.editor.storage.markdown.getMarkdown(),
  "| A | B |\n| --- | :--: |\n| a1 | b1 |\n| a2 | b2 |\n",
);
alignmentEditor.editor.destroy();
alignmentEditor.element.remove();

const cellAlignmentEditor = tableActionEditor();
let alignedCellPosition = null;
cellAlignmentEditor.editor.state.doc.descendants((node, position) => {
  if (node.type.name === "tableCell" && node.textContent === "b2") {
    alignedCellPosition = position;
  }
});
assert.notEqual(alignedCellPosition, null);
cellAlignmentEditor.editor.view.dispatch(
  cellAlignmentEditor.editor.state.tr.setSelection(
    CellSelection.create(
      cellAlignmentEditor.editor.state.doc,
      alignedCellPosition,
    ),
  ),
);
assert.equal(setTableColumnAlignment(cellAlignmentEditor.editor, "right"), true);
assert.deepEqual(
  cellAlignmentEditor.editor.state.doc.firstChild.content.content.map((row) =>
    row.content.content.map((cell) => cell.attrs.align),
  ),
  [
    [null, "right"],
    [null, "right"],
    [null, "right"],
  ],
);
cellAlignmentEditor.editor.destroy();
cellAlignmentEditor.element.remove();

assert.deepEqual(
  tableMatrixFromClipboard("a\tb\n1\t2\n", null, baseWindow.document),
  [
    ["a", "b"],
    ["1", "2"],
  ],
);
for (const text of [
  "function f() {\n\tif (x) {\n\t\treturn 1;\n\t}\n}",
  "build:\n\tgo build ./...\n\ttest -x bin/app",
  "第一行\n\t续行内容",
  "single\trow",
]) {
  assert.equal(tableMatrixFromClipboard(text, null, baseWindow.document), null);
}
assert.equal(
  tableMatrixFromClipboard("普通\n多行\n文字", null, baseWindow.document),
  null,
);
assert.deepEqual(
  tableMatrixFromClipboard(
    "",
    "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>",
    baseWindow.document,
  ),
  [
    ["A", "B"],
    ["1", "2"],
  ],
);
assert.deepEqual(
  tableMatrixFromClipboard(
    "",
    "<table><tr><th colspan='2'>A</th></tr><tr><td>B</td><td>C</td></tr></table>",
    baseWindow.document,
  ),
  [
    ["A", ""],
    ["B", "C"],
  ],
);
assert.deepEqual(
  tableMatrixFromClipboard(
    "",
    "<table><tr><td>A</td><td>B</td></tr><tr><td>C</td></tr></table>",
    baseWindow.document,
  ),
  [
    ["A", "B"],
    ["C", ""],
  ],
);
assert.equal(
  tableMatrixFromClipboard(
    "",
    "<table><tr><td><img src='https://example.test/a.png'></td><td>B</td></tr></table>",
    baseWindow.document,
  ),
  null,
);
assert.equal(
  tableMatrixFromClipboard(
    "A\tB\n1\t2",
    "<table><tr><td><img src='https://example.test/a.png'></td><td>B</td></tr><tr><td>1</td><td>2</td></tr></table>",
    baseWindow.document,
  ),
  null,
);
assert.equal(
  tableMatrixFromClipboard(
    "标题\t说明\t备注\n\t续行一\n\t续行二",
    null,
    baseWindow.document,
  ),
  null,
);

const matrixPasteCase = tableActionEditor();
selectTableCell(matrixPasteCase.editor, "a1");
assert.equal(
  insertTableMatrix(matrixPasteCase.editor, [
    ["A", "B", "C"],
    ["1", "2", "3"],
    ["4", "5", "6"],
  ]),
  true,
);
assert.deepEqual(
  matrixPasteCase.editor.state.doc.firstChild.content.content.map((row) =>
    row.content.content.map((cell) => cell.textContent),
  ),
  [
    ["A", "B", ""],
    ["A", "B", "C"],
    ["1", "2", "3"],
    ["4", "5", "6"],
  ],
);
matrixPasteCase.editor.destroy();
matrixPasteCase.element.remove();

const singleRowTableCase = tableActionEditor("| A | B |\n| --- | --- |");
selectTableCell(singleRowTableCase.editor, "A");
assert.equal(singleRowTableCase.editor.state.doc.firstChild.childCount, 1);
assert.equal(
  insertTableMatrix(singleRowTableCase.editor, [["A", "B", "C"]]),
  true,
);
assert.deepEqual(
  singleRowTableCase.editor.state.doc.firstChild.firstChild.content.content.map(
    (cell) => cell.type.name,
  ),
  ["tableHeader", "tableHeader", "tableHeader"],
);
assert.equal(hasTableHeaderRow(singleRowTableCase.editor), true);
singleRowTableCase.editor.destroy();
singleRowTableCase.element.remove();

const matrixInsertElement = baseWindow.document.createElement("div");
baseWindow.document.body.appendChild(matrixInsertElement);
const matrixInsertEditor = new Editor({
  element: matrixInsertElement,
  extensions: [
    StarterKit,
    MarkdownTable,
    TableRow,
    TableHeader,
    TableCell,
    BlockMarkdownImage,
    Markdown.configure({ html: false }),
  ],
});
matrixInsertEditor.view.scrollToSelection = () => {};
assert.equal(
  insertTableMatrix(matrixInsertEditor, [
    ["A", "B"],
    ["1", "2"],
  ]),
  true,
);
assert.equal(matrixInsertEditor.state.doc.firstChild.type.name, "table");
assert.deepEqual(
  matrixInsertEditor.state.doc.firstChild.content.content.map((row) =>
    row.content.content.map((cell) => cell.textContent),
  ),
  [
    ["A", "B"],
    ["1", "2"],
  ],
);
matrixInsertEditor.destroy();
matrixInsertElement.remove();

const matrixUndoCase = tableActionEditor();
selectTableCell(matrixUndoCase.editor, "a1");
const matrixBeforePaste = matrixUndoCase.editor.storage.markdown.getMarkdown();
matrixUndoCase.editor.view.dispatch(closeHistory(matrixUndoCase.editor.state.tr));
assert.equal(
  insertTableMatrix(matrixUndoCase.editor, [
    ["A", "B", "C"],
    ["1", "2", "3"],
    ["4", "5", "6"],
  ]),
  true,
);
let matrixUndoCount = 0;
while (
  matrixUndoCase.editor.storage.markdown.getMarkdown() !== matrixBeforePaste &&
  matrixUndoCase.editor.commands.undo()
) {
  matrixUndoCount += 1;
}
assert.equal(matrixUndoCount, 1);
assert.equal(
  matrixUndoCase.editor.storage.markdown.getMarkdown(),
  matrixBeforePaste,
);
matrixUndoCase.editor.destroy();
matrixUndoCase.element.remove();

const cellSelectionCase = tableActionEditor();
let firstCellPosition = null;
let secondCellPosition = null;
let bottomRightCellPosition = null;
cellSelectionCase.editor.state.doc.descendants((node, position) => {
  if (node.type.name !== "tableCell") return;
  if (firstCellPosition === null && node.textContent === "a1") {
    firstCellPosition = position;
  } else if (secondCellPosition === null && node.textContent === "b1") {
    secondCellPosition = position;
  } else if (bottomRightCellPosition === null && node.textContent === "b2") {
    bottomRightCellPosition = position;
  }
});
assert.notEqual(firstCellPosition, null);
assert.notEqual(secondCellPosition, null);
assert.notEqual(bottomRightCellPosition, null);
cellSelectionCase.editor.view.dispatch(
  cellSelectionCase.editor.state.tr.setSelection(
    CellSelection.create(
      cellSelectionCase.editor.state.doc,
      firstCellPosition,
      secondCellPosition,
    ),
  ),
);
assert.equal(
  tableSelectionToMarkdown(
    cellSelectionCase.editor,
    cellSelectionCase.editor.state.selection.content(),
  ),
  "| a1 | b1 |\n| --- | --- |\n",
);
assert.equal(
  tableSelectionToMarkdown(cellSelectionCase.editor, {
    content: Fragment.fromArray([
      cellSelectionCase.editor.state.doc.firstChild,
      cellSelectionCase.editor.state.schema.nodes.paragraph.create(),
    ]),
  }),
  null,
);
cellSelectionCase.editor.view.dispatch(
  cellSelectionCase.editor.state.tr.setSelection(
    CellSelection.create(
      cellSelectionCase.editor.state.doc,
      firstCellPosition,
      bottomRightCellPosition,
    ),
  ),
);
assert.equal(
  tableSelectionToMarkdown(
    cellSelectionCase.editor,
    cellSelectionCase.editor.state.selection.content(),
  ),
  "| a1 | b1 |\n| --- | --- |\n| a2 | b2 |\n",
);
cellSelectionCase.editor.view.dispatch(
  cellSelectionCase.editor.state.tr.setSelection(
    CellSelection.create(
      cellSelectionCase.editor.state.doc,
      firstCellPosition,
      secondCellPosition,
    ),
  ),
);
assert.equal(clearSelectedTableCells(cellSelectionCase.editor), true);
assert.deepEqual(
  cellSelectionCase.editor.state.doc.firstChild.child(1).content.content.map(
    (cell) => cell.textContent,
  ),
  ["", ""],
);
cellSelectionCase.editor.destroy();
cellSelectionCase.element.remove();

const axisSelectionCase = tableActionEditor();
selectTableCell(axisSelectionCase.editor, "a2");
assert.equal(selectCurrentTableRow(axisSelectionCase.editor), true);
assert.equal(axisSelectionCase.editor.state.selection instanceof CellSelection, true);
assert.equal(axisSelectionCase.editor.state.selection.isRowSelection(), true);
selectTableCell(axisSelectionCase.editor, "b2");
assert.equal(selectCurrentTableColumn(axisSelectionCase.editor), true);
assert.equal(axisSelectionCase.editor.state.selection.isColSelection(), true);
axisSelectionCase.editor.destroy();
axisSelectionCase.element.remove();

const tableDragCase = tableActionEditor();
const tableDragA1 = tableCellPosition(tableDragCase.editor, "a1");
const tableDragB1 = tableCellPosition(tableDragCase.editor, "b1");
const tableDragB2 = tableCellPosition(tableDragCase.editor, "b2");
stubTableCoordinates(
  tableDragCase.editor,
  new Map([
    [1, tableDragA1],
    [2, tableDragB2],
    [3, tableDragB1],
  ]),
);
const tableDragView = tableDragCase.editor.view;
const tableDragMouseDown = tableMouseDownHandler(tableDragCase.editor);
assert.equal(
  tableDragMouseDown(tableDragView, tableMouseEvent("mousedown", 1)),
  false,
);
tableDragView.root.dispatchEvent(tableMouseEvent("mousemove", 2));
assert.equal(tableDragView.state.selection instanceof CellSelection, true);
const tableDragSelectedTexts = [];
tableDragView.state.selection.forEachCell((node) => {
  tableDragSelectedTexts.push(node.textContent);
});
assert.deepEqual(tableDragSelectedTexts, ["a1", "b1", "a2", "b2"]);
assert.notEqual(tableEditingKey.getState(tableDragView.state), null);
let postTableMouseupCalled = false;
const postTableMouseup = () => {
  postTableMouseupCalled = true;
};
tableDragView.root.addEventListener("mouseup", postTableMouseup);
tableDragView.root.dispatchEvent(tableMouseEvent("mouseup", 2));
assert.equal(postTableMouseupCalled, true);
tableDragView.root.removeEventListener("mouseup", postTableMouseup);
assert.equal(tableEditingKey.getState(tableDragView.state), null);
tableDragView.root.dispatchEvent(tableMouseEvent("mousemove", 3));
const tableDragSelectedAfterCleanup = [];
tableDragView.state.selection.forEachCell((node) => {
  tableDragSelectedAfterCleanup.push(node.textContent);
});
assert.deepEqual(tableDragSelectedAfterCleanup, tableDragSelectedTexts);
tableDragCase.editor.destroy();
tableDragCase.element.remove();

const tableDragGapCase = tableActionEditor();
const tableDragGapA1 = tableCellPosition(tableDragGapCase.editor, "a1");
const tableDragGapB2 = tableCellPosition(tableDragGapCase.editor, "b2");
stubTableCoordinates(
  tableDragGapCase.editor,
  new Map([
    [1, tableDragGapA1],
    [2, tableDragGapB2],
  ]),
);
const tableDragGapView = tableDragGapCase.editor.view;
const tableDragGapMouseDown = tableMouseDownHandler(tableDragGapCase.editor);
assert.equal(
  tableDragGapMouseDown(tableDragGapView, tableMouseEvent("mousedown", 1)),
  false,
);
tableDragGapView.root.dispatchEvent(tableMouseEvent("mousemove", 3));
tableDragGapView.root.dispatchEvent(tableMouseEvent("mousemove", 2));
assert.equal(tableDragGapView.state.selection instanceof CellSelection, true);
tableDragGapView.root.dispatchEvent(tableMouseEvent("mouseup", 2));
tableDragGapCase.editor.destroy();
tableDragGapCase.element.remove();

const tableDragDestroyCase = tableActionEditor();
const tableDragDestroyPosition = tableCellPosition(
  tableDragDestroyCase.editor,
  "a1",
);
let tableDragDestroyCalls = 0;
tableDragDestroyCase.editor.view.posAtCoords = () => {
  tableDragDestroyCalls += 1;
  return { inside: tableDragDestroyPosition + 1, pos: tableDragDestroyPosition + 1 };
};
const tableDragDestroyView = tableDragDestroyCase.editor.view;
const tableDragDestroyMouseDown = tableMouseDownHandler(tableDragDestroyCase.editor);
const originalDestroyRootRemove = tableDragDestroyView.root.removeEventListener;
const destroyRemovedTypes = [];
tableDragDestroyView.root.removeEventListener = function (type, listener, options) {
  destroyRemovedTypes.push(type);
  return originalDestroyRootRemove.call(this, type, listener, options);
};
assert.equal(
  tableDragDestroyMouseDown(
    tableDragDestroyView,
    tableMouseEvent("mousedown", 1),
  ),
  false,
);
const callsBeforeDestroy = tableDragDestroyCalls;
tableDragDestroyCase.editor.destroy();
tableDragDestroyView.root.removeEventListener = originalDestroyRootRemove;
for (const type of ["mousemove", "mouseup", "dragstart"]) {
  assert.equal(destroyRemovedTypes.includes(type), true);
}
assert.doesNotThrow(() => {
  tableDragDestroyView.root.dispatchEvent(tableMouseEvent("mousemove", 2));
});
assert.equal(tableDragDestroyCalls, callsBeforeDestroy);
tableDragDestroyCase.element.remove();

const sameCellDragCase = tableActionEditor();
const sameCellPosition = tableCellPosition(sameCellDragCase.editor, "a1");
stubTableCoordinates(sameCellDragCase.editor, new Map([[1, sameCellPosition]]));
const sameCellView = sameCellDragCase.editor.view;
const sameCellMouseDown = tableMouseDownHandler(sameCellDragCase.editor);
assert.equal(
  sameCellMouseDown(sameCellView, tableMouseEvent("mousedown", 1)),
  false,
);
sameCellView.root.dispatchEvent(tableMouseEvent("mousemove", 1));
assert.equal(sameCellView.state.selection instanceof CellSelection, false);
sameCellView.root.dispatchEvent(tableMouseEvent("mouseup", 1));
sameCellDragCase.editor.destroy();
sameCellDragCase.element.remove();

const crossTableDragCase = tableActionEditor();
const sharedTableNode = crossTableDragCase.editor.state.doc.firstChild;
assert.ok(sharedTableNode);
crossTableDragCase.editor.view.dispatch(
  crossTableDragCase.editor.state.tr.insert(
    crossTableDragCase.editor.state.doc.content.size,
    sharedTableNode,
  ),
);
const crossTableA1 = tableCellPositionAt(crossTableDragCase.editor, 0, 1, 0);
const crossTableSecondA1 = tableCellPositionAt(crossTableDragCase.editor, 2, 1, 0);
assert.equal(
  crossTableDragCase.editor.state.doc.child(0),
  crossTableDragCase.editor.state.doc.child(2),
);
stubTableCoordinates(
  crossTableDragCase.editor,
  new Map([
    [1, crossTableA1],
    [2, crossTableSecondA1],
  ]),
);
const crossTableView = crossTableDragCase.editor.view;
const crossTableMouseDown = tableMouseDownHandler(crossTableDragCase.editor);
assert.equal(
  crossTableMouseDown(crossTableView, tableMouseEvent("mousedown", 1)),
  false,
);
assert.doesNotThrow(() => {
  crossTableView.root.dispatchEvent(tableMouseEvent("mousemove", 2));
});
assert.equal(crossTableView.state.selection instanceof CellSelection, false);
crossTableDragCase.editor.destroy();
crossTableDragCase.element.remove();

const resizeTableCase = tableActionEditor();
selectTableCell(resizeTableCase.editor, "a1");
assert.deepEqual(tableDimensions(resizeTableCase.editor), { rows: 3, columns: 2 });
assert.equal(tableResizeLosesContent(resizeTableCase.editor, 4, 3), false);
assert.equal(resizeTable(resizeTableCase.editor, 4, 3), true);
assert.deepEqual(tableDimensions(resizeTableCase.editor), { rows: 4, columns: 3 });
assert.deepEqual(
  resizeTableCase.editor.state.doc.firstChild.content.content.map((row) =>
    row.content.content.map((cell) => cell.textContent),
  ),
  [
    ["A", "B", ""],
    ["a1", "b1", ""],
    ["a2", "b2", ""],
    ["", "", ""],
  ],
);
assert.deepEqual(
  resizeTableCase.editor.state.doc.firstChild.content.content.map((row) =>
    row.content.content.map((cell) => cell.type.name),
  ),
  [
    ["tableHeader", "tableHeader", "tableHeader"],
    ["tableCell", "tableCell", "tableCell"],
    ["tableCell", "tableCell", "tableCell"],
    ["tableCell", "tableCell", "tableCell"],
  ],
);
assert.equal(tableResizeLosesContent(resizeTableCase.editor, 3, 2), false);
assert.equal(tableResizeLosesContent(resizeTableCase.editor, 1, 1), true);
const resizeUndoBefore = resizeTableCase.editor.storage.markdown.getMarkdown();
resizeTableCase.editor.view.dispatch(closeHistory(resizeTableCase.editor.state.tr));
assert.equal(resizeTable(resizeTableCase.editor, 1, 1), true);
assert.deepEqual(tableDimensions(resizeTableCase.editor), { rows: 1, columns: 1 });
assert.equal(resizeTableCase.editor.state.doc.firstChild.textContent, "A");
let resizeUndoCount = 0;
while (
  resizeTableCase.editor.storage.markdown.getMarkdown() !== resizeUndoBefore &&
  resizeTableCase.editor.commands.undo()
) {
  resizeUndoCount += 1;
}
assert.equal(resizeUndoCount, 1);
resizeTableCase.editor.destroy();
resizeTableCase.element.remove();

const colspanResizeCase = tableActionEditor();
colspanResizeCase.editor.commands.setContent({
  type: "doc",
  content: [
    {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            {
              type: "tableHeader",
              attrs: { colspan: 2 },
              content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }],
            },
          ],
        },
        {
          type: "tableRow",
          content: [
            { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }] },
            { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "C" }] }] },
          ],
        },
      ],
    },
  ],
});
selectTableCell(colspanResizeCase.editor, "A");
assert.deepEqual(tableDimensions(colspanResizeCase.editor), { rows: 2, columns: 2 });
assert.equal(resizeTable(colspanResizeCase.editor, 2, 1), true);
assert.deepEqual(
  colspanResizeCase.editor.state.doc.firstChild.content.content.map((row) =>
    row.content.content.map((cell) => ({ type: cell.type.name, colspan: cell.attrs.colspan })),
  ),
  [
    [{ type: "tableHeader", colspan: 1 }],
    [{ type: "tableCell", colspan: 1 }],
  ],
);
colspanResizeCase.editor.destroy();
colspanResizeCase.element.remove();

const rowspanResizeCase = tableActionEditor();
rowspanResizeCase.editor.commands.setContent({
  type: "doc",
  content: [
    {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            {
              type: "tableHeader",
              attrs: { rowspan: 2 },
              content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }],
            },
            { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }] },
          ],
        },
        {
          type: "tableRow",
          content: [
            { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "C" }] }] },
          ],
        },
        {
          type: "tableRow",
          content: [
            { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "D" }] }] },
            { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "E" }] }] },
          ],
        },
      ],
    },
  ],
});
selectTableCell(rowspanResizeCase.editor, "A");
assert.deepEqual(tableDimensions(rowspanResizeCase.editor), { rows: 3, columns: 2 });
assert.equal(resizeTable(rowspanResizeCase.editor, 1, 2), true);
assert.deepEqual(
  rowspanResizeCase.editor.state.doc.firstChild.content.content.map((row) =>
    row.content.content.map((cell) => ({ text: cell.textContent, rowspan: cell.attrs.rowspan })),
  ),
  [[{ text: "A", rowspan: 1 }, { text: "B", rowspan: 1 }]],
);
rowspanResizeCase.editor.destroy();
rowspanResizeCase.element.remove();

const tableCase = saveTwice(
  "| 名称 | 数量 | 备注 |\n| :--- | ---: | :---: |\n| 铅笔 | 2 | 日常使用 |\n| 橡皮 | 1 | 备用 |");
assert.equal(
  tableCase.first,
  "| 名称 | 数量 | 备注 |\n| :-- | --: | :--: |\n| 铅笔 | 2 | 日常使用 |\n| 橡皮 | 1 | 备用 |\n",
);
assert.equal(tableCase.second, tableCase.first);
assert.deepEqual(tableCase.secondJSON.content.map((node) => node.type), ["table"]);
assert.deepEqual(
  tableCase.secondJSON.content[0].content[0].content.map((cell) => cell.type),
  ["tableHeader", "tableHeader", "tableHeader"],
);
assert.equal(
  tableCase.secondJSON.content[0].content[1].content[0].content[0].content[0].text,
  "铅笔",
);

const escapedPipeTable = saveTwice(
  "| 名称 | 说明 |\n| --- | --- |\n| 项目 | 含有 \\| 分隔符 |",
);
assert.match(escapedPipeTable.first, /含有 \\\| 分隔符/);
assert.equal(escapedPipeTable.second, escapedPipeTable.first);

const bodyAlignmentTable = saveDocumentTwice({
  type: "doc",
  content: [
    {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "左" }] }] },
            { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "中" }] }] },
            { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "右" }] }] },
          ],
        },
        {
          type: "tableRow",
          content: [
            { type: "tableCell", attrs: { align: "left" }, content: [{ type: "paragraph", content: [{ type: "text", text: "a" }] }] },
            { type: "tableCell", attrs: { align: "center" }, content: [{ type: "paragraph", content: [{ type: "text", text: "b" }] }] },
            { type: "tableCell", attrs: { align: "right" }, content: [{ type: "paragraph", content: [{ type: "text", text: "c" }] }] },
          ],
        },
      ],
    },
  ],
});
assert.match(bodyAlignmentTable.first, /\| :-- \| :--: \| --: \|/);
assert.equal(bodyAlignmentTable.second, bodyAlignmentTable.first);

const widthTable = saveDocumentTwice({
  type: "doc",
  content: [
    {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            { type: "tableHeader", attrs: { colwidth: [120] }, content: [{ type: "paragraph", content: [{ type: "text", text: "A" }] }] },
            { type: "tableHeader", attrs: { colwidth: [240] }, content: [{ type: "paragraph", content: [{ type: "text", text: "B" }] }] },
          ],
        },
        {
          type: "tableRow",
          content: [
            { type: "tableCell", attrs: { colwidth: [120] }, content: [{ type: "paragraph", content: [{ type: "text", text: "1" }] }] },
            { type: "tableCell", attrs: { colwidth: [240] }, content: [{ type: "paragraph", content: [{ type: "text", text: "2" }] }] },
          ],
        },
      ],
    },
  ],
});
assert.match(widthTable.first, /<!-- koinote-table-widths: 120,240 -->/);
assert.equal(widthTable.second, widthTable.first);
assert.deepEqual(
  widthTable.secondJSON.content[0].content[0].content.map(
    (cell) => cell.attrs.colwidth,
  ),
  [[120], [240]],
);

const invalidWidthTable = saveTwice(
  "<!-- koinote-table-widths: 20,5000 -->\n| A | B |\n| --- | --- |\n| 1 | 2 |",
);
assert.match(invalidWidthTable.first, /&lt;!-- koinote-table-widths: 20,5000 --&gt;/);
assert.equal(invalidWidthTable.second, invalidWidthTable.first);

function tableWithCellText(text) {
  return saveDocumentTwice({
    type: "doc",
    content: [
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              {
                type: "tableHeader",
                content: [{ type: "paragraph", content: [{ type: "text", text: "标题" }] }],
              },
              {
                type: "tableHeader",
                content: [{ type: "paragraph", content: [{ type: "text", text: "内容" }] }],
              },
            ],
          },
          {
            type: "tableRow",
            content: [
              {
                type: "tableCell",
                content: [{ type: "paragraph", content: [{ type: "text", text }] }],
              },
              {
                type: "tableCell",
                content: [{ type: "paragraph", content: [{ type: "text", text: "旁边" }] }],
              },
            ],
          },
        ],
      },
    ],
  });
}

for (const text of ["a|b", "a\\|b", "a\\\\|b"]) {
  const pipeCase = tableWithCellText(text);
  assert.equal(pipeCase.second, pipeCase.first);
  assert.equal(
    pipeCase.secondJSON.content[0].content[1].content[0].content[0].content[0].text,
    text,
  );
}

const complexTable = saveDocumentTwice({
  type: "doc",
  content: [
    {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            {
              type: "tableHeader",
              content: [{ type: "paragraph", content: [{ type: "text", text: "标题" }] }],
            },
            {
              type: "tableHeader",
              content: [{ type: "paragraph", content: [{ type: "text", text: "内容" }] }],
            },
          ],
        },
        {
          type: "tableRow",
          content: [
            {
              type: "tableCell",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "第一段" }] },
                { type: "paragraph", content: [{ type: "text", text: "第二段" }] },
              ],
            },
            {
              type: "tableCell",
              content: [
                {
                  type: "paragraph",
                  content: [
                    { type: "text", text: "上" },
                    { type: "hardBreak" },
                    { type: "text", text: "下" },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: "tableRow",
          content: [
            {
              type: "tableCell",
              content: [
                {
                  type: "image",
                  attrs: { src: "https://i.test/a.png", alt: "alt", title: null },
                },
              ],
            },
            {
              type: "tableCell",
              content: [{ type: "paragraph", content: [{ type: "text", text: "文本" }] }],
            },
          ],
        },
      ],
    },
  ],
});
assert.doesNotMatch(complexTable.first, /\[(?:table|hardBreak)\]/);
assert.match(complexTable.first, /第一段 第二段/);
assert.match(complexTable.first, /上 下/);
assert.match(complexTable.first, /!\[alt\]\(https:\/\/i\.test\/a\.png\)/);
assert.equal(complexTable.second, complexTable.first);

const colspanTable = saveDocumentTwice({
  type: "doc",
  content: [
    {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            {
              type: "tableHeader",
              attrs: { colspan: 2 },
              content: [{ type: "paragraph", content: [{ type: "text", text: "跨列标题" }] }],
            },
          ],
        },
        {
          type: "tableRow",
          content: [
            { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "左" }] }] },
            { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "右" }] }] },
          ],
        },
      ],
    },
  ],
});
assert.doesNotMatch(colspanTable.first, /\[table\]/);
assert.match(colspanTable.first, /跨列标题/);
assert.equal(colspanTable.second, colspanTable.first);

const rowspanTable = saveDocumentTwice({
  type: "doc",
  content: [
    {
      type: "table",
      content: [
        {
          type: "tableRow",
          content: [
            {
              type: "tableHeader",
              content: [{ type: "paragraph", content: [{ type: "text", text: "标题 1" }] }],
            },
            {
              type: "tableHeader",
              content: [{ type: "paragraph", content: [{ type: "text", text: "标题 2" }] }],
            },
          ],
        },
        {
          type: "tableRow",
          content: [
            {
              type: "tableCell",
              attrs: { rowspan: 2 },
              content: [{ type: "paragraph", content: [{ type: "text", text: "跨两行" }] }],
            },
            {
              type: "tableCell",
              content: [{ type: "paragraph", content: [{ type: "text", text: "b1" }] }],
            },
          ],
        },
        {
          type: "tableRow",
          content: [
            {
              type: "tableCell",
              content: [{ type: "paragraph", content: [{ type: "text", text: "b2" }] }],
            },
          ],
        },
      ],
    },
  ],
});
assert.match(rowspanTable.first, /\|  \| b2 \|/);
assert.equal(rowspanTable.second, rowspanTable.first);

const emptyHeaderTable = saveDocumentTwice({
  type: "doc",
  content: [
    {
      type: "table",
      content: [
        { type: "tableRow", content: [] },
        {
          type: "tableRow",
          content: [
            { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "左" }] }] },
            { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "右" }] }] },
          ],
        },
      ],
    },
  ],
});
assert.match(emptyHeaderTable.first, /^\|  \|  \|\n\| --- \| --- \|/);
assert.equal(emptyHeaderTable.second, emptyHeaderTable.first);

const headingCase = saveTwice("![](https://img.test/a.png)\n\n## 下载\n\n正文");
assert.equal(
  headingCase.first,
  "![](https://img.test/a.png)\n\n## 下载\n\n正文",
);
assert.equal(headingCase.second, headingCase.first);
assert.deepEqual(
  headingCase.secondJSON.content.map((node) => node.type),
  ["image", "heading", "paragraph"],
);
assert.equal(headingCase.secondJSON.content[1].attrs.level, 2);

const paragraphCase = saveTwice(
  '![备注](https://img.test/a\\(1\\).png "标题")\n\n图片后的正文',
);
assert.equal(
  paragraphCase.first,
  '![备注](https://img.test/a\\(1\\).png "标题")\n\n图片后的正文',
);
assert.equal(paragraphCase.second, paragraphCase.first);
assert.deepEqual(
  paragraphCase.secondJSON.content.map((node) => node.type),
  ["image", "paragraph"],
);

const consecutiveImages = saveTwice(
  "![](https://img.test/a.png)\n\n![](https://img.test/b.png)",
);
assert.equal(
  consecutiveImages.first,
  "![](https://img.test/a.png)\n\n![](https://img.test/b.png)",
);
assert.equal(consecutiveImages.second, consecutiveImages.first);
assert.deepEqual(
  consecutiveImages.secondJSON.content.map((node) => node.type),
  ["image", "image"],
);

const legacyBroken = [
  "![](https://img.test/a.png)",
  "",
  "\\## 下载",
  "",
  "正文",
].join("\n");
const legacyNormalized = normalizeLegacyImageAdjacentHeadings(legacyBroken);
assert.equal(
  legacyNormalized,
  "![](https://img.test/a.png)\n\n## 下载\n\n正文",
);
assert.equal(
  normalizeLegacyImageAdjacentHeadings(legacyNormalized),
  legacyNormalized,
);
const legacyRoundTrip = saveTwice(legacyNormalized);
assert.deepEqual(
  legacyRoundTrip.secondJSON.content.map((node) => node.type),
  ["image", "heading", "paragraph"],
);
assert.equal(legacyRoundTrip.secondJSON.content[1].attrs.level, 2);

// 生产数据里真实出现过的形状：旧序列化器把图片与转义标题直接粘在同一行。
// 修复时不只去掉反斜杠，还必须补回块间空行，否则 ## 仍不会被解析成标题。
const legacySameLine =
  "![](https://img.test/a.png)\\## 下载\n\n正文\n\n" +
  "![](https://img.test/b.png)\\## 上公网\n\n更多正文";
const legacySameLineNormalized =
  normalizeLegacyImageAdjacentHeadings(legacySameLine);
assert.equal(
  legacySameLineNormalized,
  "![](https://img.test/a.png)\n\n## 下载\n\n正文\n\n" +
    "![](https://img.test/b.png)\n\n## 上公网\n\n更多正文",
);
const legacySameLineRoundTrip = saveTwice(legacySameLineNormalized);
assert.deepEqual(
  legacySameLineRoundTrip.secondJSON.content.map((node) => node.type),
  ["image", "heading", "paragraph", "image", "heading", "paragraph"],
);
assert.equal(legacySameLineRoundTrip.secondJSON.content[1].attrs.level, 2);
assert.equal(legacySameLineRoundTrip.secondJSON.content[4].attrs.level, 2);

// 另一种历史形状没有反斜杠：图片与标题被序列化到同一行，Markdown
// 解析器会把整行当成图片地址的一部分。兼容层也要把它恢复成两个块。
const legacyUnescapedSameLine =
  "![](https://img.test/a.png)## 下载\n\n正文\n\n" +
  "![](https://img.test/b.png)## 上公网\n\n更多正文";
const legacyUnescapedNormalized = normalizeLegacyImageAdjacentHeadings(
  legacyUnescapedSameLine,
);
assert.equal(
  legacyUnescapedNormalized,
  "![](https://img.test/a.png)\n\n## 下载\n\n正文\n\n" +
    "![](https://img.test/b.png)\n\n## 上公网\n\n更多正文",
);
const legacyUnescapedRoundTrip = saveTwice(legacyUnescapedNormalized);
assert.deepEqual(
  legacyUnescapedRoundTrip.secondJSON.content.map((node) => node.type),
  ["image", "heading", "paragraph", "image", "heading", "paragraph"],
);
assert.equal(legacyUnescapedRoundTrip.secondJSON.content[1].attrs.level, 2);
assert.equal(legacyUnescapedRoundTrip.secondJSON.content[4].attrs.level, 2);

const intentionalEscapedHeading = [
  "普通段落",
  "",
  "\\## 这是 Markdown 示例，不是标题",
].join("\n");
assert.equal(
  normalizeLegacyImageAdjacentHeadings(intentionalEscapedHeading),
  intentionalEscapedHeading,
);

console.log("markdown round-trip checks passed");
