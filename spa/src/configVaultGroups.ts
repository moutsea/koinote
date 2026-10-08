import catalog from "./configVaultCatalog.json";

export const GROUP_KEYS = [
  "git", "ssh", "shell", "coding-agents", "personal-agents", "editor-ide",
  "cloud-devops", "language-tools", "other-ai", "config",
] as const;

export type GroupKey = (typeof GROUP_KEYS)[number];

export function configGroupKey(path: string): GroupKey {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  for (const group of catalog) {
    if (group.files.some((file) => normalized === file.toLowerCase())
      || group.directories.some((directory) => normalized === directory.toLowerCase()
        || normalized.startsWith(`${directory.toLowerCase()}/`))) {
      return group.id as GroupKey;
    }
  }
  return "config";
}
