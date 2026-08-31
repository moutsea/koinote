export type WechatLayoutModuleName =
  | "hero"
  | "toc"
  | "callout"
  | "metrics"
  | "steps"
  | "quote"
  | "quote-card"
  | "faq"
  | "cta";

export type WechatLayoutDiagnostic = {
  level: "warning" | "error";
  code: string;
  module?: string;
  message: string;
};

export type WechatLayoutBlock = {
  name: string;
  caption: string;
  lines: string[];
  startLine: number;
  endLine: number;
};

export type WechatLayoutParseResult = {
  blocks: WechatLayoutBlock[];
  diagnostics: WechatLayoutDiagnostic[];
};

export type WechatLayoutRenderResult = {
  rendered: number;
  names: string[];
  diagnostics: WechatLayoutDiagnostic[];
};

const SUPPORTED_MODULES = new Set<WechatLayoutModuleName>([
  "hero",
  "toc",
  "callout",
  "metrics",
  "steps",
  "quote",
  "quote-card",
  "faq",
  "cta",
]);

const MAX_MODULES = 12;

export function parseWechatLayoutBlocks(markdown: string): WechatLayoutParseResult {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: WechatLayoutBlock[] = [];
  const diagnostics: WechatLayoutDiagnostic[] = [];
  let index = 0;
  let inFence = false;

  while (index < lines.length) {
    if (/^\s*```/.test(lines[index])) {
      inFence = !inFence;
      index += 1;
      continue;
    }
    if (inFence) {
      index += 1;
      continue;
    }
    const match = /^\s*:::\s*([a-z][a-z0-9-]*)(?:\[([^\]]*)\])?\s*$/.exec(
      lines[index],
    );
    if (!match) {
      index += 1;
      continue;
    }

    const name = match[1];
    const caption = (match[2] ?? "").trim();
    const startLine = index;
    const body: string[] = [];
    index += 1;
    let closed = false;
    let bodyInFence = false;
    while (index < lines.length) {
      if (/^\s*```/.test(lines[index])) {
        bodyInFence = !bodyInFence;
        body.push(lines[index]);
        index += 1;
        continue;
      }
      if (!bodyInFence && /^\s*:::\s*$/.test(lines[index])) {
        closed = true;
        break;
      }
      body.push(lines[index]);
      index += 1;
    }

    if (!closed) {
      diagnostics.push({
        level: "error",
        code: "unclosed_module",
        module: name,
        message: `未闭合的 :::${name} 块`,
      });
      break;
    }

    const endLine = index;
    index += 1;
    if (!SUPPORTED_MODULES.has(name as WechatLayoutModuleName)) {
      diagnostics.push({
        level: "warning",
        code: "unsupported_module",
        module: name,
        message: `暂不支持「${name}」模块，导出时会保留为普通文本`,
      });
      continue;
    }
    if (blocks.length >= MAX_MODULES) {
      diagnostics.push({
        level: "warning",
        code: "module_limit",
        module: name,
        message: `结构化模块最多渲染 ${MAX_MODULES} 个，后续模块会保留为普通文本`,
      });
      continue;
    }
    blocks.push({ name, caption, lines: body, startLine, endLine });
  }

  return { blocks, diagnostics };
}

export function applyWechatLayoutModules(
  stage: HTMLElement,
  markdown: string,
): WechatLayoutRenderResult {
  const parsed = parseWechatLayoutBlocks(markdown);
  const renderedNames: string[] = [];
  const diagnostics = [...parsed.diagnostics];

  for (const block of parsed.blocks) {
    const module = renderModule(block, stage);
    if (!module) {
      diagnostics.push({
        level: "error",
        code: "invalid_module",
        module: block.name,
        message: `「${block.name}」模块缺少必要内容，已保留为普通文本`,
      });
      continue;
    }
    if (!replaceBlockInStage(stage, block, module)) {
      diagnostics.push({
        level: "warning",
        code: "module_not_found",
        module: block.name,
        message: `未能在编辑器 HTML 中定位「${block.name}」模块，已保留为普通文本`,
      });
      continue;
    }
    renderedNames.push(block.name);
  }

  return {
    rendered: renderedNames.length,
    names: renderedNames,
    diagnostics,
  };
}

function replaceBlockInStage(
  stage: HTMLElement,
  block: WechatLayoutBlock,
  replacement: HTMLElement,
): boolean {
  const children = Array.from(stage.children);
  const startText = `:::${block.name}`;
  const startIndex = children.findIndex((child) => {
    const text = child.textContent ?? "";
    const firstLine = text.split(/\r?\n/)[0].trim();
    return (
      firstLine === startText ||
      firstLine.startsWith(`${startText}[`) ||
      normalizeText(text).startsWith(startText)
    );
  });
  if (startIndex < 0) return false;

  const startContent = children[startIndex].textContent ?? "";
  const normalizedStartContent = normalizeText(startContent);
  const hasInlineEnd =
    startContent.split(/\r?\n/).some((line) => normalizeText(line) === ":::") ||
    normalizedStartContent.lastIndexOf(":::") > startText.length;
  if (hasInlineEnd) {
    const anchor = children[startIndex];
    anchor.parentElement?.replaceChild(replacement, anchor);
    return true;
  }

  let endIndex = -1;
  for (let index = startIndex; index < children.length; index += 1) {
    if (normalizeText(children[index].textContent ?? "") === ":::") {
      endIndex = index;
      break;
    }
  }
  if (endIndex < 0) return false;

  const anchor = children[startIndex];
  anchor.parentElement?.insertBefore(replacement, anchor);
  for (let index = startIndex; index <= endIndex; index += 1) {
    children[index].remove();
  }
  return true;
}

function renderModule(block: WechatLayoutBlock, stage: HTMLElement): HTMLElement | null {
  const fields = parseFields(block.lines);
  switch (block.name) {
    case "hero":
      return renderHero(fields);
    case "toc":
      return renderToc(block, stage);
    case "callout":
      return renderCallout(fields, block.lines);
    case "metrics":
      return renderRows(block, "metrics");
    case "steps":
      return renderRows(block, "steps");
    case "quote":
      return renderQuote(block);
    case "quote-card":
      return renderQuoteCard(block);
    case "faq":
      return renderFaq(block);
    case "cta":
      return renderCta(fields);
    default:
      return null;
  }
}

function parseFields(lines: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of lines) {
    const match = /^\s*([a-zA-Z][\w-]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (match && match[2]) fields[match[1].toLowerCase()] = match[2];
  }
  return fields;
}

function nonEmpty(value: string | undefined): string {
  return value?.trim() ?? "";
}

function renderHero(fields: Record<string, string>): HTMLElement | null {
  const title = nonEmpty(fields.title);
  if (!title) return null;
  const section = moduleElement(
    "margin:28px 0;padding:24px 20px;border-radius:12px;background:#f3f0ea;color:#24211e;",
  );
  appendText(section, "p", nonEmpty(fields.eyebrow), "margin:0 0 8px;color:#8b5e3c;font-size:12px;letter-spacing:1px;font-weight:700;");
  appendText(section, "h2", title, "margin:0;font-size:24px;line-height:1.35;font-weight:800;");
  appendText(section, "p", nonEmpty(fields.subtitle), "margin:10px 0 0;color:#625a52;font-size:15px;line-height:1.7;");
  const points = splitPipe(fields.points);
  if (points.length > 0) {
    const list = document.createElement("ul");
    list.style.cssText = "margin:16px 0 0;padding-left:20px;color:#4b443d;font-size:14px;line-height:1.8;";
    for (const point of points) appendText(list, "li", point, "");
    section.appendChild(list);
  }
  return section;
}

function renderToc(block: WechatLayoutBlock, stage: HTMLElement): HTMLElement | null {
  const headings = Array.from(stage.querySelectorAll("h2, h3"))
    .map((heading) => normalizeText(heading.textContent ?? ""))
    .filter(Boolean);
  if (headings.length < 2) return null;
  const section = moduleElement("margin:24px 0;padding:16px 18px;border-left:4px solid #8b5e3c;background:#f7f4ef;");
  appendText(section, "p", block.caption || "阅读导航", "margin:0 0 8px;font-size:14px;font-weight:700;color:#4b443d;");
  const list = document.createElement("ol");
  list.style.cssText = "margin:0;padding-left:22px;color:#625a52;font-size:14px;line-height:1.8;";
  for (const heading of headings) appendText(list, "li", heading, "");
  section.appendChild(list);
  return section;
}

function renderCallout(fields: Record<string, string>, lines: string[]): HTMLElement | null {
  const body =
    nonEmpty(fields.body) ||
    nonEmpty(fields.text) ||
    lines
      .filter((line) => !/^\s*[a-zA-Z][\w-]*\s*:\s*.+$/.test(line))
      .join("\n")
      .trim();
  if (!body) return null;
  const type = nonEmpty(fields.type) || "info";
  const colors: Record<string, [string, string]> = {
    info: ["#e8f1fb", "#286090"],
    warning: ["#fff5df", "#9b6811"],
    success: ["#e9f7ef", "#2f7d4c"],
    danger: ["#fdebea", "#a23b37"],
  };
  const [background, color] = colors[type] ?? colors.info;
  const section = moduleElement(`margin:20px 0;padding:14px 16px;border-radius:8px;background:${background};color:${color};`);
  appendText(section, "p", body, "margin:0;font-size:14px;line-height:1.75;");
  return section;
}

function renderRows(block: WechatLayoutBlock, kind: "metrics" | "steps"): HTMLElement | null {
  const rows = block.lines
    .map((line) => line.split("|").map((cell) => cell.trim()).filter(Boolean))
    .filter((cells) => cells.length >= 3);
  if (rows.length === 0) return null;
  const section = moduleElement("margin:22px 0;padding:16px 14px;border:1px solid #e5e0d8;border-radius:10px;background:#fff;");
  appendText(section, "p", block.caption || (kind === "metrics" ? "核心数据" : "使用步骤"), "margin:0 0 12px;font-size:15px;font-weight:700;color:#3f3933;");
  for (const cells of rows) {
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:12px;padding:10px 0;border-top:1px solid #eee9e2;align-items:flex-start;";
    appendText(row, "strong", cells[0], "min-width:58px;color:#8b5e3c;font-size:14px;line-height:1.6;");
    const detail = document.createElement("div");
    detail.style.cssText = "flex:1;color:#625a52;font-size:14px;line-height:1.65;";
    if (kind === "metrics") {
      appendText(detail, "strong", cells[1], "display:block;color:#24211e;font-size:18px;line-height:1.3;");
      appendText(detail, "span", cells.slice(2).join(" · "), "display:block;margin-top:3px;");
    } else {
      appendText(detail, "strong", cells[1], "display:block;color:#24211e;");
      appendText(detail, "span", cells.slice(2).join(" · "), "display:block;margin-top:3px;");
    }
    row.appendChild(detail);
    section.appendChild(row);
  }
  return section;
}

function renderQuote(block: WechatLayoutBlock): HTMLElement | null {
  const body = block.lines.map((line) => line.trim()).filter(Boolean).join(" ");
  if (!body) return null;
  const quote = document.createElement("blockquote");
  quote.style.cssText = "margin:22px 0;padding:16px 18px;border-left:4px solid #8b5e3c;background:#f7f4ef;color:#4b443d;font-size:17px;line-height:1.75;font-style:italic;";
  quote.textContent = body;
  return quote;
}

function renderQuoteCard(block: WechatLayoutBlock): HTMLElement | null {
  const raw = block.lines.join("\n").trim();
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { text?: unknown; source?: unknown };
    if (typeof value.text !== "string" || !value.text.trim()) return null;
    const quote = document.createElement("blockquote");
    quote.style.cssText = "margin:26px 0;padding:24px 20px;border-radius:12px;background:#24211e;color:#fff;font-size:20px;line-height:1.6;font-weight:700;";
    quote.textContent = value.text.trim();
    if (typeof value.source === "string" && value.source.trim()) {
      appendText(quote, "footer", `— ${value.source.trim()}`, "margin-top:12px;color:#cfc7bd;font-size:12px;font-weight:400;");
    }
    return quote;
  } catch {
    return null;
  }
}

function renderFaq(block: WechatLayoutBlock): HTMLElement | null {
  const pairs: Array<[string, string]> = [];
  let question = "";
  for (const line of block.lines) {
    const q = /^\s*Q\s*:\s*(.+)$/i.exec(line);
    const a = /^\s*A\s*:\s*(.+)$/i.exec(line);
    if (q) question = q[1].trim();
    else if (a && question) {
      pairs.push([question, a[1].trim()]);
      question = "";
    }
  }
  if (pairs.length === 0) return null;
  const section = moduleElement("margin:22px 0;padding:16px 14px;border:1px solid #e5e0d8;border-radius:10px;background:#fff;");
  appendText(section, "p", block.caption || "常见问题", "margin:0 0 10px;font-size:15px;font-weight:700;color:#3f3933;");
  for (const [q, a] of pairs) {
    appendText(section, "p", q, "margin:10px 0 3px;font-size:14px;font-weight:700;color:#24211e;");
    appendText(section, "p", a, "margin:0;color:#625a52;font-size:14px;line-height:1.7;");
  }
  return section;
}

function renderCta(fields: Record<string, string>): HTMLElement | null {
  const title = nonEmpty(fields.title);
  if (!title) return null;
  const section = moduleElement("margin:28px 0;padding:20px 18px;border-radius:12px;background:#8b5e3c;color:#fff;text-align:center;");
  appendText(section, "p", title, "margin:0;font-size:17px;line-height:1.65;font-weight:700;");
  appendText(section, "p", nonEmpty(fields.subtitle), "margin:8px 0 0;color:#f2e8df;font-size:13px;line-height:1.6;");
  appendText(section, "p", nonEmpty(fields.note), "margin:14px 0 0;color:#ead8ca;font-size:11px;letter-spacing:1px;");
  return section;
}

function moduleElement(style: string): HTMLElement {
  const element = document.createElement("section");
  element.style.cssText = style;
  return element;
}

function appendText(parent: HTMLElement, tag: string, text: string, style: string): void {
  if (!text) return;
  const element = document.createElement(tag);
  element.textContent = text;
  if (style) element.style.cssText = style;
  parent.appendChild(element);
}

function splitPipe(value: string | undefined): string[] {
  return (value ?? "").split("|").map((item) => item.trim()).filter(Boolean);
}

function normalizeText(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}
