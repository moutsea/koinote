import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { FolderTree, ListTree, Share2 } from "lucide-react";
import MarkdownEditor from "../components/editor/MarkdownEditor";
import { DocumentList } from "../components/editor/DocumentList";
import { useDeleteConfirm } from "../components/editor/useDeleteConfirm";
import { OutlinePanel } from "../components/editor/OutlinePanel";
import { ResizablePanel } from "../components/editor/ResizablePanel";
import { ShareDialog } from "../components/editor/ShareDialog";
import { scrollToHeading, useOutline } from "../components/editor/useOutline";
import {
  useCreateDocument,
  useDeleteDocument,
  useDocument,
  useDocumentList,
  useRefreshDocumentList,
} from "../documents";
import { useSession } from "../auth";
import { useI18n } from "../i18n";

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
  const refreshList = useRefreshDocumentList();
  const confirmDelete = useDeleteConfirm();

  const [editor, setEditor] = useState<Editor | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
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

  const handleSelect = useCallback(
    (docId: string) => {
      void navigate({ to: "/editor/$docId", params: { docId } });
    },
    [navigate],
  );

  const handleCreate = useCallback(() => {
    create.mutate(undefined, {
      onSuccess: ({ document }) => {
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
    [confirmDelete, remove, activeDocId, documents, navigate],
  );

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
            activeDocId={activeDocId}
            loading={list.isLoading}
            creating={create.isPending}
            onSelect={handleSelect}
            onCreate={handleCreate}
            onDelete={handleDelete}
            onCollapse={() => setDocsOpen(false)}
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
        ) : doc.data ? (
          <MarkdownEditor
            key={doc.data.docId}
            document={doc.data}
            onEditorReady={setEditor}
            onTitleCommitted={refreshList}
            leadingControls={
              (!docsOpen || !outlineOpen) && (
                <span className="hidden shrink-0 items-center gap-1 lg:flex">
                  {expandControls}
                </span>
              )
            }
            trailingControls={
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
            }
            outlineSlot={
              outlineOpen ? (
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
        ) : (
          <Centered>{t.editor.loading}</Centered>
        )}
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

