import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import type { Editor } from "@tiptap/react";
import { cellAround } from "@tiptap/pm/tables";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  BetweenHorizontalEnd,
  BetweenHorizontalStart,
  BetweenVerticalEnd,
  BetweenVerticalStart,
  Eraser,
  PanelLeftOpen,
  PanelTop,
  PanelTopOpen,
  Plus,
  TableProperties,
  TableColumnsSplit,
  TableRowsSplit,
  Trash2,
} from "lucide-react";
import { interpolate, useI18n } from "../../i18n";
import { confirmAction } from "../../confirmAction";
import {
  clearSelectedTableCells,
  hasTableHeaderRow,
  isTableCellSelection,
  resizeTable,
  selectCurrentTableColumn,
  selectCurrentTableRow,
  setTableColumnAlignment,
  tableDimensions,
  tableResizeLosesContent,
} from "./tableActions";

type TableLayout = {
  toolbarX: number;
  toolbarY: number;
  rowControlX: number;
  rowControlY: number;
  rowSelectX: number;
  rowSelectY: number;
  rowSelectHeight: number;
  columnControlX: number;
  columnControlY: number;
  columnSelectX: number;
  columnSelectY: number;
  columnSelectWidth: number;
  toolbarBelow: boolean;
  alignment: Alignment;
  headerRow: boolean;
  cellSelection: boolean;
};

type Alignment = "left" | "center" | "right" | null;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(value, maximum));
}

type Viewport = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

function clipsOverflow(value: string) {
  return value === "auto" || value === "scroll" || value === "hidden" || value === "clip";
}

function clipsVerticalOverflow(element: HTMLElement, value: string) {
  if (value === "hidden" || value === "clip") return true;
  if (!clipsOverflow(value)) return false;
  // An x-only scroller can report a small scrollHeight delta for its
  // horizontal scrollbar. Exclude that delta so .tableWrapper is not
  // mistaken for the editor's vertical viewport.
  const horizontalScrollbar = Math.max(0, element.offsetHeight - element.clientHeight);
  return element.scrollHeight > element.clientHeight + horizontalScrollbar + 1;
}

/**
 * The editor scrolls inside its own viewport. Fixed table controls still use
 * viewport coordinates, so using window.innerHeight here lets them escape
 * above the editor and overlap the application header after scrolling.
 */
function editorViewport(element: HTMLElement): Viewport {
  const viewport: Viewport = {
    left: 0,
    top: 0,
    right: window.innerWidth,
    bottom: window.innerHeight,
  };
  let ancestor = element.parentElement;
  while (ancestor) {
    const style = window.getComputedStyle(ancestor);
    if (clipsVerticalOverflow(ancestor, style.overflowY)) {
      const rect = ancestor.getBoundingClientRect();
      viewport.top = Math.max(viewport.top, rect.top);
      viewport.bottom = Math.min(viewport.bottom, rect.bottom);
    }
    ancestor = ancestor.parentElement;
  }
  return viewport;
}

function horizontalTableViewport(
  tableElement: HTMLElement,
  viewport: Viewport,
): Viewport {
  let left = viewport.left;
  let right = viewport.right;
  let ancestor = tableElement.parentElement;
  while (ancestor) {
    const style = window.getComputedStyle(ancestor);
    if (clipsOverflow(style.overflowX)) {
      const rect = ancestor.getBoundingClientRect();
      left = Math.max(left, rect.left);
      right = Math.min(right, rect.right);
      break;
    }
    ancestor = ancestor.parentElement;
  }
  return { ...viewport, left, right };
}

function measureTableLayout(editor: Editor): TableLayout | null {
  if (typeof window === "undefined" || !editor.isActive("table")) return null;
  const $cell = cellAround(editor.state.selection.$head);
  if (!$cell) return null;

  const cellDOM = editor.view.nodeDOM($cell.pos);
  if (!cellDOM || typeof (cellDOM as Element).closest !== "function") return null;
  const cellElement = (cellDOM as Element).closest("td,th") as HTMLElement | null;
  const rowElement = cellElement?.closest("tr") as HTMLElement | null;
  const tableElement = cellElement?.closest("table") as HTMLElement | null;
  if (!cellElement || !rowElement || !tableElement) return null;

  const tableRect = tableElement.getBoundingClientRect();
  const rowRect = rowElement.getBoundingClientRect();
  const cellRect = cellElement.getBoundingClientRect();
  const viewport = editorViewport(tableElement);
  if (tableRect.bottom <= viewport.top || tableRect.top >= viewport.bottom) return null;
  if (cellRect.bottom <= viewport.top || cellRect.top >= viewport.bottom) return null;

  const tableViewport = horizontalTableViewport(tableElement, viewport);
  if (cellRect.right <= tableViewport.left || cellRect.left >= tableViewport.right) {
    return null;
  }

  const xMinimum = viewport.left + 8;
  const xMaximum = viewport.right - 32;
  const yMinimum = viewport.top + 8;
  const yMaximum = viewport.bottom - 32;
  const toolbarYMaximum = Math.max(yMinimum, viewport.bottom - 56);
  const toolbarBelow = tableRect.top < viewport.top + 64;
  const columnSelectX = clamp(cellRect.left, tableViewport.left, tableViewport.right - 24);
  const columnSelectWidth = Math.max(
    24,
    Math.min(cellRect.width, tableViewport.right - columnSelectX),
  );
  const rowSelectY = clamp(rowRect.top, viewport.top, viewport.bottom - 24);
  const rowSelectHeight = Math.max(
    24,
    Math.min(rowRect.bottom, viewport.bottom) - rowSelectY,
  );

  return {
    toolbarX: clamp(tableRect.left + tableRect.width / 2, xMinimum, viewport.right - 8),
    toolbarY: toolbarBelow
      ? yMinimum
      : clamp(tableRect.top - 8, yMinimum, toolbarYMaximum),
    toolbarBelow,
    rowControlX: clamp(rowRect.left - 52, xMinimum, xMaximum),
    rowControlY: clamp(rowRect.top + rowRect.height / 2 - 12, yMinimum, yMaximum),
    rowSelectX: clamp(rowRect.left - 28, xMinimum, xMaximum),
    rowSelectY,
    rowSelectHeight,
    columnControlX: clamp(cellRect.right - 12, tableViewport.left, tableViewport.right - 32),
    columnControlY: clamp(tableRect.top - 28, yMinimum, yMaximum),
    columnSelectX,
    columnSelectY: clamp(tableRect.top - 28, yMinimum, yMaximum),
    columnSelectWidth,
    alignment: currentAlignment(editor),
    headerRow: hasTableHeaderRow(editor),
    cellSelection: isTableCellSelection(editor),
  };
}

function currentAlignment(editor: Editor): Alignment {
  const cellAlignment = editor.getAttributes("tableCell").align;
  const headerAlignment = editor.getAttributes("tableHeader").align;
  if (cellAlignment === "left" || cellAlignment === "center" || cellAlignment === "right") {
    return cellAlignment;
  }
  if (
    headerAlignment === "left" ||
    headerAlignment === "center" ||
    headerAlignment === "right"
  ) {
    return headerAlignment;
  }
  return null;
}

function ActionButton({
  label,
  active,
  danger,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="button"
      aria-label={label}
      aria-pressed={active}
      title={label}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={`flex h-8 w-8 items-center justify-center rounded-lg transition disabled:cursor-not-allowed disabled:opacity-35 ${
        danger
          ? "text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
          : active
            ? "bg-cinnabar-100 text-cinnabar-700 dark:bg-cinnabar-950/60 dark:text-cinnabar-300"
            : "text-neutral-600 hover:bg-black/5 hover:text-neutral-950 dark:text-neutral-300 dark:hover:bg-white/10 dark:hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}

function EdgeButton({
  label,
  style,
  onClick,
  className,
  children,
}: {
  label: string;
  style: CSSProperties;
  onClick: () => void;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      style={style}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      className={
        className ??
        "pointer-events-auto fixed z-50 flex h-6 w-6 items-center justify-center rounded-full border border-cinnabar-300 bg-[var(--background)] text-cinnabar-700 shadow-sm transition hover:scale-105 hover:bg-cinnabar-50 dark:border-cinnabar-500/60 dark:text-cinnabar-300 dark:hover:bg-cinnabar-950/70"
      }
    >
      {children ?? <Plus className="h-4 w-4" />}
    </button>
  );
}

const TABLE_RESIZE_PICKER_SIZE = 8;

function TableResizePicker({ editor }: { editor: Editor }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState({ rows: 3, columns: 3 });
  const [applying, setApplying] = useState(false);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const toggleOpen = () => {
    if (!open) {
      const dimensions = tableDimensions(editor);
      if (!dimensions) return;
      setSelected({
        rows: Math.min(dimensions.rows, TABLE_RESIZE_PICKER_SIZE),
        columns: Math.min(dimensions.columns, TABLE_RESIZE_PICKER_SIZE),
      });
    }
    setOpen((value) => !value);
  };

  const applyResize = async (rows: number, columns: number) => {
    if (applying) return;
    const current = tableDimensions(editor);
    if (!current) return;
    if (rows === current.rows && columns === current.columns) {
      setOpen(false);
      return;
    }

    setApplying(true);
    try {
      if (tableResizeLosesContent(editor, rows, columns)) {
        const confirmed = await confirmAction(
          interpolate(t.editor.toolbar.tableResizeWarning, {
            rows,
            columns,
          }),
        );
        if (!confirmed || !mountedRef.current || editor.isDestroyed) return;
      }

      if (
        mountedRef.current &&
        !editor.isDestroyed &&
        resizeTable(editor, rows, columns)
      ) {
        setOpen(false);
      }
    } finally {
      if (mountedRef.current) setApplying(false);
    }
  };

  const moveFocus = (row: number, column: number, key: string) => {
    let nextRow = row;
    let nextColumn = column;
    if (key === "ArrowUp") nextRow -= 1;
    if (key === "ArrowDown") nextRow += 1;
    if (key === "ArrowLeft") nextColumn -= 1;
    if (key === "ArrowRight") nextColumn += 1;
    if (
      nextRow < 1 ||
      nextRow > TABLE_RESIZE_PICKER_SIZE ||
      nextColumn < 1 ||
      nextColumn > TABLE_RESIZE_PICKER_SIZE
    ) {
      return;
    }
    const next = pickerRef.current?.querySelector<HTMLButtonElement>(
      `[data-table-resize-row="${nextRow}"][data-table-resize-column="${nextColumn}"]`,
    );
    next?.focus();
    setSelected({ rows: nextRow, columns: nextColumn });
  };

  return (
    <div ref={pickerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label={t.editor.toolbar.tableResize}
        aria-haspopup="grid"
        aria-expanded={open}
        title={t.editor.toolbar.tableResize}
        onMouseDown={(event) => event.preventDefault()}
        onClick={toggleOpen}
        className={`flex h-8 w-8 items-center justify-center rounded-lg transition ${
          open
            ? "bg-cinnabar-100 text-cinnabar-700 dark:bg-cinnabar-950/60 dark:text-cinnabar-300"
            : "text-neutral-600 hover:bg-black/5 hover:text-neutral-950 dark:text-neutral-300 dark:hover:bg-white/10 dark:hover:text-white"
        }`}
      >
        <TableProperties className="h-4 w-4" />
      </button>

      {open && (
        <div
          aria-label={t.editor.toolbar.tableResize}
          className="absolute left-0 top-10 z-50 rounded-xl border border-black/10 bg-[var(--background)] p-2 shadow-lg dark:border-white/15"
        >
          <div
            aria-live="polite"
            className="mb-1.5 text-center text-xs font-medium tabular-nums text-neutral-600 dark:text-neutral-300"
          >
            {selected.rows} × {selected.columns}
          </div>
          <div role="grid" aria-label={t.editor.toolbar.tableResize}>
            {Array.from({ length: TABLE_RESIZE_PICKER_SIZE }, (_, rowIndex) => {
              const row = rowIndex + 1;
              return (
                <div key={row} role="row" className="flex gap-0.5">
                  {Array.from({ length: TABLE_RESIZE_PICKER_SIZE }, (_, columnIndex) => {
                    const column = columnIndex + 1;
                    const highlighted =
                      row <= selected.rows && column <= selected.columns;
                    return (
                      <button
                        key={column}
                        type="button"
                        role="gridcell"
                        tabIndex={
                          row === selected.rows && column === selected.columns ? 0 : -1
                        }
                        data-table-resize-row={row}
                        data-table-resize-column={column}
                        aria-label={`${row} × ${column}`}
                        aria-selected={highlighted}
                        disabled={applying}
                        onMouseEnter={() => setSelected({ rows: row, columns: column })}
                        onFocus={() => setSelected({ rows: row, columns: column })}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            event.stopPropagation();
                            void applyResize(row, column);
                            return;
                          }
                          if (event.key.startsWith("Arrow")) {
                            event.preventDefault();
                            moveFocus(row, column, event.key);
                          }
                        }}
                        onClick={() => void applyResize(row, column)}
                        className={`h-5 w-5 rounded-sm border transition disabled:cursor-wait ${
                          highlighted
                            ? "border-cinnabar-500 bg-cinnabar-300/80 dark:bg-cinnabar-500/70"
                            : "border-black/15 bg-transparent hover:border-cinnabar-400 dark:border-white/20"
                        }`}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export function TableContextToolbar({ editor }: { editor: Editor | null }) {
  const { t } = useI18n();
  const [layout, setLayout] = useState<TableLayout | null>(null);
  const [toolbarHovered, setToolbarHovered] = useState(false);

  const refreshLayout = useCallback(() => {
    if (!editor) {
      setLayout(null);
      return;
    }
    const nextLayout = measureTableLayout(editor);
    setLayout((previous) => {
      if (!previous || !nextLayout) return nextLayout;
      const keys = Object.keys(nextLayout) as Array<keyof TableLayout>;
      return keys.every((key) => previous[key] === nextLayout[key]) ? previous : nextLayout;
    });
  }, [editor]);

  useLayoutEffect(() => {
    refreshLayout();
  }, [refreshLayout]);

  useEffect(() => {
    if (!layout) {
      setToolbarHovered(false);
      return;
    }
    const handlePointerMove = (event: PointerEvent) => {
      const target = event.target as Element | null;
      const isToolbarTarget = Boolean(
        target?.closest?.('[data-table-context-toolbar="true"]'),
      );
      setToolbarHovered((previous) =>
        previous === isToolbarTarget ? previous : isToolbarTarget,
      );
    };
    window.addEventListener("pointermove", handlePointerMove, {
      passive: true,
    });
    return () => window.removeEventListener("pointermove", handlePointerMove);
  }, [layout]);

  useEffect(() => {
    if (!editor) return;
    let frame: number | null = null;
    const scheduleRefresh = () => {
      if (frame !== null || typeof window === "undefined") return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        refreshLayout();
      });
    };
    editor.on("selectionUpdate", scheduleRefresh);
    editor.on("transaction", scheduleRefresh);
    window.addEventListener("resize", scheduleRefresh);
    window.addEventListener("scroll", scheduleRefresh, {
      capture: true,
      passive: true,
    });
    return () => {
      editor.off("selectionUpdate", scheduleRefresh);
      editor.off("transaction", scheduleRefresh);
      window.removeEventListener("resize", scheduleRefresh);
      window.removeEventListener("scroll", scheduleRefresh, true);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [editor, refreshLayout]);

  if (!editor || !layout) return null;

  const run = (command: () => boolean) => {
    editor.commands.focus();
    command();
  };

  return (
    <>
      <div
        data-table-context-toolbar="true"
        role="toolbar"
        aria-label={t.editor.toolbar.tableActions}
        style={{
          left: layout.toolbarX,
          top: layout.toolbarY,
          transform: layout.toolbarBelow
            ? "translate(-50%, 0)"
            : "translate(-50%, -100%)",
          maxWidth: "calc(100vw - 16px)",
        }}
        className="pointer-events-auto fixed z-50 flex flex-wrap items-center justify-center gap-0.5 rounded-xl border border-black/10 bg-[var(--background)]/95 p-1 shadow-lg backdrop-blur dark:border-white/15"
      >
        <TableResizePicker editor={editor} />
        {/* Keep these directions aligned with the visible labels: VerticalStart/End are the above/below row icons, and HorizontalStart/End are the left/right column icons. */}
        <ActionButton
          label={t.editor.toolbar.tableAddRowBefore}
          onClick={() => run(() => editor.commands.addRowBefore())}
        >
          <BetweenVerticalStart className="h-4 w-4" />
        </ActionButton>
        <ActionButton
          label={t.editor.toolbar.tableAddRow}
          onClick={() => run(() => editor.commands.addRowAfter())}
        >
          <BetweenVerticalEnd className="h-4 w-4" />
        </ActionButton>
        <ActionButton
          label={t.editor.toolbar.tableAddColumnBefore}
          onClick={() => run(() => editor.commands.addColumnBefore())}
        >
          <BetweenHorizontalStart className="h-4 w-4" />
        </ActionButton>
        <ActionButton
          label={t.editor.toolbar.tableAddColumn}
          onClick={() => run(() => editor.commands.addColumnAfter())}
        >
          <BetweenHorizontalEnd className="h-4 w-4" />
        </ActionButton>
        <span aria-hidden className="mx-1 h-5 w-px bg-black/10 dark:bg-white/15" />
        <ActionButton
          label={t.editor.toolbar.tableHeaderRow}
          active={layout.headerRow}
          disabled={layout.headerRow || !editor.can().toggleHeaderRow()}
          onClick={() => run(() => editor.commands.toggleHeaderRow())}
        >
          <PanelTop className="h-4 w-4" />
        </ActionButton>
        <ActionButton
          label={t.editor.toolbar.tableAlignLeft}
          active={layout.alignment === "left"}
          onClick={() => run(() => setTableColumnAlignment(editor, "left"))}
        >
          <AlignLeft className="h-4 w-4" />
        </ActionButton>
        <ActionButton
          label={t.editor.toolbar.tableAlignCenter}
          active={layout.alignment === "center"}
          onClick={() => run(() => setTableColumnAlignment(editor, "center"))}
        >
          <AlignCenter className="h-4 w-4" />
        </ActionButton>
        <ActionButton
          label={t.editor.toolbar.tableAlignRight}
          active={layout.alignment === "right"}
          onClick={() => run(() => setTableColumnAlignment(editor, "right"))}
        >
          <AlignRight className="h-4 w-4" />
        </ActionButton>
        {layout.cellSelection && (
          <ActionButton
            label={t.editor.toolbar.tableClearSelection}
            onClick={() => run(() => clearSelectedTableCells(editor))}
          >
            <Eraser className="h-4 w-4" />
          </ActionButton>
        )}
        <span aria-hidden className="mx-1 h-5 w-px bg-black/10 dark:bg-white/15" />
        <ActionButton
          label={t.editor.toolbar.tableDeleteRow}
          danger
          disabled={!editor.can().deleteRow()}
          onClick={() => run(() => editor.commands.deleteRow())}
        >
          <TableRowsSplit className="h-4 w-4" />
        </ActionButton>
        <ActionButton
          label={t.editor.toolbar.tableDeleteColumn}
          danger
          disabled={!editor.can().deleteColumn()}
          onClick={() => run(() => editor.commands.deleteColumn())}
        >
          <TableColumnsSplit className="h-4 w-4" />
        </ActionButton>
        <ActionButton
          label={t.editor.toolbar.tableDelete}
          danger
          disabled={!editor.can().deleteTable()}
          onClick={() => run(() => editor.commands.deleteTable())}
        >
          <Trash2 className="h-4 w-4" />
        </ActionButton>
      </div>

      <EdgeButton
        label={t.editor.toolbar.tableSelectRow}
        style={{
          left: layout.rowSelectX,
          top: layout.rowSelectY,
          height: layout.rowSelectHeight,
        }}
        className="pointer-events-auto fixed z-50 flex w-6 items-center justify-center rounded-md border border-black/10 bg-[var(--background)]/95 text-neutral-500 shadow-sm transition hover:border-cinnabar-300 hover:bg-cinnabar-50 hover:text-cinnabar-700 dark:border-white/15 dark:text-neutral-400 dark:hover:border-cinnabar-500/60 dark:hover:bg-cinnabar-950/60 dark:hover:text-cinnabar-300"
        onClick={() => selectCurrentTableRow(editor)}
      >
        <PanelLeftOpen className="h-3.5 w-3.5" />
      </EdgeButton>
      <EdgeButton
        label={t.editor.toolbar.tableAddRow}
        style={{ left: layout.rowControlX, top: layout.rowControlY }}
        onClick={() => run(() => editor.commands.addRowAfter())}
      />
      <EdgeButton
        label={t.editor.toolbar.tableSelectColumn}
        style={{
          left: layout.columnSelectX,
          top: layout.columnSelectY,
          width: layout.columnSelectWidth,
          zIndex: toolbarHovered ? 49 : 51,
        }}
        className="pointer-events-auto fixed z-50 flex h-6 items-center justify-center rounded-md border border-black/10 bg-[var(--background)]/95 text-neutral-500 shadow-sm transition hover:border-cinnabar-300 hover:bg-cinnabar-50 hover:text-cinnabar-700 dark:border-white/15 dark:text-neutral-400 dark:hover:border-cinnabar-500/60 dark:hover:bg-cinnabar-950/60 dark:hover:text-cinnabar-300"
        onClick={() => selectCurrentTableColumn(editor)}
      >
        <PanelTopOpen className="h-3.5 w-3.5" />
      </EdgeButton>
      <EdgeButton
        label={t.editor.toolbar.tableAddColumn}
        style={{ left: layout.columnControlX, top: layout.columnControlY }}
        onClick={() => run(() => editor.commands.addColumnAfter())}
      />
    </>
  );
}
