import { useCallback, useEffect, useLayoutEffect, useState, type CSSProperties, type ReactNode } from "react";
import type { Editor } from "@tiptap/react";
import { cellAround } from "@tiptap/pm/tables";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Eraser,
  GripHorizontal,
  GripVertical,
  PanelTop,
  Plus,
  TableColumnsSplit,
  TableRowsSplit,
  Trash2,
} from "lucide-react";
import { useI18n } from "../../i18n";
import {
  clearSelectedTableCells,
  hasTableHeaderRow,
  isTableCellSelection,
  selectCurrentTableColumn,
  selectCurrentTableRow,
  setTableColumnAlignment,
} from "./tableActions";

type TableLayout = {
  toolbarX: number;
  toolbarY: number;
  rowControlX: number;
  rowControlY: number;
  rowSelectX: number;
  columnControlX: number;
  columnControlY: number;
  columnSelectX: number;
  columnSelectY: number;
  alignment: Alignment;
  headerRow: boolean;
  cellSelection: boolean;
};

type Alignment = "left" | "center" | "right" | null;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.max(minimum, Math.min(value, maximum));
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
  if (tableRect.bottom < 0 || tableRect.top > window.innerHeight) return null;

  return {
    toolbarX: clamp(tableRect.left + tableRect.width / 2, 8, window.innerWidth - 8),
    toolbarY: Math.max(8, tableRect.top - 46),
    rowControlX: clamp(rowRect.left - 28, 8, window.innerWidth - 32),
    rowControlY: clamp(rowRect.top + rowRect.height / 2 - 12, 8, window.innerHeight - 32),
    rowSelectX: clamp(rowRect.left - 52, 8, window.innerWidth - 32),
    columnControlX: clamp(cellRect.left + cellRect.width / 2 - 12, 8, window.innerWidth - 32),
    columnControlY: clamp(tableRect.top - 28, 8, window.innerHeight - 32),
    columnSelectX: clamp(tableRect.left - 28, 8, window.innerWidth - 32),
    columnSelectY: clamp(tableRect.top - 28, 8, window.innerHeight - 32),
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
  children,
}: {
  label: string;
  style: CSSProperties;
  onClick: () => void;
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
      className="pointer-events-auto fixed z-50 flex h-6 w-6 items-center justify-center rounded-full border border-cinnabar-300 bg-[var(--background)] text-cinnabar-700 shadow-sm transition hover:scale-105 hover:bg-cinnabar-50 dark:border-cinnabar-500/60 dark:text-cinnabar-300 dark:hover:bg-cinnabar-950/70"
    >
      {children ?? <Plus className="h-4 w-4" />}
    </button>
  );
}

export function TableContextToolbar({ editor }: { editor: Editor | null }) {
  const { t } = useI18n();
  const [layout, setLayout] = useState<TableLayout | null>(null);

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
        role="toolbar"
        aria-label={t.editor.toolbar.tableActions}
        style={{
          left: layout.toolbarX,
          top: layout.toolbarY,
          transform: "translateX(-50%)",
          maxWidth: "calc(100vw - 16px)",
        }}
        className="pointer-events-auto fixed z-50 flex flex-wrap items-center justify-center gap-0.5 rounded-xl border border-black/10 bg-[var(--background)]/95 p-1 shadow-lg backdrop-blur dark:border-white/15"
      >
        <ActionButton
          label={t.editor.toolbar.tableAddRowBefore}
          onClick={() => run(() => editor.commands.addRowBefore())}
        >
          <ArrowUp className="h-4 w-4" />
        </ActionButton>
        <ActionButton
          label={t.editor.toolbar.tableAddRow}
          onClick={() => run(() => editor.commands.addRowAfter())}
        >
          <ArrowDown className="h-4 w-4" />
        </ActionButton>
        <ActionButton
          label={t.editor.toolbar.tableAddColumnBefore}
          onClick={() => run(() => editor.commands.addColumnBefore())}
        >
          <ArrowLeft className="h-4 w-4" />
        </ActionButton>
        <ActionButton
          label={t.editor.toolbar.tableAddColumn}
          onClick={() => run(() => editor.commands.addColumnAfter())}
        >
          <ArrowRight className="h-4 w-4" />
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
        style={{ left: layout.rowSelectX, top: layout.rowControlY }}
        onClick={() => selectCurrentTableRow(editor)}
      >
        <GripVertical className="h-4 w-4" />
      </EdgeButton>
      <EdgeButton
        label={t.editor.toolbar.tableAddRow}
        style={{ left: layout.rowControlX, top: layout.rowControlY }}
        onClick={() => run(() => editor.commands.addRowAfter())}
      />
      <EdgeButton
        label={t.editor.toolbar.tableSelectColumn}
        style={{ left: layout.columnSelectX, top: layout.columnSelectY }}
        onClick={() => selectCurrentTableColumn(editor)}
      >
        <GripHorizontal className="h-4 w-4" />
      </EdgeButton>
      <EdgeButton
        label={t.editor.toolbar.tableAddColumn}
        style={{ left: layout.columnControlX, top: layout.columnControlY }}
        onClick={() => run(() => editor.commands.addColumnAfter())}
      />
    </>
  );
}
