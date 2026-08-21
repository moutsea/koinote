import type { Editor } from "@tiptap/react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
  type ReactNode,
} from "react";
import { interpolate, useI18n } from "../../i18n";
import { useDesktopMenuActions } from "../../desktop/menu";
import { isModalOpen } from "../../modalStack";
import {
  activateDocumentSearchMatch,
  clearDocumentSearch,
  documentSearchSnapshot,
  setDocumentSearchQuery,
} from "./pageSearch";
import {
  findTextMatches,
  isPageSearchShortcut,
  nextPageSearchIndex,
} from "./pageSearchCore";

export function DocumentFindBar({
  editor,
  title,
  editorRootRef,
}: {
  editor: Editor | null;
  title: string;
  editorRootRef: RefObject<HTMLDivElement | null>;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [bodyCount, setBodyCount] = useState(0);
  const [activeIndex, setActiveIndex] = useState(-1);

  const normalizedQuery = query.trim();
  const titleMatched =
    normalizedQuery.length > 0 && findTextMatches(title, normalizedQuery, 1).length > 0;
  const titleOffset = titleMatched ? 1 : 0;
  const total = bodyCount + titleOffset;

  const syncTitleHighlight = useCallback(
    (matched: boolean, current: boolean) => {
      const titleElement = editorRootRef.current?.querySelector(".kn-doc-title");
      titleElement?.classList.toggle("kn-page-search-title-match", matched);
      titleElement?.classList.toggle("kn-page-search-title-current", current);
    },
    [editorRootRef],
  );

  const activate = useCallback(
    (
      index: number,
      currentTitleMatched: boolean,
      currentBodyCount: number,
      scroll: boolean,
    ) => {
      if (!editor) return;
      const currentTitleOffset = currentTitleMatched ? 1 : 0;
      const currentTotal = currentTitleOffset + currentBodyCount;
      const safeIndex = index >= 0 && index < currentTotal ? index : -1;
      const titleCurrent = currentTitleMatched && safeIndex === 0;
      syncTitleHighlight(currentTitleMatched, titleCurrent);
      activateDocumentSearchMatch(
        editor,
        safeIndex >= currentTitleOffset ? safeIndex - currentTitleOffset : -1,
      );

      if (!scroll || safeIndex < 0) return;
      window.requestAnimationFrame(() => {
        const target = titleCurrent
          ? editorRootRef.current?.querySelector(".kn-doc-title")
          : editor.view.dom.querySelector(".kn-page-search-current");
        target?.scrollIntoView({ block: "center", behavior: "smooth" });
      });
    },
    [editor, editorRootRef, syncTitleHighlight],
  );

  const close = useCallback(() => {
    setOpen(false);
    setActiveIndex(-1);
    setBodyCount(0);
    syncTitleHighlight(false, false);
    if (editor) clearDocumentSearch(editor);
  }, [editor, syncTitleHighlight]);

  const openFind = useCallback(() => {
    if (!editorRootRef.current?.getClientRects().length) return;
    setOpen(true);
    window.setTimeout(() => inputRef.current?.select(), 0);
  }, [editorRootRef]);

  useDesktopMenuActions((action) => {
    if (action === "find-in-document") openFind();
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const pageSearchShortcut = isPageSearchShortcut(event);
      if (isModalOpen()) {
        if (pageSearchShortcut) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      if (pageSearchShortcut) {
        // 多标签编辑器会保留隐藏实例，只让当前真正可见的实例接管浏览器查找。
        if (!editorRootRef.current?.getClientRects().length) return;
        event.preventDefault();
        event.stopPropagation();
        openFind();
        return;
      }
      if (open && event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [close, editorRootRef, open, openFind]);

  useEffect(() => {
    if (!open) return;
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    if (!editor || !open || !normalizedQuery) {
      if (editor) clearDocumentSearch(editor);
      setBodyCount(0);
      setActiveIndex(-1);
      syncTitleHighlight(false, false);
      return;
    }

    const snapshot = setDocumentSearchQuery(editor, normalizedQuery);
    const nextTitleMatched = findTextMatches(title, normalizedQuery, 1).length > 0;
    const nextTotal = snapshot.total + (nextTitleMatched ? 1 : 0);
    const nextIndex = nextTotal > 0 ? 0 : -1;
    setBodyCount(snapshot.total);
    setActiveIndex(nextIndex);
    activate(nextIndex, nextTitleMatched, snapshot.total, false);
  }, [activate, editor, normalizedQuery, open, syncTitleHighlight, title]);

  useEffect(() => {
    if (!editor || !open || !normalizedQuery) return;
    const onUpdate = () => {
      const snapshot = documentSearchSnapshot(editor);
      const nextTitleMatched = findTextMatches(title, normalizedQuery, 1).length > 0;
      const nextTotal = snapshot.total + (nextTitleMatched ? 1 : 0);
      const nextIndex = nextTotal > 0 ? Math.min(Math.max(activeIndex, 0), nextTotal - 1) : -1;
      setBodyCount(snapshot.total);
      setActiveIndex(nextIndex);
      activate(nextIndex, nextTitleMatched, snapshot.total, false);
    };
    editor.on("update", onUpdate);
    return () => {
      editor.off("update", onUpdate);
    };
  }, [activate, activeIndex, editor, normalizedQuery, open, title]);

  useEffect(() => () => {
    syncTitleHighlight(false, false);
    if (editor) clearDocumentSearch(editor);
  }, [editor, syncTitleHighlight]);

  function move(direction: 1 | -1) {
    const nextIndex = nextPageSearchIndex(activeIndex, total, direction);
    setActiveIndex(nextIndex);
    activate(nextIndex, titleMatched, bodyCount, true);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={`${t.editor.find.button} · ⌘F / Ctrl+F`}
        aria-label={t.editor.find.button}
        aria-expanded={open}
        className="flex h-7 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-neutral-400 transition hover:bg-black/5 hover:text-neutral-700 dark:hover:bg-white/10 dark:hover:text-neutral-200"
      >
        <Search className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">{t.editor.find.button}</span>
      </button>

      {open && (
        <div
          role="search"
          className="absolute right-3 top-12 z-50 flex max-w-[calc(100%-1.5rem)] items-center gap-1 rounded-xl border border-black/10 bg-[var(--background)] p-1.5 shadow-lg dark:border-white/15"
        >
          <Search className="ml-1 h-4 w-4 shrink-0 text-neutral-400" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              move(event.shiftKey ? -1 : 1);
            }}
            placeholder={t.editor.find.placeholder}
            aria-label={t.editor.find.placeholder}
            className="w-48 min-w-0 bg-transparent px-1.5 py-1 text-sm outline-none sm:w-60"
          />
          <span
            aria-live="polite"
            className="min-w-12 shrink-0 text-center text-[11px] tabular-nums text-neutral-400"
          >
            {normalizedQuery
              ? total > 0
                ? interpolate(t.editor.find.resultCount, {
                    current: activeIndex + 1,
                    total,
                  })
                : t.editor.find.noResults
              : ""}
          </span>
          <FindButton
            label={t.editor.find.previous}
            disabled={total === 0}
            onClick={() => move(-1)}
          >
            <ChevronUp className="h-4 w-4" />
          </FindButton>
          <FindButton
            label={t.editor.find.next}
            disabled={total === 0}
            onClick={() => move(1)}
          >
            <ChevronDown className="h-4 w-4" />
          </FindButton>
          <FindButton label={t.editor.find.close} onClick={close}>
            <X className="h-4 w-4" />
          </FindButton>
        </div>
      )}
    </>
  );
}

function FindButton({
  label,
  disabled = false,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-neutral-400 transition hover:bg-black/5 hover:text-neutral-700 disabled:opacity-30 dark:hover:bg-white/10 dark:hover:text-neutral-200"
    >
      {children}
    </button>
  );
}
