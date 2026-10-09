import { ApiError, getAgentWorkspace, getAgentWorkspaceFile, type AgentWorkspace, type AgentWorkspaceFile } from "./api";
import { sha256Hex } from "./agentWorkspaceImport";
import { Zip, ZipDeflate } from "fflate";
import type { ConfigVaultFile } from "./configVaultCrypto";
import { isDesktopRuntime } from "./desktop/runtime";

export class AgentWorkspaceTransferError extends Error {
  constructor(public code: "transferChanged" | "transferInvalidPath" | "transferTooLarge") { super(code); }
}

export type AgentWorkspaceTransferSource = {
  readWorkspace: (signal?: AbortSignal) => ReturnType<typeof getAgentWorkspace>;
  readFile: (fileId: number, signal?: AbortSignal) => ReturnType<typeof getAgentWorkspaceFile>;
};

// The native bridge expands bytes into number arrays. Bound the entire batch,
// not just simultaneous requests, before downloading or allocating ZIP buffers.
export const AGENT_WORKSPACE_TRANSFER_MAX_BYTES = 64 << 20;
export const AGENT_WORKSPACE_TRANSFER_MAX_FILES = 10_000;
export function agentWorkspaceTransferTooLarge(files: { sizeBytes: number }[]): boolean {
  let total = 0;
  return files.length > AGENT_WORKSPACE_TRANSFER_MAX_FILES || files.some(({ sizeBytes }) => {
    total += sizeBytes;
    return !Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || total > AGENT_WORKSPACE_TRANSFER_MAX_BYTES;
  });
}

export function validateAgentWorkspaceTransferPaths(files: Pick<AgentWorkspaceFile, "path">[]) {
  const paths = new Set<string>();
  for (const { path } of files) {
    if (!path || path.startsWith("/") || /[\\\u0000-\u001f\u007f:]/.test(path) || path.split("/").some((part) => !part || part === "." || part === "..") || paths.has(path)) {
      throw new AgentWorkspaceTransferError("transferInvalidPath");
    }
    paths.add(path);
  }
  for (const path of paths) {
    const parts = path.split("/");
    for (let length = 1; length < parts.length; length++) {
      if (paths.has(parts.slice(0, length).join("/"))) throw new AgentWorkspaceTransferError("transferInvalidPath");
    }
  }
}

function waitForTransferRetry(delay: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, delay);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function loadAgentWorkspaceFiles(
  snapshot: AgentWorkspace,
  selectedIDs: Set<number>,
  onProgress: (completed: number, total: number) => void,
  signal?: AbortSignal,
  source?: AgentWorkspaceTransferSource,
  onRateLimit?: (waiting: boolean) => void,
): Promise<ConfigVaultFile[]> {
  const files = snapshot.files.filter((file) => selectedIDs.has(file.fileId));
  if (!files.length || files.length !== selectedIDs.size) throw new AgentWorkspaceTransferError("transferChanged");
  if (agentWorkspaceTransferTooLarge(files)) throw new AgentWorkspaceTransferError("transferTooLarge");
  validateAgentWorkspaceTransferPaths(files);
  signal?.throwIfAborted();
  const controller = new AbortController();
  const transferSignal = controller.signal;
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  // A single cooldown pauses all four readers, including the final manifest
  // check. Only the rejected read is retried; verified files stay in memory.
  let blockedUntil = 0;
  async function readWithRetry<T>(read: () => Promise<T>): Promise<T> {
    for (let retries = 0; ; retries++) {
      transferSignal.throwIfAborted();
      while (Date.now() < blockedUntil) await waitForTransferRetry(blockedUntil - Date.now(), transferSignal);
      transferSignal.throwIfAborted();
      onRateLimit?.(false);
      try {
        return await read();
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 429 || retries >= 3) throw error;
        const delay = Math.max(1000, error.retryAfterMs ?? 60_000);
        // Do not retry early when the server asks for an unusually long wait.
        // Bound each read so a persistently rate-limited transfer can fail visibly.
        if (!Number.isFinite(delay) || delay > 300_000) throw error;
        blockedUntil = Math.max(blockedUntil, Date.now() + delay);
        onRateLimit?.(true);
      }
    }
  }
  const checkRevision = async () => {
    let workspace: AgentWorkspace | null | undefined;
    try {
      ({ workspace } = await readWithRetry(() => source ? source.readWorkspace(transferSignal) : getAgentWorkspace(snapshot.workspaceId, transferSignal)));
    } catch (error) {
      if (error instanceof ApiError && (error.status === 404 || error.status === 409)) throw new AgentWorkspaceTransferError("transferChanged");
      throw error;
    }
    if (!workspace || workspace.revision !== snapshot.revision) throw new AgentWorkspaceTransferError("transferChanged");
    transferSignal.throwIfAborted();
  };
  try {
    await checkRevision();
    const result: ConfigVaultFile[] = new Array(files.length);
    let next = 0;
    let completed = 0;
    let failure: unknown;
    onProgress(0, files.length);
    // Limit simultaneous full-file reads (each file may be 5 MiB).
    await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
      while (next < files.length && !transferSignal.aborted) {
        const index = next++;
        const expected = files[index];
        try {
          const { file } = await readWithRetry(() => source ? source.readFile(expected.fileId, transferSignal) : getAgentWorkspaceFile(expected.fileId, transferSignal));
          transferSignal.throwIfAborted();
          if (file.contentBase64.length > 4 * Math.ceil(expected.sizeBytes / 3)) throw new AgentWorkspaceTransferError("transferChanged");
          const binary = atob(file.contentBase64);
          const bytes = new Uint8Array(binary.length);
          for (let offset = 0; offset < binary.length; offset++) bytes[offset] = binary.charCodeAt(offset);
          if (file.fileId !== expected.fileId || file.path !== expected.path || file.sha256 !== expected.sha256 || bytes.length !== expected.sizeBytes || await sha256Hex(bytes) !== expected.sha256) {
            throw new AgentWorkspaceTransferError("transferChanged");
          }
          transferSignal.throwIfAborted();
          result[index] = { path: expected.path, bytes };
          onProgress(++completed, files.length);
        } catch (error) {
          if (!transferSignal.aborted) {
            failure = error instanceof ApiError && (error.status === 404 || error.status === 409) ? new AgentWorkspaceTransferError("transferChanged") : error;
            controller.abort(failure); // Wake other readers waiting on the shared cooldown.
          }
        }
      }
    }));
    if (failure) throw failure;
    transferSignal.throwIfAborted();
    await checkRevision();
    return result;
  } finally {
    signal?.removeEventListener("abort", abort);
    onRateLimit?.(false);
  }
}

export async function saveAgentWorkspaceZip(files: ConfigVaultFile[], name: string): Promise<boolean> {
  validateAgentWorkspaceTransferPaths(files);
  if (agentWorkspaceTransferTooLarge(files.map((file) => ({ sizeBytes: file.bytes.byteLength })))) throw new AgentWorkspaceTransferError("transferTooLarge");
  // Add named entries directly: zipSync's internal plain object treats a root
  // file named __proto__ as a prototype setter instead of an archive entry.
  const bytes = await new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let failed = false;
    const zip = new Zip((error, chunk, final) => {
      if (error) { failed = true; reject(error); return; }
      chunks.push(chunk);
      size += chunk.length;
      if (final) {
        const output = new Uint8Array(size);
        let offset = 0;
        for (const part of chunks) { output.set(part, offset); offset += part.length; }
        resolve(output);
      }
    });
    for (const file of files) {
      const entry = new ZipDeflate(file.path, { level: 6 });
      zip.add(entry);
      entry.push(file.bytes, true);
      if (failed) return;
    }
    zip.end();
  });
  const filename = `${Array.from(name.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_").replace(/^\.+/, "").trim()).slice(0, 80).join("") || "agent-workspace"}.zip`;
  if (isDesktopRuntime()) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke<boolean>("desktop_save_export", bytes, { headers: {
      "x-koinote-export-filename": encodeURIComponent(filename),
      "x-koinote-export-extension": "zip",
    } });
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/zip" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
