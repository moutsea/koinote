import { useCallback, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CopyX,
  FilePlus,
  ListX,
  MoreHorizontal,
  Plus,
  X,
} from "lucide-react";
import { useI18n } from "../../i18n";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { tabsToClose, type TabCloseScope } from "./tabPool";
import type { SaveStatus } from "./useDocumentSaver";

/**
 * 标签栏。
 *
 * 放在正文列顶部而不是跨整个窗口：左侧文件树是文档间的导航，与标签是两个层级 ——
 * 标签属于「正在编辑的这一组」，跨过去会让层级关系错乱。
 *
 * 保存失败必须落到标签上。单开文档时这个信号在标题栏一处就够，多开之后失败的
 * 那篇可能正在后台，标题栏根本看不见。
 */
export function TabBar({
  tabs,
  activeDocId,
  titleOf,
  statusOf,
  dirtyOf,
  onSelect,
  onClose,
  onCloseTabs,
  onCloseAll,
  closingAll,
  onCreate,
  creating,
  desktopShortcuts,
}: {
  tabs: string[];
  activeDocId: string | null;
  titleOf: (docId: string) => string;
  statusOf: (docId: string) => SaveStatus;
  dirtyOf: (docId: string) => boolean;
  onSelect: (docId: string) => void;
  onClose: (docId: string) => void;
  onCloseTabs: (docIds: string[]) => void;
  onCloseAll?: () => void;
  closingAll?: boolean;
  /**
   * 签名要和 EditorPage 的 handleCreate 一致（带上那个可选参数），不能简写成
   * `() => void`。写成无参的话，`onClick={onCreate}` 这种绑定在类型上是合法的
   * —— 参数少的函数可以赋给参数多的类型 —— 于是 React 把点击事件当成 folderId
   * 传了进去，而这一层的类型已经把它擦掉了，TS 查不出来。
   */
  onCreate: (folderId?: string | null) => void;
  creating: boolean;
  desktopShortcuts: boolean;
}) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    docId: string | null;
    source: "toolbar" | "tab";
  } | null>(null);
  const menuTrigger = useRef<HTMLElement | null>(null);
  const closeMenu = useCallback(() => {
    setMenu(null);
    if (document.activeElement?.getAttribute("role") === "menuitem") {
      menuTrigger.current?.focus({ preventScroll: true });
    }
  }, []);
  const closeLabel = desktopShortcuts
    ? `${t.editor.closeTab} (⌘W / Ctrl+W)`
    : t.editor.closeTab;
  const newDocumentLabel = desktopShortcuts
    ? `${t.editor.newDocument} (⌘N / Ctrl+N)`
    : t.editor.newDocument;

  const menuItems: ContextMenuItem[] = menu
    ? [
        {
          key: "new-document",
          label: newDocumentLabel,
          icon: <FilePlus className="h-3.5 w-3.5" />,
          disabled: creating,
          onSelect: () => onCreate(null),
        },
        ...([
          {
            key: "current",
            label: closeLabel,
            icon: <X className="h-3.5 w-3.5" />,
            separatorBefore: true,
          },
          {
            key: "others",
            label: t.editor.closeOtherTabs,
            icon: <CopyX className="h-3.5 w-3.5" />,
          },
          {
            key: "left",
            label: t.editor.closeTabsToLeft,
            icon: <ArrowLeft className="h-3.5 w-3.5" />,
          },
          {
            key: "right",
            label: t.editor.closeTabsToRight,
            icon: <ArrowRight className="h-3.5 w-3.5" />,
          },
          {
            key: "all",
            label: t.editor.closeAllTabs,
            icon: <ListX className="h-3.5 w-3.5" />,
            separatorBefore: true,
          },
        ] satisfies (Omit<ContextMenuItem, "onSelect"> & { key: TabCloseScope })[]).map(
          (item) => {
            const docIds = tabsToClose(tabs, menu.docId, item.key);
            return {
              ...item,
              disabled: docIds.length === 0 || Boolean(closingAll),
              onSelect: () => {
                if (item.key === "all" && onCloseAll) onCloseAll();
                else onCloseTabs(docIds);
              },
            };
          },
        ),
      ]
    : [];

  return (
    <div className="flex shrink-0 items-stretch border-b border-black/5 dark:border-white/10">
      <div
        role="tablist"
        aria-label={t.editor.tabsLabel}
        className="flex min-w-0 flex-1 items-stretch gap-0.5 overflow-x-auto px-1.5 pt-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((docId) => {
          const active = docId === activeDocId;
          const menuOpen = menu?.source === "tab" && menu.docId === docId;
          const status = statusOf(docId);
          const failed = ["failed", "backed-up", "conflict"].includes(status);
          return (
            <div
              key={docId}
              role="tab"
              data-koinote-editor-tab
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => onSelect(docId)}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                menuTrigger.current = event.currentTarget;
                setMenu({
                  x: event.clientX,
                  y: event.clientY,
                  docId,
                  source: "tab",
                });
              }}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
                  e.preventDefault();
                  const rect = e.currentTarget.getBoundingClientRect();
                  menuTrigger.current = e.currentTarget;
                  setMenu({ x: rect.left, y: rect.bottom, docId, source: "tab" });
                  return;
                }
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(docId);
                }
              }}
              // 中键关闭：浏览器标签的通用手势，习惯了的人会直接试
              onAuxClick={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  onClose(docId);
                }
              }}
              className={`group flex max-w-44 shrink-0 cursor-pointer items-center gap-1.5 rounded-t-lg border-b-2 px-2.5 py-1.5 text-xs transition ${
                active
                  ? "border-cinnabar-500 bg-black/[0.03] font-medium dark:bg-white/[0.06]"
                  : menuOpen
                    ? "border-cinnabar-500 bg-black/[0.04] font-medium dark:border-cinnabar-500 dark:bg-white/[0.08]"
                  : "border-transparent text-neutral-500 hover:bg-black/[0.02] dark:text-neutral-400 dark:hover:bg-white/[0.03]"
              }`}
            >
              <span
                className={`min-w-0 truncate ${
                  status === "backed-up"
                    ? "text-amber-700 dark:text-amber-400"
                    : failed
                      ? "text-red-600 dark:text-red-400"
                      : ""
                }`}
                title={
                  status === "conflict"
                    ? t.editor.resolveConflict
                    : status === "backed-up"
                      ? `${t.editor.saveFailed} · ${t.editor.saveFailedBackedUp}`
                      : failed
                        ? `${t.editor.saveFailed} · ${t.editor.saveBackupFailed}`
                        : titleOf(docId)
                }
              >
                {titleOf(docId) || t.editor.untitled}
              </span>

              {/* 未保存圆点。占位固定宽度，避免出现/消失时标签宽度跳动 */}
              <span
                aria-hidden="true"
                className="flex h-3 w-3 shrink-0 items-center justify-center"
              >
                {dirtyOf(docId) && !failed && (
                  <span className="h-1.5 w-1.5 rounded-full bg-neutral-400" />
                )}
                {failed && (
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      status === "backed-up" ? "bg-amber-700" : "bg-red-500"
                    }`}
                  />
                )}
              </span>

              <button
                type="button"
                disabled={closingAll}
                onClick={(e) => {
                  e.stopPropagation(); // 否则会连带触发标签的 onSelect
                  onClose(docId);
                }}
                aria-label={closeLabel}
                aria-keyshortcuts={desktopShortcuts ? "Meta+W Control+W" : undefined}
                title={closeLabel}
                className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-neutral-400 opacity-0 transition group-hover:opacity-100 hover:bg-black/10 hover:text-neutral-700 focus-visible:opacity-100 dark:hover:bg-white/15 dark:hover:text-neutral-200"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex shrink-0 items-center gap-0.5 px-1.5 pt-1">
        <button
          type="button"
          // 必须包一层箭头函数并显式传 null：直接写 onClick={onCreate} 会把 React
          // 的点击事件当成 folderId 传下去，那个对象里 view 指向 window（循环引用），
          // JSON.stringify 直接抛 TypeError —— 请求根本发不出去，只剩一句「请求失败」
          onClick={() => onCreate(null)}
          disabled={creating}
          aria-label={newDocumentLabel}
          aria-keyshortcuts={desktopShortcuts ? "Meta+N Control+N" : undefined}
          title={newDocumentLabel}
          className="my-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-neutral-400 transition hover:bg-black/5 hover:text-neutral-700 disabled:opacity-50 dark:hover:bg-white/10 dark:hover:text-neutral-200"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          aria-label={t.editor.tabActions}
          aria-haspopup="menu"
          aria-expanded={menu?.source === "toolbar"}
          title={t.editor.tabActions}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            if (menu?.source === "toolbar") {
              closeMenu();
              return;
            }
            const rect = event.currentTarget.getBoundingClientRect();
            menuTrigger.current = event.currentTarget;
            setMenu({
              x: rect.right,
              y: rect.bottom + 4,
              docId: activeDocId,
              source: "toolbar",
            });
          }}
          className="my-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-neutral-400 transition hover:bg-black/5 hover:text-neutral-700 dark:hover:bg-white/10 dark:hover:text-neutral-200"
        >
          <MoreHorizontal className="h-3.5 w-3.5" />
        </button>
      </div>
      {menu && (
        <ContextMenu
          key={`${menu.source}:${menu.docId}:${menu.x}:${menu.y}`}
          x={menu.x}
          y={menu.y}
          items={menuItems}
          onClose={closeMenu}
          ariaLabel={t.editor.tabActions}
        />
      )}
    </div>
  );
}
