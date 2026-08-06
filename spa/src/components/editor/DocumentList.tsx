import { useCallback, useMemo, useState } from "react";
import { ChevronLeft, FolderPlus, Plus } from "lucide-react";
import { useI18n } from "../../i18n";
import type { DocumentSummary, Folder } from "../../documents";
import { buildTree, canDropDoc, canDropFolder } from "./tree";
import { FolderRow, DocRow, type DragPayload, type TreeRowHandlers } from "./TreeRow";

/**
 * 侧栏文件树。
 *
 * 拖拽用原生 HTML5 DnD 而不是引库：只需要「拖到某个文件夹上」这一种交互，不需要
 * 同层排序、不需要跨列表、不需要触摸支持 —— 原生够用，且不增加依赖。
 *
 * 原生 DnD 键盘不可达。文件夹的重命名与删除有按钮兜住，但「移动」目前只能靠拖 ——
 * 这是这一版的无障碍缺口，右键菜单「移动到…」待补。
 */
export function DocumentList({
  documents,
  folders,
  activeDocId,
  loading,
  creating,
  onSelect,
  onCreate,
  onCreateFolder,
  onDelete,
  onRenameFolder,
  onDeleteFolder,
  onMoveDoc,
  onMoveFolder,
  onCollapse,
}: {
  documents: DocumentSummary[];
  folders: Folder[];
  activeDocId?: string;
  loading: boolean;
  creating: boolean;
  onSelect: (docId: string) => void;
  onCreate: () => void;
  onCreateFolder: () => void;
  onDelete: (docId: string, title: string) => void;
  onRenameFolder: (folderId: string, name: string) => void;
  onDeleteFolder: (folderId: string, name: string) => void;
  onMoveDoc: (docId: string, folderId: string | null) => void;
  onMoveFolder: (folderId: string, parentFolderId: string | null) => void;
  onCollapse: () => void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [dragging, setDragging] = useState<DragPayload | null>(null);
  const [rootOver, setRootOver] = useState(false);

  const tree = useMemo(() => buildTree(folders, documents), [folders, documents]);

  const onToggle = useCallback((folderId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return next;
    });
  }, []);

  const canDropOn = useCallback(
    (payload: DragPayload, targetFolderId: string | null) =>
      payload.kind === "folder"
        ? canDropFolder(folders, payload.id, targetFolderId).ok
        : canDropDoc(documents, payload.id, targetFolderId).ok,
    [folders, documents],
  );

  const onDrop = useCallback(
    (payload: DragPayload, targetFolderId: string | null) => {
      setDragging(null);
      if (!canDropOn(payload, targetFolderId)) return;
      if (payload.kind === "folder") onMoveFolder(payload.id, targetFolderId);
      else onMoveDoc(payload.id, targetFolderId);
      // 放进去就展开，否则拖进去的东西「消失」了，还得自己点开才看得见
      if (targetFolderId) setExpanded((prev) => new Set(prev).add(targetFolderId));
    },
    [canDropOn, onMoveFolder, onMoveDoc],
  );

  const handlers: TreeRowHandlers = {
    activeDocId,
    expanded,
    onToggle,
    onSelectDoc: onSelect,
    onDeleteDoc: onDelete,
    onRenameFolder,
    onDeleteFolder,
    onDrop,
    canDropOn,
    dragging,
    setDragging,
  };

  const rootAcceptsDrop = dragging ? canDropOn(dragging, null) : false;
  const isEmpty = folders.length === 0 && documents.length === 0;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 px-3 py-2">
        <span className="flex-1 truncate text-xs font-semibold uppercase tracking-wide text-neutral-400">
          {t.editor.documentsPanel}
        </span>
        <button
          type="button"
          onClick={onCreateFolder}
          aria-label={t.editor.newFolder}
          title={t.editor.newFolder}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-neutral-500 transition hover:bg-black/5 hover:text-neutral-900 dark:hover:bg-white/10 dark:hover:text-white"
        >
          <FolderPlus className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onCreate}
          disabled={creating}
          aria-label={t.editor.newDocument}
          title={t.editor.newDocument}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-neutral-500 transition hover:bg-black/5 hover:text-neutral-900 disabled:opacity-50 dark:hover:bg-white/10 dark:hover:text-white"
        >
          <Plus className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={onCollapse}
          aria-label={t.editor.collapsePanel}
          aria-expanded
          title={t.editor.collapsePanel}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-neutral-400 transition hover:bg-black/5 hover:text-neutral-700 dark:hover:bg-white/10 dark:hover:text-neutral-200"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
      </div>

      {/* 整个滚动区都是「根」的放置区：拖到空白处即移出文件夹。
          提示只在拖动中显现，静止时不该有多余的框 */}
      <div
        onDragOver={(e) => {
          if (!rootAcceptsDrop) return;
          e.preventDefault(); // 不调用它浏览器不会触发 drop
          setRootOver(true);
        }}
        onDragLeave={() => setRootOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setRootOver(false);
          if (dragging && rootAcceptsDrop) onDrop(dragging, null);
        }}
        className={`min-h-0 flex-1 overflow-y-auto px-2 pb-2 ${
          rootOver && rootAcceptsDrop ? "rounded-lg ring-1 ring-inset ring-sky-400" : ""
        }`}
      >
        {loading ? (
          <p className="px-2 py-4 text-xs text-neutral-400">{t.editor.loading}</p>
        ) : isEmpty ? (
          <p className="px-2 py-4 text-xs leading-relaxed text-neutral-400">
            {t.editor.emptyDocuments}
          </p>
        ) : (
          <ul className="space-y-0.5">
            {tree.folders.map((folder) => (
              <FolderRow key={folder.folderId} folder={folder} depth={0} h={handlers} />
            ))}
            {tree.docs.map((docNode) => (
              <DocRow key={docNode.docId} doc={docNode} depth={0} h={handlers} />
            ))}
          </ul>
        )}

        {/* 拖动中给一条明确落点：内容可能占满滚动区，没有空白可拖 */}
        {dragging && rootAcceptsDrop && (
          <div className="mt-1 rounded-lg border border-dashed border-sky-400 px-2 py-2 text-center text-[11px] text-sky-600 dark:text-sky-400">
            {t.editor.dropToRoot}
          </div>
        )}
      </div>
    </div>
  );
}
