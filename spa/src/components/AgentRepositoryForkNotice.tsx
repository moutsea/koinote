import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { PublicAgentRepositorySync } from "../agentRepositorySharing";
import { AGENT_REPOSITORY_FORK_NOTICE_QUERY_KEY, publicRepositoryPreparationFeedback } from "../agentRepositorySyncFeedback";
import { useI18n } from "../i18n";

export function AgentRepositoryForkNotice({ userId, workspaceId }: { userId: number; workspaceId: number }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const queryKey = [AGENT_REPOSITORY_FORK_NOTICE_QUERY_KEY, userId, workspaceId];
  // A successful Fork writes this account-scoped notice before navigation.
  // Keep the original result codes so changing locale also translates it.
  const notice = useQuery<PublicAgentRepositorySync | null>({ queryKey, queryFn: () => null, enabled: false, staleTime: Infinity });
  const message = notice.data && publicRepositoryPreparationFeedback(notice.data, t.agentWorkspace);
  if (!message) return null;
  return <div role="status" className="mt-5 flex items-start gap-3 rounded-lg border p-4 text-sm" style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }}>
    <p className="flex-1">{message}</p>
    <button type="button" className="shrink-0 underline" onClick={() => client.setQueryData(queryKey, null)}>{t.announcements.close}</button>
  </div>;
}
