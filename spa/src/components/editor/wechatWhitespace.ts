/**
 * 把代码块里的空白改成「结构性」的，不再依赖 CSS。
 *
 * 为什么需要这一步：实测微信会剥掉 white-space 声明。只靠
 * `white-space:pre-wrap` 的话，粘进公众号后连续空格被 HTML 的空白折叠规则
 * 压成一个、换行被当普通空白 —— 缩进全部消失，Python 直接变废码。
 * 高亮还在，缩进没了，正是这个原因。
 *
 * 做法是让空白不再需要 CSS 来维持：
 *   - 连续空格 → U+00A0（不换行空格）。它不参与空白折叠，浏览器必须原样渲染。
 *   - 换行 → <br>。它是元素而不是字符，不受 white-space 影响。
 *
 * CSS 声明仍然保留（见 wechatInline.ts 的 CODE_BLOCK_EXTRAS）—— 两者不冲突：
 * 微信留着 white-space 时它负责长行折行，剥掉时这里的结构兜住缩进。
 *
 * 只用于导出，不动编辑器里的文档。
 */

/** 不换行空格。写成常量而不是字面量，免得在源码里和普通空格看混。 */
const NBSP = " ";

/**
 * 把一段代码文本里的空格换成 NBSP。
 *
 * 全部空格都换，而不是只换行首的缩进：字符串里的对齐、注释里的表格、
 * 行尾对齐的续行符都靠连续空格，只处理行首会让这些地方错位。
 *
 * 代价是复制出来的文本里空格是 U+00A0 而不是 U+0020，粘回编辑器可能不能直接跑。
 * 但导出微信的产物本来就是给人读的，读得出缩进比能直接复制运行更重要 ——
 * 而且不换的话连读都读不出来。
 *
 * 单个空格也换：一行里「换了的」和「没换的」混在一起时，两种空格的宽度在
 * 某些字体下并不相同，代码会看着参差。
 */
export function spacesToNbsp(text: string): string {
  return text.replace(/ /g, NBSP);
}

/**
 * 制表符展开成几个空格。
 *
 * 微信里 tab 的表现完全不可控（宽度取决于它自己的 tab-size，而那也可能被剥掉），
 * 展开成固定数量的 NBSP 是唯一能保证对齐的做法。
 *
 * 用 4 而不是 8：编辑器里的 tabSize 是 4（见 extensions.ts 的 CodeBlockLowlight
 * 配置），保持一致，导出前后看起来才是同一段代码。
 */
export const TAB_WIDTH = 4;

export function expandTabs(text: string): string {
  return text.replace(/\t/g, " ".repeat(TAB_WIDTH));
}

/**
 * 就地改写一个代码块内的空白。
 *
 * 遍历文本节点而不是改 innerHTML：代码块里已经有高亮的 <span>，
 * 用字符串替换会碰到标签和属性（比如 style 里的空格），把样式改坏。
 * 逐个文本节点处理则天然只碰内容。
 *
 * 换行拆成 <br> 需要在父节点上换掉整个文本节点，所以先收集再改 ——
 * 边遍历边替换会漏掉后面的节点。
 */
export function structuralizeWhitespace(codeElement: Element): void {
  const doc = codeElement.ownerDocument;
  if (!doc) return;

  // 先收集所有文本节点。不能边走边改：替换会改变树结构
  const textNodes: Text[] = [];
  const collect = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) textNodes.push(child as Text);
      else if (child.nodeType === 1) collect(child);
    }
  };
  collect(codeElement);

  for (const node of textNodes) {
    const raw = node.nodeValue ?? "";
    if (!raw) continue;

    const expanded = expandTabs(raw);
    // 没有换行时只需换空格，省一次节点替换
    if (!expanded.includes("\n")) {
      const replaced = spacesToNbsp(expanded);
      if (replaced !== raw) node.nodeValue = replaced;
      continue;
    }

    // 有换行：拆成 文本 / <br> / 文本 …
    const parent = node.parentNode;
    if (!parent) continue;
    const fragment = doc.createDocumentFragment();
    const lines = expanded.split("\n");
    lines.forEach((line, index) => {
      if (index > 0) fragment.appendChild(doc.createElement("br"));
      if (line) fragment.appendChild(doc.createTextNode(spacesToNbsp(line)));
    });
    parent.replaceChild(fragment, node);
  }
}

/**
 * 处理 root 下所有代码块。返回处理过的代码块数。
 *
 * 只碰 pre 里的 code：行内 code 本来就是单行，没有缩进可言，
 * 把它的空格换成 NBSP 只会让正文里的断行变差。
 */
export function structuralizeCodeWhitespace(root: HTMLElement): number {
  const blocks = Array.from(root.querySelectorAll("pre > code"));
  for (const block of blocks) {
    structuralizeWhitespace(block);
  }
  return blocks.length;
}
