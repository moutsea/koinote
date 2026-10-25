import type { Editor } from "@tiptap/react";
import { ChevronDown, ChevronRight, ChevronUp, Replace, Search, X } from "lucide-react";
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
  replaceDocumentSearch,
  setDocumentSearchQuery,
} from "./pageSearch";
import {
  findTextMatches,
  isPageSearchShortcut,
  isPageReplaceShortcut,
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
  const replacementRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [replaceMode, setReplaceMode] = useState(false);
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [replacedCount, setReplacedCount] = useState<number | null>(null);
  const [bodyCount, setBodyCount] = useState(0);
  const [activeIndex, setActiveIndex] = useState(-1);
  const searchSessionRef = useRef<{ editor: Editor; query: string } | null>(null);
  const initialSelectionRef = useRef<{ editor: Editor; query: string; from: number; to: number } | null>(null);

  const titleMatched =
    !replaceMode && query.length > 0 && findTextMatches(title, query, 1).length > 0;
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
    initialSelectionRef.current = null;
    setOpen(false);
    setActiveIndex(-1);
    setBodyCount(0);
    syncTitleHighlight(false, false);
    if (editor) clearDocumentSearch(editor);
  }, [editor, syncTitleHighlight]);

  const openFind = useCallback((replace = false) => {
    if (!editorRootRef.current?.getClientRects().length) return;
    if (!open) initialSelectionRef.current = null;
    if (!open && editor && !editor.state.selection.empty) {
      const { from, to } = editor.state.selection;
      const selected = editor.state.doc.textBetween(from, to, "\n");
      if (selected.length === to - from && selected.length <= 500 && !selected.includes("\n")) {
        setQuery(selected);
        initialSelectionRef.current = { editor, query: selected, from, to };
      }
    }
    setReplaceMode(replace);
    setReplacedCount(null);
    setOpen(true);
    window.setTimeout(() => inputRef.current?.select(), 0);
  }, [editor, editorRootRef, open]);

  useDesktopMenuActions((action) => {
    if (action === "find-in-document") openFind();
    if (action === "replace-in-document") openFind(true);
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Hidden tabs must never intercept refresh, search or Escape.
      if (!editorRootRef.current?.getClientRects().length) return;
      const pageSearchShortcut = isPageSearchShortcut(event);
      const pageReplaceShortcut = isPageReplaceShortcut(event);
      if (isModalOpen()) {
        if (pageSearchShortcut || pageReplaceShortcut) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      if (pageSearchShortcut || pageReplaceShortcut) {
        event.preventDefault();
        event.stopPropagation();
        openFind(pageReplaceShortcut);
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
    setReplacedCount(null);
    if (!editor || !open || !query) {
      searchSessionRef.current = null;
      initialSelectionRef.current = null;
      if (editor) clearDocumentSearch(editor);
      setBodyCount(0);
      setActiveIndex(-1);
      syncTitleHighlight(false, false);
      return;
    }

    // Switching modes only changes whether the title participates. Keep the
    // plugin's current body match instead of restarting the search at index 0.
    const sameSearch = searchSessionRef.current?.editor === editor &&
      searchSessionRef.current.query === query;
    // Only seed a newly opened search from the body selection. Mode switches
    // and later query edits must not reuse this initial position.
    const initialSelection = initialSelectionRef.current;
    initialSelectionRef.current = null;
    const initialRange = initialSelection?.editor === editor && initialSelection.query === query
      ? { from: initialSelection.from, to: initialSelection.to }
      : undefined;
    const snapshot = sameSearch
      ? documentSearchSnapshot(editor)
      : setDocumentSearchQuery(editor, query, initialRange);
    searchSessionRef.current = { editor, query };
    const nextTitleMatched = !replaceMode && findTextMatches(title, query, 1).length > 0;
    const nextTotal = snapshot.total + (nextTitleMatched ? 1 : 0);
    const nextIndex = snapshot.activeIndex >= 0
      ? snapshot.activeIndex + (nextTitleMatched ? 1 : 0)
      : nextTotal > 0 ? 0 : -1;
    setBodyCount(snapshot.total);
    setActiveIndex(nextIndex);
    activate(nextIndex, nextTitleMatched, snapshot.total, false);
  }, [activate, editor, query, open, replaceMode, syncTitleHighlight, title]);

  useEffect(() => {
    if (!editor || !open || !query) return;
    const onUpdate = () => {
      const snapshot = documentSearchSnapshot(editor);
      const nextTitleMatched = !replaceMode && findTextMatches(title, query, 1).length > 0;
      const nextTotal = snapshot.total + (nextTitleMatched ? 1 : 0);
      // The plugin has already mapped the body target through this edit.
      // Convert that index to the UI's title-inclusive list in either mode.
      const nextIndex = snapshot.activeIndex >= 0
        ? snapshot.activeIndex + (nextTitleMatched ? 1 : 0)
        : nextTotal > 0 ? 0 : -1;
      setReplacedCount(null);
      setBodyCount(snapshot.total);
      setActiveIndex(nextIndex);
      activate(nextIndex, nextTitleMatched, snapshot.total, false);
    };
    editor.on("update", onUpdate);
    return () => {
      editor.off("update", onUpdate);
    };
  }, [activate, editor, query, open, replaceMode, title]);

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

  function replace(all: boolean) {
    if (!editor || !replaceMode) return;
    const result = replaceDocumentSearch(editor, replacement, all);
    setReplacedCount(result.replaced);
    setBodyCount(result.total);
    setActiveIndex(result.activeIndex);
    activate(result.activeIndex, false, result.total, !all);
    replacementRef.current?.focus();
  }

  return (
    <>
      <button
        type="button"
        onClick={() => openFind()}
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
          aria-label={replaceMode ? t.editor.find.replaceToggle : t.editor.find.button}
          className="absolute right-3 top-12 z-50 w-[28rem] max-w-[calc(100%-1.5rem)] rounded-xl border border-black/10 bg-[var(--background)] p-1.5 shadow-lg dark:border-white/15"
        >
          <div className="flex min-w-0 items-center gap-1">
            <FindButton label={t.editor.find.replaceToggle} expanded={replaceMode} onClick={() => setReplaceMode(!replaceMode)}>
              {replaceMode ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </FindButton>
            <input
              ref={inputRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
                event.preventDefault();
                move(event.shiftKey ? -1 : 1);
              }}
              placeholder={t.editor.find.placeholder}
              aria-label={t.editor.find.placeholder}
              className="min-w-0 flex-1 bg-transparent px-1.5 py-1 text-sm outline-none"
            />
            <span
              aria-live="polite"
              className="min-w-12 shrink-0 text-center text-[11px] tabular-nums text-neutral-400"
            >
              {query
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
          {replaceMode && (
            <div className="mt-1 border-t border-black/5 pt-1 dark:border-white/10">
              <div className="flex min-w-0 items-center gap-1">
                <Replace className="mx-1.5 h-4 w-4 shrink-0 text-neutral-400" />
                <input
                  ref={replacementRef}
                  value={replacement}
                  onChange={(event) => { setReplacement(event.target.value); setReplacedCount(null); }}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
                    event.preventDefault();
                    replace(event.metaKey || event.ctrlKey);
                  }}
                  placeholder={t.editor.find.replacePlaceholder}
                  aria-label={t.editor.find.replacePlaceholder}
                  className="min-w-0 flex-1 bg-transparent px-1.5 py-1 text-sm outline-none"
                />
                <button type="button" onClick={() => replace(false)} disabled={!bodyCount || !editor?.isEditable}
                  className="shrink-0 rounded-lg px-2 py-1.5 text-xs font-medium hover:bg-black/5 disabled:opacity-30 dark:hover:bg-white/10">
                  {t.editor.find.replaceOne}
                </button>
                <button type="button" onClick={() => replace(true)} disabled={!bodyCount || !editor?.isEditable}
                  className="shrink-0 rounded-lg px-2 py-1.5 text-xs font-medium hover:bg-black/5 disabled:opacity-30 dark:hover:bg-white/10">
                  {t.editor.find.replaceAll}
                </button>
              </div>
              <p aria-live="polite" className="px-2 pb-0.5 pt-1 text-[11px] text-neutral-500 dark:text-neutral-400">
                {replacedCount === null ? t.editor.find.replaceScope : interpolate(t.editor.find.replacedCount, { count: replacedCount })}
              </p>
            </div>
          )}
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
  expanded,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
  expanded?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-expanded={expanded}
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-neutral-400 transition hover:bg-black/5 hover:text-neutral-700 disabled:opacity-30 dark:hover:bg-white/10 dark:hover:text-neutral-200"
    >
      {children}
    </button>
  );
}
