import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { FolderTree, ListTree, Share2 } from "lucide-react";
import { LiveEditor } from "../components/editor/LiveEditor";
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
  useDeleteDocument,
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
import {
  EMPTY_TABS,
  activate,
  close,
  hydrate,
  removeDeleted,
  type TabState,
} from "../components/editor/tabPool";
import { useSession } from "../auth";
import { interpolate, useI18n } from "../i18n";

// 早期版本把正文存在这个 key 下（单文档、无账号）。
// 现在改为账号内多文档，首次进入且云端为空时把它导入为第一篇，不静默丢弃。
const LEGACY_STORAGE_KEY = "koinote:document";

export function EditorPage() {
  const { t } = useI18n();
  const session = useSession();
  const navigate = useNavigate();
  const params = useParams({ strict: false }) as { docId?: string };
  const activeDocId = params.docId;

  const loggedIn = Boolean(session.data?.user);
  const list = useDocumentList(loggedIn);
  const create = useCreateDocument();
  const remove = useDeleteDocument();
  const folderList = useFolderList(loggedIn);
  const createFolder = useCreateFolder();
  const renameFolderMut = useRenameFolder();
  const deleteFolderMut = useDeleteFolder();
  const moveFolderMut = useMoveFolder();
  const moveDocMut = useMoveDocument();
  const refreshList = useRefreshDocumentList();
  const confirmDelete = useDeleteConfirm();

  const [editor, setEditor] = useState<Editor | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [tabState, setTabState] = useState<TabState>(EMPTY_TABS);
  const saver = useDocumentSaver(refreshList);
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

  // 自动落地逻辑只跑一次，避免重复建文档
  const bootstrapped = useRef(false);

  const documents = list.data;

  // 无 docId 时：跳最近编辑的一篇；一篇都没有则新建（顺带导入本地遗留草稿）
  useEffect(() => {
    if (!loggedIn || activeDocId || !documents || bootstrapped.current) return;
    if (create.isPending) return;

    if (documents.length > 0) {
      bootstrapped.current = true;
      void navigate({ to: "/editor/$docId", params: { docId: documents[0].docId } });
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
  }, [loggedIn, activeDocId, documents, create, navigate, t.editor.importedLocalDraft]);

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

  // handleCloseTab 要在 updater 外面读当前标签状态
  const tabStateRef = useRef(tabState);
  tabStateRef.current = tabState;

  /**
   * 本次会话里由「+」新建的 docId。
   *
   * 用来区分「刚建的空文档」与「从服务端载入的空文档」—— 前者关掉标签就该删，
   * 后者是用户的数据，不能因为关个标签就没了。
   */
  const createdHere = useRef<Set<string>>(new Set());

  // URL 是当前标签的唯一真相。地址栏变化（含前进后退、深链）都要落进标签状态
  useEffect(() => {
    if (!activeDocId) return;
    if (justClosed.current === activeDocId) return; // 地址还没跟上，别把它拉回来
    setTabState((prev) => {
      if (prev.activeDocId === activeDocId && prev.openTabs.includes(activeDocId)) {
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

  /**
   * 标签上显示的标题。
   *
   * 单独存一份而不是从 saver.peek 读：peek 读的是 ref，改动不触发渲染，标签标题
   * 会等到保存完成才更新 —— 打字时看着像卡住了。
   */
  const [liveTitles, setLiveTitles] = useState<Record<string, string>>({});

  const handleTitleChange = useCallback((docId: string, title: string) => {
    setLiveTitles((prev) => (prev[docId] === title ? prev : { ...prev, [docId]: title }));
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

  const handleCreate = useCallback(() => {
    create.mutate(undefined, {
      onSuccess: ({ document }) => {
        createdHere.current.add(document.docId);
        void navigate({
          to: "/editor/$docId",
          params: { docId: document.docId },
        });
      },
    });
  }, [create, navigate]);

  const handleDelete = useCallback(
    (docId: string, title: string) => {
      if (!confirmDelete(title)) return;
      remove.mutate(docId, {
        onSuccess: () => {
          // 删掉的文档不该再留着待存内容 —— 发出去只会 404
          void saver.forget(docId);
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
    [confirmDelete, remove, activeDocId, documents, navigate, saver],
  );

  // ---------- 文件夹 ----------

  // 新建成功后让那一行直接进入改名态：名字是空的，不聚焦的话用户得先猜到
  // 「双击可以改名」，加上失败无提示，整件事看起来就像按钮没反应
  const [autoEditFolderId, setAutoEditFolderId] = useState<string | null>(null);

  const handleCreateFolder = useCallback(() => {
    createFolder.mutate(
      { name: "", parentFolderId: null },
      { onSuccess: ({ folder }) => setAutoEditFolderId(folder.folderId) },
    );
  }, [createFolder]);

  const handleRenameFolder = useCallback(
    (folderId: string, name: string) => {
      renameFolderMut.mutate({ folderId, name });
    },
    [renameFolderMut],
  );

  const handleDeleteFolder = useCallback(
    (folderId: string, name: string) => {
      // 说清楚「里面的东西不会被删」—— 否则用户不敢删，或者删了以为丢了正文
      if (!window.confirm(interpolate(t.editor.deleteFolderConfirm, { name }))) return;
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

  /**
   * 文件夹五种写操作的失败合成一条提示。
   *
   * 之前全都静默吞掉了 —— 后端没起、没登录、表还没建，点按钮都是「没反应」，
   * 而这个仓库其它地方（保存、导出、上传）都会把失败说出来。
   */
  const folderError =
    createFolder.isError ||
    renameFolderMut.isError ||
    deleteFolderMut.isError ||
    moveFolderMut.isError ||
    moveDocMut.isError
      ? t.auth.requestFailed
      : null;

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
          className="rounded-full bg-sky-600 px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-sky-500"
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

  return (
    <div className="flex min-h-0 flex-1">
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
            error={folderError}
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
              className="text-sm font-medium text-sky-600 hover:underline"
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
            visible={liveId === tabState.activeDocId && !doc.isLoading && !doc.isError}
            saver={saver}
            onEditorReady={setEditor}
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
                    title={doc.data.title}
                    themeId={doc.data.theme ?? ""}
                  />
                  <button
                    type="button"
                    onClick={() => setShareOpen(true)}
                    title={t.editor.share}
                    aria-label={t.editor.share}
                    className={`flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-medium transition ${
                      doc.data.share
                        ? "text-sky-600 hover:bg-sky-50 dark:text-sky-400 dark:hover:bg-sky-950/40"
                        : "text-neutral-400 hover:bg-black/5 hover:text-neutral-700 dark:hover:bg-white/10 dark:hover:text-neutral-200"
                    }`}
                  >
                    <Share2 className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">{t.editor.share}</span>
                  </button>
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

      {shareOpen && doc.data && (
        <ShareDialog
          docId={doc.data.docId}
          share={doc.data.share}
          onClose={() => setShareOpen(false)}
        />
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

