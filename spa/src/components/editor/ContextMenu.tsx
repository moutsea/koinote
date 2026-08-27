import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export type ContextMenuItem = {
  key: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  /** 删除这类不可逆操作，标红并放在分隔线之后 */
  danger?: boolean;
  disabled?: boolean;
};

/**
 * 指针位置弹出的菜单。
 *
 * 不复用 ExportMenu 的写法：那个锚在按钮上，用 absolute 就够；这个要落在右键的坐标
 * 上，而侧栏是 overflow-y-auto 的滚动容器，absolute 的菜单靠边时会被裁掉。
 *
 * 用 fixed 而不是 portal：fixed 已经不受 overflow 裁剪，坐标也直接是视口坐标，和
 * clientX/clientY 同一套。前提是从 body 到这里没有 transform/filter 的祖先（那会变成
 * fixed 的包含块，坐标就不再是视口的了）—— 当前布局没有，加的时候要留意。
 * z 值要压过 AppShell 那个 z-50 的 sticky 页头。
 *
 * 键盘可达：菜单打开后焦点进第一项，上下键移动，Esc 关闭。原生 DnD 键盘不可达，
 * 右键菜单是那部分功能的替代入口，自己再不可达就没意义了。
 */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
  ariaLabel,
}: {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  ariaLabel: string;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x, y });
  const enabled = items.filter((item) => !item.disabled);

  // 夹进视口。要在绘制前做完，否则会看到菜单先出现在屏幕外再跳回来
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const margin = 8;
    // 右边放不下就翻到指针左侧，下边放不下就翻到上方 —— 翻转比硬贴边更不容易
    // 盖住用户刚点的那一行
    let nx = x + width + margin > window.innerWidth ? x - width : x;
    let ny = y + height + margin > window.innerHeight ? y - height : y;
    nx = Math.max(margin, Math.min(nx, window.innerWidth - width - margin));
    ny = Math.max(margin, Math.min(ny, window.innerHeight - height - margin));
    setPos({ x: nx, y: ny });
  }, [x, y]);

  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>("button:not([disabled])")?.focus();
  }, []);

  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    // 滚动时菜单会和它指向的那一行脱开，直接关掉
    const onScroll = () => onClose();
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onScroll);
    // capture：侧栏内部的滚动不冒泡到 window
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [onClose]);

  function onMenuKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const buttons = Array.from(
      menuRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ??
        [],
    );
    if (buttons.length === 0) return;
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === "ArrowDown" ? 1 : -1;
    // 环形移动：到底回到头，符合原生菜单的习惯
    const next = (at + step + buttons.length) % buttons.length;
    buttons[next]?.focus();
  }

  if (enabled.length === 0) return null;

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label={ariaLabel}
      onKeyDown={onMenuKeyDown}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
      style={{ left: pos.x, top: pos.y }}
      className="fixed z-[60] min-w-[176px] overflow-hidden rounded-xl border border-black/10 bg-[var(--background)] py-1 shadow-lg dark:border-white/15"
    >
      {items.map((item, i) => {
        // 危险项前面加分隔线，和上面的常规操作分开
        const divider = item.danger && !items[i - 1]?.danger && i > 0;
        return (
          <div key={item.key}>
            {divider && <div className="my-1 h-px bg-black/10 dark:bg-white/10" />}
            <button
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                onClose();
                item.onSelect();
              }}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition disabled:opacity-40 ${
                item.danger
                  ? "text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
                  : "text-neutral-700 hover:bg-black/5 dark:text-neutral-200 dark:hover:bg-white/10"
              }`}
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center text-neutral-400">
                {item.icon}
              </span>
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
            </button>
          </div>
        );
      })}
    </div>
  );
}
