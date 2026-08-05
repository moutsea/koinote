import { useCallback, useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";

export type OutlineItem = {
  /** 标题层级 1-6 */
  level: number;
  /** 标题纯文字 */
  text: string;
  /** 文档内位置，用于点击跳转 */
  pos: number;
};

/**
 * 从 TipTap 文档中抽取标题树。
 *
 * 官方的 TableOfContents 是 Pro 付费扩展，这里自己遍历文档节点实现，
 * 逻辑简单且不引入依赖：走一遍 doc，收集所有 heading 节点。
 */
function collectHeadings(editor: Editor): OutlineItem[] {
  const items: OutlineItem[] = [];
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name !== "heading") return;
    const text = node.textContent.trim();
    // 空标题不进大纲，否则会出现一排无法辨识的空条目
    if (!text) return;
    items.push({ level: node.attrs.level as number, text, pos });
  });
  return items;
}

export function useOutline(editor: Editor | null): OutlineItem[] {
  const [outline, setOutline] = useState<OutlineItem[]>([]);

  const refresh = useCallback((instance: Editor) => {
    setOutline(collectHeadings(instance));
  }, []);

  useEffect(() => {
    if (!editor) {
      setOutline([]);
      return;
    }

    refresh(editor);

    // 内容与事务都要监听：setContent 走 update，光标移动不影响大纲但成本极低
    const handleUpdate = () => refresh(editor);
    editor.on("update", handleUpdate);
    return () => {
      editor.off("update", handleUpdate);
    };
  }, [editor, refresh]);

  return outline;
}

/** 跳到指定标题：定位光标并滚动到视野内 */
export function scrollToHeading(editor: Editor | null, pos: number) {
  if (!editor) return;
  editor.chain().focus().setTextSelection(pos + 1).scrollIntoView().run();
}
