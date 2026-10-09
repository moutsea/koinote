import { AgentGitHubAttribution } from "../components/AgentGitHubAttribution";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { FolderGit2, Search, Star } from "lucide-react";
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
  return <PageContainer className="flex-1 py-8 sm:py-12">
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div><h1 className="text-2xl font-bold">{labels.publicRepositories}</h1><p className="mt-3 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{labels.publicDescription}</p></div>
      <Link to="/space" search={{ tab: "agent" }} className="rounded-lg border px-4 py-2 text-sm">{t.nav.space}</Link>
    </header>
    <form className="my-7 flex max-w-xl gap-2" onSubmit={(event) => { event.preventDefault(); setSearch(input.trim()); }}>
      <input aria-label={labels.publicSearch} placeholder={labels.publicSearch} value={input} maxLength={80} onChange={(event) => setInput(event.target.value)} className="min-w-0 flex-1 rounded-lg border bg-transparent px-4 py-2 text-sm" />
      <button type="submit" aria-label={labels.publicSearch} className="rounded-lg border px-3 py-2"><Search className="h-4 w-4" /></button>
    </form>
    <p className="mb-4 text-xs" style={{ color: "var(--ink-faint)" }}>{labels.publicSortUpdated}</p>
    {repositories.isPending && <p className="text-sm">{labels.loading}</p>}
    {repositories.isError && <p role="alert" className="text-sm">{labels.repositoryLoadFailed} <button type="button" onClick={() => void repositories.refetch()} className="underline">{labels.refresh}</button></p>}
    {!repositories.isPending && !repositories.isError && !items.length && <PaperCard className="p-8 text-sm">{labels.publicEmpty}</PaperCard>}
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">{items.map((item) => <PaperCard key={item.workspaceId} className="min-w-0 p-5 transition hover:bg-[var(--ink-wash)]">
      <Link to="/repositories/$repositoryId" params={{ repositoryId: String(item.workspaceId) }} className="block">
        <h2 className="flex items-center gap-2 font-semibold"><FolderGit2 className="h-4 w-4 shrink-0" /><span className="truncate">{item.name}</span></h2>
        <p className="mt-3 line-clamp-3 text-sm leading-6" style={{ color: "var(--ink-mid)" }}>{item.description}</p>
        <p className="mt-5 text-xs" style={{ color: "var(--ink-faint)" }}>r{item.revision} · {item.license} · {labels.fileCount.replace("{count}", String(item.fileCount))} · {formatBytes(item.sizeBytes)}</p>
      </Link>
      <p className="mt-3 flex items-center gap-1.5 text-xs"><Star className={`h-3.5 w-3.5 ${item.starred ? "fill-current" : ""}`} />{item.starCount ?? 0} · {labels.cloneRequests.replace("{count}", String(item.cloneCount ?? 0))}</p>
      {item.githubSource && <div className="mt-4 border-t pt-3"><AgentGitHubAttribution source={item.githubSource} compact /></div>}
    </PaperCard>)}</div>
    {repositories.hasNextPage && <button type="button" className="mt-6 rounded-lg border px-4 py-2 text-sm disabled:opacity-50" disabled={repositories.isFetchingNextPage} onClick={() => void repositories.fetchNextPage()}>{labels.loadMore}</button>}
  </PageContainer>;
}
