import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  Bot,
  Check,
  CheckCheck,
  Clock3,
  LoaderCircle,
  Sparkles,
  X,
} from "lucide-react";
import {
  AGENT_CREDITS_QUERY_KEY,
  AGENT_SETTINGS_QUERY_KEY,
  ApiError,
  applyAgentReviewSuggestion,
  applyAllAgentReviewSuggestions,
  createAgentReview,
  dismissAgentReview,
  dismissAgentReviewSuggestion,
  getAgentCredits,
  getAgentSettings,
  getAgentReview,
  listAgentReviews,
  type AgentReview,
  type AgentReviewSuggestion,
  type Document,
} from "../../api";
import { confirmAction } from "../../confirmAction";
import { interpolate, useI18n } from "../../i18n";
import {
  agentReviewAccess,
  canStartAgentReview,
  titleScoreNeedsAlternatives,
} from "./agentReviewCore";

export function AgentReviewPanel({
  docId,
  member,
  localMode,
  onPrepareReview,
  onAcceptDocument,
  onClose,
}: {
  docId: string;
  member: boolean;
  localMode: boolean;
  onPrepareReview: () => Promise<boolean>;
  onAcceptDocument: (document: Document) => void;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const access = agentReviewAccess(member, localMode);
  const remoteEnabled = access === "ready";
  const [selectedReviewId, setSelectedReviewId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const settings = useQuery({
    queryKey: AGENT_SETTINGS_QUERY_KEY,
    queryFn: getAgentSettings,
    enabled: remoteEnabled,
    retry: false,
  });
  const providerMode = settings.data?.settings.providerMode ?? "builtin";
  const credits = useQuery({
    queryKey: AGENT_CREDITS_QUERY_KEY,
    queryFn: getAgentCredits,
    enabled: remoteEnabled && providerMode === "builtin",
    retry: false,
  });
  const reviews = useQuery({
    queryKey: ["agent-reviews", docId],
    queryFn: () => listAgentReviews(docId),
    enabled: remoteEnabled,
    retry: false,
  });
  const review = useQuery({
    queryKey: ["agent-review", selectedReviewId],
    queryFn: () => getAgentReview(selectedReviewId),
    enabled: remoteEnabled && selectedReviewId !== "",
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.review.status === "running" ? 2_000 : false,
  });

  useEffect(() => {
    if (selectedReviewId || !reviews.data?.reviews.length) return;
    setSelectedReviewId(reviews.data.reviews[0].reviewId);
  }, [reviews.data?.reviews, selectedReviewId]);

  const selectedReviewStatus = review.data?.review.status;
  useEffect(() => {
    if (!selectedReviewStatus || selectedReviewStatus === "running") return;
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ["agent-reviews", docId] }),
      queryClient.invalidateQueries({ queryKey: AGENT_CREDITS_QUERY_KEY }),
    ]);
  }, [docId, queryClient, selectedReviewStatus]);

  const refreshReviewQueries = async (nextReview: AgentReview) => {
    queryClient.setQueryData(["agent-review", nextReview.reviewId], {
      review: nextReview,
    });
    await queryClient.invalidateQueries({ queryKey: ["agent-reviews", docId] });
  };

  const create = useMutation({
    mutationFn: async () => {
      if (!(await onPrepareReview())) throw new Error("document_save_failed");
      return createAgentReview(docId);
    },
    async onSuccess(result) {
      setError(null);
      setSelectedReviewId(result.review.reviewId);
      queryClient.setQueryData(["agent-review", result.review.reviewId], result);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["agent-reviews", docId] }),
        queryClient.invalidateQueries({ queryKey: AGENT_CREDITS_QUERY_KEY }),
      ]);
    },
    onError(value) {
      setError(
        value instanceof Error && value.message === "document_save_failed"
          ? t.agentReview.saveFailed
          : agentReviewErrorText(value, t.agentReview.failedTitle, t.errors),
      );
    },
  });

  const applyOne = useMutation({
    mutationFn: async ({ current, suggestion }: { current: AgentReview; suggestion: AgentReviewSuggestion }) => {
      if (!(await onPrepareReview())) throw new Error("document_save_failed");
      return applyAgentReviewSuggestion(current.reviewId, suggestion.suggestionId, current.currentRevision);
    },
    async onSuccess(result) {
      setError(null);
      onAcceptDocument(result.document);
      await refreshReviewQueries(result.review);
    },
    async onError(value) {
      setError(
        value instanceof Error && value.message === "document_save_failed"
          ? t.agentReview.saveFailed
          : agentReviewErrorText(value, t.auth.requestFailed, t.errors),
      );
      await review.refetch();
    },
  });

  const dismissOne = useMutation({
    mutationFn: ({ current, suggestion }: { current: AgentReview; suggestion: AgentReviewSuggestion }) =>
      dismissAgentReviewSuggestion(current.reviewId, suggestion.suggestionId),
    async onSuccess(result) {
      setError(null);
      await refreshReviewQueries(result.review);
    },
    onError(value) {
      setError(agentReviewErrorText(value, t.auth.requestFailed, t.errors));
    },
  });

  const applyAll = useMutation({
    mutationFn: async (current: AgentReview) => {
      if (!(await onPrepareReview())) throw new Error("document_save_failed");
      return applyAllAgentReviewSuggestions(current.reviewId, current.currentRevision);
    },
    async onSuccess(result) {
      setError(null);
      onAcceptDocument(result.document);
      await refreshReviewQueries(result.review);
    },
    async onError(value) {
      setError(
        value instanceof Error && value.message === "document_save_failed"
          ? t.agentReview.saveFailed
          : agentReviewErrorText(value, t.auth.requestFailed, t.errors),
      );
      await review.refetch();
    },
  });

  const dismissAll = useMutation({
    mutationFn: (current: AgentReview) => dismissAgentReview(current.reviewId),
    async onSuccess(result) {
      setError(null);
      await refreshReviewQueries(result.review);
    },
    onError(value) {
      setError(agentReviewErrorText(value, t.auth.requestFailed, t.errors));
    },
  });

  const current = review.data?.review;
  const reviewRunning = current?.status === "running";
  const mutating = applyOne.isPending || dismissOne.isPending || applyAll.isPending || dismissAll.isPending;
  const builtinEnabled = credits.data?.credits.builtinEnabled ?? false;
  const canStart = canStartAgentReview(
    providerMode,
    builtinEnabled,
    settings.data?.settings.defaultChannel?.channelId ?? "",
  );

  function startReview() {
    if (!canStart) {
      setError(
        providerMode === "builtin"
          ? t.errors.agent_llm_not_configured
          : t.agentReview.configureChannels,
      );
      return;
    }
    create.mutate();
  }

  async function ignoreAll() {
    if (!current || !(await confirmAction(t.agentReview.dismissAllConfirm))) return;
    dismissAll.mutate(current);
  }

  return (
    <>
      <button
        type="button"
        aria-label={t.agentReview.close}
        onClick={onClose}
        className="fixed inset-0 top-14 z-[55] bg-black/20 backdrop-blur-[1px]"
      />
      <aside
        aria-label={t.agentReview.title}
        className="fixed inset-y-14 right-0 z-[60] flex w-full flex-col border-l shadow-2xl sm:max-w-[36rem]"
        style={{ borderColor: "var(--ink-line)", background: "var(--ink-paper)", color: "var(--ink-black)" }}
      >
        <header className="flex shrink-0 items-start gap-3 border-b px-4 py-4 sm:px-5" style={{ borderColor: "var(--ink-line)" }}>
          <Bot className="mt-0.5 h-5 w-5 shrink-0" style={{ color: "var(--cinnabar)" }} />
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold">{t.agentReview.title}</h2>
            <p className="mt-1 text-xs leading-5" style={{ color: "var(--ink-mid)" }}>
              {t.agentReview.description}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t.agentReview.close}
            title={t.agentReview.close}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition hover:bg-[var(--ink-wash)]"
            style={{ color: "var(--ink-mid)" }}
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-5">
          {access === "local_mode_unavailable" ? (
            <GateMessage text={t.agentReview.localModeUnavailable} />
          ) : access === "membership_required" ? (
            <GateMessage text={t.agentReview.membersOnly}>
              <Link
                to="/dashboard"
                hash="membership"
                className="mt-4 inline-flex rounded-full px-4 py-2 text-sm font-semibold"
                style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}
              >
                {t.agentReview.upgrade}
              </Link>
            </GateMessage>
          ) : (
            <>
              <section>
                {providerMode === "builtin" && credits.data?.credits && (
                  <div className="text-right text-xs tabular-nums" style={{ color: "var(--ink-faint)" }}>
                    <p>{interpolate(t.agentReview.availableCredits, { count: credits.data.credits.available })}</p>
                    {credits.data.credits.reserved > 0 && (
                      <p className="mt-1">
                        {interpolate(t.agentCredits.estimatedCharge, { count: credits.data.credits.reserved })}
                      </p>
                    )}
                  </div>
                )}
                {providerMode === "byok" && !settings.data?.settings.defaultChannel && !settings.isLoading && (
                  <Link
                    to="/ai-settings"
                    hash="llm-channels"
                    className="inline-flex text-xs font-semibold hover:underline"
                    style={{ color: "var(--cinnabar)" }}
                  >
                    {t.agentReview.configureChannels}
                  </Link>
                )}
                {settings.isError && (
                  <p className="text-sm" role="alert" style={{ color: "var(--cinnabar)" }}>
                    {t.agentModelSettings.loadFailed}
                  </p>
                )}
                {providerMode === "builtin" && credits.isError && (
                  <p className="text-sm" role="alert" style={{ color: "var(--cinnabar)" }}>
                    {t.agentCredits.loadFailed}
                  </p>
                )}
                <button
                  type="button"
                  onClick={startReview}
                  disabled={create.isPending || reviewRunning || credits.isLoading || credits.isError || settings.isLoading || settings.isError}
                  className="mt-3 inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-md px-4 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50"
                  style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}
                >
                  {create.isPending || reviewRunning ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                  {create.isPending || reviewRunning ? t.agentReview.running : t.agentReview.start}
                </button>
              </section>

              {error && (
                <p role="alert" className="mt-4 rounded-md border px-3 py-2 text-sm" style={{ borderColor: "var(--cinnabar)", color: "var(--cinnabar)" }}>
                  {error}
                </p>
              )}

              <section className="mt-6 border-t pt-5" style={{ borderColor: "var(--ink-line)" }}>
                <div className="flex items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold">{t.agentReview.previousReviews}</h3>
                  {reviews.data?.reviews.length ? (
                    <select
                      aria-label={t.agentReview.previousReviews}
                      value={selectedReviewId}
                      onChange={(event) => setSelectedReviewId(event.target.value)}
                      className="max-w-52 rounded-md border bg-transparent px-2 py-1.5 text-xs outline-none"
                      style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }}
                    >
                      {reviews.data.reviews.map((item) => (
                        <option key={item.reviewId} value={item.reviewId}>
                          {formatReviewDate(item.createdAt, locale)} · {t.agentReview.statuses[item.status]}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </div>

                {reviews.isLoading || review.isLoading ? (
                  <div className="flex items-center gap-2 py-8 text-sm" style={{ color: "var(--ink-faint)" }}>
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                    {t.agentReview.loading}
                  </div>
                ) : reviews.isError || review.isError ? (
                  <p className="py-6 text-sm" role="alert" style={{ color: "var(--cinnabar)" }}>
                    {t.agentReview.loadFailed}
                  </p>
                ) : !current ? (
                  <p className="py-8 text-sm" style={{ color: "var(--ink-faint)" }}>
                    {t.agentReview.noPreviousReviews}
                  </p>
                ) : (
                  <ReviewDetail
                    review={current}
                    mutating={mutating}
                    applyingId={applyOne.variables?.suggestion.suggestionId}
                    onApply={(suggestion) => applyOne.mutate({ current, suggestion })}
                    onDismiss={(suggestion) => dismissOne.mutate({ current, suggestion })}
                    onApplyAll={() => applyAll.mutate(current)}
                    onDismissAll={() => void ignoreAll()}
                  />
                )}
              </section>
            </>
          )}
        </div>
      </aside>
    </>
  );
}

function ReviewDetail({
  review,
  mutating,
  applyingId,
  onApply,
  onDismiss,
  onApplyAll,
  onDismissAll,
}: {
  review: AgentReview;
  mutating: boolean;
  applyingId?: string;
  onApply: (suggestion: AgentReviewSuggestion) => void;
  onDismiss: (suggestion: AgentReviewSuggestion) => void;
  onApplyAll: () => void;
  onDismissAll: () => void;
}) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<"content" | "layout">("content");
  const actionable = review.status === "ready" || review.status === "partially_applied";
  // The list endpoint omits suggestions; tolerate that shape while the detail
  // request is loading or when an older response is still in the cache.
  const suggestions = review.suggestions ?? [];
  const pending = suggestions.filter((item) => item.status === "pending");
  const contentSuggestions = suggestions.filter((item) => item.kind !== "layout");
  const layoutSuggestions = suggestions.filter((item) => item.kind === "layout");
  const layoutAssessment = review.layoutAssessment ?? [];

  if (review.status === "running") {
    return <StatusBlock icon={<LoaderCircle className="h-5 w-5 animate-spin" />} title={t.agentReview.running} />;
  }
  if (review.status === "stale") {
    return <StatusBlock icon={<Clock3 className="h-5 w-5" />} title={t.agentReview.staleTitle} body={t.agentReview.staleDescription} />;
  }
  if (review.status === "failed") {
    const message = reviewFailureStatusText(review.errorCode, t.errors, t.agentReview.failedTitle);
    return <StatusBlock icon={<AlertCircle className="h-5 w-5" />} title={t.agentReview.failedTitle} body={message} />;
  }

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border px-2.5 py-1 text-xs" style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }}>
          {t.agentReview.statuses[review.status]}
        </span>
      </div>

      {review.summary && (
        <div className="mt-4 border-l-2 pl-3" style={{ borderColor: "var(--ink-line)" }}>
          <h4 className="text-xs font-semibold" style={{ color: "var(--ink-strong)" }}>{t.agentReview.summary}</h4>
          <p className="mt-1 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{review.summary}</p>
        </div>
      )}

      {review.providerMode === "builtin" && review.totalTokens > 0 && (
        <p className="mt-3 text-xs" style={{ color: "var(--ink-faint)" }}>
          {interpolate(t.agentReview.usage, { credits: review.creditsCharged })}
        </p>
      )}

      {actionable && pending.length > 0 && (
        <div className="mt-5 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onDismissAll}
            disabled={mutating}
            className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md border px-3 text-xs font-semibold disabled:opacity-50"
            style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }}
          >
            <X className="h-3.5 w-3.5" />
            {t.agentReview.dismissAll}
          </button>
          <button
            type="button"
            onClick={onApplyAll}
            disabled={mutating}
            className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md px-3 text-xs font-semibold disabled:opacity-50"
            style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}
          >
            {mutating ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <CheckCheck className="h-3.5 w-3.5" />}
            {mutating ? t.agentReview.applyingAll : t.agentReview.applyAll}
          </button>
        </div>
      )}

      <div className="mt-6 grid grid-cols-2 rounded-md border p-1" style={{ borderColor: "var(--ink-line)", background: "var(--ink-wash)" }}>
        {(["content", "layout"] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className="min-h-9 rounded px-3 text-xs font-semibold transition"
            style={{
              background: activeTab === tab ? "var(--ink-paper)" : "transparent",
              color: activeTab === tab ? "var(--ink-strong)" : "var(--ink-mid)",
              boxShadow: activeTab === tab ? "0 1px 2px rgb(0 0 0 / 0.06)" : "none",
            }}
          >
            {tab === "content" ? t.agentReview.contentReview : t.agentReview.layoutReview}
          </button>
        ))}
      </div>

      {activeTab === "content" ? (
        <div>
          {review.titleScore !== null && review.titleScore !== undefined && (
            <p className="mt-5 text-sm font-semibold tabular-nums" style={{ color: titleScoreNeedsAlternatives(review.titleScore) ? "var(--cinnabar)" : "var(--ink-strong)" }}>
              {interpolate(t.agentReview.titleScore, { score: review.titleScore })}
            </p>
          )}
          {review.titleAssessment && (
            <p className="mt-2 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>
              {review.titleAssessment}
            </p>
          )}
          <SuggestionCollection
            suggestions={contentSuggestions}
            emptyText={t.agentReview.noContentSuggestions}
            mutating={mutating}
            applyingId={applyingId}
            onApply={onApply}
            onDismiss={onDismiss}
          />
        </div>
      ) : (
        <div>
          <h4 className="mt-5 text-sm font-semibold">{t.agentReview.layoutAssessment}</h4>
          {layoutAssessment.length > 0 && (
            <div className="mt-3 grid grid-cols-2 gap-2">
              {layoutAssessment.map((dimension) => (
                <article key={dimension.id} className="rounded-md border p-3" style={{ borderColor: "var(--ink-line)", background: "var(--ink-paper-soft)" }}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold">{dimension.label}</span>
                    <span className="text-xs font-semibold tabular-nums" style={{ color: dimension.score < 60 ? "var(--cinnabar)" : "var(--ink-mid)" }}>
                      {dimension.score}
                    </span>
                  </div>
                  <p className="mt-1.5 text-xs leading-5" style={{ color: "var(--ink-mid)" }}>{dimension.summary}</p>
                </article>
              ))}
            </div>
          )}
          <SuggestionCollection
            suggestions={layoutSuggestions}
            emptyText={t.agentReview.noLayoutSuggestions}
            mutating={mutating}
            applyingId={applyingId}
            onApply={onApply}
            onDismiss={onDismiss}
          />
        </div>
      )}
    </div>
  );
}

function SuggestionCollection({
  suggestions,
  emptyText,
  mutating,
  applyingId,
  onApply,
  onDismiss,
}: {
  suggestions: AgentReviewSuggestion[];
  emptyText: string;
  mutating: boolean;
  applyingId?: string;
  onApply: (suggestion: AgentReviewSuggestion) => void;
  onDismiss: (suggestion: AgentReviewSuggestion) => void;
}) {
  const { t } = useI18n();
  return (
    <>
      <h4 className="mt-6 text-sm font-semibold">{t.agentReview.suggestions}</h4>
      {suggestions.length === 0 ? (
        <p className="mt-3 text-sm" style={{ color: "var(--ink-faint)" }}>{emptyText}</p>
      ) : (
        <div className="mt-3 space-y-3">
          {suggestions.map((suggestion) => (
            <SuggestionItem
              key={suggestion.suggestionId}
              suggestion={suggestion}
              mutating={mutating}
              applying={applyingId === suggestion.suggestionId}
              onApply={() => onApply(suggestion)}
              onDismiss={() => onDismiss(suggestion)}
            />
          ))}
        </div>
      )}
    </>
  );
}

function SuggestionItem({
  suggestion,
  mutating,
  applying,
  onApply,
  onDismiss,
}: {
  suggestion: AgentReviewSuggestion;
  mutating: boolean;
  applying: boolean;
  onApply: () => void;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const category = t.agentReview.categories[suggestion.category as keyof typeof t.agentReview.categories]
    ?? suggestion.category;
  return (
    <article className="overflow-hidden rounded-md border" style={{ borderColor: "var(--ink-line)", background: "var(--ink-paper-soft)" }}>
      <div className="flex items-start justify-between gap-3 px-3 py-3">
        <div className="min-w-0">
          <span className="text-xs font-semibold" style={{ color: "var(--ink-strong)" }}>{category}</span>
          <p className="mt-1 text-xs leading-5" style={{ color: "var(--ink-mid)" }}>{suggestion.reason}</p>
        </div>
        {suggestion.status !== "pending" && (
          <span className="shrink-0 text-xs font-medium" style={{ color: "var(--ink-faint)" }}>
            {suggestion.status === "applied" ? t.agentReview.applied : t.agentReview.dismissed}
          </span>
        )}
      </div>
      <DiffBlock sign="-" label={t.agentReview.before} value={suggestion.before} tone="remove" />
      <DiffBlock sign="+" label={t.agentReview.after} value={suggestion.after} tone="add" />
      {suggestion.status === "pending" && (
        <div className="grid grid-cols-2 gap-2 border-t p-3" style={{ borderColor: "var(--ink-line)" }}>
          <button
            type="button"
            onClick={() => onDismiss()}
            disabled={mutating}
            className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md border text-xs font-semibold disabled:opacity-50"
            style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }}
          >
            <X className="h-3.5 w-3.5" />
            {t.agentReview.dismiss}
          </button>
          <button
            type="button"
            onClick={() => onApply()}
            disabled={mutating}
            className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md text-xs font-semibold disabled:opacity-50"
            style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}
          >
            {applying ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
            {applying ? t.agentReview.applying : t.agentReview.apply}
          </button>
        </div>
      )}
    </article>
  );
}

function DiffBlock({ sign, label, value, tone }: { sign: string; label: string; value: string; tone: "remove" | "add" }) {
  const remove = tone === "remove";
  return (
    <div
      className="grid grid-cols-[1.5rem_minmax(0,1fr)] border-t font-mono text-xs leading-5"
      style={{
        borderColor: "var(--ink-line)",
        background: remove ? "color-mix(in srgb, #ef4444 7%, var(--ink-paper))" : "color-mix(in srgb, #22c55e 7%, var(--ink-paper))",
      }}
    >
      <span className="px-2 py-2.5 text-center select-none" style={{ color: remove ? "#b91c1c" : "#15803d" }}>{sign}</span>
      <div className="min-w-0 border-l px-2.5 py-2.5" style={{ borderColor: "var(--ink-line)" }}>
        <span className="mb-1 block font-sans text-[10px] font-semibold uppercase" style={{ color: "var(--ink-faint)" }}>{label}</span>
        <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words font-mono">{value || "∅"}</pre>
      </div>
    </div>
  );
}

function GateMessage({ text, children }: { text: string; children?: React.ReactNode }) {
  return (
    <div className="py-16 text-center">
      <Sparkles className="mx-auto h-7 w-7" style={{ color: "var(--ink-faint)" }} />
      <p className="mx-auto mt-4 max-w-sm text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{text}</p>
      {children}
    </div>
  );
}

function StatusBlock({ icon, title, body }: { icon: React.ReactNode; title: string; body?: string }) {
  return (
    <div className="mt-4 rounded-md border p-4" style={{ borderColor: "var(--ink-line)" }}>
      <div className="flex items-center gap-2 text-sm font-semibold">{icon}{title}</div>
      {body && <p className="mt-2 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{body}</p>}
    </div>
  );
}

function agentReviewErrorText(error: unknown, fallback: string, errors: Record<string, string>): string {
  if (error instanceof ApiError && error.code && errors[error.code]) return errors[error.code];
  return fallback;
}

function reviewFailureStatusText(
  errorCode: string | null | undefined,
  errors: Record<string, string>,
  fallback: string,
): string {
  if (errorCode && errors[errorCode]) return errors[errorCode];
  if (errorCode === "usage_missing" || errorCode === "usage_invalid") {
    return errors.agent_invalid_response ?? fallback;
  }
  return fallback;
}

function formatReviewDate(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}
