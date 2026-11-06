import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUp,
  Check,
  ChevronRight,
  FilePenLine,
  FileText,
  ListFilter,
  Plus,
  RotateCcw,
  ScanText,
  Sparkles,
  X,
} from "lucide-react";
import { ApiError } from "../../api";
import "./ArticleAgentPanel.css";
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
  type AgentSessionPage,
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

// Local stand-in until the server returns the task; it never reaches the API.
const sendingProgress = { id: "sending", status: "preparing", cancelRequested: false } as const;

const hints = {
  zh: [
    "只可修改这篇文章。其他文档可以作为只读参考。",
    "离线模式无法连接 Koi AI，请联网并登录后再试。",
  ],
  en: [
    "Only this article can be edited. Other documents can be read as references.",
    "Koi AI requires an online, signed-in account.",
  ],
  fr: [
    "Seul cet article peut être modifié. Les autres documents peuvent servir de références.",
    "Koi AI nécessite un compte connecté et un accès au réseau.",
  ],
  ja: [
    "編集できるのはこの記事だけです。他の文書は参考として閲覧できます。",
    "Koi AI を利用するにはオンラインでログインしてください。",
  ],
};
const articleText = {
  zh: {
    scope: "当前文章",
    intro: "想怎么改这篇文章？",
    revision: "文章修订",
    you: "你",
    stopped: "后续处理已停止，已应用的改动已保留。",
    stale: "这份修订基于旧正文。请先拒绝旧稿，再按最新文章重新发起修改。",
    staleUndo: "文章已有新的文字修改。为保留这些内容，无法直接撤销这份修订。",
    placeholder: "告诉 Koi 想改哪里…",
    starters: ["润色表达", "检查错别字", "精简开头"],
  },
  en: {
    scope: "Current article",
    intro: "What would you like to change?",
    revision: "Article revision",
    you: "You",
    stopped: "The task stopped. Applied changes are still in the article.",
    stale:
      "The text has changed. Reject this draft and request a revision of the latest article.",
    staleUndo:
      "The text has changed again. This revision cannot be undone without overwriting those edits.",
    placeholder: "Tell Koi what to revise…",
    starters: ["Polish the wording", "Check spelling", "Tighten the opening"],
  },
  fr: {
    scope: "Article actuel",
    intro: "Que souhaitez-vous modifier ?",
    revision: "Révision de l’article",
    you: "Vous",
    stopped:
      "Le traitement s’est arrêté. Les modifications appliquées sont conservées.",
    stale:
      "Le texte a changé. Refusez cette proposition et demandez une révision du texte actuel.",
    staleUndo:
      "Le texte a de nouveau changé. Une annulation écraserait ces modifications.",
    placeholder: "Que doit revoir Koi ?",
    starters: [
      "Affiner le style",
      "Corriger les fautes",
      "Raccourcir l’introduction",
    ],
  },
  ja: {
    scope: "現在の記事",
    intro: "記事のどこを直しますか？",
    revision: "記事の修正案",
    you: "あなた",
    stopped: "処理は停止しました。適用済みの変更は保持されています。",
    stale:
      "本文が更新されました。この案を却下し、最新の記事で改めて修正を依頼してください。",
    staleUndo:
      "本文が再び更新されました。その変更を保つため、この修正を取り消せません。",
    placeholder: "Koi に修正したい箇所を伝える…",
    starters: ["表現を整える", "誤字を確認する", "冒頭を短くする"],
  },
};
const starterIcons = [Sparkles, ScanText, ListFilter];
const button = "koi-article-action";

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
  const copy = articleText[locale];
  const client = useQueryClient();
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // Visible from the click until the accepted task is in the thread.
  // `before` holds the tasks already shown, so a refresh that delivers this
  // task before the POST returns cannot show the message twice.
  const [sending, setSending] = useState<{
    message: string;
    before: ReadonlySet<string>;
    taskId?: string;
  } | null>(null);
  const thread = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const prependFrom = useRef<{ top: number; height: number } | null>(null);
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
  useLayoutEffect(() => {
    const el = thread.current;
    if (!el || !page) return;
    if (prependFrom.current) {
      const { top, height } = prependFrom.current;
      el.scrollTop = top + el.scrollHeight - height;
      prependFrom.current = null;
    } else if (followLatest.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [page, olderTasks, events.data, sending]);
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
      followLatest.current = true;
      setSending({ message, before: new Set(history.map((task) => task.id)) });
      try {
        if (!(await onPrepareReview())) throw new Error(labels.draftChanged);
        if (!mounted.current) return;
        if (attempt.current?.message !== message)
          attempt.current = { message, id: crypto.randomUUID() };
        storeDraft(draft);
        const { task } = await sendAgentMessage(id, {
          message,
          requestId: attempt.current.id,
          skillRepositoryId: 0,
          skillPath: "",
        });
        // Show the accepted task now; the refresh below only adds server detail.
        setSending((s) => s && { ...s, taskId: task.id });
        client.setQueryData<AgentSessionPage>(key, (data) =>
          data && !data.tasks.some((item) => item.id === task.id)
            ? { ...data, tasks: [task, ...data.tasks] }
            : data,
        );
        attempt.current = undefined;
        storeDraft("");
        await refresh();
      } finally {
        if (mounted.current) setSending(null);
      }
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
      const result = await actOnAgentOperation(op, action).catch((e) => {
        if (e instanceof ApiError && e.code === "revision_conflict")
          throw new Error(action === "undo" ? copy.staleUndo : copy.stale);
        throw e;
      });
      setOlderOps((old) =>
        old.map((item) => (item.id === op.id ? result.operation : item)),
      );
      setPreviewId("");
      if (action !== "reject") notifyAgentDocumentChange(docId);
      await refresh();
    });
  }
  const actions = (op: AgentOperation) => (
    <>
      {op.status === "pending" && (
        <>
          <button
            className={button + " koi-article-primary"}
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
          <RotateCcw size={13} aria-hidden="true" />
          {labels.undo}
        </button>
      )}
    </>
  );
  const access = localMode
    ? hints[locale][1]
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
      <header className="koi-article-header">
        <span className="koi-article-logo">
          <Logo className="h-7 w-7" />
        </span>
        <div className="koi-article-heading">
          <h2>Koi AI</h2>
          <span title={title || t.editor.untitled}>
            <FileText size={12} /> {title || t.editor.untitled}
          </span>
        </div>
        {page && tasks.length > 0 && !active && (
          <button
            className="koi-article-icon"
            aria-label={labels.newSession}
            title={labels.newSession}
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
            <Plus size={18} />
          </button>
        )}
        <button
          className="koi-article-icon"
          aria-label={t.agentReview.close}
          title={t.agentReview.close}
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>
      <div
        className="koi-article-thread"
        ref={thread}
        onScroll={(event) => {
          const el = event.currentTarget;
          followLatest.current =
            el.scrollHeight - el.clientHeight - el.scrollTop < 32;
        }}
      >
        {access && <p className="koi-article-access">{access}</p>}
        {page && history.length === 0 && (
          <div className="koi-article-empty">
            <span className="koi-article-emblem">
              <FilePenLine size={25} strokeWidth={1.4} />
            </span>
            <h3>{copy.intro}</h3>
            <p>{hints[locale][0]}</p>
            <div className="koi-article-starters">
              {copy.starters.map((label, i) => {
                const Icon = starterIcons[i];
                return (
                  <button
                    type="button"
                    key={label}
                    onClick={() => {
                      storeDraft(label);
                      inputRef.current?.focus();
                    }}
                  >
                    <Icon size={14} />
                    {label}
                    <ChevronRight size={13} />
                  </button>
                );
              })}
            </div>
          </div>
        )}
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
                if (thread.current)
                  prependFrom.current = {
                    top: thread.current.scrollTop,
                    height: thread.current.scrollHeight,
                  };
                setOlderTasks((rows) => [...rows, ...older.tasks]);
                setOlderOps((rows) => [...rows, ...older.operations]);
                setOlderCursor(older.nextCursor || "end");
              })
            }
          >
            {labels.older}
          </button>
        )}
        {history.map((task) => {
          const changes = allOps.filter((op) => op.taskId === task.id);
          const applied = changes.some((op) => op.status === "applied");
          return (
            <section className="koi-article-turn" key={task.id}>
              <div className="koi-article-user">
                <span className="koi-article-byline">{copy.you}</span>
                <p>{task.message}</p>
              </div>
              <div className="koi-article-author">
                <Logo className="h-5 w-5" />
                Koi
              </div>
              {!writingFinished(task) && (
                <AgentProgress
                  task={task}
                  events={
                    active?.id === task.id ? events.data?.events : undefined
                  }
                  approvalHint={labels.waitingApproval}
                />
              )}
              {(!changes.length ||
                task.taskIntent?.outcome !== "operations_reported") && (
                <AgentTaskReply task={task} operations={allOps} />
              )}
              {task.status === "cancelled" && (
                <p className="koi-article-note">
                  {applied ? copy.stopped : writing.cancelled}
                </p>
              )}
              {task.error && (
                <p role="alert" className="koi-article-error">
                  {task.error}
                </p>
              )}
              {changes.map((op) => {
                const details = (
                  <>
                    {op.input.explanation && (
                      <p className="koi-article-explanation">
                        {op.input.explanation}
                      </p>
                    )}
                    <div className="koi-article-actions">
                      <button
                        type="button"
                        className={button + " koi-article-diff"}
                        onClick={() => setPreviewId(op.id)}
                      >
                        <FileText size={14} />
                        {labels.diff}
                      </button>
                      {actions(op)}
                    </div>
                  </>
                );
                if (
                  op.status === "cancelled" ||
                  op.status === "rejected" ||
                  op.status === "superseded"
                ) {
                  return (
                    <details key={op.id} className="koi-article-archived">
                      <summary>
                        <ChevronRight size={14} />
                        {copy.revision}
                        <span>{labels[op.status]}</span>
                      </summary>
                      {details}
                    </details>
                  );
                }
                return (
                  <article
                    className="koi-article-change"
                    key={op.id}
                    data-status={op.status}
                  >
                    <div className="koi-article-change-title">
                      <FilePenLine size={17} />
                      <strong>{copy.revision}</strong>
                      <span className="koi-article-badge">
                        {op.status === "applied" && <Check size={12} />}
                        {labels[op.status]}
                      </span>
                    </div>
                    {details}
                  </article>
                );
              })}
              {!writingFinished(task) && (
                <button
                  className="koi-article-stop"
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
          );
        })}
        {sending && !history.some((task) =>
          task.id === sending.taskId || (!sending.before.has(task.id) && task.message === sending.message)) && (
          <section className="koi-article-turn" data-agent-sending>
            <div className="koi-article-user">
              <span className="koi-article-byline">{copy.you}</span>
              <p>{sending.message}</p>
            </div>
            <div className="koi-article-author">
              <Logo className="h-5 w-5" />
              Koi
            </div>
            <AgentProgress task={sendingProgress} />
          </section>
        )}
      </div>
      {!access && (
        <form
          className="koi-article-compose"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          {error && (
            <p role="alert" className="koi-article-error">
              {error}
            </p>
          )}
          <div className="koi-article-inputbox">
            <textarea
              aria-label={labels.input}
              placeholder={copy.placeholder}
              rows={2}
              maxLength={16000}
              value={draft}
              className="koi-article-input"
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
            <div className="koi-article-toolbar">
              <span className="koi-article-scope" title={hints[locale][0]}>
                <FileText size={13} />
                {copy.scope}
              </span>
              <span className="koi-article-shortcut">
                {labels.sendShortcut}
              </span>
              <button
                type="submit"
                className="koi-article-send"
                aria-label={labels.send}
                title={labels.send}
                disabled={!page || !!active || busy || !draft.trim()}
              >
                <ArrowUp size={17} />
                <span className="sr-only">{labels.send}</span>
              </button>
            </div>
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
