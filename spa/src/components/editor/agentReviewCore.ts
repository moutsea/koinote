export type AgentReviewProviderMode = "builtin" | "byok";

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

export function titleScoreNeedsAlternatives(score: number): boolean {
  return score < 60;
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
