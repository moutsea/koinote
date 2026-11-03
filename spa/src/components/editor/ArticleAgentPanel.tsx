import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Send, X } from "lucide-react";
import { Logo } from "../Logo";
import { confirmAction } from "../../confirmAction";
import { useI18n } from "../../i18n";
import { agentPanelText } from "../../i18n/agentPanel";
import { writingAgentText } from "../../i18n/writingAgent";
import {
  actOnAgentOperation,
  deleteAgentSession,
  getAgentSession,
  openArticleAgentSession,
  sendAgentMessage,
  type AgentOperation,
} from "../../agentSessions";
import { notifyAgentDocumentChange } from "../../agentContext";
import {
  cancelWritingTask,
  getWritingTask,
  writingFinished,
} from "../../writingAgent";
import { AgentTaskReply } from "../AgentTaskReply";
import { AgentProgress } from "../AgentProgress";
import { AgentDiffDialog } from "../AgentDiffDialog";
import { AgentReviewSheet } from "./AgentReviewSheet";

const hints = {
  zh: [
    "只可修改这篇文章。其他文档可以作为只读参考。",
    "例如：参考《产品说明》的语气，精简这篇文章的开头。",
    "离线模式无法连接 Koi AI，请联网并登录后再试。",
  ],
  en: [
    "Only this article can be edited. Other documents can be read as references.",
    "For example: shorten this introduction using the product guide as a reference.",
    "Koi AI requires an online, signed-in account.",
  ],
  fr: [
    "Seul cet article peut être modifié. Les autres documents peuvent servir de références.",
    "Par exemple : raccourcis l’introduction en t’inspirant du guide produit.",
    "Koi AI nécessite un compte connecté et un accès au réseau.",
  ],
  ja: [
    "編集できるのはこの記事だけです。他の文書は参考として閲覧できます。",
    "例：製品ガイドの文体を参考に、この記事の導入を短くしてください。",
    "Koi AI を利用するにはオンラインでログインしてください。",
  ],
};
const button = "rounded-lg border px-3 py-1.5 text-sm disabled:opacity-50";

export function ArticleAgentPanel({
  docId,
  title,
  member,
  localMode,
  onPrepareReview,
  onClose,
}: {
  docId: string;
  title: string;
  member: boolean;
  localMode: boolean;
  onPrepareReview: () => Promise<boolean>;
  onClose: () => void;
}) {
  const { locale, t } = useI18n();
  const labels = agentPanelText[locale],
    writing = writingAgentText[locale];
  const client = useQueryClient();
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [previewId, setPreviewId] = useState("");
  const [olderCursor, setOlderCursor] = useState("");
  const [olderTasks, setOlderTasks] = useState<
    import("../../writingAgent").WritingTask[]
  >([]);
  const [olderOps, setOlderOps] = useState<AgentOperation[]>([]);
  const mounted = useRef(true),
    locked = useRef(false),
    composing = useRef(false);
  const attempt = useRef<{ message: string; id: string } | undefined>(
    undefined,
  );
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const opened = useQuery({
    queryKey: ["article-koi-open", docId],
    queryFn: () => openArticleAgentSession(docId),
    enabled: member && !localMode,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });
  const id = opened.data?.session.id;
  const draftKey = id ? "koinote:article-ai:draft:" + id : undefined;
  const saved = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!draftKey) return;
    let text = "";
    attempt.current = undefined;
    try {
      const cached = JSON.parse(sessionStorage.getItem(draftKey) || "null");
      if (typeof cached?.text === "string") text = cached.text;
      if (
        typeof cached?.attempt?.message === "string" &&
        typeof cached.attempt.id === "string"
      )
        attempt.current = cached.attempt;
    } catch {
      /* Storage can be unavailable in private windows. */
    }
    saved.current = draftKey;
    setDraft(text);
  }, [draftKey]);
  function storeDraft(text: string) {
    setDraft(text);
    if (!draftKey || saved.current !== draftKey) return;
    try {
      if (text || attempt.current)
        sessionStorage.setItem(
          draftKey,
          JSON.stringify({ text, attempt: attempt.current }),
        );
      else sessionStorage.removeItem(draftKey);
    } catch {
      /* The open form still retains the input. */
    }
  }
  const key = ["article-koi-session", id];
  const session = useQuery({
    queryKey: key,
    queryFn: () => getAgentSession(id!),
    enabled: !!id && member && !localMode,
    initialData: opened.data,
    refetchInterval: (query) =>
      query.state.data?.tasks.some((task) => !writingFinished(task))
        ? 1500
        : false,
  });
  const page =
    member &&
    !localMode &&
    id &&
    session.data?.session.id === id &&
    session.data.session.writeDocumentId === docId
      ? session.data
      : undefined;
  useEffect(() => {
    if (page?.session.id) inputRef.current?.focus();
  }, [page?.session.id]);
  const tasks = page?.tasks ?? [],
    ops = page?.operations ?? [];
  const active = tasks.find((task) => !writingFinished(task));
  const events = useQuery({
    queryKey: ["article-koi-events", active?.id],
    queryFn: () => getWritingTask(active!.id),
    enabled: !!active,
    refetchInterval: 1800,
  });
  const allOps = [
    ...ops,
    ...olderOps.filter((old) => !ops.some((op) => op.id === old.id)),
  ];
  const preview = allOps.find((op) => op.id === previewId);
  const changes = ops
    .filter((op) => op.status === "applied" || op.status === "undone")
    .map((op) => op.id + op.status)
    .sort()
    .join("|");
  useEffect(() => {
    if (changes) notifyAgentDocumentChange(docId);
  }, [docId, changes]);
  async function run(action: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      if (mounted.current) {
        setError(e instanceof Error ? e.message : writing.failed);
        if (id) void refresh();
      }
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function refresh() {
    await client.invalidateQueries({ queryKey: key });
  }
  async function send() {
    const message = draft.trim();
    if (!message || !id || !page || active) return;
    await run(async () => {
      if (!(await onPrepareReview())) throw new Error(labels.draftChanged);
      if (!mounted.current) return;
      if (attempt.current?.message !== message)
        attempt.current = { message, id: crypto.randomUUID() };
      storeDraft(draft);
      await sendAgentMessage(id, {
        message,
        requestId: attempt.current.id,
        skillRepositoryId: 0,
        skillPath: "",
      });
      attempt.current = undefined;
      storeDraft("");
      await refresh();
    });
  }
  async function decide(
    op: AgentOperation,
    action: "approve" | "reject" | "undo",
  ) {
    await run(async () => {
      if (action !== "reject" && !(await onPrepareReview()))
        throw new Error(labels.draftChanged);
      if (!mounted.current) return;
      const result = await actOnAgentOperation(op, action);
      setOlderOps((old) =>
        old.map((item) => (item.id === op.id ? result.operation : item)),
      );
      setPreviewId("");
      if (action !== "reject") notifyAgentDocumentChange(docId);
      await refresh();
    });
  }
  const actions = (op: AgentOperation) => (
    <div className="flex flex-wrap gap-2">
      {op.status === "pending" && (
        <>
          <button
            className={button}
            disabled={busy}
            onClick={() => void decide(op, "approve")}
          >
            {labels.approve}
          </button>
          <button
            className={button}
            disabled={busy}
            onClick={() => void decide(op, "reject")}
          >
            {labels.reject}
          </button>
        </>
      )}
      {op.status === "applied" && (
        <button
          className={button}
          disabled={busy}
          onClick={() => void decide(op, "undo")}
        >
          {labels.undo}
        </button>
      )}
    </div>
  );
  const access = localMode
    ? hints[locale][2]
    : !member
      ? t.agentReview.membersOnly
      : "";
  const history = [
    ...tasks,
    ...olderTasks.filter((old) => !tasks.some((task) => task.id === old.id)),
  ].reverse();
  return (
    <AgentReviewSheet
      title="Koi AI"
      closeLabel={t.agentReview.close}
      onClose={onClose}
    >
      <header
        className="flex shrink-0 items-center gap-3 border-b px-4 py-3 sm:px-5"
        style={{ borderColor: "var(--ink-line)" }}
      >
        <Logo className="h-5 w-5" />
        <h2 className="font-semibold">Koi AI</h2>
        <span className="min-w-0 flex-1 truncate text-sm opacity-70">
          {title || t.editor.untitled}
        </span>
        {page && tasks.length > 0 && !active && (
          <button
            className={button}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                if (!(await confirmAction(labels.confirmDelete))) return;
                await deleteAgentSession(page.session.id);
                attempt.current = undefined;
                storeDraft("");
                setOlderCursor("");
                setOlderTasks([]);
                setOlderOps([]);
                setPreviewId("");
                await opened.refetch();
              })
            }
          >
            {labels.newSession}
          </button>
        )}
        <button aria-label={t.agentReview.close} onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
        <p className="text-sm opacity-70">{access || hints[locale][0]}</p>
        {!access && (opened.isLoading || (!page && session.isLoading)) && (
          <p role="status">{writing.loading}</p>
        )}
        {!access && (opened.isError || session.isError) && (
          <button
            className={button}
            onClick={() => void (id ? session.refetch() : opened.refetch())}
          >
            {labels.reload}
          </button>
        )}
        {!!page?.nextCursor && olderCursor !== "end" && (
          <button
            className={button}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const older = await getAgentSession(
                  id!,
                  olderCursor || page.nextCursor,
                );
                setOlderTasks((rows) => [...rows, ...older.tasks]);
                setOlderOps((rows) => [...rows, ...older.operations]);
                setOlderCursor(older.nextCursor || "end");
              })
            }
          >
            {labels.older}
          </button>
        )}
        {history.map((task) => (
          <section
            key={task.id}
            className="space-y-3 rounded-xl border p-3"
            style={{ borderColor: "var(--ink-line)" }}
          >
            <p className="whitespace-pre-wrap font-medium">{task.message}</p>
            <AgentProgress
              task={task}
              events={active?.id === task.id ? events.data?.events : undefined}
              approvalHint={labels.waitingApproval}
            />
            <AgentTaskReply task={task} operations={allOps} />
            {task.error && (
              <p role="alert" className="text-sm text-red-600">
                {task.error}
              </p>
            )}
            {allOps
              .filter((op) => op.taskId === task.id)
              .map((op) => (
                <div key={op.id} className="space-y-2 border-t pt-2">
                  <p className="text-sm">{op.input.explanation}</p>
                  <p className="text-xs opacity-70">{labels[op.status]}</p>
                  <button
                    className={button}
                    onClick={() => setPreviewId(op.id)}
                  >
                    {labels.diff}
                  </button>
                  {actions(op)}
                </div>
              ))}
            {!writingFinished(task) && (
              <button
                className={button}
                disabled={busy || task.cancelRequested}
                onClick={() =>
                  void run(async () => {
                    await cancelWritingTask(task.id);
                    await refresh();
                  })
                }
              >
                {writing.cancel}
              </button>
            )}
          </section>
        ))}
      </div>
      {!access && (
        <form
          className="space-y-2 border-t p-4"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          {error && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}
          <textarea
            aria-label={labels.input}
            placeholder={hints[locale][1]}
            rows={3}
            maxLength={16000}
            value={draft}
            className="w-full resize-y rounded-xl border bg-transparent p-3 text-sm"
            ref={inputRef}
            disabled={busy || !page}
            onChange={(event) => storeDraft(event.target.value)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onBlur={() => {
              composing.current = false;
            }}
            onKeyDown={(event) => {
              if (
                event.key !== "Enter" ||
                composing.current ||
                event.nativeEvent.isComposing ||
                event.nativeEvent.keyCode === 229
              )
                return;
              if (event.ctrlKey) {
                event.preventDefault();
                const el = event.currentTarget;
                if (
                  el.value.length - (el.selectionEnd - el.selectionStart) <
                  el.maxLength
                ) {
                  el.setRangeText(
                    "\n",
                    el.selectionStart,
                    el.selectionEnd,
                    "end",
                  );
                  storeDraft(el.value);
                }
                return;
              }
              if (event.shiftKey) return;
              event.preventDefault();
              if (!event.repeat) void send();
            }}
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs opacity-60">{labels.sendShortcut}</span>
            <button
              type="submit"
              className={button + " flex items-center gap-2"}
              disabled={!page || !!active || busy || !draft.trim()}
            >
              <Send size={14} />
              {labels.send}
            </button>
          </div>
        </form>
      )}
      {preview && (
        <AgentDiffDialog
          beforeTitle={preview.before?.document.title ?? title}
          afterTitle={preview.input.title ?? title}
          beforeContent={preview.before?.document.content ?? ""}
          afterContent={preview.input.content ?? ""}
          actions={actions(preview)}
          error={error}
          onClose={() => setPreviewId("")}
        />
      )}
    </AgentReviewSheet>
  );
}
