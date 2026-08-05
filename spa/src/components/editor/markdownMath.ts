// markdown-it 的内部 state 类型没有随包发布声明，
// 这里只声明本插件实际用到的字段，避免为此多引一个 @types 依赖。
type MathToken = {
  content: string;
  markup: string;
  block?: boolean;
  map?: [number, number];
};

type StateInline = {
  src: string;
  pos: number;
  posMax: number;
  push(type: string, tag: string, nesting: number): MathToken;
};

type StateBlock = {
  src: string;
  bMarks: number[];
  eMarks: number[];
  tShift: number[];
  line: number;
  push(type: string, tag: string, nesting: number): MathToken;
};

type MarkdownItLike = {
  inline: { ruler: { before(before: string, name: string, fn: unknown): void } };
  block: {
    ruler: {
      before(before: string, name: string, fn: unknown, opts?: unknown): void;
    };
  };
  renderer: {
    rules: Record<string, (tokens: MathToken[], idx: number) => string>;
  };
};

/**
 * markdown-it 插件：把 `$…$` 与 `$$…$$` 解析成数学节点的 HTML。
 *
 * 为什么需要它：tiptap-markdown 的解析链是 Markdown → HTML → ProseMirror，
 * 它本身不认识数学语法。@tiptap/extension-mathematics 自带的 markdownTokenizer
 * 是给 TipTap 官方 markdown 包用的，这里用不上。
 *
 * 产出的 HTML 必须与扩展的 parseHTML 对齐：
 *   块级 <div data-type="block-math" data-latex="…">
 *   行内 <span data-type="inline-math" data-latex="…">
 */

const DOLLAR = 0x24; // "$"

/** latex 要进 HTML 属性，必须转义，否则 `"` 或 `<` 能闭合属性注入标记 */
function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 行内 `$…$`：单个美元包裹，内部不允许换行，不匹配 `$$` */
function inlineMath(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== DOLLAR) return false;
  // `$$` 交给块级规则，行内不接
  if (state.src.charCodeAt(start + 1) === DOLLAR) return false;

  // 前一个字符是反斜杠时视为转义的字面美元号
  if (start > 0 && state.src.charCodeAt(start - 1) === 0x5c) return false;

  let pos = start + 1;
  const max = state.posMax;
  let found = -1;

  while (pos < max) {
    const code = state.src.charCodeAt(pos);
    if (code === 0x0a) return false; // 换行则不成立
    if (code === 0x5c) {
      // 跳过被转义的下一个字符
      pos += 2;
      continue;
    }
    if (code === DOLLAR) {
      found = pos;
      break;
    }
    pos++;
  }

  if (found < 0) return false;
  const latex = state.src.slice(start + 1, found);
  // `$$` 相邻（空内容）不成立，交给别的规则
  if (latex.trim() === "") return false;

  // 首尾不得为空白 —— pandoc / KaTeX auto-render 的通行规则。
  // 少了这条，「价格是 $100 和 $200」会被吞成一个公式（内容 "100 和 "）。
  if (/^\s|\s$/.test(latex)) return false;

  // 收尾 $ 紧跟数字时按货币处理，如「$5 和 $10」。
  // 真实公式后面极少直接接数字，而金额并列很常见。
  const afterCode = state.src.charCodeAt(found + 1);
  if (afterCode >= 0x30 && afterCode <= 0x39) return false;

  if (!silent) {
    const token = state.push("inline_math", "", 0);
    token.content = latex;
    token.markup = "$";
  }
  state.pos = found + 1;
  return true;
}

/**
 * 块级 `$$…$$`：支持同行闭合（`$$x$$`）与跨行闭合。
 */
function blockMath(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  const start = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];

  if (start + 2 > max) return false;
  if (
    state.src.charCodeAt(start) !== DOLLAR ||
    state.src.charCodeAt(start + 1) !== DOLLAR
  ) {
    return false;
  }

  const firstLine = state.src.slice(start + 2, max);

  // 同一行内闭合：$$x$$
  if (firstLine.trimEnd().endsWith("$$")) {
    const latex = firstLine.trimEnd().slice(0, -2);
    if (latex.trim() === "") return false;
    if (!silent) {
      const token = state.push("block_math", "", 0);
      token.block = true;
      token.content = latex.trim();
      token.markup = "$$";
      token.map = [startLine, startLine + 1];
    }
    state.line = startLine + 1;
    return true;
  }

  // 跨行：往下找单独的 `$$` 收尾
  let nextLine = startLine;
  let closed = false;
  const lines: string[] = [];
  if (firstLine.trim() !== "") lines.push(firstLine);

  while (nextLine + 1 < endLine) {
    nextLine++;
    const lineStart = state.bMarks[nextLine] + state.tShift[nextLine];
    const lineMax = state.eMarks[nextLine];
    const line = state.src.slice(lineStart, lineMax);
    if (line.trim() === "$$") {
      closed = true;
      break;
    }
    lines.push(line);
  }

  // 没找到收尾就不当数学块，避免把后半篇文档整个吞掉
  if (!closed) return false;

  const latex = lines.join("\n").trim();
  if (latex === "") return false;

  if (!silent) {
    const token = state.push("block_math", "", 0);
    token.block = true;
    token.content = latex;
    token.markup = "$$";
    token.map = [startLine, nextLine + 1];
  }
  state.line = nextLine + 1;
  return true;
}

export function markdownMathPlugin(md: MarkdownItLike): void {
  md.inline.ruler.before("escape", "inline_math", inlineMath);
  md.block.ruler.before("fence", "block_math", blockMath, {
    alt: ["paragraph", "reference", "blockquote", "list"],
  });

  md.renderer.rules.inline_math = (tokens, idx) =>
    `<span data-type="inline-math" data-latex="${escapeAttr(tokens[idx].content)}"></span>`;

  md.renderer.rules.block_math = (tokens, idx) =>
    `<div data-type="block-math" data-latex="${escapeAttr(tokens[idx].content)}"></div>`;
}
