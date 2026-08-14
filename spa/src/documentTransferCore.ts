export function cleanArchivePath(raw: string): string | null {
  const value = raw.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!value || value.startsWith("/") || value.includes("\0")) return null;
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

export function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function extension(path: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(path);
  return match?.[1].toLowerCase() ?? "";
}

export function truncateUnicode(value: string, maxLength: number): string {
  return Array.from(value).slice(0, maxLength).join("");
}

export function resolveRelativePath(
  fromFile: string,
  rawTarget: string,
): string | null {
  let decoded = rawTarget.trim().replace(/^<|>$/g, "");
  if (!decoded || /^(?:[a-z]+:|\/\/|#)/i.test(decoded)) return null;
  decoded = decoded.split(/[?#]/, 1)[0];
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    return null;
  }
  const base = dirname(fromFile);
  return cleanArchivePath(base ? `${base}/${decoded}` : decoded);
}

export function imageReferences(markdown: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    const ref = value.trim().replace(/^<|>$/g, "");
    if (!ref || seen.has(ref)) return;
    seen.add(ref);
    refs.push(ref);
  };
  for (const match of markdown.matchAll(
    /!\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))/g,
  )) {
    add(match[1] ?? match[2] ?? "");
  }
  for (const match of markdown.matchAll(
    /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi,
  )) {
    add(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return refs;
}

export function rewriteImageReferences(
  markdown: string,
  mapping: Map<string, string>,
): string {
  if (mapping.size === 0) return markdown;
  let output = markdown.replace(
    /(!\[[^\]]*\]\(\s*)(?:<([^>]+)>|([^\s)]+))/g,
    (whole, prefix: string, bracketed?: string, bare?: string) => {
      const original = (bracketed ?? bare ?? "").trim();
      const next = mapping.get(original);
      if (!next) return whole;
      return `${prefix}${bracketed !== undefined ? `<${next}>` : next}`;
    },
  );
  output = output.replace(
    /(<img\b[^>]*?\bsrc\s*=\s*)(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi,
    (
      whole,
      prefix: string,
      double?: string,
      single?: string,
      bare?: string,
    ) => {
      const original = (double ?? single ?? bare ?? "").trim();
      const next = mapping.get(original);
      return next ? `${prefix}"${next}"` : whole;
    },
  );
  return output;
}
