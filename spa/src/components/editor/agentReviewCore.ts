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

export function filterAgentReviewDimensionSuggestions<
  Suggestion extends { kind: string; category: string },
>(suggestions: Suggestion[], dimensionId: string | null): Suggestion[] {
  if (!dimensionId) return suggestions;
  return suggestions.filter(
    (item) =>
      item.category === dimensionId &&
      (item.kind === "layout" || item.kind === "content"),
  );
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
