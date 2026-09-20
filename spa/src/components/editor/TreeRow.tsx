import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder as FolderIcon,
  FolderOpen,
  GripVertical,
  Loader2,
  Pencil,
  Trash2,
} from "lucide-react";
import { useI18n, type Locale } from "../../i18n";
import { docPad, folderPad, guideX } from "./indent";
import type { DocNode, TreeFolder } from "./tree";
import { treeSelectionKey, type TreeSelectionItem } from "./treeSelection";
import {
  hasExternalFileDrag,
  markdownFilesFromDataTransfer,
  readTreeDragPayload,
  sameTreeDragPayload,
  writeTreeDragPayload,
  type DragPayload,
} from "./treeDrag";

export type { DragPayload } from "./treeDrag";

type DragHover = { payload: DragPayload; local: boolean };

const DATE_LOCALE: Record<Locale, string> = {
  en: "en-US",
  zh: "zh-CN",
  fr: "fr-FR",
  ja: "ja-JP",
};

// 缩进用 padding 而非 margin —— 整行都要可点、可放置。具体数值见 ./indent

/**
 * 右键菜单指向的对象。root 是侧栏空白处。
 *
 * depth 都是渲染用的 0-based 层号，菜单靠它判断「再建一层会不会超出深度上限」。
 * 文档带上 folderId 是为了让「新建」落在它所在的那个文件夹里，而不是根下 ——
 * 右键一篇文档要新建时，想要的是它的同级。
 */
export type MenuTarget =
  | { kind: "root" }
  | { kind: "folder"; folderId: string; name: string; depth: number }
  | {
      kind: "doc";
      docId: string;
      title: string;
      folderId: string | null;
      depth: number;
    };

export type TreeRowHandlers = {
  activeDocId?: string;
  /**
   * 刚建出来的文件夹，直接进入改名态。
   *
   * 新建时名字是空的，行上只显示「未命名文件夹」—— 不自动聚焦的话，用户得先猜到
   * 「双击可以改名」。加上后端失败时也没提示，整件事看起来就像按钮没反应。
   */
  autoEditFolderId?: string | null;
  onAutoEditDone?: () => void;
  autoEditDocId?: string | null;
  onDocEditStarted?: () => void;
  onRenameDoc: (docId: string, title: string) => Promise<boolean>;
  expanded: Set<string>;
  onToggle: (folderId: string) => void;
  onSelectDoc: (docId: string) => void;
  selectedKeys: Set<string>;
  displayedSelectedKeys: Set<string>;
  dragSelection: TreeSelectionItem[];
  onSelectItem: (
    item: TreeSelectionItem,
    event: React.MouseEvent | React.KeyboardEvent,
  ) => void;
  onDeleteDoc: (docId: string, title: string) => void;
  onRenameFolder: (folderId: string, name: string) => void;
  onDeleteFolder: (folderId: string, name: string) => void;
  /** 拖放：null 目标表示根 */
  onDrop: (payload: DragPayload, targetFolderId: string | null) => void;
  onReorderDoc: (
    payload: DragPayload,
    targetDocId: string,
    position: "before" | "after",
  ) => void;
  canReorderDoc: (payload: DragPayload, targetDocId: string) => boolean;
  /** 当前是否允许放到这个文件夹上。用于抑制无效目标的高亮 */
  canDropOn: (payload: DragPayload, targetFolderId: string | null) => boolean;
  dragging: DragPayload | null;
  setDragging: (p: DragPayload | null) => void;
  onImportFiles: (files: File[], targetFolderId: string | null) => void;
  /** 右键。在行上按下时要阻止冒泡，否则会被空白处的根菜单接走 */
  onContextMenu: (e: React.MouseEvent, target: MenuTarget) => void;
  /** 菜单当前指向的行，用来给它加一个持续的高亮 */
  menuTargetId?: string | null;
};

export function FolderRow({
  folder,
  depth,
  h,
}: {
  folder: TreeFolder;
  depth: number;
  h: TreeRowHandlers;
}) {
  const { t } = useI18n();
  const open = h.expanded.has(folder.folderId);
  const [overDrag, setOverDrag] = useState<DragHover | null>(null);
  const [fileDragOver, setFileDragOver] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(folder.name);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  // 刚建出来的那个直接进改名态。清掉标记，避免每次渲染都重新进入
  useEffect(() => {
    if (h.autoEditFolderId === folder.folderId) {
      setDraft(folder.name);
      setEditing(true);
      h.onAutoEditDone?.();
    }
  }, [h.autoEditFolderId, folder.folderId, folder.name, h]);

  const name = folder.name.trim() || t.editor.untitledFolder;
  const hoverPayload = h.dragging ?? overDrag?.payload;
  const acceptsDrop = hoverPayload
    ? h.canDropOn(hoverPayload, folder.folderId)
    : false;
  // 菜单打开时这一行保持高亮：菜单在指针位置弹出，不标出来的话看不清操作的是哪一行
  const menuOpen = h.menuTargetId === folder.folderId;
  const selected = h.selectedKeys.has(treeSelectionKey({ kind: "folder", id: folder.folderId }));
  const displayedSelected = h.displayedSelectedKeys.has(
    treeSelectionKey({ kind: "folder", id: folder.folderId }),
  );

  function commitRename() {
    setEditing(false);
    const next = draft.trim();
    if (next !== folder.name) h.onRenameFolder(folder.folderId, next);
  }

  return (
    <li
      role="treeitem"
      aria-selected={selected}
      aria-expanded={open}
    >
      <div
        // 整行都是放置区。只给图标的话命中率太低，拖起来很难受
        onDragOver={(e) => {
          e.stopPropagation();
          if (hasExternalFileDrag(e.dataTransfer)) {
            e.preventDefault();
            setFileDragOver(true);
            return;
          }
          const payload = readTreeDragPayload(e.dataTransfer) ?? h.dragging;
          if (!payload || !h.canDropOn(payload, folder.folderId)) return;
          e.preventDefault(); // 不调用它，浏览器不会触发 drop
          const local = h.dragging !== null;
          setOverDrag((current) =>
            current &&
            current.local === local &&
            sameTreeDragPayload(current.payload, payload)
              ? current
              : { payload, local },
          );
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setOverDrag(null);
          setFileDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOverDrag(null);
          setFileDragOver(false);
          const files = markdownFilesFromDataTransfer(e.dataTransfer);
          if (files.length > 0) {
            h.onImportFiles(files, folder.folderId);
            return;
          }
          const payload = readTreeDragPayload(e.dataTransfer) ?? h.dragging;
          if (payload && h.canDropOn(payload, folder.folderId)) {
            h.onDrop(payload, folder.folderId);
          }
        }}
        draggable={!editing}
        onDragStart={(e) => {
          const selected = h.dragSelection;
          const payload: DragPayload =
            selected.length > 1 && selected.some(
              (item) => item.kind === "folder" && item.id === folder.folderId,
            )
              ? { kind: "folder", id: folder.folderId, selection: selected }
              : { kind: "folder", id: folder.folderId };
          writeTreeDragPayload(e.dataTransfer, payload);
          h.setDragging(payload);
        }}
        onDragEnd={() => h.setDragging(null)}
        onContextMenu={(e) =>
          h.onContextMenu(e, {
            kind: "folder",
            folderId: folder.folderId,
            name,
            depth,
          })
        }
        data-tree-item
        data-tree-item-key={treeSelectionKey({ kind: "folder", id: folder.folderId })}
        className={`group relative flex items-center rounded-lg transition ${
          fileDragOver ||
          (overDrag !== null &&
            acceptsDrop &&
            (!overDrag.local || sameTreeDragPayload(overDrag.payload, h.dragging)))
            // 拖放目标环用 500 而不是 400：400 压在宣纸上只有 2.47:1，
            // 达不到非文字元素的 3:1。这个环是拖拽时唯一的落点提示，看不见就等于没有
            ? "bg-cinnabar-100 ring-1 ring-cinnabar-500 dark:bg-cinnabar-900/40"
            : displayedSelected
              ? "bg-cinnabar-100/80 ring-1 ring-inset ring-cinnabar-600 dark:bg-cinnabar-900/60 dark:ring-cinnabar-500"
              : menuOpen
              ? "bg-black/5 dark:bg-white/10"
              : "hover:bg-black/5 dark:hover:bg-white/10"
        }`}
        style={{ paddingLeft: folderPad(depth) }}
      >
        <button
          type="button"
          onClick={(event) => {
            const item = { kind: "folder", id: folder.folderId } as const;
            h.onSelectItem(item, event);
            if (!event.shiftKey && !event.ctrlKey && !event.metaKey) {
              h.onToggle(folder.folderId);
            }
          }}
          onKeyDown={(event) => {
            if (
              (event.key === " " || event.key === "Enter") &&
              (event.shiftKey || event.ctrlKey || event.metaKey)
            ) {
              event.preventDefault();
              h.onSelectItem({ kind: "folder", id: folder.folderId }, event);
            }
          }}
          aria-label={name}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-left"
        >
          {open ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-neutral-400" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-neutral-400" />
          )}
          {open ? (
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-cinnabar-600 dark:text-cinnabar-400" />
          ) : (
            <FolderIcon className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
          )}
          {editing ? (
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") {
                  setDraft(folder.name);
                  setEditing(false);
                }
              }}
              onClick={(e) => e.stopPropagation()}
              placeholder={t.editor.folderNamePlaceholder}
              aria-label={t.editor.folderNamePlaceholder}
              // 500 而不是 400：这是重命名输入框唯一的边界提示，需要 3:1
              className="min-w-0 flex-1 rounded border border-cinnabar-500 bg-[var(--background)] px-1 text-sm outline-none"
            />
          ) : (
            <span
              className="min-w-0 flex-1 truncate text-sm text-neutral-700 dark:text-neutral-200"
              onDoubleClick={(e) => {
                e.stopPropagation();
                setDraft(folder.name);
                setEditing(true);
              }}
            >
              {name}
            </span>
          )}
        </button>

        {!editing && (
          <span className="absolute right-1 flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
            <button
              type="button"
              onClick={() => {
                setDraft(folder.name);
                setEditing(true);
              }}
              aria-label={t.editor.renameFolder}
              title={t.editor.renameFolder}
              className="flex h-6 w-6 items-center justify-center rounded-md text-[11px] text-neutral-400 hover:bg-black/10 hover:text-neutral-700 dark:hover:bg-white/15 dark:hover:text-neutral-200"
            >
              ✎
            </button>
            <button
              type="button"
              onClick={() => h.onDeleteFolder(folder.folderId, name)}
              aria-label={t.editor.deleteFolder}
              title={t.editor.deleteFolder}
              className="flex h-6 w-6 items-center justify-center rounded-md text-neutral-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-400"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </span>
        )}
      </div>

      {open && (
        <ul role="group" className="relative">
          {/* 竖线落在本行 chevron 的中心，把子项在视觉上收到这个文件夹下面 */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-y-0 w-px bg-black/10 dark:bg-white/10"
            style={{ left: guideX(depth) }}
          />
          {folder.folders.map((child) => (
            <FolderRow key={child.folderId} folder={child} depth={depth + 1} h={h} />
          ))}
          {folder.docs.map((docNode) => (
            <DocRow key={docNode.docId} doc={docNode} depth={depth + 1} h={h} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function DocRow({
  doc,
  depth,
  h,
}: {
  doc: DocNode;
  depth: number;
  h: TreeRowHandlers;
}) {
  const { t, locale } = useI18n();
  const title = doc.title.trim() || t.editor.untitled;
  const active = doc.docId === h.activeDocId;
  const menuOpen = h.menuTargetId === doc.docId;
  const selected = h.selectedKeys.has(treeSelectionKey({ kind: "doc", id: doc.docId }));
  const displayedSelected = h.displayedSelectedKeys.has(
    treeSelectionKey({ kind: "doc", id: doc.docId }),
  );
  const [dropPosition, setDropPosition] = useState<"before" | "after" | null>(null);
  const [fileDragOver, setFileDragOver] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(doc.title);
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const editingRef = useRef(false);
  const renameBusyRef = useRef(false);
  const originalTitleRef = useRef(doc.title);

  function beginRename() {
    if (renameBusyRef.current) return;
    originalTitleRef.current = doc.title;
    setDraft(doc.title);
    editingRef.current = true;
    setEditing(true);
    setRenameError(false);
  }

  useEffect(() => {
    if (h.autoEditDocId === doc.docId) {
      beginRename();
      h.onDocEditStarted?.();
    }
  }, [h.autoEditDocId, doc.docId]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  async function commitRename() {
    if (!editingRef.current || renameBusyRef.current) return;
    const next = draft.trim();
    if (!next || (next === originalTitleRef.current.trim() && !renameError)) {
      editingRef.current = false;
      setEditing(false);
      return;
    }
    renameBusyRef.current = true;
    setRenaming(true);
    setRenameError(false);
    try {
      const saved = await h.onRenameDoc(doc.docId, next);
      if (saved) {
        editingRef.current = false;
        setEditing(false);
      } else {
        setRenameError(true);
      }
    } catch {
      setRenameError(true);
    } finally {
      renameBusyRef.current = false;
      setRenaming(false);
    }
  }

  return (
    <li
      role="treeitem"
      aria-selected={selected}
      data-tree-item
      data-tree-item-key={treeSelectionKey({ kind: "doc", id: doc.docId })}
      className={`group relative ${
        fileDragOver
          ? "rounded-lg ring-1 ring-inset ring-cinnabar-500"
          : displayedSelected
            ? "rounded-lg bg-cinnabar-100/80 ring-1 ring-inset ring-cinnabar-600 dark:bg-cinnabar-900/60 dark:ring-cinnabar-500"
            : ""
      }`}
      draggable={!editing}
      onKeyDown={(event) => {
        if (event.key === "F2" && !editing) {
          event.preventDefault();
          event.stopPropagation();
          beginRename();
        }
      }}
      onDragOver={(e) => {
        e.stopPropagation();
        if (hasExternalFileDrag(e.dataTransfer)) {
          e.preventDefault();
          setFileDragOver(true);
          return;
        }
        const payload = readTreeDragPayload(e.dataTransfer) ?? h.dragging;
        if (!payload || !h.canReorderDoc(payload, doc.docId)) {
          setDropPosition(null);
          return;
        }
        e.preventDefault();
        const rect = e.currentTarget.getBoundingClientRect();
        setDropPosition(e.clientY < rect.top + rect.height / 2 ? "before" : "after");
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setFileDragOver(false);
          setDropPosition(null);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setFileDragOver(false);
        const files = markdownFilesFromDataTransfer(e.dataTransfer);
        if (files.length > 0) {
          h.onImportFiles(files, doc.folderId);
          return;
        }
        const payload = readTreeDragPayload(e.dataTransfer) ?? h.dragging;
        const rect = e.currentTarget.getBoundingClientRect();
        const position = e.clientY < rect.top + rect.height / 2 ? "before" : "after";
        setDropPosition(null);
        if (payload && h.canReorderDoc(payload, doc.docId)) {
          h.onReorderDoc(payload, doc.docId, position);
        }
      }}
      onDragStart={(e) => {
        const selectedItems = h.dragSelection;
        const selectedDocIds = selectedItems
          .filter((item): item is { kind: "doc"; id: string } => item.kind === "doc")
          .map((item) => item.id);
        const payload: DragPayload =
          selectedItems.length > 1 && selectedItems.some(
            (item) => item.kind === "doc" && item.id === doc.docId,
          )
            ? { kind: "doc", id: doc.docId, ids: selectedDocIds, selection: selectedItems }
            : { kind: "doc", id: doc.docId };
        writeTreeDragPayload(e.dataTransfer, payload);
        h.setDragging(payload);
      }}
      onDragEnd={() => h.setDragging(null)}
      onContextMenu={(e) =>
        h.onContextMenu(e, {
          kind: "doc",
          docId: doc.docId,
          title,
          folderId: doc.folderId,
          depth,
        })
      }
    >
      {dropPosition && (
        <span
          aria-hidden
          className={`pointer-events-none absolute left-2 right-1 z-10 h-0.5 rounded-full bg-cinnabar-500 ${
            dropPosition === "before" ? "top-0" : "bottom-0"
          }`}
        />
      )}
      {editing ? (
        <div className="flex min-h-10 items-center gap-2 rounded-lg py-1.5 pr-2" style={{ paddingLeft: docPad(depth) }}>
          <FileText className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
          <input
            ref={inputRef}
            value={draft}
            readOnly={renaming}
            aria-label={t.editor.renameDocument}
            aria-invalid={renameError}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => void commitRename()}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === "Enter") {
                event.stopPropagation();
                event.preventDefault();
                void commitRename();
              }
              if (event.key === "Escape" && !renameBusyRef.current) {
                event.stopPropagation();
                event.preventDefault();
                editingRef.current = false;
                setEditing(false);
                setRenameError(false);
              }
            }}
            className="min-w-0 flex-1 rounded border border-cinnabar-500 bg-[var(--background)] px-1 py-0.5 text-sm outline-none"
          />
          {renaming && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-neutral-400" />}
        </div>
      ) : <button
        type="button"
        onClick={(event) => {
          const item = { kind: "doc", id: doc.docId } as const;
          h.onSelectItem(item, event);
          if (!event.shiftKey && !event.ctrlKey && !event.metaKey) {
            h.onSelectDoc(doc.docId);
          }
        }}
        onKeyDown={(event) => {
          if (
            (event.key === " " || event.key === "Enter") &&
            (event.shiftKey || event.ctrlKey || event.metaKey)
          ) {
            event.preventDefault();
            h.onSelectItem({ kind: "doc", id: doc.docId }, event);
          }
        }}
        aria-current={active ? "true" : undefined}
        onDoubleClick={beginRename}
        className={`flex w-full items-start gap-2 rounded-lg py-1.5 pr-14 text-left transition ${
          active
            ? "bg-cinnabar-50 text-cinnabar-800 dark:bg-cinnabar-950/50 dark:text-cinnabar-200"
            : menuOpen
              ? "bg-black/5 text-neutral-600 dark:bg-white/10 dark:text-neutral-300"
              : "text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/10"
        }`}
        style={{ paddingLeft: docPad(depth) }}
      >
        <GripVertical
          aria-hidden
          className="mt-0.5 h-3 w-3 shrink-0 text-neutral-300 opacity-0 transition group-hover:opacity-100 dark:text-neutral-600"
        />
        <FileText
          className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
            active ? "text-cinnabar-600 dark:text-cinnabar-400" : "text-neutral-400"
          }`}
        />
        <span className="min-w-0 flex-1">
          <span
            className="block truncate text-sm"
            onClick={(event) => {
              // 首次点击仍打开文档；已选中时，再点名称才进入重命名。
              // 图标、日期和键盘激活继续沿用整行的打开行为。
              if (!active || event.detail === 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              event.stopPropagation();
              beginRename();
            }}
          >
            {title}
          </span>
          {doc.updatedAt && (
            <span className="mt-0.5 block text-[11px] text-neutral-400">
              {new Date(doc.updatedAt).toLocaleDateString(DATE_LOCALE[locale])}
            </span>
          )}
        </span>
      </button>}

      {renameError && <p role="alert" className="px-3 pb-1 text-xs text-red-600 dark:text-red-400">{t.editor.renameDocumentFailed}</p>}

      {/* 删除按钮：悬停或键盘聚焦时出现，避免误触 */}
      {!editing && <span className="absolute right-1 top-1.5 flex items-center gap-0.5 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
      <button type="button" onClick={beginRename} aria-label={t.editor.renameDocument} title={t.editor.renameDocument} className="flex h-6 w-6 items-center justify-center rounded-md text-neutral-400 hover:bg-black/10 hover:text-neutral-700 dark:hover:bg-white/15 dark:hover:text-neutral-200">
        <Pencil className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => h.onDeleteDoc(doc.docId, title)}
        aria-label={t.editor.deleteDocument}
        title={t.editor.deleteDocument}
        className="flex h-6 w-6 items-center justify-center rounded-md text-neutral-400 transition hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40 dark:hover:text-red-400"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
      </span>}
    </li>
  );
}
