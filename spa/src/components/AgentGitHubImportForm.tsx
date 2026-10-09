import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { githubImportErrorMessage, importGitHubAgentRepository } from "../agentGitHubImport";
import { useI18n } from "../i18n";
import { PaperCard } from "./Ink";

export function AgentGitHubImportForm({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const labels = t.agentWorkspace;
  const client = useQueryClient();
  const navigate = useNavigate();
  const [repositoryURL, setRepositoryURL] = useState("");
  const [ref, setRef] = useState("");
  const request = useRef<{ input: string; id: string } | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const importRepository = useMutation({
    mutationFn: () => {
      const input = { repositoryUrl: repositoryURL.trim(), ref: ref.trim() || undefined };
      const serialized = JSON.stringify(input);
      if (request.current?.input !== serialized) request.current = { input: serialized, id: crypto.randomUUID() };
      return importGitHubAgentRepository({ ...input, requestId: request.current.id });
    },
    onSuccess: async ({ workspace }) => {
      await Promise.all([client.invalidateQueries({ queryKey: ["agent-workspaces"] }), client.invalidateQueries({ queryKey: ["agent-workspace-storage"] })]);
      if (mounted.current) await navigate({ to: "/agent/workspaces/$workspaceId", params: { workspaceId: String(workspace.workspaceId) }, search: { from: "space" } });
    },
  });
  return <PaperCard className="p-6">
    <h2 className="text-lg font-semibold">{labels.githubImport}</h2>
    <p className="mt-3 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{labels.githubImportDescription}</p>
    <form className="mt-5 space-y-5" onSubmit={(event) => { event.preventDefault(); if (!importRepository.isPending && repositoryURL.trim()) importRepository.mutate(); }}>
      <label className="block text-sm">{labels.githubRepositoryURL}<input required autoFocus type="url" maxLength={500} value={repositoryURL} disabled={importRepository.isPending} placeholder="https://github.com/owner/repository" onChange={(event) => { setRepositoryURL(event.target.value); importRepository.reset(); }} className="mt-2 w-full rounded-lg border bg-transparent px-3 py-2.5" /></label>
      <label className="block text-sm">{labels.githubRepositoryRef}<input maxLength={200} value={ref} disabled={importRepository.isPending} placeholder={labels.githubRefDefault} onChange={(event) => { setRef(event.target.value); importRepository.reset(); }} className="mt-2 w-full rounded-lg border bg-transparent px-3 py-2.5" /></label>
      <p className="text-xs leading-6" style={{ color: "var(--ink-mid)" }}>{labels.githubImportLimits}</p>
      <Link to="/space/settings" className="inline-block text-xs underline">{labels.githubTokenSettings}</Link>
      {importRepository.isError && <p role="alert" className="text-sm" style={{ color: "var(--cinnabar)" }}>{githubImportErrorMessage(importRepository.error, labels)}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" disabled={importRepository.isPending} onClick={onClose} className="rounded-lg border px-4 py-2 text-sm disabled:opacity-50">{t.llmChannels.cancel}</button>
        <button type="submit" disabled={importRepository.isPending || !repositoryURL.trim()} className="rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50" style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}>{importRepository.isPending ? labels.githubImporting : labels.githubImport}</button>
      </div>
    </form>
  </PaperCard>;
}
