import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { ApiError, type User } from "../api";
import { deleteAgentGitHubCredential, getAgentGitHubCredential, GITHUB_CREDENTIAL_QUERY_KEY, githubImportErrorMessage, saveAgentGitHubCredential } from "../agentGitHubImport";
import { useSession } from "../auth";
import { confirmAction } from "../confirmAction";
import { useI18n } from "../i18n";
import { PaperCard } from "./Ink";

export function AgentGitHubCredentialCard() {
  const user = useSession().data?.user;
  if (!user || user.isLocalMode) return null;
  return <AccountGitHubCredentialCard key={user.authUserId} user={user} />;
}

function AccountGitHubCredentialCard({ user }: { user: User }) {
  const { t } = useI18n();
  const labels = t.agentWorkspace;
  const client = useQueryClient();
  const credentialKey = [GITHUB_CREDENTIAL_QUERY_KEY, user.authUserId];
  const credential = useQuery({ queryKey: credentialKey, queryFn: getAgentGitHubCredential, retry: false });
  const canSave = user.isAdmin || user.membershipTier === "lifetime";
  const [token, setToken] = useState("");
  const save = useMutation({ mutationFn: () => saveAgentGitHubCredential(token), onSuccess: async (result) => {
    setToken("");
    client.setQueryData(credentialKey, result);
    await client.invalidateQueries({ queryKey: credentialKey, exact: true });
  } });
  const remove = useMutation({ mutationFn: deleteAgentGitHubCredential, onSuccess: async () => {
    save.reset();
    client.setQueryData(credentialKey, { credential: { configured: false } });
    await client.invalidateQueries({ queryKey: credentialKey, exact: true });
  } });
  const pending = save.isPending || remove.isPending;
  const error = save.error ?? remove.error;
  const membershipError = error instanceof ApiError && error.code === "membership_required";
  return <PaperCard className="space-y-4 p-6">
    <h2 className="text-base font-semibold">{labels.githubTokenTitle}</h2>
    <p className="text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{labels.githubTokenDescription}</p>
    {credential.isPending ? <p role="status" className="text-xs">{labels.loading}</p> : credential.data && <p className="text-xs">{credential.data.credential.configured ? `${labels.githubTokenConfigured} · ••••${credential.data.credential.tokenHint}` : labels.githubTokenNotConfigured}</p>}
    {credential.isError && <div role="alert" className="flex items-center gap-3 text-xs" style={{ color: "var(--cinnabar)" }}>
      <p>{githubImportErrorMessage(credential.error, labels, labels.githubTokenLoadFailed)}</p>
      <button type="button" disabled={credential.isFetching || pending} onClick={() => void credential.refetch()} className="underline disabled:opacity-50">{labels.refresh}</button>
    </div>}
    {canSave && <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (!pending && token.trim()) { remove.reset(); save.mutate(); } }}>
      <label className="block text-sm">GitHub Token<input type="password" autoComplete="new-password" maxLength={512} value={token} disabled={pending} onChange={(event) => { setToken(event.target.value); save.reset(); }} className="mt-2 w-full rounded-lg border bg-transparent px-3 py-2.5" /></label>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending || !token.trim()} className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50">{labels.githubTokenSave}</button>
        <a href="https://github.com/settings/personal-access-tokens" target="_blank" rel="noreferrer" className="text-xs underline">{labels.githubTokenCreate}</a>
      </div>
    </form>}
    {(!canSave || membershipError) && <p role={membershipError ? "alert" : undefined} className="text-xs">{labels.githubTokenMembersOnly}{" "}<Link to="/pricing" className="underline">{t.mcp.upgrade}</Link></p>}
    {credential.data?.credential.configured && <button type="button" disabled={pending} className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50" onClick={async () => { if (await confirmAction(labels.githubTokenRemoveConfirm)) { save.reset(); remove.mutate(); } }}>{labels.githubTokenRemove}</button>}
    {save.isSuccess && <p role="status" className="text-xs">{labels.githubTokenSaved}</p>}
    {error && !membershipError && <p role="alert" className="text-xs" style={{ color: "var(--cinnabar)" }}>{githubImportErrorMessage(error, labels, save.isError ? labels.githubTokenSaveFailed : labels.githubTokenRemoveFailed)}</p>}
  </PaperCard>;
}
