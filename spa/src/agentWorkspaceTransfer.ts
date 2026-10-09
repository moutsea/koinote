import { ApiError, getAgentWorkspace, getAgentWorkspaceFile, type AgentWorkspace, type AgentWorkspaceFile } from "./api";
import { sha256Hex } from "./agentWorkspaceImport";
import { Zip, ZipDeflate } from "fflate";
import type { ConfigVaultFile } from "./configVaultCrypto";
import { isDesktopRuntime } from "./desktop/runtime";

export class AgentWorkspaceTransferError extends Error {
  constructor(public code: "transferChanged" | "transferInvalidPath" | "transferTooLarge") { super(code); }
}

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

export async function loadAgentWorkspaceFiles(
  snapshot: AgentWorkspace,
  selectedIDs: Set<number>,
  onProgress: (completed: number, total: number) => void,
  signal?: AbortSignal,
): Promise<ConfigVaultFile[]> {
  const files = snapshot.files.filter((file) => selectedIDs.has(file.fileId));
  if (!files.length || files.length !== selectedIDs.size) throw new AgentWorkspaceTransferError("transferChanged");
  if (agentWorkspaceTransferTooLarge(files)) throw new AgentWorkspaceTransferError("transferTooLarge");
  validateAgentWorkspaceTransferPaths(files);
  const checkRevision = async () => {
    signal?.throwIfAborted();
    const { workspace } = await getAgentWorkspace(snapshot.workspaceId);
    if (!workspace || workspace.revision !== snapshot.revision) throw new AgentWorkspaceTransferError("transferChanged");
    signal?.throwIfAborted();
  };
  await checkRevision();
  const result: ConfigVaultFile[] = new Array(files.length);
  let next = 0;
  let completed = 0;
  let failure: unknown;
  onProgress(0, files.length);
  // Limit simultaneous full-file reads (each file may be 5 MiB).
  await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
    while (next < files.length && !failure) {
      const index = next++;
      const expected = files[index];
      try {
        signal?.throwIfAborted();
        const { file } = await getAgentWorkspaceFile(expected.fileId);
        signal?.throwIfAborted();
        if (file.contentBase64.length > 4 * Math.ceil(expected.sizeBytes / 3)) throw new AgentWorkspaceTransferError("transferChanged");
        const binary = atob(file.contentBase64);
        const bytes = new Uint8Array(binary.length);
        for (let offset = 0; offset < binary.length; offset++) bytes[offset] = binary.charCodeAt(offset);
        if (file.fileId !== expected.fileId || file.path !== expected.path || file.sha256 !== expected.sha256 || bytes.length !== expected.sizeBytes || await sha256Hex(bytes) !== expected.sha256) {
          throw new AgentWorkspaceTransferError("transferChanged");
        }
        result[index] = { path: expected.path, bytes };
        onProgress(++completed, files.length);
      } catch (error) {
        failure = error instanceof ApiError && error.status === 404 ? new AgentWorkspaceTransferError("transferChanged") : error;
      }
    }
  }));
  if (failure) throw failure;
  await checkRevision();
  return result;
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
