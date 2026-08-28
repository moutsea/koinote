import { useEffect, useRef, useState, type ReactNode } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListChecks,
  Table2,
  TableColumnsSplit,
  TableRowsSplit,
  Quote,
  SquareCode,
  Link as LinkIcon,
} from "lucide-react";
import { useI18n } from "../../i18n";

const HIDE_DELAY_MS = 300;

/**
 * 悬停显现的格式工具栏。
 *
 * 默认隐藏，鼠标移到编辑区顶部触发带时显现；移开后延迟隐藏，
 * 避免从触发带移向工具栏的途中闪烁。
 *
 * 两个无障碍兜底（纯 hover 会把这两类用户完全挡在外面）：
 *  1. 键盘用户没有 hover —— focusWithin 时保持显现，Tab 进来即可用。
 *  2. 触屏没有 hover —— (hover: none) 的设备直接常驻可见。
 */
export function EditorToolbar({ editor }: { editor: Editor | null }) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [alwaysVisible, setAlwaysVisible] = useState(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tableActive =
    useEditorState({
      editor,
      selector: ({ editor: currentEditor }) =>
        Boolean(currentEditor?.isActive("table")),
    }) ?? false;

  // 触屏 / 无悬停能力的设备：常驻显示
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(hover: none)");
    const sync = () => setAlwaysVisible(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, []);

  function show() {
    if (hideTimer.current) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    setHovered(true);
  }

  function scheduleHide() {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setHovered(false), HIDE_DELAY_MS);
  }

  const visible = alwaysVisible || hovered || focusWithin;

  function setLink() {
    if (!editor) return;
    const previous = editor.getAttributes("link").href as string | undefined;
    const input = window.prompt(t.editor.toolbar.linkPrompt, previous ?? "https://");
    if (input === null) return; // 用户取消
    const url = input.trim();
    if (url === "") {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  }

  return (
    <div
      className="sticky top-14 z-20"
      onMouseEnter={show}
      onMouseLeave={scheduleHide}
      onFocusCapture={() => setFocusWithin(true)}
      onBlurCapture={() => setFocusWithin(false)}
    >
      {/* 触发带：一直存在但几乎不可见，作为「顶部有东西」的视觉锚点，
          否则悬停显现的工具栏发现性太差 */}
      <div
        aria-hidden
        className={`mx-auto h-1 w-16 rounded-full transition-colors ${
          visible ? "bg-transparent" : "bg-black/10 dark:bg-white/15"
        }`}
      />

      <div
        role="toolbar"
        aria-label={t.editor.toolbar.hint}
        aria-hidden={!visible}
        className={`-mt-1 flex flex-wrap items-center justify-center gap-0.5 rounded-xl border border-black/5 bg-[var(--background)]/95 p-1 shadow-sm backdrop-blur transition-all duration-150 dark:border-white/10 ${
          visible
            ? "pointer-events-auto translate-y-0 opacity-100"
            : "pointer-events-none -translate-y-1 opacity-0"
        }`}
      >
        <Btn
          label={t.editor.toolbar.bold}
          active={editor?.isActive("bold")}
          onClick={() => editor?.chain().focus().toggleBold().run()}
          disabled={!visible}
        >
          <Bold className="h-4 w-4" />
        </Btn>
        <Btn
          label={t.editor.toolbar.italic}
          active={editor?.isActive("italic")}
          onClick={() => editor?.chain().focus().toggleItalic().run()}
          disabled={!visible}
        >
          <Italic className="h-4 w-4" />
        </Btn>
        <Btn
          label={t.editor.toolbar.strike}
          active={editor?.isActive("strike")}
          onClick={() => editor?.chain().focus().toggleStrike().run()}
          disabled={!visible}
        >
          <Strikethrough className="h-4 w-4" />
        </Btn>
        <Btn
          label={t.editor.toolbar.code}
          active={editor?.isActive("code")}
          onClick={() => editor?.chain().focus().toggleCode().run()}
          disabled={!visible}
        >
          <Code className="h-4 w-4" />
        </Btn>

        <Divider />

        <Btn
          label={t.editor.toolbar.heading1}
          active={editor?.isActive("heading", { level: 1 })}
          onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}
          disabled={!visible}
        >
          <Heading1 className="h-4 w-4" />
        </Btn>
        <Btn
          label={t.editor.toolbar.heading2}
          active={editor?.isActive("heading", { level: 2 })}
          onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
          disabled={!visible}
        >
          <Heading2 className="h-4 w-4" />
        </Btn>
        <Btn
          label={t.editor.toolbar.heading3}
          active={editor?.isActive("heading", { level: 3 })}
          onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}
          disabled={!visible}
        >
          <Heading3 className="h-4 w-4" />
        </Btn>

        <Divider />

        <Btn
          label={t.editor.toolbar.bulletList}
          active={editor?.isActive("bulletList")}
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
          disabled={!visible}
        >
          <List className="h-4 w-4" />
        </Btn>
        <Btn
          label={t.editor.toolbar.orderedList}
          active={editor?.isActive("orderedList")}
          onClick={() => editor?.chain().focus().toggleOrderedList().run()}
          disabled={!visible}
        >
          <ListOrdered className="h-4 w-4" />
        </Btn>
        <Btn
          label={t.editor.toolbar.taskList}
          active={editor?.isActive("taskList")}
          onClick={() => editor?.chain().focus().toggleTaskList().run()}
          disabled={!visible}
        >
          <ListChecks className="h-4 w-4" />
        </Btn>
        <TablePicker
          editor={editor}
          label={t.editor.toolbar.table}
          visible={visible}
          active={tableActive}
        />

        {visible && editor && tableActive && (
          <TableActions
            editor={editor}
            labels={{
              addRow: t.editor.toolbar.tableAddRow,
              addColumn: t.editor.toolbar.tableAddColumn,
              deleteRow: t.editor.toolbar.tableDeleteRow,
              deleteColumn: t.editor.toolbar.tableDeleteColumn,
            }}
          />
        )}

        <Divider />

        <Btn
          label={t.editor.toolbar.blockquote}
          active={editor?.isActive("blockquote")}
          onClick={() => editor?.chain().focus().toggleBlockquote().run()}
          disabled={!visible}
        >
          <Quote className="h-4 w-4" />
        </Btn>
        <Btn
          label={t.editor.toolbar.codeBlock}
          active={editor?.isActive("codeBlock")}
          onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
          disabled={!visible}
        >
          <SquareCode className="h-4 w-4" />
        </Btn>
        <Btn
          label={t.editor.toolbar.link}
          active={editor?.isActive("link")}
          onClick={setLink}
          disabled={!visible}
        >
          <LinkIcon className="h-4 w-4" />
        </Btn>
      </div>
    </div>
  );
}

function TableActions({
  editor,
  labels,
}: {
  editor: Editor;
  labels: {
    addRow: string;
    addColumn: string;
    deleteRow: string;
    deleteColumn: string;
  };
}) {
  const actions = [
    {
      label: labels.addRow,
      disabled: !editor.can().addRowAfter(),
      onClick: () => editor.chain().focus().addRowAfter().run(),
      icon: <TableRowsSplit className="h-4 w-4" />,
    },
    {
      label: labels.addColumn,
      disabled: !editor.can().addColumnAfter(),
      onClick: () => editor.chain().focus().addColumnAfter().run(),
      icon: <TableColumnsSplit className="h-4 w-4" />,
    },
    {
      label: labels.deleteRow,
      disabled: !editor.can().deleteRow(),
      onClick: () => editor.chain().focus().deleteRow().run(),
      icon: <TableRowsSplit className="h-4 w-4" />,
      danger: true,
    },
    {
      label: labels.deleteColumn,
      disabled: !editor.can().deleteColumn(),
      onClick: () => editor.chain().focus().deleteColumn().run(),
      icon: <TableColumnsSplit className="h-4 w-4" />,
      danger: true,
    },
  ];

  return (
    <>
      {actions.map((action) => (
        <button
          key={action.label}
          type="button"
          disabled={action.disabled}
          aria-label={action.label}
          title={action.label}
          onClick={action.onClick}
          className={`flex h-8 w-8 items-center justify-center rounded-lg transition disabled:cursor-not-allowed disabled:opacity-40 ${
            action.danger
              ? "text-red-500 hover:bg-red-50 hover:text-red-700 dark:hover:bg-red-950/40 dark:hover:text-red-300"
              : "text-neutral-500 hover:bg-black/5 hover:text-neutral-900 dark:hover:bg-white/10 dark:hover:text-white"
          }`}
        >
          {action.icon}
        </button>
      ))}
    </>
  );
}

const TABLE_PICKER_SIZE = 8;

function TablePicker({
  editor,
  label,
  visible,
  active,
}: {
  editor: Editor | null;
  label: string;
  visible: boolean;
  active: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState({ rows: 3, cols: 3 });
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const disabled = !visible || !editor || active;

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function insertTable(rows: number, cols: number) {
    if (!editor) return;
    editor
      .chain()
      .focus()
      .insertTable({ rows, cols, withHeaderRow: true })
      .run();
    setOpen(false);
  }

  function moveFocus(row: number, col: number, key: string) {
    let nextRow = row;
    let nextCol = col;
    if (key === "ArrowUp") nextRow -= 1;
    if (key === "ArrowDown") nextRow += 1;
    if (key === "ArrowLeft") nextCol -= 1;
    if (key === "ArrowRight") nextCol += 1;
    if (
      nextRow < 1 ||
      nextRow > TABLE_PICKER_SIZE ||
      nextCol < 1 ||
      nextCol > TABLE_PICKER_SIZE
    ) {
      return;
    }
    const next = pickerRef.current?.querySelector<HTMLButtonElement>(
      `[data-table-row="${nextRow}"][data-table-col="${nextCol}"]`,
    );
    next?.focus();
    setSelected({ rows: nextRow, cols: nextCol });
  }

  return (
    <div ref={pickerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-label={label}
        aria-haspopup="grid"
        aria-expanded={open}
        title={label}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        className={`flex h-8 w-8 items-center justify-center rounded-lg transition disabled:cursor-not-allowed disabled:opacity-40 ${
          open || active
            ? "bg-cinnabar-100 text-cinnabar-700 dark:bg-cinnabar-950/60 dark:text-cinnabar-300"
            : "text-neutral-500 hover:bg-black/5 hover:text-neutral-900 dark:hover:bg-white/10 dark:hover:text-white"
        }`}
      >
        <Table2 className="h-4 w-4" />
      </button>

      {open && !disabled && (
        <div
          className="absolute left-1/2 top-10 z-40 -translate-x-1/2 rounded-xl border border-black/10 bg-[var(--background)] p-2 shadow-lg dark:border-white/15"
        >
          <div
            aria-live="polite"
            className="mb-1.5 text-center text-xs font-medium tabular-nums text-neutral-600 dark:text-neutral-300"
          >
            {selected.rows} × {selected.cols}
          </div>
          <div role="grid" aria-label={label}>
            {Array.from({ length: TABLE_PICKER_SIZE }, (_, rowIndex) => {
              const row = rowIndex + 1;
              return (
                <div key={row} role="row" className="flex gap-0.5">
                  {Array.from({ length: TABLE_PICKER_SIZE }, (_, colIndex) => {
                    const col = colIndex + 1;
                    const highlighted = row <= selected.rows && col <= selected.cols;
                    return (
                      <button
                        key={col}
                        type="button"
                        role="gridcell"
                        tabIndex={row === selected.rows && col === selected.cols ? 0 : -1}
                        data-table-row={row}
                        data-table-col={col}
                        aria-label={`${row} × ${col}`}
                        aria-selected={highlighted}
                        onMouseEnter={() => setSelected({ rows: row, cols: col })}
                        onFocus={() => setSelected({ rows: row, cols: col })}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            insertTable(row, col);
                            return;
                          }
                          if (event.key.startsWith("Arrow")) {
                            event.preventDefault();
                            moveFocus(row, col, event.key);
                          }
                        }}
                        onClick={() => insertTable(row, col)}
                        className={`h-5 w-5 rounded-sm border transition ${
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

function Divider() {
  return <span aria-hidden className="mx-1 h-5 w-px bg-black/10 dark:bg-white/15" />;
}

function Btn({
  label,
  active,
  onClick,
  disabled,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      // 隐藏时移出 Tab 序列，避免焦点落进看不见的控件
      tabIndex={disabled ? -1 : 0}
      aria-label={label}
      aria-pressed={Boolean(active)}
      title={label}
      onClick={onClick}
      className={`flex h-8 w-8 items-center justify-center rounded-lg transition ${
        active
          ? "bg-cinnabar-100 text-cinnabar-700 dark:bg-cinnabar-950/60 dark:text-cinnabar-300"
          : "text-neutral-500 hover:bg-black/5 hover:text-neutral-900 dark:hover:bg-white/10 dark:hover:text-white"
      }`}
    >
      {children}
    </button>
  );
}
