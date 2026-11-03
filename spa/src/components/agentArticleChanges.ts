import { TABLE_WIDTHS_MARKER, setupTableWidthParsing } from "./editor/tableWidths";
import type { Root, RootContent } from "hast";
import MarkdownIt from "markdown-it";
import taskLists from "markdown-it-task-lists";
import { markdownMathPlugin } from "./editor/markdownMath";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";

const markdown = unified().use(remarkParse).use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true }).use(rehypeRaw).use(rehypeSanitize);

// Use the editor tokenizer for articles containing math. Both sides of a
// comparison use the same parser, including when the last formula is removed.
const mathMarkdown = new MarkdownIt({ html: true, linkify: true }).use(taskLists).use(markdownMathPlugin);
setupTableWidthParsing(mathMarkdown);
// The editor also ignores all-zero width markers. Suppress their HTML token
// before parsing so it cannot leave a phantom newline in a nested block.
const renderHtmlBlock = mathMarkdown.renderer.rules.html_block!;
mathMarkdown.renderer.rules.html_block = (tokens, index, options, env, renderer) =>
  /^\s*<!--\s*koinote-table-widths:\s*[0-9, ]+\s*-->\s*$/.test(tokens[index].content)
    ? "" : renderHtmlBlock(tokens, index, options, env, renderer);
mathMarkdown.renderer.rules.table_open = (tokens, index, options, env, renderer) => {
  const token = tokens[index];
  if (token.map) token.attrSet("data-source-line", String(token.map[0]));
  return renderer.renderToken(tokens, index, options);
};
// MarkdownIt encodes GFM alignment as CSS. Preserve only the three allowed
// alignments as HTML attributes before sanitization, never arbitrary styles.
for (const tag of ["th_open", "td_open"]) {
  mathMarkdown.renderer.rules[tag] = (tokens, index, options, env, renderer) => {
    const token = tokens[index];
    const align = /^text-align:\s*(left|right|center);?$/.exec(token.attrGet("style") ?? "")?.[1];
    if (align) token.attrSet("align", align);
    return renderer.renderToken(tokens, index, options);
  };
}
const sanitizeRendered = unified().use(rehypeRaw).use(rehypeSanitize, {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    span: [...(defaultSchema.attributes?.span ?? []), ["dataType", "inline-math"], "dataLatex"],
    div: [...(defaultSchema.attributes?.div ?? []), ["dataType", "block-math"], "dataLatex"],
    table: [...(defaultSchema.attributes?.table ?? []), "dataSourceLine"],
  },
});
function mathArticle(content: string) {
  const html = mathMarkdown.render(content);
  const tree: Root = { type: "root", children: [{ type: "raw", value: html }] };
  return sanitizeRendered.runSync(tree);
}

function tableColumns(table: import("hast").Element): number {
  let columns = 0;
  for (const section of table.children) {
    if (section.type !== "element") continue;
    const rows = section.tagName === "tr" ? [section] : section.children;
    for (const row of rows) {
      if (row.type === "element" && row.tagName === "tr") {
        columns = Math.max(columns, row.children.filter(cell => cell.type === "element" && ["th", "td"].includes(cell.tagName)).length);
      }
    }
  }
  return columns;
}

function articleBlocks(title: string, content: string, math: boolean): RootContent[] {
  // Parse each complete article so references, tables and HTML keep their meaning.
  const tree = math ? mathArticle(content) : markdown.runSync(markdown.parse(content));
  const body = tree.children.filter(node =>
    node.type !== "comment" && (node.type !== "text" || node.value.trim() !== ""));
  // The editor stores column widths on the line preceding the GFM table.
  // Only validated numeric widths are added back to the sanitized preview.
  const widthsByLine = new Map<number, number[]>();
  if (content.includes(TABLE_WIDTHS_MARKER)) {
    for (const token of mathMarkdown.parse(content, {})) {
      const widths = token.attrGet(`data-${TABLE_WIDTHS_MARKER}`);
      if (token.type === "table_open" && token.map && widths) {
        widthsByLine.set(token.map[0], widths.split(",").map(Number));
      }
    }
  }
  function addWidths(nodes: RootContent[]) {
    for (const node of nodes) {
      if (node.type !== "element") continue;
      if (node.tagName === "table") {
        const line = math ? Number(node.properties.dataSourceLine) : (node.position?.start.line ?? 0) - 1;
        delete node.properties.dataSourceLine;
        const widths = widthsByLine.get(line);
        if (widths) {
          // Match the editor: a marker can only size cells that exist.
          const applied = widths.slice(0, tableColumns(node));
          if (applied.some(width => width > 0)) {
            node.children.unshift({
              type: "element", tagName: "colgroup", properties: {},
              children: applied.map(width => ({
                type: "element", tagName: "col", properties: width ? { style: `width: ${width}px` } : {}, children: [],
              })),
            });
          }
        }
      }
      addWidths(node.children);
    }
  }
  addWidths(body);
  if (title) body.unshift({
    type: "element", tagName: "h1", properties: { className: ["agent-preview-title"] },
    children: [{ type: "text", value: title }],
  });
  return body;
}

function signature(node: RootContent) {
  // Source offsets move when a preceding paragraph changes.
  return JSON.stringify(node, (key, value) => key === "position" ? undefined : value);
}

export type ArticleRun =
  | { kind: "equal"; blocks: RootContent[] }
  | { kind: "change"; before: RootContent[]; after: RootContent[] };

// Pair identical blocks in occurrence order, then retain the longest sequence
// that stays in document order. No quadratic matrix for long manuscripts.
function anchors(before: string[], after: string[]): [number, number][] {
  const positions = new Map<string, number[]>();
  for (let j = after.length - 1; j >= 0; j--) {
    const offsets = positions.get(after[j]);
    if (offsets) offsets.push(j);
    else positions.set(after[j], [j]);
  }
  const pairs: [number, number][] = [];
  const tails: number[] = [], parent: number[] = [];
  for (let i = 0; i < before.length; i++) {
    const j = positions.get(before[i])?.pop();
    if (j === undefined) continue;
    let lo = 0, hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (pairs[tails[mid]][1] < j) lo = mid + 1;
      else hi = mid;
    }
    parent.push(lo ? tails[lo - 1] : -1);
    tails[lo] = pairs.length;
    pairs.push([i, j]);
  }
  const matches: [number, number][] = [];
  for (let p = tails.at(-1) ?? -1; p !== -1; p = parent[p]) matches.push(pairs[p]);
  return matches.reverse();
}

export function articleChanges(beforeTitle: string, beforeContent: string, afterTitle: string, afterContent: string): ArticleRun[] {
  const math = [beforeContent, afterContent].some(content =>
    content.includes("$") && mathMarkdown.parse(content, {}).some(token =>
      token.type === "block_math" || token.children?.some(child => child.type === "inline_math")));
  const before = articleBlocks(beforeTitle, beforeContent, math);
  const after = articleBlocks(afterTitle, afterContent, math);
  const oldKeys = before.map(signature), newKeys = after.map(signature);
  let start = 0, end = 0;
  while (start < before.length && start < after.length && oldKeys[start] === newKeys[start]) start++;
  while (end < before.length - start && end < after.length - start &&
    oldKeys[before.length - 1 - end] === newKeys[after.length - 1 - end]) end++;

  const runs: ArticleRun[] = [];
  const equal = (node: RootContent) => {
    const last = runs.at(-1);
    if (last?.kind === "equal") last.blocks.push(node);
    else runs.push({ kind: "equal", blocks: [node] });
  };
  for (let i = 0; i < start; i++) equal(after[i]);
  let left = start, right = start;
  const changeUntil = (i: number, j: number) => {
    if (left < i || right < j) runs.push({ kind: "change", before: before.slice(left, i), after: after.slice(right, j) });
  };
  for (const [i, j] of anchors(oldKeys.slice(start, before.length - end), newKeys.slice(start, after.length - end))) {
    changeUntil(start + i, start + j);
    equal(after[start + j]);
    left = start + i + 1;
    right = start + j + 1;
  }
  changeUntil(before.length - end, after.length - end);
  for (let i = after.length - end; i < after.length; i++) equal(after[i]);
  return runs;
}
