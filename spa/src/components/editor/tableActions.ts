import type { Editor } from "@tiptap/react";
import { cellAround, CellSelection, TableMap } from "@tiptap/pm/tables";
import { Fragment, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TextSelection, type Selection } from "@tiptap/pm/state";

export type TableClearAxis = "row" | "column";
export type TableAlignment = "left" | "center" | "right" | null;
export type TableMatrix = string[][];

export function shouldInterceptTablePaste(parentTypeName: string): boolean {
  return parentTypeName !== "codeBlock";
}

function normalizeMatrix(matrix: TableMatrix): TableMatrix | null {
  const rows = matrix
    .map((row) => row.map((value) => (value ?? "").replace(/\r?\n/g, " ")))
    .filter((row) => row.length > 0);
  const width = Math.max(0, ...rows.map((row) => row.length));
  if (rows.length === 0 || width === 0 || (rows.length === 1 && width === 1)) {
    return null;
  }
  return rows.map((row) => [...row, ...Array(width - row.length).fill("")]);
}

export function tableMatrixFromText(text: string): TableMatrix | null {
  const source = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  if (!source.includes("\t")) return null;
  const rows = source.split("\n").map((row) => row.split("\t"));
  if (rows.length < 2) return null;
  const width = rows[0].length;
  if (width < 2 || rows.some((row) => row.length !== width)) return null;
  return normalizeMatrix(rows);
}

export function tableMatrixFromHtml(
  html: string,
  ownerDocument: Document,
): TableMatrix | null {
  const container = ownerDocument.createElement("div");
  container.innerHTML = html;
  const table = container.querySelector("table");
  if (!table || table.querySelector("img")) return null;

  const matrix: string[][] = [];
  const occupied: Array<Array<boolean>> = [];
  const rows = Array.from(table.querySelectorAll("tr"));
  rows.forEach((row, rowIndex) => {
    if (!matrix[rowIndex]) matrix[rowIndex] = [];
    if (!occupied[rowIndex]) occupied[rowIndex] = [];
    let column = 0;
    Array.from(row.children).forEach((cell) => {
      while (occupied[rowIndex][column]) column += 1;
      const colspan = Math.max(1, Number.parseInt(cell.getAttribute("colspan") ?? "1", 10) || 1);
      const rowspan = Math.max(1, Number.parseInt(cell.getAttribute("rowspan") ?? "1", 10) || 1);
      const value = (cell.textContent ?? "").replace(/\s+/g, " ").trim();
      for (let rowOffset = 0; rowOffset < rowspan; rowOffset += 1) {
        const targetRow = rowIndex + rowOffset;
        if (!matrix[targetRow]) matrix[targetRow] = [];
        if (!occupied[targetRow]) occupied[targetRow] = [];
        for (let columnOffset = 0; columnOffset < colspan; columnOffset += 1) {
          const targetColumn = column + columnOffset;
          occupied[targetRow][targetColumn] = true;
          if (rowOffset === 0 && columnOffset === 0) {
            matrix[targetRow][targetColumn] = value;
          } else if (matrix[targetRow][targetColumn] === undefined) {
            matrix[targetRow][targetColumn] = "";
          }
        }
      }
      column += colspan;
    });
  });
  return normalizeMatrix(matrix);
}

export function tableMatrixFromClipboard(
  text: string,
  html: string | null,
  ownerDocument: Document,
): TableMatrix | null {
  if (html) {
    const htmlMatrix = tableMatrixFromHtml(html, ownerDocument);
    if (htmlMatrix) return htmlMatrix;
  }
  return tableMatrixFromText(text);
}

type TableContext = {
  tableStart: number;
  table: ProseMirrorNode;
  tableMap: TableMap;
  positions: Set<number>;
};

function tableContext(editor: Editor): TableContext | null {
  const { state } = editor;
  const selection = state.selection;
  const anchorCell =
    selection instanceof CellSelection
      ? selection.$anchorCell
      : cellAround(selection.$head);
  if (!anchorCell) return null;

  const table = anchorCell.node(-1);
  const tableStart = anchorCell.start(-1);
  const tableMap = TableMap.get(table);
  const positions = new Set<number>();

  if (selection instanceof CellSelection) {
    selection.forEachCell((_cell, position) => {
      positions.add(position - tableStart);
    });
  } else {
    const rect = tableMap.findCell(anchorCell.pos - tableStart);
    positions.add(tableMap.map[rect.top * tableMap.width + rect.left]);
  }

  return { tableStart, table, tableMap, positions };
}

function currentCellPosition(editor: Editor): number | null {
  const context = tableContext(editor);
  if (!context) return null;
  const selection = editor.state.selection;
  const anchorCell =
    selection instanceof CellSelection
      ? selection.$anchorCell
      : cellAround(selection.$head);
  if (!anchorCell) return null;
  return anchorCell.pos - context.tableStart;
}

export function isTableCellSelection(editor: Editor): boolean {
  return editor.state.selection instanceof CellSelection;
}

export function hasTableHeaderRow(editor: Editor): boolean {
  const selection = editor.state.selection;
  const $cell =
    selection instanceof CellSelection
      ? selection.$headCell
      : cellAround(selection.$head);
  if (!$cell) return false;
  const firstRow = $cell.node(-1).firstChild;
  if (!firstRow || firstRow.childCount === 0) return false;
  let allHeaders = true;
  firstRow.forEach((node) => {
    if (node.type.name !== "tableHeader") allHeaders = false;
  });
  return allHeaders;
}

function createCellContent(editor: Editor, value: string): Fragment {
  const { schema } = editor.state;
  const paragraph = schema.nodes.paragraph;
  const lines = value.split("\n");
  return Fragment.from(
    lines.map((line) =>
      paragraph.create(null, line ? schema.text(line) : undefined),
    ),
  );
}

type TableState = {
  doc: ProseMirrorNode;
  selection: Selection;
};

function tableCoordinatesFromState(state: TableState) {
  const { selection } = state;
  const anchorCell =
    selection instanceof CellSelection
      ? selection.$anchorCell
      : cellAround(selection.$head);
  if (!anchorCell) return null;
  const table = anchorCell.node(-1);
  const tableStart = anchorCell.start(-1);
  const tableMap = TableMap.get(table);
  const anchorRect = tableMap.findCell(anchorCell.pos - tableStart);
  let top = anchorRect.top;
  let left = anchorRect.left;
  if (selection instanceof CellSelection) {
    const headRect = tableMap.findCell(selection.$headCell.pos - tableStart);
    top = Math.min(anchorRect.top, headRect.top);
    left = Math.min(anchorRect.left, headRect.left);
  }
  return { tableStart, table, tableMap, top, left };
}

function tableCoordinates(editor: Editor) {
  return tableCoordinatesFromState(editor.state);
}

function appendTableRows(
  table: ProseMirrorNode,
  count: number,
): ProseMirrorNode | null {
  const schema = table.type.schema;
  const rowType = schema.nodes.tableRow;
  const cellType = schema.nodes.tableCell;
  let expanded = table;

  for (let rowIndex = 0; rowIndex < count; rowIndex += 1) {
    const map = TableMap.get(expanded);
    const lastRow = expanded.child(map.height - 1);
    const allHeaders =
      lastRow.childCount > 0 &&
      lastRow.content.content.every((cell) => cell.type.name === "tableHeader");
    const cells: ProseMirrorNode[] = [];
    for (let column = 0; column < map.width; column += 1) {
      let type = cellType;
      if (!allHeaders) {
        type =
          expanded.nodeAt(map.map[(map.height - 1) * map.width + column])?.type ??
          cellType;
      }
      const cell = type.createAndFill();
      if (!cell) return null;
      cells.push(cell);
    }
    expanded = expanded.copy(
      expanded.content.append(Fragment.from(rowType.create(null, cells))),
    );
  }
  return expanded;
}

function appendTableColumns(
  table: ProseMirrorNode,
  count: number,
): ProseMirrorNode | null {
  const schema = table.type.schema;
  const cellType = schema.nodes.tableCell;
  const headerCellType = schema.nodes.tableHeader;
  let expanded = table;

  for (let columnIndex = 0; columnIndex < count; columnIndex += 1) {
    const rows: ProseMirrorNode[] = [];
    for (let row = 0; row < expanded.childCount; row += 1) {
      const rowNode = expanded.child(row);
      const rowAllHeaders =
        rowNode.childCount > 0 &&
        rowNode.content.content.every((cell) => cell.type.name === "tableHeader");
      const type = rowAllHeaders ? headerCellType : cellType;
      const cell = type.createAndFill();
      if (!cell) return null;
      rows.push(
        rowNode.copy(rowNode.content.append(Fragment.from(cell))),
      );
    }
    expanded = expanded.copy(Fragment.from(rows));
  }
  return expanded;
}

export function insertTableMatrix(editor: Editor, matrix: TableMatrix): boolean {
  const normalized = normalizeMatrix(matrix);
  if (!normalized) return false;

  const initialCoordinates = tableCoordinates(editor);
  const startRow = initialCoordinates?.top ?? 0;
  const startColumn = initialCoordinates?.left ?? 0;
  const requiredRows = startRow + normalized.length;
  const requiredColumns = startColumn + normalized[0].length;
  const chain = editor.chain().focus();
  if (!initialCoordinates) {
    chain.insertTable({
      rows: normalized.length,
      cols: normalized[0].length,
      withHeaderRow: true,
    });
  }

  return chain
    .command(({ tr }) => {
      const coordinates = tableCoordinatesFromState(tr);
      if (!coordinates) return false;
      let table = coordinates.table;
      if (initialCoordinates) {
        const rowsToAdd = requiredRows - coordinates.tableMap.height;
        const columnsToAdd = requiredColumns - coordinates.tableMap.width;
        const expandedRows = appendTableRows(table, rowsToAdd);
        if (!expandedRows) return false;
        const expandedTable = appendTableColumns(expandedRows, columnsToAdd);
        if (!expandedTable) return false;
        table = expandedTable;
        if (table !== coordinates.table) {
          tr.replaceWith(
            coordinates.tableStart - 1,
            coordinates.tableStart - 1 + coordinates.table.nodeSize,
            table,
          );
        }
      }
      const tableMap = TableMap.get(table);
      const cells = new Map<number, string>();
      for (let row = 0; row < normalized.length; row += 1) {
        for (let column = 0; column < normalized[row].length; column += 1) {
          const relativePosition =
            tableMap.map[
              (startRow + row) * tableMap.width +
                startColumn +
                column
            ];
          if (!cells.has(relativePosition)) {
            cells.set(relativePosition, normalized[row][column]);
          }
        }
      }

      [...cells.entries()]
        .sort(([left], [right]) => right - left)
        .forEach(([relativePosition, value]) => {
          const cellPosition = coordinates.tableStart + relativePosition;
          const cell = tr.doc.nodeAt(cellPosition);
          if (!cell) return;
          tr.replaceWith(
            cellPosition + 1,
            cellPosition + cell.nodeSize - 1,
            createCellContent(editor, value),
          );
        });

      if (!tr.docChanged) return false;
      const finalTable = tr.doc.nodeAt(coordinates.tableStart - 1);
      if (finalTable?.type.name === "table") {
        const finalTableMap = TableMap.get(finalTable);
        const lastRow = startRow + normalized.length - 1;
        const lastColumn = startColumn + normalized[0].length - 1;
        const lastPosition =
          finalTableMap.map[lastRow * finalTableMap.width + lastColumn];
        const lastCellPosition = coordinates.tableStart + lastPosition + 1;
        tr.setSelection(
          TextSelection.near(tr.doc.resolve(lastCellPosition + 1)),
        );
      }
      return true;
    })
    .run();
}

export function tableSelectionToMarkdown(
  editor: Editor,
  slice: { content: Fragment },
): string | null {
  const first = slice.content.firstChild;
  if (!first) return null;

  let table: ProseMirrorNode | null = null;
  if (first.type.name === "table") {
    if (slice.content.childCount !== 1) return null;
    table = first;
  } else if (
    Array.from({ length: slice.content.childCount }, (_, index) =>
      slice.content.child(index),
    ).every((node) => node.type.name === "tableRow")
  ) {
    table = editor.state.schema.nodes.table?.create(null, slice.content) ?? null;
  }
  if (!table) return null;

  const serializer = (
    editor.storage.markdown as {
      serializer?: { serialize: (content: Fragment) => string };
    }
  ).serializer;
  return serializer?.serialize(Fragment.from(table)) ?? null;
}

export function selectCurrentTableRow(editor: Editor): boolean {
  editor.commands.focus();
  const selection = editor.state.selection;
  const $cell =
    selection instanceof CellSelection
      ? selection.$headCell
      : cellAround(selection.$head);
  if (!$cell) return false;
  editor.view.dispatch(
    editor.state.tr.setSelection(CellSelection.rowSelection($cell)),
  );
  return true;
}

export function selectCurrentTableColumn(editor: Editor): boolean {
  editor.commands.focus();
  const selection = editor.state.selection;
  const $cell =
    selection instanceof CellSelection
      ? selection.$headCell
      : cellAround(selection.$head);
  if (!$cell) return false;
  editor.view.dispatch(
    editor.state.tr.setSelection(CellSelection.colSelection($cell)),
  );
  return true;
}

export function clearSelectedTableCells(editor: Editor): boolean {
  editor.commands.focus();
  const context = tableContext(editor);
  if (!context || !(editor.state.selection instanceof CellSelection)) return false;

  const transaction = editor.state.tr;
  [...context.positions]
    .sort((left, right) => right - left)
    .forEach((relativePosition) => {
      const cellPosition = context.tableStart + relativePosition;
      const cell = transaction.doc.nodeAt(cellPosition);
      if (!cell) return;
      const emptyCell = cell.type.createAndFill(cell.attrs);
      if (!emptyCell) return;
      transaction.replaceWith(
        cellPosition + 1,
        cellPosition + cell.nodeSize - 1,
        emptyCell.content,
      );
    });

  if (!transaction.docChanged) return false;
  editor.view.dispatch(transaction);
  return true;
}

export function clearTableAxis(editor: Editor, axis: TableClearAxis): boolean {
  editor.commands.focus();
  const { state } = editor;
  const context = tableContext(editor);
  if (!context) return false;

  const currentPosition = currentCellPosition(editor);
  if (currentPosition === null) return false;
  const cellRect = context.tableMap.findCell(currentPosition);
  const positions = new Set<number>();

  if (axis === "row") {
    for (let column = 0; column < context.tableMap.width; column += 1) {
      positions.add(
        context.tableMap.map[cellRect.top * context.tableMap.width + column],
      );
    }
  } else {
    for (let row = 0; row < context.tableMap.height; row += 1) {
      positions.add(
        context.tableMap.map[row * context.tableMap.width + cellRect.left],
      );
    }
  }

  const transaction = state.tr;
  [...positions]
    .sort((left, right) => right - left)
    .forEach((relativePosition) => {
      const cellPosition = context.tableStart + relativePosition;
      const cell = transaction.doc.nodeAt(cellPosition);
      if (!cell) return;
      const emptyCell = cell.type.createAndFill(cell.attrs);
      if (!emptyCell) return;
      transaction.replaceWith(
        cellPosition + 1,
        cellPosition + cell.nodeSize - 1,
        emptyCell.content,
      );
    });

  if (!transaction.docChanged) return false;
  editor.view.dispatch(transaction);
  return true;
}

export function setTableColumnAlignment(
  editor: Editor,
  alignment: TableAlignment,
): boolean {
  editor.commands.focus();
  const { state } = editor;
  const context = tableContext(editor);
  if (!context) return false;

  const positions = new Set<number>();
  if (state.selection instanceof CellSelection) {
    context.positions.forEach((position) => {
      const cellRect = context.tableMap.findCell(position);
      for (let row = 0; row < context.tableMap.height; row += 1) {
        positions.add(
          context.tableMap.map[row * context.tableMap.width + cellRect.left],
        );
      }
    });
  } else {
    const currentPosition = currentCellPosition(editor);
    if (currentPosition === null) return false;
    const cellRect = context.tableMap.findCell(currentPosition);
    for (let row = 0; row < context.tableMap.height; row += 1) {
      positions.add(
        context.tableMap.map[row * context.tableMap.width + cellRect.left],
      );
    }
  }

  const transaction = state.tr;
  [...positions]
    .sort((left, right) => right - left)
    .forEach((relativePosition) => {
      const cellPosition = context.tableStart + relativePosition;
      const cell = transaction.doc.nodeAt(cellPosition);
      if (!cell) return;
      transaction.setNodeMarkup(cellPosition, cell.type, {
        ...cell.attrs,
        align: alignment,
      });
    });

  if (!transaction.docChanged) return false;
  editor.view.dispatch(transaction);
  return true;
}
