import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DESKTOP_EDITOR_MENU_ACTIONS,
  DESKTOP_MENU_ACTIONS,
  DESKTOP_MENU_EVENT,
  desktopMenuEnabledActions,
  isDesktopMenuAction,
} from "./_desktop_menu_bundle.mjs";

const read = (path) => readFileSync(path, "utf8");
const rust = read("src-tauri/src/lib.rs");

assert.equal(DESKTOP_MENU_EVENT, "koinote:desktop-menu-action");
for (const action of DESKTOP_MENU_ACTIONS) {
  assert.equal(isDesktopMenuAction(action), true, `recognize ${action}`);
}
for (const invalid of [null, "", "quit", "new-window", 1]) {
  assert.equal(isDesktopMenuAction(invalid), false, `reject ${String(invalid)}`);
}

const anonymousDashboard = new Set(desktopMenuEnabledActions({
  editorRoute: false,
  authenticated: false,
  localMode: false,
  historyAvailable: false,
}));
assert.deepEqual(
  anonymousDashboard,
  new Set(["open-documentation", "show-keyboard-shortcuts", "check-updates"]),
);

const accountDashboard = new Set(desktopMenuEnabledActions({
  editorRoute: false,
  authenticated: true,
  localMode: false,
  historyAvailable: true,
}));
assert.equal(accountDashboard.has("quick-open"), true);
assert.equal(accountDashboard.has("search-all-documents"), true);
for (const action of DESKTOP_EDITOR_MENU_ACTIONS) {
  assert.equal(accountDashboard.has(action), false, `disable ${action} outside editor`);
}

const remoteEditor = new Set(desktopMenuEnabledActions({
  editorRoute: true,
  authenticated: true,
  localMode: false,
  historyAvailable: true,
}));
for (const action of DESKTOP_EDITOR_MENU_ACTIONS) {
  assert.equal(remoteEditor.has(action), true, `enable ${action} in editor`);
}

const localEditor = new Set(desktopMenuEnabledActions({
  editorRoute: true,
  authenticated: true,
  localMode: true,
  historyAvailable: true,
}));
for (const action of ["share-document", "ai-optimize", "version-history", "check-updates"]) {
  assert.equal(localEditor.has(action), false, `disable ${action} in local mode`);
}

const rustActions = [...rust.matchAll(/desktop_menu_item\(\s*handle,\s*"([^"]+)"/g)]
  .map((match) => match[1])
  .sort();
assert.deepEqual(rustActions, [...DESKTOP_MENU_ACTIONS].sort());
assert.match(rust, /install_desktop_menu\(app, &menu_settings\)\?/);
assert.match(rust, /strip_prefix\(DESKTOP_MENU_PREFIX\)/);
assert.match(rust, /app\.emit\(DESKTOP_MENU_EVENT, action\)/);

for (const submenu of ["file", "edit", "view", "navigate", "tools"]) {
  assert.match(rust, new RegExp(`SubmenuBuilder::new\\(handle, copy\\.${submenu}\\)`));
}
assert.match(
  rust,
  /SubmenuBuilder::with_id\(handle, WINDOW_SUBMENU_ID, copy\.window\)/,
);
assert.match(
  rust,
  /SubmenuBuilder::with_id\(handle, HELP_SUBMENU_ID, copy\.help\)/,
);
assert.match(rust, /DESKTOP_CLOSE_WINDOW_ACTION/);
assert.match(rust, /app\.get_webview_window\("main"\)/);

assert.match(
  rust,
  /"new-document",\s*copy\.new_document,\s*None,\s*enabled_actions/,
  "new document must keep input-context keyboard protection",
);
assert.match(
  rust,
  /"close-document",\s*copy\.close_document,\s*None,\s*enabled_actions/,
  "close document must keep input-context keyboard protection",
);
assert.match(
  rust,
  /"toggle-documents-panel",\s*copy\.toggle_documents,\s*None,\s*enabled_actions/,
  "panel accelerators must not bypass editor shortcut conflict protection",
);
assert.match(
  rust,
  /"toggle-outline-panel",\s*copy\.toggle_outline,\s*None,\s*enabled_actions/,
  "outline accelerator must not bypass editor shortcut conflict protection",
);
assert.match(
  rust,
  /"previous-document",\s*copy\.previous_document,\s*None,\s*enabled_actions/,
  "previous document must use only the JavaScript shortcut path",
);
assert.match(
  rust,
  /"next-document",\s*copy\.next_document,\s*None,\s*enabled_actions/,
  "next document must use only the JavaScript shortcut path",
);

const wiring = [
  ["spa/src/components/GlobalSearch.tsx", ["quick-open", "search-all-documents"]],
  [
    "spa/src/pages/EditorPage.tsx",
    [
      "new-document",
      "save-document",
      "close-document",
      "previous-document",
      "next-document",
      "toggle-documents-panel",
      "toggle-outline-panel",
      "share-document",
    ],
  ],
  ["spa/src/components/editor/DocumentFindBar.tsx", ["find-in-document"]],
  ["spa/src/components/editor/ExportMenu.tsx", ["export-document"]],
  ["spa/src/components/editor/LiveEditor.tsx", ["ai-optimize", "version-history"]],
  [
    "spa/src/components/AppShell.tsx",
    ["open-documentation", "show-keyboard-shortcuts", "check-updates"],
  ],
];

for (const [path, actions] of wiring) {
  const source = read(path);
  assert.match(source, /useDesktopMenuActions/);
  for (const action of actions) assert.match(source, new RegExp(`"${action}"`));
}

const shortcutsDialog = read("spa/src/components/KeyboardShortcutsDialog.tsx");
assert.match(shortcutsDialog, /role="dialog"/);
assert.match(shortcutsDialog, /event\.target === event\.currentTarget/);
assert.match(shortcutsDialog, /event\.key === "Escape"/);
assert.match(shortcutsDialog, /detectEditorShortcutPlatform/);
assert.match(shortcutsDialog, /showKeyboardShortcuts/);
assert.match(shortcutsDialog, /isDesktopRuntime/);
assert.match(shortcutsDialog, /desktopOnly\?: boolean/);
assert.match(
  shortcutsDialog,
  /shortcut\.desktopOnly/,
  "browser shortcut list must hide desktop-only actions",
);
assert.match(
  shortcutsDialog,
  /filter\(\(group\) => group\.shortcuts\.length > 0\)/,
  "browser shortcut list must remove empty groups",
);

const desktopMenuSource = read("spa/src/desktop/menu.ts");
assert.match(
  desktopMenuSource,
  /\.\.\.DESKTOP_EDITOR_MENU_ACTIONS\.filter/,
  "editor menu availability must use the shared action list",
);

const appShell = read("spa/src/components/AppShell.tsx");
assert.match(appShell, /syncDesktopMenuEnabled\(enabledActions\)/);
assert.match(appShell, /isKeyboardShortcutsShortcut/);
assert.match(appShell, /onShowKeyboardShortcuts/);
assert.doesNotMatch(
  appShell,
  /desktopRuntime && keyboardShortcutsOpen/,
  "shortcut dialog must also be available in the browser",
);

for (const locale of ["En", "Zh", "Fr", "Ja"]) {
  assert.match(rust, new RegExp(`DesktopMenuLocale::${locale} => DesktopMenuCopy`));
}
assert.match(rust, /if settings\.locale == next\s*\{\s*return Ok\(false\)/);
assert.match(rust, /desktop_set_menu_locale/);
assert.match(rust, /desktop_set_menu_enabled/);
assert.match(rust, /apply_desktop_menu_enabled/);
assert.match(rust, /\.enabled\(enabled_actions\.contains\(action\)\)/);
assert.match(rust, /menu_item\.set_enabled\(enabled_actions\.contains\(action\)\)/);
const installMenuSource = rust.slice(
  rust.indexOf("fn install_desktop_menu"),
  rust.indexOf("fn apply_desktop_menu_enabled"),
);
assert.doesNotMatch(
  installMenuSource,
  /apply_desktop_menu_enabled/,
  "menu setup must not synchronously dispatch set_enabled back to the main thread",
);

const i18nProvider = read("spa/src/i18n/index.tsx");
assert.doesNotMatch(i18nProvider, /localeRef\.current === l/);
assert.match(i18nProvider, /localStorage\.setItem\(STORAGE_KEY, l\)/);
assert.match(i18nProvider, /syncDesktopMenuLocale\(locale\)/);

console.log(`desktop menu: ${DESKTOP_MENU_ACTIONS.length} actions wired`);
