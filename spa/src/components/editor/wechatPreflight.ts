import { parseWechatLayoutBlocks, type WechatLayoutDiagnostic } from "./wechatLayout";

export type WechatCheckLevel = "info" | "warning" | "error";

export type WechatArticleMetadata = {
  title: string;
  author: string;
  digest: string;
  hasFrontmatter: boolean;
};

export type WechatPreflightCheck = {
  level: WechatCheckLevel;
  code: string;
  message: string;
  fix?: string;
};

export type WechatPreflightResult = {
  metadata: WechatArticleMetadata;
  headings: string[];
  images: { total: number; remote: number; local: number; missingAlt: number };
  modules: { rendered: string[]; diagnostics: WechatLayoutDiagnostic[] };
  checks: WechatPreflightCheck[];
  advice: string[];
  readiness: { copy: boolean; draft: boolean };
};

const MAX_TITLE_RUNES = 64;
const MAX_AUTHOR_RUNES = 16;
const MAX_DIGEST_RUNES = 128;

export function inspectWechatArticle(markdown: string, title: string): WechatPreflightResult {
  const document = parseArticleMetadata(markdown, title);
  const body = document.body;
  const headings = parseHeadings(body);
  const images = inspectImages(body);
  const modules = parseWechatLayoutBlocks(body);
  const checks: WechatPreflightCheck[] = [];

  if (!document.metadata.title.trim()) {
    checks.push({
      level: "error",
      code: "title_missing",
      message: "缺少文章标题。",
      fix: "为文章设置标题。",
    });
  }

  addLengthCheck(checks, "标题", document.metadata.title, MAX_TITLE_RUNES, "title_too_long");
  addLengthCheck(checks, "作者", document.metadata.author, MAX_AUTHOR_RUNES, "author_too_long");
  addLengthCheck(checks, "摘要", document.metadata.digest, MAX_DIGEST_RUNES, "digest_too_long");

  const firstHeading = headings.find((heading) => heading.level === 1)?.text ?? "";
  if (firstHeading && document.metadata.title && firstHeading === document.metadata.title) {
    checks.push({
      level: "warning",
      code: "duplicate_title",
      message: "正文首个一级标题与草稿标题重复，发布时可能出现两个标题。",
      fix: "删除正文一级标题，或调整草稿标题。",
    });
  } else if (firstHeading && document.metadata.title && firstHeading !== document.metadata.title) {
    checks.push({
      level: "info",
      code: "title_mismatch",
      message: "草稿标题与正文一级标题不同，请确认这是有意的。",
    });
  }

  if (images.missingAlt > 0) {
    checks.push({
      level: "info",
      code: "image_alt_missing",
      message: `${images.missingAlt} 张图片没有替代文字，读者无法在图片加载失败时了解内容。`,
      fix: "为重要图片补充 alt 文本或图注。",
    });
  }
  if (images.total > 0) {
    checks.push({
      level: "info",
      code: "image_sync",
      message: "图片会在复制或创建草稿时检查可达性；草稿流程会转存正文图片。",
    });
  }
  if (modules.diagnostics.length > 0) {
    for (const diagnostic of modules.diagnostics) {
      checks.push({
        level: diagnostic.level,
        code: `module_${diagnostic.code}`,
        message: diagnostic.message,
      });
    }
  }

  const plainLength = [...body.replace(/```[\s\S]*?```/g, "")].length;
  const advice: string[] = [];
  const h2Count = headings.filter((heading) => heading.level === 2).length;
  const orderedSteps = (body.match(/^\s*\d+[.)]\s+/gm) ?? []).length;
  const quoteCount = (body.match(/^\s*>/gm) ?? []).length;
  const metricCount = (body.match(/\d+(?:\.\d+)?\s*(?:%|％|倍|x|元|万元|亿元|人|次|小时|分钟|篇|个|k|m)(?![\w])/gi) ?? []).length;
  if (h2Count >= 3) advice.push("toc");
  if (orderedSteps >= 3) advice.push("steps");
  if (quoteCount > 0) advice.push("quote");
  if (metricCount >= 2) advice.push("metrics");
  if (plainLength >= 500 && images.total === 0) advice.push("cover");
  if (!/(保存|收藏|关注|回复|点击|试用|订阅|联系|评论|save|follow|click|try|subscribe|contact)/i.test(body)) advice.push("cta");

  const hasError = checks.some((check) => check.level === "error");
  const hasDraftBlocker = hasError || [...document.metadata.title].length === 0;
  return {
    metadata: document.metadata,
    headings: headings.map((heading) => heading.text),
    images,
    modules: { rendered: [], diagnostics: modules.diagnostics },
    checks,
    advice,
    readiness: { copy: !hasError, draft: !hasDraftBlocker },
  };
}

export function parseArticleMetadata(markdown: string, fallbackTitle: string): {
  metadata: WechatArticleMetadata;
  body: string;
  frontmatterKeys: string[];
} {
  const normalized = markdown.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length < 3 || lines[0].trim() !== "---") {
    return {
      metadata: { title: fallbackTitle.trim(), author: "", digest: "", hasFrontmatter: false },
      body: markdown,
      frontmatterKeys: [],
    };
  }
  const closing = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closing < 0) {
    return {
      metadata: { title: fallbackTitle.trim(), author: "", digest: "", hasFrontmatter: false },
      body: markdown,
      frontmatterKeys: [],
    };
  }
  const values: Record<string, string> = {};
  for (const line of lines.slice(1, closing)) {
    const match = /^\s*([a-zA-Z][\w-]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    values[match[1].toLowerCase()] = unquote(match[2]);
  }
  return {
    metadata: {
      title: values.title || fallbackTitle.trim(),
      author: values.author || "",
      digest: values.digest || values.summary || values.description || "",
      hasFrontmatter: true,
    },
    body: lines.slice(closing + 1).join("\n"),
    frontmatterKeys: Object.keys(values),
  };
}

export function removeWechatFrontmatterNodes(
  stage: HTMLElement,
  frontmatterKeys?: string[],
): void {
  const children = Array.from(stage.children);
  const delimiter = (child: Element) =>
    child.tagName === "HR" || child.textContent?.trim() === "---";
  const startIndex = children.findIndex(
    (child) => child.tagName !== "H1" && delimiter(child),
  );
  if (startIndex < 0) return;

  const toRemove: Element[] = [children[startIndex]];
  let index = startIndex + 1;
  const expectedKeys = frontmatterKeys
    ? new Set(frontmatterKeys.map((key) => key.toLowerCase()))
    : null;
  const consumedKeys = new Set<string>();
  while (
    index < children.length &&
    isFrontmatterFieldNode(children[index]) &&
    (expectedKeys === null || consumedKeys.size < expectedKeys.size)
  ) {
    toRemove.push(children[index]);
    for (const key of frontmatterFieldKeys(children[index])) {
      if (expectedKeys?.has(key)) consumedKeys.add(key);
    }
    index += 1;
  }
  if (index < children.length && delimiter(children[index])) {
    toRemove.push(children[index]);
  }
  for (const child of toRemove) child.remove();
}

function isFrontmatterFieldNode(child: Element): boolean {
  const lines = (child.textContent ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    lines.length > 0 &&
    lines.every((line) => /^[a-zA-Z][\w-]*\s*:\s*.*$/.test(line))
  );
}

function frontmatterFieldKeys(child: Element): string[] {
  const keys: string[] = [];
  for (const line of (child.textContent ?? "").split(/\r?\n/)) {
    const match = /^\s*([a-zA-Z][\w-]*)\s*:\s*.*$/.exec(line);
    if (match) keys.push(match[1].toLowerCase());
  }
  return keys;
}

function addLengthCheck(
  checks: WechatPreflightCheck[],
  label: string,
  value: string,
  limit: number,
  code: string,
): void {
  if ([...value].length <= limit) return;
  checks.push({
    level: "error",
    code,
    message: `${label}超过 ${limit} 个字符限制。`,
    fix: `请将${label}缩短到 ${limit} 个字符以内。`,
  });
}

function parseHeadings(markdown: string): Array<{ level: number; text: string }> {
  const headings: Array<{ level: number; text: string }> = [];
  let inFence = false;
  for (const rawLine of markdown.split("\n")) {
    const line = rawLine.trim();
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^(#{1,6})\s+(.+?)\s*#*$/.exec(line);
    if (match) headings.push({ level: match[1].length, text: match[2].trim() });
  }
  return headings;
}

function inspectImages(markdown: string): WechatPreflightResult["images"] {
  const images = [...markdown.matchAll(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)];
  let remote = 0;
  let local = 0;
  let missingAlt = 0;
  for (const image of images) {
    const alt = image[1].trim();
    const source = image[2].trim();
    if (!alt) missingAlt += 1;
    if (/^(?:https?:|data:)/i.test(source)) remote += 1;
    else local += 1;
  }
  return { total: images.length, remote, local, missingAlt };
}

function unquote(value: string): string {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1).trim();
  }
  return value.trim();
}
