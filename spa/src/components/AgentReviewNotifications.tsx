import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  LoaderCircle,
  Sparkles,
  X,
} from "lucide-react";

import { AGENT_CREDITS_QUERY_KEY, ApiError, getAgentReview } from "../api";
import {
  AGENT_REVIEW_STARTED_EVENT,
  MAX_STORED_REVIEW_TASKS,
  readAgentReviewTasks,
  requestAgentReviewOpen,
  reviewTasksStorageKey,
  writeAgentReviewTasks,
  type AgentReviewStartedDetail,
  type AgentReviewTask,
} from "../agentReviewNotifications";
import { useI18n } from "../i18n";
import {
  AGENT_REVIEW_BACKGROUND_TIMEOUT_MS,
  agentReviewFailureTranslationCode,
  agentReviewTaskExpired,
} from "./editor/agentReviewCore";

const POLL_INTERVAL_MS = 3_000;

export function AgentReviewNotifications({
  accountKey,
}: {
  accountKey: string;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [tasks, setTasks] = useState<AgentReviewTask[]>(() =>
    readAgentReviewTasks(accountKey),
  );
  const [hiddenRunningIds, setHiddenRunningIds] = useState<Set<string>>(
    () => new Set(),
  );
  const tasksRef = useRef(tasks);
  const pollingRef = useRef(false);

  useEffect(() => {
    tasksRef.current = tasks;
    writeAgentReviewTasks(accountKey, tasks);
  }, [accountKey, tasks]);

  useEffect(() => {
    const onStarted = (event: Event) => {
      const detail = (event as CustomEvent<AgentReviewStartedDetail>).detail;
      if (!detail?.reviewId || !detail.documentId) return;
      setHiddenRunningIds((current) => {
        const next = new Set(current);
        next.delete(detail.reviewId);
        return next;
      });
      setTasks((current) => [
        {
          reviewId: detail.reviewId,
          documentId: detail.documentId,
          createdAt: detail.createdAt,
          expiresAt: new Date(
            Date.now() + AGENT_REVIEW_BACKGROUND_TIMEOUT_MS,
          ).toISOString(),
          status: "running" as const,
          providerMode: detail.providerMode,
        },
        ...current.filter((task) => task.reviewId !== detail.reviewId),
      ].slice(0, MAX_STORED_REVIEW_TASKS));
    };
    window.addEventListener(AGENT_REVIEW_STARTED_EVENT, onStarted);
    return () => window.removeEventListener(AGENT_REVIEW_STARTED_EVENT, onStarted);
  }, []);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== reviewTasksStorageKey(accountKey)) return;
      setTasks(readAgentReviewTasks(accountKey));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [accountKey]);

  const runningReviewIds = useMemo(
    () => tasks.filter((task) => task.status === "running").map((task) => task.reviewId),
    [tasks],
  );
  const runningKey = runningReviewIds.join(",");

  useEffect(() => {
    const runningIds = new Set(runningKey ? runningKey.split(",") : []);
    setHiddenRunningIds((current) => {
      let changed = false;
      const next = new Set(current);
      for (const reviewId of current) {
        if (runningIds.has(reviewId)) continue;
        next.delete(reviewId);
        changed = true;
      }
      return changed ? next : current;
    });
    if (runningIds.size === 0) return;
    const timer = window.setTimeout(() => {
      setHiddenRunningIds((current) => {
        const next = new Set(current);
        for (const reviewId of runningIds) next.add(reviewId);
        return next;
      });
    }, 6_000);
    return () => window.clearTimeout(timer);
  }, [runningKey]);

  const poll = useCallback(async () => {
    const runningReviewIds = runningKey ? runningKey.split(",") : [];
    if (runningReviewIds.length === 0 || pollingRef.current) return;
    const expiredReviewIds = new Set(
      tasksRef.current
        .filter(
          (task) =>
            task.status === "running" &&
            runningReviewIds.includes(task.reviewId) &&
            agentReviewTaskExpired(task.expiresAt, task.createdAt),
        )
        .map((task) => task.reviewId),
    );
    pollingRef.current = true;
    try {
      const results = await Promise.allSettled(
        runningReviewIds.map((reviewId) => getAgentReview(reviewId)),
      );
      const completed = new Map<string, AgentReviewTask>();
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        if (result.status !== "fulfilled") {
          const reviewId = runningReviewIds[index];
          if (
            (result.reason instanceof ApiError && result.reason.status === 404) ||
            expiredReviewIds.has(reviewId)
          ) {
            const existing = tasksRef.current.find(
              (task) => task.reviewId === reviewId,
            );
            if (existing) {
              completed.set(reviewId, {
                ...existing,
                status: "failed",
                errorCode: expiredReviewIds.has(reviewId)
                  ? "review_timeout"
                  : existing.errorCode,
              });
            }
          }
          continue;
        }
        const review = result.value.review;
        if (review.status === "running") continue;
        const status = review.status === "failed"
          ? "failed"
          : review.status === "stale"
            ? "stale"
            : "ready";
        completed.set(review.reviewId, {
          reviewId: review.reviewId,
          documentId: review.documentId,
          createdAt: review.createdAt,
          status,
          errorCode: review.errorCode,
          providerMode: review.providerMode,
        });
        queryClient.setQueryData(["agent-review", review.reviewId], result.value);
        void queryClient.invalidateQueries({
          queryKey: ["agent-reviews", review.documentId],
        });
      }
      if (completed.size === 0) return;
      setTasks((current) =>
        current.map((task) => completed.get(task.reviewId) ?? task),
      );
      void queryClient.invalidateQueries({ queryKey: AGENT_CREDITS_QUERY_KEY });
    } finally {
      pollingRef.current = false;
    }
  }, [queryClient, runningKey]);

  useEffect(() => {
    if (!runningKey) return;
    void poll();
    const timer = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    const pollWhenActive = () => void poll();
    window.addEventListener("focus", pollWhenActive);
    window.addEventListener("online", pollWhenActive);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", pollWhenActive);
      window.removeEventListener("online", pollWhenActive);
    };
  }, [poll, runningKey]);

  const visibleTasks = tasks.filter(
    (task) => task.status !== "running" || !hiddenRunningIds.has(task.reviewId),
  );
  if (visibleTasks.length === 0) return null;

  return (
    <div className="fixed bottom-5 right-4 z-[75] flex w-[min(92vw,24rem)] flex-col gap-3 sm:right-5">
      {visibleTasks.slice(0, 3).map((task) => {
        const running = task.status === "running";
        const ready = task.status === "ready";
        const stale = task.status === "stale";
        const failureCode = agentReviewFailureTranslationCode(task.errorCode, task.providerMode);
        const failureDescription = failureCode
          ? (t.errors as Record<string, string>)[failureCode]
          : undefined;
        return (
          <section
            key={task.reviewId}
            role={running ? "status" : "alert"}
            className="rounded-xl border px-4 py-3 shadow-xl"
            style={{
              borderColor: "var(--ink-line)",
              background: "var(--ink-paper-soft)",
              color: "var(--ink-strong)",
            }}
          >
            <div className="flex items-start gap-3">
              {running ? (
                <LoaderCircle className="mt-0.5 h-5 w-5 shrink-0 animate-spin" style={{ color: "var(--cinnabar)" }} />
              ) : ready ? (
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
              ) : (
                <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" style={{ color: "var(--cinnabar)" }} />
              )}
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">
                  {running
                    ? t.agentReview.backgroundRunning
                    : ready
                      ? t.agentReview.backgroundReady
                      : stale
                        ? t.agentReview.staleTitle
                        : t.agentReview.backgroundFailed}
                </p>
                <p className="mt-1 text-xs leading-5" style={{ color: "var(--ink-mid)" }}>
                  {running
                    ? t.agentReview.backgroundRunningDescription
                    : ready
                      ? t.agentReview.backgroundReadyDescription
                      : stale
                        ? t.agentReview.staleDescription
                        : task.errorCode === "review_timeout"
                          ? t.agentReview.backgroundTimeoutDescription
                          : failureDescription ?? t.agentReview.backgroundFailedDescription}
                </p>
                {ready && (
                  <button
                    type="button"
                    onClick={() => {
                      setTasks((current) =>
                        current.filter((item) => item.reviewId !== task.reviewId),
                      );
                      requestAgentReviewOpen(task);
                      void navigate({
                        to: "/editor/$docId",
                        params: { docId: task.documentId },
                      });
                    }}
                    className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold hover:underline"
                    style={{ color: "var(--cinnabar)" }}
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    {t.agentReview.viewBackgroundResult}
                  </button>
                )}
              </div>
              <button
                type="button"
                aria-label={t.agentReview.dismissNotification}
                title={t.agentReview.dismissNotification}
                onClick={() => {
                  if (running) {
                    setHiddenRunningIds((current) =>
                      new Set(current).add(task.reviewId),
                    );
                  } else {
                    setTasks((current) =>
                      current.filter((item) => item.reviewId !== task.reviewId),
                    );
                  }
                }}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition hover:bg-[var(--ink-wash-strong)]"
                style={{ color: "var(--ink-mid)" }}
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </section>
        );
      })}
    </div>
  );
}
