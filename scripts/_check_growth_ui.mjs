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
const productionCompose = read("docker-compose.prod.yml");

assert.match(shell, /<GlobalSearch\s*\/>/);
assert.match(search, /globalSearchShortcutMode\(event, platform, desktop\)/);
assert.match(search, /<mark/);
assert.match(documents, /importDocumentsFromFiles/);
assert.match(documents, /exportDocumentsArchive/);
assert.match(documents, /webkitdirectory/);
assert.match(documents, /importFolderButton/);
assert.match(documents, /getImportErrorMessage/);
assert.match(documents, /setTimeout\([\s\S]*?5_000/);
assert.match(documentList, /onImport\(files\)/);
assert.match(documentList, /transfer\.importButton/);
assert.match(documentList, /accept=\{IMPORT_FILE_ACCEPT\}/);
assert.match(editor, /importDocumentsFromFiles\(files\)/);
assert.match(editor, /getImportErrorMessage/);
assert.match(editor, /setTimeout\([\s\S]*?5_000/);
assert.match(share, /copySharedDocument/);
assert.match(share, /sharedViews/);
assert.match(admin, /stats\.funnel/);
assert.match(admin, /stats\.retention/);
assert.match(admin, /role="tablist"/);
assert.match(admin, /role="tab"/);
assert.match(admin, /\[scrollbar-width:none\]/);
for (const tab of ["overview", "growth", "revenue", "users", "server", "announcements"]) {
  assert.match(admin, new RegExp(`id: "${tab}"`));
}
assert.match(admin, /activeTab === "announcements"[\s\S]*?<AnnouncementAdminPanel \/>/);
assert.match(admin, /queryFn: getAdminServerStatus/);
assert.match(admin, /staleTime: 10_000/);
assert.match(
  admin,
  /refetchInterval: \(query\)[\s\S]*?current\?\.available && current\.cpu\.usagePercent == null[\s\S]*?\? 5_000[\s\S]*?: 30_000/,
);
assert.match(admin, /activeTab === "server"[\s\S]*?<ServerMonitorPanel/);
assert.match(admin, /event\.key === "ArrowRight"/);
assert.match(admin, /event\.key === "Home"/);
for (const hostMetric of ["stat", "meminfo", "uptime", "loadavg", "net/dev"]) {
  assert.match(productionCompose, new RegExp(`/proc/${hostMetric.replace("/", "\\/")}:`));
}
assert.doesNotMatch(productionCompose, /- \/proc:\/host\/proc/);
assert.doesNotMatch(productionCompose, /- \/:\/host/);
assert.match(productionCompose, /host-metrics\/filesystem-probe:\/host\/filesystem-probe:ro/);
assert.match(home, /DESKTOP_DOWNLOAD_URL/);
assert.match(
  worker,
  /pathname === "\/download"[\s\S]*?Response\.redirect\(DESKTOP_RELEASES_URL, 302\)/,
);

console.log("growth UI wiring checks passed");
