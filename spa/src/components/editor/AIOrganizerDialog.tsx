import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Check, LoaderCircle, RotateCcw, X } from "lucide-react";
import { Logo } from "../Logo";
import {
  AGENT_CREDITS_QUERY_KEY, ApiError, applyDocumentOrganizationPreview,
  createDocumentOrganization, estimateDocumentOrganization, getDocumentOrganization,
  latestDocumentOrganization, undoDocumentOrganization,
  type DocumentOrganization, type OrganizationChoice,
} from "../../api";
import { confirmAction } from "../../confirmAction";
import { interpolate, useI18n } from "../../i18n";
import { pushModal } from "../../modalStack";
import { isDesktopRuntime } from "../../desktop/runtime";
import { organizationChoices, organizationDrafts, organizationPollInterval, type OrganizationDraft } from "./aiOrganizerCore";
import { organizationPreviewOrders } from "./aiOrganizerPreviewCore";
import { AIOrganizerPreview } from "./AIOrganizerPreview";

export function AIOrganizerDialog({ member, localMode, onPrepare, onClose }: {
  member: boolean; localMode: boolean; onPrepare: () => Promise<boolean>; onClose: () => void;
}) {
  const navigate = useNavigate();
  const { t } = useI18n(); const l = t.editor.aiOrganizer;
  const queryClient = useQueryClient();
  const enabled = member && !localMode;
  const [include, setInclude] = useState(false);
  const [selection, setSelection] = useState<DocumentOrganization | null>(null);
  const [prepared, setPrepared] = useState(false);
  const [prepareAttempt, setPrepareAttempt] = useState(0);
  const [excludedDocIDs, setExcludedDocIDs] = useState<string[]>([]);
  const [dismissedLatest, setDismissedLatest] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, OrganizationDraft>>({});
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [refreshWarning, setRefreshWarning] = useState(false);
  const [undoNotice, setUndoNotice] = useState<string[] | null>(null);
  const requestID = useRef<string | null>(null);
  const initializedID = useRef<string | null>(null);
  const busyRef = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const latest = useQuery({ queryKey: ["document-organization-latest"], queryFn: latestDocumentOrganization, enabled, staleTime: 0, retry: false });
  // Resume once after refreshing the latest entry. Later background refreshes
  // may update the undo target, but must not replace the preview being edited.
  const initialSelection = !dismissedLatest && latest.isFetchedAfterMount ? latest.data?.organization : null;
  const selected = selection ?? initialSelection;
  const selectedID = selected?.id;
  useEffect(() => {
    if (!selection && initialSelection) setSelection(initialSelection);
  }, [selection, initialSelection]);
  const query = useQuery({
    queryKey: ["document-organization", selectedID], queryFn: () => getDocumentOrganization(selectedID!), enabled: enabled && Boolean(selectedID),
    refetchInterval: state => organizationPollInterval(
      state.state.data?.organization.status,
      selected?.status,
      state.state.error instanceof ApiError ? state.state.error.status : undefined,
    ), retry: false,
  });
  const view = query.data?.organization ?? selected;
  const running = view?.status === "running";
  const ready = view?.status === "ready";
  const applied = view?.status === "applied";
  const undoSkippedTitles = undoNotice ?? (view?.status === "undone"
    ? view.data.items.filter(item => item.undoSkipped).map(item => item.title || t.editor.untitled) : []);
  const undoTarget = latest.data?.lastApplied;
  useEffect(() => {
    if (view && view.status !== "running") void queryClient.invalidateQueries({ queryKey: AGENT_CREDITS_QUERY_KEY });
  }, [view?.id, view?.status, queryClient]);

  function message(e: unknown): string {
    const code = e instanceof ApiError ? e.code : e instanceof Error ? e.message : "";
    if (code === "organization_conflict") return l.conflict;
    if (code === "organization_busy") return l.busyRetry;
    if (code === "organization_ambiguous_folder") return l.ambiguousFolder;
    if (code === "organization_no_active_documents") return l.noActiveDocuments;
    if (code === "organization_sync_conflict") return l.syncConflict;
    if (code === "organization_folder_sync_conflict") return l.folderSyncConflict;
    if (code === "invalid_organization") return l.invalid;
    if (code === "organization_estimate_changed") return l.changedEstimate;
    if (code === "document_save_failed") return l.saveFailed;
    if (code === "insufficient_credits") return l.insufficient;
    if (code === "membership_required") return l.member;
    if (code === "agent_llm_not_configured" || code === "llm_channel_not_found") return l.unavailable;
    return l.error;
  }
  async function prepare(docIds?: string[]): Promise<string[]> {
    if (!(await onPrepare())) throw new Error("document_save_failed");
    if (isDesktopRuntime()) {
      const { desktopPrepareLibraryForOrganization } = await import("../../desktop/offlineStore");
      const excluded = await desktopPrepareLibraryForOrganization(docIds);
      if (!docIds) setExcludedDocIDs(current => JSON.stringify(current) === JSON.stringify(excluded) ? current : excluded);
      return excluded;
    }
    return [];
  }
  const prepareRef = useRef(prepare); prepareRef.current = prepare;
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setPrepared(false);
    void prepareRef.current().then(() => { if (!cancelled) setPrepared(true); }).catch(e => { if (!cancelled) setError(message(e)); });
    return () => { cancelled = true; };
  }, [enabled, prepareAttempt]);
  const estimate = useQuery({
    queryKey: ["document-organization-estimate", include, prepareAttempt, excludedDocIDs], queryFn: () => estimateDocumentOrganization(include, excludedDocIDs),
    enabled: enabled && prepared && !running && !ready, retry: false, staleTime: 0,
  });
  useEffect(() => {
    if (!view || view.status !== "ready") return;
    if (initializedID.current === view.id) {
      // A permanently deleted document can disappear from this same preview.
      // Drop only that document; preserve edits to every remaining item.
      const remaining = new Set(view.data.items.map(item => item.docId));
      setDrafts(current => Object.keys(current).some(docId => !remaining.has(docId))
        ? Object.fromEntries(Object.entries(current).filter(([docId]) => remaining.has(docId))) : current);
      return;
    }
    initializedID.current = view.id; setDrafts(organizationDrafts(view.data.items)); setInclude(view.data.includeOrganized); setDirty(false);
  }, [view]);

  async function accept(next: DocumentOrganization, refresh: boolean, select = true) {
    if (select) setSelection(next);
    queryClient.setQueryData(["document-organization", next.id], { organization: next });
    await queryClient.invalidateQueries({ queryKey: ["document-organization-latest"] });
    void queryClient.invalidateQueries({ queryKey: AGENT_CREDITS_QUERY_KEY });
    if (!refresh) return;
    if (select) setDirty(false);
    setRefreshWarning(false);
    if (isDesktopRuntime()) {
      try {
        const { syncDesktopNow } = await import("../../desktop/offlineStore");
        const summary = await syncDesktopNow({ silent: true, force: true, pullOnly: true, strictPull: true });
        if (summary.state !== "idle") setRefreshWarning(true);
      } catch { setRefreshWarning(true); }
    }
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["documents"] }),
      queryClient.invalidateQueries({ queryKey: ["folders"] }),
      queryClient.invalidateQueries({ queryKey: ["document-organization-estimate"] }),
    ]);
  }
  const generate = useMutation({
    mutationFn: async () => {
      const excluded = await prepare();
      if (JSON.stringify(excluded) !== JSON.stringify(excludedDocIDs)) throw new ApiError(409, l.changedEstimate, "organization_estimate_changed");
      requestID.current ??= crypto.randomUUID();
      return createDocumentOrganization(requestID.current, include, estimate.data!, excluded);
    },
    onSuccess: async result => { requestID.current = null; initializedID.current = null; setError(""); setUndoNotice(null); await accept(result.organization, false); },
    onError: e => {
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408) requestID.current = null;
      setError(message(e)); void estimate.refetch();
    },
  });
  const apply = useMutation({
    mutationFn: async () => {
      const choices = organizationChoices(drafts, view!.data.folders);
      await prepare(choices.map(item => item.docId));
      return applyDocumentOrganizationPreview(view!.id, choices, organizationPreviewOrders(view!.data.items, view!.data.folders, drafts));
    },
    onSuccess: result => { setUndoNotice(null); return accept(result.organization, true); }, onError: e => setError(message(e)),
  });
  const undo = useMutation({
    mutationFn: async (organizationId: string) => {
      const { organization } = await getDocumentOrganization(organizationId);
      await prepare(organization.data.items.filter(item => item.appliedVersion != null).map(item => item.docId));
      return undoDocumentOrganization(organizationId);
    },
    onSuccess: (result, organizationId) => {
      setUndoNotice(result.organization.data.items.filter(item => item.undoSkipped).map(item => item.title || t.editor.untitled));
      return accept(result.organization, true, selectedID === organizationId);
    }, onError: e => {
      setError(message(e));
      void queryClient.invalidateQueries({ queryKey: ["document-organization-latest"] });
    },
  });
  const busy = generate.isPending || apply.isPending || undo.isPending; busyRef.current = busy;
  const close = async () => {
    if (busyRef.current) return;
    if (dirty && !(await confirmAction(`${l.discard}\n\n${l.discardDetail}`))) return;
    onClose();
  };
  const closeRef = useRef(close); closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const release = pushModal(); panelRef.current?.focus();
    const keydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); void closeRef.current(); }
      if (e.key === "Tab") {
        const focusable = Array.from(panelRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]') ?? []);
        const first = focusable[0], last = focusable.at(-1);
        if (e.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener("keydown", keydown);
    return () => { window.removeEventListener("keydown", keydown); release(); previous?.focus(); };
  }, []);

  const parsed = useMemo(() => {
    if (!view) return { choices: [] as OrganizationChoice[], invalid: false, validationMessage: "" };
    try { return { choices: organizationChoices(drafts, view.data.folders), invalid: false, validationMessage: "" }; }
    catch (e) { return { choices: [] as OrganizationChoice[], invalid: true, validationMessage: e instanceof Error && e.message === "organization_ambiguous_folder" ? l.ambiguousFolder : l.invalid }; }
  }, [drafts, view, l.ambiguousFolder, l.invalid]);
  const loading = latest.isLoading || (!selection && !dismissedLatest && !latest.isFetchedAfterMount) || (Boolean(selectedID) && query.isLoading);
  const providerFailures = [...new Set(view?.data.items.filter(item => item.needsReview && item.failureStatus).map(item => item.failureStatus!) ?? [])];
  function providerFailureMessage(status: number) {
    return interpolate(status === 429 ? l.providerRateLimited : [400, 413, 422].includes(status) ? l.providerRejected : l.providerUnavailable, { status });
  }
  async function newRun() {
    if (dirty && !(await confirmAction(`${l.discard}\n\n${l.discardDetail}`))) return;
    setDismissedLatest(true); setSelection(null); setDrafts({}); setDirty(false); setError(""); setUndoNotice(null); setInclude(false); requestID.current = null; initializedID.current = null; setPrepareAttempt(n => n + 1);
  }
  return <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/35 p-3 backdrop-blur-sm sm:p-6" onMouseDown={e => { if (e.target === e.currentTarget) void close(); }}>
    <div ref={panelRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="ai-organizer-title" className="flex max-h-[92dvh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-black/10 bg-[#faf9f6] shadow-2xl outline-none dark:border-white/10 dark:bg-neutral-950">
      <header className="flex items-start justify-between gap-4 border-b border-black/5 px-5 py-4 dark:border-white/10">
        <div><h2 id="ai-organizer-title" className="flex items-center gap-2 text-lg font-semibold"><Logo className="h-6 w-6" />{l.title}</h2><p className="mt-1 max-w-2xl text-sm text-neutral-500 dark:text-neutral-400">{l.description}</p></div>
        <button type="button" aria-label={l.close} disabled={busy} onClick={() => void close()} className="rounded-lg p-2 hover:bg-black/5 disabled:opacity-40 dark:hover:bg-white/10"><X className="h-5 w-5" /></button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
        {!enabled ? <p className="py-8 text-center text-sm">{l.member}</p> : <>
          {(error || latest.isError || query.isError) && <p role="alert" className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/30 dark:text-red-300">{error || l.error}</p>}
          {(latest.isError || query.isError) && <button type="button" disabled={busy || latest.isFetching || query.isFetching} onClick={() => { void latest.refetch(); if (selectedID) void query.refetch(); }} className="mb-4 text-sm underline disabled:opacity-50">{l.retry}</button>}
          {refreshWarning && <p role="status" className="mb-4 text-sm text-amber-700 dark:text-amber-300">{l.refreshFailed}</p>}
          {excludedDocIDs.length > 0 && <p role="status" className="mb-4 text-sm text-amber-700 dark:text-amber-300">{interpolate(l.excludedConflicts, { count: excludedDocIDs.length })}</p>}
          {view?.data.items.some(item => item.applySkipped) && <p role="status" className="mb-4 text-sm text-amber-700 dark:text-amber-300">{interpolate(l.skippedTrash, { titles: view.data.items.filter(item => item.applySkipped).map(item => item.title || t.editor.untitled).join("、") })}</p>}
          {undoSkippedTitles.length > 0 && <p role="status" className="mb-4 text-sm text-amber-700 dark:text-amber-300">{interpolate(l.undoSkipped, { titles: undoSkippedTitles.join("、") })}</p>}
          {loading ? <p className="flex items-center gap-2 py-8 text-sm"><LoaderCircle className="h-4 w-4 animate-spin" />{l.preparing}</p> : running ? <div className="rounded-xl border border-black/5 bg-white p-8 dark:border-white/10 dark:bg-neutral-900"><p role="status" className="flex items-center gap-2"><LoaderCircle className="h-5 w-5 animate-spin text-cinnabar-500" />{interpolate(l.progress, { done: view.data.completed, total: view.data.items.length })}</p><progress aria-label={l.title} max={view.data.items.length || 1} value={view.data.completed} className="mt-5 h-2 w-full accent-cinnabar-500" /></div> : <>
            {view?.status === "failed" && <p role="alert" className="mb-4 text-sm text-red-600 dark:text-red-400">{view.errorCode === "insufficient_credits" ? l.insufficient : l.failed}</p>}
            {undoSkippedTitles.length === 0 && (applied || view?.status === "undone" || undoNotice) && <div className="mb-4 flex items-center gap-3 rounded-xl bg-emerald-50 p-4 text-sm text-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-200"><Check className="h-5 w-5 shrink-0" />{undoNotice || view?.status === "undone" ? l.undone : l.applied}</div>}
            {!ready && <div className="rounded-xl border border-black/5 bg-white p-5 dark:border-white/10 dark:bg-neutral-900">
              <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={include} disabled={busy} onChange={e => { setInclude(e.target.checked); requestID.current = null; }} className="accent-cinnabar-500" />{l.include}</label>
              <p className="ml-6 mt-1 text-xs leading-relaxed text-neutral-500">{l.includeHint}</p>
              <div className="mt-5 border-t border-black/5 pt-4 text-sm dark:border-white/10">
                {!prepared || estimate.isFetching ? <p>{l.preparing}</p> : estimate.data ? <><p>{interpolate(l.estimate, estimate.data)}</p><p className="mt-2 text-xs text-neutral-500">{estimate.data.providerMode === "builtin" ? interpolate(l.credits, { count: estimate.data.reservedCredits }) : l.byok}</p>{estimate.data.count === 0 && <p className="mt-4 text-neutral-500">{l.empty}</p>}</> : <p role="alert">{l.error}</p>}
                {(!prepared || estimate.isError) && <button type="button" disabled={busy} onClick={() => { setError(""); setPrepareAttempt(n => n + 1); }} className="mt-3 underline">{l.newRun}</button>}
              </div>
            </div>}
            {ready && view.data.items.length === 0 && <p className="py-8 text-center text-sm text-neutral-500">{l.empty}</p>}
            {ready && view.data.items.length > 0 && <>
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-500"><span>{interpolate(l.estimate, { count: view.data.items.length, skipped: view.data.skipped })}</span><span>{interpolate(l.charged, { count: view.creditsCharged })}</span></div>
              {view.data.stopReason && <p role="status" className="mb-3 rounded-lg bg-amber-50 p-3 text-sm leading-relaxed text-amber-800 dark:bg-amber-950/30 dark:text-amber-200">{interpolate(view.data.stopReason === "timeout" ? l.partialTimeout : view.data.stopReason === "failure_ratio" ? l.partialFailureRatio : l.partialFailureLimit, { done: view.data.completed, total: view.data.items.length })}</p>}
              {providerFailures.map(status => <p key={status} role="status" className="mb-3 text-sm leading-relaxed text-amber-800 dark:text-amber-200">{providerFailureMessage(status)}</p>)}
              {(view.data.unbilledBatches ?? 0) > 0 && <p role="status" className="mb-3 text-sm text-neutral-500">{interpolate(view.data.providerMode === "builtin" ? l.unbilledBatches : l.invalidBatchesByok, { count: view.data.unbilledBatches! })}</p>}
              {parsed.invalid && <p role="alert" className="mb-3 text-sm text-red-600 dark:text-red-400">{parsed.validationMessage}</p>}
              <AIOrganizerPreview key={view.id} data={view.data} drafts={drafts} busy={busy} onChange={update => { setDrafts(update); setDirty(true); }} />
            </>}
          </>}
        </>}
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-black/5 px-5 py-4 dark:border-white/10">
        <Link to="/settings" className="text-xs text-neutral-500 underline" onClick={async e => {
          e.preventDefault(); if (busy) return;
          if (dirty && !(await confirmAction(`${l.discard}\n\n${l.discardDetail}`))) return;
          onClose(); void navigate({ to: "/settings" });
        }}>{l.settings}</Link>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {undoTarget && <button type="button" disabled={busy || running} title={new Date(undoTarget.appliedAt).toLocaleString()} onClick={() => { setError(""); undo.mutate(undoTarget.id); }} className="flex items-center gap-1 rounded-lg border border-black/10 px-3 py-2 text-sm disabled:opacity-50 dark:border-white/15"><RotateCcw className="h-4 w-4" />{undoTarget.id === view?.id ? l.undo : l.undoPrevious}</button>}
          {ready && <button type="button" disabled={busy} onClick={() => void newRun()} className="rounded-lg px-3 py-2 text-sm text-neutral-500">{l.newRun}</button>}
          {enabled && !loading && !running && (ready ? <button type="button" disabled={busy || parsed.invalid || !parsed.choices.length} onClick={() => { setError(""); apply.mutate(); }} className="rounded-lg bg-cinnabar-600 px-4 py-2 text-sm font-medium text-white hover:bg-cinnabar-700 disabled:opacity-50">{busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : interpolate(l.apply, { count: parsed.choices.length })}</button> : <button type="button" disabled={busy || !prepared || !estimate.data?.count || estimate.isFetching || estimate.isError} onClick={() => { setError(""); generate.mutate(); }} className="flex items-center gap-2 rounded-lg bg-cinnabar-600 px-4 py-2 text-sm font-medium text-white hover:bg-cinnabar-700 disabled:opacity-50">{busy && <LoaderCircle className="h-4 w-4 animate-spin" />}{l.generate}</button>)}
        </div>
      </footer>
    </div>
  </div>;
}
