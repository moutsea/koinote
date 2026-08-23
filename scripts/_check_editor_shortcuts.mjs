import { readFileSync } from "node:fs";
import {
  adjacentTabId,
  detectEditorShortcutPlatform,
  editorShortcutAction,
  isEditorShortcutInputContext,
  isKeyboardShortcutsShortcut,
  keyboardShortcutsOpenAfterShortcut,
  numberedTabId,
  shouldBlockEditorShortcutInInputContext,
  shouldPreserveInputShortcut,
} from "./_editor_shortcuts_bundle.mjs";

let pass = 0;
let fail = 0;

function eq(label, actual, expected) {
  if (actual === expected) pass += 1;
  else {
    fail += 1;
    console.error(`FAIL  ${label}: got ${String(actual)}, want ${String(expected)}`);
  }
}

function event(overrides = {}) {
  return {
    key: "Tab",
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    repeat: false,
    defaultPrevented: false,
    ...overrides,
  };
}

eq("macOS 平台识别", detectEditorShortcutPlatform("MacIntel", "Safari"), "mac");
eq("iPad 桌面 UA 识别", detectEditorShortcutPlatform("Linux", "Macintosh iPad"), "mac");
eq("Windows 平台识别", detectEditorShortcutPlatform("Win32", "Chrome"), "other");

for (const tagName of ["INPUT", "input", "TEXTAREA", "select"]) {
  eq(
    `${tagName} 属于输入上下文`,
    isEditorShortcutInputContext({ tagName }),
    true,
  );
}
eq(
  "contenteditable 属于输入上下文",
  isEditorShortcutInputContext({ tagName: "DIV", isContentEditable: true }),
  true,
);
eq(
  "普通元素不属于输入上下文",
  isEditorShortcutInputContext({ tagName: "BUTTON" }),
  false,
);
eq("空目标不属于输入上下文", isEditorShortcutInputContext(null), false);
eq(
  "输入上下文禁止关闭标签",
  shouldBlockEditorShortcutInInputContext("close-tab", true),
  true,
);
eq(
  "输入上下文禁止新建文档",
  shouldBlockEditorShortcutInInputContext("new-document", true),
  true,
);
for (const action of ["next-tab", "previous-tab", "select-tab-1", null]) {
  eq(
    `输入上下文允许 ${String(action)}`,
    shouldBlockEditorShortcutInInputContext(action, true),
    false,
  );
}
eq(
  "非输入上下文允许关闭标签",
  shouldBlockEditorShortcutInInputContext("close-tab", false),
  false,
);
eq(
  "输入上下文保留 Cmd/Ctrl+B 给粗体",
  shouldPreserveInputShortcut("toggle-documents-panel", true),
  true,
);
eq(
  "非输入上下文允许切换文档栏",
  shouldPreserveInputShortcut("toggle-documents-panel", false),
  false,
);
eq(
  "输入上下文保留 Cmd/Ctrl+反斜杠",
  shouldPreserveInputShortcut("toggle-outline-panel", true),
  true,
);

eq("Ctrl+Tab 切到下一标签", editorShortcutAction(event({ ctrlKey: true }), "mac"), "next-tab");
eq(
  "Ctrl+Shift+Tab 切到上一标签",
  editorShortcutAction(event({ ctrlKey: true, shiftKey: true }), "other"),
  "previous-tab",
);
eq("Cmd+Tab 留给系统", editorShortcutAction(event({ metaKey: true }), "mac"), null);

eq(
  "macOS Cmd+/ 打开快捷键表",
  isKeyboardShortcutsShortcut(event({ key: "/", metaKey: true }), "mac"),
  true,
);
eq(
  "Windows Ctrl+/ 打开快捷键表",
  isKeyboardShortcutsShortcut(event({ key: "/", ctrlKey: true }), "other"),
  true,
);
eq(
  "不同键盘布局按 Slash 也能打开快捷键表",
  isKeyboardShortcutsShortcut(
    event({ key: "Unidentified", code: "Slash", ctrlKey: true }),
    "other",
  ),
  true,
);
eq(
  "Cmd+Shift+/ 不接管",
  isKeyboardShortcutsShortcut(
    event({ key: "?", metaKey: true, shiftKey: true }),
    "mac",
  ),
  false,
);
eq(
  "快捷键表关闭且没有其他弹窗时打开",
  keyboardShortcutsOpenAfterShortcut(false, false, false),
  true,
);
eq(
  "快捷键表打开时再次按下快捷键关闭",
  keyboardShortcutsOpenAfterShortcut(true, true, true),
  false,
);
eq(
  "其他弹窗打开时不穿透",
  keyboardShortcutsOpenAfterShortcut(false, true, true),
  false,
);
eq(
  "快捷键表上方还有弹窗时不关闭底层弹窗",
  keyboardShortcutsOpenAfterShortcut(true, true, false),
  true,
);

eq(
  "macOS Cmd+W 关闭",
  editorShortcutAction(event({ key: "w", metaKey: true }), "mac"),
  "close-tab",
);
eq(
  "macOS Cmd+N 新建",
  editorShortcutAction(event({ key: "N", metaKey: true }), "mac"),
  "new-document",
);
eq(
  "macOS Ctrl+W 不接管",
  editorShortcutAction(event({ key: "w", ctrlKey: true }), "mac"),
  null,
);
eq(
  "Windows Ctrl+W 关闭",
  editorShortcutAction(event({ key: "w", ctrlKey: true }), "other"),
  "close-tab",
);
eq(
  "Windows Ctrl+N 新建",
  editorShortcutAction(event({ key: "n", ctrlKey: true }), "other"),
  "new-document",
);
eq(
  "Windows Cmd+N 不接管",
  editorShortcutAction(event({ key: "n", metaKey: true }), "other"),
  null,
);
eq(
  "macOS Cmd+B 切换文档栏",
  editorShortcutAction(event({ key: "b", metaKey: true }), "mac"),
  "toggle-documents-panel",
);
eq(
  "Windows Ctrl+B 切换文档栏",
  editorShortcutAction(event({ key: "b", ctrlKey: true }), "other"),
  "toggle-documents-panel",
);
eq(
  "macOS Cmd+反斜杠切换大纲",
  editorShortcutAction(event({ key: "\\", metaKey: true }), "mac"),
  "toggle-outline-panel",
);
eq(
  "Windows Ctrl+反斜杠切换大纲",
  editorShortcutAction(event({ key: "\\", ctrlKey: true }), "other"),
  "toggle-outline-panel",
);
for (let shortcutNumber = 1; shortcutNumber <= 9; shortcutNumber += 1) {
  eq(
    `macOS Cmd+${shortcutNumber} 直达标签`,
    editorShortcutAction(
      event({ key: String(shortcutNumber), metaKey: true }),
      "mac",
    ),
    `select-tab-${shortcutNumber}`,
  );
  eq(
    `Windows Ctrl+${shortcutNumber} 直达标签`,
    editorShortcutAction(
      event({ key: String(shortcutNumber), ctrlKey: true }),
      "other",
    ),
    `select-tab-${shortcutNumber}`,
  );
}
eq(
  "macOS Ctrl+1 不接管",
  editorShortcutAction(event({ key: "1", ctrlKey: true }), "mac"),
  null,
);
eq(
  "Windows Cmd+1 不接管",
  editorShortcutAction(event({ key: "1", metaKey: true }), "other"),
  null,
);
for (const key of ["0", "10", "-1", "Digit1"]) {
  eq(
    `非 1–9 数字快捷键 ${key}`,
    editorShortcutAction(event({ key, ctrlKey: true }), "other"),
    null,
  );
}

for (const [label, overrides] of [
  ["输入法组合态", { ctrlKey: true, isComposing: true }],
  ["长按重复", { ctrlKey: true, repeat: true }],
  ["已被组件处理", { ctrlKey: true, defaultPrevented: true }],
  ["Alt 组合", { ctrlKey: true, altKey: true }],
  ["Ctrl+Cmd 同按", { key: "w", ctrlKey: true, metaKey: true }],
  ["关闭快捷键带 Shift", { key: "w", ctrlKey: true, shiftKey: true }],
]) {
  eq(label, editorShortcutAction(event(overrides), "other"), null);
}

const tabs = ["a", "b", "c"];
eq("下一标签", adjacentTabId(tabs, "b", 1), "c");
eq("下一标签循环", adjacentTabId(tabs, "c", 1), "a");
eq("上一标签", adjacentTabId(tabs, "b", -1), "a");
eq("上一标签循环", adjacentTabId(tabs, "a", -1), "c");
eq("当前标签缺失时前进取首项", adjacentTabId(tabs, "missing", 1), "a");
eq("当前标签缺失时后退取末项", adjacentTabId(tabs, null, -1), "c");
eq("单标签保持当前", adjacentTabId(["a"], "a", 1), "a");
eq("空标签列表", adjacentTabId([], null, 1), null);

const numberedTabs = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
eq("数字 1 选择首个标签", numberedTabId(numberedTabs, 1), "a");
eq("数字 9 选择第九个标签", numberedTabId(numberedTabs, 9), "i");
eq("目标位置不存在时不切换", numberedTabId(["a", "b"], 3), null);
for (const invalidNumber of [0, 10, 1.5, Number.NaN]) {
  eq(`拒绝无效标签序号 ${invalidNumber}`, numberedTabId(numberedTabs, invalidNumber), null);
}

const editorPage = readFileSync("spa/src/pages/EditorPage.tsx", "utf8");
eq(
  "浏览器不注册窗口快捷键",
  /useEffect\(\(\) => \{\s*if \(!isDesktopRuntime\(\)\) return;\s*const platform = detectEditorShortcutPlatform/.test(
    editorPage,
  ),
  true,
);
for (const [label, source] of [
  ["切换复用 handleSelect", "handleSelect(target)"],
  ["数字直达读取最新标签顺序", "const target = numberedTabId("],
  ["关闭复用 handleCloseTab", "handleCloseTab(current.activeDocId)"],
  ["新建复用模板入口", "handleCreate(null)"],
  ["文档栏快捷键复用面板状态", "setDocsOpen(!docsOpen)"],
  ["大纲快捷键复用面板状态", "setOutlineOpen(!outlineOpen)"],
  ["读取最新标签状态", "const current = tabStateRef.current"],
  [
    "新建动作显式分支",
    'if (action === "new-document") handleCreate(null);',
  ],
  ["只在桌面端展示快捷键提示", "desktopShortcuts={isDesktopRuntime()}"],
  [
    "输入上下文保护",
    "shouldBlockEditorShortcutInInputContext(action, inputContext)",
  ],
]) {
  eq(label, editorPage.includes(source), true);
}

const tabShortcutBranch = editorPage.slice(
  editorPage.indexOf('if (action === "next-tab" || action === "previous-tab")'),
  editorPage.indexOf('if (action.startsWith("select-tab-"))'),
);
const tabRememberIndex = tabShortcutBranch.indexOf(
  "rememberActiveEditorSelection()",
);
const tabSelectIndex = tabShortcutBranch.indexOf("handleSelect(target)");
eq(
  "Ctrl+Tab 在导航前保存当前选区",
  tabRememberIndex !== -1 &&
    tabSelectIndex !== -1 &&
    tabRememberIndex < tabSelectIndex,
  true,
);
eq(
  "Ctrl+Tab 阻止 WebView 默认焦点导航",
  tabShortcutBranch.includes("event.preventDefault()"),
  true,
);

const numberedTabBranch = editorPage.slice(
  editorPage.indexOf('if (action.startsWith("select-tab-"))'),
  editorPage.indexOf('if (action === "close-tab")'),
);
const numberedRememberIndex = numberedTabBranch.indexOf(
  "rememberActiveEditorSelection()",
);
const numberedSelectIndex = numberedTabBranch.indexOf("handleSelect(target)");
eq(
  "数字标签快捷键同样在导航前保存选区",
  numberedRememberIndex !== -1 &&
    numberedSelectIndex !== -1 &&
    numberedRememberIndex < numberedSelectIndex,
  true,
);
eq(
  "数字标签快捷键阻止默认行为",
  numberedTabBranch.includes("event.preventDefault()"),
  true,
);

const tabBar = readFileSync("spa/src/components/editor/TabBar.tsx", "utf8");
for (const [label, source] of [
  ["关闭按钮读出快捷键", "aria-label={closeLabel}"],
  ["新建按钮读出快捷键", "aria-label={newDocumentLabel}"],
  ["关闭按钮声明标准快捷键", '"Meta+W Control+W"'],
  ["新建按钮声明标准快捷键", '"Meta+N Control+N"'],
]) {
  eq(label, tabBar.includes(source), true);
}

console.log(`\neditor shortcuts: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
