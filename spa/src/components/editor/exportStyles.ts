/**
 * 导出物的排版样式，HTML 与 PDF 两条路径共用。
 *
 * 这里只放浅色规则：PDF 是打印物，必须白底黑字，不能跟随用户的深色偏好。
 * HTML 导出会在此基础上追加一段 prefers-color-scheme 覆盖。
 */
export const EXPORT_BASE_CSS = `
  body {
    max-width: 46rem; margin: 0 auto; padding: 3rem 1.25rem;
    font: 16px/1.75 -apple-system, BlinkMacSystemFont, "Segoe UI",
          "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
    color: #1f2328; background: #fff;
  }
  h1, h2, h3, h4 { line-height: 1.3; margin: 1.6em 0 0.6em; }
  h1 { font-size: 1.9em; }
  h2 { font-size: 1.5em; }
  h3 { font-size: 1.25em; }
  p, ul, ol, blockquote, table { margin: 0.85em 0; }
  a { color: #0969da; }
  img { max-width: 100%; height: auto; }
  blockquote {
    margin-left: 0; padding-left: 1em;
    border-left: 3px solid #d0d7de; color: #57606a;
  }
  code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.9em; background: rgba(175,184,193,0.2);
    padding: 0.15em 0.35em; border-radius: 4px;
  }
  pre {
    background: #0d1117; color: #e6edf3; padding: 1em;
    border-radius: 8px; overflow-x: auto;
  }
  pre code { background: none; padding: 0; color: inherit; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #d0d7de; padding: 0.5em 0.75em; text-align: left; }
  th { background: rgba(175,184,193,0.15); }
  ul[data-type="taskList"] { list-style: none; padding-left: 0; }
  ul[data-type="taskList"] li { display: flex; gap: 0.5em; align-items: flex-start; }
  hr { border: none; border-top: 1px solid #d0d7de; margin: 2em 0; }
  [data-type="block-math"] { margin: 1em 0; text-align: center; }
  .hljs-comment, .hljs-quote { color: #8b949e; }
  .hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-type { color: #ff7b72; }
  .hljs-string, .hljs-attr, .hljs-template-tag { color: #a5d6ff; }
  .hljs-number, .hljs-symbol { color: #79c0ff; }
  .hljs-title, .hljs-title.function_, .hljs-section { color: #d2a8ff; }
  .hljs-variable, .hljs-name, .hljs-attribute { color: #ffa657; }
`;

/**
 * 仅 PDF 导出使用，覆盖在 EXPORT_BASE_CSS 之后。
 *
 * 代码块改成浅底：
 *   1. 与打印路径（globals.css 的 @media print）一致 —— 同一份文档走两条
 *      PDF 路径不该长得不一样；
 *   2. 深底在纸上是整片实色，打印机吃墨；
 *   3. 浅底位图压缩率高得多，直接决定 PDF 体积。
 * 高亮配色换成浅色主题而非像打印那样全部压成单色 —— PDF 多数在屏幕上看，
 * 留着高亮更有用。
 */
export const EXPORT_PDF_CSS = `
  pre {
    background: #f6f8fa;
    color: #1f2328;
    border: 1px solid #d0d7de;
  }
  pre code { color: inherit; }
  .hljs-comment, .hljs-quote { color: #6a737d; font-style: italic; }
  .hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-type { color: #d73a49; }
  .hljs-string, .hljs-attr, .hljs-template-tag { color: #032f62; }
  .hljs-number, .hljs-symbol { color: #005cc5; }
  .hljs-title, .hljs-title.function_, .hljs-section { color: #6f42c1; }
  .hljs-variable, .hljs-name, .hljs-attribute { color: #e36209; }
`;

/** 仅 HTML 导出使用：静态文件会被人在深色系统下打开。 */
export const EXPORT_DARK_CSS = `
  @media (prefers-color-scheme: dark) {
    body { color: #e6edf3; background: #0d1117; }
    a { color: #58a6ff; }
    blockquote { border-left-color: #30363d; color: #8b949e; }
    th, td { border-color: #30363d; }
    hr { border-top-color: #30363d; }
  }
`;
