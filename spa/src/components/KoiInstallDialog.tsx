import { ChevronDown, FolderUp, Github, LoaderCircle, X } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../api";
import { useI18n } from "../i18n";
import { koiFolderEntries, koiFolderPackages, koiSelectedFolderEntries, type KoiFolderEntry } from "../koiSkillFolder";
import { analyzeKoiImport, cancelKoiImport, confirmKoiImport, createKoiImport, getKoiImport, getKoiOverview, KOI_SETTINGS_QUERY_KEY, koiErrorMessage, koiPreviewErrorLabel, koiRejectionLabel, uploadKoiImportFile, type KoiPreview, type KoiSkill, type KoiHubTarget, type KoiGitHubTarget, type KoiImportInput, type KoiImportConfirmation, type KoiOverview } from "../koiSkills";
import { pushModal } from "../modalStack";
import { formatBytes } from "../storage";
import { KoiPending, KoiRetry, KoiSkillCompatibilityNote, useKoiSkillStorageInvalidation } from "./KoiSkillUi";
import { KoiLegacyBanner } from "./KoiLegacyBanner";

export function KoiInstallDialog({ authUserId, onClose, updateTarget, resumePreview, hubTarget, githubTarget, initialSource = "folder", migration = false }: { authUserId: string; onClose: () => void; updateTarget?: KoiSkill; resumePreview?: KoiPreview; hubTarget?: KoiHubTarget; githubTarget?: KoiGitHubTarget; initialSource?: "folder" | "github"; migration?: boolean }) {
  const { t, locale } = useI18n();
  const labels = t.koi;
  const client = useQueryClient();
  const overviewKey = [KOI_SETTINGS_QUERY_KEY, authUserId];
  const overview = useQuery({ queryKey: overviewKey, queryFn: getKoiOverview, retry: false });
  const canInstall = overview.isSuccess && overview.data.managementAvailable && overview.data.canInstall;
  const [migrating, setMigrating] = useState(migration);
  const migrationOnly = useRef(migration).current;
  const legacy = overview.data?.settings.libraryMode === "legacy";
  const [entries, setEntries] = useState<KoiFolderEntry[]>([]);
  const [folderName, setFolderName] = useState("");
  const [directories, setDirectories] = useState<string[]>([]);
  const packages = useMemo(() => koiFolderPackages(entries), [entries]);
  const uploadEntries = koiSelectedFolderEntries(packages, directories);
  const [source, setSource] = useState<"folder" | "github">(updateTarget ? "folder" : resumePreview ? resumePreview.sourceKind === "github" ? "github" : "folder" : githubTarget ? "github" : initialSource);
  const [githubUrl, setGithubUrl] = useState(githubTarget?.repositoryUrl ?? "");
  const [githubRef, setGithubRef] = useState(githubTarget?.ref ?? "");
  const [githubPath, setGithubPath] = useState("");
  const [preview, setPreview] = useState<KoiPreview | null>(resumePreview ?? null);
  const replacing = Boolean(updateTarget || preview?.source.updateFromId || preview?.candidates.some((item) => item.installedStatus === "update"));
  const [selected, setSelected] = useState<string[]>(resumePreview?.candidates.filter((item) => item.installedStatus !== "installed").map((item) => item.id) ?? []);
  const [enable, setEnable] = useState(true);
  const [busy, setBusy] = useState("");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [confirmationPending, setConfirmationPending] = useState(false);
  const [confirmationSlow, setConfirmationSlow] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const previewRef = useRef(preview);
  const closed = useRef(false);
  const confirming = useRef(false);
  const confirmationInput = useRef<KoiImportConfirmation | null>(null);
  const createRequest = useRef<{ key: string; id: string } | null>(null);
  const autoStarted = useRef(false);
  const remoteAbort = useRef<AbortController | null>(null);
  const create = (input: Omit<KoiImportInput, "requestId">, signal?: AbortSignal) => {
    const key = JSON.stringify(input);
    if (createRequest.current?.key !== key) createRequest.current = { key, id: crypto.randomUUID() };
    return createKoiImport({ ...input, requestId: createRequest.current.id }, signal);
  };
  const invalidate = useKoiSkillStorageInvalidation(authUserId);

  useEffect(() => pushModal(), []);
  useEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
      queueMicrotask(() => {
        if (closed.current) remoteAbort.current?.abort();
        if (closed.current && !confirmationInput.current && previewRef.current) void cancelKoiImport(previewRef.current.id).catch(() => undefined);
      });
    };
  }, []);

  const cancel = () => {
    closed.current = true;
    remoteAbort.current?.abort();
    onClose();
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.stopPropagation(); cancel(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const acceptPreview = (next: KoiPreview) => {
    if (closed.current) { void cancelKoiImport(next.id).catch(() => undefined); return false; }
    previewRef.current = next;
    setPreview(next);
    return true;
  };
  const restart = () => {
    if (previewRef.current) void cancelKoiImport(previewRef.current.id).catch(() => undefined);
    previewRef.current = null;
    setPreview(null);
    setSelected([]);
    setError("");
    setConfirmationPending(false);
    confirmationInput.current = null;
    createRequest.current = null;
  };

  const upload = async () => {
    setError("");
    setBusy("upload");
    setProgress(0);
    try {
      // A retry reuses the same declared paths and uploaded members. Only local
      // package selection happens before bytes leave the device.
      let current = previewRef.current;
      if (!current) {
        current = (await create({ source: "folder", directoryName: folderName, declaredPaths: uploadEntries.map((entry) => entry.path), updateFromId: updateTarget?.id, expectedRevision: updateTarget?.revision })).preview;
        if (!acceptPreview(current)) return;
      }
      for (const [index, entry] of uploadEntries.entries()) {
        if (closed.current) return;
        const contentBase64 = await fileToBase64(entry.file);
        if (closed.current) return;
        try {
          await uploadKoiImportFile(current.id, entry.path, contentBase64);
        } catch (caught) {
          // These errors store a rejection receipt on the server. Continue so
          // a rejected package cannot block its valid siblings from analysis.
          if (!(caught instanceof ApiError) || !["file_too_large", "sensitive_data_detected"].includes(caught.code ?? "")) throw caught;
        }
        if (closed.current) return;
        setProgress(index + 1);
      }
      if (closed.current) return;
      setBusy("analyze");
      const ready = (await analyzeKoiImport(current.id)).preview;
      if (acceptPreview(ready)) setSelected(ready.candidates.filter((candidate) => candidate.installedStatus !== "installed").map((candidate) => candidate.id));
    } catch (caught) {
      if (!closed.current) {
        if (previewRef.current) {
          try { acceptPreview((await getKoiImport(previewRef.current.id)).preview); } catch { /* A later retry can recover the preview. */ }
        }
        setError(koiErrorMessage(caught, labels, labels.koiAnalysisFailed));
      }
    } finally {
      if (!closed.current) setBusy("");
    }
  };

  const loadRemote = async (fromMigration = false) => {
    setError(""); setBusy("analyze");
    const controller = new AbortController();
    remoteAbort.current = controller;
    const migrationRequest = migrating || fromMigration;
    const timeout = migrationRequest ? setTimeout(() => controller.abort(), 65_000) : undefined;
    try {
      // Hub targets include display data; send only the published snapshot's
      // protocol fields to the strict import API.
      const input: Omit<KoiImportInput, "requestId"> = migrationRequest ? { source: "migration" } : hubTarget
        ? { source: "hub", workspaceId: hubTarget.workspaceId, publicationId: hubTarget.publicationId, revision: hubTarget.revision }
        : { source: "github", repositoryUrl: githubUrl.trim(), ref: githubRef.trim(), path: githubPath.trim() };
      const ready = (await create(input, controller.signal)).preview;
      if (acceptPreview(ready)) setSelected(ready.candidates.filter((item) => item.installedStatus !== "installed").map((item) => item.id));
    } catch (caught) { if (!closed.current) setError(controller.signal.aborted && migrationRequest ? labels.legacyTimeout : koiErrorMessage(caught, labels)); }
    finally {
      clearTimeout(timeout);
      if (remoteAbort.current === controller) remoteAbort.current = null;
      if (!closed.current) setBusy("");
    }
  };
  useEffect(() => {
    if ((migration || (hubTarget || githubTarget) && !legacy && !migrating) && canInstall && !resumePreview && !autoStarted.current) { autoStarted.current = true; void loadRemote(); }
  }, [canInstall, legacy, migrating]);

  const complete = async () => {
    previewRef.current = null;
    confirmationInput.current = null;
    if (!closed.current) setConfirmationPending(false);
    if (migrating) client.setQueryData<KoiOverview>(overviewKey, (current) => current ? { ...current, settings: { ...current.settings, libraryMode: "installed" }, legacySkillCount: 0 } : current);
    // A successful install must not wait on unrelated settings/storage refetches.
    void invalidate().catch(() => undefined);
    if (migrating && !migrationOnly) {
      if (!closed.current) { setMigrating(false); restart(); autoStarted.current = false; }
      return;
    }
    if (!closed.current) onClose();
  };
  const submit = async () => {
    if (!preview || selected.length === 0 || confirming.current) return;
    confirming.current = true;
    setBusy("confirm");
    setError("");
    setConfirmationSlow(false);
    const slowTimer = setTimeout(() => { if (!closed.current) setConfirmationSlow(true); }, 10_000);
    try {
      if (confirmationPending) {
        const latest = (await getKoiImport(preview.id)).preview;
        if (latest.status === "committed") { await complete(); return; }
        if (closed.current) return;
        acceptPreview(latest);
        if (latest.status !== "ready") {
          confirmationInput.current = null;
          setConfirmationPending(false);
          setError(koiPreviewErrorLabel(latest, labels));
          return;
        }
      }
      // One preview owns one confirmation, including retries after reopening.
      const input = confirmationInput.current ?? { requestId: preview.id, previewRevision: preview.revision, candidateIds: [...selected], enable };
      confirmationInput.current = input;
      await confirmKoiImport(preview.id, input);
      await complete();
    } catch (caught) {
      // A lost response may follow a committed installation. Read its receipt
      // before offering another confirmation.
      try {
        const latest = (await getKoiImport(preview.id)).preview;
        if (latest.status === "committed") { await complete(); return; }
        if (closed.current) { void invalidate().catch(() => undefined); return; }
        acceptPreview(latest);
        if (latest.status !== "ready") {
          confirmationInput.current = null;
          setConfirmationPending(false);
          setError(caught instanceof ApiError ? koiErrorMessage(caught, labels) : koiPreviewErrorLabel(latest, labels));
          return;
        }
        if (caught instanceof ApiError && caught.status >= 400 && caught.status < 500) {
          confirmationInput.current = null;
          setConfirmationPending(false);
          setError(koiErrorMessage(caught, labels));
          return;
        }
      } catch { /* Keep the preview and stable confirmation ID for retry. */ }
      if (!closed.current) { setConfirmationPending(true); setError(labels.installResultUnknown); }
      void invalidate().catch(() => undefined);
    } finally {
      clearTimeout(slowTimer);
      confirming.current = false;
      if (!closed.current) { setBusy(""); setConfirmationSlow(false); }
    }
  };
  const checkConfirmation = async () => {
    if (!preview || confirming.current) return;
    confirming.current = true;
    setBusy("check");
    try {
      const latest = (await getKoiImport(preview.id)).preview;
      if (latest.status === "committed") { await complete(); return; }
      if (!closed.current) {
        acceptPreview(latest);
        if (latest.status === "ready") setError(labels.installResultUnknown);
        else {
          confirmationInput.current = null;
          setConfirmationPending(false);
          setError(koiPreviewErrorLabel(latest, labels));
        }
      }
    } catch { if (!closed.current) setError(labels.installResultUnknown); }
    finally { confirming.current = false; if (!closed.current) setBusy(""); }
  };
  const pending = preview?.status === "pending" || preview?.status === "analyzing";
  const oversized = uploadEntries.some((entry) => entry.file.size > 128 * 1024);
  const tooMany = uploadEntries.length > 512 || uploadEntries.reduce((sum, entry) => sum + entry.file.size, 0) > 8 * 1024 * 1024;

  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/45 backdrop-blur-[2px] sm:items-center sm:p-5" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) cancel(); }}>
    <div role="dialog" aria-modal="true" aria-labelledby="koi-install-title" className="flex max-h-[90dvh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl border shadow-2xl sm:rounded-2xl" style={{ borderColor: "var(--ink-line)", background: "var(--ink-paper)" }}>
      <header className="flex shrink-0 items-start justify-between gap-4 border-b px-5 py-4 sm:px-6" style={{ borderColor: "var(--ink-line)", background: "var(--ink-paper-soft)" }}>
        <div className="min-w-0"><h2 id="koi-install-title" className="kn-heading-cn text-xl font-semibold">{migrating ? labels.legacyTitle : updateTarget ? `${labels.uploadNewVersion} · ${updateTarget.name}` : replacing ? labels.updateTitle : labels.installSkill}</h2><p className="mt-1 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{migrating ? labels.legacyPreviewDescription : hubTarget ? hubTarget.name : githubTarget ? githubTarget.name : preview?.sourceKind === "hub" ? String(preview.source.name ?? "") : source === "github" ? labels.githubUrlHint : labels.folderDescription}</p></div>
        <button type="button" autoFocus onClick={cancel} aria-label={labels.close} className="shrink-0 rounded-lg p-2 transition hover:bg-[var(--ink-wash-strong)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--cinnabar)]"><X className="h-5 w-5" /></button>
      </header>
      <div className="min-h-0 space-y-5 overflow-y-auto p-4 sm:p-6">
        {!preview && overview.isPending && <KoiPending label={labels.loading} />}
        {!preview && overview.isError && <KoiRetry label={labels.loadFailed} action={labels.retry} busy={overview.isFetching} onRetry={() => void overview.refetch()} />}
        {!preview && overview.isSuccess && !canInstall && <p role="alert" className="text-sm">{overview.data.managementAvailable ? labels.koiMembersOnly : labels.koiUnavailable}</p>}
        {canInstall && legacy && (!preview || migrating && preview.status === "failed") && !busy && <KoiLegacyBanner settings={overview.data.settings} count={overview.data.legacySkillCount} onReview={() => { autoStarted.current = true; setMigrating(true); void loadRemote(true); }} onChanged={async () => { await client.invalidateQueries({ queryKey: overviewKey, exact: true }); if (migration && client.getQueryData<typeof overview.data>(overviewKey)?.settings.libraryMode === "installed") cancel(); }} />}
        {!preview && !hubTarget && (!githubTarget || !busy) && !migrating && !legacy && canInstall && <>
          {!updateTarget && !githubTarget && <div className="flex flex-wrap items-center gap-3">
            <div role="tablist" aria-label={labels.installSource} className="inline-flex rounded-lg border p-1" style={{ borderColor: "var(--ink-line)", background: "var(--ink-wash)" }}>
              <button type="button" role="tab" aria-selected={source === "folder"} disabled={Boolean(busy)} onClick={() => { setSource("folder"); setError(""); }} className="rounded-md px-3 py-2 text-sm transition aria-selected:font-semibold aria-selected:shadow-sm disabled:opacity-50" style={source === "folder" ? { background: "var(--ink-paper-soft)" } : undefined}>{labels.sourceFolder}</button>
              <button type="button" role="tab" aria-selected={source === "github"} disabled={Boolean(busy)} onClick={() => { setSource("github"); setError(""); }} className="rounded-md px-3 py-2 text-sm transition aria-selected:font-semibold aria-selected:shadow-sm disabled:opacity-50" style={source === "github" ? { background: "var(--ink-paper-soft)" } : undefined}>{labels.sourceGithub}</button>
            </div>
            <a href="/repositories" className="px-1 py-2 text-sm underline underline-offset-4" style={{ color: "var(--ink-mid)" }}>{labels.hubBrowse}</a>
          </div>}
          {source === "github" ? <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void loadRemote(); }}>
            <label className="block text-sm">{labels.githubUrlLabel}<input type="url" required value={githubUrl} disabled={Boolean(busy) || Boolean(githubTarget)} onChange={(event) => setGithubUrl(event.target.value)} placeholder="https://github.com/owner/repo" className="mt-1 w-full rounded-lg border bg-transparent px-3 py-2" /></label>
            <details><summary className="cursor-pointer text-xs underline">{labels.githubAdvanced}</summary><div className="mt-2 grid gap-3 sm:grid-cols-2">
              <label className="text-xs">{labels.githubRefLabel}<input value={githubRef} disabled={Boolean(busy)} onChange={(event) => setGithubRef(event.target.value)} className="mt-1 w-full rounded-lg border bg-transparent px-3 py-2" /></label>
              <label className="text-xs">{labels.githubPathLabel}<input value={githubPath} disabled={Boolean(busy)} onChange={(event) => setGithubPath(event.target.value)} className="mt-1 w-full rounded-lg border bg-transparent px-3 py-2" /></label>
            </div></details>
            <p className="text-xs leading-5" style={{ color: "var(--ink-mid)" }}>{labels.githubPrivateHint} <a href="/space?tab=koi&section=settings" className="underline">{labels.githubCredentials}</a></p>
            <button type="submit" disabled={Boolean(busy) || !githubUrl.trim()} className="inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" style={{ background: "var(--cinnabar)" }}><Github className="h-4 w-4" />{labels.analyzeSource}</button>
          </form> : <>

          <input ref={fileInput} type="file" multiple hidden {...({ webkitdirectory: "", directory: "" } as Record<string, string>)} onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            if (files.length === 0) return;
            try {
              const next = koiFolderEntries(files);
              setEntries(next);
              setFolderName((files[0]?.webkitRelativePath || "").split("/")[0] || "");
              const found = koiFolderPackages(next);
              setDirectories(found.slice(0, updateTarget ? 1 : undefined).map((item) => item.directory));
              setError(next.length === 0 ? labels.folderEmpty : found.length === 0 ? labels.koiNoSkills : "");
            } catch { setEntries([]); setDirectories([]); setError(labels.koiSkillInvalid); }
          }} />
          <button type="button" disabled={Boolean(busy)} onClick={() => fileInput.current?.click()} className="inline-flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-semibold transition hover:bg-[var(--ink-wash)] disabled:opacity-50" style={{ borderColor: "var(--ink-line)" }}><FolderUp className="h-4 w-4" />{entries.length ? labels.rechoose : labels.folderChoose}</button>
          {packages.length > 0 && <fieldset disabled={Boolean(busy)} className="space-y-2 rounded-lg border p-4 disabled:opacity-60" style={{ borderColor: "var(--ink-line)", background: "var(--ink-paper-soft)" }}>
            <legend className="px-1 text-sm font-semibold">{labels.folderSelectSkills}</legend>
            {packages.map((item) => <label key={item.directory} className="flex items-start gap-2.5 text-sm">
              <input type={updateTarget ? "radio" : "checkbox"} name="folder-package" className="mt-1 accent-[var(--cinnabar)]" checked={directories.includes(item.directory)} onChange={() => setDirectories((current) => updateTarget ? [item.directory] : current.includes(item.directory) ? current.filter((path) => path !== item.directory) : [...current, item.directory])} />
              <span className="break-all">{item.directory || folderName || "SKILL.md"}<span className="ml-2 text-xs" style={{ color: "var(--ink-mid)" }}>{labels.fileCount.replace("{count}", String(item.entries.length))} · {formatBytes(item.entries.reduce((sum, entry) => sum + entry.file.size, 0), locale)}</span></span>
            </label>)}
          </fieldset>}
          {oversized && <p role="alert" className="text-xs" style={{ color: "var(--cinnabar)" }}>{labels.fileTooLarge}</p>}
          {tooMany && <p role="alert" className="text-xs" style={{ color: "var(--cinnabar)" }}>{labels.folderImportLimit}</p>}
          {packages.length > 0 && <button type="button" disabled={Boolean(busy) || uploadEntries.length === 0 || oversized || tooMany} onClick={() => void upload()} className="rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition hover:brightness-95 disabled:opacity-50" style={{ background: "var(--cinnabar)" }}>{labels.uploadAndAnalyze}</button>}
          <p className="text-xs leading-5" style={{ color: "var(--ink-mid)" }}>{labels.folderCloudNotice}</p>
          </>}
        </>}
        {!preview && hubTarget && !legacy && !busy && canInstall && <button type="button" onClick={() => void loadRemote()} className="text-sm underline">{labels.retry}</button>}
        {busy && <KoiPending label={busy === "upload" ? `${labels.uploading} ${progress}/${uploadEntries.length}` : busy === "analyze" ? migrating ? labels.legacyAnalyzing.replace("{count}", String(overview.data?.legacySkillCount ?? 0)) : labels.analyzing : busy === "check" ? labels.checkingInstallResult : confirmationSlow ? labels.installingSlow : labels.installing} />}
        {preview?.status === "ready" && <>
          <h3 className="text-base font-semibold">{labels.previewTitle}</h3>
          {preview.candidates.length > 1 && <p className="text-xs leading-5" style={{ color: "var(--ink-mid)" }}>{labels.previewMultiHint}</p>}
          {preview.source.reviewedSubset === true && <p className="text-xs leading-5" style={{ color: "var(--ink-mid)" }}>{labels.reviewedSubsetHint}</p>}
          {migrating && <p className="text-xs leading-5" style={{ color: "var(--ink-mid)" }}>{labels.legacyStorage.replace("{size}", formatBytes(preview.candidates.filter((item) => selected.includes(item.id)).reduce((total, item) => total + item.sizeBytes, 0), locale))}</p>}
          <p className="truncate text-xs" style={{ color: "var(--ink-faint)" }} title={preview.sourceKind === "github" ? `${preview.source.repositoryUrl} · ${preview.source.ref} · ${preview.source.commitSha}` : preview.sourceKind === "hub" ? `${preview.source.name} · ${preview.source.revision}` : folderName}>{preview.sourceKind === "github" ? `${preview.source.repositoryUrl} · ${preview.source.ref} · ${preview.source.commitSha}` : preview.sourceKind === "hub" ? `${preview.source.name} · ${preview.source.revision}` : folderName}</p>
          <ul className="space-y-3">{preview.candidates.map((candidate) => <li key={candidate.id} className="rounded-lg border p-4 sm:p-5" style={{ borderColor: "var(--ink-line)", background: "var(--ink-paper-soft)" }}>
            {migrating && <p className="mb-3 break-all text-xs" style={{ color: "var(--ink-faint)" }}>{migrationSourceLabel(preview, candidate.id)}</p>}
            <label className="flex cursor-pointer items-start gap-3"><input type={updateTarget ? "radio" : "checkbox"} name="preview-candidate" checked={selected.includes(candidate.id)} disabled={Boolean(busy) || confirmationPending} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--cinnabar)]" onChange={() => setSelected((current) => updateTarget ? [candidate.id] : current.includes(candidate.id) ? current.filter((id) => id !== candidate.id) : [...current, candidate.id])} />
              <span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold"><span>{candidate.name}</span>{candidate.installedStatus && <span className="rounded px-1.5 py-0.5 text-xs font-medium" style={{ background: candidate.installedStatus === "update" ? "var(--cinnabar-soft)" : "var(--ink-wash-strong)", color: candidate.installedStatus === "update" ? "var(--cinnabar)" : "var(--ink-mid)" }}>{candidate.installedStatus === "update" ? labels.updateAvailable : labels.alreadyInstalled}</span>}</span><span className="mt-1.5 block text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{candidate.description}</span><span className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs" style={{ color: "var(--ink-faint)" }}><span className="break-all">{[candidate.directory, candidate.entryPath].filter(Boolean).join("/")}</span><span aria-hidden="true">·</span><span>{formatBytes(candidate.sizeBytes, locale)}</span><span aria-hidden="true">·</span><span>{labels.fileCount.replace("{count}", String(candidate.fileCount))}</span><span className="rounded px-1.5 py-0.5" style={{ background: "var(--ink-wash)", color: "var(--ink-mid)" }}>{candidate.metadataFormat === "plain-markdown" ? labels.formatPlain : labels.formatStandard}</span></span></span>
            </label>
            <div className="mt-3 border-t pt-3" style={{ borderColor: "var(--ink-line)" }}>
              {candidate.license.trim() ? <details className="group">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1 text-xs underline underline-offset-2 [&::-webkit-details-marker]:hidden" style={{ color: "var(--ink-mid)" }}>{labels.viewLicense}<ChevronDown className="h-3.5 w-3.5 shrink-0 transition group-open:rotate-180" aria-hidden="true" /></summary>
                <p className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-md p-3 text-xs leading-5" style={{ background: "var(--ink-wash)", color: "var(--ink-mid)" }}>{candidate.license}</p>
              </details> : <p className="text-xs" style={{ color: "var(--ink-faint)" }}>{labels.licenseLabel} · {labels.licenseNone}</p>}
              <div className="mt-3"><KoiSkillCompatibilityNote compatibility={candidate.compatibility} /></div>
              {candidate.installedStatus === "update" && <p className="mt-2 text-xs" style={{ color: "var(--ink-mid)" }}>{labels.updateComparison.replace("{version}", candidate.previousVersion ?? "—").replace("{oldSize}", formatBytes(candidate.previousSizeBytes ?? 0, locale)).replace("{newSize}", formatBytes(candidate.sizeBytes, locale))}</p>}
              <details className="group mt-2">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1 text-xs underline underline-offset-2 [&::-webkit-details-marker]:hidden" style={{ color: "var(--ink-mid)" }}>{labels.viewSkillMd}<ChevronDown className="h-3.5 w-3.5 transition group-open:rotate-180" aria-hidden="true" /></summary>
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md p-3 text-xs leading-5" style={{ background: "var(--ink-wash)", color: "var(--ink-mid)" }}>{candidate.instructions}</pre>
              </details>
            </div>
          </li>)}</ul>
          {preview.candidates.length === 0 ? <p className="text-sm">{labels.koiNoSkills}</p> : <>
            {preview.candidates.some((candidate) => selected.includes(candidate.id) && !candidate.installedStatus) && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enable} disabled={Boolean(busy) || confirmationPending} onChange={(event) => setEnable(event.target.checked)} />{labels.enableAfterInstall}</label>}
            {preview.candidates.some((candidate) => selected.includes(candidate.id) && Boolean(candidate.installedStatus)) && <p className="text-xs" style={{ color: "var(--ink-mid)" }}>{labels.existingKeepsState}</p>}
            <p className="text-xs leading-5" style={{ color: "var(--ink-mid)" }}>{labels.installNotGuaranteed}</p>
          </>}
        </>}
        {preview && preview.rejected.length > 0 && <details className="rounded-lg border p-3" style={{ borderColor: "var(--ink-line)" }}><summary className="cursor-pointer text-xs font-semibold">{labels.rejectedTitle} ({preview.rejected.length})</summary><ul className="mt-2 max-h-48 space-y-1 overflow-auto break-words text-xs leading-5" style={{ color: "var(--ink-mid)" }}>{preview.rejected.map((item) => <li key={`${item.entryPath}:${item.reason}`}>{item.entryPath} — {koiRejectionLabel(item, labels)}</li>)}</ul></details>}
        {preview && ["failed", "expired", "cancelled"].includes(preview.status) && <p role="alert" className="text-sm" style={{ color: "var(--cinnabar)" }}>{koiPreviewErrorLabel(preview, labels)}</p>}
        {error && <p role="alert" className="text-sm" style={{ color: "var(--cinnabar)" }}>{error}</p>}
        {confirmationPending && !busy && <button type="button" onClick={() => void checkConfirmation()} className="text-sm underline">{labels.checkInstallResult}</button>}
        {preview && !busy && !confirmationPending && pending && <button type="button" onClick={() => void (preview.sourceKind === "folder" ? upload() : loadRemote())} className="text-sm underline underline-offset-2">{labels.retry}</button>}
      </div>
      <footer className="shrink-0 space-y-3 border-t px-4 py-4 sm:px-6" style={{ borderColor: "var(--ink-line)", background: "var(--ink-paper-soft)" }}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          {preview && !busy && !confirmationPending && !resumePreview ? <button type="button" onClick={restart} className="py-2 text-xs underline underline-offset-2" style={{ color: "var(--ink-mid)" }}>{labels.startOver}</button> : <span />}
          <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
            <button type="button" onClick={cancel} className="rounded-lg border px-4 py-2.5 text-sm transition hover:bg-[var(--ink-wash)]" style={{ borderColor: "var(--ink-line)" }}>{busy === "confirm" || confirmationPending ? labels.close : labels.cancel}</button>
            {preview?.status === "ready" && preview.candidates.length > 0 && <button type="button" disabled={Boolean(busy) || selected.length === 0} onClick={() => void submit()} className="inline-flex items-center justify-center gap-2 rounded-lg px-5 py-2.5 text-sm font-semibold text-white transition hover:brightness-95 disabled:opacity-50" style={{ background: "var(--cinnabar)" }}>{busy === "confirm" && <LoaderCircle className="h-4 w-4 animate-spin" />}{confirmationPending ? labels.retryInstall : migrating ? labels.legacyConfirm.replace("{count}", String(selected.length)) : replacing ? labels.confirmUpdate : labels.confirmInstall.replace("{count}", String(selected.length))}</button>}
          </div>
        </div>
        <div className="space-y-0.5 text-xs leading-5" style={{ color: "var(--ink-mid)" }}><p>{labels.installRuntimeNotice}</p><p>{labels.skillTaskScope}</p>{(busy === "confirm" || confirmationPending) && <p>{labels.installCloseNotice}</p>}</div>
      </footer>
    </div>
  </div>;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("read_failed"));
    reader.onload = () => { const result = String(reader.result ?? ""); resolve(result.slice(result.indexOf(",") + 1)); };
    reader.readAsDataURL(file);
  });
}

function migrationSourceLabel(preview: KoiPreview, candidateId: string): string {
  const entries = preview.source.entries as Record<string, Record<string, unknown>> | undefined;
  const source = entries?.[candidateId];
  return [source?.directoryName, source?.path].filter((value) => typeof value === "string" && value).join("/");
}
