import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import {
  ApiError,
  getDocument,
  AGENT_CREDITS_QUERY_KEY,
  type Document,
} from "../../api";
import { useI18n } from "../../i18n";
import { writingAgentText } from "../../i18n/writingAgent";
import {
  applyWritingTask,
  cancelWritingTask,
  createWritingTask,
  getWritingConfig,
  getWritingTask,
  listWritingTasks,
  writingFinished,
  type WritingTask,
} from "../../writingAgent";
import { buildVersionDiff } from "./versionDiff";
import { pushModal } from "../../modalStack";
import { AgentProgress } from "../AgentProgress";

export function WritingAgentPanel({
  docId,
  member,
  localMode,
  onPrepare,
  onAccept,
  onClose,
}: {
  docId: string;
  member: boolean;
  localMode: boolean;
  onPrepare: () => Promise<boolean>;
  onAccept: (document: Document) => Promise<boolean>;
  onClose: () => void;
}) {
  const { locale } = useI18n();
  const t = writingAgentText[locale];
  const qc = useQueryClient();
  const [message, setMessage] = useState("");
  const [skill, setSkill] = useState("");
  const [selected, setSelected] = useState("");
  const request = useRef({ fingerprint: "", id: "" });
  const eligible = member && !localMode;
  const config = useQuery({
    queryKey: ["writing-config"],
    queryFn: getWritingConfig,
    enabled: eligible,
  });
  const history = useQuery({
    queryKey: ["writing-tasks", docId],
    queryFn: () => listWritingTasks(docId),
    enabled: eligible,
  });
  const id = selected || history.data?.tasks[0]?.id || "";
  const detail = useQuery({
    queryKey: ["writing-task", id],
    queryFn: () => getWritingTask(id),
    enabled: eligible && !!id,
    refetchInterval: (query) =>
      query.state.data && writingFinished(query.state.data.task) ? false : 2500,
  });
  const task = detail.data?.task;
  const diff = useMemo(
    () =>
      task?.proposal
        ? buildVersionDiff(task.source.content, task.proposal.content)
        : null,
    [task],
  );
  const options = (config.data?.skills ?? []).map((item) => ({
    value: JSON.stringify([item.repositoryId, item.path]),
    label: `${item.name} · ${item.path}`,
  }));
  const refresh = async () => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["writing-tasks", docId] }),
      qc.invalidateQueries({ queryKey: ["writing-task", id] }),
      qc.invalidateQueries({ queryKey: AGENT_CREDITS_QUERY_KEY }),
    ]);
  };
  const create = useMutation({
    mutationFn: async () => {
      if (!(await onPrepare())) throw new Error(t.saveError);
      const { document } = await getDocument(docId);
      const [skillRepositoryId, skillPath] = skill
        ? (JSON.parse(skill) as [number, string])
        : [0, ""];
      const input = {
        docId,
        expectedRevision: document.remoteRevision ?? document.revision,
        message: message.trim(),
        skillRepositoryId,
        skillPath,
      };
      const fingerprint = JSON.stringify(input);
      if (request.current.fingerprint !== fingerprint)
        request.current = { fingerprint, id: crypto.randomUUID() };
      return createWritingTask({ ...input, requestId: request.current.id });
    },
    onSuccess: async ({ task: next }) => {
      setSelected(next.id);
      request.current = { fingerprint: "", id: "" };
      await refresh();
    },
  });
  const cancel = useMutation({
    mutationFn: () => cancelWritingTask(id),
    onSuccess: refresh,
  });
  const apply = useMutation({
    mutationFn: async (current: WritingTask) => {
      if (!(await onPrepare())) throw new Error(t.saveError);
      const { document } = await applyWritingTask(current);
      if (!(await onAccept(document))) throw new Error(t.conflict);
    },
    onSettled: refresh,
  });
  const busy = create.isPending || apply.isPending;
  useEffect(() => {
    const release = pushModal();
    return release;
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [busy, onClose]);
  useEffect(() => {
    if (task && writingFinished(task))
      void qc.invalidateQueries({ queryKey: AGENT_CREDITS_QUERY_KEY });
  }, [task?.status, qc]);
  const error =
    create.error ||
    apply.error ||
    cancel.error ||
    detail.error ||
    config.error ||
    history.error;
  const errorText =
    error instanceof ApiError && error.status === 409
      ? t.conflict
      : error instanceof Error
        ? error.message
        : t.failed;
  const button =
    "rounded-lg border px-3 py-2 text-sm disabled:opacity-40 hover:bg-black/5 dark:hover:bg-white/5";
  return (
    <>
      <button
        type="button"
        aria-label={t.close}
        onClick={() => !busy && onClose()}
        className="fixed inset-0 top-14 z-[55] bg-black/20"
      />
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="writing-agent-title"
        className="fixed bottom-0 right-0 top-14 z-[60] flex w-full flex-col border-l shadow-2xl sm:max-w-[42rem]"
        style={{
          background: "var(--ink-paper)",
          color: "var(--ink-black)",
          borderColor: "var(--ink-line)",
        }}
      >
        <header
          className="flex items-center justify-between border-b p-4"
          style={{ borderColor: "var(--ink-line)" }}
        >
          <h2 id="writing-agent-title" className="font-semibold">
            {t.title}
          </h2>
          <button
            type="button"
            aria-label={t.close}
            onClick={onClose}
            disabled={busy}
          >
            <X size={18} />
          </button>
        </header>
        <div className="flex-1 space-y-5 overflow-auto p-4 text-sm">
          <p>{t.intro}</p>
          {!eligible ? (
            <p>{t.access}</p>
          ) : (
            <>
              {config.isPending ? (
                <p>{t.loading}</p>
              ) : (
                !config.data?.enabled && <p>{t.unavailable}</p>
              )}
              <label className="block space-y-2">
                <span>{t.skill}</span>
                <select
                  className="w-full rounded-lg border bg-transparent p-2"
                  value={skill}
                  onChange={(e) => setSkill(e.target.value)}
                  disabled={busy}
                >
                  <option value="">{t.builtin}</option>
                  {options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <textarea
                aria-label={t.prompt}
                placeholder={t.prompt}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                maxLength={4000}
                disabled={busy}
                rows={4}
                className="w-full resize-y rounded-lg border bg-transparent p-3"
              />
              <p className="text-xs opacity-70">{t.cost}</p>
              <button
                type="button"
                className={button}
                disabled={
                  busy ||
                  !config.data?.enabled ||
                  !message.trim() ||
                  (!!task && !writingFinished(task))
                }
                onClick={() => create.mutate()}
              >
                {create.isPending ? t.loading : t.start}
              </button>
              {!!history.data?.tasks.length && (
                <label className="block space-y-2">
                  <span>{t.history}</span>
                  <select
                    value={id}
                    disabled={busy}
                    onChange={(e) => {
                      setSelected(e.target.value);
                      apply.reset();
                      cancel.reset();
                    }}
                    className="w-full rounded-lg border bg-transparent p-2"
                  >
                    {history.data.tasks.map((item) => (
                      <option key={item.id} value={item.id}>
                        {new Date(item.createdAt).toLocaleString(locale)} ·{" "}
                        {item.message.slice(0, 45)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {error && (
                <div role="alert" className="space-y-2 text-red-600">
                  <p>{errorText}</p>
                  <button
                    type="button"
                    className={button}
                    onClick={() => {
                      void refresh();
                      void config.refetch();
                    }}
                  >
                    {t.retry}
                  </button>
                </div>
              )}
              {task && (
                <>
                  <AgentProgress task={task} events={detail.data?.events} approvalHint={t.approval} />
                  {!writingFinished(task) && (
                    <div className="flex justify-end">
                      <button
                        type="button"
                        className={`${button} ml-auto`}
                        disabled={cancel.isPending || task.cancelRequested}
                        onClick={() => cancel.mutate()}
                      >
                        {task.cancelRequested ? t.cancelling : t.cancel}
                      </button>
                    </div>
                  )}
                  {task.error && <p role="alert">{task.error}</p>}
                  <p className="text-xs">
                    {t.credits}:{" "}
                    {task.billingStatus === "reserved"
                      ? `${task.reservedCredits} → …`
                      : task.chargedCredits}
                    {task.usage?.totalTokens !== undefined &&
                      ` · ${task.usage.totalTokens.toLocaleString()} tokens`}
                  </p>
                  {task.billingStatus === "needs_review" && (
                    <p>{t.unknownUsage}</p>
                  )}
                  {task.result && (
                    <details open>
                      <summary>{t.result}</summary>
                      <p className="mt-2 whitespace-pre-wrap break-words">
                        {task.result}
                      </p>
                    </details>
                  )}
                  {task.proposal && diff && (
                    <section className="space-y-3">
                      <h3 className="font-semibold">{t.proposal}</h3>
                      <p>{task.proposal.explanation}</p>
                      {task.source.title !== task.proposal.title && (
                        <div>
                          <del className="text-red-600">
                            {task.source.title}
                          </del>
                          <p className="text-green-700 dark:text-green-400">
                            {task.proposal.title}
                          </p>
                        </div>
                      )}
                      <div
                        className="overflow-x-auto rounded-lg border font-mono text-xs"
                        aria-label={`${t.before} → ${t.after}`}
                      >
                        {diff.lines.map((line, index) => (
                          <div
                            key={index}
                            className={`whitespace-pre-wrap break-words px-2 py-0.5 ${line.kind === "add" ? "bg-green-500/10 text-green-800 dark:text-green-300" : line.kind === "remove" ? "bg-red-500/10 text-red-800 dark:text-red-300" : "opacity-70"}`}
                          >
                            {line.kind === "add"
                              ? "+ "
                              : line.kind === "remove"
                                ? "− "
                                : "  "}
                            {line.text}
                          </div>
                        ))}
                      </div>
                      {task.appliedDocument ? (
                        <p>{t.applied}</p>
                      ) : (
                        <button
                          type="button"
                          className={button}
                          disabled={busy || task.status !== "completed"}
                          onClick={() => apply.mutate(task)}
                        >
                          {apply.isPending ? t.loading : t.apply}
                        </button>
                      )}
                    </section>
                  )}
                  {writingFinished(task) && !task.proposal && (
                    <p>{t.noProposal}</p>
                  )}
                </>
              )}
            </>
          )}
        </div>
      </section>
    </>
  );
}
