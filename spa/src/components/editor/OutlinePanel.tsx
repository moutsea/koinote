import { ChevronLeft } from "lucide-react";
import { useI18n } from "../../i18n";
import type { OutlineItem } from "./useOutline";

// 按层级缩进。只到 h6，超出的按 h6 处理。
const INDENT: Record<number, string> = {
  1: "pl-2",
  2: "pl-5",
  3: "pl-8",
  4: "pl-11",
  5: "pl-14",
  6: "pl-16",
};

export function OutlinePanel({
  outline,
  onJump,
  onCollapse,
}: {
  outline: OutlineItem[];
  onJump: (pos: number) => void;
  onCollapse: () => void;
}) {
  const { t } = useI18n();

  return (
    <div className="flex h-full flex-col">
      {/* 标题行整体压低对比度：大纲是正文的辅助导航，不该抢正文的视觉权重。
          收起按钮平时半透明，悬停到大纲区域才显形。 */}
      <div className="group/head flex items-center gap-1 py-2 pl-4 pr-2">
        <span className="flex-1 truncate text-[11px] font-medium uppercase tracking-wider text-neutral-400/80">
          {t.editor.outlinePanel}
        </span>
        <button
          type="button"
          onClick={onCollapse}
          aria-label={t.editor.collapsePanel}
          aria-expanded
          title={t.editor.collapsePanel}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-neutral-400 opacity-0 transition hover:bg-black/5 hover:text-neutral-700 focus:opacity-100 group-hover/head:opacity-100 dark:hover:bg-white/10 dark:hover:text-neutral-200"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-4 pl-2 pr-1">
        {outline.length === 0 ? (
          <p className="px-2 py-2 text-xs leading-relaxed text-neutral-400/70">
            {t.editor.emptyOutline}
          </p>
        ) : (
          <ul>
            {outline.map((item, index) => (
              // 位置可能因编辑而变，但同一次渲染内 pos+index 足以稳定标识
              <li key={`${item.pos}-${index}`}>
                <button
                  type="button"
                  onClick={() => onJump(item.pos)}
                  className={`block w-full truncate rounded-md py-1 pr-2 text-left text-[13px] leading-relaxed text-neutral-500 transition hover:text-cinnabar-600 dark:text-neutral-400 dark:hover:text-cinnabar-400 ${
                    INDENT[Math.min(item.level, 6)] ?? "pl-2"
                  } ${item.level === 1 ? "font-medium text-neutral-600 dark:text-neutral-300" : ""}`}
                  title={item.text}
                >
                  {item.text}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
