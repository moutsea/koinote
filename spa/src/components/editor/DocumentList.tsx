import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  CalendarRange,
  ChevronLeft,
  FilePlus,
  FolderCog,
  FolderPlus,
  LoaderCircle,
  Pencil,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";
import type { ApplyDocumentOrganizationResult } from "../../documentOrganizer";
import { interpolate, useI18n } from "../../i18n";
import type { DocumentSummary, Folder } from "../../documents";
import { IMPORT_FILE_ACCEPT } from "../../documentTransferCore";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import {
  buildDocumentOrganizationPlan,
  countDocumentOrganizationMoves,
  type DocumentOrganizationPlan,
  type DocumentOrganizerStrategy,
} from "./documentOrganizerCore";
import { buildTree, canCreateSubfolder, canDropDoc, canDropFolder } from "./tree";
import {
  FolderRow,
  DocRow,
  type DragPayload,
  type MenuTarget,
  type TreeRowHandlers,
} from "./TreeRow";

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
  importing,
  onImport,
  notice,
  error,
  onOrganize,
  autoEditFolderId,
  onAutoEditDone,
}: {
  documents: DocumentSummary[];
  folders: Folder[];
  activeDocId?: string;
  loading: boolean;
  creating: boolean;
  /** 文件夹的增删改移任何一步失败都落在这里。静默失败会让用户以为按钮坏了 */
  error?: string | null;
  autoEditFolderId?: string | null;
  onAutoEditDone?: () => void;
  onSelect: (docId: string) => void;
  /** folderId 为 null 时建在根下 */
  onCreate: (folderId?: string | null) => void;
  onCreateFolder: (parentFolderId?: string | null) => void;
  onDelete: (docId: string, title: string) => void;
  onRenameFolder: (folderId: string, name: string) => void;
  onDeleteFolder: (folderId: string, name: string) => void;
  onMoveDoc: (docId: string, folderId: string | null) => void;
  onMoveFolder: (folderId: string, parentFolderId: string | null) => void;
  onCollapse: () => void;
  importing: boolean;
  onImport: (files: File[]) => void;
  notice?: string | null;
  onOrganize: (
    plan: DocumentOrganizationPlan,
  ) => Promise<ApplyDocumentOrganizationResult>;
}) {
  const { locale, t } = useI18n();
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const organizerMenuRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [dragging, setDragging] = useState<DragPayload | null>(null);
  const [rootOver, setRootOver] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; target: MenuTarget } | null>(
    null,
  );
  /**
   * 菜单里点「重命名」时要进入的那一行。
   *
   * 复用 TreeRow 已有的行内改名态，而不是给 EditorPage 再加一个回调：新建文件夹走的
   * 就是这条路（autoEditFolderId），菜单只是它的第二个触发源。菜单里另开一个输入框
   * 会变成两套编辑入口。
   */
  const [renameRequestId, setRenameRequestId] = useState<string | null>(null);
  const [organizerMenuOpen, setOrganizerMenuOpen] = useState(false);
  const [pendingOrganizerStrategy, setPendingOrganizerStrategy] =
    useState<DocumentOrganizerStrategy | null>(null);
  const [organizingStrategy, setOrganizingStrategy] =
    useState<DocumentOrganizerStrategy | null>(null);

  const tree = useMemo(() => buildTree(folders, documents), [folders, documents]);
  const organizerPlans = useMemo(() => {
    const labels = t.editor.organizer;
    const sharedLabels = {
      unknownDate: labels.unknownDate,
      weekOfMonth: labels.weekOfMonth,
      activityRecent7: labels.activityRecent7,
      activityRecent30: labels.activityRecent30,
      activityRecent90: labels.activityRecent90,
      activityInactive: labels.activityInactive,
      activityArchive: labels.activityArchive,
    };
    const now = new Date();
    return {
      smart: buildDocumentOrganizationPlan(
        documents,
        folders,
        "smart",
        locale,
        sharedLabels,
        now,
      ),
      activity: buildDocumentOrganizationPlan(
        documents,
        folders,
        "activity",
        locale,
        sharedLabels,
        now,
      ),
    };
  }, [documents, folders, locale, t.editor.organizer]);
  const organizerMoveCounts = useMemo(
    () => ({
      smart: countDocumentOrganizationMoves(
        organizerPlans.smart,
        documents,
        folders,
      ),
      activity: countDocumentOrganizationMoves(
        organizerPlans.activity,
        documents,
        folders,
      ),
    }),
    [documents, folders, organizerPlans],
  );

  const closeOrganizerMenu = useCallback(() => {
    setOrganizerMenuOpen(false);
    setPendingOrganizerStrategy(null);
  }, []);

  useEffect(() => {
    if (!organizerMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!organizerMenuRef.current?.contains(event.target as Node)) {
        closeOrganizerMenu();
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeOrganizerMenu();
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [closeOrganizerMenu, organizerMenuOpen]);

  const organize = useCallback(
    async (strategy: DocumentOrganizerStrategy) => {
      if (organizingStrategy) return;
      const plan = organizerPlans[strategy];
      if (plan.documentCount === 0) return;
      closeOrganizerMenu();
      setOrganizingStrategy(strategy);
      try {
        await onOrganize(plan);
      } catch {
        // EditorPage 已负责显示具体失败提示。
      } finally {
        setOrganizingStrategy(null);
      }
    },
    [closeOrganizerMenu, onOrganize, organizerPlans, organizingStrategy],
  );

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

  const openMenu = useCallback((e: React.MouseEvent, target: MenuTarget) => {
    e.preventDefault();
    // 行上的右键不能冒泡到滚动区，否则会被根菜单接走
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, target });
  }, []);

  const closeMenu = useCallback(() => setMenu(null), []);

  /** 新建后把目标文件夹展开，否则新东西建在折叠的文件夹里，看起来像没成功 */
  const revealIn = useCallback((folderId: string | null) => {
    if (folderId) setExpanded((prev) => new Set(prev).add(folderId));
  }, []);

  const menuTargetId =
    menu?.target.kind === "folder"
      ? menu.target.folderId
      : menu?.target.kind === "doc"
        ? menu.target.docId
        : null;

  const handlers: TreeRowHandlers = {
    activeDocId,
    // 新建后的自动改名和菜单里的手动改名进的是同一个态
    autoEditFolderId: autoEditFolderId ?? renameRequestId,
    onAutoEditDone: () => {
      setRenameRequestId(null);
      onAutoEditDone?.();
    },
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
    onContextMenu: openMenu,
    menuTargetId,
  };

  /**
   * 三种右键目标都能「在这里新建」，只是「这里」指的容器不同：
   * 文件夹行指它自己，文档行指它所在的文件夹（要的是同级），空白处指根。
   *
   * containerDepth 是容器的 0-based 层号，根是 -1。到了深度上限就把「新建子文件夹」
   * 置灰 —— 点了报错不如点不动。深度换算见 canCreateSubfolder。
   */
  function createItems(
    containerId: string | null,
    containerDepth: number,
  ): ContextMenuItem[] {
    const inFolder = containerId !== null;
    return [
      {
        key: "new-doc",
        label: inFolder ? t.editor.newDocumentHere : t.editor.newDocument,
        icon: <FilePlus className="h-3.5 w-3.5" />,
        onSelect: () => {
          revealIn(containerId);
          onCreate(containerId);
        },
      },
      {
        key: "new-folder",
        label: inFolder ? t.editor.newSubfolder : t.editor.newFolder,
        icon: <FolderPlus className="h-3.5 w-3.5" />,
        disabled: !canCreateSubfolder(containerDepth),
        onSelect: () => {
          revealIn(containerId);
          onCreateFolder(containerId);
        },
      },
    ];
  }

  function menuItems(target: MenuTarget): ContextMenuItem[] {
    if (target.kind === "folder") {
      return [
        ...createItems(target.folderId, target.depth),
        {
          key: "rename",
          label: t.editor.renameFolder,
          icon: <Pencil className="h-3.5 w-3.5" />,
          onSelect: () => setRenameRequestId(target.folderId),
        },
        {
          key: "delete",
          label: t.editor.deleteFolder,
          icon: <Trash2 className="h-3.5 w-3.5" />,
          danger: true,
          onSelect: () => onDeleteFolder(target.folderId, target.name),
        },
      ];
    }

    if (target.kind === "doc") {
      // 文档渲染在 depth，装着它的文件夹就在 depth - 1；根下的文档容器是 null
      return [
        ...createItems(target.folderId, target.depth - 1),
        {
          key: "delete",
          label: t.editor.deleteDocument,
          icon: <Trash2 className="h-3.5 w-3.5" />,
          danger: true,
          onSelect: () => onDelete(target.docId, target.title),
        },
      ];
    }

    return createItems(null, -1);
  }

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
          onClick={() => onCreateFolder(null)}
          aria-label={t.editor.newFolder}
          title={t.editor.newFolder}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-neutral-500 transition hover:bg-black/5 hover:text-neutral-900 dark:hover:bg-white/10 dark:hover:text-white"
        >
          <FolderPlus className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => onCreate(null)}
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

      <div className="px-3 pb-2">
        <input
          ref={importInputRef}
          type="file"
          accept={IMPORT_FILE_ACCEPT}
          multiple
          className="hidden"
          onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            if (files.length > 0) onImport(files);
          }}
        />
        <button
          type="button"
          disabled={importing}
          onClick={() => importInputRef.current?.click()}
          className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed px-2 py-2 text-xs font-medium text-neutral-500 transition hover:border-cinnabar-400 hover:bg-cinnabar-50/60 hover:text-cinnabar-700 disabled:opacity-50 dark:border-white/10 dark:text-neutral-400 dark:hover:border-cinnabar-500/60 dark:hover:bg-cinnabar-950/30 dark:hover:text-cinnabar-300"
          title={t.transfer.importHint}
        >
          {importing ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Upload className="h-3.5 w-3.5" />
          )}
          {t.transfer.importButton}
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
        // 空白处右键 = 根菜单。行上的右键已经 stopPropagation，不会走到这里
        onContextMenu={(e) => openMenu(e, { kind: "root" })}
        className={`min-h-0 flex-1 overflow-y-auto px-2 pb-2 ${
          // 500 而不是 400，理由同 TreeRow：拖放落点提示要够 3:1
          rootOver && rootAcceptsDrop ? "rounded-lg ring-1 ring-inset ring-cinnabar-500" : ""
        }`}
      >
        {error && (
          <p
            role="alert"
            className="mb-1 rounded-lg bg-red-50 px-2 py-1.5 text-[11px] leading-relaxed text-red-600 dark:bg-red-950/40 dark:text-red-400"
          >
            {error}
          </p>
        )}

        {notice && !error && (
          <p
            role="status"
            className="mb-1 rounded-lg bg-emerald-50 px-2 py-1.5 text-[11px] leading-relaxed text-emerald-700 dark:bg-emerald-950/30 dark:text-emerald-300"
          >
            {notice}
          </p>
        )}

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
          <div className="mt-1 rounded-lg border border-dashed border-cinnabar-500 px-2 py-2 text-center text-[11px] text-cinnabar-600 dark:text-cinnabar-400">
            {t.editor.dropToRoot}
          </div>
        )}
      </div>

      <div
        ref={organizerMenuRef}
        className="relative border-t border-black/5 p-2 dark:border-white/10"
      >
        {organizerMenuOpen && (
          <div
            role="menu"
            aria-label={t.editor.organizer.button}
            className="absolute bottom-full left-2 right-2 z-30 mb-2 space-y-1 rounded-xl border border-black/10 bg-white p-1.5 shadow-xl dark:border-white/10 dark:bg-neutral-900"
          >
            {pendingOrganizerStrategy ? (
              <OrganizerConfirmation
                title={
                  pendingOrganizerStrategy === "smart"
                    ? t.editor.organizer.smartTitle
                    : t.editor.organizer.activityTitle
                }
                summary={interpolate(t.editor.organizer.confirmSummary, {
                  documents: organizerMoveCounts[pendingOrganizerStrategy],
                  folders: organizerPlans[pendingOrganizerStrategy].folderCount,
                })}
                note={t.editor.organizer.rootOnly}
                upToDate={t.editor.organizer.upToDate}
                moveCount={organizerMoveCounts[pendingOrganizerStrategy]}
                cancelLabel={t.editor.organizer.cancel}
                applyLabel={t.editor.organizer.apply}
                onCancel={() => setPendingOrganizerStrategy(null)}
                onConfirm={() => void organize(pendingOrganizerStrategy)}
              />
            ) : (
              <>
                <OrganizerMenuItem
                  icon={<CalendarRange className="h-4 w-4" />}
                  title={t.editor.organizer.smartTitle}
                  description={t.editor.organizer.smartDescription}
                  disabled={organizerPlans.smart.documentCount === 0}
                  onSelect={() => setPendingOrganizerStrategy("smart")}
                />
                <OrganizerMenuItem
                  icon={<Activity className="h-4 w-4" />}
                  title={t.editor.organizer.activityTitle}
                  description={t.editor.organizer.activityDescription}
                  disabled={organizerPlans.activity.documentCount === 0}
                  onSelect={() => setPendingOrganizerStrategy("activity")}
                />
              </>
            )}
          </div>
        )}
        <button
          type="button"
          onClick={() => {
            if (organizerMenuOpen) closeOrganizerMenu();
            else setOrganizerMenuOpen(true);
          }}
          disabled={loading || organizerPlans.smart.documentCount === 0 || Boolean(organizingStrategy)}
          aria-haspopup="menu"
          aria-expanded={organizerMenuOpen}
          className="flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-medium text-neutral-500 transition hover:bg-black/5 hover:text-neutral-900 disabled:opacity-50 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-white"
        >
          {organizingStrategy ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <FolderCog className="h-3.5 w-3.5" />
          )}
          {organizingStrategy
            ? t.editor.organizer.organizing
            : t.editor.organizer.button}
        </button>
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.target)}
          onClose={closeMenu}
          ariaLabel={t.editor.treeMenu}
        />
      )}
    </div>
  );
}

function OrganizerMenuItem({
  icon,
  title,
  description,
  disabled,
  onSelect,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={() => onSelect()}
      className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition hover:bg-black/5 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-white/10"
    >
      <span className="mt-0.5 text-neutral-500 dark:text-neutral-400">
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-medium text-neutral-800 dark:text-neutral-100">
          {title}
        </span>
        <span className="mt-0.5 block text-[11px] leading-4 text-neutral-500">
          {description}
        </span>
      </span>
    </button>
  );
}

function OrganizerConfirmation({
  title,
  summary,
  note,
  upToDate,
  moveCount,
  cancelLabel,
  applyLabel,
  onCancel,
  onConfirm,
}: {
  title: string;
  summary: string;
  note: string;
  upToDate: string;
  moveCount: number;
  cancelLabel: string;
  applyLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="px-2 py-1.5">
      <p className="text-xs font-semibold text-neutral-800 dark:text-neutral-100">
        {title}
      </p>
      <p className="mt-1 text-[11px] leading-4 text-neutral-500">
        {moveCount > 0 ? summary : upToDate}
      </p>
      {moveCount > 0 && (
        <p className="mt-2 rounded-lg bg-black/[0.03] px-2 py-1.5 text-[10px] leading-4 text-neutral-500 dark:bg-white/[0.05]">
          {note}
        </p>
      )}
      <div className="mt-2 flex justify-end gap-1.5">
        <button
          type="button"
          role="menuitem"
          onClick={onCancel}
          className="rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-neutral-500 transition hover:bg-black/5 dark:hover:bg-white/10"
        >
          {cancelLabel}
        </button>
        {moveCount > 0 && (
          <button
            type="button"
            role="menuitem"
            onClick={onConfirm}
            className="rounded-lg bg-neutral-900 px-2.5 py-1.5 text-[11px] font-medium text-white transition hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-white"
          >
            {applyLabel}
          </button>
        )}
      </div>
    </div>
  );
}
