import { Extension, type Editor } from "@tiptap/core";
import { Fragment, Slice, type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { ReplaceStep } from "@tiptap/pm/transform";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { closeHistory } from "@tiptap/pm/history";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { BatchReplaceStep } from "./batchReplaceStep";
import {
  findTextMatches,
  MAX_PAGE_SEARCH_MATCHES,
  type TextMatch,
} from "./pageSearchCore";

export type PageSearchSnapshot = {
  total: number;
  activeIndex: number;
};

type PageSearchState = PageSearchSnapshot & {
  query: string;
  ranges: TextMatch[];
  decorations: DecorationSet;
};

type PageSearchAction =
  | { type: "query"; query: string; initialRange?: TextMatch }
  | { type: "activate"; activeIndex: number }
  | { type: "replaced"; nextFrom: number }
  | { type: "clear" };

const pageSearchKey = new PluginKey<PageSearchState>("koinotePageSearch");

function findDocumentMatches(
  document: ProseMirrorNode,
  query: string,
): TextMatch[] {
  const ranges: TextMatch[] = [];

  document.descendants((block, blockPosition) => {
    if (!block.isTextblock) return true;

    let text = "";
    const segments: Array<{
      textFrom: number;
      textTo: number;
      documentFrom: number;
    }> = [];

    block.descendants((node, nodePosition) => {
      if (node.isText && node.text) {
        const textFrom = text.length;
        text += node.text;
        segments.push({
          textFrom,
          textTo: text.length,
          documentFrom: blockPosition + 1 + nodePosition,
        });
        return false;
      }
      if (node.isInline && node.isLeaf) {
        // 图片、硬换行等原子节点占一个文档位置。放一个不可搜索的分隔符，
        // 防止关键词错误地跨过图片或换行拼成命中。
        text += "\u0000";
        return false;
      }
      return true;
    });

    // Single-match navigation must include overlaps so an explicit body
    // selection is always addressable. Bulk replacement filters them later.
    const matches = findTextMatches(text, query, Infinity, true);
    let startSegmentIndex = 0;
    let endSegmentIndex = 0;
    for (const match of matches) {
      while (startSegmentIndex < segments.length && segments[startSegmentIndex].textTo <= match.from) startSegmentIndex++;
      const startSegment = segments[startSegmentIndex];
      const endOffset = match.to - 1;
      while (endSegmentIndex < segments.length && segments[endSegmentIndex].textTo <= endOffset) endSegmentIndex++;
      const endSegment = segments[endSegmentIndex];
      if (!startSegment || !endSegment) continue;

      const from =
        startSegment.documentFrom + (match.from - startSegment.textFrom);
      const to = endSegment.documentFrom + (match.to - endSegment.textFrom);
      // 相邻 mark 会把文本拆成多个 text node，但文档位置仍连续；真正跨过
      // 原子节点的匹配已被 \0 分隔，不会走到这里。
      if (to - from !== match.to - match.from) continue;
      ranges.push({ from, to });
    }
    return false;
  });

  return ranges;
}

function decorationsFor(
  document: ProseMirrorNode,
  ranges: TextMatch[],
  activeIndex: number,
): DecorationSet {
  // Bound decoration work while keeping the active match visible. Indices
  // remain relative to the full result list when moving between windows.
  const start = activeIndex < 0
    ? 0
    : Math.floor(activeIndex / MAX_PAGE_SEARCH_MATCHES) * MAX_PAGE_SEARCH_MATCHES;
  const current = ranges[activeIndex];
  const decorations: Decoration[] = [];
  let highlightedUntil = -1;
  for (let index = start; index < Math.min(ranges.length, start + MAX_PAGE_SEARCH_MATCHES); index++) {
    const range = ranges[index];
    // Reserve the exact active range, then draw disjoint background matches.
    // Overlapping decorations would split the current highlight into pieces.
    if (index !== activeIndex && current && range.from < current.to && range.to > current.from) continue;
    if (range.from < highlightedUntil) continue;
    decorations.push(Decoration.inline(range.from, range.to, {
      class: index === activeIndex
        ? "kn-page-search-match kn-page-search-current"
        : "kn-page-search-match",
      "data-page-search-index": String(index),
    }));
    highlightedUntil = range.to;
  }
  return DecorationSet.create(document, decorations);
}

function stateFor(
  document: ProseMirrorNode,
  query: string,
  requestedActiveIndex = -1,
  initialRange?: TextMatch,
): PageSearchState {
  const ranges = findDocumentMatches(document, query);
  if (initialRange) {
    requestedActiveIndex = ranges.findIndex((range) => range.from === initialRange.from && range.to === initialRange.to);
  }
  const activeIndex =
    requestedActiveIndex >= 0 && requestedActiveIndex < ranges.length
      ? requestedActiveIndex
      : -1;
  return {
    query,
    ranges,
    total: ranges.length,
    activeIndex,
    decorations: decorationsFor(document, ranges, activeIndex),
  };
}

const emptySearchState = (document: ProseMirrorNode): PageSearchState => ({
  query: "",
  ranges: [],
  total: 0,
  activeIndex: -1,
  decorations: DecorationSet.empty,
});

export const PageSearchExtension = Extension.create({
  name: "pageSearch",

  addProseMirrorPlugins() {
    return [
      new Plugin<PageSearchState>({
        key: pageSearchKey,
        filterTransaction(transaction) {
          // Undo/redo retains steps but not transaction metadata. These remain
          // literal edits too, and must not trigger a quadratic autolink scan.
          if (transaction.steps.some((step) => step instanceof BatchReplaceStep)) {
            transaction.setMeta("preventAutolink", true);
          }
          return true;
        },
        state: {
          init: (_, state) => emptySearchState(state.doc),
          apply(transaction, previous) {
            const action = transaction.getMeta(pageSearchKey) as
              | PageSearchAction
              | undefined;
            if (action?.type === "clear") return emptySearchState(transaction.doc);
            if (action?.type === "query") {
              return stateFor(transaction.doc, action.query, -1, action.initialRange);
            }
            if (action?.type === "replaced") {
              const next = stateFor(transaction.doc, previous.query);
              const index = next.ranges.findIndex((range) => range.from >= action.nextFrom);
              next.activeIndex = next.total ? Math.max(index, 0) : -1;
              next.decorations = decorationsFor(transaction.doc, next.ranges, next.activeIndex);
              return next;
            }
            if (action?.type === "activate") {
              const activeIndex =
                action.activeIndex >= 0 && action.activeIndex < previous.total
                  ? action.activeIndex
                  : -1;
              return {
                ...previous,
                activeIndex,
                decorations: decorationsFor(
                  transaction.doc,
                  previous.ranges,
                  activeIndex,
                ),
              };
            }
            if (transaction.docChanged && previous.query) {
              const current = previous.ranges[previous.activeIndex];
              if (!current) return stateFor(transaction.doc, previous.query);
              // Follow the original text, not its index in a changing result
              // list. Insertions at either edge stay outside the active match.
              const mapped = {
                from: transaction.mapping.map(current.from, 1),
                to: transaction.mapping.map(current.to, -1),
              };
              const next = stateFor(transaction.doc, previous.query, -1, mapped);
              if (next.activeIndex < 0 && next.total) {
                // The active text no longer matches. Continue from its mapped
                // position, wrapping only when no later match remains.
                const index = next.ranges.findIndex((range) => range.from >= mapped.from);
                next.activeIndex = Math.max(index, 0);
                next.decorations = decorationsFor(transaction.doc, next.ranges, next.activeIndex);
              }
              return next;
            }
            return previous;
          },
        },
        props: {
          decorations: (state) => pageSearchKey.getState(state)?.decorations,
        },
      }),
    ];
  },
});

export function setDocumentSearchQuery(
  editor: Editor,
  query: string,
  initialRange?: TextMatch,
): PageSearchSnapshot {
  editor.view.dispatch(
    editor.state.tr.setMeta(pageSearchKey, { type: "query", query, initialRange } satisfies PageSearchAction),
  );
  return documentSearchSnapshot(editor);
}

export function activateDocumentSearchMatch(
  editor: Editor,
  activeIndex: number,
): PageSearchSnapshot {
  editor.view.dispatch(
    editor.state.tr.setMeta(pageSearchKey, {
      type: "activate",
      activeIndex,
    } satisfies PageSearchAction),
  );
  return documentSearchSnapshot(editor);
}

export function clearDocumentSearch(editor: Editor): void {
  editor.view.dispatch(
    editor.state.tr.setMeta(pageSearchKey, { type: "clear" } satisfies PageSearchAction),
  );
}

export function documentSearchSnapshot(editor: Editor): PageSearchSnapshot {
  const state = pageSearchKey.getState(editor.state);
  return {
    total: state?.total ?? 0,
    activeIndex: state?.activeIndex ?? -1,
  };
}

export type PageReplaceResult = PageSearchSnapshot & { replaced: number };

/** Replace literal text in the live document; all replacements form one undo step. */
export function replaceDocumentSearch(
  editor: Editor,
  replacement: string,
  all = false,
): PageReplaceResult {
  const search = pageSearchKey.getState(editor.state);
  if (editor.isDestroyed || !editor.isEditable || !search?.query || !search.total) {
    return { ...documentSearchSnapshot(editor), replaced: 0 };
  }
  // Replace all still consumes each original character at most once, from
  // left to right, even though navigation includes overlapping matches.
  let replacedUntil = -1;
  const ranges = all
    ? search.ranges.filter((range) => {
        if (range.from < replacedUntil) return false;
        replacedUntil = range.to;
        return true;
      })
    : [search.ranges[Math.max(search.activeIndex, 0)]];
  const transaction = editor.state.tr;
  const replacements: ReplaceStep[] = [];
  for (const range of ranges) {
    if (editor.state.doc.textBetween(range.from, range.to) === replacement) continue;
    const marks = editor.state.doc.resolve(range.from).marksAcross(editor.state.doc.resolve(range.to));
    replacements.push(new ReplaceStep(
      range.from,
      range.to,
      new Slice(replacement ? Fragment.from(editor.schema.text(replacement, marks ?? undefined)) : Fragment.empty, 0, 0),
    ));
  }
  // Use the same recognizable step for single and bulk edits so undo/redo
  // preserves literal replacement semantics even without transaction metadata.
  // StepMap recovery encodes the range index in 16 bits. Bound each batch
  // well below that limit, applying later batches first to keep coordinates.
  const batchSize = 16384;
  for (let end = replacements.length; end > 0; end -= batchSize) {
    transaction.step(new BatchReplaceStep(replacements.slice(Math.max(0, end - batchSize), end)));
  }
  transaction.setMeta(pageSearchKey, {
    type: "replaced",
    nextFrom: all ? 0 : ranges[0].from + replacement.length,
  } satisfies PageSearchAction);
  // Explicit replacement preserves existing marks, like other programmatic
  // edits. Autolink's changed-range scan is quadratic for many disjoint edits
  // and must not add formatting to the user's literal replacement text.
  transaction.setMeta("preventAutolink", true);
  const changed = transaction.docChanged;
  editor.view.dispatch(changed ? closeHistory(transaction) : transaction);
  // Subsequent typing should not be grouped with an explicit replacement.
  if (changed) editor.view.dispatch(closeHistory(editor.state.tr));
  return { ...documentSearchSnapshot(editor), replaced: ranges.length };
}
