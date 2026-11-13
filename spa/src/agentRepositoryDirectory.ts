export const REPOSITORY_CATEGORIES = ["design", "development", "agents", "writing", "product", "research", "media", "other"] as const;
export type RepositoryCategory = typeof REPOSITORY_CATEGORIES[number];
export type RepositorySource = "" | "system" | "community";
export type RepositoryFacet = { category: RepositoryCategory; systemManaged: boolean; count: number; koiInstallableCount?: number };
export type RepositoryDirectorySearch = { q?: string; source?: Exclude<RepositorySource, "">; category?: RepositoryCategory; koiInstallable?: true };

export function parseRepositoryDirectorySearch(search: Record<string, unknown>): RepositoryDirectorySearch {
  // The router merges validation results with raw URL values. Explicitly clear
  // invalid fields so numbers, arrays and objects cannot survive that merge.
  const result: RepositoryDirectorySearch = { q: undefined, source: undefined, category: undefined, koiInstallable: undefined };
  // Its default URL parser JSON-decodes plain numeric/boolean search terms.
  const rawQuery = (typeof search.q === "number" && Number.isFinite(search.q)) || typeof search.q === "boolean"
    ? String(search.q) : search.q;
  if (typeof rawQuery === "string") {
    const q = rawQuery.trim();
    if (q && Array.from(q).length <= 80) result.q = q;
  }
  if (search.source === "system" || search.source === "community") result.source = search.source;
  if (REPOSITORY_CATEGORIES.includes(search.category as RepositoryCategory)) result.category = search.category as RepositoryCategory;
  if (search.koiInstallable === true || search.koiInstallable === "true") result.koiInstallable = true;
  return result;
}

export function repositoryFacetCount(facets: RepositoryFacet[], source: RepositorySource, category: RepositoryCategory | "", koiInstallable = false) {
  return facets.reduce((total, facet) => total + ((!source || facet.systemManaged === (source === "system")) && (!category || facet.category === category) ? (koiInstallable ? facet.koiInstallableCount ?? 0 : facet.count) : 0), 0);
}
export function repositoryCategory(value?: string): RepositoryCategory {
  return REPOSITORY_CATEGORIES.includes(value as RepositoryCategory) ? value as RepositoryCategory : "other";
}
