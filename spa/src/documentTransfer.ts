import { strFromU8, strToU8, zip } from "fflate";
import {
  createDocument,
  createFolder,
  fetchAppResource,
  getDocument,
  releaseUnusedImages,
  trackProductEvent,
  uploadImage,
  type DocumentSummary,
  type Folder,
  type SharedDocument,
  type UploadedImage,
} from "./api";
import { downloadBlob, safeFilename } from "./components/editor/exportDocument";
import {
  basename,
  cleanArchivePath,
  dirname,
  extension,
  forEachConcurrent,
  ImportValidationError,
  importFileKind,
  imageReferences,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_FILES,
  resolveRelativePath,
  replaceFilenamePlaceholder,
  rewriteImageReferences,
  truncateUnicode,
  UnsupportedImportFormatError,
  validateImportEntrySize,
} from "./documentTransferCore";
import { prepareImportedImage } from "./importImageCompression";
import { unpackImportArchiveFile } from "./importArchive";
import { desktopLocalImageID } from "./desktop/offlineImagesCore";

export {
  rewriteImageReferences,
  ImportValidationError,
  UnsupportedImportFormatError,
} from "./documentTransferCore";

const IMPORT_IMAGE_CONCURRENCY = 3;
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

type ImportErrorMessages = {
  importFailed: string;
  unsupportedImportFormat: string;
  importTooManyFiles: string;
  importTooLarge: string;
  importDocumentTooLarge: string;
  importImageTooLarge: string;
};

function withFilename(template: string, filename?: string): string {
  return replaceFilenamePlaceholder(template, filename || "");
}

export function getImportErrorMessage(
  error: unknown,
  messages: ImportErrorMessages,
): string {
  if (error instanceof UnsupportedImportFormatError) {
    return withFilename(messages.unsupportedImportFormat, error.filename);
  }
  if (error instanceof ImportValidationError) {
    switch (error.reason) {
      case "too_many_files":
        return messages.importTooManyFiles;
      case "import_too_large":
        return messages.importTooLarge;
      case "document_too_large":
        return withFilename(messages.importDocumentTooLarge, error.filename);
      case "image_too_large":
        return withFilename(messages.importImageTooLarge, error.filename);
    }
  }
  return messages.importFailed;
}

function withoutExtension(path: string): string {
  return path.replace(/\.[^.]+$/, "");
}

type ImportEntry = {
  size: number;
  read: () => Promise<Uint8Array>;
};

function bytesEntry(bytes: Uint8Array): ImportEntry {
  return { size: bytes.byteLength, read: async () => bytes };
}

function fileEntry(file: File): ImportEntry {
  return {
    size: file.size,
    read: async () => new Uint8Array(await file.arrayBuffer()),
  };
}

function unzipFile(
  file: File,
  remainingFiles: number,
  remainingBytes: number,
): Promise<Record<string, Uint8Array>> {
  if (file.size > MAX_IMPORT_BYTES) {
    return Promise.reject(new ImportValidationError("import_too_large"));
  }
  return unpackImportArchiveFile(file, remainingFiles, remainingBytes);
}

async function filesToEntries(files: File[]): Promise<Map<string, ImportEntry>> {
  const entries = new Map<string, ImportEntry>();
  let fileCount = 0;
  let totalBytes = 0;

  const add = (path: string, entry: ImportEntry) => {
    const clean = cleanArchivePath(path);
    if (
      !clean ||
      clean.startsWith("__MACOSX/") ||
      basename(clean).startsWith(".")
    )
      return;
    fileCount += 1;
    totalBytes += entry.size;
    if (fileCount > MAX_IMPORT_FILES) {
      throw new ImportValidationError("too_many_files");
    }
    if (totalBytes > MAX_IMPORT_BYTES) {
      throw new ImportValidationError("import_too_large");
    }
    entries.set(clean, entry);
  };

  for (const file of files) {
    const path = file.webkitRelativePath || file.name;
    const kind = importFileKind(path);
    const fromDirectory = Boolean(file.webkitRelativePath);
    if (!kind) {
      if (fromDirectory) continue;
      throw new UnsupportedImportFormatError(file.name);
    }
    if (kind === "manifest" && !fromDirectory) {
      throw new UnsupportedImportFormatError(file.name);
    }
    if (kind === "archive") {
      const unpacked = await unzipFile(
        file,
        MAX_IMPORT_FILES - fileCount,
        MAX_IMPORT_BYTES - totalBytes,
      );
      for (const [entryPath, bytes] of Object.entries(unpacked)) {
        add(entryPath, bytesEntry(bytes));
      }
      continue;
    }
    validateImportEntrySize(path, file.size, kind);
    add(path, fileEntry(file));
  }
  for (const [path, entry] of entries) {
    if (basename(path) !== "manifest.json") continue;
    try {
      const bytes = await entry.read();
      const manifest = JSON.parse(strFromU8(bytes)) as { format?: string };
      if (manifest.format !== "koinote-markdown-export") continue;
      const root = dirname(path);
      if (!root) break;
      const prefix = `${root}/`;
      const shifted = new Map<string, ImportEntry>();
      for (const [entryPath, shiftedEntry] of entries) {
        if (entryPath.startsWith(prefix))
          shifted.set(entryPath.slice(prefix.length), shiftedEntry);
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
  compress = false,
): Promise<{ image: UploadedImage; flattenedAnimation: boolean }> {
  const mime = IMAGE_TYPES[extension(path)];
  if (!mime) throw new Error("unsupported_image");
  const original = new File([bytes as BlobPart], basename(path), { type: mime });
  const prepared = compress
    ? await prepareImportedImage(original)
    : { file: original, flattenedAnimation: false };
  return {
    image: await uploadImage(prepared.file),
    flattenedAnimation: prepared.flattenedAnimation,
  };
}

export type ImportDocumentsResult = {
  imported: number;
  flattenedGifCount: number;
};

export async function importDocumentsFromFiles(
  files: File[],
  onProgress?: TransferProgress,
): Promise<ImportDocumentsResult> {
  const entries = await filesToEntries(files);
  const markdownPaths = [...entries.keys()]
    .filter((path) => extension(path) === "md")
    .sort();
  if (markdownPaths.length === 0) throw new Error("no_markdown_files");

  const folderIDs = new Map<string, string | null>([["", null]]);
  const uploadedImages = new Map<string, string>();
  const uploadedImageKeys = new Set<string>();
  const plannedDocuments: Array<{
    path: string;
    content: string;
    references: Array<{ original: string; resolved: string }>;
  }> = [];
  const referencedImages = new Set<string>();
  let imported = 0;
  let flattenedGifCount = 0;
  let completedWork = 0;

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
    const entry = entries.get(markdownPath)!;
    const content = strFromU8(await entry.read());
    entries.delete(markdownPath);
    const references: Array<{ original: string; resolved: string }> = [];
    for (const ref of imageReferences(content)) {
      const resolved = resolveRelativePath(markdownPath, ref);
      if (!resolved) continue;
      const imageEntry = entries.get(resolved);
      if (!imageEntry || !IMAGE_TYPES[extension(resolved)]) continue;
      references.push({ original: ref, resolved });
      referencedImages.add(resolved);
    }
    plannedDocuments.push({ path: markdownPath, content, references });
  }

  const totalWork = referencedImages.size + plannedDocuments.length;
  onProgress?.(0, totalWork);
  try {
    await forEachConcurrent(
      [...referencedImages],
      IMPORT_IMAGE_CONCURRENCY,
      async (imagePath) => {
        const entry = entries.get(imagePath);
        if (!entry) return;
        const bytes = await entry.read();
        const uploaded = await uploadArchiveImage(imagePath, bytes, true);
        uploadedImageKeys.add(uploaded.image.key);
        uploadedImages.set(imagePath, uploaded.image.url);
        if (uploaded.flattenedAnimation) flattenedGifCount += 1;
        entries.delete(imagePath);
        completedWork += 1;
        onProgress?.(completedWork, totalWork);
      },
    );

    for (const planned of plannedDocuments) {
      const replacements = new Map<string, string>();
      for (const reference of planned.references) {
        const uploadedURL = uploadedImages.get(reference.resolved);
        if (uploadedURL) replacements.set(reference.original, uploadedURL);
      }
      const folderId = await ensureFolder(dirname(planned.path));
      await createDocument({
        title: truncateUnicode(withoutExtension(basename(planned.path)), 200),
        content: rewriteImageReferences(planned.content, replacements),
        folderId,
      });
      imported += 1;
      completedWork += 1;
      onProgress?.(completedWork, totalWork);
    }
    return { imported, flattenedGifCount };
  } catch (error) {
    await releaseUnusedImages([...uploadedImageKeys]).catch(() => undefined);
    throw error;
  }
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

async function readLocalImageObject(reference: string): Promise<{
  bytes: Uint8Array;
  extension: string;
}> {
  const response = await fetchAppResource(reference);
  if (!response.ok) throw new Error(`image_fetch_${response.status}`);
  const contentType = response.headers.get("Content-Type")?.split(";", 1)[0];
  const imageExtension = Object.entries(IMAGE_TYPES).find(
    ([candidate, mime]) => candidate !== "jpeg" && mime === contentType,
  )?.[0];
  if (!imageExtension) throw new Error("image_type_unsupported");
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    extension: imageExtension,
  };
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
  const imageAssetPaths = new Map<string, string>();
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
      const localImageID = desktopLocalImageID(ref);
      if (!key && !localImageID) continue;
      const cacheKey = key
        ? `remote:${key}`
        : `local:${localImageID}`;
      try {
        let bytes = imageCache.get(cacheKey);
        let assetKey = imageAssetPaths.get(cacheKey);
        if (!bytes) {
          if (key) {
            bytes = await readImageObject(key);
            assetKey = key;
          } else {
            const local = await readLocalImageObject(ref);
            bytes = local.bytes;
            assetKey = `offline/${localImageID}.${local.extension}`;
          }
          imageCache.set(cacheKey, bytes);
          imageAssetPaths.set(cacheKey, assetKey);
          entries[`${root}/assets/${assetKey}`] = bytes;
        }
        if (!assetKey) throw new Error("image_asset_path_missing");
        replacements.set(ref, relativeAssetPath(documentFolder, assetKey));
      } catch {
        failedImages.add(key ?? ref);
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
      url = (await uploadArchiveImage(key, bytes)).image.url;
      copied.set(key, url);
    }
    replacements.set(ref, url);
  }
  return createDocument({
    title: shared.title,
    content: rewriteImageReferences(shared.content, replacements),
  });
}
