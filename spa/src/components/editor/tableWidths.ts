export const TABLE_WIDTHS_MARKER = "koinote-table-widths";

export function parseTableWidthsMarker(line: string): number[] | null {
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

export function setupTableWidthParsing(markdownit: any) {
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
