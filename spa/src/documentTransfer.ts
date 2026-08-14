import { strFromU8, strToU8, unzipSync, zip } from "fflate";
import {
  createDocument,
  createFolder,
  fetchAppResource,
  getDocument,
  trackProductEvent,
  uploadImage,
  type DocumentSummary,
  type Folder,
  type SharedDocument,
} from "./api";
import { downloadBlob, safeFilename } from "./components/editor/exportDocument";
import {
  basename,
  cleanArchivePath,
  dirname,
  extension,
  imageReferences,
  resolveRelativePath,
  rewriteImageReferences,
  truncateUnicode,
} from "./documentTransferCore";

export { rewriteImageReferences } from "./documentTransferCore";

const MAX_ARCHIVE_FILES = 1_000;
const MAX_ARCHIVE_BYTES = 250 * 1024 * 1024;
const IMAGE_KEY_PATTERN =
  /u\/[A-Za-z0-9_-]{1,128}\/[0-9a-f]{8,64}\.(?:png|jpg|gif|webp)/;
const IMAGE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export type TransferProgress = (done: number, total: number) => void;

function withoutExtension(path: string): string {
  return path.replace(/\.[^.]+$/, "");
}

async function filesToEntries(files: File[]): Promise<Map<string, Uint8Array>> {
  const entries = new Map<string, Uint8Array>();
  let fileCount = 0;
  let totalBytes = 0;

  const add = (path: string, bytes: Uint8Array) => {
    const clean = cleanArchivePath(path);
    if (
      !clean ||
      clean.startsWith("__MACOSX/") ||
      basename(clean).startsWith(".")
    )
      return;
    fileCount += 1;
    totalBytes += bytes.byteLength;
    if (fileCount > MAX_ARCHIVE_FILES || totalBytes > MAX_ARCHIVE_BYTES) {
      throw new Error("archive_limit_exceeded");
    }
    entries.set(clean, bytes);
  };

  for (const file of files) {
    if (file.name.toLowerCase().endsWith(".zip")) {
      let zipFileCount = 0;
      let zipBytes = 0;
      const unpacked = unzipSync(new Uint8Array(await file.arrayBuffer()), {
        filter(info) {
          zipFileCount += 1;
          zipBytes += info.originalSize;
          if (
            zipFileCount > MAX_ARCHIVE_FILES ||
            zipBytes > MAX_ARCHIVE_BYTES
          ) {
            throw new Error("archive_limit_exceeded");
          }
          const ext = extension(info.name);
          return ext === "md" || Boolean(IMAGE_TYPES[ext]);
        },
      });
      for (const [path, bytes] of Object.entries(unpacked)) add(path, bytes);
      continue;
    }
    const path = file.webkitRelativePath || file.name;
    add(path, new Uint8Array(await file.arrayBuffer()));
  }
  for (const [path, bytes] of entries) {
    if (basename(path) !== "manifest.json") continue;
    try {
      const manifest = JSON.parse(strFromU8(bytes)) as { format?: string };
      if (manifest.format !== "koinote-markdown-export") continue;
      const root = dirname(path);
      if (!root) break;
      const prefix = `${root}/`;
      const shifted = new Map<string, Uint8Array>();
      for (const [entryPath, entryBytes] of entries) {
        if (entryPath.startsWith(prefix))
          shifted.set(entryPath.slice(prefix.length), entryBytes);
      }
      return shifted;
    } catch {
      break;
    }
  }
  return entries;
}

async function uploadArchiveImage(
  path: string,
  bytes: Uint8Array,
): Promise<string> {
  const mime = IMAGE_TYPES[extension(path)];
  if (!mime) throw new Error("unsupported_image");
  const file = new File([bytes as BlobPart], basename(path), { type: mime });
  return (await uploadImage(file)).url;
}

export async function importDocumentsFromFiles(
  files: File[],
  onProgress?: TransferProgress,
): Promise<number> {
  const entries = await filesToEntries(files);
  const markdownPaths = [...entries.keys()]
    .filter((path) => extension(path) === "md")
    .sort();
  if (markdownPaths.length === 0) throw new Error("no_markdown_files");

  const folderIDs = new Map<string, string | null>([["", null]]);
  const uploadedImages = new Map<string, string>();
  let imported = 0;

  async function ensureFolder(path: string): Promise<string | null> {
    if (folderIDs.has(path)) return folderIDs.get(path) ?? null;
    const parentPath = dirname(path);
    const parentFolderId = await ensureFolder(parentPath);
    const result = await createFolder({
      name: truncateUnicode(basename(path), 100) || "Imported",
      parentFolderId,
    });
    folderIDs.set(path, result.folder.folderId);
    return result.folder.folderId;
  }

  for (const markdownPath of markdownPaths) {
    const bytes = entries.get(markdownPath)!;
    let content = strFromU8(bytes);
    const replacements = new Map<string, string>();
    for (const ref of imageReferences(content)) {
      const resolved = resolveRelativePath(markdownPath, ref);
      if (!resolved) continue;
      const imageBytes = entries.get(resolved);
      if (!imageBytes || !IMAGE_TYPES[extension(resolved)]) continue;
      let uploadedURL = uploadedImages.get(resolved);
      if (!uploadedURL) {
        uploadedURL = await uploadArchiveImage(resolved, imageBytes);
        uploadedImages.set(resolved, uploadedURL);
      }
      replacements.set(ref, uploadedURL);
    }
    content = rewriteImageReferences(content, replacements);
    const folderId = await ensureFolder(dirname(markdownPath));
    await createDocument({
      title: truncateUnicode(withoutExtension(basename(markdownPath)), 200),
      content,
      folderId,
    });
    imported += 1;
    onProgress?.(imported, markdownPaths.length);
  }
  return imported;
}

function folderPath(folderId: string | null, folders: Folder[]): string {
  if (!folderId) return "";
  const byID = new Map(folders.map((folder) => [folder.folderId, folder]));
  const names: string[] = [];
  const seen = new Set<string>();
  let current = byID.get(folderId);
  while (current && !seen.has(current.folderId)) {
    seen.add(current.folderId);
    names.unshift(safeFilename(current.name, "Folder"));
    current = current.parentFolderId
      ? byID.get(current.parentFolderId)
      : undefined;
  }
  return names.join("/");
}

function imageKeyFromReference(reference: string): string | null {
  const match = IMAGE_KEY_PATTERN.exec(reference);
  return match?.[0] ?? null;
}

async function readImageObject(key: string): Promise<Uint8Array> {
  const response = await fetchAppResource(`/images/${key}`, {
    credentials: "include",
  });
  if (!response.ok) throw new Error(`image_fetch_${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function relativeAssetPath(documentFolder: string, key: string): string {
  const depth = documentFolder ? documentFolder.split("/").length : 0;
  return `${"../".repeat(depth)}assets/${key}`;
}

function zipAsync(entries: Record<string, Uint8Array>): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip(entries, { level: 6 }, (error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
  });
}

export async function exportDocumentsArchive(
  summaries: DocumentSummary[],
  folders: Folder[],
  onProgress?: TransferProgress,
): Promise<void> {
  const root = "Koinote Export";
  const entries: Record<string, Uint8Array> = {};
  const imageCache = new Map<string, Uint8Array>();
  const usedPaths = new Set<string>();
  const failedImages = new Set<string>();

  for (const [index, summary] of summaries.entries()) {
    const document = (await getDocument(summary.docId)).document;
    const documentFolder = folderPath(summary.folderId, folders);
    const base = safeFilename(document.title, "Untitled");
    let suffix = 1;
    let relativeDocumentPath = `${documentFolder ? `${documentFolder}/` : ""}${base}.md`;
    while (usedPaths.has(relativeDocumentPath.toLowerCase())) {
      suffix += 1;
      relativeDocumentPath = `${documentFolder ? `${documentFolder}/` : ""}${base}-${suffix}.md`;
    }
    usedPaths.add(relativeDocumentPath.toLowerCase());

    const replacements = new Map<string, string>();
    for (const ref of imageReferences(document.content)) {
      const key = imageKeyFromReference(ref);
      if (!key) continue;
      try {
        let bytes = imageCache.get(key);
        if (!bytes) {
          bytes = await readImageObject(key);
          imageCache.set(key, bytes);
          entries[`${root}/assets/${key}`] = bytes;
        }
        replacements.set(ref, relativeAssetPath(documentFolder, key));
      } catch {
        failedImages.add(key);
      }
    }
    const content = rewriteImageReferences(document.content, replacements);
    entries[`${root}/${relativeDocumentPath}`] = strToU8(content);
    onProgress?.(index + 1, summaries.length);
  }

  entries[`${root}/manifest.json`] = strToU8(
    JSON.stringify(
      {
        format: "koinote-markdown-export",
        version: 1,
        generatedAt: new Date().toISOString(),
        documents: summaries.length,
        images: imageCache.size,
        failedImages: [...failedImages],
      },
      null,
      2,
    ),
  );
  const archive = await zipAsync(entries);
  const date = new Date().toISOString().slice(0, 10);
  downloadBlob(
    new Blob([archive as BlobPart], { type: "application/zip" }),
    `koinote-export-${date}.zip`,
  );
  void trackProductEvent("first_export").catch(() => undefined);
}

export async function copySharedDocument(shared: SharedDocument) {
  const replacements = new Map<string, string>();
  const copied = new Map<string, string>();
  for (const ref of imageReferences(shared.content)) {
    const key = imageKeyFromReference(ref);
    if (!key) continue;
    let url = copied.get(key);
    if (!url) {
      const bytes = await readImageObject(key);
      url = await uploadArchiveImage(key, bytes);
      copied.set(key, url);
    }
    replacements.set(ref, url);
  }
  return createDocument({
    title: shared.title,
    content: rewriteImageReferences(shared.content, replacements),
  });
}
