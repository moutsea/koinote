import { useEffect, useState } from "react";
import { fetchAppResource } from "../api";
import type { AgentArtifact } from "../agentSessions";
import { agentPanelText } from "../i18n/agentPanel";
import { useI18n } from "../i18n";
import { formatBytes } from "../storage";

export function AgentArtifactCard({ file, disabled }: { file: AgentArtifact; disabled: boolean }) {
  const { locale } = useI18n();
  const labels = agentPanelText[locale];
  const image = file.mimeType === "image/jpeg" && file.name.startsWith("koi-cover-");
  const [preview, setPreview] = useState("");
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);
  const path = `/api/agent/artifacts/${file.id}`;
  useEffect(() => {
    if (!image) return;
    const controller = new AbortController();
    let objectURL = "";
    setPreview(""); setFailed(false);
    void fetchAppResource(`${path}?preview=1`, { credentials: "include", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok || response.headers.get("content-type") !== "image/jpeg") throw new Error("preview_failed");
        const blob = await response.blob();
        if (!controller.signal.aborted) { objectURL = URL.createObjectURL(blob); setPreview(objectURL); }
      })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => { controller.abort(); if (objectURL) URL.revokeObjectURL(objectURL); };
  }, [path, image]);
  async function download() {
    setSaving(true); setError(false);
    try {
      const response = await fetchAppResource(path, { credentials: "include" });
      if (!response.ok) throw new Error("download_failed");
      const { saveExportBlob, safeFilename } = await import("./editor/exportDocument");
      const name = safeFilename(image ? "koi-cover.jpg" : file.name, "agent-result.txt");
      await saveExportBlob(await response.blob(), name, name.split(".").pop() || "txt");
    } catch { setError(true); }
    finally { setSaving(false); }
  }
  return <div className="my-3 max-w-xl rounded-xl border p-3" style={{ borderColor: "var(--ink-line)" }}>
    {image && <>
      {preview && !failed ? <img src={preview} alt={labels.generatedCover} onError={() => setFailed(true)} className="mb-3 max-h-80 w-full rounded-lg object-contain" /> : <p role="status" className="mb-3 text-xs text-[var(--ink-mid)]">{failed ? labels.coverPreviewFailed : labels.coverPreviewLoading}</p>}
      <p className="mb-2 text-xs text-[var(--ink-mid)]">{labels.coverSaved}</p>
    </>}
    <button type="button" className="rounded-lg border px-3 py-2 text-xs disabled:opacity-50" disabled={disabled || saving} onClick={() => void download()}>
      ↓ {image ? labels.downloadCover : file.name} · {formatBytes(file.bytes, locale)}
    </button>
    {error && <p role="alert" className="mt-2 text-xs text-[var(--cinnabar)]">{labels.artifactDownloadFailed}</p>}
  </div>;
}
