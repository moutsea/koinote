import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  FileText,
  Files,
  Folder,
  FolderOpen,
  KeyRound,
  LoaderCircle,
  ScanLine,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ApiError,
  createConfigSnapshot,
  createConfigSyncGrant,
  revokeConfigSyncGrants,
  deleteConfigSnapshot,
  getConfigSnapshot,
  getConfigSnapshots,
  updateConfigSnapshot,
  type ConfigSnapshotSummary,
} from "../api";
import {
  decryptConfigSnapshot,
  downloadConfigFiles,
  encryptConfigSnapshot,
  unlockConfigSnapshot,
  filesFromFileList,
  type ConfigVaultFile,
} from "../configVaultCrypto";
import { isAgentWorkspaceSourcePath } from "../agentWorkspaceImport";
import { configRestoreErrorMessage } from "../configRestore";
import { configAgentSyncPrompt } from "../agentLocalSync";
import { LocalSyncMenu } from "./LocalSyncMenu";
import { useAgentSyncCopy } from "./AgentSyncCopyDialog";
import { isDesktopRuntime } from "../desktop/runtime";
import { interpolate, useI18n, type Messages } from "../i18n";
import { formatBytes } from "../storage";
import { confirmAction } from "../confirmAction";
import { PaperCard } from "./Ink";
import { ConfigSnapshotPasswordDialog } from "./ConfigSnapshotPasswordDialog";
import { STORAGE_USAGE_KEY } from "./StorageCard";
import { pushModal } from "../modalStack";
import { configGroupKey, GROUP_KEYS, type GroupKey } from "../configVaultGroups";

const SNAPSHOTS_KEY = ["config-snapshots"] as const;
const CONFIG_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;
type SnapshotFiles = Record<string, ConfigVaultFile[]>;
type UnlockedSnapshot = { revision: number; files: ConfigVaultFile[]; decryptionKey: string };
type PendingScan = {
  files: ConfigVaultFile[];
};
type GroupAction = { snapshotId: string; groupKey: string } | null;
type SnapshotAction = { snapshot: ConfigSnapshotSummary } & (
  | { kind: "expand" }
  | { kind: "restore"; destination: "home" | "folder"; groupKey?: string }
  | { kind: "agent" }
  | { kind: "update"; groupKey: string; replacements: ConfigVaultFile[] }
  | { kind: "delete"; groupKey: string; paths: string[]; label: string }
);

type ConfigFileTreeNode = {
  name: string;
  path: string;
  kind: "directory" | "file";
  children: ConfigFileTreeNode[];
  file?: ConfigVaultFile;
};

type SnapshotMessages = Messages["space"]["configSnapshots"];

function errorMessage(error: unknown, messages: SnapshotMessages): string {
  const restoreError = configRestoreErrorMessage(error, messages);
  if (restoreError) return restoreError;
  if (error instanceof ApiError) {
    if (error.code === "config_snapshot_limit") return messages.errorLimit;
    if (error.code === "config_snapshot_quota_exceeded") return messages.errorQuota;
    if (error.code === "config_snapshot_conflict") return messages.errorConflict;
    if (error.code === "invalid_snapshot") return messages.errorInvalid;
    if (error.code === "too_many_requests" || error.code === "rate_limited") return messages.errorGeneric;
  }
  if (error instanceof Error) {
    if (error.message === "config_password_incorrect" || error.message === "config_snapshot_invalid") return messages.errorPassword;
    if (error.message === "config_password_mismatch") return messages.passwordMismatch;
    if (error.message === "config_password_too_short") return messages.errorPasswordShort;
    if (error.message === "config_file_count_invalid") return messages.errorFileCount;
    if (error.message === "config_files_too_large") return messages.errorInvalid;
    if (error.message === "config_no_files_found") return messages.errorNoFiles;
    if (error.message === "config_home_unavailable") return messages.errorHome;
    if (error.message === "config_file_outside_home") return messages.errorOutsideHome;
    if (error.message === "config_path_invalid" || error.message === "config_path_duplicate") return messages.errorPath;
    return error.message || messages.errorGeneric;
  }
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object") {
    const message = "message" in error && typeof error.message === "string" ? error.message : "";
    if (message) return message;
    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== "{}") return serialized;
    } catch {
      return messages.errorGeneric;
    }
  }
  return messages.errorGeneric;
}

function displayDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function groupedFiles(files: ConfigVaultFile[]): Array<[GroupKey, ConfigVaultFile[]]> {
  const groups = new Map<GroupKey, ConfigVaultFile[]>();
  for (const file of files) {
    const key = configGroupKey(file.path);
    const group = groups.get(key) ?? [];
    group.push(file);
    groups.set(key, group);
  }
  return Array.from(groups.entries()).sort(([left], [right]) => GROUP_KEYS.indexOf(left) - GROUP_KEYS.indexOf(right));
}

function buildFileTree(files: ConfigVaultFile[]): ConfigFileTreeNode[] {
  const roots: ConfigFileTreeNode[] = [];
  for (const file of files) {
    const parts = file.path.split("/");
    let children = roots;
    let path = "";
    parts.forEach((name, index) => {
      path = path ? `${path}/${name}` : name;
      const isFile = index === parts.length - 1;
      let node = children.find((candidate) => candidate.name === name);
      if (!node) {
        node = {
          name,
          path,
          kind: isFile ? "file" : "directory",
          children: [],
          ...(isFile ? { file } : {}),
        };
        children.push(node);
      }
      children = node.children;
    });
  }
  const sortNodes = (nodes: ConfigFileTreeNode[]): ConfigFileTreeNode[] => [...nodes]
    .sort((left, right) => {
      if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
      return left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    })
    .map((node) => ({ ...node, children: sortNodes(node.children) }));
  return sortNodes(roots);
}

function filesInTreeNode(node: ConfigFileTreeNode): ConfigVaultFile[] {
  if (node.kind === "file" && node.file) return [node.file];
  return node.children.flatMap(filesInTreeNode);
}

function ConfigFileTree({
  files,
  onView,
  onDelete,
  disabled,
  labels,
}: {
  files: ConfigVaultFile[];
  onView: (file: ConfigVaultFile) => void;
  onDelete: (paths: string[], label: string) => void;
  disabled: boolean;
  labels: SnapshotMessages;
}) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const nodes = useMemo(() => buildFileTree(files), [files]);

  function toggleDirectory(path: string) {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function renderNode(node: ConfigFileTreeNode, depth: number): ReactNode {
    const isDirectory = node.kind === "directory";
    const isExpanded = isDirectory && expandedPaths.has(node.path);
    const descendants = isDirectory ? filesInTreeNode(node) : node.file ? [node.file] : [];
    return (
      <div key={node.path} role="treeitem" aria-expanded={isDirectory ? isExpanded : undefined}>
        <div
          className="group flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs hover:bg-[var(--ink-wash)]"
          style={{ paddingLeft: `${depth * 16 + 6}px` }}
        >
          {isDirectory ? (
            <button
              type="button"
              onClick={() => toggleDirectory(node.path)}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              aria-label={`${isExpanded ? labels.treeCollapse : labels.treeExpand} ${node.path}`}
            >
              {isExpanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
              {isExpanded ? <FolderOpen className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--cinnabar)" }} /> : <Folder className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--ink-faint)" }} />}
              <span className="min-w-0 truncate" style={{ color: "var(--ink-strong)" }}>{node.name}</span>
              <span className="shrink-0" style={{ color: "var(--ink-faint)" }}>{descendants.length}</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => { if (node.file) onView(node.file); }}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:underline"
              aria-label={interpolate(labels.treeView, { path: node.path })}
              title={interpolate(labels.treeView, { path: node.path })}
            >
              <FileText className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--ink-faint)" }} />
              <span className="min-w-0 truncate" style={{ color: "var(--ink-mid)" }}>{node.name}</span>
              <span className="shrink-0" style={{ color: "var(--ink-faint)" }}>{node.file ? formatBytes(node.file.bytes.byteLength) : ""}</span>
              <Eye className="ml-auto h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity group-hover:opacity-70" style={{ color: "var(--ink-faint)" }} />
            </button>
          )}
          <button
            type="button"
            onClick={() => onDelete(descendants.map((file) => file.path), node.path)}
            disabled={disabled}
            className="shrink-0 rounded p-1 opacity-60 hover:bg-[var(--ink-line)] hover:opacity-100 disabled:opacity-30 sm:opacity-0 sm:group-hover:opacity-100"
            style={{ color: "var(--ink-mid)" }}
            aria-label={interpolate(labels.treeDelete, { path: node.path })}
            title={interpolate(labels.treeDelete, { path: node.path })}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
        {isDirectory && isExpanded && <div role="group">{node.children.map((child) => renderNode(child, depth + 1))}</div>}
      </div>
    );
  }

  return <div role="tree" className="space-y-0.5">{nodes.map((node) => renderNode(node, 0))}</div>;
}

function ConfigFileSelectionTree({
  files,
  selectedPaths,
  onToggleFile,
  onToggleDirectory,
  labels,
}: {
  files: ConfigVaultFile[];
  selectedPaths: Set<string>;
  onToggleFile: (path: string) => void;
  onToggleDirectory: (files: ConfigVaultFile[]) => void;
  labels: SnapshotMessages;
}) {
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const nodes = useMemo(() => buildFileTree(files), [files]);

  function toggleDirectory(path: string) {
    setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function renderNode(node: ConfigFileTreeNode, depth: number): ReactNode {
    const isDirectory = node.kind === "directory";
    const isExpanded = isDirectory && expandedPaths.has(node.path);
    const descendants = isDirectory ? filesInTreeNode(node) : node.file ? [node.file] : [];
    const selectedCount = descendants.filter((file) => selectedPaths.has(file.path)).length;
    const allSelected = descendants.length > 0 && selectedCount === descendants.length;
    const partiallySelected = selectedCount > 0 && !allSelected;
    return (
      <div key={node.path} role="treeitem" aria-expanded={isDirectory ? isExpanded : undefined}>
        <div className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs hover:bg-[var(--ink-wash)]" style={{ paddingLeft: `${depth * 16 + 4}px` }}>
          {isDirectory ? (
            <button
              type="button"
              onClick={() => toggleDirectory(node.path)}
              className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
              aria-label={`${isExpanded ? labels.treeCollapse : labels.treeExpand} ${node.path}`}
            >
              {isExpanded ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
              {isExpanded ? <FolderOpen className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--cinnabar)" }} /> : <Folder className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--ink-faint)" }} />}
              <span className="min-w-0 truncate" style={{ color: "var(--ink-strong)" }}>{node.name}</span>
            </button>
          ) : (
            <span className="flex min-w-0 flex-1 items-center gap-1.5">
              <FileText className="h-3.5 w-3.5 shrink-0" style={{ color: "var(--ink-faint)" }} />
              <span className="min-w-0 truncate" title={node.path} style={{ color: "var(--ink-mid)" }}>{node.name}</span>
            </span>
          )}
          <span className="shrink-0 text-[11px]" style={{ color: "var(--ink-faint)" }}>{isDirectory ? `${selectedCount}/${descendants.length}` : node.file ? formatBytes(node.file.bytes.byteLength) : ""}</span>
          <input
            type="checkbox"
            checked={allSelected}
            ref={(element) => { if (element) element.indeterminate = partiallySelected; }}
            onChange={() => isDirectory ? onToggleDirectory(descendants) : node.file && onToggleFile(node.file.path)}
            className="h-3.5 w-3.5 shrink-0 accent-[var(--cinnabar)]"
            aria-label={interpolate(labels.treeSelect, { path: node.path })}
          />
        </div>
        {isDirectory && isExpanded && <div role="group">{node.children.map((child) => renderNode(child, depth + 1))}</div>}
      </div>
    );
  }

  return <div role="tree" className="space-y-0.5">{nodes.map((node) => renderNode(node, 0))}</div>;
}

function ConfigFilePreviewDialog({
  file,
  onClose,
  labels,
}: {
  file: ConfigVaultFile;
  onClose: () => void;
  labels: SnapshotMessages;
}) {
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const previewBytes = file.bytes.subarray(0, CONFIG_PREVIEW_MAX_BYTES);
  const text = new TextDecoder("utf-8").decode(previewBytes);
  const isTruncated = file.bytes.byteLength > CONFIG_PREVIEW_MAX_BYTES;
  const isBinary = previewBytes.some((byte) => byte === 0);

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const releaseModal = pushModal();
    dialogRef.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
      if (event.key === "Tab") {
        const controls = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled), [tabindex]:not([tabindex='-1'])") ?? []);
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (first && last && !dialogRef.current?.contains(document.activeElement)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        } else if (first && last && event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (first && last && !event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      releaseModal();
      previouslyFocused.current?.focus();
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="config-file-preview-title"
        ref={dialogRef}
        className="flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border bg-[var(--background)] shadow-2xl"
        style={{ borderColor: "var(--ink-line)" }}
      >
        <header className="flex shrink-0 items-center gap-3 border-b px-5 py-4" style={{ borderColor: "var(--ink-line)" }}>
          <Eye className="h-5 w-5 shrink-0" style={{ color: "var(--cinnabar)" }} />
          <div className="min-w-0 flex-1">
            <h2 id="config-file-preview-title" className="truncate text-base font-semibold" style={{ color: "var(--ink-strong)" }}>{labels.previewTitle}</h2>
            <p className="mt-0.5 truncate text-xs" style={{ color: "var(--ink-faint)" }}>~/{file.path} · {formatBytes(file.bytes.byteLength)}</p>
          </div>
          <button type="button" onClick={onClose} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-[var(--ink-wash)]" aria-label={labels.previewClose}>
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 overflow-y-auto p-4 sm:p-5">
          {isBinary ? (
            <div className="rounded-xl border p-5 text-sm" style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }}>
              {labels.binaryFile}
            </div>
          ) : (
            <pre className="max-h-[68vh] overflow-auto whitespace-pre-wrap break-words rounded-xl border p-4 font-mono text-xs leading-6" style={{ borderColor: "var(--ink-line)", background: "var(--paper)", color: "var(--ink-strong)" }}>
              {text || labels.emptyFile}
            </pre>
          )}
          {!isBinary && isTruncated && <p className="mt-2 text-xs" style={{ color: "var(--ink-faint)" }}>{interpolate(labels.truncatedFile, { size: formatBytes(CONFIG_PREVIEW_MAX_BYTES) })}</p>}
        </div>
      </section>
    </div>
  );
}

function filterByGroups(files: ConfigVaultFile[], selectedGroups: Set<string>): ConfigVaultFile[] {
  return files.filter((file) => !isAgentWorkspaceSourcePath(file.path) && selectedGroups.has(configGroupKey(file.path)));
}

function filterPrivateConfigFiles(files: ConfigVaultFile[]): ConfigVaultFile[] {
  return files.filter((file) => !isAgentWorkspaceSourcePath(file.path));
}

function localizedGroupLabel(groupKey: GroupKey, categories: string[]): string {
  const index = GROUP_KEYS.indexOf(groupKey);
  return categories[index] ?? groupKey;
}

export function ConfigSnapshotsCard({
  member,
  localMode = false,
  syncOpen = false,
  onSyncOpenChange,
}: {
  member: boolean;
  localMode?: boolean;
  syncOpen?: boolean;
  onSyncOpenChange?: (open: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const snapshotMessages = t.space.configSnapshots;
  const queryClient = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);
  const syncDialogRef = useRef<HTMLElement>(null);
  const reviewDialogRef = useRef<HTMLElement>(null);
  const closeTimer = useRef<number | null>(null);
  const pendingGroupAction = useRef<GroupAction>(null);
  const unlockedSnapshots = useRef(new Map<string, UnlockedSnapshot>());
  const readingSnapshot = useRef(false);
  const mounted = useRef(true);
  const [snapshotFiles, setSnapshotFiles] = useState<SnapshotFiles>({});
  const [expandedSnapshotId, setExpandedSnapshotId] = useState<string | null>(null);
  const [name, setName] = useState(snapshotMessages.defaultName);
  const [password, setPassword] = useState("");
  const [snapshotAction, setSnapshotAction] = useState<SnapshotAction | null>(null);
  const [previewFile, setPreviewFile] = useState<{ snapshotId: string; file: ConfigVaultFile } | null>(null);
  const [confirmation, setConfirmation] = useState("");
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(() => new Set(GROUP_KEYS));
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const agentSyncCopy = useAgentSyncCopy(() => setMessage(snapshotMessages.agentCopied));
  const [syncPhase, setSyncPhase] = useState<"scanning" | "uploading" | "completed" | null>(null);
  const [pendingScan, setPendingScan] = useState<PendingScan | null>(null);
  const [selectedScanPaths, setSelectedScanPaths] = useState<Set<string>>(() => new Set());
  const closePreview = useCallback(() => setPreviewFile(null), []);
  const snapshots = useQuery({ queryKey: SNAPSHOTS_KEY, queryFn: getConfigSnapshots, enabled: !localMode });
  const existing = snapshots.data?.snapshots ?? [];
  const canUpload = !localMode && (member || existing.length <= 1);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; unlockedSnapshots.current.clear(); }; }, []);
  useEffect(() => {
    if (!snapshots.data && !localMode) return;
    const invalid = [...unlockedSnapshots.current].filter(([id, cached]) => {
      const summary = snapshots.data?.snapshots.find((item) => item.id === id);
      return localMode || !summary || summary.revision > cached.revision;
    }).map(([id]) => id);
    if (!invalid.length) return;
    for (const id of invalid) unlockedSnapshots.current.delete(id);
    setSnapshotFiles((current) => Object.fromEntries(Object.entries(current).filter(([id]) => !invalid.includes(id))));
    setPreviewFile((current) => current && invalid.includes(current.snapshotId) ? null : current);
  }, [snapshots.data, localMode]);

  const upload = useMutation({
    mutationFn: async (source: ConfigVaultFile[]) => {
      source = source.filter((file) => !isAgentWorkspaceSourcePath(file.path));
      if (source.length === 0) throw new Error("config_file_count_invalid");
      if (password.length < 8) throw new Error("config_password_too_short");
      if (password !== confirmation) throw new Error("config_password_mismatch");
      if (!member && existing.length > 0) {
        const currentSummary = existing[0];
        const { snapshot: currentSnapshot } = await getConfigSnapshot(currentSummary.id);
        const current = filterPrivateConfigFiles(await decryptConfigSnapshot(currentSnapshot.envelope, password));
        const selectedPaths = new Set(source.map((file) => file.path));
        const merged = [
          ...current.filter((file) => !selectedPaths.has(file.path)),
          ...source,
        ];
        const mergedEncrypted = await encryptConfigSnapshot(merged, password);
        return updateConfigSnapshot(currentSnapshot.id, {
          name: name.trim() || currentSnapshot.name || snapshotMessages.defaultName,
          fileCount: mergedEncrypted.fileCount,
          envelopeVersion: 1,
          envelope: mergedEncrypted.envelope,
          revision: currentSnapshot.revision,
        });
      }
      const encrypted = await encryptConfigSnapshot(source, password);
      return createConfigSnapshot({
        name: name.trim() || snapshotMessages.defaultName,
        fileCount: encrypted.fileCount,
        envelopeVersion: 1,
        envelope: encrypted.envelope,
      });
    },
    onSuccess: (result) => {
      const updated = result.snapshot;
      unlockedSnapshots.current.delete(updated.id);
      setSnapshotFiles((current) => {
        const next = { ...current };
        delete next[updated.id];
        return next;
      });
      if (expandedSnapshotId === updated.id) setExpandedSnapshotId(null);
      setPassword("");
      setConfirmation("");
      if (fileInput.current) fileInput.current.value = "";
      setSyncPhase("completed");
      setMessage(snapshotMessages.saved);
      void queryClient.invalidateQueries({ queryKey: SNAPSHOTS_KEY });
      void queryClient.invalidateQueries({ queryKey: STORAGE_USAGE_KEY });
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
      closeTimer.current = window.setTimeout(() => {
        closeTimer.current = null;
        setSyncPhase(null);
        onSyncOpenChange?.(false);
      }, 1200);
    },
    onError: (error) => {
      setSyncPhase(null);
      setMessage(errorMessage(error, snapshotMessages));
    },
  });

  const remove = useMutation({
    mutationFn: ({ snapshotId, revision }: { snapshotId: string; revision: number }) => deleteConfigSnapshot(snapshotId, revision),
    onSuccess: (_, { snapshotId }) => {
      unlockedSnapshots.current.delete(snapshotId);
      setSnapshotFiles((current) => {
        const next = { ...current };
        delete next[snapshotId];
        return next;
      });
      if (expandedSnapshotId === snapshotId) setExpandedSnapshotId(null);
      setPreviewFile((current) => current?.snapshotId === snapshotId ? null : current);
      setMessage(snapshotMessages.deleted);
      void queryClient.invalidateQueries({ queryKey: SNAPSHOTS_KEY });
      void queryClient.invalidateQueries({ queryKey: STORAGE_USAGE_KEY });
    },
    onError: (error) => setMessage(errorMessage(error, snapshotMessages)),
  });

  function unlockSnapshot(snapshot: ConfigSnapshotSummary) {
    if (expandedSnapshotId === snapshot.id && snapshotFiles[snapshot.id]) {
      setExpandedSnapshotId(null);
      return;
    }
    setMessage(null);
    if (unlockedSnapshots.current.get(snapshot.id)?.revision === snapshot.revision) {
      setExpandedSnapshotId(snapshot.id);
      return;
    }
    setSnapshotAction({ kind: "expand", snapshot });
  }

  async function restoreFiles(restored: ConfigVaultFile[], snapshotName: string, destination: "home" | "folder" = "home") {
    if (isDesktopRuntime()) {
      const { desktopRestoreConfigFiles, desktopRestoreConfigFilesToHome } = await import("../desktop/configFiles");
      if (!mounted.current) return;
      const count = destination === "home"
        ? await desktopRestoreConfigFilesToHome(restored, locale)
        : await desktopRestoreConfigFiles(restored, locale);
      setMessage(count > 0 ? interpolate(snapshotMessages.restored, { count }) : snapshotMessages.restoreCancelled);
      return;
    }
    downloadConfigFiles(restored, snapshotName);
    setMessage(snapshotMessages.downloaded);
  }

  function restoreSnapshot(snapshot: ConfigSnapshotSummary, destination: "home" | "folder" = "home") {
    startReadAction({ kind: "restore", snapshot, destination });
  }

  async function revokeAgentAccess(snapshot: ConfigSnapshotSummary) {
    if (readingSnapshot.current || busyId !== null) return;
    readingSnapshot.current = true;
    setBusyId(`revoke:${snapshot.id}`);
    try {
      if (!await confirmAction(interpolate(snapshotMessages.revokeAgentAccessConfirm, { name: snapshot.name }))) return;
      await revokeConfigSyncGrants(snapshot.id);
      if (mounted.current) {
        agentSyncCopy.clear();
        setMessage(snapshotMessages.agentAccessRevoked);
      }
    } catch (error) {
      if (mounted.current) setMessage(errorMessage(error, snapshotMessages));
    } finally {
      readingSnapshot.current = false;
      if (mounted.current) setBusyId(null);
    }
  }

  type ReadAction = Extract<SnapshotAction, { kind: "restore" | "agent" }>;
  function forgetUnlockedSnapshot(id: string) {
    unlockedSnapshots.current.delete(id);
    setSnapshotFiles((current) => { const next = { ...current }; delete next[id]; return next; });
    setPreviewFile((current) => current?.snapshotId === id ? null : current);
    void queryClient.invalidateQueries({ queryKey: SNAPSHOTS_KEY });
  }
  async function prepareAgentInstructions(action: ReadAction, unlocked: UnlockedSnapshot) {
    const grant = await createConfigSyncGrant(action.snapshot.id, unlocked.revision).catch((error) => {
      if (mounted.current && error instanceof ApiError && (error.code === "config_snapshot_conflict" || error.code === "snapshot_not_found")) forgetUnlockedSnapshot(action.snapshot.id);
      throw error;
    });
    if (!mounted.current) throw new DOMException("Copy cancelled", "AbortError");
    if (grant.snapshotId !== action.snapshot.id || grant.revision !== unlocked.revision) throw new ApiError(409, "Snapshot changed", "config_snapshot_conflict");
    return configAgentSyncPrompt(grant, unlocked.decryptionKey);
  }
  async function executeReadAction(action: ReadAction, unlocked: UnlockedSnapshot) {
    if (action.kind === "agent") {
      return agentSyncCopy.copy(() => prepareAgentInstructions(action, unlocked));
    }
    // Reuse plaintext only for the exact revision the user unlocked. A metadata
    // check avoids downloading/decrypting the whole encrypted archive again.
    const latest = (await getConfigSnapshots()).snapshots.find((item) => item.id === action.snapshot.id);
    if (!latest || latest.revision !== unlocked.revision) {
      if (mounted.current) forgetUnlockedSnapshot(action.snapshot.id);
      throw new ApiError(409, "Snapshot changed", "config_snapshot_conflict");
    }
    if (!mounted.current) return;
    const restored = action.groupKey ? unlocked.files.filter((file) => configGroupKey(file.path) === action.groupKey) : unlocked.files;
    if (!restored.length) throw new Error("config_no_files_found");
    await restoreFiles(restored, latest.name, action.destination);
  }

  function startReadAction(action: ReadAction) {
    if (readingSnapshot.current || busyId !== null) return;
    setMessage(null);
    const cached = unlockedSnapshots.current.get(action.snapshot.id);
    if (!cached || cached.revision !== action.snapshot.revision) { setSnapshotAction(action); return; }
    readingSnapshot.current = true;
    setBusyId(`${action.kind}:${action.snapshot.id}`);
    void executeReadAction(action, cached).catch((error) => {
      if (mounted.current) setMessage(errorMessage(error, snapshotMessages));
    }).finally(() => {
      readingSnapshot.current = false;
      if (mounted.current) setBusyId(null);
    });
  }

  function openScanPreview(scanned: ConfigVaultFile[]) {
    if (scanned.length === 0) {
      setMessage(snapshotMessages.selectedCategoriesEmpty);
      return;
    }
    setPendingScan({ files: scanned });
    setSelectedScanPaths(new Set(scanned.map((file) => file.path)));
  }

  function updateGroup(snapshot: ConfigSnapshotSummary, groupKey: string, selected: ConfigVaultFile[]) {
    if (selected.length === 0) return;
    const replacements = selected.filter((file) => !isAgentWorkspaceSourcePath(file.path) && configGroupKey(file.path) === groupKey);
    if (replacements.length === 0) {
      setMessage(interpolate(snapshotMessages.categoryNoFiles, { category: localizedGroupLabel(groupKey as GroupKey, t.space.cloneCategories) }));
      return;
    }
    setMessage(null);
    setSnapshotAction({ kind: "update", snapshot, groupKey, replacements });
  }

  function deleteTreeNode(snapshot: ConfigSnapshotSummary, groupKey: string, paths: string[], label: string) {
    if (paths.length === 0) return;
    setMessage(null);
    setSnapshotAction({ kind: "delete", snapshot, groupKey, paths, label });
  }

  async function unlockCurrentSnapshot(id: string, migrationPassword: string) {
    const { snapshot } = await getConfigSnapshot(id);
    const decrypted = await unlockConfigSnapshot(snapshot.envelope, migrationPassword);
    if (!mounted.current) throw new DOMException("Unlock cancelled", "AbortError");
    const latest = queryClient.getQueryData<{ snapshots: ConfigSnapshotSummary[] }>(SNAPSHOTS_KEY)?.snapshots.find((item) => item.id === id);
    if (latest && latest.revision > snapshot.revision) throw new ApiError(409, "Snapshot changed", "config_snapshot_conflict");
    const current = filterPrivateConfigFiles(decrypted.files);
    const unlocked = { files: current, decryptionKey: decrypted.decryptionKey, revision: snapshot.revision };
    unlockedSnapshots.current.set(snapshot.id, unlocked);
    setSnapshotFiles((filesBySnapshot) => ({ ...filesBySnapshot, [snapshot.id]: current }));
    // The detail may be newer than the list the user clicked. Keep both revision
    // checks in agreement without putting decrypted data or keys in query caches.
    const { envelope: _envelope, ...summary } = snapshot;
    queryClient.setQueryData<{ snapshots: ConfigSnapshotSummary[] }>(SNAPSHOTS_KEY, (data) => data && {
      snapshots: data.snapshots.map((item) => item.id === id && item.revision <= summary.revision ? summary : item),
    });
    return { snapshot, current, unlocked };
  }

  async function runSnapshotAction(migrationPassword: string) {
    if (!snapshotAction) return;
    const action = snapshotAction;
    setBusyId(`${action.kind}:${action.snapshot.id}`);
    setMessage(null);
    try {
      if (action.kind === "agent") {
        // Start writing in the form's submit gesture, before fetching/decrypting.
        await agentSyncCopy.copy(async () => {
          const { unlocked } = await unlockCurrentSnapshot(action.snapshot.id, migrationPassword);
          return prepareAgentInstructions(action, unlocked);
        });
        return;
      }
      const { snapshot, current, unlocked } = await unlockCurrentSnapshot(action.snapshot.id, migrationPassword);
      if (action.kind === "expand") {
        setExpandedSnapshotId(snapshot.id);
        return;
      }
      if (action.kind === "restore") {
        await executeReadAction(action, unlocked);
        return;
      }
      if (action.kind === "delete") {
        const pathsToDelete = new Set(action.paths);
        const remaining = current.filter((file) => !pathsToDelete.has(file.path));
        setPreviewFile((selected) => selected && selected.snapshotId === snapshot.id && pathsToDelete.has(selected.file.path) ? null : selected);
        if (remaining.length === 0) {
          await deleteConfigSnapshot(snapshot.id, snapshot.revision);
          unlockedSnapshots.current.delete(snapshot.id);
          setSnapshotFiles((filesBySnapshot) => {
            const next = { ...filesBySnapshot };
            delete next[snapshot.id];
            return next;
          });
          queryClient.setQueryData<{ snapshots: ConfigSnapshotSummary[] }>(SNAPSHOTS_KEY, (currentData) => currentData && {
            snapshots: currentData.snapshots.filter((item) => item.id !== snapshot.id),
          });
          setExpandedSnapshotId(null);
          setMessage(snapshotMessages.deletedAll);
        } else {
          const encrypted = await encryptConfigSnapshot(remaining, migrationPassword);
          const { snapshot: updated } = await updateConfigSnapshot(snapshot.id, {
            name: snapshot.name,
            fileCount: encrypted.fileCount,
            envelopeVersion: 1,
            envelope: encrypted.envelope,
            revision: snapshot.revision,
          });
          unlockedSnapshots.current.delete(snapshot.id);
          setSnapshotFiles((filesBySnapshot) => ({ ...filesBySnapshot, [snapshot.id]: remaining }));
          queryClient.setQueryData<{ snapshots: ConfigSnapshotSummary[] }>(SNAPSHOTS_KEY, (currentData) => currentData && {
            snapshots: currentData.snapshots.map((item) => item.id === snapshot.id ? updated : item),
          });
          setMessage(interpolate(snapshotMessages.deletedFiles, { count: action.paths.length }));
        }
        void queryClient.invalidateQueries({ queryKey: SNAPSHOTS_KEY });
        void queryClient.invalidateQueries({ queryKey: STORAGE_USAGE_KEY });
        return;
      }
      const replacementPaths = new Set(action.replacements.map((file) => file.path));
      const merged = [
        ...current.filter((file) => configGroupKey(file.path) !== action.groupKey || !replacementPaths.has(file.path)),
        ...action.replacements,
      ];
      const encrypted = await encryptConfigSnapshot(merged, migrationPassword);
      const { snapshot: updated } = await updateConfigSnapshot(snapshot.id, {
        name: snapshot.name,
        fileCount: encrypted.fileCount,
        envelopeVersion: 1,
        envelope: encrypted.envelope,
        revision: snapshot.revision,
      });
      unlockedSnapshots.current.delete(snapshot.id);
      setSnapshotFiles((filesBySnapshot) => ({ ...filesBySnapshot, [snapshot.id]: merged }));
      queryClient.setQueryData<{ snapshots: ConfigSnapshotSummary[] }>(SNAPSHOTS_KEY, (currentData) => currentData && {
        snapshots: currentData.snapshots.map((item) => item.id === snapshot.id ? updated : item),
      });
      setMessage(interpolate(snapshotMessages.updated, { category: localizedGroupLabel(action.groupKey as GroupKey, t.space.cloneCategories) }));
      void queryClient.invalidateQueries({ queryKey: SNAPSHOTS_KEY });
      void queryClient.invalidateQueries({ queryKey: STORAGE_USAGE_KEY });
    } finally {
      setBusyId(null);
    }
  }

  function restoreGroup(snapshot: ConfigSnapshotSummary, groupKey: string) {
    startReadAction({ kind: "restore", snapshot, destination: "home", groupKey });
  }

  async function pickFiles() {
    setMessage(null);
    try {
      if (isDesktopRuntime()) {
        const { desktopPickConfigFiles } = await import("../desktop/configFiles");
        const selected = await desktopPickConfigFiles();
        if (selected.length > 0) openScanPreview(filterByGroups(selected, selectedGroups));
      } else {
        pendingGroupAction.current = null;
        if (fileInput.current) fileInput.current.value = "";
        fileInput.current?.click();
      }
    } catch (error) {
      setMessage(errorMessage(error, snapshotMessages));
    }
  }

  async function pickFilesForGroup(snapshot: ConfigSnapshotSummary, groupKey: string) {
    setMessage(null);
    try {
      if (isDesktopRuntime()) {
        setBusyId(`scan:${snapshot.id}:${groupKey}`);
        const { desktopScanConfigFiles } = await import("../desktop/configFiles");
        const scanned = await desktopScanConfigFiles();
        const replacements = scanned.filter((file) => configGroupKey(file.path) === groupKey);
        if (replacements.length === 0) {
          setMessage(interpolate(snapshotMessages.categoryNoFiles, { category: localizedGroupLabel(groupKey as GroupKey, t.space.cloneCategories) }));
          return;
        }
        updateGroup(snapshot, groupKey, replacements);
      } else {
        pendingGroupAction.current = { snapshotId: snapshot.id, groupKey };
        if (fileInput.current) fileInput.current.value = "";
        fileInput.current?.click();
      }
    } catch (error) {
      setMessage(errorMessage(error, snapshotMessages));
    } finally {
      setBusyId(null);
    }
  }

  async function handleFileInput(fileList: FileList | null) {
    try {
      const selected = await filesFromFileList(fileList ?? []);
      const action = pendingGroupAction.current;
      pendingGroupAction.current = null;
      if (action) {
        const snapshot = existing.find((item) => item.id === action.snapshotId);
        if (snapshot) await updateGroup(snapshot, action.groupKey, selected);
      } else {
        if (selected.length > 0) openScanPreview(filterByGroups(selected, selectedGroups));
      }
    } catch (error) {
      setMessage(errorMessage(error, snapshotMessages));
    }
  }

  function validateSyncSettings() {
    if (selectedGroups.size === 0) {
      setMessage(snapshotMessages.categoryRequired);
      return false;
    }
    if (password.length < 8) {
      setMessage(snapshotMessages.errorPasswordShort);
      return false;
    }
    if (password !== confirmation) {
      setMessage(snapshotMessages.passwordMismatch);
      return false;
    }
    return true;
  }

  async function scanAndUpload() {
    setMessage(null);
    if (!validateSyncSettings()) return;
    setSyncPhase("scanning");
    try {
      const { desktopScanConfigFiles } = await import("../desktop/configFiles");
      const scanned = filterByGroups(await desktopScanConfigFiles(), selectedGroups);
      if (scanned.length === 0) {
        setSyncPhase(null);
        setMessage(snapshotMessages.selectedCategoriesEmpty);
        return;
      }
      openScanPreview(scanned);
      setSyncPhase(null);
    } catch (error) {
      setSyncPhase(null);
      setMessage(errorMessage(error, snapshotMessages));
    }
  }

  function cancelPendingScan() {
    setPendingScan(null);
    setSelectedScanPaths(new Set());
    setMessage(snapshotMessages.uploadCancelled);
  }

  function confirmPendingScan() {
    if (!pendingScan) return;
    const scanned = pendingScan.files.filter((file) => selectedScanPaths.has(file.path));
    if (scanned.length === 0) return;
    setPendingScan(null);
    setSelectedScanPaths(new Set());
    setSyncPhase("uploading");
    upload.mutate(scanned);
  }

  function setAllScanFilesSelected(selected: boolean) {
    setSelectedScanPaths(selected ? new Set(pendingScan?.files.map((file) => file.path) ?? []) : new Set());
  }

  function toggleScanFile(path: string) {
    setSelectedScanPaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function toggleScanDirectory(files: ConfigVaultFile[]) {
    setSelectedScanPaths((current) => {
      const next = new Set(current);
      const allSelected = files.every((file) => next.has(file.path));
      for (const file of files) {
        if (allSelected) next.delete(file.path);
        else next.add(file.path);
      }
      return next;
    });
  }

  const selectedPendingFiles = pendingScan?.files.filter((file) => selectedScanPaths.has(file.path)) ?? [];
  const selectedPendingBytes = selectedPendingFiles.reduce((total, file) => total + file.bytes.byteLength, 0);

  function closeSyncDialog() {
    if (upload.isPending || syncPhase === "scanning") return;
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
    setPendingScan(null);
    setSelectedScanPaths(new Set());
    setSyncPhase(null);
    setPassword("");
    setConfirmation("");
    onSyncOpenChange?.(false);
  }

  const modalActions = useRef({ closeSyncDialog, cancelPendingScan });
  modalActions.current = { closeSyncDialog, cancelPendingScan };
  const reviewing = pendingScan !== null;

  useEffect(() => () => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
  }, []);

  useEffect(() => {
    if (!syncOpen && !reviewing) return;
    const dialog = reviewing ? reviewDialogRef.current : syncDialogRef.current;
    const previousFocus = document.activeElement as HTMLElement | null;
    const releaseModal = pushModal();
    const controls = () => Array.from(dialog?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled)") ?? []);
    controls()[0]?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (reviewing) modalActions.current.cancelPendingScan();
        else modalActions.current.closeSyncDialog();
      }
      if (event.key === "Tab") {
        const elements = controls();
        const first = elements[0];
        const last = elements[elements.length - 1];
        if (!dialog?.contains(document.activeElement) || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        }
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      releaseModal();
      previousFocus?.focus();
    };
  }, [syncOpen, reviewing]);

  function toggleGroup(groupKey: GroupKey) {
    setSelectedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  }

  return (
    <>
      {agentSyncCopy.dialog}
      {pendingScan && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]">
          <section ref={reviewDialogRef} role="dialog" aria-modal="true" aria-labelledby="config-sync-review-title" className="max-h-[92vh] w-full max-w-md overflow-y-auto rounded-2xl border bg-[var(--background)] shadow-2xl" style={{ borderColor: "var(--ink-line)" }}>
            <div className="flex items-start gap-3 border-b px-5 py-4" style={{ borderColor: "var(--ink-line)" }}>
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl" style={{ background: "var(--cinnabar-soft)", color: "var(--cinnabar)" }}><ShieldCheck className="h-5 w-5" /></span>
              <div className="min-w-0">
                <h2 id="config-sync-review-title" className="kn-heading-cn text-base font-semibold" style={{ color: "var(--ink-black)" }}>{t.space.syncReviewTitle}</h2>
                <p className="mt-1 text-xs leading-5" style={{ color: "var(--ink-mid)" }}>{t.space.syncReviewDescription}</p>
              </div>
            </div>
            <div className="space-y-3 px-5 py-4">
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-xl border px-3 py-2.5" style={{ borderColor: "var(--ink-line)", background: "var(--paper)" }}>
                  <p className="text-[11px]" style={{ color: "var(--ink-faint)" }}>{t.space.syncReviewFilesLabel}</p>
                  <p className="mt-0.5 text-sm font-semibold" style={{ color: "var(--ink-strong)" }}>{t.space.syncReviewFiles.replace("{count}", String(selectedPendingFiles.length))}</p>
                </div>
                <div className="rounded-xl border px-3 py-2.5" style={{ borderColor: "var(--ink-line)", background: "var(--paper)" }}>
                  <p className="text-[11px]" style={{ color: "var(--ink-faint)" }}>{t.space.syncReviewSizeLabel}</p>
                  <p className="mt-0.5 text-sm font-semibold" style={{ color: "var(--ink-strong)" }}>{t.space.syncReviewSize.replace("{size}", formatBytes(selectedPendingBytes))}</p>
                </div>
              </div>
              <div>
                <div className="mb-1.5 flex items-center justify-between gap-3">
                  <p className="text-xs font-semibold" style={{ color: "var(--ink-strong)" }}>{t.space.syncReviewGroupsLabel}</p>
                  <div className="flex gap-2 text-[11px]">
                    <button type="button" onClick={() => setAllScanFilesSelected(true)} className="rounded-full px-2 py-1 hover:bg-[var(--ink-wash)]" style={{ color: "var(--cinnabar)" }}>{t.space.syncReviewSelectAll}</button>
                    <button type="button" onClick={() => setAllScanFilesSelected(false)} className="rounded-full px-2 py-1 hover:bg-[var(--ink-wash)]" style={{ color: "var(--ink-mid)" }}>{t.space.syncReviewClearAll}</button>
                  </div>
                </div>
                <div className="max-h-56 overflow-y-auto rounded-xl border p-2" style={{ borderColor: "var(--ink-line)" }}>
                    <ConfigFileSelectionTree
                      files={pendingScan.files}
                      selectedPaths={selectedScanPaths}
                      onToggleFile={toggleScanFile}
                      onToggleDirectory={toggleScanDirectory}
                      labels={snapshotMessages}
                    />
                </div>
              </div>
              <div className="flex items-start gap-2 rounded-xl border px-3 py-2.5 text-xs leading-5" style={{ borderColor: "var(--cinnabar-soft)", background: "var(--cinnabar-wash)", color: "var(--ink-mid)" }}>
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--cinnabar)" }} />
                <span>{t.space.syncReviewWarning}</span>
              </div>
            </div>
            <div className="flex justify-end gap-2 border-t px-5 py-3" style={{ borderColor: "var(--ink-line)" }}>
              <button type="button" onClick={cancelPendingScan} className="rounded-full border px-4 py-2 text-sm font-medium transition hover:bg-[var(--ink-wash)]" style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }}>{t.space.syncReviewCancel}</button>
              <button type="button" onClick={confirmPendingScan} disabled={selectedPendingFiles.length === 0} className="rounded-full px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50" style={{ background: "var(--cinnabar)" }}>{t.space.syncReviewUpload}</button>
            </div>
          </section>
        </div>
      )}
      {previewFile && <ConfigFilePreviewDialog file={previewFile.file} onClose={closePreview} labels={snapshotMessages} />}
      {snapshotAction && <ConfigSnapshotPasswordDialog
        snapshotName={snapshotAction.kind === "delete"
          ? `${snapshotAction.snapshot.name} · ${interpolate(snapshotMessages.deleteGroupAria, { category: snapshotAction.label })}`
          : snapshotAction.snapshot.name}
        onSubmit={runSnapshotAction}
        onClose={() => setSnapshotAction(null)}
        formatError={(error) => errorMessage(error, snapshotMessages)}
      />}
      <input ref={fileInput} type="file" multiple className="sr-only" onChange={(event) => void handleFileInput(event.target.files)} />
      {syncOpen && (
        <div inert={reviewing} className="fixed inset-0 z-[90] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]" onMouseDown={(event) => { if (event.target === event.currentTarget) closeSyncDialog(); }}>
          <section ref={syncDialogRef} role="dialog" aria-modal="true" aria-labelledby="config-sync-title" className="relative max-h-[92vh] w-full max-w-2xl overflow-y-auto rounded-2xl border bg-[var(--background)] p-5 shadow-2xl sm:p-6" style={{ borderColor: "var(--ink-line)" }}>
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl" style={{ background: "var(--cinnabar-soft)", color: "var(--cinnabar)" }}><Archive className="h-5 w-5" /></div>
              <div className="min-w-0 flex-1"><h2 id="config-sync-title" className="kn-heading-cn text-xl font-bold" style={{ color: "var(--ink-black)" }}>{t.space.syncDialogTitle}</h2><p className="mt-1.5 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{t.space.syncDialogDescription}</p></div>
              <button type="button" onClick={closeSyncDialog} disabled={upload.isPending || syncPhase === "scanning"} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg hover:bg-[var(--ink-wash)] disabled:opacity-50" aria-label={t.space.syncCancel}><X className="h-4 w-4" /></button>
            </div>
            {!member && existing.length > 0 && <p className="mt-3 text-xs leading-5" style={{ color: "var(--ink-faint)" }}>{t.space.syncUpdateHint}</p>}
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <label className="block text-sm font-medium" style={{ color: "var(--ink-strong)" }}>{t.space.syncNameLabel}<input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} className="mt-1.5 w-full rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "var(--ink-line)", background: "var(--paper)" }} /></label>
              <div className="hidden sm:block" />
              <label className="block text-sm font-medium" style={{ color: "var(--ink-strong)" }}>{t.space.syncPasswordLabel}<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" className="mt-1.5 w-full rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "var(--ink-line)", background: "var(--paper)" }} /></label>
              <label className="block text-sm font-medium" style={{ color: "var(--ink-strong)" }}>{t.space.syncConfirmLabel}<input type="password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" className="mt-1.5 w-full rounded-lg border px-3 py-2 text-sm" style={{ borderColor: "var(--ink-line)", background: "var(--paper)" }} /></label>
            </div>
            <div className="mt-5 flex items-center justify-between gap-3"><p className="text-sm font-semibold" style={{ color: "var(--ink-strong)" }}>{t.space.syncSelectLabel}</p><div className="flex gap-2 text-xs"><button type="button" onClick={() => setSelectedGroups(new Set(GROUP_KEYS))} className="rounded-full border px-3 py-1.5 hover:bg-[var(--ink-wash)]" style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}>{t.space.syncSelectAll}</button><button type="button" onClick={() => setSelectedGroups(new Set())} className="rounded-full border px-3 py-1.5 hover:bg-[var(--ink-wash)]" style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }}>{t.space.syncClearAll}</button></div></div>
            <div className="mt-2 grid gap-1.5 sm:grid-cols-2">{GROUP_KEYS.map((groupKey, index) => { const checked = selectedGroups.has(groupKey); return <label key={groupKey} className="flex cursor-pointer items-start gap-2 rounded-lg border px-2.5 py-1.5 text-xs leading-4 transition sm:text-sm" style={{ borderColor: checked ? "var(--cinnabar)" : "var(--ink-line)", background: checked ? "var(--cinnabar-wash)" : "transparent", color: "var(--ink-strong)" }}><input type="checkbox" checked={checked} onChange={() => toggleGroup(groupKey)} className="sr-only" /><span className="mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border" style={{ borderColor: checked ? "var(--cinnabar)" : "var(--ink-faint)", background: checked ? "var(--cinnabar)" : "transparent", color: "white" }}>{checked && <Check className="h-2.5 w-2.5" />}</span><span>{t.space.cloneCategories[index] ?? groupKey}</span></label>; })}</div>
            <p className="mt-2 text-xs" style={{ color: "var(--ink-faint)" }}>{t.space.syncSelected.replace("{count}", String(selectedGroups.size))}</p>
            <div className="mt-5 rounded-xl border p-3 text-xs leading-5" style={{ borderColor: "var(--cinnabar-soft)", background: "var(--cinnabar-wash)", color: "var(--ink-mid)" }}><div className="flex items-start gap-2"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" style={{ color: "var(--cinnabar)" }} /><span>{t.space.cloneSecurity}</span></div></div>
            {message && <p className="mt-3 text-sm" style={{ color: "var(--cinnabar)" }}>{message}</p>}
            <div className="mt-5 flex flex-wrap items-center gap-2">
              <div className="min-h-10 min-w-0 flex-1 text-xs" style={{ color: "var(--ink-mid)" }}>
                {syncPhase && <div className="flex items-center gap-2" role="status" aria-live="polite">
                  {syncPhase === "completed" ? <Check className="h-4 w-4 shrink-0" style={{ color: "var(--cinnabar)" }} /> : <LoaderCircle className="h-4 w-4 shrink-0 animate-spin" style={{ color: "var(--cinnabar)" }} />}
                  {syncPhase === "scanning" ? t.space.syncStatusScanning : syncPhase === "uploading" ? t.space.syncStatusUploading : t.space.syncStatusCompleted}
                </div>}
              </div>
              <div className="flex flex-wrap justify-end gap-2">
                <button type="button" onClick={() => void pickFiles()} disabled={!canUpload || upload.isPending || syncPhase === "scanning" || selectedGroups.size === 0} className="inline-flex items-center gap-2 rounded-full border px-4 py-2 text-sm font-medium transition hover:bg-[var(--ink-wash)] disabled:cursor-not-allowed disabled:opacity-50" style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}>
                  <Upload className="h-4 w-4" />{t.space.syncManual}
                </button>
                {isDesktopRuntime() && <button type="button" onClick={() => void scanAndUpload()} disabled={!canUpload || upload.isPending || syncPhase === "scanning" || selectedGroups.size === 0} className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold text-white transition disabled:cursor-not-allowed disabled:opacity-50" style={{ background: "var(--cinnabar)" }}>
                  {upload.isPending ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <ScanLine className="h-4 w-4" />}{t.space.syncScan}
                </button>}
              </div>
            </div>
          </section>
        </div>
      )}
      <PaperCard className="p-5 sm:p-6">
        <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide" style={{ color: "var(--ink-faint)" }}><KeyRound className="h-4 w-4" />{snapshotMessages.savedTitle}</div>
        <p className="mt-2 text-xs" style={{ color: "var(--ink-faint)" }}>{t.space.syncSnapshotsHint}</p>
        {isDesktopRuntime() && <p className="mt-2 text-xs leading-5" style={{ color: "var(--ink-mid)" }}>{snapshotMessages.crossPlatformHint}</p>}
        {localMode && <p className="mt-3 text-sm" style={{ color: "var(--ink-mid)" }}>{t.space.syncCloudOnly}</p>}
        {snapshots.isLoading && <p className="mt-3 text-sm" style={{ color: "var(--ink-faint)" }}>{snapshotMessages.loading}</p>}
        {!snapshots.isLoading && existing.length === 0 && <p className="mt-3 text-sm" style={{ color: "var(--ink-faint)" }}>{snapshotMessages.empty}</p>}
        <div className="mt-3 space-y-2">
          {existing.map((snapshot) => {
            const unlocked = snapshotFiles[snapshot.id];
            const expanded = expandedSnapshotId === snapshot.id;
            const groups = unlocked ? groupedFiles(unlocked) : [];
            return (
              <div key={snapshot.id} className="rounded-xl border p-3" style={{ borderColor: "var(--ink-line)" }}>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium" style={{ color: "var(--ink-strong)" }}>{snapshot.name}</p>
                    <p className="mt-1 text-xs" style={{ color: "var(--ink-faint)" }}>{interpolate(snapshotMessages.filesSummary, { count: snapshot.fileCount, size: formatBytes(snapshot.bytes), date: displayDate(snapshot.updatedAt) })}</p>
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    <button type="button" onClick={() => void unlockSnapshot(snapshot)} disabled={busyId !== null} className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium hover:bg-[var(--ink-wash)] disabled:opacity-50" style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}>
                      {busyId === `unlock:${snapshot.id}` ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} />}
                      {expanded ? snapshotMessages.collapse : snapshotMessages.expandUnlock}
                    </button>
                    <LocalSyncMenu label={snapshotMessages.restoreAll} disabled={busyId !== null} sensitive download={!isDesktopRuntime()} onKoinote={() => restoreSnapshot(snapshot)} onAgent={() => startReadAction({ kind: "agent", snapshot })} />
                    <button type="button" onClick={() => void revokeAgentAccess(snapshot)} disabled={busyId !== null} className="rounded-full border px-3 py-1.5 text-xs hover:bg-[var(--ink-wash)] disabled:opacity-50" style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }}>{snapshotMessages.revokeAgentAccess}</button>
                    {isDesktopRuntime() && <button type="button" onClick={() => void restoreSnapshot(snapshot, "folder")} disabled={busyId !== null} className="inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs hover:bg-[var(--ink-wash)] disabled:opacity-50" style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }}>{snapshotMessages.chooseFolder}</button>}
                    <button type="button" onClick={() => void (async () => { if (await confirmAction(interpolate(snapshotMessages.deleteSnapshotConfirm, { name: snapshot.name }))) remove.mutate({ snapshotId: snapshot.id, revision: snapshot.revision }); })()} disabled={remove.isPending} className="inline-flex items-center justify-center rounded-full border px-2.5 py-1.5 text-xs hover:bg-[var(--ink-wash)] disabled:opacity-50" style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }} aria-label={interpolate(snapshotMessages.deleteSnapshotAria, { name: snapshot.name })}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
                {expanded && unlocked && (
                  <div className="mt-4 space-y-3 border-t pt-4" style={{ borderColor: "var(--ink-line)" }}>
                    {groups.map(([groupKey, group]) => (
                      <div key={groupKey} className="rounded-lg border p-3" style={{ borderColor: "var(--ink-line)" }}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="flex items-center gap-2 text-sm font-medium" style={{ color: "var(--ink-strong)" }}>
                            <Files className="h-4 w-4" style={{ color: "var(--ink-faint)" }} />
                            {localizedGroupLabel(groupKey, t.space.cloneCategories)}
                            <span className="text-xs font-normal" style={{ color: "var(--ink-faint)" }}>{interpolate(snapshotMessages.groupFiles, { count: group.length })}</span>
                          </div>
                          <div className="flex gap-2">
                            <button type="button" onClick={() => void restoreGroup(snapshot, groupKey)} disabled={busyId !== null} className="rounded-full border px-3 py-1.5 text-xs font-medium hover:bg-[var(--ink-wash)] disabled:opacity-50" style={{ borderColor: "var(--ink-line)", color: "var(--ink-strong)" }}>{isDesktopRuntime() ? snapshotMessages.restoreGroup : snapshotMessages.downloadAll}</button>
                            {isDesktopRuntime() && <button type="button" onClick={() => void pickFilesForGroup(snapshot, groupKey)} disabled={busyId !== null} className="rounded-full border px-3 py-1.5 text-xs hover:bg-[var(--ink-wash)] disabled:opacity-50" style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }}>{snapshotMessages.updateFromLocal}</button>}
                            <button type="button" onClick={() => deleteTreeNode(snapshot, groupKey, group.map((file) => file.path), localizedGroupLabel(groupKey, t.space.cloneCategories))} disabled={busyId !== null} className="inline-flex items-center justify-center rounded-full border px-2 py-1.5 text-xs hover:bg-[var(--ink-wash)] disabled:opacity-50" style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }} aria-label={interpolate(snapshotMessages.deleteGroupAria, { category: localizedGroupLabel(groupKey, t.space.cloneCategories) })} title={interpolate(snapshotMessages.deleteGroupAria, { category: localizedGroupLabel(groupKey, t.space.cloneCategories) })}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                        <div className="mt-2 max-h-72 overflow-y-auto overscroll-contain pr-1">
                            <ConfigFileTree
                              files={group}
                              disabled={busyId !== null}
                              onView={(file) => setPreviewFile({ snapshotId: snapshot.id, file })}
                              onDelete={(paths, label) => deleteTreeNode(snapshot, groupKey, paths, label)}
                              labels={snapshotMessages}
                            />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {message && !syncOpen && <p className="mt-4 text-sm" style={{ color: "var(--ink-mid)" }}>{message}</p>}
      </PaperCard>
    </>
  );
}
