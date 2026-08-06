import { useEffect, useMemo, useRef } from "react";
import type { Editor } from "@tiptap/react";
import MarkdownEditor from "./MarkdownEditor";
import { useDocument } from "../../documents";
import type { DocPatch, DocumentSaver } from "./useDocumentSaver";

/**
 * 挂载池里的一个编辑器实例。
 *
 * 单独抽成组件是因为每个实例都要自己调 useDocument —— hook 不能在循环里调，
 * 页面层没法为 N 个 docId 各取一份数据。
 *
 * 非当前实例用 display:none 藏起来而不是卸载：这正是多开的意义所在，切回来时
 * 撕销历史、光标位置都还在。代价是滚动位置 —— display:none 之后部分浏览器会把
 * scrollTop 归零，所以手动存取（见下方 scroll ref）。
 */
export function LiveEditor({
  docId,
  visible,
  saver,
  onEditorReady,
  onTitleChange,
  leadingControls,
  trailingControls,
  outlineSlot,
}: {
  docId: string;
  visible: boolean;
  saver: DocumentSaver;
  /** 只有当前实例上报，否则大纲会跟到后台的某篇上 */
  onEditorReady?: (editor: Editor | null) => void;
  onTitleChange?: (docId: string, title: string) => void;
  leadingControls?: React.ReactNode;
  trailingControls?: React.ReactNode;
  outlineSlot?: React.ReactNode;
}) {
  const doc = useDocument(docId);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollTop = useRef(0);

  // 文档到手后铺一份基线。seed 内部对已有待存内容不覆盖 ——
  // 被淘汰又点回来时，本地未落库的改动比服务端那份新
  useEffect(() => {
    if (!doc.data) return;
    saver.seed(docId, {
      title: doc.data.title,
      content: doc.data.content,
      theme: doc.data.theme ?? "",
    });
  }, [doc.data, docId, saver]);

  // 隐藏前记住滚动位置，显示后还原
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (visible) {
      el.scrollTop = scrollTop.current;
    } else {
      scrollTop.current = el.scrollTop;
    }
  }, [visible]);

  // 传给编辑器的 document 要合并未落库的改动，否则重新挂载会退回服务端那份，
  // 用户看到自己刚写的字消失
  const merged = useMemo(() => {
    if (!doc.data) return null;
    const pending = saver.peek(docId);
    return pending ? { ...doc.data, ...pending } : doc.data;
    // peek 读的是 ref，不进依赖 —— 它变化时不需要重算，重算时机由 doc.data 决定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc.data, docId]);

  if (!merged) return null;

  return (
    <div className={visible ? "flex min-h-0 flex-1 flex-col" : "hidden"}>
      <MarkdownEditor
        document={merged}
        status={saver.status(docId)}
        onChange={(patch: DocPatch) => {
          saver.queue(docId, patch);
          if (patch.title !== undefined) onTitleChange?.(docId, patch.title);
        }}
        onFlush={() => void saver.flush(docId)}
        onEditorReady={visible ? onEditorReady : undefined}
        scrollContainerRef={scrollRef}
        leadingControls={leadingControls}
        trailingControls={trailingControls}
        outlineSlot={outlineSlot}
      />
    </div>
  );
}
