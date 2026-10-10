import type { AgentGitHubSource, AgentWorkspaceFile } from "./api";
import { defaultStringifySearch } from "@tanstack/react-router";

export const REPOSITORY_PREVIEW_BYTES = 256 * 1024;
export const isRepositoryMarkdown = (path: string) => /\.(md|markdown|mdown)$/i.test(path);

export function repositoryAnchorID(fragment: string) {
  try { fragment = decodeURIComponent(fragment); } catch { /* Keep literal malformed anchors. */ }
  return `user-content-${fragment}`;
}

export function repositoryFileHref(workspaceId: number, path: string, fragment?: string) {
  return `/repositories/${workspaceId}${defaultStringifySearch({ file: path })}${fragment ? `#${encodeURIComponent(repositoryAnchorID(fragment))}` : ""}`;
}

export function parseRepositorySearch(search: Record<string, unknown>): { file?: string } {
  return typeof search.file === "string" && search.file.length <= 4096 ? { file: search.file } : {};
}

export function repositoryReadme(files: AgentWorkspaceFile[]) {
  for (const directory of ["", ".github/", "docs/"]) {
    for (const extension of ["md", "markdown", "mdown", "txt"]) {
      const file = files.find((item) => item.path.toLowerCase() === `${directory}readme.${extension}`);
      if (file) return file;
    }
  }
  return files.find((file) => /(^|\/)readme\.(md|markdown|mdown)$/i.test(file.path))
    ?? files.find((file) => /(^|\/)skill\.md$/i.test(file.path));
}

export function repositoryPreview(base64: string) {
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const binary = bytes.includes(0);
  const truncated = bytes.length > REPOSITORY_PREVIEW_BYTES;
  // Streaming decoding leaves an incomplete final UTF-8 character out of a truncated preview.
  const text = binary ? "" : new TextDecoder().decode(bytes.subarray(0, REPOSITORY_PREVIEW_BYTES), { stream: truncated });
  return { text, binary, truncated };
}

export type RepositoryResource = { href: string; file?: AgentWorkspaceFile; fragment?: string };

/** Resolve within the snapshot first. Never turn README paths into application API URLs. */
export function repositoryResource(raw: string, filePath: string, files: AgentWorkspaceFile[], source?: AgentGitHubSource, image = false): RepositoryResource | undefined {
  const value = raw.trim();
  if (!value || /[\u0000-\u001f\u007f\\]/.test(value)) return;
  if (value.startsWith("#")) return image ? undefined : { href: value, fragment: value.slice(1) };
  if (/^[a-z][a-z\d+.-]*:/i.test(value) || value.startsWith("//")) {
    try {
      const url = new URL(value.startsWith("//") ? `https:${value}` : value);
      if (!(image ? ["https:"] : ["https:", "http:", "mailto:"]).includes(url.protocol) || url.username || url.password) return;
      return { href: url.href };
    } catch { return; }
  }
  try {
    const base = `https://repository.invalid/${filePath.split("/").map(encodeURIComponent).join("/")}`;
    const url = new URL(value, base);
    if (url.origin !== "https://repository.invalid") return;
    const path = decodeURIComponent(url.pathname.slice(1));
    if (/[\u0000-\u001f\u007f\\]/.test(path)) return;
    const file = files.find((item) => item.path === path);
    const fragment = url.hash.slice(1);
    if (file) return { href: `#repository-file-${file.fileId}`, file, fragment };
    // Pin fallback links to the imported commit, not the upstream default branch.
    if (source && !source.private && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(source.repositoryUrl) && /^[a-f\d]{40}$/i.test(source.commitSha)) {
      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      const directory = !path || path.endsWith("/") || files.some((item) => item.path.startsWith(`${path}/`));
      return { href: image
        ? `https://raw.githubusercontent.com/${source.repositoryUrl.slice("https://github.com/".length)}/${source.commitSha}/${encodedPath}`
        : `${source.repositoryUrl}/${directory ? "tree" : "blob"}/${source.commitSha}/${encodedPath}${url.search}${url.hash}` };
    }
  } catch { /* Malformed percent escapes are not navigable resources. */ }
}
