import { ChevronDown, ChevronRight, Download, Eye, FileText, Folder, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { getAgentWorkspaceFile, type AgentWorkspace, type AgentWorkspaceFile } from "../api";
import { decodeAgentWorkspaceText, isAgentWorkspaceHomeFile } from "../agentWorkspaceImport";
import { AGENT_WORKSPACE_TRANSFER_MAX_BYTES, AGENT_WORKSPACE_TRANSFER_MAX_FILES, agentWorkspaceTransferTooLarge, AgentWorkspaceTransferError, loadAgentWorkspaceFiles, saveAgentWorkspaceZip } from "../agentWorkspaceTransfer";
import { confirmAction } from "../confirmAction";
import { configRestoreErrorMessage } from "../configRestore";
import { isDesktopRuntime } from "../desktop/runtime";
import { useI18n } from "../i18n";
import { pushModal } from "../modalStack";
import { formatBytes } from "../storage";
import { buildAgentWorkspaceFileTree } from "./AgentWorkspaceFileTree";

type Destination = "zip" | "home" | "folder";
type Node = ReturnType<typeof buildAgentWorkspaceFileTree>[number];
function descendants(node: Node): AgentWorkspaceFile[] {
  return node.kind === "file" ? [node.file] : node.children.flatMap(descendants);
}

export function AgentWorkspaceTransferDialog({ workspace, initialDestination, onClose, onComplete }: {
  workspace: AgentWorkspace;
  initialDestination: "zip" | "home";
  onClose: () => void;
  onComplete: (message: string) => void;
}) {
  const { t, locale } = useI18n();
  const messages = t.agentWorkspace;
  const desktop = isDesktopRuntime();
  const homeFiles = workspace.files.filter((file) => isAgentWorkspaceHomeFile(file.path));
  const initial = !desktop ? "zip" : initialDestination === "home" && !homeFiles.length ? "folder" : initialDestination;
  const [destination, setDestination] = useState<Destination>(initial);
  const [selected, setSelected] = useState(() => new Set((initial === "home" ? homeFiles : workspace.files).map((file) => file.fileId)));
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [pending, setPending] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ path: string; text: string } | null>(null);
  const transfer = useRef<AbortController | null>(null);
  const previewSequence = useRef(0);
  const eligible = destination === "home" ? homeFiles : workspace.files;
  const eligibleIDs = new Set(eligible.map((file) => file.fileId));
  const selectedFiles = eligible.filter((file) => selected.has(file.fileId));
  const selectionTooLarge = agentWorkspaceTransferTooLarge(selectedFiles);
  const limitMessage = messages.transferTooLarge.replace("{size}", `${AGENT_WORKSPACE_TRANSFER_MAX_BYTES >> 20} MiB`).replace("{count}", AGENT_WORKSPACE_TRANSFER_MAX_FILES.toLocaleString(locale));
  const nodes = buildAgentWorkspaceFileTree(workspace.files);

  useEffect(() => {
    const release = pushModal();
    return () => { release(); transfer.current?.abort(); previewSequence.current++; };
  }, []);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); if (!transfer.current) onClose(); }
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [onClose]);

  function changeDestination(value: Destination) {
    setDestination(value);
    setSelected(new Set((value === "home" ? homeFiles : workspace.files).map((file) => file.fileId)));
    setError(null);
    setNotice(null);
  }
  function toggle(files: AgentWorkspaceFile[]) {
    const available = files.filter((file) => eligibleIDs.has(file.fileId));
    setSelected((current) => {
      const next = new Set(current);
      const remove = available.every((file) => next.has(file.fileId));
      for (const file of available) { if (remove) next.delete(file.fileId); else next.add(file.fileId); }
      return next;
    });
  }
  async function showPreview(file: AgentWorkspaceFile) {
    const sequence = ++previewSequence.current;
    setPreview({ path: file.path, text: messages.loadingFile });
    try {
      const result = await getAgentWorkspaceFile(file.fileId);
      if (sequence !== previewSequence.current) return;
      if (result.file.sha256 !== file.sha256) throw new AgentWorkspaceTransferError("transferChanged");
      const binary = atob(result.file.contentBase64);
      const bytes = binary.slice(0, 64 * 1024);
      setPreview({ path: file.path, text: bytes.includes("\0") ? messages.scanReviewPreviewBinary : decodeAgentWorkspaceText(btoa(bytes)) + (binary.length > bytes.length ? `\n\n${messages.scanReviewPreviewTruncated}` : "") });
    } catch (value) {
      if (sequence === previewSequence.current) setPreview({ path: file.path, text: value instanceof AgentWorkspaceTransferError ? messages[value.code] : messages.transferPreviewFailed });
    }
  }
  async function submit() {
    if (transfer.current || !selectedFiles.length || selectionTooLarge || (!desktop && destination !== "zip")) return;
    const controller = new AbortController();
    transfer.current = controller;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      if (destination === "folder" && !await confirmAction(messages.transferFolderConfirm)) return;
      const files = await loadAgentWorkspaceFiles(workspace, new Set(selectedFiles.map((file) => file.fileId)), (done, total) => {
        if (!controller.signal.aborted) setProgress(messages.transferProgress.replace("{done}", String(done)).replace("{total}", String(total)));
      }, controller.signal);
      controller.signal.throwIfAborted();
      setProgress(messages.transferSaving);
      let completed: boolean;
      if (destination === "zip") {
        completed = await saveAgentWorkspaceZip(files, `${workspace.name}-r${workspace.revision}`);
      } else {
        const { desktopRestoreConfigFiles, desktopRestoreConfigFilesToHome } = await import("../desktop/configFiles");
        controller.signal.throwIfAborted();
        completed = (await (destination === "home" ? desktopRestoreConfigFilesToHome(files, locale) : desktopRestoreConfigFiles(files, locale))) > 0;
      }
      if (controller.signal.aborted) return;
      if (completed) onComplete(destination === "zip" ? messages.transferDownloaded : messages.transferSynced.replace("{count}", String(files.length)));
      else setNotice(messages.transferCancelled);
    } catch (value) {
      if (!controller.signal.aborted) setError(value instanceof AgentWorkspaceTransferError ? (value.code === "transferTooLarge" ? limitMessage : messages[value.code]) : configRestoreErrorMessage(value, t.space.configSnapshots) ?? messages.transferFailed);
    } finally {
      if (!controller.signal.aborted) { transfer.current = null; setPending(false); }
    }
  }

  function renderNode(node: Node, depth: number): ReactNode {
    const files = descendants(node).filter((file) => eligibleIDs.has(file.fileId));
    const count = files.filter((file) => selected.has(file.fileId)).length;
    const open = expanded.has(node.path);
    return <div key={node.path}>
      <div className="flex min-w-0 items-center gap-2 rounded px-2 py-1.5 text-xs hover:bg-[var(--ink-wash)]" style={{ paddingLeft: 8 + depth * 16 }}>
        <input type="checkbox" checked={files.length > 0 && count === files.length} disabled={pending || !files.length} ref={(el) => { if (el) el.indeterminate = count > 0 && count < files.length; }} onChange={() => toggle(files)} aria-label={`${messages.select} ${node.path}`} className="h-3.5 w-3.5 shrink-0 accent-[var(--cinnabar)]" />
        {node.kind === "directory" ? <button type="button" aria-expanded={open} onClick={() => setExpanded((current) => { const next = new Set(current); if (open) next.delete(node.path); else next.add(node.path); return next; })} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
          {open ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}<Folder className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{node.name}</span><span className="ml-auto shrink-0" style={{ color: "var(--ink-faint)" }}>{count}/{files.length}</span>
        </button> : <button type="button" onClick={() => void showPreview(node.file)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" title={node.path}>
          <FileText className="h-3.5 w-3.5 shrink-0" /><span className="truncate">{node.name}</span><Eye className="ml-auto h-3.5 w-3.5 shrink-0" /><span className="shrink-0" style={{ color: "var(--ink-faint)" }}>{formatBytes(node.file.sizeBytes)}</span>
        </button>}
      </div>
      {node.kind === "directory" && open && node.children.map((child) => renderNode(child, depth + 1))}
    </div>;
  }

  return <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]">
    <section role="dialog" aria-modal="true" aria-labelledby="agent-transfer-title" className="flex max-h-[92vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border bg-[var(--background)] shadow-2xl" style={{ borderColor: "var(--ink-line)" }}>
      <header className="flex items-start gap-3 border-b px-5 py-4" style={{ borderColor: "var(--ink-line)" }}>
        <Download className="mt-1 h-5 w-5 shrink-0" style={{ color: "var(--cinnabar)" }} /><div className="min-w-0 flex-1"><h2 id="agent-transfer-title" className="font-semibold">{messages.transferTitle}</h2><p className="mt-1 break-words text-xs" style={{ color: "var(--ink-mid)" }}>{workspace.name} · r{workspace.revision}</p></div><button type="button" disabled={pending} onClick={onClose} aria-label={messages.close} className="rounded p-1 disabled:opacity-50"><X className="h-4 w-4" /></button>
      </header>
      <div className="min-h-0 space-y-4 overflow-y-auto px-5 py-4">
        <label className="block text-sm">{messages.transferDestination}<select value={destination} disabled={pending} onChange={(event) => changeDestination(event.target.value as Destination)} className="mt-2 block w-full rounded-lg border bg-[var(--background)] px-3 py-2" style={{ borderColor: "var(--ink-line)" }}>
          <option value="zip">{messages.transferZip}</option>{desktop && <><option value="home" disabled={!homeFiles.length}>{messages.transferHome}</option><option value="folder">{messages.transferFolder}</option></>}
        </select></label>
        <p className="text-xs leading-5" style={{ color: "var(--ink-mid)" }}>{destination === "zip" ? messages.transferZipHint : destination === "home" ? messages.transferHomeHint : messages.transferFolderHint}</p>
        {destination === "home" && <p className="text-xs leading-5" style={{ color: "var(--ink-mid)" }}>{t.space.configSnapshots.crossPlatformHint}</p>}
        <div><div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs"><span>{messages.scanReviewFiles.replace("{count}", String(selectedFiles.length))} · {formatBytes(selectedFiles.reduce((sum, file) => sum + file.sizeBytes, 0))}</span><div className="flex gap-3"><button type="button" disabled={pending} onClick={() => setSelected(new Set(eligibleIDs))} style={{ color: "var(--cinnabar)" }}>{messages.scanReviewSelectAll}</button><button type="button" disabled={pending} onClick={() => setSelected(new Set())}>{messages.scanReviewClearAll}</button></div></div><div className="max-h-64 overflow-auto rounded-lg border p-1" style={{ borderColor: "var(--ink-line)" }}>{nodes.map((node) => renderNode(node, 0))}</div></div>
        {preview && <div className="rounded-lg border p-3" style={{ borderColor: "var(--ink-line)" }}><p className="mb-2 break-all text-xs font-medium">{preview.path}</p><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs leading-5">{preview.text}</pre></div>}
        {selectionTooLarge && <p role="alert" className="text-sm" style={{ color: "var(--cinnabar)" }}>{limitMessage}</p>}
        {error && <p role="alert" className="text-sm" style={{ color: "var(--cinnabar)" }}>{error}</p>}
        {notice && <p role="status" className="text-sm">{notice}</p>}
        {pending && <p role="status" className="text-sm" style={{ color: "var(--ink-mid)" }}>{progress || messages.transferSaving}</p>}
      </div>
      <footer className="flex shrink-0 flex-wrap items-center justify-end gap-3 border-t px-5 py-3" style={{ borderColor: "var(--ink-line)" }}><button type="button" disabled={pending} onClick={onClose} className="rounded-full border px-4 py-2 text-sm disabled:opacity-50" style={{ borderColor: "var(--ink-line)" }}>{messages.scanReviewCancel}</button><button type="button" disabled={pending || !selectedFiles.length || selectionTooLarge} aria-busy={pending} onClick={() => void submit()} className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed" style={{ background: "var(--cinnabar)", opacity: !selectedFiles.length || selectionTooLarge ? 0.5 : 1 }}><RefreshCw aria-hidden="true" className={`h-4 w-4 shrink-0 ${pending ? "animate-spin" : "invisible"}`} />{destination === "zip" ? messages.transferZip : messages.transferConfirmSync}</button></footer>
    </section>
  </div>;
}
