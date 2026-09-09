import { Extension, type Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { markdownToPlainText } from "./agentReviewCore";

/**
 * 把 AI 优化建议标到正文对应位置上。
 *
 * 建议的 before 是后端从 Markdown 源码里切出来的精确子串，而编辑器里是渲染后的
 * ProseMirror 文档 —— 两者的坐标系不同，Markdown 的 `**粗体**` 在文档里只剩
 * `粗体`。所以这里按纯文本内容匹配，而不是按字节偏移映射：把 before 去掉 Markdown
 * 标记后在文档文本里找，找不到就不标。宁可少标一条，也不要标错位置。
 */

export type AgentReviewAnchor = {
  suggestionId: string;
  /** 建议的 before 原文，Markdown 形式 */
  before: string;
};

export type AgentReviewAnchorMatch = {
  suggestionId: string;
  from: number;
  to: number;
};

type AnchorState = {
  anchors: AgentReviewAnchor[];
  activeSuggestionId: string;
  matches: AgentReviewAnchorMatch[];
  decorations: DecorationSet;
};

type AnchorAction =
  | { type: "anchors"; anchors: AgentReviewAnchor[]; activeSuggestionId: string }
  | { type: "activate"; activeSuggestionId: string }
  | { type: "clear" };

const anchorKey = new PluginKey<AnchorState>("koinoteAgentReviewAnchors");

type TextSegment = {
  textFrom: number;
  textTo: number;
  documentFrom: number;
};

/**
 * 把整篇文档拉平成一段带位置映射的纯文本。
 *
 * 块之间插入一个空格：建议可能跨段落，但相邻两段的文字在文档里并不相连，
 * 不加分隔会让 "……结尾开头……" 拼成一个本不存在的匹配。
 */
function flattenDocument(document: ProseMirrorNode): {
  text: string;
  segments: TextSegment[];
} {
  let text = "";
  const segments: TextSegment[] = [];

  document.descendants((node, position) => {
    if (node.isText && node.text) {
      const textFrom = text.length;
      text += node.text;
      segments.push({ textFrom, textTo: text.length, documentFrom: position });
      return false;
    }
    if (node.isInline && node.isLeaf) {
      // 图片、硬换行等原子节点占一个文档位置，但没有文本。
      text += " ";
      return false;
    }
    if (node.isTextblock && text.length > 0) {
      text += " ";
    }
    return true;
  });

  return { text, segments };
}

function normalizeForMatch(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * 归一化拉平文本，同时留下「归一化后的第 i 个字符来自原文第几位」的映射。
 *
 * 不能拿归一化后的下标直接去查按原文建的 segments：折叠空白和 trim 都会让字符串
 * 变短，后面每个下标都往前挪，高亮就整体偏出去几个字。偏一个字比不高亮更糟 ——
 * 用户会以为 AI 要改的是旁边那处。
 */
function normalizeWithMap(value: string): { text: string; indexMap: number[] } {
  let text = "";
  const indexMap: number[] = [];
  // 折叠出来的那个空格记的是这段空白的**首字符**位置，不是它后面那个字。命中的
  // 首尾字符不会是空格（needle 已 trim），所以端点映射用不到它；但保持语义正确，
  // 后面有人拿中间某位去映射时才不会踩坑。
  let whitespaceStart = -1;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (/\s/.test(char)) {
      // 连续空白折叠成一个空格；开头的空白整段丢掉（等价于 trim 的前半段）
      if (text.length > 0 && whitespaceStart < 0) whitespaceStart = index;
      continue;
    }
    if (whitespaceStart >= 0) {
      text += " ";
      indexMap.push(whitespaceStart);
      whitespaceStart = -1;
    }
    text += char;
    indexMap.push(index);
  }
  // 结尾挂着的空白不写出去，等价于 trim 的后半段
  return { text, indexMap };
}

/**
 * 在拉平文本里定位一条建议，返回文档坐标。
 *
 * 命中必须唯一：同一段文字在文章里出现多次时，标错一处比不标更糟——用户会以为
 * AI 想改的是另一处。后端的锚点唯一性校验是针对 Markdown 源码的，剥掉标记后
 * 仍有可能撞车，所以这里再查一次。
 */
function locateAnchor(
  text: string,
  indexMap: number[],
  segments: TextSegment[],
  before: string,
): { from: number; to: number } | null {
  const needle = normalizeForMatch(markdownToPlainText(before));
  if (needle.length < 2) return null;

  const first = text.indexOf(needle);
  if (first < 0) return null;
  if (text.indexOf(needle, first + 1) >= 0) return null;

  // 先把归一化下标换回原文下标，再查 segments —— segments 是按原文建的。
  const rawFirst = indexMap[first];
  const rawEnd = indexMap[first + needle.length - 1];
  if (rawFirst === undefined || rawEnd === undefined) return null;

  const startSegment = segments.find(
    (segment) => rawFirst >= segment.textFrom && rawFirst < segment.textTo,
  );
  const endSegment = segments.find(
    (segment) => rawEnd >= segment.textFrom && rawEnd < segment.textTo,
  );
  if (!startSegment || !endSegment) return null;

  return {
    from: startSegment.documentFrom + (rawFirst - startSegment.textFrom),
    to: endSegment.documentFrom + (rawEnd - endSegment.textFrom) + 1,
  };
}

export function matchAgentReviewAnchors(
  document: ProseMirrorNode,
  anchors: AgentReviewAnchor[],
): AgentReviewAnchorMatch[] {
  if (anchors.length === 0) return [];
  const { text, segments } = flattenDocument(document);
  const { text: normalized, indexMap } = normalizeWithMap(text);
  const matches: AgentReviewAnchorMatch[] = [];
  const claimed: Array<{ from: number; to: number }> = [];

  for (const anchor of anchors) {
    const range = locateAnchor(normalized, indexMap, segments, anchor.before);
    if (!range) continue;
    // 两条建议标到同一段文字上时只留先来的那条：重叠的波浪线无法点选，
    // 而后端已经保证接受的建议互不重叠，这里撞车只可能是剥标记造成的假匹配。
    if (claimed.some((value) => range.from < value.to && value.from < range.to)) {
      continue;
    }
    claimed.push(range);
    matches.push({ suggestionId: anchor.suggestionId, ...range });
  }
  return matches;
}

function decorationsFor(
  document: ProseMirrorNode,
  matches: AgentReviewAnchorMatch[],
  activeSuggestionId: string,
): DecorationSet {
  return DecorationSet.create(
    document,
    matches.map((match) =>
      Decoration.inline(match.from, match.to, {
        class:
          match.suggestionId === activeSuggestionId
            ? "kn-agent-anchor kn-agent-anchor-current"
            : "kn-agent-anchor",
        "data-agent-suggestion-id": match.suggestionId,
      }),
    ),
  );
}

function stateFor(
  document: ProseMirrorNode,
  anchors: AgentReviewAnchor[],
  activeSuggestionId: string,
): AnchorState {
  const matches = matchAgentReviewAnchors(document, anchors);
  return {
    anchors,
    activeSuggestionId,
    matches,
    decorations: decorationsFor(document, matches, activeSuggestionId),
  };
}

const emptyAnchorState: AnchorState = {
  anchors: [],
  activeSuggestionId: "",
  matches: [],
  decorations: DecorationSet.empty,
};

export const AgentReviewAnchorExtension = Extension.create({
  name: "agentReviewAnchors",

  addProseMirrorPlugins() {
    return [
      new Plugin<AnchorState>({
        key: anchorKey,
        state: {
          init: () => emptyAnchorState,
          apply(transaction, previous) {
            const action = transaction.getMeta(anchorKey) as
              | AnchorAction
              | undefined;
            if (action?.type === "clear") return emptyAnchorState;
            if (action?.type === "anchors") {
              return stateFor(
                transaction.doc,
                action.anchors,
                action.activeSuggestionId,
              );
            }
            if (action?.type === "activate") {
              return {
                ...previous,
                activeSuggestionId: action.activeSuggestionId,
                decorations: decorationsFor(
                  transaction.doc,
                  previous.matches,
                  action.activeSuggestionId,
                ),
              };
            }
            // 正文改动后重新定位：落实一条建议会改掉那段文字，其余建议的位置
            // 也随之移动。直接用 mapping 平移不够——被改掉的那条应当消失。
            if (transaction.docChanged && previous.anchors.length > 0) {
              return stateFor(
                transaction.doc,
                previous.anchors,
                previous.activeSuggestionId,
              );
            }
            return previous;
          },
        },
        props: {
          decorations: (state) => anchorKey.getState(state)?.decorations,
          handleClick(view, _position, event) {
            const target = (event.target as HTMLElement | null)?.closest(
              "[data-agent-suggestion-id]",
            );
            const suggestionId = target?.getAttribute(
              "data-agent-suggestion-id",
            );
            if (!suggestionId) return false;
            view.dom.dispatchEvent(
              new CustomEvent(AGENT_REVIEW_ANCHOR_CLICK_EVENT, {
                detail: { suggestionId },
                bubbles: true,
              }),
            );
            // 不吞掉点击：用户可能只是想把光标放到那段文字里继续编辑。
            return false;
          },
        },
      }),
    ];
  },
});

export const AGENT_REVIEW_ANCHOR_CLICK_EVENT = "koinote:agent-anchor-click";

export type AgentReviewAnchorClickDetail = { suggestionId: string };

export function setAgentReviewAnchors(
  editor: Editor,
  anchors: AgentReviewAnchor[],
  activeSuggestionId = "",
): AgentReviewAnchorMatch[] {
  editor.view.dispatch(
    editor.state.tr.setMeta(anchorKey, {
      type: "anchors",
      anchors,
      activeSuggestionId,
    } satisfies AnchorAction),
  );
  return agentReviewAnchorMatches(editor);
}

export function activateAgentReviewAnchor(
  editor: Editor,
  suggestionId: string,
): void {
  editor.view.dispatch(
    editor.state.tr.setMeta(anchorKey, {
      type: "activate",
      activeSuggestionId: suggestionId,
    } satisfies AnchorAction),
  );
}

export function clearAgentReviewAnchors(editor: Editor): void {
  editor.view.dispatch(
    editor.state.tr.setMeta(anchorKey, { type: "clear" } satisfies AnchorAction),
  );
}

export function agentReviewAnchorMatches(
  editor: Editor,
): AgentReviewAnchorMatch[] {
  return anchorKey.getState(editor.state)?.matches ?? [];
}

/** 把某条建议滚到视口中间，供面板点卡片时调用。 */
export function scrollToAgentReviewAnchor(
  editor: Editor,
  suggestionId: string,
): boolean {
  const match = agentReviewAnchorMatches(editor).find(
    (value) => value.suggestionId === suggestionId,
  );
  if (!match) return false;
  activateAgentReviewAnchor(editor, suggestionId);
  window.requestAnimationFrame(() => {
    const target = editor.view.dom.querySelector(".kn-agent-anchor-current");
    target?.scrollIntoView({ block: "center", behavior: "smooth" });
  });
  return true;
}
