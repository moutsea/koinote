// HTML source whitespace between block elements is layout, not another paragraph.
// ProseMirror can otherwise turn it into a space-only paragraph (or a hard break
// when data-pm-slice enables whitespace preservation for an internal copy).
const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DD", "DETAILS", "DIV", "DL",
  "DT", "FIELDSET", "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2",
  "H3", "H4", "H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P",
  "PRE", "SECTION", "SUMMARY", "TABLE", "TBODY", "TD", "TFOOT", "TH",
  "THEAD", "TR", "UL",
]);

function preservesWhitespace(element: HTMLElement): boolean {
  return /^(PRE|CODE|TEXTAREA|SCRIPT|STYLE)$/.test(element.tagName) ||
    /^(pre|pre-wrap|pre-line|break-spaces)$/.test(element.style?.whiteSpace ?? "");
}

export function normalizeClipboardHTML(html: string): string {
  // A template preserves standalone table rows/cells, unlike parsing in a div.
  const template = document.createElement("template");
  template.innerHTML = html;
  let changed = false;

  function visit(parent: Node) {
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType === 1) {
        if (!preservesWhitespace(child as HTMLElement)) visit(child);
        continue;
      }
      if (child.nodeType !== 3 || !/^[\t\n\r\f ]+$/.test(child.nodeValue ?? "")) {
        continue;
      }
      const bordersBlock = [child.previousSibling, child.nextSibling].some(
        (sibling) => sibling?.nodeType === 1 &&
          BLOCK_TAGS.has((sibling as Element).tagName),
      );
      if (bordersBlock) {
        parent.removeChild(child);
        changed = true;
      }
    }
  }

  visit(template.content);
  if (!changed) return html;
  const container = document.createElement("div");
  container.appendChild(template.content);
  return container.innerHTML;
}
