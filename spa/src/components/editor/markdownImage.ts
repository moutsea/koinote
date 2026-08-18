import Image from "@tiptap/extension-image";

type MarkdownSerializerState = {
  closeBlock: (node: unknown) => void;
  esc: (value: string) => string;
  write: (value: string) => void;
};

type MarkdownImageNode = {
  attrs: {
    alt?: string | null;
    src?: string | null;
    title?: string | null;
  };
};

// 旧版把块级图片按行内节点序列化，紧随其后的标题会先与图片粘在一起，
// 再在下一次保存时退化成 `\## 标题`。线上存量同时存在
// `![](url)\## 标题`、`![](url)## 标题` 与“图片、空行、转义标题”几种形状。
// 只匹配行首的独占图片，避免把用户有意写在普通段落里的 Markdown 示例改掉。
const LEGACY_ESCAPED_HEADING_AFTER_IMAGE =
  /(^!\[[^\r\n]*\]\([^\r\n]*\))[ \t]*(?:\r?\n[ \t]*)*\\?(?=#{1,6}[ \t]+\S)/gm;

export function normalizeLegacyImageAdjacentHeadings(markdown: string): string {
  return markdown.replace(
    LEGACY_ESCAPED_HEADING_AFTER_IMAGE,
    (_match, image: string) => `${image}\n\n`,
  );
}

/**
 * Block images need to close their Markdown block explicitly.
 *
 * tiptap-markdown reuses ProseMirror's inline image serializer, which does not
 * call closeBlock(). With Image configured as inline:false, the next paragraph
 * or heading would otherwise be concatenated onto the image Markdown.
 */
export const BlockMarkdownImage = Image.configure({
  allowBase64: false,
  inline: false,
}).extend({
  addStorage() {
    return {
      markdown: {
        serialize(state: MarkdownSerializerState, node: MarkdownImageNode) {
          const alt = state.esc(node.attrs.alt ?? "");
          const src = (node.attrs.src ?? "").replace(/[()]/g, "\\$&");
          const title = node.attrs.title
            ? ` "${node.attrs.title.replace(/"/g, '\\"')}"`
            : "";

          state.write(`![${alt}](${src}${title})`);
          state.closeBlock(node);
        },
      },
    };
  },
});
