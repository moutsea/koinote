import { ChevronRight, FileCode2, Folder } from "lucide-react";
import { useMemo } from "react";
import type { AgentWorkspaceFile } from "../api";

type DirectoryNode = {
  kind: "directory";
  name: string;
  path: string;
  children: FileTreeNode[];
};

type FileTreeNode = DirectoryNode | {
  kind: "file";
  name: string;
  path: string;
  file: AgentWorkspaceFile;
};

export function buildAgentWorkspaceFileTree(files: AgentWorkspaceFile[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];
  const directories = new Map<string, DirectoryNode>();

  for (const file of files) {
    const segments = file.path.split("/");
    let children = root;
    let directoryPath = "";
    for (const segment of segments.slice(0, -1)) {
      directoryPath = directoryPath ? `${directoryPath}/${segment}` : segment;
      let directory = directories.get(directoryPath);
      if (!directory) {
        directory = { kind: "directory", name: segment, path: directoryPath, children: [] };
        directories.set(directoryPath, directory);
        children.push(directory);
      }
      children = directory.children;
    }
    children.push({ kind: "file", name: segments[segments.length - 1], path: file.path, file });
  }

  function sortNodes(nodes: FileTreeNode[]) {
    nodes.sort((first, second) => {
      if (first.kind !== second.kind) return first.kind === "directory" ? -1 : 1;
      return first.name.localeCompare(second.name, undefined, { numeric: true });
    });
    for (const node of nodes) {
      if (node.kind === "directory") sortNodes(node.children);
    }
  }
  sortNodes(root);
  return root;
}

type FileTreeProps = {
  files: AgentWorkspaceFile[];
  hashLabel: string;
  onOpen: (fileId: number) => void;
};

export function AgentWorkspaceFileTree({ files, hashLabel, onOpen }: FileTreeProps) {
  const nodes = useMemo(() => buildAgentWorkspaceFileTree(files), [files]);
  return (
    <div className="overflow-x-auto px-3 py-2">
      <FileTreeLevel nodes={nodes} hashLabel={hashLabel} onOpen={onOpen} />
    </div>
  );
}

function FileTreeLevel({ nodes, hashLabel, onOpen }: {
  nodes: FileTreeNode[];
  hashLabel: string;
  onOpen: (fileId: number) => void;
}) {
  return (
    <ul className="m-0 list-none p-0">
      {nodes.map((node) => (
        <li key={`${node.kind}:${node.path}`}>
          {node.kind === "directory" ? (
            <details className="[&[open]>summary>svg:first-child]:rotate-90">
              <summary
                className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-2.5 text-sm hover:bg-[var(--ink-wash)] focus-visible:outline focus-visible:outline-2 [&::-webkit-details-marker]:hidden"
                style={{ color: "var(--ink-strong)" }}
                title={node.path}
              >
                <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 transition-transform" />
                <Folder aria-hidden="true" className="h-4 w-4 shrink-0" style={{ color: "var(--ink-mid)" }} />
                <span className="min-w-0 truncate font-medium">{node.name}</span>
              </summary>
              <div className="ml-4 border-l pl-2" style={{ borderColor: "var(--ink-line)" }}>
                <FileTreeLevel nodes={node.children} hashLabel={hashLabel} onOpen={onOpen} />
              </div>
            </details>
          ) : (
            <button
              type="button"
              onClick={() => onOpen(node.file.fileId)}
              title={node.path}
              className="flex w-full items-center justify-between gap-4 rounded-md py-2.5 pl-7 pr-2 text-left hover:bg-[var(--ink-wash)] focus-visible:outline focus-visible:outline-2"
            >
              <span className="flex min-w-0 items-center gap-2">
                <FileCode2 aria-hidden="true" className="h-4 w-4 shrink-0" style={{ color: "var(--ink-faint)" }} />
                <span className="truncate font-mono text-sm" style={{ color: "var(--ink-strong)" }}>{node.name}</span>
              </span>
              <span className="flex shrink-0 items-center gap-4 text-xs" style={{ color: "var(--ink-faint)" }}>
                <span className="hidden sm:inline" title={node.file.sha256}>{hashLabel} {node.file.sha256.slice(0, 12)}</span>
                <span>{formatBytes(node.file.sizeBytes)}</span>
              </span>
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
