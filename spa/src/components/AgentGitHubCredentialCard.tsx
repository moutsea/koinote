import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { deleteAgentGitHubCredential, getAgentGitHubCredential, GITHUB_CREDENTIAL_QUERY_KEY, githubImportErrorMessage, saveAgentGitHubCredential } from "../agentGitHubImport";
import { confirmAction } from "../confirmAction";
import { useI18n } from "../i18n";
import { PaperCard } from "./Ink";

export function AgentGitHubCredentialCard() {
  const { t } = useI18n();
  const labels = t.agentWorkspace;
  const client = useQueryClient();
  const credential = useQuery({ queryKey: [GITHUB_CREDENTIAL_QUERY_KEY], queryFn: getAgentGitHubCredential, retry: false });
  const [token, setToken] = useState("");
  const save = useMutation({ mutationFn: () => saveAgentGitHubCredential(token), onSuccess: async () => { setToken(""); await client.invalidateQueries({ queryKey: [GITHUB_CREDENTIAL_QUERY_KEY] }); } });
  const remove = useMutation({ mutationFn: deleteAgentGitHubCredential, onSuccess: async () => { save.reset(); await client.invalidateQueries({ queryKey: [GITHUB_CREDENTIAL_QUERY_KEY] }); } });
  const pending = save.isPending || remove.isPending;
  const error = save.error ?? remove.error ?? credential.error;
  return <PaperCard className="space-y-4 p-6">
    <h2 className="text-base font-semibold">{labels.githubTokenTitle}</h2>
    <p className="text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{labels.githubTokenDescription}</p>
    <p className="text-xs">{credential.isPending ? labels.loading : credential.data?.credential.configured ? `${labels.githubTokenConfigured} · ••••${credential.data.credential.tokenHint}` : labels.githubTokenNotConfigured}</p>
    <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); if (!pending && token.trim()) { remove.reset(); save.mutate(); } }}>
      <label className="block text-sm">GitHub Token<input type="password" autoComplete="new-password" maxLength={512} value={token} disabled={pending} onChange={(event) => { setToken(event.target.value); save.reset(); }} className="mt-2 w-full rounded-lg border bg-transparent px-3 py-2.5" /></label>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" disabled={pending || !token.trim()} className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50">{labels.githubTokenSave}</button>
        {credential.data?.credential.configured && <button type="button" disabled={pending} className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50" onClick={async () => { if (await confirmAction(labels.githubTokenRemoveConfirm)) remove.mutate(); }}>{labels.githubTokenRemove}</button>}
        <a href="https://github.com/settings/personal-access-tokens" target="_blank" rel="noreferrer" className="text-xs underline">{labels.githubTokenCreate}</a>
      </div>
    </form>
    {save.isSuccess && <p role="status" className="text-xs">{labels.githubTokenSaved}</p>}
    {error && <p role="alert" className="text-xs" style={{ color: "var(--cinnabar)" }}>{githubImportErrorMessage(error, labels)}</p>}
  </PaperCard>;
}
