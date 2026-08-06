import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder as FolderIcon,
  FolderOpen,
  Trash2,
} from "lucide-react";
import { useI18n, type Locale } from "../../i18n";
import type { DocNode, TreeFolder } from "./tree";

const DATE_LOCALE: Record<Locale, string> = {
  en: "en-US",
  zh: "zh-CN",
  fr: "fr-FR",
  ja: "ja-JP",
};

/** 每层缩进的像素。用 padding 而非 margin —— 整行都要可点、可放置 */
const INDENT = 12;

export type DragPayload =
  | { kind: "doc"; id: string }
  | { kind: "folder"; id: string };

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
  expanded: Set<string>;
  onToggle: (folderId: string) => void;
  onSelectDoc: (docId: string) => void;
  onDeleteDoc: (docId: string, title: string) => void;
  onRenameFolder: (folderId: string, name: string) => void;
  onDeleteFolder: (folderId: string, name: string) => void;
  /** 拖放：null 目标表示根 */
  onDrop: (payload: DragPayload, targetFolderId: string | null) => void;
  /** 当前是否允许放到这个文件夹上。用于抑制无效目标的高亮 */
  canDropOn: (payload: DragPayload, targetFolderId: string | null) => boolean;
  dragging: DragPayload | null;
  setDragging: (p: DragPayload | null) => void;
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
  const [over, setOver] = useState(false);
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
  const acceptsDrop = h.dragging ? h.canDropOn(h.dragging, folder.folderId) : false;

  function commitRename() {
    setEditing(false);
    const next = draft.trim();
    if (next !== folder.name) h.onRenameFolder(folder.folderId, next);
  }

  return (
    <li>
      <div
        // 整行都是放置区。只给图标的话命中率太低，拖起来很难受
        onDragOver={(e) => {
          if (!acceptsDrop) return;
          e.preventDefault(); // 不调用它，浏览器不会触发 drop
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (h.dragging && acceptsDrop) h.onDrop(h.dragging, folder.folderId);
        }}
        draggable={!editing}
        onDragStart={() => h.setDragging({ kind: "folder", id: folder.folderId })}
        onDragEnd={() => h.setDragging(null)}
        className={`group relative flex items-center rounded-lg transition ${
          over && acceptsDrop
            ? "bg-sky-100 ring-1 ring-sky-400 dark:bg-sky-900/40"
            : "hover:bg-black/5 dark:hover:bg-white/10"
        }`}
        style={{ paddingLeft: depth * INDENT }}
      >
        <button
          type="button"
          onClick={() => h.onToggle(folder.folderId)}
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
            <FolderOpen className="h-3.5 w-3.5 shrink-0 text-sky-600 dark:text-sky-400" />
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
              className="min-w-0 flex-1 rounded border border-sky-400 bg-[var(--background)] px-1 text-sm outline-none"
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
        <ul>
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

  return (
    <li
      className="group relative"
      draggable
      onDragStart={() => h.setDragging({ kind: "doc", id: doc.docId })}
      onDragEnd={() => h.setDragging(null)}
    >
      <button
        type="button"
        onClick={() => h.onSelectDoc(doc.docId)}
        aria-current={active ? "true" : undefined}
        className={`flex w-full items-start gap-2 rounded-lg py-1.5 pr-8 text-left transition ${
          active
            ? "bg-sky-50 text-sky-800 dark:bg-sky-950/50 dark:text-sky-200"
            : "text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/10"
        }`}
        style={{ paddingLeft: depth * INDENT + 8 }}
      >
        <FileText
          className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${
            active ? "text-sky-600 dark:text-sky-400" : "text-neutral-400"
          }`}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{title}</span>
          {doc.updatedAt && (
            <span className="mt-0.5 block text-[11px] text-neutral-400">
              {new Date(doc.updatedAt).toLocaleDateString(DATE_LOCALE[locale])}
            </span>
          )}
        </span>
      </button>

      {/* 删除按钮：悬停或键盘聚焦时出现，避免误触 */}
      <button
        type="button"
        onClick={() => h.onDeleteDoc(doc.docId, title)}
        aria-label={t.editor.deleteDocument}
        title={t.editor.deleteDocument}
        className="absolute right-1 top-1.5 flex h-6 w-6 items-center justify-center rounded-md text-neutral-400 opacity-0 transition hover:bg-red-50 hover:text-red-600 focus:opacity-100 group-hover:opacity-100 dark:hover:bg-red-950/40 dark:hover:text-red-400"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}
