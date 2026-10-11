import { useInfiniteQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowDownToLine, ArrowRight, BookOpen, Bot, Clapperboard, Code2, Compass, FileText, FolderGit2, Github, LayoutGrid, LibraryBig, PenLine, PencilRuler, Search, Shapes, Star, TrendingUp, X, type LucideIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { useSession } from "../auth";
import { listPublicAgentRepositories, PUBLIC_REPOSITORIES_QUERY_KEY, type PublicRepositorySummary } from "../agentRepositorySharing";
import { REPOSITORY_CATEGORIES, parseRepositoryDirectorySearch, repositoryCategory, repositoryFacetCount, type RepositoryCategory, type RepositoryDirectorySearch } from "../agentRepositoryDirectory";
import { PageContainer } from "../components/PageContainer";
import { useI18n } from "../i18n";

const CATEGORY_ICONS: Record<RepositoryCategory, LucideIcon> = {
  design: PencilRuler, development: Code2, agents: Bot, writing: PenLine,
  product: TrendingUp, research: LibraryBig, media: Clapperboard, other: Shapes,
};

export function AgentPublicRepositoriesPage() {
  const { t } = useI18n();
  const labels = t.agentWorkspace;
  const session = useSession();
  const directorySearch = useSearch({ from: "/repositories" });
  const navigate = useNavigate({ from: "/repositories" });
  const { q: search = "", source = "", category = "" } = directorySearch;
  const [input, setInput] = useState(search);
  useEffect(() => { setInput(search); }, [search]);
  function updateFilters(change: RepositoryDirectorySearch) {
    void navigate({ to: "/repositories", search: (previous) => parseRepositoryDirectorySearch({ ...previous, ...change }), resetScroll: false });
  }
  const repositories = useInfiniteQuery({
    queryKey: [PUBLIC_REPOSITORIES_QUERY_KEY, search, source, category, session.data?.user?.id],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => listPublicAgentRepositories(search, pageParam, { source, category }),
    getNextPageParam: (page) => page.nextCursor ?? undefined, retry: false,
  });
  const items = [...new Map(repositories.data?.pages.flatMap((page) => page.repositories).map((item) => [item.workspaceId, item]) ?? []).values()];
  const firstPage = repositories.data?.pages[0];
  const facets = firstPage?.facets ?? [];
  const categoryLabel = (value: RepositoryCategory | "") => value ? labels[`hubCategory_${value}`] : labels.hubAllCategories;
  const total = firstPage?.total ?? items.length;
  const hasFilters = Boolean(search || source || category);
  function clearFilters() { setInput(""); void navigate({ to: "/repositories", search: {}, resetScroll: false }); }
  return <PageContainer className="repository-hub flex-1 py-8 sm:py-12">
    <header className="hub-intro relative overflow-hidden rounded-2xl border p-6 sm:p-8 lg:px-10">
      <div className="relative flex flex-wrap items-end justify-between gap-6">
        <div className="max-w-2xl">
          <p className="mb-4 flex items-center gap-2 text-xs font-medium tracking-wide text-[var(--cinnabar)]"><BookOpen className="h-4 w-4" aria-hidden="true" />{labels.hubEyebrow}</p>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{labels.publicRepositories}</h1>
          <p className="mt-3 max-w-xl text-sm leading-7 text-[var(--ink-mid)]">{labels.hubIntro}</p>
        </div>
        <Link to="/space" search={{ tab: "agent" }} className="inline-flex shrink-0 items-center gap-2 rounded-lg border bg-[var(--ink-paper)] px-4 py-2.5 text-sm transition hover:bg-[var(--ink-wash)]">{labels.hubMyRepositories}<ArrowRight className="h-4 w-4" aria-hidden="true" /></Link>
      </div>
    </header>

    <div className="my-6 flex flex-col gap-4 border-b pb-6 lg:flex-row lg:items-center lg:justify-between">
      <div role="group" aria-label={labels.hubSources} className="flex w-fit max-w-full gap-1 overflow-x-auto rounded-xl bg-[var(--ink-wash)] p-1">
        {(["", "system", "community"] as const).map((value) => <button key={value} type="button" aria-pressed={source === value} onClick={() => updateFilters({ source: value || undefined })} className={`hub-source-button inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2.5 text-sm transition sm:px-4 ${source === value ? "bg-[var(--ink-paper)] font-medium text-[var(--ink-strong)] shadow-sm" : "text-[var(--ink-mid)] hover:text-[var(--ink-strong)]"}`}>
          {value === "system" ? labels.hubSystemBadge : value === "community" ? labels.hubCommunity : labels.hubAllRepositories}
          <span className="text-[11px] tabular-nums text-[var(--ink-mid)]">{firstPage ? repositoryFacetCount(facets, value, category) : "—"}</span>
        </button>)}
      </div>
      <form className="flex min-w-0 items-center gap-2 rounded-xl border bg-[var(--ink-paper-soft)] p-1.5 lg:w-[24rem]" role="search" onSubmit={(event) => { event.preventDefault(); updateFilters({ q: input.trim() || undefined }); }}>
        <Search className="ml-2 h-4 w-4 shrink-0 text-[var(--ink-mid)]" aria-hidden="true" />
        <input type="search" aria-label={labels.publicSearch} placeholder={labels.hubSearchPlaceholder} value={input} maxLength={80} onChange={(event) => setInput(event.target.value)} className="min-w-0 flex-1 rounded-md bg-transparent py-2 text-sm outline-offset-2" />
        <button type="submit" className="shrink-0 rounded-lg bg-[var(--ink-strong)] px-3 py-2 text-xs text-[var(--ink-paper)]">{labels.hubSearchAction}</button>
      </form>
    </div>

    <div className="grid min-w-0 gap-6 lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-8">
      <aside className="min-w-0 self-start lg:sticky lg:top-24">
        <h2 className="mb-3 flex items-center gap-2 px-1 text-xs font-medium text-[var(--ink-mid)]"><Compass className="h-3.5 w-3.5" aria-hidden="true" />{labels.hubBrowseCategories}</h2>
        <nav aria-label={labels.hubBrowseCategories} className="flex gap-1.5 overflow-x-auto pb-2 lg:flex-col lg:overflow-visible">
          {(["", ...REPOSITORY_CATEGORIES] as const).map((value) => {
            const Icon = value ? CATEGORY_ICONS[value] : LayoutGrid;
            return <button type="button" key={value} aria-pressed={category === value} onClick={() => updateFilters({ category: value || undefined })} className={`hub-category-button flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2.5 text-sm transition lg:w-full ${category === value ? "bg-[var(--ink-wash-strong)] font-medium text-[var(--cinnabar)]" : "text-[var(--ink-mid)] hover:bg-[var(--ink-wash)] hover:text-[var(--ink-strong)]"}`}>
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" /><span>{categoryLabel(value)}</span>
              <span className="ml-auto pl-2 text-[11px] tabular-nums text-[var(--ink-mid)]">{firstPage ? repositoryFacetCount(facets, source, value) : "—"}</span>
            </button>;
          })}
        </nav>
        <p className="mt-5 hidden border-t px-1 pt-4 text-xs leading-6 text-[var(--ink-mid)] lg:block">{labels.hubBrowseHint}</p>
      </aside>

      <section aria-label={labels.hubResults} aria-busy={repositories.isFetching} className="min-w-0">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3"><h2 className="text-base font-semibold">{categoryLabel(category)}</h2><span role="status" className="text-xs tabular-nums text-[var(--ink-mid)]">{repositories.isPending ? labels.loading : labels.hubResultCount.replace("{count}", String(total))}</span></div>
          <span className="text-[11px] text-[var(--ink-mid)]">{labels.publicSortUpdated}</span>
        </div>
        {hasFilters && <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-[var(--ink-mid)]">
          {search && <span className="rounded-md border px-2 py-1">“{search}”</span>}
          <button type="button" onClick={clearFilters} className="inline-flex items-center gap-1 rounded-md px-1 py-1 hover:text-[var(--ink-strong)]"><X className="h-3 w-3" aria-hidden="true" />{labels.hubClearFilters}</button>
        </div>}
        {repositories.isPending && <div aria-hidden="true" className="grid gap-4 sm:grid-cols-2">{Array.from({ length: 6 }, (_, i) => <div key={i} className="h-56 rounded-xl border bg-[var(--ink-paper-soft)] p-5 motion-safe:animate-pulse"><div className="h-7 w-7 rounded-lg bg-[var(--ink-wash-strong)]" /><div className="mt-5 h-4 w-3/5 rounded bg-[var(--ink-wash-strong)]" /><div className="mt-3 h-3 rounded bg-[var(--ink-wash)]" /><div className="mt-2 h-3 w-4/5 rounded bg-[var(--ink-wash)]" /></div>)}</div>}
        {repositories.isError && <p role="alert" className="mb-4 rounded-xl border p-5 text-sm">{labels.repositoryLoadFailed} <button type="button" disabled={repositories.isFetching} onClick={() => void (repositories.isFetchNextPageError ? repositories.fetchNextPage() : repositories.refetch())} className="underline disabled:opacity-50">{labels.refresh}</button></p>}
        {!repositories.isPending && !repositories.isError && !items.length && <div className="rounded-xl border border-dashed py-16 text-center"><FolderGit2 className="mx-auto mb-4 h-8 w-8 text-[var(--ink-mid)]" aria-hidden="true" /><h3 className="text-sm font-medium">{labels.publicEmpty}</h3><p className="mx-auto mt-2 max-w-sm px-4 text-xs leading-6 text-[var(--ink-mid)]">{hasFilters ? labels.hubEmptyFiltered : labels.hubEmptyHint}</p>{hasFilters && <button type="button" onClick={clearFilters} className="mt-5 rounded-lg border px-4 py-2 text-xs">{labels.hubClearFilters}</button>}</div>}
        <div className="grid gap-4 sm:grid-cols-2">{items.map((item) => <RepositoryCard key={item.workspaceId} item={item} directorySearch={directorySearch} />)}</div>
        {!repositories.isPending && items.length > 0 && <div className="mt-7 flex flex-col items-center gap-3 border-t pt-6">
          <p className="text-xs tabular-nums text-[var(--ink-mid)]">{labels.hubShowing.replace("{shown}", String(items.length)).replace("{total}", String(total))}</p>
          {repositories.hasNextPage && <button type="button" className="rounded-lg border bg-[var(--ink-paper-soft)] px-8 py-2.5 text-sm transition hover:bg-[var(--ink-wash)] disabled:opacity-50" disabled={repositories.isFetching} onClick={() => void repositories.fetchNextPage()}>{repositories.isFetchingNextPage ? labels.loading : labels.loadMore}</button>}
        </div>}
      </section>
    </div>
  </PageContainer>;
}

function RepositoryCard({ item, directorySearch }: { item: PublicRepositorySummary; directorySearch: RepositoryDirectorySearch }) {
  const { t } = useI18n();
  const labels = t.agentWorkspace;
  const category = repositoryCategory(item.category);
  const Icon = CATEGORY_ICONS[category];
  const author = item.githubSource?.author;
  const name = author && item.name.toLowerCase().startsWith(`${author.toLowerCase()}/`) ? item.name.slice(author.length + 1) : item.name;
  return <article data-repository-card className="hub-repository-card group flex min-w-0 flex-col rounded-xl border bg-[var(--ink-paper-soft)] p-5 transition duration-200 hover:border-[var(--ink-mid)] hover:shadow-sm">
    <div className="mb-4 flex items-center justify-between gap-3"><span className="rounded-lg bg-[var(--ink-wash)] p-2 text-[var(--ink-mid)]"><Icon className="h-4 w-4" aria-hidden="true" /></span><span className="text-[11px] text-[var(--ink-mid)]">{item.systemManaged ? labels.hubSystemBadge : labels.hubCommunity}</span></div>
    <Link to="/repositories/$repositoryId" params={{ repositoryId: String(item.workspaceId) }} search={directorySearch} title={item.name} className="rounded-sm focus-visible:outline focus-visible:outline-2">
      <h3 className="break-words text-base font-semibold leading-6 tracking-tight text-[var(--ink-strong)] group-hover:text-[var(--cinnabar)] [overflow-wrap:anywhere]">{name}</h3>
      <p className="mt-2 line-clamp-2 min-h-12 text-sm leading-6 text-[var(--ink-mid)]">{item.description || labels.hubNoDescription}</p>
    </Link>
    <div className="mt-3 flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-[var(--ink-mid)]">
      <span className="rounded-md bg-[var(--ink-wash)] px-2 py-1">{labels[`hubCategory_${category}`]}</span>
      {item.githubSource && <a href={item.githubSource.authorUrl} title={`${labels.githubOriginalAuthor} ${author}`} aria-label={`${labels.githubOriginalAuthor} ${author}`} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1.5 hover:underline"><Github className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span className="truncate">{author}</span></a>}
    </div>
    <div className="mt-auto pt-4"><div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t pt-3 text-[11px] text-[var(--ink-mid)]">
      <span>{item.license}</span><span className="inline-flex items-center gap-1"><FileText className="h-3 w-3" aria-hidden="true" />{labels.fileCount.replace("{count}", String(item.fileCount))}</span>
      {(item.starCount ?? 0) > 0 && <span className="inline-flex items-center gap-1" aria-label={labels.starCount.replace("{count}", String(item.starCount))}><Star className={`h-3 w-3 ${item.starred ? "fill-current" : ""}`} aria-hidden="true" />{item.starCount}</span>}
      {(item.cloneCount ?? 0) > 0 && <span className="inline-flex items-center gap-1" title={labels.cloneRequests.replace("{count}", String(item.cloneCount))}><ArrowDownToLine className="h-3 w-3" aria-hidden="true" />{item.cloneCount}</span>}
      {item.githubSource && <a href={item.githubSource.repositoryUrl} title={labels.githubOriginalLink} aria-label={`${labels.githubOriginalLink}: ${item.name}`} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 hover:underline">GitHub<ArrowRight className="h-3 w-3" aria-hidden="true" /></a>}
    </div></div>
  </article>;
}
