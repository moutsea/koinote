import { useEffect, useRef, useState } from "react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { useI18n } from "../../i18n";

/**
 * Typora 式图片节点：平时渲染图片，点击后浮出 Markdown 源码可编辑。
 *
 * 编辑的是 `![备注](url)` 整段——改 alt 即改备注，改 url 即换图。
 * 提交时解析回 alt/src 写入节点属性；Esc 放弃，Enter 或失焦提交。
 */

const MARKDOWN_IMAGE = /^!\[([^\]]*)\]\(\s*(\S+?)(?:\s+"([^"]*)")?\s*\)$/;

function toMarkdown(alt: string, src: string, title: string): string {
  const titlePart = title ? ` "${title}"` : "";
  return `![${alt}](${src}${titlePart})`;
}

export function ImageNodeView({
  node,
  updateAttributes,
  deleteNode,
  selected,
  editor,
}: NodeViewProps) {
  const { t } = useI18n();
  const src = (node.attrs.src as string) ?? "";
  const alt = (node.attrs.alt as string) ?? "";
  const title = (node.attrs.title as string) ?? "";

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => toMarkdown(alt, src, title));
  const [broken, setBroken] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // 删除进行中的标记：deleteNode() 会卸载 input 触发 blur → commit，
  // 那时节点已不存在，写属性会报错或复活一个空节点。
  const removing = useRef(false);

  // 外部改动（撤销、协同、切换文档）要同步回草稿，否则显示的源码会过期
  useEffect(() => {
    if (!editing) setDraft(toMarkdown(alt, src, title));
  }, [alt, src, title, editing]);

  useEffect(() => {
    if (!editing) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    // 光标落在 alt 里：备注是最常改的部分
    const start = draft.indexOf("[") + 1;
    const end = draft.indexOf("]");
    if (start > 0 && end > start) input.setSelectionRange(start, end);
    else input.select();
    // 仅在进入编辑态时聚焦一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  /**
   * 收回焦点给编辑器。
   *
   * 只在键盘操作（Enter / Esc / 退格删图）后调用 —— 那时用户想继续打字，
   * 把焦点送回正文是对的。
   *
   * 失焦退出时**绝不能**调它：`focus()` 不带位置时，若当前选区不是文本选区
   * （点过图片之后就是这张图的 NodeSelection），TipTap 会走 delayedFocus 并
   * 顺手 scrollIntoView —— 滚回那个 NodeSelection，也就是刚才那张图。
   * 于是「点图 A → 往下滚 → 点图 B」会在 B 的 mousedown 触发 A 的 blur 时
   * 被拽回 A。见 @tiptap/core 的 focus 命令：position === null 且选区非文本
   * 选区时进 delayedFocus，其中 scrollIntoView 默认为 true。
   */
  function refocusEditor() {
    editor.commands.focus();
  }

  /**
   * 提交草稿。
   *
   * refocus 由调用方决定：键盘操作要把焦点送回正文，失焦退出不要 ——
   * 那时焦点该落在用户刚点的地方。
   */
  function commit({ refocus }: { refocus: boolean }) {
    if (removing.current) return; // 节点正在被删，不要再写属性
    const matched = MARKDOWN_IMAGE.exec(draft.trim());
    if (!matched) {
      // 解析不出来就当放弃，不静默写入坏数据
      setDraft(toMarkdown(alt, src, title));
      setEditing(false);
      return;
    }
    const [, nextAlt, nextSrc, nextTitle] = matched;
    updateAttributes({
      alt: nextAlt,
      src: nextSrc,
      title: nextTitle ?? null,
    });
    setEditing(false);
    if (refocus) refocusEditor();
  }

  function cancel() {
    setDraft(toMarkdown(alt, src, title));
    setEditing(false);
    // Esc 是键盘操作，焦点该回到正文
    refocusEditor();
  }

  /**
   * 删掉整个图片节点。
   *
   * 先退出编辑态再删：留在编辑态时 input 会随节点一起卸载，
   * 触发 blur → commit，对着已不存在的节点写属性。
   */
  function removeImage() {
    removing.current = true;
    setEditing(false);
    deleteNode();
    // 删图是键盘操作（退格/删除），焦点该回到正文继续编辑。
    // 这里也不会有跳位问题：节点已经删掉，那个 NodeSelection 不复存在
    refocusEditor();
  }

  return (
    <NodeViewWrapper className="my-2">
      <figure className="m-0">
        {/* 源码行在图片上方：编辑时视线与光标都在这一行，
            图片留在下方作为即时预览，改完立刻知道换的是哪张。 */}
        {editing && (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            // 失焦提交但不抢焦点：用户点了别处，焦点该留在那儿。
            // 送回编辑器会连带 scrollIntoView 滚回这张图 —— 就是「点另一张图
            // 却被拽回上一张」那个 bug。见 refocusEditor 的注释。
            onBlur={() => commit({ refocus: false })}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                // 回车是显式确认，焦点回正文继续打字
                commit({ refocus: true });
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                cancel();
                return;
              }
              // 退格/删除意在「删掉这张图」，不是逐字符改源码。
              // 但整段选中时放行原生行为，否则改不了备注里的错字——
              // 进入编辑态默认选中 alt，直接打字即替换，这条才成立。
              if (e.key === "Backspace" || e.key === "Delete") {
                const input = e.currentTarget;
                const hasSelection =
                  input.selectionStart !== input.selectionEnd;
                if (hasSelection) return; // 有选区：正常编辑文本
                e.preventDefault();
                removeImage();
              }
            }}
            spellCheck={false}
            aria-label={t.editor.imageMarkdownLabel}
            className="mb-1.5 w-full rounded-lg border border-cinnabar-500/40 bg-cinnabar-50/40 px-3 py-2 font-mono text-[13px] outline-none focus:border-cinnabar-500 dark:bg-cinnabar-950/20"
          />
        )}

        <button
          type="button"
          // 编辑中点图片不该收起源码行。阻止默认行为避免抢走 input 焦点，
          // 否则 blur 触发 commit，源码行刚打开就被关掉。
          onMouseDown={(e) => {
            if (editing) e.preventDefault();
          }}
          onClick={() => {
            if (!editing) setEditing(true);
          }}
          // 图片本身获得焦点时（Tab 或点击后），退格/删除同样删整张图。
          // 焦点在 button 上，ProseMirror 收不到这个按键，得自己接。
          onKeyDown={(e) => {
            if (editing) return;
            if (e.key === "Backspace" || e.key === "Delete") {
              e.preventDefault();
              removeImage();
            }
          }}
          title={t.editor.imageClickToEdit}
          aria-expanded={editing}
          className={`block w-full overflow-hidden rounded-lg border text-left transition ${
            editing
              ? "cursor-default border-cinnabar-500"
              : selected
                ? "cursor-pointer border-cinnabar-500"
                : "cursor-pointer border-transparent hover:border-cinnabar-500/40"
          }`}
        >
          {broken ? (
            // 图挂了也要能点开改 URL，否则用户被困在一个坏节点上
            <span className="block px-3 py-6 text-center text-xs text-neutral-400">
              {t.editor.imageBroken}
            </span>
          ) : (
            <img
              src={src}
              alt={alt}
              title={title || undefined}
              onError={() => setBroken(true)}
              className="mx-auto block max-w-full"
            />
          )}
        </button>

        {/* 非编辑态用 alt 当图注。编辑态下源码行已经把 alt 显示出来了，
            再挂一行图注是重复信息。 */}
        {!editing && alt && (
          <figcaption className="mt-1 text-center text-xs text-neutral-400">
            {alt}
          </figcaption>
        )}
      </figure>
    </NodeViewWrapper>
  );
}
