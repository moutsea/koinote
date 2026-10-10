import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowDownToLine, ArrowRight, BookOpen, FileText, FolderGit2, Github, Scale, Search, Star } from "lucide-react";
import { useState } from "react";
import { useSession } from "../auth";
import { listPublicAgentRepositories, PUBLIC_REPOSITORIES_QUERY_KEY } from "../agentRepositorySharing";
import { PageContainer } from "../components/PageContainer";
import { PaperCard } from "../components/Ink";
import { useI18n } from "../i18n";
import { formatBytes } from "../storage";

export function AgentPublicRepositoriesPage() {
  const { t } = useI18n();
  const labels = t.agentWorkspace;
  const session = useSession();
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const repositories = useInfiniteQuery({
    queryKey: [PUBLIC_REPOSITORIES_QUERY_KEY, search, session.data?.user?.id], initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => listPublicAgentRepositories(search, pageParam),
    getNextPageParam: (page) => page.nextCursor ?? undefined, retry: false,
  });
  const items = [...new Map(repositories.data?.pages.flatMap((page) => page.repositories).map((item) => [item.workspaceId, item]) ?? []).values()];
  return <PageContainer className="repository-hub flex-1 py-8 sm:py-12">
    <header className="flex flex-wrap items-start justify-between gap-5">
      <div className="max-w-2xl"><span className="mb-4 inline-flex rounded-xl border p-2.5 text-[var(--cinnabar)]"><BookOpen className="h-6 w-6" aria-hidden="true" /></span><h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{labels.publicRepositories}</h1><p className="mt-3 text-sm leading-7 text-[var(--ink-mid)] sm:text-base">{labels.publicDescription}</p></div>
      <Link to="/space" search={{ tab: "agent" }} className="inline-flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm transition hover:bg-[var(--ink-wash)]">{t.nav.space}<ArrowRight className="h-4 w-4" aria-hidden="true" /></Link>
    </header>
    <form className="my-8 flex gap-2 rounded-xl border bg-[var(--ink-paper-soft)] p-2 sm:max-w-2xl" role="search" onSubmit={(event) => { event.preventDefault(); setSearch(input.trim()); }}>
      <Search className="ml-2 mt-2.5 h-5 w-5 shrink-0 text-[var(--ink-mid)]" aria-hidden="true" />
      <input aria-label={labels.publicSearch} placeholder={labels.publicSearch} value={input} maxLength={80} onChange={(event) => setInput(event.target.value)} className="min-w-0 flex-1 rounded-md bg-transparent px-2 py-2.5 text-sm outline-offset-2" />
      <button type="submit" aria-label={labels.publicSearch} className="rounded-lg bg-[var(--ink-strong)] px-4 text-[var(--ink-paper)]"><ArrowRight className="h-4 w-4" aria-hidden="true" /></button>
    </form>
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3 border-b pb-4 text-xs text-[var(--ink-mid)]"><span>{labels.publicSortUpdated}</span>{items.length > 0 && <span role="status">{labels.hubLoadedCount.replace("{count}", String(items.length))}</span>}</div>
    {repositories.isPending && <div role="status" className="py-10 text-center text-sm text-[var(--ink-mid)]">{labels.loading}</div>}
    {repositories.isError && <p role="alert" className="text-sm">{labels.repositoryLoadFailed} <button type="button" onClick={() => void repositories.refetch()} className="underline">{labels.refresh}</button></p>}
    {!repositories.isPending && !repositories.isError && !items.length && <PaperCard className="p-8 text-sm">{labels.publicEmpty}</PaperCard>}
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{items.map((item) => <article key={item.workspaceId} className="group flex min-w-0 flex-col rounded-xl border bg-[var(--ink-paper-soft)] p-5 transition hover:border-[var(--ink-mid)] hover:shadow-sm sm:p-6">
      <div className="mb-4 flex items-center justify-between gap-3"><FolderGit2 className="h-5 w-5 text-[var(--ink-mid)]" aria-hidden="true" /><span className="rounded-full border px-2 py-0.5 text-[11px] text-[var(--ink-mid)]">{labels.hubPublicBadge}</span></div>
      <Link to="/repositories/$repositoryId" params={{ repositoryId: String(item.workspaceId) }} className="rounded-sm focus-visible:outline focus-visible:outline-2">
        <h2 className="break-words text-base font-semibold leading-6 text-[var(--ink-strong)] group-hover:text-[var(--cinnabar)] [overflow-wrap:anywhere]">{item.name}</h2>
        <p className="mt-2.5 line-clamp-3 text-sm leading-6 text-[var(--ink-mid)]">{item.description || labels.publicDescription}</p>
      </Link>
      {item.githubSource && <p className="mt-4 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-[var(--ink-mid)]"><Github className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span>{labels.githubOriginalAuthor}</span><a href={item.githubSource.authorUrl} target="_blank" rel="noreferrer" className="break-all font-medium hover:underline">{item.githubSource.author}</a></p>}
      <div className="mt-auto pt-5"><div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-[var(--ink-mid)]">
        <span className="inline-flex items-center gap-1.5" title={labels.licenseLabel}><Scale className="h-3.5 w-3.5" aria-hidden="true" />{item.license}</span>
        <span className="inline-flex items-center gap-1.5"><FileText className="h-3.5 w-3.5" aria-hidden="true" />{labels.fileCount.replace("{count}", String(item.fileCount))}</span><span>{formatBytes(item.sizeBytes)}</span>
      </div><div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-4 text-xs text-[var(--ink-mid)]">
        <span className="inline-flex items-center gap-1.5" title={labels.starCount.replace("{count}", String(item.starCount ?? 0))}><Star className={`h-3.5 w-3.5 ${item.starred ? "fill-current" : ""}`} aria-hidden="true" />{item.starCount ?? 0}</span>
        <span className="inline-flex items-center gap-1.5"><ArrowDownToLine className="h-3.5 w-3.5" aria-hidden="true" />{labels.cloneRequests.replace("{count}", String(item.cloneCount ?? 0))}</span>
        {item.githubSource && <a href={item.githubSource.repositoryUrl} title={labels.githubOriginalLink} aria-label={`${labels.githubOriginalLink}: ${item.name}`} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 hover:underline">GitHub<ArrowRight className="h-3 w-3" aria-hidden="true" /></a>}
      </div></div>
    </article>)}</div>
    {repositories.hasNextPage && <div className="mt-8 text-center"><button type="button" className="rounded-lg border bg-[var(--ink-paper-soft)] px-6 py-2.5 text-sm disabled:opacity-50" disabled={repositories.isFetchingNextPage} onClick={() => void repositories.fetchNextPage()}>{repositories.isFetchingNextPage ? labels.loading : labels.loadMore}</button></div>}
  </PageContainer>;
}
