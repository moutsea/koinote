export type AgentReviewProviderMode = "builtin" | "byok";

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
