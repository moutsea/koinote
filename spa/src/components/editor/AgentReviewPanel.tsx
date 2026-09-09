import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import {
  AlertCircle,
  Bot,
  Check,
  CheckCheck,
  ChevronRight,
  Clock3,
  Crosshair,
  Gauge,
  LayoutList,
  ListTree,
  LoaderCircle,
  MessageSquareText,
  Pencil,
  RefreshCw,
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
  estimateAgentReview,
  getAgentCredits,
  getAgentSettings,
  getAgentReview,
  listAgentReviews,
  type AgentReview,
  type AgentReviewCreateInput,
  type AgentReviewLayoutAssessment,
  type AgentReviewSuggestion,
  type Document,
} from "../../api";
import { confirmAction } from "../../confirmAction";
import { interpolate, useI18n } from "../../i18n";
import { publishAgentReviewStarted } from "../../agentReviewNotifications";
import { pushModal } from "../../modalStack";
import {
  AGENT_REVIEW_TASKS,
  agentReviewAccess,
  agentReviewAffordable,
  agentReviewFailureTranslationCode,
  agentReviewPendingAnchors,
  agentReviewTasksInScope,
  canStartAgentReview,
  defaultExpandedAgentReviewDimension,
  groupAgentReviewSuggestionsByDimension,
  hasAgentReviewLayoutAssessment,
  hasAgentReviewTitleAssessment,
  hasRunningAgentReviewForCurrentRevision,
  titleScoreNeedsAlternatives,
  toggleAgentReviewTask,
  type AgentReviewTaskId,
} from "./agentReviewCore";
import {
  AGENT_REVIEW_ANCHOR_CLICK_EVENT,
  clearAgentReviewAnchors,
  scrollToAgentReviewAnchor,
  setAgentReviewAnchors,
  type AgentReviewAnchorClickDetail,
} from "./agentReviewAnchors";

const TASK_ICONS: Record<AgentReviewTaskId, typeof Gauge> = {
  title: Gauge,
  proofread: MessageSquareText,
  structure: ListTree,
  paragraph: LayoutList,
};

/**
 * 把正文建议按来源任务归到 4 个 bucket。
 *
 * 新记录优先使用后端保存的 sourceTask；老记录没有来源字段时再用 category 作 heuristic：
 *  - 结构/排版：kind === "layout" 或 category 是六维 id 之一
 *  - 校对：clarity / accuracy（表达准确类）
 *  - 段落：style / engagement / conversion / structure（逻辑/节奏类）
 *
 * 分不清楚的建议（category 不在上表）归到段落桶，这是最宽泛的兜底。
 */
const LAYOUT_CATEGORIES = new Set([
  "hierarchy",
  "readability",
  "emphasis",
  "rhythm",
  "modules",
  "mobile",
]);
const PROOFREAD_CATEGORIES = new Set(["clarity", "accuracy"]);

function bucketBodySuggestion(
  s: AgentReviewSuggestion,
): "structure" | "proofread" | "paragraph" {
  if (s.sourceTask === "structure") return "structure";
  if (s.sourceTask === "proofread") return "proofread";
  if (s.sourceTask === "paragraph") return "paragraph";
  if (s.kind === "layout" || LAYOUT_CATEGORIES.has(s.category))
    return "structure";
  if (PROOFREAD_CATEGORIES.has(s.category)) return "proofread";
  return "paragraph";
}

type ReviewCategoryKey = AgentReviewTaskId;

/** 建议列表的公共 props，切页和六维折叠块都要往下传同一组。 */
type SuggestionListProps = {
  mutating: boolean;
  applyingId?: string;
  activeSuggestionId: string;
  anchoredIds: string[];
  onFocus: (suggestion: AgentReviewSuggestion) => void;
  onApply: (suggestion: AgentReviewSuggestion) => void;
  onDismiss: (suggestion: AgentReviewSuggestion) => void;
};

type ReviewCategorySection = {
  key: ReviewCategoryKey;
  label: string;
  icon: typeof Gauge;
  suggestions: AgentReviewSuggestion[];
};

export function AgentReviewPanel({
  docId,
  documentRevision,
  member,
  localMode,
  initialReviewId,
  editor,
  onPrepareReview,
  onAcceptDocument,
  onClose,
}: {
  docId: string;
  documentRevision: number;
  member: boolean;
  localMode: boolean;
  initialReviewId?: string;
  editor?: Editor | null;
  onPrepareReview: () => Promise<boolean>;
  onAcceptDocument: (document: Document) => void;
  onClose: () => void;
}) {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const access = agentReviewAccess(member, localMode);
  const remoteEnabled = access === "ready";
  const [selectedReviewId, setSelectedReviewId] = useState(
    initialReviewId ?? "",
  );
  const [error, setError] = useState<string | null>(null);
  const [selectedTasks, setSelectedTasks] = useState<AgentReviewTaskId[]>([
    ...AGENT_REVIEW_TASKS,
  ]);
  const [activeSuggestionId, setActiveSuggestionId] = useState("");
  const [rerunOpen, setRerunOpen] = useState(false);
  const [deepAnalysisFocusDimension, setDeepAnalysisFocusDimension] =
    useState<AgentReviewLayoutAssessment["id"] | null>(null);
  const rerunRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const releaseModal = pushModal();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      releaseModal();
    };
  }, [onClose]);

  // 点下拉外部区域关闭
  useEffect(() => {
    if (!rerunOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        rerunRef.current &&
        !rerunRef.current.contains(event.target as Node)
      ) {
        setRerunOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [rerunOpen]);

  const settings = useQuery({
    queryKey: AGENT_SETTINGS_QUERY_KEY,
    queryFn: getAgentSettings,
    enabled: remoteEnabled,
    retry: false,
  });
  const configuredProviderMode = settings.data?.settings.providerMode;
  const providerMode = configuredProviderMode ?? "builtin";
  const credits = useQuery({
    queryKey: AGENT_CREDITS_QUERY_KEY,
    queryFn: getAgentCredits,
    enabled: remoteEnabled && configuredProviderMode === "builtin",
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
  // 是否有可展示的历史审阅（包括正在运行的）
  const hasHistory = Boolean(
    reviews.data?.reviews.length || (review.data?.review && selectedReviewId),
  );
  // 没有历史，且还没开始加载：显示发起引导
  const showLaunchGuide =
    !hasHistory &&
    !reviews.isLoading &&
    !reviews.isError &&
    !review.isLoading &&
    !review.isError &&
    review.data?.review.status !== "running";

  // 预估在「有发起入口可见」时才请求：首次使用是发起引导，之后是右上角的重新审阅
  // 浮层。只判 rerunOpen 会漏掉首次使用 —— 那时重新审阅按钮根本没渲染，rerunOpen
  // 恒为 false，界面会一直停在「正在预估花费…」，而这句预估正是发起前该看到的。
  const needsEstimate = rerunOpen || showLaunchGuide;
  const estimate = useQuery({
    queryKey: [
      "agent-review-estimate",
      docId,
      documentRevision,
      selectedTasks.join(","),
    ],
    queryFn: ({ signal }) => estimateAgentReview(docId, selectedTasks, signal),
    enabled:
      remoteEnabled &&
      providerMode === "builtin" &&
      selectedTasks.length > 0 &&
      needsEstimate,
    retry: false,
    // 不缓存：预估随正文长度变，缓存窗口内编辑过文档就会显示一个对不上的数字。
    // 这个数字的全部意义是让用户掏 credits 前知道要花多少，宁可每次展开多一次请求。
    //
    // revision 进入 query key，文档保存后自动重新估价；不能复用旧文档的预留上限。
    staleTime: 0,
  });

  useEffect(() => {
    if (!initialReviewId) return;
    setSelectedReviewId(initialReviewId);
  }, [initialReviewId]);

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

  const current = review.data?.review;

  const deepEstimate = useQuery({
    queryKey: [
      "agent-review-deep-estimate",
      docId,
      documentRevision,
      current?.reviewId,
      deepAnalysisFocusDimension,
    ],
    queryFn: ({ signal }) =>
      estimateAgentReview(docId, [], signal, {
        depth: "deep",
        focusDimension: deepAnalysisFocusDimension ?? undefined,
        sourceReviewId: current?.reviewId,
      }),
    enabled:
      remoteEnabled &&
      providerMode === "builtin" &&
      Boolean(current?.reviewId) &&
      Boolean(deepAnalysisFocusDimension) &&
      current?.status !== "running" &&
      current?.status !== "failed",
    retry: false,
    staleTime: 0,
  });

  const pendingAnchors = useMemo(
    () => agentReviewPendingAnchors(current?.suggestions),
    [current?.suggestions],
  );
  const anchorKey = pendingAnchors
    .map((anchor) => anchor.suggestionId)
    .join(",");
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    setAgentReviewAnchors(editor, pendingAnchors, activeSuggestionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- anchorKey 代表内容标识
  }, [editor, anchorKey, activeSuggestionId]);
  useEffect(() => {
    if (!editor) return;
    return () => {
      if (!editor.isDestroyed) clearAgentReviewAnchors(editor);
    };
  }, [editor]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const element = editor.view.dom;
    const onAnchorClick = (event: Event) => {
      const detail = (event as CustomEvent<AgentReviewAnchorClickDetail>)
        .detail;
      if (!detail?.suggestionId) return;
      setActiveSuggestionId(detail.suggestionId);
      window.requestAnimationFrame(() => {
        document
          .querySelector(`[data-suggestion-card="${detail.suggestionId}"]`)
          ?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    };
    element.addEventListener(AGENT_REVIEW_ANCHOR_CLICK_EVENT, onAnchorClick);
    return () =>
      element.removeEventListener(
        AGENT_REVIEW_ANCHOR_CLICK_EVENT,
        onAnchorClick,
      );
  }, [editor]);

  function focusSuggestion(suggestion: AgentReviewSuggestion) {
    setActiveSuggestionId(suggestion.suggestionId);
    if (!editor || editor.isDestroyed || suggestion.target !== "body") return;
    scrollToAgentReviewAnchor(editor, suggestion.suggestionId);
  }

  const refreshReviewQueries = async (nextReview: AgentReview) => {
    queryClient.setQueryData(["agent-review", nextReview.reviewId], {
      review: nextReview,
    });
    await queryClient.invalidateQueries({ queryKey: ["agent-reviews", docId] });
  };

  const create = useMutation({
    mutationFn: async (input: AgentReviewCreateInput = {}) => {
      if (!(await onPrepareReview())) throw new Error("document_save_failed");
      if (providerMode === "builtin") {
        const tasks = input.depth ? [] : input.tasks ?? selectedTasks;
        const estimateResult = await estimateAgentReview(
          docId,
          tasks,
          undefined,
          input.depth
            ? {
                depth: "deep",
                focusDimension: input.focusDimension,
                sourceReviewId: input.sourceReviewId,
              }
            : undefined,
        );
        if (input.depth) {
          queryClient.setQueryData(
            [
              "agent-review-deep-estimate",
              docId,
              estimateResult.estimate.documentRevision,
              input.sourceReviewId,
              input.focusDimension,
            ],
            estimateResult,
          );
        } else {
          queryClient.setQueryData(
            [
              "agent-review-estimate",
              docId,
              estimateResult.estimate.documentRevision,
              tasks.join(","),
            ],
            estimateResult,
          );
        }
      }
      return createAgentReview(docId, input);
    },
    onSuccess(result) {
      setError(null);
      setRerunOpen(false);
      setSelectedReviewId(result.review.reviewId);
      queryClient.setQueryData(
        ["agent-review", result.review.reviewId],
        result,
      );
      publishAgentReviewStarted({
        reviewId: result.review.reviewId,
        documentId: result.review.documentId,
        createdAt: result.review.createdAt,
        providerMode: result.review.providerMode,
      });
      void Promise.all([
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
    mutationFn: async ({
      current,
      suggestion,
    }: {
      current: AgentReview;
      suggestion: AgentReviewSuggestion;
    }) => {
      if (!(await onPrepareReview())) throw new Error("document_save_failed");
      const latest = await getAgentReview(current.reviewId);
      return applyAgentReviewSuggestion(
        current.reviewId,
        suggestion.suggestionId,
        latest.review.documentRevision,
      );
    },
    async onSuccess(result) {
      setError(null);
      setActiveSuggestionId("");
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
    mutationFn: ({
      current,
      suggestion,
    }: {
      current: AgentReview;
      suggestion: AgentReviewSuggestion;
    }) =>
      dismissAgentReviewSuggestion(current.reviewId, suggestion.suggestionId),
    async onSuccess(result) {
      setError(null);
      setActiveSuggestionId("");
      await refreshReviewQueries(result.review);
    },
    onError(value) {
      setError(agentReviewErrorText(value, t.auth.requestFailed, t.errors));
    },
  });

  const applyAll = useMutation({
    mutationFn: async (current: AgentReview) => {
      if (!(await onPrepareReview())) throw new Error("document_save_failed");
      const latest = await getAgentReview(current.reviewId);
      return applyAllAgentReviewSuggestions(
        current.reviewId,
        latest.review.documentRevision,
      );
    },
    async onSuccess(result) {
      setError(null);
      setActiveSuggestionId("");
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

  const currentRevisionReviewRunning = hasRunningAgentReviewForCurrentRevision([
    ...(reviews.data?.reviews ?? []),
    ...(current ? [current] : []),
  ]);
  const mutating =
    applyOne.isPending ||
    dismissOne.isPending ||
    applyAll.isPending ||
    dismissAll.isPending;
  const builtinEnabled = credits.data?.credits.builtinEnabled ?? false;
  const canStart = canStartAgentReview(
    providerMode,
    builtinEnabled,
    settings.data?.settings.defaultChannel?.channelId ?? "",
  );
  const builtinCreditsUnavailable =
    providerMode === "builtin" && (credits.isLoading || credits.isError);
  const reservedCredits = estimate.data?.estimate.reservedCredits;
  const estimateMatchesRevision =
    estimate.data?.estimate.documentRevision === documentRevision;
  const affordable = agentReviewAffordable(
    providerMode,
    credits.data?.credits.available,
    reservedCredits,
  );
  const estimatePending =
    providerMode === "builtin" &&
    selectedTasks.length > 0 &&
    (estimate.isLoading ||
      estimate.isFetching ||
      estimate.isError ||
      reservedCredits === undefined ||
      !estimateMatchesRevision);
  const deepReservedCredits = deepEstimate.data?.estimate.reservedCredits;
  const deepEstimateMatchesRevision =
    deepEstimate.data?.estimate.documentRevision === documentRevision;
  const deepEstimatePending =
    providerMode === "builtin" &&
    Boolean(deepAnalysisFocusDimension) &&
    (deepEstimate.isLoading ||
      deepEstimate.isFetching ||
      deepEstimate.isError ||
      deepReservedCredits === undefined ||
      !deepEstimateMatchesRevision);
  const deepAffordable = agentReviewAffordable(
    providerMode,
    credits.data?.credits.available,
    deepReservedCredits,
  );
  const deepAnalysisDisabled =
    create.isPending ||
    mutating ||
    currentRevisionReviewRunning ||
    builtinCreditsUnavailable ||
    !canStart ||
    settings.isLoading ||
    settings.isError ||
    deepEstimatePending ||
    !deepAffordable;
  const reviewStartDisabled =
    create.isPending ||
    mutating ||
    currentRevisionReviewRunning ||
    builtinCreditsUnavailable ||
    selectedTasks.length === 0 ||
    estimatePending ||
    !affordable ||
    settings.isLoading ||
    settings.isError ||
    reviews.isLoading ||
    reviews.isError;

  function startReview(input: AgentReviewCreateInput = {}) {
    if (!canStart) {
      setError(
        providerMode === "builtin"
          ? t.errors.agent_llm_not_configured
          : t.agentReview.configureChannels,
      );
      return;
    }
    create.mutate(
      input.depth ? input : { ...input, tasks: input.tasks ?? selectedTasks },
    );
  }

  async function ignoreAll() {
    if (!current || !(await confirmAction(t.agentReview.dismissAllConfirm)))
      return;
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
        role="dialog"
        aria-modal="true"
        aria-label={t.agentReview.title}
        className="fixed bottom-0 right-0 top-14 z-[60] flex w-full flex-col border-l shadow-2xl sm:max-w-[36rem]"
        style={{
          borderColor: "var(--ink-line)",
          background: "var(--ink-paper)",
          color: "var(--ink-black)",
        }}
      >
        {/* Header */}
        <header
          className="flex shrink-0 items-center gap-3 border-b px-4 py-3 sm:px-5"
          style={{ borderColor: "var(--ink-line)" }}
        >
          <Bot className="h-4 w-4 shrink-0" style={{ color: "var(--cinnabar)" }} />
          <h2 className="min-w-0 flex-1 font-semibold">
            {t.agentReview.title}
          </h2>

          {/* 历史审阅切换 */}
          {reviews.data && reviews.data.reviews.length > 1 && (
            <select
              aria-label={t.agentReview.previousReviews}
              value={selectedReviewId}
              onChange={(event) => setSelectedReviewId(event.target.value)}
              className="max-w-36 rounded-md border bg-transparent px-2 py-1 text-xs outline-none"
              style={{
                borderColor: "var(--ink-line)",
                color: "var(--ink-mid)",
              }}
            >
              {reviews.data.reviews.map((item) => (
                <option key={item.reviewId} value={item.reviewId}>
                  {formatReviewDate(item.createdAt, locale)} ·{" "}
                  {t.agentReview.statuses[item.status]}
                </option>
              ))}
            </select>
          )}

          {/* 重新审阅按钮 + 下拉浮层 */}
          {!showLaunchGuide && (
            <div className="relative" ref={rerunRef}>
              <button
                type="button"
                onClick={() => setRerunOpen((v) => !v)}
                title={t.agentReview.rerunReview}
                aria-label={t.agentReview.rerunReview}
                aria-expanded={rerunOpen}
                // 朱砂描边 + 淡底，比原来的中性灰边显眼一档，但不抢主操作（落实建议）的位置
                className="flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-semibold transition hover:brightness-95"
                style={{
                  borderColor:
                    "color-mix(in srgb, var(--cinnabar) 45%, transparent)",
                  background: "var(--cinnabar-soft)",
                  color: "var(--cinnabar)",
                }}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">
                  {t.agentReview.rerunReview}
                </span>
              </button>

              {rerunOpen && (
                <div
                  role="dialog"
                  aria-label={t.agentReview.rerunReviewTitle}
                  className="absolute right-0 top-full z-10 mt-1.5 w-72 rounded-xl border shadow-xl"
                  style={{
                    borderColor: "var(--ink-line)",
                    background: "var(--ink-paper)",
                  }}
                >
                  <div className="px-4 py-3">
                    <p
                      className="text-xs font-semibold"
                      style={{ color: "var(--ink-strong)" }}
                    >
                      {t.agentReview.rerunReviewTitle}
                    </p>
                    <div
                      className="mt-2.5 space-y-1.5"
                      role="group"
                      aria-label={t.agentReview.taskSelection}
                    >
                      {AGENT_REVIEW_TASKS.map((task) => {
                        const Icon = TASK_ICONS[task];
                        const checked = selectedTasks.includes(task);
                        return (
                          <button
                            key={task}
                            type="button"
                            role="checkbox"
                            aria-checked={checked}
                            onClick={() =>
                              setSelectedTasks((prev) =>
                                toggleAgentReviewTask(prev, task),
                              )
                            }
                            className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-xs transition hover:bg-[var(--ink-wash)]"
                          >
                            <span
                              aria-hidden="true"
                              className="flex h-4 w-4 shrink-0 items-center justify-center rounded border"
                              style={{
                                borderColor: checked
                                  ? "var(--cinnabar)"
                                  : "var(--ink-line)",
                                background: checked
                                  ? "var(--cinnabar)"
                                  : "transparent",
                                color: "var(--ink-paper)",
                              }}
                            >
                              {checked && <Check className="h-3 w-3" />}
                            </span>
                            <Icon
                              className="h-3.5 w-3.5 shrink-0"
                              style={{ color: "var(--ink-mid)" }}
                            />
                            <span className="min-w-0">
                              <span className="font-semibold">
                                {t.agentReview.tasks[task].label}
                              </span>
                              <span
                                className="ml-1.5"
                                style={{ color: "var(--ink-faint)" }}
                              >
                                {t.agentReview.tasks[task].description}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    {providerMode === "builtin" && selectedTasks.length > 0 && (
                      <p
                        className="mt-2 text-[11px] leading-4"
                        style={{
                          color: affordable
                            ? "var(--ink-faint)"
                            : "var(--cinnabar)",
                        }}
                      >
                        {estimate.isError
                          ? (
                              <>
                                {t.agentReview.estimateFailed}{" "}
                                <button
                                  type="button"
                                  onClick={() => void estimate.refetch()}
                                  className="font-semibold underline"
                                >
                                  {t.agentReview.estimateRetry}
                                </button>
                              </>
                            )
                          : estimate.isLoading ||
                              estimate.isFetching ||
                              !estimateMatchesRevision ||
                              reservedCredits === undefined
                            ? t.agentReview.estimateLoading
                            : affordable
                              ? interpolate(t.agentReview.estimateHint, {
                                  credits: reservedCredits,
                                })
                              : interpolate(
                                  t.agentReview.estimateInsufficient,
                                  { credits: reservedCredits },
                                )}
                      </p>
                    )}
                    {error && (
                      <p
                        role="alert"
                        className="mt-2 text-[11px] leading-4"
                        style={{ color: "var(--cinnabar)" }}
                      >
                        {error}
                      </p>
                    )}
                  </div>
                  <div
                    className="border-t px-4 py-3"
                    style={{ borderColor: "var(--ink-line)" }}
                  >
                    <button
                      type="button"
                      onClick={() => startReview()}
                      disabled={reviewStartDisabled}
                      className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-md text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-45"
                      style={{ background: "var(--cinnabar)", color: "#fff" }}
                    >
                      {create.isPending ? (
                        <>
                          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                          {t.agentReview.deepAnalysisStarting}
                        </>
                      ) : currentRevisionReviewRunning ? (
                        t.agentReview.alreadyRunning
                      ) : selectedTasks.length === 0 ? (
                        t.agentReview.selectTaskFirst
                      ) : (
                        <>
                          <Sparkles className="h-3.5 w-3.5" />
                          {interpolate(t.agentReview.startWithCount, {
                            count: selectedTasks.length,
                          })}
                        </>
                      )}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

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
                to="/settings"
                search={{ section: "membership" }}
                hash="membership"
                className="mt-4 inline-flex rounded-full px-4 py-2 text-sm font-semibold"
                style={{
                  background: "var(--ink-strong)",
                  color: "var(--ink-paper)",
                }}
              >
                {t.agentReview.upgrade}
              </Link>
            </GateMessage>
          ) : showLaunchGuide ? (
            /* 没有历史审阅 → 显示发起引导 */
            <LaunchGuideSection
              providerMode={providerMode}
              credits={credits.data?.credits}
              creditsError={credits.isError}
              settingsError={settings.isError}
              hasChannel={Boolean(settings.data?.settings.defaultChannel)}
              settingsLoading={settings.isLoading}
              selectedTasks={selectedTasks}
              onToggleTask={(task) =>
                setSelectedTasks((value) => toggleAgentReviewTask(value, task))
              }
              onSelectAll={() => setSelectedTasks([...AGENT_REVIEW_TASKS])}
              reservedCredits={reservedCredits}
              estimateLoading={
                estimate.isLoading ||
                estimate.isFetching ||
                !estimateMatchesRevision
              }
              estimateError={estimate.isError}
              onRetryEstimate={() => void estimate.refetch()}
              affordable={affordable}
              starting={create.isPending}
              disabled={reviewStartDisabled}
              running={currentRevisionReviewRunning}
              error={error}
              onStart={() => startReview()}
            />
          ) : (
            /* 有历史 → 直接显示结果 */
            <>
              {reviews.isLoading || review.isLoading ? (
                <div
                  className="flex items-center gap-2 py-12 text-sm"
                  style={{ color: "var(--ink-faint)" }}
                >
                  <LoaderCircle className="h-4 w-4 animate-spin" />
                  {t.agentReview.loading}
                </div>
              ) : reviews.isError || review.isError ? (
                <p
                  className="py-6 text-sm"
                  role="alert"
                  style={{ color: "var(--cinnabar)" }}
                >
                  {t.agentReview.loadFailed}
                </p>
              ) : current ? (
                <ReviewDetail
                  key={current.reviewId}
                  review={current}
                  mutating={mutating}
                  deepAnalyzing={create.isPending}
                  deepAnalysisDisabled={deepAnalysisDisabled}
                  deepEstimateFocusDimension={deepAnalysisFocusDimension}
                  deepEstimateCredits={deepReservedCredits}
                  deepEstimateLoading={
                    deepEstimate.isLoading ||
                    deepEstimate.isFetching ||
                    !deepEstimateMatchesRevision
                  }
                  deepEstimateError={deepEstimate.isError}
                  deepEstimateAffordable={deepAffordable}
                  onRetryDeepEstimate={() => void deepEstimate.refetch()}
                  applyingId={applyOne.variables?.suggestion.suggestionId}
                  activeSuggestionId={activeSuggestionId}
                  anchoredIds={pendingAnchors.map(
                    (anchor) => anchor.suggestionId,
                  )}
                  onFocusSuggestion={focusSuggestion}
                  onApply={(suggestion) =>
                    applyOne.mutate({ current, suggestion })
                  }
                  onDismiss={(suggestion) =>
                    dismissOne.mutate({ current, suggestion })
                  }
                  onApplyAll={() => applyAll.mutate(current)}
                  onDismissAll={() => void ignoreAll()}
                  onDeepAnalyze={(focusDimension) =>
                    startReview({
                      depth: "deep",
                      focusDimension,
                      sourceReviewId: current.reviewId,
                    })
                  }
                  onDeepFocusChange={setDeepAnalysisFocusDimension}
                />
              ) : null}
            </>
          )}
        </div>
      </aside>
    </>
  );
}

/** 首次使用的发起引导，没有历史审阅时显示。 */
function LaunchGuideSection({
  providerMode,
  credits,
  creditsError,
  settingsError,
  hasChannel,
  settingsLoading,
  selectedTasks,
  onToggleTask,
  onSelectAll,
  reservedCredits,
  estimateLoading,
  estimateError,
  onRetryEstimate,
  affordable,
  starting,
  disabled,
  running,
  error,
  onStart,
}: {
  providerMode: "builtin" | "byok";
  credits?: { available: number; reserved: number; builtinEnabled: boolean };
  creditsError: boolean;
  settingsError: boolean;
  hasChannel: boolean;
  settingsLoading: boolean;
  selectedTasks: AgentReviewTaskId[];
  onToggleTask: (task: AgentReviewTaskId) => void;
  onSelectAll: () => void;
  reservedCredits?: number;
  estimateLoading: boolean;
  estimateError: boolean;
  onRetryEstimate: () => void;
  affordable: boolean;
  starting: boolean;
  disabled: boolean;
  running: boolean;
  error: string | null;
  onStart: () => void;
}) {
  const { t } = useI18n();
  const allSelected = selectedTasks.length === AGENT_REVIEW_TASKS.length;
  return (
    <section>
      <div className="flex items-center gap-2 pb-5">
        <Sparkles
          className="h-5 w-5 shrink-0"
          style={{ color: "var(--cinnabar)" }}
        />
        <p className="text-sm leading-5" style={{ color: "var(--ink-mid)" }}>
          {t.agentReview.description}
        </p>
      </div>

      {providerMode === "builtin" && credits && (
        <p
          className="mb-3 text-xs tabular-nums"
          style={{ color: "var(--ink-faint)" }}
        >
          {interpolate(t.agentReview.availableCredits, {
            count: credits.available,
          })}
        </p>
      )}
      {providerMode === "byok" && !hasChannel && !settingsLoading && (
        <Link
          to="/settings"
          search={{ section: "ai" }}
          hash="llm-channels"
          className="mb-3 inline-flex text-xs font-semibold hover:underline"
          style={{ color: "var(--cinnabar)" }}
        >
          {t.agentReview.configureChannels}
        </Link>
      )}
      {settingsError && (
        <p
          className="mb-3 text-sm"
          role="alert"
          style={{ color: "var(--cinnabar)" }}
        >
          {t.agentModelSettings.loadFailed}
        </p>
      )}
      {providerMode === "builtin" && creditsError && (
        <p
          className="mb-3 text-sm"
          role="alert"
          style={{ color: "var(--cinnabar)" }}
        >
          {t.agentCredits.loadFailed}
        </p>
      )}

      <p className="mb-2 text-sm font-semibold">
        {t.agentReview.taskSelection}
      </p>
      <div
        className="grid grid-cols-1 gap-2 sm:grid-cols-2"
        role="group"
        aria-label={t.agentReview.taskSelection}
      >
        {AGENT_REVIEW_TASKS.map((task) => {
          const Icon = TASK_ICONS[task];
          const checked = selectedTasks.includes(task);
          return (
            <button
              key={task}
              type="button"
              role="checkbox"
              aria-checked={checked}
              onClick={() => onToggleTask(task)}
              className="flex min-h-[4.5rem] items-start gap-2.5 rounded-md border px-3 py-2.5 text-left text-xs transition hover:bg-[var(--ink-wash)]"
              style={{
                borderColor: checked ? "var(--cinnabar)" : "var(--ink-line)",
                background: checked
                  ? "color-mix(in srgb, var(--cinnabar) 8%, transparent)"
                  : "transparent",
              }}
            >
              <span
                aria-hidden="true"
                className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border"
                style={{
                  borderColor: checked ? "var(--cinnabar)" : "var(--ink-line)",
                  background: checked ? "var(--cinnabar)" : "transparent",
                  color: "var(--ink-paper)",
                }}
              >
                {checked && <Check className="h-3 w-3" />}
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 font-semibold">
                  <Icon
                    className="h-3.5 w-3.5"
                    style={{
                      color: checked ? "var(--cinnabar)" : "var(--ink-mid)",
                    }}
                  />
                  {t.agentReview.tasks[task].label}
                </span>
                <span
                  className="mt-0.5 block leading-4"
                  style={{ color: "var(--ink-mid)" }}
                >
                  {t.agentReview.tasks[task].description}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {!allSelected && (
        <button
          type="button"
          onClick={onSelectAll}
          className="mt-2 text-xs font-medium hover:underline"
          style={{ color: "var(--cinnabar)" }}
        >
          {t.agentReview.selectAllTasks}
        </button>
      )}

      {providerMode === "builtin" && selectedTasks.length > 0 && (
        <p
          className="mt-3 text-xs leading-5"
          style={{ color: affordable ? "var(--ink-faint)" : "var(--cinnabar)" }}
        >
          {estimateError
            ? (
                <>
                  {t.agentReview.estimateFailed}{" "}
                  <button
                    type="button"
                    onClick={onRetryEstimate}
                    className="font-semibold underline"
                  >
                    {t.agentReview.estimateRetry}
                  </button>
                </>
              )
            : estimateLoading || reservedCredits === undefined
              ? t.agentReview.estimateLoading
              : affordable
                ? interpolate(t.agentReview.estimateHint, {
                    credits: reservedCredits,
                  })
                : interpolate(t.agentReview.estimateInsufficient, {
                    credits: reservedCredits,
                  })}
        </p>
      )}

      {error && (
        <p
          role="alert"
          className="mt-3 rounded-md border px-3 py-2 text-xs"
          style={{ borderColor: "var(--cinnabar)", color: "var(--cinnabar)" }}
        >
          {error}
        </p>
      )}

      <button
        type="button"
        onClick={onStart}
        disabled={disabled}
        className="mt-4 inline-flex min-h-10 w-full items-center justify-center gap-2 rounded-md px-4 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-45"
        style={{ background: "var(--cinnabar)", color: "#fff" }}
      >
        {starting ? (
          <LoaderCircle className="h-4 w-4 animate-spin" />
        ) : (
          <Sparkles className="h-4 w-4" />
        )}
        {starting
          ? t.agentReview.deepAnalysisStarting
          : running
            ? t.agentReview.alreadyRunning
            : selectedTasks.length === 0
              ? t.agentReview.selectTaskFirst
              : interpolate(t.agentReview.startWithCount, {
                  count: selectedTasks.length,
                })}
      </button>
    </section>
  );
}

function ReviewDetail({
  review,
  mutating,
  deepAnalyzing,
  deepAnalysisDisabled,
  deepEstimateFocusDimension,
  deepEstimateCredits,
  deepEstimateLoading,
  deepEstimateError,
  deepEstimateAffordable,
  onRetryDeepEstimate,
  applyingId,
  activeSuggestionId,
  anchoredIds,
  onFocusSuggestion,
  onApply,
  onDismiss,
  onApplyAll,
  onDismissAll,
  onDeepAnalyze,
  onDeepFocusChange,
}: {
  review: AgentReview;
  mutating: boolean;
  deepAnalyzing: boolean;
  deepAnalysisDisabled: boolean;
  deepEstimateFocusDimension: AgentReviewLayoutAssessment["id"] | null;
  deepEstimateCredits?: number;
  deepEstimateLoading: boolean;
  deepEstimateError: boolean;
  deepEstimateAffordable: boolean;
  onRetryDeepEstimate: () => void;
  applyingId?: string;
  activeSuggestionId: string;
  anchoredIds: string[];
  onFocusSuggestion: (suggestion: AgentReviewSuggestion) => void;
  onApply: (suggestion: AgentReviewSuggestion) => void;
  onDismiss: (suggestion: AgentReviewSuggestion) => void;
  onApplyAll: () => void;
  onDismissAll: () => void;
  onDeepAnalyze: (dimensionId: AgentReviewLayoutAssessment["id"]) => void;
  onDeepFocusChange: (dimensionId: AgentReviewLayoutAssessment["id"] | null) => void;
}) {
  const { t } = useI18n();
  const deepReview = review.taskProgress?.mode === "deep";
  const deepFocusDimension = review.taskProgress?.focusDimension ?? null;
  const layoutAssessment = review.layoutAssessment ?? [];
  const layoutAssessed = hasAgentReviewLayoutAssessment(review);
  const titleAssessed = hasAgentReviewTitleAssessment(review);
  // 折叠面板允许同时展开多维，所以状态是一组 id 而不是单个选中项。
  // null 表示还没动过，此时用默认展开策略；点过之后一切听用户的。
  const [expandedDimensionIds, setExpandedDimensionIds] = useState<
    string[] | null
  >(deepFocusDimension ? [deepFocusDimension] : null);
  const actionable =
    review.status === "ready" ||
    review.status === "partially_applied" ||
    review.status === "stale";
  const suggestions = review.suggestions ?? [];
  const pending = suggestions.filter((item) => item.status === "pending");

  // 按发起任务的 4 个维度聚合建议。
  // 标题：target === "title"
  // 结构/排版：kind === "layout" 或 category 属于六维 id
  // 校对：category ∈ clarity/accuracy
  // 段落：其余正文建议（style/engagement/conversion/structure 等）
  const titleSuggestions = suggestions.filter(
    (item) => item.target === "title",
  );
  const bodyOnly = suggestions.filter((item) => item.target === "body");
  const structureSuggestions = deepReview
    ? bodyOnly
    : bodyOnly.filter((item) => bucketBodySuggestion(item) === "structure");
  const proofreadSuggestions = deepReview
    ? []
    : bodyOnly.filter((item) => bucketBodySuggestion(item) === "proofread");
  const paragraphSuggestions = deepReview
    ? []
    : bodyOnly.filter((item) => bucketBodySuggestion(item) === "paragraph");

  // 页签按「本次勾了什么」出，不按「有没有建议」出。前者来自 taskProgress.stages，
  // 是权威记录；后者会同时犯两个错：勾了却零建议的范围页签消失（用户分不清「审过
  // 很干净」和「没审」），没勾的范围反而因为 category 落到那个桶里冒出页签。
  const inScope = new Set<ReviewCategoryKey>(
    deepReview
      ? ["structure"]
      : agentReviewTasksInScope(review.taskProgress?.stages),
  );
  // 兜底：老审阅记录可能没有 stages（该字段是任务化改造后才有的）。此时退回按
  // 「有内容」判断，至少不会把已有建议藏起来。
  if (inScope.size === 0) {
    if (titleAssessed) inScope.add("title");
    if (layoutAssessed || structureSuggestions.length > 0)
      inScope.add("structure");
    if (proofreadSuggestions.length > 0) inScope.add("proofread");
    if (paragraphSuggestions.length > 0) inScope.add("paragraph");
  }

  // 下面两段补范围，保证「有建议就一定有分区能显示它」。按后端当前的产出都不会
  // 触发（标题建议只出自标题任务，只勾标题也不产出正文建议），但兜住的成本是多一个
  // 页签，不兜住的代价是用户付过费的建议看不见。
  //
  // 必须在算 strandedBody 之前定完范围：否则同一条建议既算「本分区自有」又算
  // 「孤儿」，会渲染两遍。
  if (titleSuggestions.length > 0) inScope.add("title");
  if (
    bodyOnly.length > 0 &&
    !inScope.has("structure") &&
    !inScope.has("proofread") &&
    !inScope.has("paragraph")
  ) {
    inScope.add("structure");
  }

  // 老记录的 category 启发式可能把建议丢进没勾过的桶。那些建议不能凭空消失 ——
  // 归并到一个在范围内的正文页签里。归并目标必须自己也在范围内，否则建议进了一个
  // 不会渲染的分区，等于丢了。三个正文桶都要判，不能只判两个：只勾校对时结构桶
  // 同样不在范围内。
  const strandedBody = [
    ...(inScope.has("structure") ? [] : structureSuggestions),
    ...(inScope.has("proofread") ? [] : proofreadSuggestions),
    ...(inScope.has("paragraph") ? [] : paragraphSuggestions),
  ];
  const bodyFallbackKey: ReviewCategoryKey = inScope.has("paragraph")
    ? "paragraph"
    : inScope.has("proofread")
      ? "proofread"
      : "structure";
  const withStranded = (
    key: ReviewCategoryKey,
    items: AgentReviewSuggestion[],
  ) => {
    const own = inScope.has(key) ? items : [];
    return key === bodyFallbackKey ? [...own, ...strandedBody] : own;
  };
  const sectionsOf: Record<ReviewCategoryKey, AgentReviewSuggestion[]> = {
    title: titleSuggestions,
    structure: withStranded("structure", structureSuggestions),
    proofread: withStranded("proofread", proofreadSuggestions),
    paragraph: withStranded("paragraph", paragraphSuggestions),
  };

  // 结构建议按维度分到各自的折叠块里。归不到六维的走 unmatched，单独列在下面。
  // 用 sectionsOf.structure 而不是 structureSuggestions：前者含被归并过来的孤儿建议。
  const dimensionIds = layoutAssessment.map((item) => item.id);
  const grouped = groupAgentReviewSuggestionsByDimension(
    sectionsOf.structure,
    dimensionIds,
  );
  const suggestionsOfDimension = (dimensionId: string) =>
    grouped.byDimension.get(dimensionId) ?? [];
  const defaultExpanded = defaultExpandedAgentReviewDimension(
    layoutAssessment,
    (dimensionId) =>
      suggestionsOfDimension(dimensionId).filter(
        (item) => item.status === "pending",
      ).length,
  );
  // 点正文锚点选中的建议可能落在收起的维度里，那一维要跟着展开，否则卡片不在
  // DOM 里、面板看着像没反应。和页签同理，派生而不是用 effect。
  const anchoredDimensionId = activeSuggestionId
    ? dimensionIds.find((id) =>
        suggestionsOfDimension(id).some(
          (item) => item.suggestionId === activeSuggestionId,
        ),
      )
    : undefined;
  const chosenExpandedIds =
    expandedDimensionIds ?? (defaultExpanded ? [defaultExpanded] : []);
  const expandedIds =
    anchoredDimensionId && !chosenExpandedIds.includes(anchoredDimensionId)
      ? [...chosenExpandedIds, anchoredDimensionId]
      : chosenExpandedIds;
  useEffect(() => {
    if (deepEstimateFocusDimension === null && defaultExpanded) {
      onDeepFocusChange(defaultExpanded as AgentReviewLayoutAssessment["id"]);
    }
  }, [deepEstimateFocusDimension, defaultExpanded, onDeepFocusChange]);
  const controlsDisabled = mutating || deepAnalyzing;

  // 四类建议原来纵向铺开，一屏装不下，用户要找某一类得一直滚。改成分类切页：
  // 一次只渲染一类，切页条 sticky 在滚动区顶部，各类的待处理数直接标在页签上。
  const sections: ReviewCategorySection[] = [];
  const SECTION_META: Array<{
    key: ReviewCategoryKey;
    label: string;
    icon: typeof Gauge;
  }> = [
    { key: "title", label: t.agentReview.tasks.title.label, icon: Gauge },
    {
      key: "structure",
      label: deepReview
        ? t.agentReview.layoutReview
        : t.agentReview.tasks.structure.label,
      icon: ListTree,
    },
    {
      key: "proofread",
      label: t.agentReview.tasks.proofread.label,
      icon: MessageSquareText,
    },
    {
      key: "paragraph",
      label: t.agentReview.tasks.paragraph.label,
      icon: LayoutList,
    },
  ];
  for (const meta of SECTION_META) {
    if (!inScope.has(meta.key)) continue;
    sections.push({ ...meta, suggestions: sectionsOf[meta.key] });
  }

  // 点正文锚点会选中一条可能不在当前页签里的建议，此时页签跟着切过去，否则卡片
  // 不在 DOM 里、面板看着像没反应。派生而不是用 effect：effect 在 paint 之后才跑，
  // 来不及赶上调用方那一帧的 scrollIntoView。
  const anchorOwner = activeSuggestionId
    ? sections.find((section) =>
        section.suggestions.some(
          (item) => item.suggestionId === activeSuggestionId,
        ),
      )?.key
    : undefined;
  const [pickedCategory, setPickedCategory] =
    useState<ReviewCategoryKey | null>(null);
  const fallbackKey =
    sections.find((section) =>
      section.suggestions.some((item) => item.status === "pending"),
    )?.key ?? sections[0]?.key;
  const activeKey =
    anchorOwner ??
    (pickedCategory &&
    sections.some((section) => section.key === pickedCategory)
      ? pickedCategory
      : fallbackKey);

  if (review.status === "running") {
    return (
      <div>
        <StatusBlock
          icon={<LoaderCircle className="h-5 w-5 animate-spin" />}
          title={t.agentReview.running}
        />
        {/* 运行中要能看到本次预留了多少额度：跑完才知道扣了多少太晚了。 */}
        {/* 用本次审阅自己的预留，不用账户上的聚合值：另一篇文章的审阅还跑着时，
            聚合值会把它的预留也算进来，显示成本次的上限。 */}
        {review.providerMode === "builtin" &&
          (review.reservedCredits ?? 0) > 0 && (
            <p
              className="mt-2 text-xs tabular-nums"
              style={{ color: "var(--ink-faint)" }}
            >
              {interpolate(t.agentCredits.estimatedCharge, {
                count: review.reservedCredits ?? 0,
              })}
            </p>
          )}
        <AgentReviewProgress review={review} />
        <PartialAgentReviewResult review={review} />
      </div>
    );
  }
  if (review.status === "failed") {
    const message =
      review.errorCode === "review_timeout"
        ? t.agentReview.backgroundTimeoutDescription
        : reviewFailureStatusText(
            review.errorCode,
            review.providerMode,
            t.errors,
            t.agentReview.failedTitle,
          );
    return (
      <StatusBlock
        icon={<AlertCircle className="h-5 w-5" />}
        title={t.agentReview.failedTitle}
        body={message}
      />
    );
  }

  const suggestionListProps: SuggestionListProps = {
    mutating: controlsDisabled,
    applyingId,
    activeSuggestionId,
    anchoredIds,
    onFocus: onFocusSuggestion,
    onApply,
    onDismiss,
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span
          className="rounded-full border px-2.5 py-1 text-xs"
          style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }}
        >
          {t.agentReview.statuses[review.status]}
        </span>
        {deepReview && (
          <span
            className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold"
            style={{
              background:
                "color-mix(in srgb, var(--cinnabar) 12%, transparent)",
              color: "var(--cinnabar)",
            }}
          >
            <Pencil className="h-3 w-3" />
            {interpolate(t.agentReview.deepReviewBadge, {
              dimension:
                layoutAssessment.find((item) => item.id === deepFocusDimension)
                  ?.label ?? t.agentReview.layoutReview,
            })}
          </span>
        )}
      </div>

      {review.status === "stale" && (
        <div
          role="status"
          className="mt-4 flex items-start gap-2.5 rounded-md border px-3 py-2.5"
          style={{
            borderColor: "var(--ink-line)",
            background: "var(--ink-wash)",
            color: "var(--ink-mid)",
          }}
        >
          <Clock3
            className="mt-0.5 h-4 w-4 shrink-0"
            style={{ color: "var(--cinnabar)" }}
          />
          <div>
            <p
              className="text-xs font-semibold"
              style={{ color: "var(--ink-strong)" }}
            >
              {t.agentReview.staleTitle}
            </p>
            <p className="mt-1 text-xs leading-5">
              {t.agentReview.staleDescription}
            </p>
          </div>
        </div>
      )}

      {review.summary && (
        <div
          className="mt-4 border-l-2 pl-3"
          style={{ borderColor: "var(--ink-line)" }}
        >
          <p className="text-sm leading-6" style={{ color: "var(--ink-mid)" }}>
            {review.summary}
          </p>
        </div>
      )}

      {review.providerMode === "builtin" && review.totalTokens > 0 && (
        <p className="mt-3 text-xs" style={{ color: "var(--ink-faint)" }}>
          {interpolate(t.agentReview.usage, { credits: review.creditsCharged })}
        </p>
      )}

      {anchoredIds.length > 0 && (
        <p
          className="mt-3 flex items-start gap-1.5 text-xs leading-5"
          style={{ color: "var(--ink-faint)" }}
        >
          <Crosshair className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {t.agentReview.anchorHint}
        </p>
      )}

      {actionable && pending.length > 0 && (
        <div className="mt-5 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onDismissAll}
            disabled={controlsDisabled}
            className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md border px-3 text-xs font-semibold disabled:opacity-50"
            style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }}
          >
            <X className="h-3.5 w-3.5" />
            {t.agentReview.dismissAll}
          </button>
          <button
            type="button"
            onClick={onApplyAll}
            disabled={controlsDisabled}
            className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md px-3 text-xs font-semibold disabled:opacity-50"
            style={{
              background: "var(--ink-strong)",
              color: "var(--ink-paper)",
            }}
          >
            {mutating ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CheckCheck className="h-3.5 w-3.5" />
            )}
            {mutating ? t.agentReview.applyingAll : t.agentReview.applyAll}
          </button>
        </div>
      )}

      {/* 分类切页条。sticky 让用户滚到长列表深处也能直接换类，不用滚回顶部。
          只有一个分区时不画切页条：一个孤零零的页签加一条分割线是纯噪音。 */}
      {sections.length > 1 && (
        <div
          role="tablist"
          aria-label={t.agentReview.categoryTabs}
          className="sticky top-0 z-[1] -mx-4 mt-5 flex gap-1 overflow-x-auto border-b px-4 pb-0 sm:-mx-5 sm:px-5"
          style={{
            borderColor: "var(--ink-line)",
            background: "var(--ink-paper)",
          }}
        >
          {sections.map((section) => {
            const Icon = section.icon;
            const selected = section.key === activeKey;
            const count = section.suggestions.filter(
              (item) => item.status === "pending",
            ).length;
            return (
              <button
                key={section.key}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => setPickedCategory(section.key)}
                className="-mb-px flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-2.5 py-2.5 text-xs font-semibold transition"
                style={{
                  borderColor: selected ? "var(--cinnabar)" : "transparent",
                  color: selected ? "var(--cinnabar)" : "var(--ink-mid)",
                }}
              >
                <Icon className="h-3.5 w-3.5" />
                {section.label}
                {count > 0 && (
                  <span
                    className="rounded-full px-1.5 text-[11px] tabular-nums"
                    style={{
                      background: selected
                        ? "color-mix(in srgb, var(--cinnabar) 14%, transparent)"
                        : "var(--ink-wash-strong)",
                      color: selected ? "var(--cinnabar)" : "var(--ink-mid)",
                    }}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* 一个分区都没有：老记录既没有 stages 也没有任何建议时会走到这里。原来
          结构分区是无条件渲染的，总有个空状态兜着；改成按范围出页签后不能让面板
          在摘要下方直接空掉。 */}
      {sections.length === 0 && (
        <p className="mt-5 text-sm" style={{ color: "var(--ink-faint)" }}>
          {t.agentReview.noSuggestions}
        </p>
      )}

      <div role="tabpanel" className="mt-4">
        {activeKey === "title" && (
          <>
            {(review.titleScore !== null && review.titleScore !== undefined) ||
            review.titleAssessment ? (
              <div className="mb-3">
                {review.titleScore !== null &&
                  review.titleScore !== undefined && (
                    <p
                      className="text-sm font-semibold tabular-nums"
                      style={{
                        color: titleScoreNeedsAlternatives(review.titleScore)
                          ? "var(--cinnabar)"
                          : "var(--ink-strong)",
                      }}
                    >
                      {interpolate(t.agentReview.titleScore, {
                        score: review.titleScore,
                      })}
                    </p>
                  )}
                {review.titleAssessment && (
                  <p
                    className="mt-1 text-sm leading-6"
                    style={{ color: "var(--ink-mid)" }}
                  >
                    {review.titleAssessment}
                  </p>
                )}
              </div>
            ) : null}
            <SuggestionCollection
              suggestions={titleSuggestions}
              emptyText={
                titleScoreNeedsAlternatives(review.titleScore ?? 100)
                  ? t.agentReview.noTitleSuggestionsLowScore
                  : t.agentReview.noTitleSuggestions
              }
              {...suggestionListProps}
            />
          </>
        )}

        {activeKey === "structure" && (
          <>
            {layoutAssessed ? (
              <LayoutDimensionAccordion
                assessment={layoutAssessment}
                suggestionsOf={suggestionsOfDimension}
                expandedIds={expandedIds}
                onToggleDimension={(dimensionId) => {
                  onDeepFocusChange(dimensionId);
                  setExpandedDimensionIds((prev) => {
                    const base = prev ?? expandedIds;
                    return base.includes(dimensionId)
                      ? base.filter((id) => id !== dimensionId)
                      : [...base, dimensionId];
                  });
                }}
                deepAnalyzing={deepAnalyzing}
                deepAnalysisDisabled={deepAnalysisDisabled}
                deepEstimateFocusDimension={deepEstimateFocusDimension}
                deepEstimateCredits={deepEstimateCredits}
                deepEstimateLoading={deepEstimateLoading}
                deepEstimateError={deepEstimateError}
                deepEstimateAffordable={deepEstimateAffordable}
                onRetryDeepEstimate={onRetryDeepEstimate}
                onDeepAnalyze={onDeepAnalyze}
                suggestionListProps={suggestionListProps}
              />
            ) : !deepReview ? (
              <p
                className="mb-3 text-xs leading-5"
                style={{ color: "var(--ink-faint)" }}
              >
                {t.agentReview.layoutNotAssessed}
              </p>
            ) : null}
            {/* 六维之外的结构建议：没有折叠块能收留它们，直接铺在下面。深度审阅
                只产出单一维度的补丁，六维分组对它没意义，也走这条路径。 */}
            {(grouped.unmatched.length > 0 || !layoutAssessed) && (
              <div className={layoutAssessed ? "mt-4" : undefined}>
                {layoutAssessed && (
                  <p
                    className="mb-2 text-xs font-semibold"
                    style={{ color: "var(--ink-mid)" }}
                  >
                    {t.agentReview.otherLayoutSuggestions}
                  </p>
                )}
                <SuggestionCollection
                  suggestions={grouped.unmatched}
                  emptyText={
                    deepReview
                      ? t.agentReview.noSuggestions
                      : t.agentReview.noLayoutSuggestions
                  }
                  {...suggestionListProps}
                />
              </div>
            )}
          </>
        )}

        {activeKey === "proofread" && (
          <SuggestionCollection
            suggestions={sectionsOf.proofread}
            emptyText={t.agentReview.noContentSuggestions}
            {...suggestionListProps}
          />
        )}

        {activeKey === "paragraph" && (
          <SuggestionCollection
            suggestions={sectionsOf.paragraph}
            emptyText={t.agentReview.noContentSuggestions}
            {...suggestionListProps}
          />
        )}
      </div>
    </div>
  );
}

/**
 * 六维评分做成折叠面板：每维一行，行上是评分条 + 待处理条数，展开后就地显示
 * 该维的建议和深入分析入口。可以同时展开多维。
 *
 * 换掉了原来的「点维度筛选下方共用列表」：那种做法下建议区离维度行有一段距离，
 * 用户点一下得往下找列表变成了什么，而且一次只能看一维。折叠面板把维度和它的
 * 建议放在同一块里，展开哪几维由用户自己决定。
 */
function LayoutDimensionAccordion({
  assessment,
  suggestionsOf,
  expandedIds,
  onToggleDimension,
  deepAnalyzing,
  deepAnalysisDisabled,
  deepEstimateFocusDimension,
  deepEstimateCredits,
  deepEstimateLoading,
  deepEstimateError,
  deepEstimateAffordable,
  onRetryDeepEstimate,
  onDeepAnalyze,
  suggestionListProps,
}: {
  assessment: AgentReview["layoutAssessment"];
  suggestionsOf: (dimensionId: string) => AgentReviewSuggestion[];
  expandedIds: readonly string[];
  onToggleDimension: (dimensionId: AgentReviewLayoutAssessment["id"]) => void;
  deepAnalyzing: boolean;
  deepAnalysisDisabled: boolean;
  deepEstimateFocusDimension: AgentReviewLayoutAssessment["id"] | null;
  deepEstimateCredits?: number;
  deepEstimateLoading: boolean;
  deepEstimateError: boolean;
  deepEstimateAffordable: boolean;
  onRetryDeepEstimate: () => void;
  onDeepAnalyze: (dimensionId: AgentReviewLayoutAssessment["id"]) => void;
  suggestionListProps: SuggestionListProps;
}) {
  const { t } = useI18n();
  if (assessment.length === 0) return null;
  const weakest = assessment.reduce<AgentReviewLayoutAssessment | null>(
    (lowest, dimension) =>
      !lowest || dimension.score < lowest.score ? dimension : lowest,
    null,
  );

  return (
    <div>
      <p className="text-xs" style={{ color: "var(--ink-faint)" }}>
        {t.agentReview.layoutDimensionHint}
      </p>
      <ul className="mt-2 space-y-1.5">
        {assessment.map((dimension) => {
          const expanded = expandedIds.includes(dimension.id);
          const low = dimension.score < 60;
          const items = suggestionsOf(dimension.id);
          const pendingCount = items.filter(
            (item) => item.status === "pending",
          ).length;
          return (
            <li
              key={dimension.id}
              className="overflow-hidden rounded-md border"
              style={{
                borderColor: expanded ? "var(--cinnabar)" : "var(--ink-line)",
                background: expanded ? "var(--cinnabar-soft)" : "transparent",
              }}
            >
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => onToggleDimension(dimension.id)}
                className="w-full px-3 py-2 text-left transition hover:bg-[var(--ink-wash)]"
              >
                <div className="flex items-center gap-2.5">
                  <ChevronRight
                    className="h-3.5 w-3.5 shrink-0 transition-transform"
                    style={{
                      color: "var(--ink-faint)",
                      transform: expanded ? "rotate(90deg)" : "none",
                    }}
                  />
                  <span className="w-16 shrink-0 text-xs font-semibold">
                    {dimension.label}
                  </span>
                  <span
                    className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full"
                    style={{ background: "var(--ink-line)" }}
                  >
                    <span
                      className="block h-full rounded-full"
                      style={{
                        width: `${Math.max(0, Math.min(100, dimension.score))}%`,
                        background: low
                          ? "var(--cinnabar)"
                          : "var(--ink-strong)",
                      }}
                    />
                  </span>
                  <span
                    className="w-8 shrink-0 text-right text-xs font-semibold tabular-nums"
                    style={{
                      color: low ? "var(--cinnabar)" : "var(--ink-mid)",
                    }}
                  >
                    {dimension.score}
                  </span>
                  {/* 折叠着也要能看出这一维有几条待处理，否则得逐个展开才知道哪维有内容 */}
                  <span
                    className="w-6 shrink-0 text-right text-[11px] font-semibold tabular-nums"
                    style={{
                      color:
                        pendingCount > 0
                          ? "var(--cinnabar)"
                          : "var(--ink-faint)",
                    }}
                  >
                    {pendingCount > 0 ? pendingCount : "–"}
                  </span>
                  {weakest?.id === dimension.id && (
                    <span
                      className="shrink-0 text-[10px] font-semibold"
                      style={{ color: "var(--cinnabar)" }}
                    >
                      {t.agentReview.weakestDimension}
                    </span>
                  )}
                </div>
              </button>
              {expanded && (
                <div
                  className="border-t px-3 py-3"
                  style={{
                    borderColor: "var(--ink-line)",
                    background: "var(--ink-paper)",
                  }}
                >
                  <p
                    className="text-xs leading-5"
                    style={{ color: "var(--ink-mid)" }}
                  >
                    {dimension.summary}
                  </p>
                  <div className="mt-3">
                    <SuggestionCollection
                      suggestions={items}
                      emptyText={interpolate(
                        t.agentReview.noFilteredLayoutSuggestions,
                        {
                          dimension: dimension.label,
                        },
                      )}
                      {...suggestionListProps}
                    />
                  </div>
                  <button
                    type="button"
                    disabled={
                      deepAnalyzing ||
                      deepAnalysisDisabled ||
                      deepEstimateFocusDimension !== dimension.id
                    }
                    title={
                      deepEstimateFocusDimension === dimension.id
                        ? undefined
                        : t.agentReview.deepAnalysisExpandHint
                    }
                    onClick={() => onDeepAnalyze(dimension.id)}
                    className="mt-3 inline-flex min-h-9 w-full items-center justify-center gap-1.5 rounded-md border px-3 text-xs font-semibold transition disabled:cursor-not-allowed disabled:opacity-45"
                    style={{
                      borderColor: "var(--cinnabar)",
                      color: "var(--cinnabar)",
                    }}
                  >
                    {deepAnalyzing ? (
                      <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Pencil className="h-3.5 w-3.5" />
                    )}
                    {deepAnalyzing
                      ? t.agentReview.deepAnalysisStarting
                      : `${t.agentReview.deepAnalysis} · ${dimension.label}`}
                  </button>
                  {deepEstimateFocusDimension === dimension.id &&
                    (deepEstimateLoading ||
                      deepEstimateError ||
                      deepEstimateCredits !== undefined) && (
                      <p
                        className="mt-2 text-[11px] leading-4"
                        style={{
                          color:
                            deepEstimateError || !deepEstimateAffordable
                              ? "var(--cinnabar)"
                              : "var(--ink-faint)",
                        }}
                      >
                        {deepEstimateError
                          ? (
                              <>
                                {t.agentReview.estimateFailed}{" "}
                                <button
                                  type="button"
                                  onClick={() => onRetryDeepEstimate()}
                                  className="font-semibold underline"
                                >
                                  {t.agentReview.estimateRetry}
                                </button>
                              </>
                            )
                          : deepEstimateLoading ||
                              deepEstimateCredits === undefined
                            ? t.agentReview.estimateLoading
                            : deepEstimateAffordable
                              ? interpolate(t.agentReview.estimateHint, {
                                  credits: deepEstimateCredits,
                                })
                              : interpolate(
                                  t.agentReview.estimateInsufficient,
                                  { credits: deepEstimateCredits },
                                )}
                      </p>
                    )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function AgentReviewProgress({ review }: { review: AgentReview }) {
  const { t } = useI18n();
  const progress = review.taskProgress;
  if (!progress || progress.totalTasks <= 0) return null;
  const percentage = Math.round(
    (progress.completedTasks / progress.totalTasks) * 100,
  );
  const labels = {
    title: t.agentReview.stageTitle,
    document: t.agentReview.stageDocument,
    body: t.agentReview.stageBody,
    layout: t.agentReview.stageLayout,
  };
  return (
    <div
      className="mt-4 rounded-md border p-3"
      style={{
        borderColor: "var(--ink-line)",
        background: "var(--ink-paper-soft)",
      }}
    >
      <div
        className="flex items-center justify-between gap-3 text-xs"
        style={{ color: "var(--ink-mid)" }}
      >
        <span>
          {interpolate(t.agentReview.progress, {
            completed: progress.completedTasks,
            total: progress.totalTasks,
          })}
        </span>
        <span className="tabular-nums">{percentage}%</span>
      </div>
      <div
        className="mt-2 h-1.5 overflow-hidden rounded-full"
        style={{ background: "var(--ink-line)" }}
      >
        <div
          className="h-full rounded-full transition-[width] duration-300"
          style={{ width: `${percentage}%`, background: "var(--cinnabar)" }}
        />
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {progress.stages.map((stage) => (
          <div
            key={stage.id}
            className="flex items-center gap-2 text-xs"
            style={{
              color:
                stage.status === "completed"
                  ? "var(--ink-strong)"
                  : "var(--ink-faint)",
            }}
          >
            {stage.status === "completed" ? (
              <Check className="h-3.5 w-3.5" />
            ) : stage.status === "running" ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : stage.status === "failed" ? (
              <AlertCircle className="h-3.5 w-3.5" />
            ) : (
              <Clock3 className="h-3.5 w-3.5" />
            )}
            <span>{labels[stage.id]}</span>
            {stage.totalTasks > 1 && (
              <span className="tabular-nums">
                {stage.completedTasks}/{stage.totalTasks}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function PartialAgentReviewResult({ review }: { review: AgentReview }) {
  const { t } = useI18n();
  const suggestions = review.suggestions ?? [];
  const hasTitleResult = hasAgentReviewTitleAssessment(review);
  if (
    !hasTitleResult &&
    suggestions.length === 0 &&
    !hasAgentReviewLayoutAssessment(review)
  )
    return null;
  return (
    <div
      className="mt-4 border-l-2 pl-3"
      style={{ borderColor: "var(--ink-line)" }}
    >
      <p className="text-xs" style={{ color: "var(--ink-faint)" }}>
        {t.agentReview.partialResults}
      </p>
      {hasTitleResult && (
        <div className="mt-3">
          <p
            className="text-sm font-semibold tabular-nums"
            style={{
              color: titleScoreNeedsAlternatives(review.titleScore ?? 100)
                ? "var(--cinnabar)"
                : "var(--ink-strong)",
            }}
          >
            {interpolate(t.agentReview.titleScore, {
              score: review.titleScore ?? 0,
            })}
          </p>
          {review.titleAssessment && (
            <p
              className="mt-1 text-xs leading-5"
              style={{ color: "var(--ink-mid)" }}
            >
              {review.titleAssessment}
            </p>
          )}
        </div>
      )}
      {suggestions.slice(0, 4).map((suggestion) => (
        <article
          key={suggestion.suggestionId}
          className="mt-3 rounded-md border p-3"
          style={{ borderColor: "var(--ink-line)" }}
        >
          <p
            className="text-xs font-semibold"
            style={{ color: "var(--ink-mid)" }}
          >
            {t.agentReview.categories[
              suggestion.category as keyof typeof t.agentReview.categories
            ] ?? suggestion.category}
          </p>
          <div className="mt-2 space-y-2">
            <DiffBlock
              sign="-"
              label={t.agentReview.before}
              value={suggestion.before}
              tone="remove"
            />
            <DiffBlock
              sign="+"
              label={t.agentReview.after}
              value={suggestion.after}
              tone="add"
            />
          </div>
        </article>
      ))}
    </div>
  );
}

function SuggestionCollection({
  suggestions,
  emptyText,
  mutating,
  applyingId,
  activeSuggestionId,
  anchoredIds,
  onFocus,
  onApply,
  onDismiss,
}: {
  suggestions: AgentReviewSuggestion[];
  emptyText: string;
  mutating: boolean;
  applyingId?: string;
  activeSuggestionId: string;
  anchoredIds: string[];
  onFocus: (suggestion: AgentReviewSuggestion) => void;
  onApply: (suggestion: AgentReviewSuggestion) => void;
  onDismiss: (suggestion: AgentReviewSuggestion) => void;
}) {
  if (suggestions.length === 0) {
    return (
      <p className="text-sm" style={{ color: "var(--ink-faint)" }}>
        {emptyText}
      </p>
    );
  }
  return (
    <div className="space-y-3">
      {suggestions.map((suggestion) => (
        <SuggestionItem
          key={suggestion.suggestionId}
          suggestion={suggestion}
          mutating={mutating}
          applying={applyingId === suggestion.suggestionId}
          active={activeSuggestionId === suggestion.suggestionId}
          anchored={anchoredIds.includes(suggestion.suggestionId)}
          onFocus={() => onFocus(suggestion)}
          onApply={() => onApply(suggestion)}
          onDismiss={() => onDismiss(suggestion)}
        />
      ))}
    </div>
  );
}

function SuggestionItem({
  suggestion,
  mutating,
  applying,
  active,
  anchored,
  onFocus,
  onApply,
  onDismiss,
}: {
  suggestion: AgentReviewSuggestion;
  mutating: boolean;
  applying: boolean;
  active: boolean;
  anchored: boolean;
  onFocus: () => void;
  onApply: () => void;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const category =
    t.agentReview.categories[
      suggestion.category as keyof typeof t.agentReview.categories
    ] ?? suggestion.category;
  return (
    <article
      data-suggestion-card={suggestion.suggestionId}
      className="overflow-hidden rounded-md border transition"
      style={{
        borderColor: active ? "var(--cinnabar)" : "var(--ink-line)",
        background: "var(--ink-paper-soft)",
        boxShadow: active
          ? "0 0 0 2px color-mix(in srgb, var(--cinnabar) 22%, transparent)"
          : "none",
      }}
    >
      {/* 卡片头部整体可点：定位到正文对应位置。用 button 而不是给 article 加
          onClick，键盘用户也要能触发。 */}
      <button
        type="button"
        onClick={() => onFocus()}
        disabled={!anchored}
        aria-label={anchored ? t.agentReview.locateInDocument : undefined}
        className="flex w-full items-start justify-between gap-3 px-3 py-3 text-left transition enabled:hover:bg-[var(--ink-wash)] disabled:cursor-default"
      >
        <div className="min-w-0">
          <span
            className="flex items-center gap-1.5 text-xs font-semibold"
            style={{ color: "var(--ink-strong)" }}
          >
            {category}
            {anchored && (
              <Crosshair
                className="h-3 w-3"
                style={{ color: "var(--cinnabar)" }}
              />
            )}
          </span>
          <p
            className="mt-1 text-xs leading-5"
            style={{ color: "var(--ink-mid)" }}
          >
            {suggestion.reason}
          </p>
        </div>
        {suggestion.status !== "pending" ? (
          <span
            className="shrink-0 text-xs font-medium"
            style={{ color: "var(--ink-faint)" }}
          >
            {suggestion.status === "applied"
              ? t.agentReview.applied
              : t.agentReview.dismissed}
          </span>
        ) : anchored ? (
          <ChevronRight
            className="h-4 w-4 shrink-0"
            style={{ color: "var(--ink-faint)" }}
          />
        ) : null}
      </button>
      <DiffBlock
        sign="-"
        label={t.agentReview.before}
        value={suggestion.before}
        tone="remove"
      />
      <DiffBlock
        sign="+"
        label={t.agentReview.after}
        value={suggestion.after}
        tone="add"
      />
      {suggestion.status === "pending" && (
        <div
          className="grid grid-cols-2 gap-2 border-t p-3"
          style={{ borderColor: "var(--ink-line)" }}
        >
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
            style={{
              background: "var(--ink-strong)",
              color: "var(--ink-paper)",
            }}
          >
            {applying ? (
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            {applying ? t.agentReview.applying : t.agentReview.apply}
          </button>
        </div>
      )}
    </article>
  );
}

function DiffBlock({
  sign,
  label,
  value,
  tone,
}: {
  sign: string;
  label: string;
  value: string;
  tone: "remove" | "add";
}) {
  const remove = tone === "remove";
  return (
    <div
      className="grid grid-cols-[1.5rem_minmax(0,1fr)] border-t font-mono text-xs leading-5"
      style={{
        borderColor: "var(--ink-line)",
        background: remove
          ? "color-mix(in srgb, #ef4444 7%, var(--ink-paper))"
          : "color-mix(in srgb, #22c55e 7%, var(--ink-paper))",
      }}
    >
      <span
        className="px-2 py-2.5 text-center select-none"
        style={{ color: remove ? "#b91c1c" : "#15803d" }}
      >
        {sign}
      </span>
      <div
        className="min-w-0 border-l px-2.5 py-2.5"
        style={{ borderColor: "var(--ink-line)" }}
      >
        <span
          className="mb-1 block font-sans text-[10px] font-semibold uppercase"
          style={{ color: "var(--ink-faint)" }}
        >
          {label}
        </span>
        <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-words font-mono">
          {value || "∅"}
        </pre>
      </div>
    </div>
  );
}

function GateMessage({
  text,
  children,
}: {
  text: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="py-16 text-center">
      <Sparkles
        className="mx-auto h-7 w-7"
        style={{ color: "var(--ink-faint)" }}
      />
      <p
        className="mx-auto mt-4 max-w-sm text-sm leading-6"
        style={{ color: "var(--ink-mid)" }}
      >
        {text}
      </p>
      {children}
    </div>
  );
}

function StatusBlock({
  icon,
  title,
  body,
}: {
  icon: React.ReactNode;
  title: string;
  body?: string;
}) {
  return (
    <div
      className="mt-4 rounded-md border p-4"
      style={{ borderColor: "var(--ink-line)" }}
    >
      <div className="flex items-center gap-2 text-sm font-semibold">
        {icon}
        {title}
      </div>
      {body && (
        <p
          className="mt-2 text-sm leading-6"
          style={{ color: "var(--ink-mid)" }}
        >
          {body}
        </p>
      )}
    </div>
  );
}

function agentReviewErrorText(
  error: unknown,
  fallback: string,
  errors: Record<string, string>,
): string {
  if (error instanceof ApiError && error.code && errors[error.code])
    return errors[error.code];
  return fallback;
}

function reviewFailureStatusText(
  errorCode: string | null | undefined,
  providerMode: AgentReview["providerMode"],
  errors: Record<string, string>,
  fallback: string,
): string {
  const translatedCode = agentReviewFailureTranslationCode(
    errorCode,
    providerMode,
  );
  if (translatedCode && errors[translatedCode]) return errors[translatedCode];
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
