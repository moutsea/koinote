import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import { TaskList } from "@tiptap/extension-task-list";
import { TaskItem } from "@tiptap/extension-task-item";
import CodeBlockLowlight from "@tiptap/extension-code-block-lowlight";
import Typography from "@tiptap/extension-typography";
import { BlockMath, InlineMath } from "@tiptap/extension-mathematics";
import { TableCell, TableHeader, TableRow } from "@tiptap/extension-table";
import { ReactNodeViewRenderer } from "@tiptap/react";
import { InputRule } from "@tiptap/core";
import { Markdown } from "tiptap-markdown";
import { ImageNodeView } from "./ImageNodeView";
import { lowlight } from "./lowlight";
import { BlockMarkdownImage } from "./markdownImage";
import { markdownMathPlugin } from "./markdownMath";
import { PageSearchExtension } from "./pageSearch";
import { MarkdownTable } from "./markdownTable";
import { InlineCode } from "./inlineCode";

/**
 * TipTap 扩展集合 —— Typora 式所见即所得的地基。
 *
 * - StarterKit 自带输入规则：`# ` 变标题、`> ` 变引用、`- ` 变列表、
 *   `1. ` 变有序列表、`` ``` `` 变代码块、`**x**` 变粗体等，实现边写边渲染。
 * - CodeBlockLowlight 替换默认代码块，接语法高亮。
 * - TaskList/TaskItem 提供 `[ ]` 任务列表。
 * - MarkdownTable/TableRow/TableHeader/TableCell 提供可编辑的 Markdown 表格。
 * - Typography 智能标点（-- → —、(c) → © 等）。
 * - Markdown 负责 .md 的解析(setContent)与序列化(getMarkdown)，保证往返一致。
 */
// placeholder 由调用方按当前语言传入，其余扩展固定。
export function createEditorExtensions(placeholder: string) {
  return [
    StarterKit.configure({
      // 用带高亮的代码块替换 StarterKit 内置的
      code: false,
      codeBlock: false,
    }),
    InlineCode,
    PageSearchExtension,
    CodeBlockLowlight.configure({
      lowlight,
      defaultLanguage: "plaintext",
    }),
    TaskList,
    TaskItem.configure({ nested: true }),
    MarkdownTable.configure({ resizable: true, cellMinWidth: 96 }),
    TableRow,
    TableHeader,
    TableCell,
    // allowBase64 必须关：否则粘贴截图会以 data:image/... 内联进 Markdown，
    // 文档瞬间膨胀到几 MB 且完全绕过图床。图片一律走 R2 拿到 URL 再插入。
    //
    // 挂自定义 NodeView 实现 Typora 式交互：点击图片浮出 `![备注](url)` 源码可编辑。
    // 只影响编辑器内的呈现，序列化仍由 tiptap-markdown 输出标准 Markdown。
    BlockMarkdownImage.extend({
      addNodeView() {
        return ReactNodeViewRenderer(ImageNodeView);
      },
    }),
    // 行内公式 $…$
    //
    // 上游的输入规则用的是非标准分隔符（行内 $$…$$、块级 $$$…$$$），
    // 但它的序列化输出却是标准的 $…$ / $$…$$ —— 打字与存盘两头对不上。
    // README 承诺 Markdown 往返保真，这里覆盖成 CommonMark 通行的写法。
    InlineMath.extend({
      addInputRules() {
        return [
          new InputRule({
            // 结尾 $ 刚打完就触发；前后不允许多余 $，避免与块级冲突
            find: /(?<!\$)\$([^$\n]+?)\$$/,
            handler: ({ state, range, match }) => {
              state.tr.replaceWith(
                range.from,
                range.to,
                this.type.create({ latex: match[1] }),
              );
            },
          }),
        ];
      },
      addStorage() {
        return {
          markdown: {
            serialize(state: any, node: any) {
              state.write(`$${node.attrs.latex ?? ""}$`);
            },
            parse: {
              setup(markdownit: any) {
                markdownit.use(markdownMathPlugin);
              },
            },
          },
        };
      },
    }),

    // 块级公式 $$…$$
    BlockMath.extend({
      addInputRules() {
        return [
          new InputRule({
            find: /^\$\$([^$]+?)\$\$$/,
            handler: ({ state, range, match }) => {
              state.tr.replaceWith(
                range.from - 1,
                range.to,
                this.type.create({ latex: match[1].trim() }),
              );
            },
          }),
        ];
      },
      addStorage() {
        return {
          markdown: {
            serialize(state: any, node: any) {
              // 前后空行，保证块级语义（紧贴段落会被并进上一段）
              state.write(`$$\n${node.attrs.latex ?? ""}\n$$`);
              state.closeBlock(node);
            },
            parse: {
              setup(markdownit: any) {
                markdownit.use(markdownMathPlugin);
              },
            },
          },
        };
      },
    }),

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
