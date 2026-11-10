import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowUpRight, Check, Github, KeyRound, LoaderCircle, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
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
  const [editing, setEditing] = useState(false);
  const save = useMutation({ mutationFn: () => saveAgentGitHubCredential(token), onSuccess: async (result) => {
    setToken("");
    setEditing(false);
    client.setQueryData(credentialKey, result);
    await client.invalidateQueries({ queryKey: credentialKey, exact: true });
  } });
  const remove = useMutation({ mutationFn: deleteAgentGitHubCredential, onSuccess: async () => {
    setToken("");
    setEditing(false);
    save.reset();
    client.setQueryData(credentialKey, { credential: { configured: false } });
    await client.invalidateQueries({ queryKey: credentialKey, exact: true });
  } });
  const pending = save.isPending || remove.isPending;
  const error = save.error ?? remove.error;
  const membershipError = error instanceof ApiError && error.code === "membership_required";
  const configured = credential.data?.credential.configured;
  const action = "inline-flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-semibold transition hover:bg-[var(--ink-wash)] disabled:cursor-not-allowed disabled:opacity-50";
  return <section className="koi-github-card" aria-labelledby="koi-github-title"><PaperCard className="p-5 sm:p-6">
    <header className="flex items-center gap-2.5">
      <Github aria-hidden className="h-4 w-4 shrink-0" />
      <h3 id="koi-github-title" className="text-sm font-semibold">{labels.githubTokenTitle}</h3>
    </header>
    <p className="mt-2 text-xs leading-5" style={{ color: "var(--ink-mid)" }}>{labels.githubTokenDescription}</p>
    {credential.isPending ? <p role="status" className="mt-4 flex items-center gap-2 text-xs" style={{ color: "var(--ink-mid)" }}><LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" />{labels.loading}</p> : credential.data && <div className="mt-4 flex flex-wrap items-center gap-2 rounded-lg px-3 py-2.5 text-xs" style={{ background: "var(--ink-wash)", color: "var(--ink-mid)" }}>
      {configured && <Check aria-hidden className="h-3.5 w-3.5" />}
      <span>{configured ? labels.githubTokenConfigured : labels.githubTokenNotConfigured}</span>
      {configured && <code className="ml-auto text-xs tracking-wider" style={{ color: "var(--ink-strong)" }}>••••{credential.data.credential.tokenHint}</code>}
    </div>}
    {credential.isError && <div role="alert" className="mt-4 flex items-center justify-between gap-3 text-xs" style={{ color: "var(--cinnabar)" }}>
      <p>{githubImportErrorMessage(credential.error, labels, labels.githubTokenLoadFailed)}</p>
      <button type="button" disabled={credential.isFetching || pending} onClick={() => void credential.refetch()} className="inline-flex shrink-0 items-center gap-1.5 rounded px-2 py-1 font-semibold disabled:opacity-50"><RefreshCw aria-hidden className={`h-3.5 w-3.5 ${credential.isFetching ? "animate-spin" : ""}`} />{labels.refresh}</button>
    </div>}
    {canSave && editing ? <form className="mt-4 space-y-3" onSubmit={(event) => { event.preventDefault(); if (!pending && token.trim()) { remove.reset(); save.mutate(); } }}>
      <label className="block text-xs font-medium">GitHub Token<input type="password" autoComplete="new-password" autoCapitalize="none" spellCheck={false} autoFocus maxLength={512} value={token} disabled={pending} onChange={(event) => { setToken(event.target.value); save.reset(); }} className="mt-2 w-full rounded-lg border bg-transparent px-3 py-2.5 font-mono text-sm outline-[var(--cinnabar)]" style={{ borderColor: "var(--ink-line)" }} /></label>
      <a href="https://github.com/settings/personal-access-tokens" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs underline underline-offset-4">{labels.githubTokenCreate}<ArrowUpRight aria-hidden className="h-3 w-3" /></a>
      <div className="flex flex-wrap gap-2">
        <button type="submit" disabled={pending || !token.trim()} aria-busy={save.isPending} className="inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50" style={{ background: "var(--cinnabar)" }}>{save.isPending && <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" />}{labels.githubTokenSave}</button>
        <button type="button" disabled={pending} className={action} style={{ borderColor: "var(--ink-line)" }} onClick={() => { setEditing(false); setToken(""); save.reset(); remove.reset(); }}>{t.llmChannels.cancel}</button>
      </div>
    </form> : canSave && credential.data && <div className="mt-4">
      <button type="button" disabled={pending} className={action} style={{ borderColor: "var(--ink-line)" }} onClick={() => { setEditing(true); save.reset(); remove.reset(); }}><KeyRound aria-hidden className="h-3.5 w-3.5" />{configured ? labels.githubTokenEdit : labels.githubTokenAdd}</button>
    </div>}
    {(!canSave || membershipError) && <p role={membershipError ? "alert" : undefined} className="mt-4 text-xs leading-5" style={{ color: "var(--ink-mid)" }}>{labels.githubTokenMembersOnly}{" "}<Link to="/pricing" className="underline underline-offset-4">{t.mcp.upgrade}</Link></p>}
    {configured && <button type="button" disabled={pending} className="mt-3 inline-flex items-center gap-1.5 rounded py-1 text-xs transition hover:opacity-70 disabled:opacity-50" style={{ color: "var(--cinnabar)" }} onClick={async () => { if (await confirmAction(labels.githubTokenRemoveConfirm)) { save.reset(); remove.mutate(); } }}>{remove.isPending ? <LoaderCircle aria-hidden className="h-3.5 w-3.5 animate-spin" /> : <Trash2 aria-hidden className="h-3.5 w-3.5" />}{labels.githubTokenRemove}</button>}
    {save.isSuccess && <p role="status" className="mt-3 flex items-center gap-1.5 text-xs"><Check aria-hidden className="h-3.5 w-3.5" />{labels.githubTokenSaved}</p>}
    {error && !membershipError && <p role="alert" className="mt-3 text-xs leading-5" style={{ color: "var(--cinnabar)" }}>{githubImportErrorMessage(error, labels, save.isError ? labels.githubTokenSaveFailed : labels.githubTokenRemoveFailed)}</p>}
    <p className="mt-5 flex items-start gap-2 border-t pt-4 text-xs leading-5" style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }}><ShieldCheck aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0" />{labels.githubTokenSecurity}</p>
  </PaperCard></section>;
}
