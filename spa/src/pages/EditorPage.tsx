import {
  Link,
  useBlocker,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import type { EditorEvents } from "@tiptap/core";
import { FolderTree, ListTree, Share2 } from "lucide-react";
import { LiveEditor } from "../components/editor/LiveEditor";
import { DocumentTemplateDialog } from "../components/DocumentTemplateDialog";
import { DocumentList } from "../components/editor/DocumentList";
import { useDeleteConfirm } from "../components/editor/useDeleteConfirm";
import { OutlinePanel } from "../components/editor/OutlinePanel";
import { ResizablePanel } from "../components/editor/ResizablePanel";
import { ShareDialog } from "../components/editor/ShareDialog";
import { ExportMenu } from "../components/editor/ExportMenu";
import { scrollToHeading, useOutline } from "../components/editor/useOutline";
import {
  useCreateDocument,
  useCreateFolder,
  useTrashDocument,
  useDeleteFolder,
  useDocument,
  useDocumentList,
  useEditorTabs,
  useFolderList,
  useMoveDocument,
  useMoveFolder,
  useRefreshDocumentList,
  useRenameFolder,
  useSyncEditorTabs,
} from "../documents";
import { TabBar } from "../components/editor/TabBar";
import { useDocumentSaver } from "../components/editor/useDocumentSaver";
import { isSaveShortcut } from "../components/editor/saveShortcut";
import {
  adjacentTabId,
  detectEditorShortcutPlatform,
  editorShortcutAction,
  isEditorShortcutFormInputContext,
  isEditorShortcutInputContext,
  numberedTabId,
  shouldBlockEditorShortcutInFormInputContext,
  shouldPreserveInputShortcut,
} from "../components/editor/editorShortcuts";
import {
  EMPTY_TABS,
  activate,
  close,
  hydrate,
  removeDeleted,
  removeUnavailable,
  type TabState,
} from "../components/editor/tabPool";
import { useSession } from "../auth";
import { ApiError } from "../api";
import { interpolate, useI18n } from "../i18n";
import { isDesktopRuntime } from "../desktop/runtime";
import { useDesktopMenuActions } from "../desktop/menu";
import { registerDesktopSyncPreparation } from "../desktop/logoutGuard";
import { confirmAction } from "../confirmAction";
import {
  getImportErrorMessage,
  importDocumentsFromFiles,
} from "../documentTransfer";
import {
  applyDocumentOrganization,
  type ApplyDocumentOrganizationResult,
} from "../documentOrganizer";
import type { DocumentOrganizationPlan } from "../components/editor/documentOrganizerCore";
import {
  buildDocumentFromTemplate,
  canUseDocumentTemplate,
  documentTemplateById,
  type DocumentTemplateId,
} from "../documentTemplates";
import { isModalOpen, pushModal } from "../modalStack";
import {
  captureEditorTabSelection,
  EDITOR_TAB_SELECTION_RESTORE_META,
  restoreEditorTabSelection,
  shouldPreserveEditorFocusAfterBlur,
  type EditorTabSelection,
} from "../components/editor/editorTabSelection";

// 早期版本把正文存在这个 key 下（单文档、无账号）。
// 现在改为账号内多文档，首次进入且云端为空时把它导入为第一篇，不静默丢弃。
const LEGACY_STORAGE_KEY = "koinote:document";

type ActiveEditor = {
  docId: string;
  editor: Editor;
};

export function EditorPage() {
  const { locale, t } = useI18n();
  const session = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { docId?: string };
  const search = useSearch({ strict: false }) as { create?: boolean };
  const activeDocId = params.docId;
  const createFromRoute = search.create === true;

  const loggedIn = Boolean(session.data?.user);
  const localMode = Boolean(session.data?.user?.isLocalMode);
  const list = useDocumentList(loggedIn);
  const create = useCreateDocument();
  const remove = useTrashDocument();
  const folderList = useFolderList(loggedIn);
  const createFolder = useCreateFolder();
  const renameFolderMut = useRenameFolder();
  const deleteFolderMut = useDeleteFolder();
  const moveFolderMut = useMoveFolder();
  const moveDocMut = useMoveDocument();
  const refreshList = useRefreshDocumentList();
  const confirmDelete = useDeleteConfirm();

  const [activeEditor, setActiveEditor] = useState<ActiveEditor | null>(null);
  const editorSelections = useRef<Map<string, EditorTabSelection>>(new Map());
  const editor =
    activeEditor && activeEditor.docId === activeDocId
      ? activeEditor.editor
      : null;
  const [shareOpen, setShareOpen] = useState(false);
  const [mobileDocsOpen, setMobileDocsOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importNotice, setImportNotice] = useState<{
    error: boolean;
    message: string;
  } | null>(null);
  const [organizationNotice, setOrganizationNotice] = useState<{
    error: boolean;
    message: string;
  } | null>(null);
  const [templateRequest, setTemplateRequest] = useState<{
    folderId: string | null;
    fromRoute: boolean;
  } | null>(() =>
    createFromRoute ? { folderId: null, fromRoute: true } : null,
  );
  const [tabState, setTabState] = useState<TabState>(EMPTY_TABS);
  const tabStateRef = useRef(tabState);
  tabStateRef.current = tabState;
  const saver = useDocumentSaver(refreshList);

  const prepareEditorRouteExit = useCallback(
    async ({ next }: { next: { pathname: string } }) => {
      if (
        next.pathname === "/editor" ||
        next.pathname.startsWith("/editor/")
      ) {
        return false;
      }
      await saver.flushAll();
      // 保存失败时 useDocumentSaver 已经同步写入本地恢复草稿。这里仍允许离开，
      // 否则持续离线或服务端故障会把用户永久困在编辑器路由。
      return false;
    },
    [saver.flushAll],
  );
  useBlocker({
    shouldBlockFn: prepareEditorRouteExit,
    enableBeforeUnload: false,
  });

  const serverTabs = useEditorTabs(loggedIn);
  const syncTabs = useSyncEditorTabs();
  // 折叠状态与面板宽度一样要记住，否则每次刷新都弹回展开态
  const [docsOpen, setDocsOpen] = usePersistedFlag(
    "koinote:panel-open:documents",
    true,
  );
  const [outlineOpen, setOutlineOpen] = usePersistedFlag(
    "koinote:panel-open:outline",
    true,
  );
  const outline = useOutline(editor);

  const handleEditorReady = useCallback(
    (docId: string, nextEditor: Editor | null) => {
      setActiveEditor((current) => {
        if (!nextEditor) {
          return current?.docId === docId ? null : current;
        }
        if (current?.docId === docId && current.editor === nextEditor) {
          return current;
        }
        return { docId, editor: nextEditor };
      });
    },
    [],
  );

  useEffect(() => {
    if (
      !activeEditor ||
      activeEditor.docId !== activeDocId ||
      activeEditor.editor.isDestroyed
    )
      return;
    const { docId, editor: currentEditor } = activeEditor;
    const rememberSelection = (focused = currentEditor.isFocused) => {
      if (currentEditor.isDestroyed) return;
      editorSelections.current.set(
        docId,
        captureEditorTabSelection(currentEditor, focused),
      );
    };
    const forgetClosedSelection = () => {
      if (tabStateRef.current.openTabs.includes(docId)) return false;
      editorSelections.current.delete(docId);
      return true;
    };
    const rememberBlur = () => {
      queueMicrotask(() => {
        if (forgetClosedSelection()) return;
        if (
          shouldPreserveEditorFocusAfterBlur(
            document.activeElement,
            document.body,
          )
        )
          return;
        rememberSelection(false);
      });
    };

    const rememberCurrentSelection = ({
      transaction,
    }: EditorEvents["selectionUpdate"]) => {
      if (transaction.getMeta(EDITOR_TAB_SELECTION_RESTORE_META)) return;
      rememberSelection();
    };
    const rememberFocus = () => rememberSelection(true);
    currentEditor.on("selectionUpdate", rememberCurrentSelection);
    currentEditor.on("focus", rememberFocus);
    currentEditor.on("blur", rememberBlur);
    const remembered = editorSelections.current.get(docId);
    if (remembered) {
      restoreEditorTabSelection(currentEditor, remembered);
    } else {
      rememberSelection();
    }

    return () => {
      if (!forgetClosedSelection()) {
        rememberSelection(
          editorSelections.current.get(docId)?.focused ??
            currentEditor.isFocused,
        );
      }
      currentEditor.off("selectionUpdate", rememberCurrentSelection);
      currentEditor.off("focus", rememberFocus);
      currentEditor.off("blur", rememberBlur);
    };
  }, [activeDocId, activeEditor]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    return registerDesktopSyncPreparation(() => saver.flushAll());
  }, [saver]);

  useEffect(() => {
    if (!mobileDocsOpen) return;
    const releaseModal = pushModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileDocsOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
      releaseModal();
    };
  }, [mobileDocsOpen]);

  useEffect(() => {
    if (!importNotice) return;
    const timer = window.setTimeout(() => setImportNotice(null), 5_000);
    return () => window.clearTimeout(timer);
  }, [importNotice]);

  useEffect(() => {
    if (!organizationNotice) return;
    const timer = window.setTimeout(() => setOrganizationNotice(null), 5_000);
    return () => window.clearTimeout(timer);
  }, [organizationNotice]);

  // 自动落地逻辑只跑一次，避免重复建文档
  const bootstrapped = useRef(false);

  const documents = list.data;

  useEffect(() => {
    if (!createFromRoute) return;
    create.reset();
    setTemplateRequest({ folderId: null, fromRoute: true });
  }, [createFromRoute]);

  // 无 docId 时：跳最近编辑的一篇；一篇都没有则新建（顺带导入本地遗留草稿）
  useEffect(() => {
    if (
      !loggedIn ||
      activeDocId ||
      createFromRoute ||
      !documents ||
      bootstrapped.current
    )
      return;
    if (create.isPending) return;

    if (documents.length > 0) {
      bootstrapped.current = true;
      void navigate({
        to: "/editor/$docId",
        params: { docId: documents[0].docId },
      });
      return;
    }

    bootstrapped.current = true;
    const legacy =
      typeof window !== "undefined"
        ? window.localStorage.getItem(LEGACY_STORAGE_KEY)
        : null;

    create.mutate(
      legacy && legacy.trim()
        ? { title: t.editor.importedLocalDraft, content: legacy }
        : undefined,
      {
        onSuccess: ({ document }) => {
          // 导入成功后清掉旧 key，避免下次再次导入
          if (legacy && typeof window !== "undefined") {
            window.localStorage.removeItem(LEGACY_STORAGE_KEY);
          }
          void navigate({
            to: "/editor/$docId",
            params: { docId: document.docId },
          });
        },
        onError: () => {
          // 失败允许再试
          bootstrapped.current = false;
        },
      },
    );
  }, [
    loggedIn,
    activeDocId,
    createFromRoute,
    documents,
    create,
    navigate,
    t.editor.importedLocalDraft,
  ]);

  const doc = useDocument(activeDocId);

  // ---------- 标签页 ----------

  // 恢复上次的标签组。只做一次：之后真相在客户端，再读会把刚开的标签覆盖回旧状态
  const hydrated = useRef(false);
  useEffect(() => {
    if (hydrated.current || !serverTabs.data) return;
    hydrated.current = true;
    const { tabs, activeDocId: serverActive } = serverTabs.data;
    if (tabs.length === 0) return;
    // URL 里的 docId 优先：深链或刷新时用户明确要看的是那一篇
    setTabState(hydrate(tabs, activeDocId ?? serverActive));
  }, [serverTabs.data, activeDocId]);

  // saver 经 ref 用，不进 effect 依赖：它的 status 依赖 statuses，打字时身份会变，
  // 放进依赖数组会让下面那个 effect 每次保存状态变化都重跑一遍
  const saverRef = useRef(saver);
  saverRef.current = saver;

  /**
   * 刚关掉的标签，闸门。
   *
   * 关闭是「先改状态、再改地址」，中间有几帧 activeDocId 还指着已关掉的那篇。
   * 下面的 effect 那时会把它 activate 回来 —— 表现就是要点两次才关得掉。
   */
  const justClosed = useRef<string | null>(null);

  /**
   * 本次会话里由「+」新建的 docId。
   *
   * 用来区分「刚建的空文档」与「从服务端载入的空文档」—— 前者关掉标签就该删，
   * 后者是用户的数据，不能因为关个标签就没了。
   */
  const createdHere = useRef<Set<string>>(new Set());

  // 后台检查可能发现某篇文档已经在另一端删除。列表会刷新，但单篇 query 和标签池
  // 都有独立缓存，若不主动对齐就会留下“未命名文档”假标签和旧正文。
  useEffect(() => {
    if (!documents || !hydrated.current) return;
    const current = tabStateRef.current;
    const preserved = current.openTabs.filter((id) => saverRef.current.isDirty(id));
    const { next, removed } = removeUnavailable(
      current,
      documents.map((document) => document.docId),
      preserved,
    );
    if (removed.length === 0) return;

    if (current.activeDocId && removed.includes(current.activeDocId)) {
      justClosed.current = current.activeDocId;
    }
    for (const id of removed) {
      saverRef.current.drop(id);
      createdHere.current.delete(id);
      editorSelections.current.delete(id);
    }
    setTabState(next);

    if (next.activeDocId === current.activeDocId) return;
    if (next.activeDocId) {
      void navigate({
        to: "/editor/$docId",
        params: { docId: next.activeDocId },
      });
      return;
    }
    bootstrapped.current = false;
    const fallback = documents[0]?.docId;
    if (fallback) {
      void navigate({ to: "/editor/$docId", params: { docId: fallback } });
    } else {
      void navigate({ to: "/editor" });
    }
  }, [documents, navigate]);

  // URL 是当前标签的唯一真相。地址栏变化（含前进后退、深链）都要落进标签状态
  useEffect(() => {
    if (!activeDocId) return;
    if (justClosed.current === activeDocId) return; // 地址还没跟上，别把它拉回来
    setTabState((prev) => {
      if (
        prev.activeDocId === activeDocId &&
        prev.openTabs.includes(activeDocId)
      ) {
        return prev;
      }
      const { next, evicted } = activate(prev, activeDocId);
      // 被挤出池子的实例即将卸载，先把它们的待存内容发出去
      for (const id of evicted) void saverRef.current.flush(id);
      return next;
    });
  }, [activeDocId]);

  // 地址真的离开了，闸门就该撤掉，否则再打开这篇会被一直挡住
  useEffect(() => {
    if (justClosed.current && justClosed.current !== activeDocId) {
      justClosed.current = null;
    }
  }, [activeDocId]);

  // 标签组同步到后端。防抖 —— 切标签很频繁，每次都打后端太吵
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncRef = useRef(syncTabs.mutate);
  syncRef.current = syncTabs.mutate;
  useEffect(() => {
    if (!loggedIn || !hydrated.current) return;
    if (syncTimer.current) clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => {
      syncRef.current({
        tabs: tabState.openTabs,
        activeDocId: tabState.activeDocId,
      });
    }, 600);
    return () => {
      if (syncTimer.current) clearTimeout(syncTimer.current);
    };
  }, [loggedIn, tabState.openTabs, tabState.activeDocId]);

  const handleSelect = useCallback(
    (docId: string) => {
      void navigate({ to: "/editor/$docId", params: { docId } });
    },
    [navigate],
  );

  const rememberActiveEditorSelection = useCallback(() => {
    if (
      !activeEditor ||
      activeEditor.docId !== activeDocId ||
      activeEditor.editor.isDestroyed
    )
      return;
    editorSelections.current.set(
      activeEditor.docId,
      captureEditorTabSelection(
        activeEditor.editor,
        activeEditor.editor.isFocused,
      ),
    );
  }, [activeDocId, activeEditor]);

  /**
   * Ctrl+S / Cmd+S 立刻保存当前文档。
   *
   * 内容本来就有 800ms 防抖自动保存，这个快捷键要的不是「否则会丢」，而是让「我按过
   * 保存了」这件事有确认 —— 浏览器默认会弹「保存网页」对话框，不拦的话用户以为编辑器
   * 没响应。
   *
   * 监听挂在页面层而不是 MarkdownEditor 里：多开时最多 3 个实例同时挂载（非当前的用
   * display:none 藏着），在组件里挂 window 监听会一次按键触发 3 次，把后台那两篇也
   * 一起存了。这里只有一个监听，且天然知道哪篇是当前的。
   *
   * 挂 window 而不是编辑器容器：焦点可能在标题输入框、侧栏、工具栏上，那时也该能存。
   */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isSaveShortcut(e)) return;
      // 一定要拦掉，否则浏览器弹「保存网页」
      e.preventDefault();
      if (isModalOpen()) return;
      const docId = activeDocId;
      if (!docId) return;
      // flush 内部对「没有待存改动」是空操作，所以重复按不会产生多余请求
      void saver.flush(docId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeDocId, saver]);

  /**
   * 标签上显示的标题。
   *
   * 单独存一份而不是从 saver.peek 读：peek 读的是 ref，改动不触发渲染，标签标题
   * 会等到保存完成才更新 —— 打字时看着像卡住了。
   */
  const [liveTitles, setLiveTitles] = useState<Record<string, string>>({});

  const handleTitleChange = useCallback((docId: string, title: string) => {
    setLiveTitles((prev) =>
      prev[docId] === title ? prev : { ...prev, [docId]: title },
    );
  }, []);

  const titleOf = useCallback(
    (docId: string) => {
      const live = liveTitles[docId];
      if (live !== undefined) return live;
      return (documents ?? []).find((d) => d.docId === docId)?.title ?? "";
    },
    [liveTitles, documents],
  );

  const handleCloseTab = useCallback(
    (docId: string) => {
      editorSelections.current.delete(docId);
      /**
       * 点「+」会立刻 POST 建一篇真文档，所以关标签只摘标签的话，一篇没动过的空
       * 文档会永久留在侧栏里。这里把它删掉。
       *
       * 三个条件都要满足才删：本次会话新建的、没有未落库的改动、标题与正文都空。
       * 「本次会话新建」这条是关键 —— 少了它，关掉一篇从服务端载入的旧空文档的
       * 标签会把那篇真删了。
       */
      const snapshot = saver.peek(docId);
      const untouched =
        createdHere.current.has(docId) &&
        !saver.isDirty(docId) &&
        !snapshot?.title.trim() &&
        !snapshot?.content.trim();

      if (untouched) {
        // drop 而不是 forget：forget 会先 PUT 一次，而这篇马上就要删了
        saver.drop(docId);
        createdHere.current.delete(docId);
        remove.mutate(docId);
      } else {
        // 先把待存内容存掉再摘标签，否则防抖窗口内的编辑就没了
        void saver.forget(docId);
      }

      // 闸门要在改地址之前立起来，挡住 activeDocId 还没更新的那几帧
      if (docId === tabStateRef.current.activeDocId) {
        justClosed.current = docId;
      }

      const { next, evicted } = close(tabStateRef.current, docId);
      for (const id of evicted) void saver.flush(id);
      setTabState(next);

      // navigate 放在 updater 外面：updater 在 StrictMode 下会跑两次，
      // 副作用写在里面就会发两次导航
      if (next.activeDocId !== tabStateRef.current.activeDocId) {
        if (next.activeDocId) {
          void navigate({
            to: "/editor/$docId",
            params: { docId: next.activeDocId },
          });
        } else {
          bootstrapped.current = false;
          void navigate({ to: "/editor" });
        }
      }
    },
    [saver, navigate, remove],
  );

  const handleCreate = useCallback(
    (folderId?: string | null) => {
      create.reset();
      setTemplateRequest({ folderId: folderId ?? null, fromRoute: false });
    },
    [create],
  );

  useDesktopMenuActions((action) => {
    const current = tabStateRef.current;
    if (action === "new-document") {
      handleCreate(null);
      return;
    }
    if (action === "save-document") {
      if (current.activeDocId) void saver.flush(current.activeDocId);
      return;
    }
    if (action === "close-document") {
      if (current.activeDocId) handleCloseTab(current.activeDocId);
      return;
    }
    if (action === "previous-document" || action === "next-document") {
      const target = adjacentTabId(
        current.openTabs,
        current.activeDocId,
        action === "next-document" ? 1 : -1,
      );
      if (target && target !== current.activeDocId) handleSelect(target);
      return;
    }
    if (action === "toggle-documents-panel") {
      setDocsOpen(!docsOpen);
      return;
    }
    if (action === "toggle-outline-panel") {
      setOutlineOpen(!outlineOpen);
      return;
    }
    if (action === "share-document" && !localMode && doc.data) {
      setShareOpen(true);
    }
  });

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    const platform = detectEditorShortcutPlatform(
      navigator.platform,
      navigator.userAgent,
    );
    const onKeyDown = (event: KeyboardEvent) => {
      const action = editorShortcutAction(event, platform);
      if (!action) return;
      if (isModalOpen()) {
        event.preventDefault();
        return;
      }

      const target = event.target as HTMLElement | null;
      const inputContext = isEditorShortcutInputContext(target);
      if (shouldPreserveInputShortcut(action, inputContext)) return;
      const formInputContext = isEditorShortcutFormInputContext(target);
      if (shouldBlockEditorShortcutInFormInputContext(action, formInputContext)) {
        // 不执行应用动作，也不能交还给 WebView：否则 Cmd+W 可能关闭整个窗口。
        event.preventDefault();
        return;
      }

      const current = tabStateRef.current;
      if (action === "next-tab" || action === "previous-tab") {
        // Ctrl+Tab 仍交给 WebView 会在路由切换前执行 Tab 的默认焦点导航，
        // 选区可能因此被改写。先同步记住当前 ProseMirror 选区，再消费按键。
        event.preventDefault();
        rememberActiveEditorSelection();
        const target = adjacentTabId(
          current.openTabs,
          current.activeDocId,
          action === "next-tab" ? 1 : -1,
        );
        if (target && target !== current.activeDocId) handleSelect(target);
        return;
      }
      if (action.startsWith("select-tab-")) {
        event.preventDefault();
        rememberActiveEditorSelection();
        const target = numberedTabId(
          current.openTabs,
          Number(action.slice("select-tab-".length)),
        );
        if (target && target !== current.activeDocId) handleSelect(target);
        return;
      }
      if (action === "close-tab") {
        event.preventDefault();
        if (current.activeDocId) handleCloseTab(current.activeDocId);
        return;
      }
      if (action === "toggle-documents-panel") {
        setDocsOpen(!docsOpen);
        return;
      }
      if (action === "toggle-outline-panel") {
        setOutlineOpen(!outlineOpen);
        return;
      }
      if (action === "new-document") {
        event.preventDefault();
        handleCreate(null);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    docsOpen,
    handleCloseTab,
    handleCreate,
    handleSelect,
    outlineOpen,
    rememberActiveEditorSelection,
    setDocsOpen,
    setOutlineOpen,
  ]);

  const handleTemplateCreate = useCallback(
    (templateId: DocumentTemplateId | null) => {
      if (!templateRequest) return;
      const user = session.data?.user;
      if (!user) return;
      if (templateId) {
        const template = documentTemplateById(templateId);
        if (
          !canUseDocumentTemplate(
            template,
            user.membershipTier,
            Boolean(user.isLocalMode),
          )
        )
          return;
      }
      const copy = templateId
        ? buildDocumentFromTemplate(templateId, locale)
        : { title: "", content: "" };
      create.mutate(
        { ...copy, folderId: templateRequest.folderId },
        {
          onSuccess: ({ document }) => {
            createdHere.current.add(document.docId);
            setTemplateRequest(null);
            void navigate({
              to: "/editor/$docId",
              params: { docId: document.docId },
            });
          },
        },
      );
    },
    [create, locale, navigate, session.data?.user, templateRequest],
  );

  const handleTemplateClose = useCallback(() => {
    const openedFromRoute = templateRequest?.fromRoute ?? false;
    setTemplateRequest(null);
    create.reset();
    if (!openedFromRoute) return;
    bootstrapped.current = false;
    void navigate({ to: "/editor", search: {}, replace: true });
  }, [create, navigate, templateRequest?.fromRoute]);

  const handleDelete = useCallback(
    async (docId: string, title: string) => {
      if (!(await confirmDelete(title))) return;

      // 先把未存的改动落库，再删。
      //
      // 顺序不能反：后端删文档时会读正文、把里面的图片排进回收队列，读到的是库里
      // 那一版。而防抖窗口是 800ms —— 刚粘进去的图很可能还没保存，此时先删就等于
      // 让后端看不见那些图，它们会成为没人回收的孤儿，永久占着用户的配额。
      //
      // 保存失败时不能继续删：刚上传的图片只存在本地待存正文里，后端删文档时
      // 看不到它们，也就不会入回收队列，最终永久占着配额。保留文档与草稿，
      // 让用户重试，比静默制造无法自救的孤儿对象安全。
      const saved = await saver.flush(docId);
      if (!saved) {
        window.alert(t.editor.deleteSaveFailed);
        return;
      }

      remove.mutate(docId, {
        onSuccess: () => {
          // 用 drop 而不是 forget：forget 会先 flush 一次，而文档此刻已经删了，
          // 那个 PUT 必然 404 —— 白发一次请求，还会把保存状态标成失败。
          // 上面已经 flush 过，这里只需丢掉本地记录。
          saver.drop(docId);
          editorSelections.current.delete(docId);
          // 标签也要摘掉。数据库那边有外键 CASCADE 兜底，但本地状态得立刻反映
          setTabState((prev) => removeDeleted(prev, docId).next);

          // 删的是当前打开的那篇，就跳到剩下的第一篇（没有则回 /editor 触发新建）
          if (docId !== activeDocId) return;
          const rest = (documents ?? []).filter((d) => d.docId !== docId);
          bootstrapped.current = false;
          if (rest.length > 0) {
            void navigate({
              to: "/editor/$docId",
              params: { docId: rest[0].docId },
            });
          } else {
            void navigate({ to: "/editor" });
          }
        },
      });
    },
    [confirmDelete, remove, activeDocId, documents, navigate, saver, t],
  );

  // ---------- 文件夹 ----------

  // 新建成功后让那一行直接进入改名态：名字是空的，不聚焦的话用户得先猜到
  // 「双击可以改名」，加上失败无提示，整件事看起来就像按钮没反应
  const [autoEditFolderId, setAutoEditFolderId] = useState<string | null>(null);

  const handleCreateFolder = useCallback(
    (parentFolderId?: string | null) => {
      createFolder.mutate(
        { name: "", parentFolderId: parentFolderId ?? null },
        { onSuccess: ({ folder }) => setAutoEditFolderId(folder.folderId) },
      );
    },
    [createFolder],
  );

  const handleRenameFolder = useCallback(
    (folderId: string, name: string) => {
      renameFolderMut.mutate({ folderId, name });
    },
    [renameFolderMut],
  );

  const handleDeleteFolder = useCallback(
    async (folderId: string, name: string) => {
      // 说清楚「里面的东西不会被删」—— 否则用户不敢删，或者删了以为丢了正文
      if (
        !(await confirmAction(
          interpolate(t.editor.deleteFolderConfirm, { name }),
        ))
      )
        return;
      deleteFolderMut.mutate(folderId);
    },
    [deleteFolderMut, t.editor.deleteFolderConfirm],
  );

  const handleMoveDoc = useCallback(
    (docId: string, folderId: string | null) => {
      moveDocMut.mutate({ docId, folderId });
    },
    [moveDocMut],
  );

  const handleMoveFolder = useCallback(
    (folderId: string, parentFolderId: string | null) => {
      moveFolderMut.mutate({ folderId, parentFolderId });
    },
    [moveFolderMut],
  );

  const handleImport = useCallback(
    async (files: File[]) => {
      setImporting(true);
      setImportNotice(null);
      setOrganizationNotice(null);
      try {
        const result = await importDocumentsFromFiles(files);
        const success = interpolate(t.transfer.importSuccess, {
          count: String(result.imported),
        });
        const gifNotice = result.flattenedGifCount
          ? ` ${interpolate(t.transfer.importGifFlattened, {
              count: String(result.flattenedGifCount),
            })}`
          : "";
        setImportNotice({
          error: false,
          message: `${success}${gifNotice}`,
        });
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["documents"] }),
          queryClient.invalidateQueries({ queryKey: ["folders"] }),
          queryClient.invalidateQueries({ queryKey: ["storage-usage"] }),
        ]);
      } catch (error) {
        setImportNotice({
          error: true,
          message: getImportErrorMessage(error, t.transfer),
        });
      } finally {
        setImporting(false);
      }
    },
    [queryClient, t.transfer],
  );

  const handleOrganize = useCallback(
    async (
      plan: DocumentOrganizationPlan,
    ): Promise<ApplyDocumentOrganizationResult> => {
      setImportNotice(null);
      setOrganizationNotice(null);
      try {
        const result = await applyDocumentOrganization(plan);
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["documents"] }),
          queryClient.invalidateQueries({ queryKey: ["folders"] }),
        ]);
        setOrganizationNotice({
          error: result.failed > 0,
          message:
            result.failed > 0
              ? interpolate(t.editor.organizer.partial, {
                  moved: result.moved,
                  failed: result.failed,
                })
              : result.moved === 0
                ? t.editor.organizer.upToDate
                : interpolate(t.editor.organizer.success, {
                    count: result.moved,
                  }),
        });
        return result;
      } catch (error) {
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["documents"] }),
          queryClient.invalidateQueries({ queryKey: ["folders"] }),
        ]);
        setOrganizationNotice({ error: true, message: t.editor.organizer.failed });
        throw error;
      }
    },
    [queryClient, t.editor.organizer],
  );

  /**
   * 文件夹六种写操作的失败合成一条提示。
   *
   * 之前全都静默吞掉了 —— 后端没起、没登录、表还没建，点按钮都是「没反应」，
   * 而这个仓库其它地方（保存、导出、上传）都会把失败说出来。
   *
   * 有错误码时优先用码对应的文案：深度超限、名字过长这类是规则违例，报「请求失败」
   * 会让用户以为是网络问题，去重试同一个必然失败的操作。
   */
  const folderError = useMemo(() => {
    const failed = [
      create,
      createFolder,
      renameFolderMut,
      deleteFolderMut,
      moveFolderMut,
      moveDocMut,
    ].find((m) => m.isError);
    if (!failed) return null;
    const err = failed.error;
    if (err instanceof ApiError && err.code && t.errors[err.code]) {
      return t.errors[err.code];
    }
    return t.auth.requestFailed;
  }, [
    create,
    createFolder,
    renameFolderMut,
    deleteFolderMut,
    moveFolderMut,
    moveDocMut,
    t,
  ]);

  // ---------- 门禁与加载态 ----------

  if (session.isLoading) {
    return <Centered>{t.editor.loading}</Centered>;
  }

  if (!loggedIn) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-4 px-4 py-24 text-center">
        <p className="text-lg font-medium">{t.editor.loginRequired}</p>
        <p className="text-sm text-neutral-500">{t.editor.loginRequiredHint}</p>
        <Link
          to="/login"
          className="rounded-full bg-cinnabar-600 px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-cinnabar-500"
        >
          {t.editor.goLogin}
        </Link>
      </div>
    );
  }

  // 两处复用：文档就绪时并入标题栏，未就绪时单独一行
  const expandControls = (
    <>
      {!docsOpen && (
        <ExpandButton
          label={t.editor.documentsPanel}
          icon={<FolderTree className="h-4 w-4" />}
          onClick={() => setDocsOpen(true)}
        />
      )}
      {!outlineOpen && (
        <ExpandButton
          label={t.editor.outlinePanel}
          icon={<ListTree className="h-4 w-4" />}
          onClick={() => setOutlineOpen(true)}
          className="hidden xl:flex"
        />
      )}
    </>
  );

  // 桌面外壳已经锁住页面滚动，这里的 overflow 是工作区自己的第二道边界，避免子面板
  // 溢出相邻列；移动端没有侧栏，刻意不锁这一层，让 Safari 使用页面自然滚动。
  return (
    <div className="flex min-h-0 flex-1 lg:overflow-hidden">
      {/* 第一列：文件树。它是文档间的导航，与正文分属两个层级，保留分隔线。 */}
      {docsOpen ? (
        <ResizablePanel
          storageKey="koinote:panel-width:documents"
          defaultWidth={224}
          ariaLabel={t.editor.resizeDocuments}
          className="hidden lg:block"
        >
          <DocumentList
            documents={documents ?? []}
            folders={folderList.data ?? []}
            activeDocId={activeDocId}
            loading={list.isLoading}
            creating={create.isPending}
            onSelect={handleSelect}
            onCreate={handleCreate}
            onCreateFolder={handleCreateFolder}
            onDelete={handleDelete}
            onRenameFolder={handleRenameFolder}
            onDeleteFolder={handleDeleteFolder}
            onMoveDoc={handleMoveDoc}
            onMoveFolder={handleMoveFolder}
            onCollapse={() => setDocsOpen(false)}
            importing={importing}
            onImport={(files) => void handleImport(files)}
            notice={
              organizationNotice?.error
                ? null
                : organizationNotice?.message ??
                  (importNotice?.error ? null : importNotice?.message)
            }
            error={
              organizationNotice?.error
                ? organizationNotice.message
                : importNotice?.error
                  ? importNotice.message
                  : folderError
            }
            onOrganize={handleOrganize}
            autoEditFolderId={autoEditFolderId}
            onAutoEditDone={() => setAutoEditFolderId(null)}
          />
        </ResizablePanel>
      ) : null}

      {/* 右：正文。大纲作为正文的一部分渲染在其内部，不再是独立的一列。 */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* 面板都收起、或文档尚未就绪时，展开入口需要独立一行兜住；
            文档就绪后按钮并入标题栏（见下方 leadingControls）。 */}
        {(!docsOpen || !outlineOpen) && !doc.data && (
          <div className="hidden items-center gap-1 px-2 pt-2 lg:flex">
            {expandControls}
          </div>
        )}

        <div className="flex items-center border-b border-black/5 px-2 py-1.5 dark:border-white/10 lg:hidden">
          <button
            type="button"
            onClick={() => setMobileDocsOpen(true)}
            aria-label={t.editor.documentsPanel}
            aria-expanded={mobileDocsOpen}
            className="inline-flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs font-medium text-neutral-500 transition hover:bg-black/5 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-white/10 dark:hover:text-neutral-100"
          >
            <FolderTree className="h-4 w-4" />
            {t.editor.documentsPanel}
          </button>
        </div>

        <TabBar
          tabs={tabState.openTabs}
          activeDocId={tabState.activeDocId}
          titleOf={titleOf}
          statusOf={saver.status}
          dirtyOf={saver.isDirty}
          onSelect={handleSelect}
          onClose={handleCloseTab}
          onCreate={handleCreate}
          creating={create.isPending}
          desktopShortcuts={isDesktopRuntime()}
        />

        {/* 加载与错误态盖在池子上方，池子本身继续挂着 ——
            否则切到一篇还在拉取的文档会把其他标签的实例一起卸载 */}
        {doc.isLoading || (!activeDocId && create.isPending) ? (
          <Centered>{t.editor.loading}</Centered>
        ) : doc.isError ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-24 text-center">
            <p className="text-sm text-neutral-500">{t.editor.notFound}</p>
            <button
              type="button"
              onClick={() => void navigate({ to: "/editor" })}
              className="text-sm font-medium text-cinnabar-600 hover:underline"
            >
              {t.editor.backToList}
            </button>
          </div>
        ) : null}

        {/* 挂载池：liveIds 里的都挂着，只有当前那个可见 */}
        {tabState.liveIds.map((liveId) => (
          <LiveEditor
            key={liveId}
            docId={liveId}
            remoteRevision={documents?.find((document) => document.docId === liveId)?.revision}
            historyAvailable={session.data?.user?.membershipTier === "lifetime"}
            member={session.data?.user?.membershipTier === "lifetime"}
            localMode={localMode}
            visible={
              liveId === tabState.activeDocId && !doc.isLoading && !doc.isError
            }
            saver={saver}
            onEditorReady={handleEditorReady}
            onTitleChange={handleTitleChange}
            leadingControls={
              (!docsOpen || !outlineOpen) && (
                <span className="hidden shrink-0 items-center gap-1 lg:flex">
                  {expandControls}
                </span>
              )
            }
            trailingControls={
              // 导出与分享只给当前标签：它们作用于「正在看的这篇」，
              // 后台实例也渲染一份会让 ExportMenu 的弹层出现多个同 id 节点
              liveId === tabState.activeDocId && doc.data ? (
                <>
                  <ExportMenu
                    editor={editor}
                    docId={liveId}
                    title={doc.data.title}
                    themeId={doc.data.theme ?? ""}
                    member={session.data?.user?.membershipTier === "lifetime"}
                    isAdmin={session.data?.user?.isAdmin === true}
                    localMode={localMode}
                  />
                  {!localMode && <button
                    type="button"
                    onClick={() => setShareOpen(true)}
                    title={t.editor.share}
                    aria-label={t.editor.share}
                    className={`flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-medium transition ${
                      doc.data.share
                        ? "text-cinnabar-600 hover:bg-cinnabar-50 dark:text-cinnabar-400 dark:hover:bg-cinnabar-950/40"
                        : "text-neutral-400 hover:bg-black/5 hover:text-neutral-700 dark:hover:bg-white/10 dark:hover:text-neutral-200"
                    }`}
                  >
                    <Share2 className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">{t.editor.share}</span>
                  </button>}
                </>
              ) : null
            }
            outlineSlot={
              // 大纲同理，只跟当前标签
              liveId === tabState.activeDocId && outlineOpen ? (
                <ResizablePanel
                  storageKey="koinote:panel-width:outline"
                  defaultWidth={208}
                  minWidth={140}
                  maxWidth={360}
                  ariaLabel={t.editor.resizeOutline}
                  className="hidden xl:block"
                  bordered={false}
                >
                  <OutlinePanel
                    outline={outline}
                    onJump={(pos) => scrollToHeading(editor, pos)}
                    onCollapse={() => setOutlineOpen(false)}
                  />
                </ResizablePanel>
              ) : null
            }
          />
        ))}
      </div>

      {!localMode && shareOpen && doc.data && (
        <ShareDialog
          docId={doc.data.docId}
          share={doc.data.share}
          onClose={() => setShareOpen(false)}
        />
      )}

      {templateRequest && session.data?.user && (
        <DocumentTemplateDialog
          membershipTier={session.data.user.membershipTier}
          localMode={Boolean(session.data.user.isLocalMode)}
          creating={create.isPending}
          createFailed={create.isError}
          onCreate={handleTemplateCreate}
          onUpgrade={() => void navigate({ to: "/pricing" })}
          onClose={handleTemplateClose}
        />
      )}

      {mobileDocsOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label={t.editor.collapsePanel}
            onClick={() => setMobileDocsOpen(false)}
            className="absolute inset-0 bg-black/35 backdrop-blur-[1px]"
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label={t.editor.documentsPanel}
            className="relative h-full w-[min(86vw,20rem)] border-r bg-white shadow-2xl dark:border-white/10 dark:bg-neutral-950"
            style={{ borderColor: "var(--ink-line)" }}
          >
            <DocumentList
              documents={documents ?? []}
              folders={folderList.data ?? []}
              activeDocId={activeDocId}
              loading={list.isLoading}
              creating={create.isPending}
              onSelect={(docId) => {
                setMobileDocsOpen(false);
                handleSelect(docId);
              }}
              onCreate={(folderId) => {
                setMobileDocsOpen(false);
                handleCreate(folderId);
              }}
              onCreateFolder={handleCreateFolder}
              onDelete={handleDelete}
              onRenameFolder={handleRenameFolder}
              onDeleteFolder={handleDeleteFolder}
              onMoveDoc={handleMoveDoc}
              onMoveFolder={handleMoveFolder}
              onCollapse={() => setMobileDocsOpen(false)}
              importing={importing}
              onImport={(files) => void handleImport(files)}
              notice={
                organizationNotice?.error
                  ? null
                  : organizationNotice?.message ??
                    (importNotice?.error ? null : importNotice?.message)
              }
              error={
                organizationNotice?.error
                  ? organizationNotice.message
                  : importNotice?.error
                    ? importNotice.message
                    : folderError
              }
              onOrganize={handleOrganize}
              autoEditFolderId={autoEditFolderId}
              onAutoEditDone={() => setAutoEditFolderId(null)}
            />
          </aside>
        </div>
      )}
    </div>
  );
}

/** 正文内侧左上角的展开按钮，把收起的面板召回 */
function ExpandButton({
  label,
  icon,
  onClick,
  className = "",
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  className?: string;
}) {
  const { t } = useI18n();
  const title = `${label} · ${t.editor.expandPanel}`;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={title}
      aria-expanded={false}
      title={title}
      className={`flex h-7 w-7 items-center justify-center rounded-lg text-neutral-400 transition hover:bg-black/5 hover:text-neutral-700 dark:hover:bg-white/10 dark:hover:text-neutral-200 ${className}`}
    >
      {icon}
    </button>
  );
}

/** 布尔状态 + localStorage 持久化，用于记住面板折叠状态 */
function usePersistedFlag(
  storageKey: string,
  defaultValue: boolean,
): [boolean, (next: boolean) => void] {
  const [value, setValue] = useState<boolean>(() => {
    if (typeof window === "undefined") return defaultValue;
    const stored = window.localStorage.getItem(storageKey);
    return stored === null ? defaultValue : stored === "true";
  });

  const set = useCallback(
    (next: boolean) => {
      setValue(next);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(storageKey, String(next));
      }
    },
    [storageKey],
  );

  return [value, set];
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 items-center justify-center py-24 text-sm text-neutral-400">
      {children}
    </div>
  );
}
