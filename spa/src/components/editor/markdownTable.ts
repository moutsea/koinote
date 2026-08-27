import { InputRule } from "@tiptap/core";
import { Table, type TableOptions } from "@tiptap/extension-table";
import { DOMParser } from "@tiptap/pm/model";
import { TextSelection } from "@tiptap/pm/state";

type MarkdownNode = {
  type: { name: string; spec?: { inlineContent?: boolean } };
  attrs: Record<string, unknown>;
  childCount: number;
  nodeSize: number;
  textContent: string;
  firstChild?: MarkdownNode;
  forEach: (callback: (node: MarkdownNode, offset: number, index: number) => void) => void;
};

type MarkdownSerializer = (
  state: MarkdownSerializerState,
  node: MarkdownNode,
  parent: MarkdownNode,
  index: number,
) => void;

type MarkdownSerializerState = {
  inTable: boolean;
  out: string;
  nodes: Record<string, MarkdownSerializer>;
  esc: (value: string, startOfLine?: boolean) => string;
  write: (value?: string) => void;
  ensureNewLine: () => void;
  closeBlock: (node: MarkdownNode) => void;
  renderInline: (node: MarkdownNode) => void;
};

type TableCellNode = MarkdownNode & {
  attrs: MarkdownNode["attrs"] & {
    align?: "left" | "center" | "right" | null;
    colspan?: number;
    rowspan?: number;
    colwidth?: number[] | null;
  };
};

type TableRowNode = MarkdownNode;

type GridCell = TableCellNode | null;

function cells(row: TableRowNode): TableCellNode[] {
  const result: TableCellNode[] = [];
  row.forEach((node) => result.push(node as TableCellNode));
  return result;
}

function splitTableCells(line: string): string[] {
  const source = line.trim();
  const content =
    source.startsWith("|") && source.endsWith("|")
      ? source.slice(1, -1)
      : source.startsWith("|")
        ? source.slice(1)
        : source.endsWith("|")
          ? source.slice(0, -1)
          : source;
  const result: string[] = [];
  let value = "";
  let escaped = false;
  for (const character of content) {
    if (character === "|" && !escaped) {
      result.push(value.trim());
      value = "";
      continue;
    }
    value += character;
    escaped = character === "\\" && !escaped;
    if (character !== "\\") escaped = false;
  }
  result.push(value.trim());
  return result;
}

function isTableDelimiter(line: string): boolean {
  if (!line.includes("|")) return false;
  const cells = splitTableCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

function findTableDelimiter(text: string) {
  if (!text.endsWith("\n")) return null;
  const line = text.slice(0, -1);
  if (!isTableDelimiter(line)) return null;
  return { index: 0, text };
}

function span(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : 1;
}

/** 将 colspan/rowspan 展开成 Markdown 能表达的矩形网格，避免复杂表格整张丢失。 */
function expandRows(rows: TableRowNode[]): GridCell[][] {
  const grid: GridCell[][] = [];
  const pending: number[] = [];

  for (const row of rows) {
    const occupied = pending.map((remaining) => remaining > 0);
    for (let column = 0; column < pending.length; column += 1) {
      if (pending[column] > 0) pending[column] -= 1;
    }

    const output: GridCell[] = [];
    let cursor = 0;
    for (const cell of cells(row)) {
      while (occupied[cursor]) cursor += 1;
      const colspan = span(cell.attrs.colspan);
      const rowspan = span(cell.attrs.rowspan);
      while (occupied.length < cursor + colspan) occupied.push(false);
      while (pending.length < cursor + colspan) pending.push(0);

      for (let offset = 0; offset < colspan; offset += 1) {
        const column = cursor + offset;
        occupied[column] = true;
        output[column] = offset === 0 ? cell : null;
        pending[column] = Math.max(pending[column], rowspan - 1);
      }
      cursor += colspan;
    }
    grid.push(output);
  }

  const columnCount = Math.max(1, ...grid.map((row) => row.length));
  return grid.map((row) => [
    ...row,
    ...Array<GridCell>(columnCount - row.length).fill(null),
  ]);
}

function delimiter(cell: TableCellNode | undefined): string {
  const dashes = "---";
  const align = cell?.attrs.align;
  if (align === "left") return `:${dashes.slice(1)}`;
  if (align === "right") return `${dashes.slice(1)}:`;
  if (align === "center") return `:${dashes.slice(1)}:`;
  return dashes;
}

const TABLE_WIDTHS_MARKER = "koinote-table-widths";

function parseTableWidthsMarker(line: string): number[] | null {
  const match = line.trim().match(
    new RegExp(`^<!--\\s*${TABLE_WIDTHS_MARKER}:\\s*([0-9, ]+)\\s*-->$`),
  );
  if (!match) return null;
  const widths = match[1].split(",").map((value) => {
    const width = Number.parseInt(value.trim(), 10);
    return Number.isFinite(width) && width >= 40 && width <= 2000 ? width : 0;
  });
  return widths.some((width) => width > 0) ? widths : null;
}

function setupTableWidthParsing(markdownit: any) {
  if (markdownit.__koinoteTableWidths) return;
  markdownit.__koinoteTableWidths = true;

  markdownit.block.ruler.before(
    "table",
    TABLE_WIDTHS_MARKER,
    (state: any, startLine: number, _endLine: number, silent: boolean) => {
      const start = state.bMarks[startLine] + state.tShift[startLine];
      const end = state.eMarks[startLine];
      const line = state.src.slice(start, end);
      const widths = parseTableWidthsMarker(line);
      if (!widths) return false;
      if (silent) return true;
      const token = state.push(TABLE_WIDTHS_MARKER, "", 0);
      token.meta = { widths };
      state.line = startLine + 1;
      return true;
    },
    { alt: [] },
  );
  markdownit.renderer.rules[TABLE_WIDTHS_MARKER] = () => "";
  markdownit.core.ruler.after("block", TABLE_WIDTHS_MARKER, (state: any) => {
    let pending: number[] | null = null;
    for (const token of state.tokens) {
      if (token.type === TABLE_WIDTHS_MARKER) {
        pending = token.meta?.widths ?? null;
        continue;
      }
      if (token.type === "table_open" && pending) {
        token.attrSet(`data-${TABLE_WIDTHS_MARKER}`, pending.join(","));
        pending = null;
        continue;
      }
      if (token.type !== "inline" && token.type !== "paragraph_open") {
        pending = null;
      }
    }
  });
}

function applyTableWidthsFromDOM(element: Element) {
  element.querySelectorAll<HTMLTableElement>(
    `table[data-${TABLE_WIDTHS_MARKER}]`,
  ).forEach((table) => {
    const widths = (table.getAttribute(`data-${TABLE_WIDTHS_MARKER}`) ?? "")
      .split(",")
      .map((value) => Number.parseInt(value, 10));
    table.querySelectorAll("tr").forEach((row) => {
      Array.from(row.children).forEach((cell, column) => {
        const width = widths[column];
        if (Number.isFinite(width) && width >= 40 && width <= 2000) {
          cell.setAttribute("colwidth", String(width));
        }
      });
    });
    table.removeAttribute(`data-${TABLE_WIDTHS_MARKER}`);
  });
}

function renderImage(state: MarkdownSerializerState, node: MarkdownNode) {
  const attrs = node.attrs;
  const alt = state.esc(typeof attrs.alt === "string" ? attrs.alt : "");
  const src = (typeof attrs.src === "string" ? attrs.src : "").replace(/[()]/g, "\\$&");
  const title =
    typeof attrs.title === "string" && attrs.title
      ? ` "${attrs.title.replace(/"/g, '\\"')}"`
      : "";
  state.write(`![${alt}](${src}${title})`);
}

function renderInline(state: MarkdownSerializerState, node: MarkdownNode) {
  const previousHardBreak = state.nodes.hardBreak;
  state.nodes.hardBreak = (nestedState) => nestedState.write(" ");
  try {
    state.renderInline(node);
  } finally {
    if (previousHardBreak) state.nodes.hardBreak = previousHardBreak;
    else delete state.nodes.hardBreak;
  }
}

function renderBlock(state: MarkdownSerializerState, node: MarkdownNode) {
  if (node.type.name === "image") {
    renderImage(state, node);
    return;
  }
  if (node.type.name === "hardBreak") {
    state.write(" ");
    return;
  }
  if (node.type.name === "text") {
    state.write(state.esc(node.textContent));
    return;
  }
  if (node.type.spec?.inlineContent || node.type.name === "paragraph" || node.type.name === "heading") {
    renderInline(state, node);
    return;
  }
  if (node.childCount > 0) {
    let first = true;
    node.forEach((child) => {
      if (!first) state.write(" ");
      renderBlock(state, child);
      first = false;
    });
    return;
  }
  if (node.textContent) state.write(state.esc(node.textContent));
}

function renderCell(state: MarkdownSerializerState, cell: GridCell) {
  if (!cell) return;
  const start = state.out.length;
  let hasContent = false;
  cell.forEach((block) => {
    const blockStart = state.out.length;
    if (hasContent) state.write(" ");
    const contentStart = state.out.length;
    renderBlock(state, block);
    if (state.out.length === contentStart) {
      state.out = state.out.slice(0, blockStart);
    } else {
      hasContent = true;
    }
  });
  const content = state.out.slice(start).replace(/\r?\n/g, " ").trim();
  state.out = state.out.slice(0, start) + content.replace(/\|/g, "\\|");
}

function serializeTable(
  state: MarkdownSerializerState,
  node: MarkdownNode,
  _parent: MarkdownNode,
  _index: number,
) {
  const rows: TableRowNode[] = [];
  node.forEach((row) => rows.push(row));
  const grid = expandRows(rows);
  const columnCount = grid[0]?.length ?? 1;
  const alignments = Array.from({ length: columnCount }, (_, columnIndex) =>
    grid.find((row) => row[columnIndex]?.attrs.align)?.[columnIndex],
  );
  const columnWidths: Array<number | null> = Array(columnCount).fill(null);
  grid.forEach((row) => {
    row.forEach((cell, column) => {
      if (!cell?.attrs.colwidth) return;
      const widths = cell.attrs.colwidth;
      const colspan = span(cell.attrs.colspan);
      for (let offset = 0; offset < colspan; offset += 1) {
        const width = widths[offset];
        if (
          columnWidths[column + offset] === null &&
          typeof width === "number" &&
          Number.isFinite(width) &&
          width >= 40 &&
          width <= 2000
        ) {
          columnWidths[column + offset] = Math.round(width);
        }
      }
    });
  });

  state.inTable = true;
  if (columnWidths.some((width) => width !== null)) {
    state.write(
      `<!-- ${TABLE_WIDTHS_MARKER}: ${columnWidths
        .map((width) => width ?? "")
        .join(",")} -->`,
    );
    state.ensureNewLine();
  }
  const outputRows = grid.length > 0 ? grid : [Array<GridCell>(columnCount).fill(null)];
  outputRows.forEach((row, rowIndex) => {
    state.write("| ");
    row.forEach((cell, cellIndex) => {
      if (cellIndex) state.write(" | ");
      renderCell(state, cell);
    });
    state.write(" |");
    state.ensureNewLine();

    if (rowIndex === 0) {
      state.write("| ");
      row.forEach((cell, cellIndex) => {
        if (cellIndex) state.write(" | ");
        state.write(delimiter(alignments[cellIndex] ?? cell ?? undefined));
      });
      state.write(" |");
      state.ensureNewLine();
    }
  });
  state.closeBlock(node);
  state.inTable = false;
}

export const MarkdownTable = Table.extend<Partial<TableOptions>>({
  addInputRules() {
    return [
      new InputRule({
        find: findTableDelimiter,
        handler: ({ state }) => {
          const { $from } = state.selection;
          if ($from.depth !== 1 || $from.parent.type.name !== "paragraph") {
            return null;
          }

          const currentText = $from.parent.textContent.trim();
          if (!isTableDelimiter(currentText)) return null;

          const currentStart = $from.before(1);
          const index = $from.index(0);
          if (index === 0) return null;

          const headerNode = state.doc.child(index - 1) as MarkdownNode;
          if (headerNode.type.name !== "paragraph") {
            return null;
          }

          const headerText = headerNode.textContent.trim();
          if (!headerText.includes("|")) return null;
          const headerCells = splitTableCells(headerText);
          const delimiterCells = splitTableCells(currentText);
          if (
            headerCells.length === 0 ||
            headerCells.length !== delimiterCells.length
          ) {
            return null;
          }

          const blankRow = `| ${headerCells.map(() => "").join(" | ")} |`;
          const markdown = `${headerText}\n${currentText}\n${blankRow}`;
          const markdownParser = (
            this.editor.storage.markdown as unknown as {
              parser: { parse: (content: string) => string };
            }
          ).parser;
          const renderedHTML = markdownParser.parse(markdown);
          const ownerDocument = this.editor.view.dom.ownerDocument;
          const container = ownerDocument.createElement("div");
          container.innerHTML = renderedHTML;
          const parsedDocument = DOMParser.fromSchema(state.schema).parse(container);
          const table = parsedDocument.firstChild;

          if (!table || table.type.name !== this.name || table.childCount < 2) {
            return null;
          }

          const start = currentStart - headerNode.nodeSize;
          const end = currentStart + $from.parent.nodeSize;
          const transaction = state.tr.replaceWith(start, end, table);
          const firstBodyRow = table.child(1);
          const firstCell = firstBodyRow.firstChild;
          if (firstCell) {
            const bodyRowOffset = table.child(0).nodeSize;
            const cellStart = start + 1 + bodyRowOffset + 1;
            transaction.setSelection(
              TextSelection.near(transaction.doc.resolve(cellStart + 2)),
            );
          }
          transaction.scrollIntoView();
          return;
        },
      }),
    ];
  },
  addStorage() {
    return {
      markdown: {
        serialize: serializeTable,
        parse: {
          setup: setupTableWidthParsing,
          updateDOM: applyTableWidthsFromDOM,
        },
      },
    };
  },
});
