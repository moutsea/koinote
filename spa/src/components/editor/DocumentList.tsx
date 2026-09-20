import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  CalendarRange,
  ChevronLeft,
  FilePlus,
  FolderCog,
  FolderInput,
  FolderPlus,
  LoaderCircle,
  Pencil,
  Plus,
  Trash2,
  Upload,
  X,
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
import {
  buildTree,
  canCreateSubfolder,
  canDropDoc,
  canDropFolder,
  type TreeLevel,
} from "./tree";
import {
  FolderRow,
  DocRow,
  type MenuTarget,
  type TreeRowHandlers,
} from "./TreeRow";
import {
  hasExternalFileDrag,
  markdownFilesFromDataTransfer,
  readTreeDragPayload,
  sameTreeDragPayload,
  documentIds,
  type DragPayload,
} from "./treeDrag";
import {
  flattenVisibleTree,
  compactTreeSelection,
  rangeSelectionKeys,
  replaceRangeSelection,
  treeSelectionKey,
  type TreeSelectionItem,
} from "./treeSelection";
import { isModalOpen } from "../../modalStack";

type DragHover = { payload: DragPayload; local: boolean };

const EMPTY_SELECTION_KEYS = new Set<string>();

/**
 * 侧栏文件树。
 *
 * 拖拽用原生 HTML5 DnD 而不是引库：文件夹用于归类，文档用于同级排序。原生 DnD
 * 足够覆盖这两种交互，且不增加依赖。
 *
 * 原生 DnD 键盘不可达。选择工具栏提供批量删除和「移动到…」入口，单项拖放仍保留
 * 作为快速整理方式。
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
  onDeleteMany,
  onRenameFolder,
  onRenameDoc,
  onDeleteFolder,
  onMoveDoc,
  onMoveMany,
  onReorderDocuments,
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
  onDeleteMany: (items: TreeSelectionItem[]) => Promise<boolean> | boolean;
  onRenameFolder: (folderId: string, name: string) => void;
  onRenameDoc: (docId: string, title: string) => Promise<boolean>;
  onDeleteFolder: (folderId: string, name: string) => void;
  onMoveDoc: (docId: string, folderId: string | null) => void;
  onMoveMany: (items: TreeSelectionItem[], folderId: string | null) => Promise<boolean> | boolean;
  onReorderDocuments: (docId: string, folderId: string | null, docIds: string[]) => void;
  onMoveFolder: (folderId: string, parentFolderId: string | null) => void;
  onCollapse: () => void;
  importing: boolean;
  onImport: (files: File[], targetFolderId?: string | null) => void;
  notice?: string | null;
  onOrganize: (
    plan: DocumentOrganizationPlan,
  ) => Promise<ApplyDocumentOrganizationResult>;
}) {
  const { locale, t } = useI18n();
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const organizerMenuRef = useRef<HTMLDivElement | null>(null);
  const selectionAreaRef = useRef<HTMLDivElement | null>(null);
  const treeRef = useRef<HTMLUListElement | null>(null);
  const selectionMoveMenuRef = useRef<HTMLDivElement | null>(null);
  const selectionMoveTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [dragging, setDragging] = useState<DragPayload | null>(null);
  const [rootOverDrag, setRootOverDrag] = useState<DragHover | null>(null);
  const [rootFileOver, setRootFileOver] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(() => new Set());
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);
  const selectionRangeRef = useRef<Set<string>>(new Set());
  const [selectionBox, setSelectionBox] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const marqueeRef = useRef<{
    startX: number;
    startY: number;
    baseKeys: Set<string>;
    additive: boolean;
    active: boolean;
    rows: Array<{
      key: string;
      left: number;
      right: number;
      top: number;
      bottom: number;
    }>;
  } | null>(null);
  const [selectionMoveMenuOpen, setSelectionMoveMenuOpen] = useState(false);
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
  const [renameDocRequestId, setRenameDocRequestId] = useState<string | null>(null);
  const [organizerMenuOpen, setOrganizerMenuOpen] = useState(false);
  const [pendingOrganizerStrategy, setPendingOrganizerStrategy] =
    useState<DocumentOrganizerStrategy | null>(null);
  const [organizingStrategy, setOrganizingStrategy] =
    useState<DocumentOrganizerStrategy | null>(null);

  const tree = useMemo(() => buildTree(folders, documents), [folders, documents]);
  const visibleItems = useMemo(
    () => flattenVisibleTree(tree, expanded),
    [expanded, tree],
  );
  const allSelectionItems = useMemo<TreeSelectionItem[]>(
    () => [
      ...folders.map((folder) => ({ kind: "folder" as const, id: folder.folderId })),
      ...documents.map((document) => ({
        kind: "doc" as const,
        id: document.docId,
        revision: document.revision,
      })),
    ],
    [documents, folders],
  );
  const allSelectionKeys = useMemo(
    () => new Set(allSelectionItems.map(treeSelectionKey)),
    [allSelectionItems],
  );
  const documentByID = useMemo(
    () => new Map(documents.map((document) => [document.docId, document])),
    [documents],
  );
  const selectedItems = useMemo(
    () => allSelectionItems.filter((item) => selectedKeys.has(treeSelectionKey(item))),
    [allSelectionItems, selectedKeys],
  );
  const movableSelectedItems = useMemo(
    () => compactTreeSelection(selectedItems, folders, documents),
    [documents, folders, selectedItems],
  );
  const displayedSelectedKeys = selectedItems.length > 1 ? selectedKeys : EMPTY_SELECTION_KEYS;
  const folderTargets = useMemo(() => {
    const targets: { id: string; name: string; depth: number }[] = [];
    const visit = (level: TreeLevel, depth: number) => {
      for (const folder of level.folders) {
        targets.push({
          id: folder.folderId,
          name: folder.name.trim() || t.editor.untitledFolder,
          depth,
        });
        visit(folder, depth + 1);
      }
    };
    visit(tree, 0);
    return targets;
  }, [t.editor.untitledFolder, tree]);

  useEffect(() => {
    setSelectedKeys((previous) => {
      const next = new Set([...previous].filter((key) => allSelectionKeys.has(key)));
      return next.size === previous.size ? previous : next;
    });
    setSelectionAnchor((previous) =>
      previous && allSelectionKeys.has(previous) ? previous : null,
    );
  }, [allSelectionKeys]);

  useEffect(() => {
    if (selectedItems.length === 0) setSelectionMoveMenuOpen(false);
  }, [selectedItems.length]);

  useEffect(() => {
    if (!selectionMoveMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!selectionMoveMenuRef.current?.contains(event.target as Node)) {
        setSelectionMoveMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setSelectionMoveMenuOpen(false);
        selectionMoveTriggerRef.current?.focus({ preventScroll: true });
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [selectionMoveMenuOpen]);

  useEffect(() => {
    if (!selectionMoveMenuOpen) return;
    selectionMoveMenuRef.current?.querySelector<HTMLButtonElement>(
      'button[role="menuitem"]:not([disabled])',
    )?.focus();
  }, [selectionMoveMenuOpen]);

  const onSelectionMoveMenuKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setSelectionMoveMenuOpen(false);
      selectionMoveTriggerRef.current?.focus({ preventScroll: true });
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const buttons = Array.from(
      selectionMoveMenuRef.current?.querySelectorAll<HTMLButtonElement>(
        'button[role="menuitem"]:not([disabled])',
      ) ?? [],
    );
    if (buttons.length === 0) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    buttons[(current + step + buttons.length) % buttons.length]?.focus();
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedKeys(new Set());
    setSelectionAnchor(null);
    selectionRangeRef.current.clear();
    setSelectionMoveMenuOpen(false);
  }, []);

  useEffect(() => {
    if (selectedItems.length === 0) return;
    const clearOnEscape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !isModalOpen() &&
        !selectionMoveMenuOpen &&
        !organizerMenuOpen
      ) {
        clearSelection();
      }
    };
    window.addEventListener("keydown", clearOnEscape);
    return () => window.removeEventListener("keydown", clearOnEscape);
  }, [clearSelection, organizerMenuOpen, selectionMoveMenuOpen, selectedItems.length]);

  const onSelectItem = useCallback(
    (
      item: TreeSelectionItem,
      event: React.MouseEvent | React.KeyboardEvent,
    ) => {
      const key = treeSelectionKey(item);
      if (event.shiftKey) {
        const previousRange = new Set(selectionRangeRef.current);
        const nextRange = rangeSelectionKeys(visibleItems, selectionAnchor, key);
        setSelectedKeys((previous) => {
          return replaceRangeSelection(previous, previousRange, nextRange);
        });
        selectionRangeRef.current = new Set(nextRange);
        if (!selectionAnchor) setSelectionAnchor(key);
      } else if (event.ctrlKey || event.metaKey) {
        setSelectedKeys((previous) => {
          const next = new Set(previous);
          if (next.has(key)) next.delete(key);
          else next.add(key);
          return next;
        });
        selectionRangeRef.current.clear();
        setSelectionAnchor(key);
      } else {
        setSelectedKeys(new Set([key]));
        selectionRangeRef.current = new Set([key]);
        setSelectionAnchor(key);
      }
    },
    [selectionAnchor, visibleItems],
  );

  const selectionMoveAllowed = useCallback(
    (targetFolderId: string | null) => {
      if (movableSelectedItems.length === 0) return false;
      let hasMove = false;
      for (const item of movableSelectedItems) {
        if (item.kind === "doc") {
          const document = documentByID.get(item.id);
          if (!document) return false;
          if (document.folderId !== targetFolderId) hasMove = true;
          continue;
        }
        const result = canDropFolder(folders, item.id, targetFolderId);
        if (result.reason === "noop") continue;
        if (!result.ok) return false;
        hasMove = true;
      }
      return hasMove;
    },
    [documentByID, folders, movableSelectedItems],
  );

  const beginSelectionBox = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || event.pointerType !== "mouse" || !event.isPrimary) return;
      const target = event.target as Element;
      if (target.closest("[data-tree-item]") || target.closest("button, input")) return;
      const area = selectionAreaRef.current;
      if (!area) return;
      const rect = area.getBoundingClientRect();
      if (
        (event.clientX >= rect.left + area.clientWidth && event.clientX <= rect.right) ||
        (event.clientY >= rect.top + area.clientHeight && event.clientY <= rect.bottom)
      ) return;
      const additive = event.ctrlKey || event.metaKey;
      marqueeRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        baseKeys: additive ? new Set(selectedKeys) : new Set(),
        additive,
        active: false,
        rows: Array.from(area.querySelectorAll<HTMLElement>("[data-tree-item-key]")).map((row) => {
          const rowRect = row.getBoundingClientRect();
          return {
            key: row.dataset.treeItemKey!,
            left: rowRect.left,
            right: rowRect.right,
            top: rowRect.top,
            bottom: rowRect.bottom,
          };
        }),
      };
      setSelectionBox({
        left: event.clientX - rect.left + area.scrollLeft,
        top: event.clientY - rect.top + area.scrollTop,
        width: 0,
        height: 0,
      });
    },
    [selectedKeys],
  );

  const selectionBoxActive = selectionBox !== null;
  useEffect(() => {
    if (!selectionBoxActive) return;
    const update = (event: PointerEvent) => {
      const marquee = marqueeRef.current;
      const area = selectionAreaRef.current;
      if (!marquee || !area) return;
      const distance = Math.hypot(
        event.clientX - marquee.startX,
        event.clientY - marquee.startY,
      );
      if (!marquee.active && distance < 4) return;
      if (!marquee.active) {
        marquee.active = true;
        if (!marquee.additive) {
          setSelectedKeys(new Set());
          setSelectionAnchor(null);
          selectionRangeRef.current.clear();
        }
      }
      event.preventDefault();
      const rect = area.getBoundingClientRect();
      const leftClient = Math.min(marquee.startX, event.clientX);
      const rightClient = Math.max(marquee.startX, event.clientX);
      const topClient = Math.min(marquee.startY, event.clientY);
      const bottomClient = Math.max(marquee.startY, event.clientY);
      setSelectionBox({
        left: leftClient - rect.left + area.scrollLeft,
        top: topClient - rect.top + area.scrollTop,
        width: rightClient - leftClient,
        height: bottomClient - topClient,
      });
      const next = new Set(marquee.baseKeys);
      marquee.rows.forEach((rowRect) => {
        const intersects =
          rowRect.left < rightClient &&
          rowRect.right > leftClient &&
          rowRect.top < bottomClient &&
          rowRect.bottom > topClient;
        if (intersects) next.add(rowRect.key);
      });
      setSelectedKeys(next);
    };
    const finish = () => {
      const marquee = marqueeRef.current;
      if (marquee && !marquee.active && !marquee.additive) {
        setSelectedKeys(new Set());
        setSelectionAnchor(null);
        selectionRangeRef.current.clear();
      }
      marqueeRef.current = null;
      setSelectionBox(null);
    };
    window.addEventListener("pointermove", update);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    window.addEventListener("blur", finish);
    return () => {
      window.removeEventListener("pointermove", update);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      window.removeEventListener("blur", finish);
    };
  }, [selectionBoxActive]);
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
      if (event.key === "Escape") {
        event.preventDefault();
        closeOrganizerMenu();
      }
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

  const focusVisibleItem = useCallback((key: string) => {
    const row = Array.from(
      treeRef.current?.querySelectorAll<HTMLElement>("[data-tree-item-key]") ?? [],
    ).find((candidate) => candidate.dataset.treeItemKey === key);
    row?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
  }, []);

  const onTreeKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLUListElement>) => {
      if (event.defaultPrevented) return;
      const target = event.target as HTMLElement;
      if (target.closest("input, textarea, select, [contenteditable='true']")) return;
      const row = target.closest<HTMLElement>("[data-tree-item-key]");
      const key = row?.dataset.treeItemKey;
      if (!key) return;
      const index = visibleItems.findIndex((item) => treeSelectionKey(item) === key);
      if (index < 0) return;
      const item = visibleItems[index];
      const focusAndSelect = (nextIndex: number) => {
        const next = visibleItems[nextIndex];
        if (!next) return;
        event.preventDefault();
        focusVisibleItem(treeSelectionKey(next));
        if (event.shiftKey || (!event.ctrlKey && !event.metaKey)) {
          onSelectItem(next, event);
        }
      };

      if (event.key === "ArrowDown") {
        focusAndSelect(Math.min(index + 1, visibleItems.length - 1));
        return;
      }
      if (event.key === "ArrowUp") {
        focusAndSelect(Math.max(index - 1, 0));
        return;
      }
      if (event.key === "Home") {
        focusAndSelect(0);
        return;
      }
      if (event.key === "End") {
        focusAndSelect(visibleItems.length - 1);
        return;
      }
      if (event.key === "ArrowRight" && item.kind === "folder") {
        if (!expanded.has(item.id)) {
          event.preventDefault();
          onToggle(item.id);
          return;
        }
        const child = visibleItems[index + 1];
        if (child && child.depth > item.depth) {
          event.preventDefault();
          focusVisibleItem(treeSelectionKey(child));
        }
        return;
      }
      if (event.key === "ArrowLeft") {
        if (item.kind === "folder" && expanded.has(item.id)) {
          event.preventDefault();
          onToggle(item.id);
          return;
        }
        for (let parentIndex = index - 1; parentIndex >= 0; parentIndex -= 1) {
          if (visibleItems[parentIndex].depth < item.depth) {
            event.preventDefault();
            focusVisibleItem(treeSelectionKey(visibleItems[parentIndex]));
            return;
          }
        }
      }
    },
    [expanded, focusVisibleItem, onSelectItem, onToggle, visibleItems],
  );

  const canDropOn = useCallback(
    (payload: DragPayload, targetFolderId: string | null) => {
      if (payload.selection) {
        const items = compactTreeSelection(payload.selection, folders, documents);
        if (items.length === 0) return false;
        let hasMove = false;
        for (const item of items) {
          const result =
            item.kind === "folder"
              ? canDropFolder(folders, item.id, targetFolderId)
              : canDropDoc(documents, item.id, targetFolderId);
          if (result.reason === "noop") continue;
          if (!result.ok) return false;
          hasMove = true;
        }
        return hasMove;
      }
      if (payload.kind === "folder") {
        return canDropFolder(folders, payload.id, targetFolderId).ok;
      }
      let hasMove = false;
      for (const docId of documentIds(payload)) {
        const result = canDropDoc(documents, docId, targetFolderId);
        if (result.reason === "noop") continue;
        if (!result.ok) return false;
        hasMove = true;
      }
      return hasMove;
    },
    [folders, documents],
  );

  const onDrop = useCallback(
    (payload: DragPayload, targetFolderId: string | null) => {
      setDragging(null);
      if (!canDropOn(payload, targetFolderId)) return;
      if (payload.selection) {
        void onMoveMany(
          compactTreeSelection(payload.selection, folders, documents),
          targetFolderId,
        );
      } else if (payload.kind === "folder") onMoveFolder(payload.id, targetFolderId);
      else {
        const docIds = documentIds(payload);
        if (docIds.length > 1) {
          void onMoveMany(
            docIds.map((id) => ({
              kind: "doc" as const,
              id,
              revision: documentByID.get(id)?.revision,
            })),
            targetFolderId,
          );
        } else {
          onMoveDoc(payload.id, targetFolderId);
        }
      }
      // 放进去就展开，否则拖进去的东西「消失」了，还得自己点开才看得见
      if (targetFolderId) setExpanded((prev) => new Set(prev).add(targetFolderId));
    },
    [canDropOn, documentByID, documents, folders, onMoveFolder, onMoveDoc, onMoveMany],
  );

  const onImportFiles = useCallback(
    (files: File[], targetFolderId: string | null) => {
      if (importing || files.length === 0) return;
      setRootOverDrag(null);
      setRootFileOver(false);
      if (targetFolderId) {
        setExpanded((prev) => new Set(prev).add(targetFolderId));
      }
      onImport(files, targetFolderId);
    },
    [importing, onImport],
  );

  const canReorderDoc = useCallback(
    (payload: DragPayload, targetDocId: string) => {
      if (
        payload.kind !== "doc" ||
        payload.id === targetDocId ||
        payload.selection?.some((item) => item.kind === "folder")
      ) return false;
      const target = documents.find((document) => document.docId === targetDocId);
      const dragged = documentIds(payload)
        .map((docId) => documents.find((document) => document.docId === docId))
        .filter((document): document is (typeof documents)[number] => Boolean(document));
      return Boolean(
        target &&
          dragged.length === documentIds(payload).length &&
          !documentIds(payload).includes(targetDocId) &&
          dragged.every((document) => document.folderId === target.folderId),
      );
    },
    [documents],
  );

  const onReorderDoc = useCallback(
    (payload: DragPayload, targetDocId: string, position: "before" | "after") => {
      if (payload.kind !== "doc" || !canReorderDoc(payload, targetDocId)) return;
      const target = documents.find((document) => document.docId === targetDocId);
      if (!target) return;
      const movingIds = documentIds(payload);
      const moving = new Set(movingIds);
      const siblings = documents.filter(
        (document) => document.folderId === target.folderId,
      );
      const dragged = siblings.filter((document) => moving.has(document.docId));
      if (dragged.length !== movingIds.length) return;
      const next = siblings.filter((document) => !moving.has(document.docId));
      const targetIndex = next.findIndex((document) => document.docId === targetDocId);
      if (targetIndex < 0) return;
      next.splice(position === "before" ? targetIndex : targetIndex + 1, 0, ...dragged);
      onReorderDocuments(
        payload.id,
        target.folderId,
        next.map((document) => document.docId),
      );
      setDragging(null);
    },
    [canReorderDoc, documents, onReorderDocuments],
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
    autoEditDocId: renameDocRequestId,
    onDocEditStarted: () => setRenameDocRequestId(null),
    onAutoEditDone: () => {
      setRenameRequestId(null);
      onAutoEditDone?.();
    },
    expanded,
    onToggle,
    onSelectDoc: onSelect,
    selectedKeys,
    displayedSelectedKeys,
    dragSelection: selectedItems,
    onSelectItem,
    onDeleteDoc: onDelete,
    onRenameFolder,
    onRenameDoc,
    onDeleteFolder,
    onDrop,
    onReorderDoc,
    canReorderDoc,
    canDropOn,
    dragging,
    setDragging,
    onImportFiles,
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
          key: "rename-doc",
          label: t.editor.renameDocument,
          icon: <Pencil className="h-3.5 w-3.5" />,
          onSelect: () => setRenameDocRequestId(target.docId),
        },
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

  const rootHoverPayload = dragging ?? rootOverDrag?.payload;
  const rootAcceptsDrop = rootHoverPayload
    ? canDropOn(rootHoverPayload, null)
    : false;
  const rootDropHovered =
    rootOverDrag !== null &&
    rootAcceptsDrop &&
    (!rootOverDrag.local ||
      sameTreeDragPayload(rootOverDrag.payload, dragging));
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

      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {selectedItems.length > 0
          ? interpolate(t.editor.selectedItems, { count: selectedItems.length })
          : ""}
      </span>

      {selectedItems.length > 1 && (
        <div className="relative mx-2 mb-2 flex items-center gap-1 rounded-lg border border-cinnabar-200 bg-cinnabar-50/70 px-2 py-1.5 dark:border-cinnabar-900 dark:bg-cinnabar-950/30">
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-cinnabar-800 dark:text-cinnabar-200">
            {interpolate(t.editor.selectedItems, { count: selectedItems.length })}
          </span>
          <div ref={selectionMoveMenuRef} className="relative">
            <button
              type="button"
              ref={selectionMoveTriggerRef}
              aria-label={t.editor.moveSelected}
              aria-haspopup="menu"
              aria-expanded={selectionMoveMenuOpen}
              title={t.editor.moveSelected}
              onClick={() => setSelectionMoveMenuOpen((open) => !open)}
              className="flex h-6 w-6 items-center justify-center rounded-md text-cinnabar-700 hover:bg-cinnabar-100 dark:text-cinnabar-300 dark:hover:bg-cinnabar-900/60"
            >
              <FolderInput className="h-3.5 w-3.5" />
            </button>
            {selectionMoveMenuOpen && (
              <div
                role="menu"
                aria-label={t.editor.moveSelected}
                onKeyDown={onSelectionMoveMenuKeyDown}
                className="absolute left-0 top-full z-40 mt-1 max-h-64 min-w-48 overflow-y-auto rounded-xl border border-black/10 bg-[var(--background)] p-1 shadow-xl dark:border-white/10"
              >
                <button
                  type="button"
                  role="menuitem"
                  disabled={!selectionMoveAllowed(null)}
                  onClick={() => {
                    void Promise.resolve(onMoveMany(movableSelectedItems, null)).then((success) => {
                      if (success) clearSelection();
                    });
                  }}
                  className="flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-xs text-neutral-700 hover:bg-black/5 disabled:opacity-40 dark:text-neutral-200 dark:hover:bg-white/10"
                >
                  {t.editor.rootFolder}
                </button>
                {folderTargets.map((folder) => (
                  <button
                    key={folder.id}
                    type="button"
                    role="menuitem"
                    disabled={!selectionMoveAllowed(folder.id)}
                    onClick={() => {
                      void Promise.resolve(onMoveMany(movableSelectedItems, folder.id)).then((success) => {
                        if (success) clearSelection();
                      });
                    }}
                    style={{ paddingLeft: `${10 + folder.depth * 12}px` }}
                    className="flex w-full items-center rounded-lg py-1.5 pr-2.5 text-left text-xs text-neutral-700 hover:bg-black/5 disabled:opacity-40 dark:text-neutral-200 dark:hover:bg-white/10"
                  >
                    {folder.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            aria-label={t.editor.deleteSelected}
            title={t.editor.deleteSelected}
            onClick={() => {
              void Promise.resolve(onDeleteMany(selectedItems)).then((success) => {
                if (success) clearSelection();
              });
            }}
            className="flex h-6 w-6 items-center justify-center rounded-md text-red-600 hover:bg-red-100 dark:text-red-400 dark:hover:bg-red-950/50"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label={t.editor.clearSelection}
            title={t.editor.clearSelection}
            onClick={clearSelection}
            className="flex h-6 w-6 items-center justify-center rounded-md text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

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
        ref={selectionAreaRef}
        onPointerDown={beginSelectionBox}
        onDragOver={(e) => {
          if (hasExternalFileDrag(e.dataTransfer)) {
            e.preventDefault();
            setRootFileOver(true);
            return;
          }
          const payload = readTreeDragPayload(e.dataTransfer) ?? dragging;
          if (!payload || !canDropOn(payload, null)) return;
          e.preventDefault(); // 不调用它浏览器不会触发 drop
          const local = dragging !== null;
          setRootOverDrag((current) =>
            current &&
            current.local === local &&
            sameTreeDragPayload(current.payload, payload)
              ? current
              : { payload, local },
          );
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setRootOverDrag(null);
          setRootFileOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setRootOverDrag(null);
          setRootFileOver(false);
          const files = markdownFilesFromDataTransfer(e.dataTransfer);
          if (files.length > 0) {
            onImportFiles(files, null);
            return;
          }
          const payload = readTreeDragPayload(e.dataTransfer) ?? dragging;
          if (payload && canDropOn(payload, null)) onDrop(payload, null);
        }}
        // 空白处右键 = 根菜单。行上的右键已经 stopPropagation，不会走到这里
        onContextMenu={(e) => openMenu(e, { kind: "root" })}
        className={`relative min-h-0 flex-1 overflow-y-auto px-2 pb-2 ${
          selectionBoxActive ? "select-none" : ""
        } ${
          rootDropHovered || rootFileOver
            ? "rounded-lg ring-1 ring-inset ring-cinnabar-500"
            : ""
        }`}
      >
        {selectionBox && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute z-20 rounded-sm border border-cinnabar-500 bg-cinnabar-500/10"
            style={selectionBox}
          />
        )}
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
          <ul
            ref={treeRef}
            role="tree"
            aria-label={t.editor.documentsPanel}
            aria-multiselectable="true"
            onKeyDown={onTreeKeyDown}
            className="space-y-0.5"
          >
            {tree.folders.map((folder) => (
              <FolderRow key={folder.folderId} folder={folder} depth={0} h={handlers} />
            ))}
            {tree.docs.map((docNode) => (
              <DocRow key={docNode.docId} doc={docNode} depth={0} h={handlers} />
            ))}
          </ul>
        )}

        {/* 拖动中给一条明确落点：内容可能占满滚动区，没有空白可拖 */}
        {((dragging && rootAcceptsDrop) || rootDropHovered || rootFileOver) && (
          <div className="mt-1 rounded-lg border border-dashed border-cinnabar-500 px-2 py-2 text-center text-[11px] text-cinnabar-600 dark:text-cinnabar-400">
            {rootFileOver ? t.transfer.importDropHint : t.editor.dropToRoot}
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
