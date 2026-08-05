import "@tiptap/core";

// tiptap-markdown 未提供 storage 的类型声明，这里补上，避免用 any
declare module "@tiptap/core" {
  interface Storage {
    markdown: {
      getMarkdown: () => string;
    };
  }
}
