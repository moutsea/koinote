import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { FileText, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { searchDocuments } from "../api";
import { useI18n } from "../i18n";

export function GlobalSearch() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
      }
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  const results = useQuery({
    queryKey: ["document-search", debounced],
    queryFn: async () => (await searchDocuments(debounced)).results,
    enabled: debounced.length > 0,
    retry: false,
    staleTime: 15_000,
  });

  async function openDocument(docId: string) {
    setOpen(false);
    await navigate({ to: "/editor/$docId", params: { docId } });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
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
            aria-label={t.search.title}
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
                placeholder={t.search.placeholder}
                aria-label={t.search.placeholder}
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
              {!debounced ? (
                <SearchState>{t.search.startTyping}</SearchState>
              ) : results.isLoading ? (
                <SearchState>{t.editor.loading}</SearchState>
              ) : results.isError ? (
                <SearchState>{t.search.loadFailed}</SearchState>
              ) : results.data?.length ? (
                <ul>
                  {results.data.map((result) => (
                    <li key={result.docId}>
                      <button
                        type="button"
                        onClick={() => void openDocument(result.docId)}
                        className="flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition hover:bg-[var(--ink-wash-strong)]"
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
                              query={debounced}
                            />
                          </span>
                          {result.snippet && (
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
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <SearchState>{t.search.noResults}</SearchState>
              )}
            </div>

            <p
              className="border-t px-4 py-2 text-right text-[10px]"
              style={{
                borderColor: "var(--ink-line)",
                color: "var(--ink-faint)",
              }}
            >
              {t.search.hint}
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
