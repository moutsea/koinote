import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const shell = read("spa/src/components/AppShell.tsx");
const search = read("spa/src/components/GlobalSearch.tsx");
const documents = read("spa/src/pages/DocumentsPage.tsx");
const documentList = read("spa/src/components/editor/DocumentList.tsx");
const editor = read("spa/src/pages/EditorPage.tsx");
const share = read("spa/src/pages/SharePage.tsx");
const admin = read("spa/src/pages/AdminPage.tsx");
const home = read("spa/src/pages/HomePage.tsx");
const worker = read("worker/index.ts");

assert.match(shell, /<GlobalSearch\s*\/>/);
assert.match(search, /event\.metaKey \|\| event\.ctrlKey/);
assert.match(search, /<mark/);
assert.match(documents, /importDocumentsFromFiles/);
assert.match(documents, /exportDocumentsArchive/);
assert.match(documents, /webkitdirectory/);
assert.match(documents, /importFolderButton/);
assert.match(documentList, /onImport\(files\)/);
assert.match(documentList, /transfer\.importButton/);
assert.match(editor, /importDocumentsFromFiles\(files\)/);
assert.match(share, /copySharedDocument/);
assert.match(share, /sharedViews/);
assert.match(admin, /stats\.funnel/);
assert.match(admin, /stats\.retention/);
assert.match(home, /DESKTOP_DOWNLOAD_URL/);
assert.match(
  worker,
  /pathname === "\/download"[\s\S]*?Response\.redirect\(DESKTOP_RELEASES_URL, 302\)/,
);

console.log("growth UI wiring checks passed");
