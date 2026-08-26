import { Table, type TableOptions } from "@tiptap/extension-table";

type MarkdownNode = {
  type: { name: string; spec?: { inlineContent?: boolean } };
  attrs: Record<string, unknown>;
  childCount: number;
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
  };
};

type TableRowNode = MarkdownNode;

type GridCell = TableCellNode | null;

function cells(row: TableRowNode): TableCellNode[] {
  const result: TableCellNode[] = [];
  row.forEach((node) => result.push(node as TableCellNode));
  return result;
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

  state.inTable = true;
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
        state.write(delimiter(cell ?? undefined));
      });
      state.write(" |");
      state.ensureNewLine();
    }
  });
  state.closeBlock(node);
  state.inTable = false;
}

export const MarkdownTable = Table.extend<Partial<TableOptions>>({
  addStorage() {
    return {
      markdown: {
        serialize: serializeTable,
      },
    };
  },
});
