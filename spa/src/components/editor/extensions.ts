import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import Typography from "@tiptap/extension-typography";
import { Markdown } from "tiptap-markdown";
import { lowlight } from "./lowlight";

/**
 * TipTap 扩展集合 —— Typora 式所见即所得的地基。
 *
 * - StarterKit 自带输入规则：`# ` 变标题、`> ` 变引用、`- ` 变列表、
 *   `1. ` 变有序列表、`` ``` `` 变代码块、`**x**` 变粗体等，实现边写边渲染。
 * - CodeBlockLowlight 替换默认代码块，接语法高亮。
 * - TaskList/TaskItem 提供 `[ ]` 任务列表。
 * - Typography 智能标点（-- → —、(c) → © 等）。
 * - Markdown 负责 .md 的解析(setContent)与序列化(getMarkdown)，保证往返一致。
 */
// placeholder 由调用方按当前语言传入，其余扩展固定。
export function createEditorExtensions(placeholder: string) {
  return [
    StarterKit.configure({
      // 用带高亮的代码块替换 StarterKit 内置的
      codeBlock: false,
    }),
    CodeBlockLowlight.configure({
      lowlight,
      defaultLanguage: "plaintext",
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    Typography,
    Placeholder.configure({ placeholder }),
    Markdown.configure({
      html: false, // 以纯 Markdown 为核心，不夹带 HTML
      tightLists: true, // 列表项紧凑，往返更保真
      bulletListMarker: "-",
      linkify: true, // 自动识别裸链接
      breaks: false, // 单换行不转 <br>，符合 CommonMark
      transformPastedText: true, // 粘贴纯文本时按 markdown 解析
      transformCopiedText: true, // 复制时输出 markdown
    }),
  ];
}
