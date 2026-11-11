export type KoiFolderEntry = { path: string; file: File };
export type KoiFolderPackage = { directory: string; entries: KoiFolderEntry[] };

const KOI_IGNORED_SEGMENTS = new Set([
  ".git", "node_modules", ".DS_Store", "__MACOSX", ".cache",
]);

export function koiIgnoredPath(path: string): boolean {
  return path.split("/").some((segment) => KOI_IGNORED_SEGMENTS.has(segment) || segment.startsWith("._"));
}

// Work on picker metadata only. Keep File objects intact and never read bytes
// before package selection. The server must still validate paths and content.
export function koiFolderEntries(files: readonly File[]): KoiFolderEntry[] {
  const entries = files.map((file) => ({ path: (file.webkitRelativePath || file.name).replace(/\\/g, "/"), file }));
  const seen = new Set<string>();
  for (const { path } of entries) {
    if (!path || path !== path.trim() || path[1] === ":" || /[\u0000-\u001f\u007f-\u009f]/.test(path)
      || path.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
      throw new Error("Invalid folder file path");
    }
    if (seen.has(path)) throw new Error("Duplicate folder file path");
    seen.add(path);
  }
  const roots = new Set(entries.map(({ path }) => path.split("/")[0]));
  const stripRoot = roots.size === 1 && entries.every(({ path }) => path.includes("/"));
  return entries
    .map(({ path, file }) => ({ path: stripRoot ? path.slice(path.indexOf("/") + 1) : path, file }))
    .filter(({ path }) => !koiIgnoredPath(path));
}

// Match the server's package boundary: a nested SKILL.md owns its subtree.
// Entries must come from koiFolderEntries, with unique relative file paths.
export function koiFolderPackages(entries: readonly KoiFolderEntry[]): KoiFolderPackage[] {
  const directories = entries
    .filter(({ path }) => path === "SKILL.md" || path.endsWith("/SKILL.md"))
    .map(({ path }) => path === "SKILL.md" ? "" : path.slice(0, -9))
    .sort();
  const packages = directories.map((directory) => ({ directory, entries: [] as KoiFolderEntry[] }));
  for (const entry of entries) {
    let owner: KoiFolderPackage | undefined;
    for (const item of packages) {
      if ((!item.directory || entry.path.startsWith(item.directory + "/"))
        && (!owner || item.directory.length > owner.directory.length)) owner = item;
    }
    if (owner) owner.entries.push(entry);
  }
  // Preserve ancestor licenses and notices at their original paths. The server
  // rebases these without overwriting a package's own license or attachments.
  for (const item of packages) {
    for (const entry of entries) {
      const segments = entry.path.split("/");
      const base = segments.pop() ?? "";
      const ancestor = segments.join("/");
      if (/^(?:LICENSE|LICENCE|NOTICE|COPYING)(?:[.-].*)?$/i.test(base)
        && ancestor !== item.directory
        && (!ancestor || item.directory.startsWith(ancestor + "/"))
        && !item.entries.includes(entry)) item.entries.push(entry);
    }
  }
  return packages;
}

// A shared notice is uploaded once even when several selected packages use it.
export function koiSelectedFolderEntries(packages: readonly KoiFolderPackage[], directories: readonly string[]): KoiFolderEntry[] {
  const selected = new Set(directories);
  return [...new Map(packages.filter(({ directory }) => selected.has(directory))
    .flatMap(({ entries }) => entries).map((entry) => [entry.path, entry])).values()];
}
