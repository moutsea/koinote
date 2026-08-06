import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * 可拖拽调宽的侧栏容器。
 *
 * 宽度存 localStorage，按 storageKey 区分，刷新后保持。
 * 拖拽期间用 pointer 事件 + setPointerCapture，指针移出窗口也不会丢失拖拽。
 */
export function ResizablePanel({
  children,
  storageKey,
  defaultWidth,
  minWidth = 160,
  maxWidth = 520,
  ariaLabel,
  className = "",
  bordered = true,
}: {
  children: ReactNode;
  storageKey: string;
  defaultWidth: number;
  minWidth?: number;
  maxWidth?: number;
  ariaLabel: string;
  className?: string;
  /** 是否画右边框。大纲作为正文的一部分时不画，避免看起来像独立侧栏。 */
  bordered?: boolean;
}) {
  const clamp = useCallback(
    (value: number) => Math.min(maxWidth, Math.max(minWidth, value)),
    [minWidth, maxWidth],
  );

  const [width, setWidth] = useState<number>(() => {
    if (typeof window === "undefined") return defaultWidth;
    const stored = window.localStorage.getItem(storageKey);
    const parsed = stored ? Number(stored) : NaN;
    return Number.isFinite(parsed) ? clamp(parsed) : defaultWidth;
  });
  const [dragging, setDragging] = useState(false);

  // 拖拽起点：记录按下时的指针位置与当时宽度，按位移增量算新宽度
  const dragStart = useRef<{ x: number; width: number } | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(storageKey, String(width));
  }, [storageKey, width]);

  // 拖拽时禁掉全局文字选中，否则拖动会顺手选中页面文本
  useEffect(() => {
    if (!dragging || typeof document === "undefined") return;
    const previous = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    return () => {
      document.body.style.userSelect = previous;
      document.body.style.cursor = "";
    };
  }, [dragging]);

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    dragStart.current = { x: event.clientX, width };
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handlePointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragStart.current) return;
    const delta = event.clientX - dragStart.current.x;
    setWidth(clamp(dragStart.current.width + delta));
  }

  function endDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragStart.current) return;
    dragStart.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  // 键盘调宽：分隔条聚焦后左右方向键微调，Home/End 到极值。
  // 纯鼠标拖拽会把键盘用户完全挡在外面。
  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setWidth((w) => clamp(w - step));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setWidth((w) => clamp(w + step));
    } else if (event.key === "Home") {
      event.preventDefault();
      setWidth(minWidth);
    } else if (event.key === "End") {
      event.preventDefault();
      setWidth(maxWidth);
    }
  }

  return (
    <div
      className={`relative shrink-0 ${
        bordered ? "border-r border-black/5 dark:border-white/10" : ""
      } ${className}`}
      style={{ width }}
    >
      {children}

      {/* 分隔条：视觉上只有 1px 边框，但命中区域加宽到 8px 才好抓 */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={ariaLabel}
        aria-valuenow={width}
        aria-valuemin={minWidth}
        aria-valuemax={maxWidth}
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={handleKeyDown}
        className={`absolute -right-1 top-0 z-10 h-full w-2 cursor-col-resize transition-colors focus:outline-none ${
          bordered
            ? "hover:bg-cinnabar-500/30 focus:bg-cinnabar-500/40"
            : // 无边框场景（大纲嵌在正文里）：拖拽热区更含蓄，只在交互时透出一点
              "hover:bg-cinnabar-500/15 focus:bg-cinnabar-500/25"
        } ${dragging ? (bordered ? "bg-cinnabar-500/40" : "bg-cinnabar-500/25") : "bg-transparent"}`}
      />
    </div>
  );
}
