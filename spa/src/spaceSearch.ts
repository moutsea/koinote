export type SpaceSearch = {
  tab?: "config" | "agent" | "koi";
  section?: "settings" | "skills";
  install?: "folder" | "github";
};

export function parseSpaceSearch(search: Record<string, unknown>): SpaceSearch {
  const koi = search.tab === "koi";
  return {
    tab: search.tab === "agent" || search.tab === "config" || search.tab === "koi" ? search.tab : undefined,
    section: koi && (search.section === "settings" || search.section === "skills") ? search.section : undefined,
    install: koi && (search.install === "folder" || search.install === "github") ? search.install : undefined,
  };
}
