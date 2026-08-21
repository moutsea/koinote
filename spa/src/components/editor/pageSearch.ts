import { Extension, type Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
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
  | { type: "query"; query: string }
  | { type: "activate"; activeIndex: number }
  | { type: "clear" };

const pageSearchKey = new PluginKey<PageSearchState>("koinotePageSearch");

function findDocumentMatches(
  document: ProseMirrorNode,
  query: string,
): TextMatch[] {
  const ranges: TextMatch[] = [];

  document.descendants((block, blockPosition) => {
    if (!block.isTextblock || ranges.length >= MAX_PAGE_SEARCH_MATCHES) return true;

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

    const matches = findTextMatches(
      text,
      query,
      MAX_PAGE_SEARCH_MATCHES - ranges.length,
    );
    for (const match of matches) {
      const startSegment = segments.find(
        (segment) => match.from >= segment.textFrom && match.from < segment.textTo,
      );
      const endOffset = match.to - 1;
      const endSegment = segments.find(
        (segment) => endOffset >= segment.textFrom && endOffset < segment.textTo,
      );
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
  return DecorationSet.create(
    document,
    ranges.map((range, index) =>
      Decoration.inline(range.from, range.to, {
        class:
          index === activeIndex
            ? "kn-page-search-match kn-page-search-current"
            : "kn-page-search-match",
        "data-page-search-index": String(index),
      }),
    ),
  );
}

function stateFor(
  document: ProseMirrorNode,
  query: string,
  requestedActiveIndex = -1,
): PageSearchState {
  const ranges = findDocumentMatches(document, query);
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
        state: {
          init: (_, state) => emptySearchState(state.doc),
          apply(transaction, previous) {
            const action = transaction.getMeta(pageSearchKey) as
              | PageSearchAction
              | undefined;
            if (action?.type === "clear") return emptySearchState(transaction.doc);
            if (action?.type === "query") {
              return stateFor(transaction.doc, action.query);
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
              return stateFor(
                transaction.doc,
                previous.query,
                Math.min(previous.activeIndex, previous.total - 1),
              );
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
): PageSearchSnapshot {
  editor.view.dispatch(
    editor.state.tr.setMeta(pageSearchKey, { type: "query", query } satisfies PageSearchAction),
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
