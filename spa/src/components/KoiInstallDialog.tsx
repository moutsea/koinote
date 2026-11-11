import { FolderUp, LoaderCircle, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ApiError } from "../api";
import { useI18n } from "../i18n";
import { koiFolderEntries, koiFolderPackages, koiSelectedFolderEntries, type KoiFolderEntry } from "../koiSkillFolder";
import { analyzeKoiImport, cancelKoiImport, confirmKoiImport, createKoiImport, getKoiImport, koiErrorMessage, koiPreviewErrorLabel, koiRejectionLabel, uploadKoiImportFile, type KoiPreview } from "../koiSkills";
import { pushModal } from "../modalStack";
import { formatBytes } from "../storage";
import { KoiPending, useKoiSkillStorageInvalidation } from "./KoiSkillUi";

export function KoiInstallDialog({ authUserId, onClose }: { authUserId: string; onClose: () => void }) {
  const { t, locale } = useI18n();
  const labels = t.koi;
  const [entries, setEntries] = useState<KoiFolderEntry[]>([]);
  const [folderName, setFolderName] = useState("");
  const [directories, setDirectories] = useState<string[]>([]);
  const packages = useMemo(() => koiFolderPackages(entries), [entries]);
  const uploadEntries = koiSelectedFolderEntries(packages, directories);
  const [preview, setPreview] = useState<KoiPreview | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [enable, setEnable] = useState(true);
  const [busy, setBusy] = useState("");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const previewRef = useRef(preview);
  const closed = useRef(false);
  const confirming = useRef(false);
  const confirmationID = useRef(crypto.randomUUID());
  const invalidate = useKoiSkillStorageInvalidation(authUserId);

  useEffect(() => pushModal(), []);
  useEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
      queueMicrotask(() => {
        if (closed.current && !confirming.current && previewRef.current) void cancelKoiImport(previewRef.current.id).catch(() => undefined);
      });
    };
  }, []);

  const cancel = () => {
    if (confirming.current) return;
    closed.current = true;
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
    confirmationID.current = crypto.randomUUID();
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
        current = (await createKoiImport({ requestId: crypto.randomUUID(), source: "folder", directoryName: folderName, declaredPaths: uploadEntries.map((entry) => entry.path) })).preview;
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

  const complete = async () => {
    previewRef.current = null;
    await invalidate();
    if (!closed.current) onClose();
  };
  const submit = async () => {
    if (!preview || selected.length === 0 || confirming.current) return;
    confirming.current = true;
    setBusy("confirm");
    setError("");
    try {
      await confirmKoiImport(preview.id, { requestId: confirmationID.current, previewRevision: preview.revision, candidateIds: selected, enable });
      await complete();
    } catch (caught) {
      // A lost response may follow a committed installation. Read its receipt
      // before offering another confirmation.
      try {
        const latest = (await getKoiImport(preview.id)).preview;
        if (latest.status === "committed") { await complete(); return; }
        acceptPreview(latest);
      } catch { /* Keep the preview and stable confirmation ID for retry. */ }
      if (!closed.current) setError(koiErrorMessage(caught, labels));
      await invalidate();
    } finally {
      confirming.current = false;
      if (!closed.current) setBusy("");
    }
  };
  const pending = preview?.status === "pending" || preview?.status === "analyzing";
  const oversized = uploadEntries.some((entry) => entry.file.size > 128 * 1024);
  const tooMany = uploadEntries.length > 512 || uploadEntries.reduce((sum, entry) => sum + entry.file.size, 0) > 8 * 1024 * 1024;

  return <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center sm:p-6" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) cancel(); }}>
    <div role="dialog" aria-modal="true" aria-labelledby="koi-install-title" className="flex max-h-[90dvh] w-full max-w-3xl flex-col overflow-hidden rounded-t-2xl border sm:rounded-2xl" style={{ borderColor: "var(--ink-line)", background: "var(--ink-paper)" }}>
      <header className="flex items-start justify-between gap-3 border-b p-5" style={{ borderColor: "var(--ink-line)" }}>
        <div><h2 id="koi-install-title" className="kn-heading-cn text-lg font-semibold">{labels.installSkill}</h2><p className="mt-1 text-xs leading-5" style={{ color: "var(--ink-mid)" }}>{labels.folderDescription}</p></div>
        <button type="button" autoFocus onClick={cancel} disabled={busy === "confirm"} aria-label={labels.close} className="rounded-lg border p-2 disabled:opacity-50" style={{ borderColor: "var(--ink-line)" }}><X className="h-4 w-4" /></button>
      </header>
      <div className="space-y-4 overflow-y-auto p-5">
        {!preview && <>
          <input ref={fileInput} type="file" multiple hidden {...({ webkitdirectory: "", directory: "" } as Record<string, string>)} onChange={(event) => {
            const files = Array.from(event.currentTarget.files ?? []);
            event.currentTarget.value = "";
            try {
              const next = koiFolderEntries(files);
              setEntries(next);
              setFolderName((files[0]?.webkitRelativePath || "").split("/")[0] || "");
              const found = koiFolderPackages(next);
              setDirectories(found.map((item) => item.directory));
              setError(next.length === 0 ? labels.folderEmpty : found.length === 0 ? labels.koiNoSkills : "");
            } catch { setEntries([]); setDirectories([]); setError(labels.koiSkillInvalid); }
          }} />
          <button type="button" disabled={Boolean(busy)} onClick={() => fileInput.current?.click()} className="inline-flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-semibold" style={{ borderColor: "var(--ink-line)" }}><FolderUp className="h-4 w-4" />{entries.length ? labels.rechoose : labels.folderChoose}</button>
          {packages.length > 0 && <fieldset disabled={Boolean(busy)} className="space-y-2 rounded-xl border p-4" style={{ borderColor: "var(--ink-line)" }}>
            <legend className="px-1 text-xs font-semibold">{labels.folderSelectSkills}</legend>
            {packages.map((item) => <label key={item.directory} className="flex items-start gap-2.5 text-sm">
              <input type="checkbox" name="folder-package" className="mt-1 accent-[var(--cinnabar)]" checked={directories.includes(item.directory)} onChange={() => setDirectories((current) => current.includes(item.directory) ? current.filter((path) => path !== item.directory) : [...current, item.directory])} />
              <span className="break-all">{item.directory || folderName || "SKILL.md"}<span className="ml-2 text-xs" style={{ color: "var(--ink-mid)" }}>{labels.fileCount.replace("{count}", String(item.entries.length))} · {formatBytes(item.entries.reduce((sum, entry) => sum + entry.file.size, 0), locale)}</span></span>
            </label>)}
          </fieldset>}
          {oversized && <p role="alert" className="text-xs" style={{ color: "var(--cinnabar)" }}>{labels.fileTooLarge}</p>}
          {tooMany && <p role="alert" className="text-xs" style={{ color: "var(--cinnabar)" }}>{labels.folderImportLimit}</p>}
          {packages.length > 0 && <button type="button" disabled={Boolean(busy) || uploadEntries.length === 0 || oversized || tooMany} onClick={() => void upload()} className="rounded-lg px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50" style={{ background: "var(--cinnabar)" }}>{labels.uploadAndAnalyze}</button>}
          <p className="text-xs leading-5" style={{ color: "var(--ink-mid)" }}>{labels.folderCloudNotice}</p>
        </>}
        {busy && <KoiPending label={busy === "upload" ? `${labels.uploading} ${progress}/${uploadEntries.length}` : busy === "analyze" ? labels.analyzing : labels.installing} />}
        {preview?.status === "ready" && <>
          <h3 className="text-sm font-semibold">{labels.previewTitle}</h3>
          <ul className="space-y-3">{preview.candidates.map((candidate) => <li key={candidate.id} className="rounded-xl border p-4" style={{ borderColor: "var(--ink-line)" }}>
            <label className="flex items-start gap-3"><input type="checkbox" checked={selected.includes(candidate.id)} disabled={Boolean(busy)} className="mt-1 accent-[var(--cinnabar)]" onChange={() => setSelected((current) => current.includes(candidate.id) ? current.filter((id) => id !== candidate.id) : [...current, candidate.id])} />
              <span className="min-w-0"><span className="text-sm font-semibold">{candidate.name}</span>{candidate.installedStatus === "installed" && <span className="ml-2 text-xs" style={{ color: "var(--ink-mid)" }}>{labels.alreadyInstalled}</span>}<span className="mt-1 block text-xs leading-5" style={{ color: "var(--ink-mid)" }}>{candidate.description}</span><span className="mt-1 block break-all text-xs" style={{ color: "var(--ink-faint)" }}>{candidate.entryPath} · {formatBytes(candidate.sizeBytes, locale)} · {labels.fileCount.replace("{count}", String(candidate.fileCount))}</span></span>
            </label>
            <details className="mt-3"><summary className="cursor-pointer text-xs underline">{labels.viewSkillMd}</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs leading-6">{candidate.instructions}</pre></details>
          </li>)}</ul>
          {preview.candidates.length === 0 ? <p className="text-sm">{labels.koiNoSkills}</p> : <>
            {preview.candidates.some((candidate) => selected.includes(candidate.id) && candidate.installedStatus !== "installed") && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enable} disabled={Boolean(busy)} onChange={(event) => setEnable(event.target.checked)} />{labels.enableAfterInstall}</label>}
            {preview.candidates.some((candidate) => selected.includes(candidate.id) && candidate.installedStatus === "installed") && <p className="text-xs" style={{ color: "var(--ink-mid)" }}>{labels.existingKeepsState}</p>}
            <p className="text-xs leading-5" style={{ color: "var(--ink-mid)" }}>{labels.installNotGuaranteed}</p>
            <button type="button" disabled={Boolean(busy) || selected.length === 0} onClick={() => void submit()} className="inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-50" style={{ background: "var(--cinnabar)" }}>{busy === "confirm" && <LoaderCircle className="h-4 w-4 animate-spin" />}{labels.confirmInstall.replace("{count}", String(selected.length))}</button>
          </>}
        </>}
        {preview && preview.rejected.length > 0 && <div className="rounded-lg border p-3" style={{ borderColor: "var(--ink-line)" }}><h3 className="text-xs font-semibold">{labels.rejectedTitle}</h3><ul className="mt-2 space-y-1 text-xs leading-5" style={{ color: "var(--ink-mid)" }}>{preview.rejected.map((item) => <li key={`${item.entryPath}:${item.reason}`}>{item.entryPath} — {koiRejectionLabel(item, labels)}</li>)}</ul></div>}
        {preview && ["failed", "expired", "cancelled"].includes(preview.status) && <p role="alert" className="text-sm" style={{ color: "var(--cinnabar)" }}>{koiPreviewErrorLabel(preview, labels)}</p>}
        {error && <p role="alert" className="text-sm" style={{ color: "var(--cinnabar)" }}>{error}</p>}
        {preview && !busy && <div className="flex gap-4">{pending && <button type="button" onClick={() => void upload()} className="text-sm underline">{labels.retry}</button>}<button type="button" onClick={restart} className="text-sm underline">{labels.startOver}</button></div>}
      </div>
      <footer className="flex items-center justify-between gap-4 border-t p-4" style={{ borderColor: "var(--ink-line)" }}><p className="text-xs leading-5" style={{ color: "var(--ink-mid)" }}>{labels.skillTaskScope}</p><button type="button" disabled={busy === "confirm"} onClick={cancel} className="shrink-0 rounded-lg border px-4 py-2 text-sm disabled:opacity-50" style={{ borderColor: "var(--ink-line)" }}>{labels.cancel}</button></footer>
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
