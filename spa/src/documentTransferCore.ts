export const IMPORT_FILE_ACCEPT =
  ".md,.zip,image/png,image/jpeg,image/gif,image/webp";
export const MAX_IMPORT_FILES = 1_000;
export const MAX_IMPORT_BYTES = 250 * 1024 * 1024;
export const MAX_IMPORT_DOCUMENT_BYTES = 1 * 1024 * 1024;
export const MAX_IMPORT_SOURCE_IMAGE_BYTES = 50 * 1024 * 1024;
export const MAX_IMPORT_UPLOAD_IMAGE_BYTES = 10 * 1024 * 1024;

export async function forEachConcurrent<T>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  let failed = false;
  let firstError: unknown;
  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (!failed && nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      try {
        await task(item);
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
  });
  await Promise.all(workers);
  if (failed) throw firstError;
}

export function replaceFilenamePlaceholder(
  template: string,
  filename: string,
): string {
  return template.replace("{filename}", () => filename);
}

export type ImportFileKind = "markdown" | "archive" | "image" | "manifest";

export class UnsupportedImportFormatError extends Error {
  readonly filename: string;

  constructor(filename: string) {
    super(`unsupported_import_format:${filename}`);
    this.name = "UnsupportedImportFormatError";
    this.filename = filename;
  }
}

export type ImportValidationReason =
  | "too_many_files"
  | "import_too_large"
  | "document_too_large"
  | "image_too_large";

export class ImportValidationError extends Error {
  readonly reason: ImportValidationReason;
  readonly filename?: string;

  constructor(reason: ImportValidationReason, filename?: string) {
    super(`${reason}${filename ? `:${filename}` : ""}`);
    this.name = "ImportValidationError";
    this.reason = reason;
    this.filename = filename;
  }
}

export function validateImportEntrySize(
  path: string,
  size: number,
  kind: ImportFileKind,
): void {
  if (kind === "markdown" && size > MAX_IMPORT_DOCUMENT_BYTES) {
    throw new ImportValidationError("document_too_large", basename(path));
  }
  if (kind === "image" && size > MAX_IMPORT_SOURCE_IMAGE_BYTES) {
    throw new ImportValidationError("image_too_large", basename(path));
  }
}

export function importFileKind(path: string): ImportFileKind | null {
  const name = basename(path).toLowerCase();
  if (name === "manifest.json") return "manifest";
  switch (extension(name)) {
    case "md":
      return "markdown";
    case "zip":
      return "archive";
    case "png":
    case "jpg":
    case "jpeg":
    case "gif":
    case "webp":
      return "image";
    default:
      return null;
  }
}

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
