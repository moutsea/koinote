export type AgentReviewProviderMode = "builtin" | "byok";

const AGENT_REVIEW_FAILURE_TRANSLATIONS: Record<string, string> = {
  usage_missing: "agent_invalid_response",
  usage_invalid: "agent_invalid_response",
  invalid_response: "agent_invalid_response",
  provider_unavailable: "agent_provider_unavailable",
  finalize_failed: "server_error",
  credit_reservation_failed: "server_error",
};

export function agentReviewFailureTranslationCode(
  errorCode: string | null | undefined,
  providerMode?: AgentReviewProviderMode,
): string | null {
  if (!errorCode) return null;
  if (errorCode === "provider_http_error") {
    return providerMode === "byok"
      ? "agent_provider_error"
      : "agent_provider_unavailable";
  }
  return AGENT_REVIEW_FAILURE_TRANSLATIONS[errorCode] ?? errorCode;
}

export const AGENT_REVIEW_BACKGROUND_TIMEOUT_MS = 15 * 60 * 1_000;

export type AgentReviewAccess =
  | "ready"
  | "membership_required"
  | "local_mode_unavailable";

export function agentReviewAccess(
  member: boolean,
  localMode: boolean,
): AgentReviewAccess {
  if (localMode) return "local_mode_unavailable";
  return member ? "ready" : "membership_required";
}

export function canStartAgentReview(
  providerMode: AgentReviewProviderMode,
  builtinEnabled: boolean,
  channelId: string,
): boolean {
  return providerMode === "builtin"
    ? builtinEnabled
    : channelId.trim() !== "";
}

export function hasRunningAgentReviewForCurrentRevision(
  reviews: Array<{
    status: string;
    baseRevision: number;
    documentRevision: number;
  }>,
): boolean {
  return reviews.some(
    (review) =>
      review.status === "running" &&
      review.baseRevision === review.documentRevision,
  );
}

export function titleScoreNeedsAlternatives(score: number): boolean {
  return score < 60;
}

/**
 * 把结构建议按六维分组，每维一组，剩下的归到 unmatched。
 *
 * 折叠面板按维度渲染，如果只渲染六组，category 不落在六维里的建议就消失了 ——
 * 建议是模型给的，六维只是它被要求打分的坐标系，两者不保证对齐。unmatched
 * 单独成一组显示，宁可多一个「其他」区，也不能让用户看不到已经付过费的建议。
 */
export function groupAgentReviewSuggestionsByDimension<
  Suggestion extends { kind: string; category: string },
>(
  suggestions: Suggestion[],
  dimensionIds: readonly string[],
): { byDimension: Map<string, Suggestion[]>; unmatched: Suggestion[] } {
  const byDimension = new Map<string, Suggestion[]>();
  for (const id of dimensionIds) byDimension.set(id, []);
  const unmatched: Suggestion[] = [];
  for (const item of suggestions) {
    const bucket = byDimension.get(item.category);
    if (bucket && (item.kind === "layout" || item.kind === "content")) {
      bucket.push(item);
      continue;
    }
    unmatched.push(item);
  }
  return { byDimension, unmatched };
}

/** 折叠面板默认展开哪一维：优先第一个有待处理建议的维度，否则分数最低的那维。 */
export function defaultExpandedAgentReviewDimension<
  Dimension extends { id: string; score: number },
>(
  dimensions: readonly Dimension[],
  pendingCountOf: (dimensionId: string) => number,
): string | null {
  if (dimensions.length === 0) return null;
  const withPending = dimensions.find((item) => pendingCountOf(item.id) > 0);
  if (withPending) return withPending.id;
  return dimensions.reduce((lowest, item) => (item.score < lowest.score ? item : lowest)).id;
}

export function agentReviewTaskExpired(
  expiresAt: string | undefined,
  createdAt: string,
  now = Date.now(),
): boolean {
  const explicitDeadline = Date.parse(expiresAt ?? "");
  if (Number.isFinite(explicitDeadline)) return explicitDeadline <= now;
  const createdAtTime = Date.parse(createdAt);
  return (
    Number.isFinite(createdAtTime) &&
    createdAtTime + AGENT_REVIEW_BACKGROUND_TIMEOUT_MS <= now
  );
}

/**
 * 剥掉行内 Markdown 标记，得到编辑器里实际显示的文本。
 *
 * 建议的 before 是后端从 Markdown 源码里切出来的，而编辑器里是渲染后的文档：
 * `**粗体**` 在文档里只剩 `粗体`。要把建议标回正文，得先把两边归到同一种形式。
 *
 * 块级标记（`## `、`- `、`> `）在文档里对应节点类型而非文本，所以一并去掉。
 * 链接保留可见文字丢掉 URL；图片整体丢掉——它在文档里是原子节点，没有对应文本。
 */
export function markdownToPlainText(value: string): string {
  return value
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*\*|___)(.+?)\1/g, "$2")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(.+?)\1/g, "$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]{0,3}>[ \t]?/gm, "")
    .replace(/^[ \t]{0,3}(?:[-*+]|\d+[.)])[ \t]+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

export const AGENT_REVIEW_TASKS = [
  "title",
  "proofread",
  "structure",
  "paragraph",
] as const;

export type AgentReviewTaskId = (typeof AGENT_REVIEW_TASKS)[number];

/** 按固定顺序排列勾选结果，与后端 normalizeAgentReviewTasks 的顺序一致。 */
export function normalizeAgentReviewTaskSelection(
  selected: Iterable<string>,
): AgentReviewTaskId[] {
  const chosen = new Set(selected);
  return AGENT_REVIEW_TASKS.filter((task) => chosen.has(task));
}

export function toggleAgentReviewTask(
  selected: readonly AgentReviewTaskId[],
  task: AgentReviewTaskId,
): AgentReviewTaskId[] {
  const next = new Set<string>(selected);
  if (next.has(task)) next.delete(task);
  else next.add(task);
  return normalizeAgentReviewTaskSelection(next);
}

/**
 * 从 taskProgress.stages 反推本次勾了哪几项。
 *
 * 后端建计划时只为实际存在任务的阶段生成 stage（newAgentReviewTaskProgress 里
 * `total > 0` 才 append），且四项勾选与四个阶段一一对应，所以 stages 就是勾选
 * 范围的权威记录。
 *
 * 不能用「有没有建议」来推：勾了校对但一条都没挑出来，是「审过、很干净」，和
 * 「没勾校对」是两件事，而用户为前者付过费。也不能用 category 推来源 —— body
 * 和 document 两个阶段共用同一套 category 枚举，分不开。
 */
const AGENT_REVIEW_STAGE_TO_TASK: Record<string, AgentReviewTaskId> = {
  title: "title",
  layout: "structure",
  document: "paragraph",
  body: "proofread",
};

export function agentReviewTasksInScope(
  stages: ReadonlyArray<{ id: string }> | null | undefined,
): AgentReviewTaskId[] {
  const found = new Set<string>();
  for (const stage of stages ?? []) {
    const task = AGENT_REVIEW_STAGE_TO_TASK[stage.id];
    if (task) found.add(task);
  }
  return normalizeAgentReviewTaskSelection(found);
}

/**
 * 六维评分是否真的评估过。
 *
 * 后端在计划里没有结构任务时会写入空数组，前端据此隐藏能力图——而不是渲染一张
 * 六项满分的假图，那会让用户基于没评估过的维度发起付费的深入分析。
 */
export function hasAgentReviewLayoutAssessment(
  review: { layoutAssessment?: Array<{ id: string }> | null } | null | undefined,
): boolean {
  return (review?.layoutAssessment?.length ?? 0) > 0;
}

/** 本次审阅是否给出过标题结论，决定标题分区是否可信。 */
export function hasAgentReviewTitleAssessment(
  review:
    | { titleScore?: number | null; titleAssessment?: string | null }
    | null
    | undefined,
): boolean {
  return review?.titleScore !== null && review?.titleScore !== undefined;
}

/**
 * 待处理建议在正文里的锚点。只有 pending 的才标：已落实的那段文字已经被替换，
 * 已忽略的用户明确表示不想看。
 */
export function agentReviewPendingAnchors<
  Suggestion extends {
    suggestionId: string;
    target: string;
    status: string;
    before: string;
  },
>(suggestions: Suggestion[] | undefined): Array<{
  suggestionId: string;
  before: string;
}> {
  return (suggestions ?? [])
    .filter(
      (item) =>
        item.status === "pending" && item.target === "body" && item.before !== "",
    )
    .map((item) => ({ suggestionId: item.suggestionId, before: item.before }));
}

/** 预留额度是上限；余额够不够按它判断，避免跑到一半才报 insufficient_credits。 */
export function agentReviewAffordable(
  providerMode: AgentReviewProviderMode,
  availableCredits: number | undefined,
  reservedCredits: number | undefined,
): boolean {
  if (providerMode !== "builtin") return true;
  if (availableCredits === undefined || reservedCredits === undefined) return true;
  return availableCredits >= reservedCredits;
}
