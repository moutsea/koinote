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

  function commit() {
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
    editor.commands.focus();
  }

  function cancel() {
    setDraft(toMarkdown(alt, src, title));
    setEditing(false);
    editor.commands.focus();
  }

  return (
    <NodeViewWrapper className="my-2">
      <figure className="m-0">
        {/* 图片始终在位。编辑时只是在下方追加源码行，不替换图片本身，
            这样能边改边看，改完立刻知道换的是哪张。 */}
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
          title={t.editor.imageClickToEdit}
          aria-expanded={editing}
          className={`block w-full overflow-hidden rounded-lg border text-left transition ${
            editing
              ? "cursor-default border-sky-500"
              : selected
                ? "cursor-pointer border-sky-500"
                : "cursor-pointer border-transparent hover:border-sky-500/40"
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

        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancel();
              }
            }}
            spellCheck={false}
            aria-label={t.editor.imageMarkdownLabel}
            className="mt-1.5 w-full rounded-lg border border-sky-500/40 bg-sky-50/40 px-3 py-2 font-mono text-[13px] outline-none focus:border-sky-500 dark:bg-sky-950/20"
          />
        ) : (
          alt && (
            <figcaption className="mt-1 text-center text-xs text-neutral-400">
              {alt}
            </figcaption>
          )
        )}
      </figure>
    </NodeViewWrapper>
  );
}
