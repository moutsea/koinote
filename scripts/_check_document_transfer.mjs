import assert from "node:assert/strict";
import {
  cleanArchivePath,
  imageReferences,
  resolveRelativePath,
  rewriteImageReferences,
  truncateUnicode,
} from "./_document_transfer_core_bundle.mjs";

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
