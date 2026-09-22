import { useI18n } from "../../i18n";
import { shouldLeaveTitleOnEnter } from "./titleKeyboard";
import { Image as ImageIcon } from "lucide-react";

/**
 * 文档标题。渲染在正文列里、正文之上，跟着主题的 h1 走。
 *
 * 为什么放进正文列而不是控件栏：标题在导出时**就是**正文的第一个 h1
 * （见 exportWechat.ts / exportDocument.ts 里的 heading 拼接）。
 * 原来它是控件栏里一个 text-sm 的输入框，和产物里那个 28px 的大标题毫无关系
 * —— 编辑区号称即预览，唯独标题不是。
 *
 * 用 textarea 而不是 input：套上主题的 h1 字号后，长标题必然要折行，而 input
 * 永远单行，只能横向滚。
 *
 * 高度靠 CSS 网格镜像撑开，不用 JS 量 scrollHeight：换主题、改窗宽、缩放字号
 * 都会改变折行数，靠 JS 就得同时盯 value、主题、ResizeObserver 三个来源，
 * 漏一个就是「标题被截掉半行」。镜像是同一份文本用同一套排版量出来的，
 * 天然跟着变。实现见 globals.css 的 .kn-doc-title。
 */
export function DocTitle({
  value,
  onChange,
  onEnter,
  onOpenCover,
  overlay = false,
}: {
  value: string;
  onChange: (next: string) => void;
  /** 在标题里按回车：跳到正文，而不是在标题里插入换行 */
  onEnter?: () => void;
  onOpenCover?: () => void;
  overlay?: boolean;
}) {
  const { t } = useI18n();

  return (
    // 外层只负责横向内缩，与正文的 px-2 对齐（见 editorContentClass）。
    // 不能把内缩写在 .kn-doc-title 上：主题的 h1 规则里带 padding（popart 是
    // 18px 16px），选择器权重比 Tailwind 的类高，会把内缩顶掉，标题左边缘
    // 就比正文往外凸 8px。
    <div
      className={`koinote-doc-title-wrap flex items-start gap-2 px-2 ${
        overlay ? "koinote-doc-title-overlay" : ""
      }`}
    >
      {/*
        data-title 供 ::after 镜像读取。镜像量出行数，网格行高随之变化，
        textarea 被拉伸填满 —— 所以它永远刚好装下全部文本。
      */}
      <div
        className={`kn-doc-title min-w-0 flex-1 ${
          overlay ? "kn-doc-title-cover" : ""
        }`}
        data-title={value}
      >
        <textarea
          value={value}
          rows={1}
          // 换行一律剥掉：标题最终是一个 h1，留着换行在产物里也表达不出来，
          // 而粘贴一段带换行的文本是很常见的
          onChange={(e) => onChange(e.target.value.replace(/[\r\n]+/g, " "))}
          onKeyDown={(e) => {
            if (
              !shouldLeaveTitleOnEnter({
                key: e.key,
                isComposing: e.nativeEvent.isComposing,
                keyCode: e.keyCode,
              })
            ) {
              return;
            }
            e.preventDefault();
            onEnter?.();
          }}
          placeholder={t.editor.titlePlaceholder}
          aria-label={t.editor.titlePlaceholder}
          spellCheck={false}
        />
      </div>
      {onOpenCover && (
        <button
          type="button"
          onClick={onOpenCover}
          title={t.editor.wechatCoverTitle}
          aria-label={t.editor.wechatCoverTitle}
          className="mt-1.5 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-neutral-400 transition hover:bg-black/5 hover:text-neutral-700 dark:hover:bg-white/10 dark:hover:text-neutral-200"
        >
          <ImageIcon className="h-4 w-4" />
          <span className="hidden sm:inline">{t.editor.wechatCoverTitle}</span>
        </button>
      )}
    </div>
  );
}
