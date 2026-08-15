import { useCallback, useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { useQueryClient } from "@tanstack/react-query";
import { History, RefreshCw } from "lucide-react";
import { getDocument } from "../../api";
import { DESKTOP_SYNC_EVENT, isDesktopRuntime } from "../../desktop/runtime";
import type { DesktopSyncSummary } from "../../desktop/offlineStore";
import MarkdownEditor from "./MarkdownEditor";
import { useDocument } from "../../documents";
import type { DocPatch, DocumentSaver } from "./useDocumentSaver";
import { ConflictDialog } from "./ConflictDialog";
import { VersionHistoryDialog } from "./VersionHistoryDialog";
import { useI18n } from "../../i18n";
import { decideRemoteDocumentUpdate } from "../../remoteUpdates";

/**
 * 挂载池里的一个编辑器实例。
 *
 * 单独抽成组件是因为每个实例都要自己调 useDocument —— hook 不能在循环里调，
 * 页面层没法为 N 个 docId 各取一份数据。
 *
 * 非当前实例用 display:none 藏起来而不是卸载：这正是多开的意义所在，切回来时
 * 撕销历史、光标位置都还在。代价是滚动位置 —— display:none 之后部分浏览器会把
 * scrollTop 归零，所以手动存取（见下方 scroll ref）。
 */
export function LiveEditor({
  docId,
  remoteRevision,
  visible,
  historyAvailable,
  saver,
  onEditorReady,
  onTitleChange,
  leadingControls,
  trailingControls,
  outlineSlot,
}: {
  docId: string;
  remoteRevision?: number;
  visible: boolean;
  historyAvailable: boolean;
  saver: DocumentSaver;
  /** 只有当前实例上报，否则大纲会跟到后台的某篇上 */
  onEditorReady?: (editor: Editor | null) => void;
  onTitleChange?: (docId: string, title: string) => void;
  leadingControls?: React.ReactNode;
  trailingControls?: React.ReactNode;
  outlineSlot?: React.ReactNode;
}) {
  const doc = useDocument(docId);
  const queryClient = useQueryClient();
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollTop = useRef(0);
  const [editorGeneration, setEditorGeneration] = useState(0);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [seededDocId, setSeededDocId] = useState<string | null>(null);
  const [remoteUpdateAvailable, setRemoteUpdateAvailable] = useState(false);
  const [remoteUpdated, setRemoteUpdated] = useState(false);
  const remoteUpdatedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const acceptLatestDocument = useCallback((document: NonNullable<typeof doc.data>) => {
    saver.acceptRemote(docId, {
      title: document.title,
      content: document.content,
      theme: document.theme ?? "",
      revision: document.revision,
    });
    queryClient.setQueryData(["document", docId], document);
    onTitleChange?.(docId, document.title);
    setRemoteUpdateAvailable(false);
    setRemoteUpdated(true);
    if (remoteUpdatedTimer.current) clearTimeout(remoteUpdatedTimer.current);
    remoteUpdatedTimer.current = setTimeout(() => setRemoteUpdated(false), 4_000);
    setEditorGeneration((value) => value + 1);
  }, [docId, onTitleChange, queryClient, saver]);

  useEffect(() => () => {
    if (remoteUpdatedTimer.current) clearTimeout(remoteUpdatedTimer.current);
  }, []);

  // 文档到手后铺一份基线。seed 内部对已有待存内容不覆盖 ——
  // 被淘汰又点回来时，本地未落库的改动比服务端那份新
  useEffect(() => {
    if (!doc.data) return;
    saver.seed(docId, {
      title: doc.data.title,
      content: doc.data.content,
      theme: doc.data.theme ?? "",
      revision: doc.data.revision,
    });
    setSeededDocId(docId);
  }, [doc.data, docId, saver]);

  useEffect(() => {
    if (!isDesktopRuntime()) return;
    let disposed = false;
    const onDesktopSync = (event: Event) => {
      const summary = (event as CustomEvent<DesktopSyncSummary>).detail;
      if (summary.state !== "idle" || saver.isDirty(docId)) return;
      void getDocument(docId).then(({ document }) => {
        if (disposed || saver.isDirty(docId)) return;
        const current = saver.peek(docId);
        if (
          current?.revision === document.revision &&
          current.title === document.title &&
          current.theme === document.theme &&
          current.content === document.content
        ) {
          return;
        }
        acceptLatestDocument(document);
      }).catch(() => undefined);
    };
    window.addEventListener(DESKTOP_SYNC_EVENT, onDesktopSync);
    return () => {
      disposed = true;
      window.removeEventListener(DESKTOP_SYNC_EVENT, onDesktopSync);
    };
  }, [acceptLatestDocument, docId, saver]);

  useEffect(() => {
    if (isDesktopRuntime() || remoteRevision === undefined) return;
    const current = saver.peek(docId);
    const decision = decideRemoteDocumentUpdate(
      current?.revision ?? doc.data?.revision ?? 0,
      remoteRevision,
      saver.isDirty(docId),
    );
    if (decision === "unchanged") return;

    let disposed = false;
    void getDocument(docId).then(({ document }) => {
      if (disposed) return;
      const latest = saver.peek(docId);
      const latestDecision = decideRemoteDocumentUpdate(
        latest?.revision ?? doc.data?.revision ?? 0,
        document.revision,
        saver.isDirty(docId),
      );
      if (latestDecision === "prompt") {
        setRemoteUpdateAvailable(true);
      } else if (latestDecision === "apply") {
        acceptLatestDocument(document);
      }
    }).catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, [acceptLatestDocument, doc.data?.revision, docId, remoteRevision, saver]);

  // 隐藏前记住滚动位置，显示后还原
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (visible) {
      el.scrollTop = scrollTop.current;
    } else {
      scrollTop.current = el.scrollTop;
    }
  }, [visible]);

  // 传给编辑器的 document 要合并未落库的改动，否则重新挂载会退回服务端那份，
  // 用户看到自己刚写的字消失
  // 不能只按 doc.data 做 memo：刷新后 seed 从 localStorage 恢复冲突草稿时，
  // 远端 query 不会变化，memo 会把草稿一直挡在编辑器外面。
  const pending = saver.peek(docId);
  const merged =
    doc.data && seededDocId === docId
      ? pending
        ? { ...doc.data, ...pending }
        : doc.data
      : null;

  if (!merged) return null;

  const status = saver.status(docId);

  async function openHistory() {
    const saved = await saver.flush(docId);
    if (!saved) {
      if (saver.status(docId) === "conflict") setConflictOpen(true);
      return;
    }
    setHistoryOpen(true);
  }

  function acceptDocument(next: NonNullable<typeof merged>) {
    queryClient.setQueryData(["document", docId], next);
    onTitleChange?.(docId, next.title);
    void queryClient.invalidateQueries({ queryKey: ["documents"] });
    saver.acceptRemote(docId, {
      title: next.title,
      content: next.content,
      theme: next.theme ?? "",
      revision: next.revision,
    });
    setRemoteUpdateAvailable(false);
    setRemoteUpdated(false);
    setEditorGeneration((value) => value + 1);
  }

  return (
    <div className={visible ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
      {remoteUpdateAvailable && (
        <div
          role="alert"
          className="flex items-center gap-2 border-b px-4 py-2 text-xs"
          style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }}
        >
          <RefreshCw className="h-3.5 w-3.5 shrink-0" />
          <span>{t.editor.remoteUpdateAvailable}</span>
          <button
            type="button"
            onClick={() => setConflictOpen(true)}
            className="ml-auto shrink-0 font-semibold hover:underline"
            style={{ color: "var(--cinnabar)" }}
          >
            {t.editor.reviewRemoteUpdate}
          </button>
        </div>
      )}
      {remoteUpdated && !remoteUpdateAvailable && (
        <div
          role="status"
          className="flex items-center gap-2 border-b px-4 py-2 text-xs"
          style={{ borderColor: "var(--ink-line)", color: "var(--ink-faint)" }}
        >
          <RefreshCw className="h-3.5 w-3.5 shrink-0" />
          {t.editor.remoteUpdated}
        </div>
      )}
      <MarkdownEditor
        key={`${docId}:${editorGeneration}`}
        document={merged}
        status={status}
        onChange={(patch: DocPatch) => {
          saver.queue(docId, patch);
          if (patch.title !== undefined) onTitleChange?.(docId, patch.title);
        }}
        onFlush={() => void saver.flush(docId)}
        onEditorReady={visible ? onEditorReady : undefined}
        scrollContainerRef={scrollRef}
        leadingControls={leadingControls}
        trailingControls={
          <>
            {status === "conflict" && (
              <button
                type="button"
                onClick={() => setConflictOpen(true)}
                className="rounded-lg px-2 py-1 text-xs font-medium text-red-600 transition hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
              >
                {t.editor.resolveConflict}
              </button>
            )}
            {historyAvailable && (
              <button
                type="button"
                onClick={() => void openHistory()}
                title={t.editor.history}
                aria-label={t.editor.history}
                className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-neutral-400 transition hover:bg-black/5 hover:text-neutral-700 dark:hover:bg-white/10 dark:hover:text-neutral-200"
              >
                <History className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">{t.editor.history}</span>
              </button>
            )}
            {trailingControls}
          </>
        }
        outlineSlot={outlineSlot}
      />
      {visible && conflictOpen && (
        <ConflictDialog
          docId={docId}
          local={saver.peek(docId)!}
          onAcceptRemote={(remote) => {
            acceptDocument(remote);
            setConflictOpen(false);
          }}
          onOverwrite={async (remoteRevision, patch) => {
            const saved = await saver.overwrite(docId, remoteRevision, patch);
            if (saved) {
              setRemoteUpdateAvailable(false);
              setRemoteUpdated(false);
              onTitleChange?.(docId, patch.title);
              void queryClient.invalidateQueries({ queryKey: ["documents"] });
              setConflictOpen(false);
              setEditorGeneration((value) => value + 1);
            }
            return saved;
          }}
          onClose={() => setConflictOpen(false)}
        />
      )}
      {visible && historyAvailable && historyOpen && (
        <VersionHistoryDialog
          document={merged}
          onRestore={(restored) => {
            acceptDocument(restored);
            setHistoryOpen(false);
          }}
          onClose={() => setHistoryOpen(false)}
        />
      )}
    </div>
  );
}
