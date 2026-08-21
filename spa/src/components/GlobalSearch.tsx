import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { FileText, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { searchDocuments } from "../api";
import { useDocumentList } from "../documents";
import { useDesktopMenuActions } from "../desktop/menu";
import { isDesktopRuntime } from "../desktop/runtime";
import { useI18n } from "../i18n";
import { isModalOpen, isOnlyModalOpen, pushModal } from "../modalStack";
import {
  countQuickOpenDocuments,
  detectGlobalSearchPlatform,
  filterQuickOpenDocuments,
  globalSearchShortcutMode,
  nextGlobalSearchIndex,
  type GlobalSearchMode,
} from "./globalSearchCore";

export function GlobalSearch() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const desktop = isDesktopRuntime();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<GlobalSearchMode>("fulltext");
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);

  const openSearch = useCallback((nextMode: GlobalSearchMode) => {
    setMode(nextMode);
    setQuery("");
    setDebounced("");
    setActiveIndex(-1);
    setOpen(true);
  }, []);

  useDesktopMenuActions((action) => {
    if (action === "quick-open") openSearch("quick-open");
    if (action === "search-all-documents") openSearch("fulltext");
  });

  useEffect(() => {
    const platform = detectGlobalSearchPlatform(
      navigator.platform,
      navigator.userAgent,
    );
    const onKey = (event: KeyboardEvent) => {
      const nextMode = globalSearchShortcutMode(event, platform, desktop);
      if (open && isOnlyModalOpen()) {
        if (nextMode) {
          event.preventDefault();
          openSearch(nextMode);
          return;
        }
        if (event.key === "Escape") setOpen(false);
        return;
      }
      if (isModalOpen()) {
        if (nextMode) event.preventDefault();
        return;
      }
      if (nextMode) {
        event.preventDefault();
        openSearch(nextMode);
        return;
      }
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [desktop, open, openSearch]);

  useEffect(() => {
    if (!open) return;
    return pushModal();
  }, [open]);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(query.trim()), 180);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  const documents = useDocumentList(open && mode === "quick-open");

  const results = useQuery({
    queryKey: ["document-search", debounced],
    queryFn: async () => (await searchDocuments(debounced)).results,
    enabled: open && mode === "fulltext" && debounced.length > 0,
    retry: false,
    staleTime: 15_000,
  });

  const items = useMemo(
    () =>
      mode === "quick-open"
        ? filterQuickOpenDocuments(documents.data ?? [], query)
        : (results.data ?? []),
    [documents.data, mode, query, results.data],
  );
  const quickOpenMatchCount = useMemo(
    () => countQuickOpenDocuments(documents.data ?? [], query),
    [documents.data, query],
  );
  const quickOpenTruncated =
    mode === "quick-open" && quickOpenMatchCount > items.length;

  useEffect(() => {
    setActiveIndex(items.length > 0 ? 0 : -1);
    itemRefs.current.length = items.length;
  }, [items]);

  useEffect(() => {
    if (activeIndex < 0) return;
    itemRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, items]);

  async function openDocument(docId: string) {
    setOpen(false);
    await navigate({ to: "/editor/$docId", params: { docId } });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => openSearch("fulltext")}
        aria-label={t.search.button}
        title={`${t.search.button} · ⌘K / Ctrl+K`}
        className="inline-flex h-9 items-center gap-2 rounded-full px-2.5 text-sm transition hover:bg-[var(--ink-wash-strong)] sm:border sm:px-3"
        style={{ color: "var(--ink-mid)", borderColor: "var(--ink-line)" }}
      >
        <Search className="h-4 w-4" />
        <span className="hidden lg:inline">{t.search.button}</span>
        <kbd
          className="hidden rounded border px-1.5 py-0.5 text-[10px] font-medium lg:inline"
          style={{ borderColor: "var(--ink-line)", color: "var(--ink-faint)" }}
        >
          ⌘K
        </kbd>
      </button>

      {open && (
        <div
          className="fixed inset-0 z-[80] flex items-start justify-center bg-black/40 px-3 pt-[10vh] backdrop-blur-[2px]"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label={
              mode === "quick-open" ? t.search.quickOpenTitle : t.search.title
            }
            className="w-full max-w-2xl overflow-hidden rounded-2xl border shadow-2xl"
            style={{
              borderColor: "var(--ink-line)",
              background: "var(--ink-paper)",
            }}
          >
            <div
              className="flex items-center gap-3 border-b px-4"
              style={{ borderColor: "var(--ink-line)" }}
            >
              <Search
                className="h-5 w-5 shrink-0"
                style={{ color: "var(--ink-faint)" }}
              />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    setActiveIndex((current) =>
                      nextGlobalSearchIndex(
                        current,
                        items.length,
                        event.key === "ArrowDown" ? 1 : -1,
                      ),
                    );
                    return;
                  }
                  if (event.key === "Enter" && activeIndex >= 0) {
                    event.preventDefault();
                    const item = items[activeIndex];
                    if (item) void openDocument(item.docId);
                  }
                }}
                placeholder={
                  mode === "quick-open"
                    ? t.search.quickOpenPlaceholder
                    : t.search.placeholder
                }
                aria-label={
                  mode === "quick-open"
                    ? t.search.quickOpenPlaceholder
                    : t.search.placeholder
                }
                className="min-w-0 flex-1 bg-transparent py-4 text-base outline-none"
                style={{ color: "var(--ink-black)" }}
              />
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="flex h-8 w-8 items-center justify-center rounded-full transition hover:bg-[var(--ink-wash-strong)]"
                style={{ color: "var(--ink-faint)" }}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="max-h-[62vh] min-h-56 overflow-y-auto p-2">
              {mode === "fulltext" && !debounced ? (
                <SearchState>{t.search.startTyping}</SearchState>
              ) : mode === "quick-open" && documents.isLoading ? (
                <SearchState>{t.editor.loading}</SearchState>
              ) : mode === "fulltext" && results.isLoading ? (
                <SearchState>{t.editor.loading}</SearchState>
              ) : mode === "quick-open" && documents.isError ? (
                <SearchState>{t.search.loadFailed}</SearchState>
              ) : mode === "fulltext" && results.isError ? (
                <SearchState>{t.search.loadFailed}</SearchState>
              ) : items.length ? (
                <ul>
                  {items.map((result, index) => (
                    <li key={result.docId}>
                      <button
                        ref={(node) => {
                          itemRefs.current[index] = node;
                        }}
                        type="button"
                        onClick={() => void openDocument(result.docId)}
                        data-active={index === activeIndex || undefined}
                        className={`flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition hover:bg-[var(--ink-wash-strong)] ${
                          index === activeIndex ? "bg-[var(--ink-wash-strong)]" : ""
                        }`}
                      >
                        <FileText
                          className="mt-0.5 h-4 w-4 shrink-0"
                          style={{ color: "var(--ink-faint)" }}
                        />
                        <span className="min-w-0 flex-1">
                          <span
                            className="block truncate text-sm font-semibold"
                            style={{ color: "var(--ink-black)" }}
                          >
                            <Highlighted
                              text={result.title || t.editor.untitled}
                              query={
                                mode === "quick-open" ? query.trim() : debounced
                              }
                            />
                          </span>
                          {"snippet" in result && result.snippet && (
                            <span
                              className="mt-1 line-clamp-2 block whitespace-pre-wrap text-xs leading-relaxed"
                              style={{ color: "var(--ink-mid)" }}
                            >
                              <Highlighted
                                text={result.snippet}
                                query={debounced}
                              />
                            </span>
                          )}
                          {"titleMatched" in result && (
                            <span
                              className="mt-1.5 flex gap-2 text-[10px]"
                              style={{ color: "var(--ink-faint)" }}
                            >
                              {result.titleMatched && (
                                <span>{t.search.titleMatch}</span>
                              )}
                              {result.contentMatched && (
                                <span>{t.search.contentMatch}</span>
                              )}
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <SearchState>
                  {mode === "quick-open"
                    ? t.search.quickOpenEmpty
                    : t.search.noResults}
                </SearchState>
              )}
            </div>

            <p
              className="border-t px-4 py-2 text-right text-[10px]"
              style={{
                borderColor: "var(--ink-line)",
                color: "var(--ink-faint)",
              }}
            >
              {mode === "quick-open"
                ? quickOpenTruncated
                  ? `${t.search.quickOpenHint} · ${t.search.quickOpenMore}`
                  : t.search.quickOpenHint
                : desktop
                  ? `${t.search.hint} · ⌘⇧F / Ctrl+Shift+F`
                  : t.search.hint}
            </p>
          </section>
        </div>
      )}
    </>
  );
}

function SearchState({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex min-h-52 items-center justify-center px-6 text-center text-sm"
      style={{ color: "var(--ink-faint)" }}
    >
      {children}
    </div>
  );
}

function Highlighted({ text, query }: { text: string; query: string }) {
  if (!query) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  return parts.map((part, index) =>
    part.toLocaleLowerCase() === query.toLocaleLowerCase() ? (
      <mark
        key={`${part}-${index}`}
        className="rounded px-0.5"
        style={{ background: "var(--cinnabar-soft)", color: "inherit" }}
      >
        {part}
      </mark>
    ) : (
      part
    ),
  );
}
