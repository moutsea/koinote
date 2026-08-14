import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const shell = read("spa/src/components/AppShell.tsx");
const search = read("spa/src/components/GlobalSearch.tsx");
const documents = read("spa/src/pages/DocumentsPage.tsx");
const share = read("spa/src/pages/SharePage.tsx");
const admin = read("spa/src/pages/AdminPage.tsx");

assert.match(shell, /<GlobalSearch\s*\/>/);
assert.match(search, /event\.metaKey \|\| event\.ctrlKey/);
assert.match(search, /<mark/);
assert.match(documents, /importDocumentsFromFiles/);
assert.match(documents, /exportDocumentsArchive/);
assert.match(documents, /webkitdirectory/);
assert.match(documents, /importFolderButton/);
assert.match(share, /copySharedDocument/);
assert.match(share, /sharedViews/);
assert.match(admin, /stats\.funnel/);
assert.match(admin, /stats\.retention/);

console.log("growth UI wiring checks passed");
