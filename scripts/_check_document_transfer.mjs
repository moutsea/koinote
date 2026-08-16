import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { strToU8, zipSync } from "fflate";
import {
  cleanArchivePath,
  forEachConcurrent,
  ImportValidationError,
  importFileKind,
  IMPORT_FILE_ACCEPT,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_DOCUMENT_BYTES,
  MAX_IMPORT_FILES,
  MAX_IMPORT_SOURCE_IMAGE_BYTES,
  MAX_IMPORT_UPLOAD_IMAGE_BYTES,
  imageReferences,
  replaceFilenamePlaceholder,
  resolveRelativePath,
  rewriteImageReferences,
  truncateUnicode,
  UnsupportedImportFormatError,
  validateImportEntrySize,
} from "./_document_transfer_core_bundle.mjs";
import {
  IMPORT_IMAGE_MAX_DIMENSION,
  importImageEncodingAttempts,
  importImageFlattensAnimation,
  importImageCompressionPlan,
  importImageOutputType,
  shouldUseCompressedImportImage,
} from "./_import_image_compression_core_bundle.mjs";
import { unpackImportArchive } from "./_import_archive_core_bundle.mjs";

assert.equal(importFileKind("article.md"), "markdown");
assert.equal(importFileKind("Koinote Export.zip"), "archive");
assert.equal(importFileKind("assets/photo.JPEG"), "image");
assert.equal(importFileKind("Koinote Export/manifest.json"), "manifest");
assert.equal(importFileKind("article.docx"), null);
assert.match(IMPORT_FILE_ACCEPT, /\.md/);
assert.match(IMPORT_FILE_ACCEPT, /\.zip/);
const unsupported = new UnsupportedImportFormatError("article.docx");
assert.equal(unsupported.filename, "article.docx");
assert.equal(unsupported.name, "UnsupportedImportFormatError");
assert.equal(MAX_IMPORT_FILES, 1_000);
assert.equal(MAX_IMPORT_BYTES, 250 * 1024 * 1024);
assert.equal(
  replaceFilenamePlaceholder("不支持 {filename}", "论文 $& $` $'.docx"),
  "不支持 论文 $& $` $'.docx",
);
assert.doesNotThrow(() =>
  validateImportEntrySize("article.md", MAX_IMPORT_DOCUMENT_BYTES, "markdown"),
);
assert.throws(
  () =>
    validateImportEntrySize(
      "article.md",
      MAX_IMPORT_DOCUMENT_BYTES + 1,
      "markdown",
    ),
  (error) =>
    error instanceof ImportValidationError &&
    error.reason === "document_too_large" &&
    error.filename === "article.md",
);
assert.throws(
  () =>
    validateImportEntrySize(
      "photo.png",
      MAX_IMPORT_SOURCE_IMAGE_BYTES + 1,
      "image",
    ),
  (error) =>
    error instanceof ImportValidationError && error.reason === "image_too_large",
);

assert.deepEqual(
  importImageCompressionPlan("image/jpeg", 2 * 1024 * 1024, 5_120, 2_560),
  { width: IMPORT_IMAGE_MAX_DIMENSION, height: 1_280, shouldEncode: true },
);
assert.equal(
  importImageCompressionPlan("image/gif", 2 * 1024 * 1024, 800, 600)
    .shouldEncode,
  false,
);
assert.equal(shouldUseCompressedImportImage(2_000, 1_700, 10_000), true);
assert.equal(shouldUseCompressedImportImage(2_000, 1_900, 10_000), false);
assert.equal(shouldUseCompressedImportImage(12_000, 9_900, 10_000), true);
assert.equal(shouldUseCompressedImportImage(12_000, 10_100, 10_000), false);
assert.equal(
  importImageOutputType(
    "image/gif",
    MAX_IMPORT_UPLOAD_IMAGE_BYTES + 1,
    MAX_IMPORT_UPLOAD_IMAGE_BYTES,
  ),
  "image/webp",
);
assert.equal(
  importImageFlattensAnimation(
    "image/gif",
    MAX_IMPORT_UPLOAD_IMAGE_BYTES + 1,
    MAX_IMPORT_UPLOAD_IMAGE_BYTES,
  ),
  true,
);
assert.equal(
  importImageFlattensAnimation(
    "image/gif",
    MAX_IMPORT_UPLOAD_IMAGE_BYTES,
    MAX_IMPORT_UPLOAD_IMAGE_BYTES,
  ),
  false,
);
assert.deepEqual(importImageEncodingAttempts(5_120, 2_560).at(-1), {
  width: 640,
  height: 320,
  quality: 0.5,
});

let releaseFailedUpload;
let releaseInflightUpload;
const startedUploads = [];
const concurrentRun = forEachConcurrent([1, 2, 3], 2, async (item) => {
  startedUploads.push(item);
  if (item === 1) {
    await new Promise((resolve) => {
      releaseFailedUpload = resolve;
    });
    throw new Error("upload_failed");
  }
  if (item === 2) {
    await new Promise((resolve) => {
      releaseInflightUpload = resolve;
    });
  }
});
let concurrentSettled = false;
const observedConcurrentRun = concurrentRun.then(
  () => {
    concurrentSettled = true;
    return null;
  },
  (error) => {
    concurrentSettled = true;
    return error;
  },
);
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(startedUploads, [1, 2]);
releaseFailedUpload();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(concurrentSettled, false);
releaseInflightUpload();
const concurrentError = await observedConcurrentRun;
assert.match(concurrentError.message, /upload_failed/);
assert.deepEqual(startedUploads, [1, 2]);

const archive = zipSync({
  "notes/article.md": strToU8("# Article"),
  "notes/image.png": new Uint8Array([1, 2, 3]),
  "notes/ignored.docx": new Uint8Array([4, 5, 6]),
});
const unpacked = unpackImportArchive(
  archive.slice().buffer,
  MAX_IMPORT_FILES,
  MAX_IMPORT_BYTES,
);
assert.deepEqual(Object.keys(unpacked).sort(), [
  "notes/article.md",
  "notes/image.png",
]);
assert.throws(
  () => unpackImportArchive(archive.slice().buffer, 2, MAX_IMPORT_BYTES),
  (error) =>
    error?.name === "ImportValidationError" && error.reason === "too_many_files",
);

const transferSource = readFileSync("spa/src/documentTransfer.ts", "utf8");
const compressionSource = readFileSync(
  "spa/src/importImageCompression.ts",
  "utf8",
);
const compressionWorkerSource = readFileSync(
  "spa/src/workers/importImage.worker.ts",
  "utf8",
);
assert.match(transferSource, /unpackImportArchiveFile/);
assert.doesNotMatch(transferSource, /unzipSync/);
assert.match(transferSource, /prepareImportedImage/);
assert.match(transferSource, /IMPORT_IMAGE_CONCURRENCY = 3/);
assert.match(transferSource, /releaseUnusedImages\(\[\.\.\.uploadedImageKeys\]\)/);
assert.match(
  transferSource,
  /desktopLocalImageID[\s\S]*?readLocalImageObject[\s\S]*?offline\/\$\{localImageID\}/,
  "迁移 ZIP 必须内嵌尚未上传的桌面本地图片，不能导出私有协议死链",
);
assert.match(
  transferSource,
  /const cacheKey = key\s*\? `remote:\$\{key\}`\s*: `local:\$\{localImageID\}`/,
  "迁移导出的远端图与本地图缓存键必须使用显式命名空间",
);
assert.match(transferSource, /file\.size > MAX_IMPORT_BYTES/);
assert.match(compressionSource, /new Worker\(/);
assert.doesNotMatch(
  compressionSource,
  /file\.type === "image\/gif"[\s\S]{0,200}throw new ImportValidationError/,
);
assert.match(compressionWorkerSource, /new OffscreenCanvas\(/);
assert.match(compressionWorkerSource, /flattenedAnimation/);

assert.equal(cleanArchivePath("notes/../article.md"), "article.md");
assert.equal(cleanArchivePath("../outside.md"), null);
assert.equal(cleanArchivePath("/absolute.md"), null);
assert.equal(
  cleanArchivePath("folder\\nested\\article.md"),
  "folder/nested/article.md",
);
assert.equal(
  resolveRelativePath("notes/article.md", "../assets/a.png"),
  "assets/a.png",
);
assert.equal(
  resolveRelativePath("notes/article.md", "../../outside.png"),
  null,
);
assert.equal(
  resolveRelativePath("notes/article.md", "https://example.com/a.png"),
  null,
);
assert.equal(truncateUnicode("文档😀标题", 3), "文档😀");
assert.equal(truncateUnicode("😀".repeat(101), 100), "😀".repeat(100));

const markdown = [
  '![图注](../assets/a.png "标题")',
  '<img alt="第二张" src="../assets/b.webp">',
  "![重复](../assets/a.png)",
].join("\n");
assert.deepEqual(imageReferences(markdown), [
  "../assets/a.png",
  "../assets/b.webp",
]);
const rewritten = rewriteImageReferences(
  markdown,
  new Map([
    ["../assets/a.png", "https://koinote.test/images/a.png"],
    ["../assets/b.webp", "https://koinote.test/images/b.webp"],
  ]),
);
assert.match(
  rewritten,
  /!\[图注\]\(https:\/\/koinote\.test\/images\/a\.png "标题"\)/,
);
assert.match(rewritten, /src="https:\/\/koinote\.test\/images\/b\.webp"/);
assert.equal((rewritten.match(/images\/a\.png/g) ?? []).length, 2);

console.log("document transfer core checks passed");
