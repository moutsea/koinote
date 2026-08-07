import type { Root, RootContent } from "hast";
import { lowlight } from "./lowlight";

/**
 * 给导出物里的代码块补上语法高亮的 <span>。
 *
 * 为什么必须有这一步（这是之前微信导出没有高亮的真正原因）：
 * CodeBlockLowlight 是用 ProseMirror 的 Decoration 实现高亮的 —— 见
 * @tiptap/extension-code-block-lowlight/dist/index.js 里的 LowlightPlugin，
 * 它把颜色作为「装饰」叠在编辑器视图上，而不是写进文档。装饰只存在于
 * EditorView 的 DOM 里，editor.getHTML() 序列化的是文档本身，产物只有
 *
 *     <pre><code class="language-python">def f(x): ...</code></pre>
 *
 * 里面一个 span 都没有。所以下游无论怎么处理 hljs-* class 都是空转 ——
 * 内联配色、内联行高全都作用在不存在的元素上。高亮必须在这里重新算一遍。
 *
 * 这个模块只负责「产出带 class 的 span」，不管颜色。颜色由各导出路径自己
 * 决定：HTML/PDF 用 CSS 规则（exportStyles.ts），微信用内联 style
 * （wechatInline.ts），因为微信会把 class 剥掉。
 */

/** TipTap 写在 <code> 上的语言 class 前缀，与 extensions.ts 的配置一致 */
const LANGUAGE_PREFIX = "language-";

/**
 * 找不到语言时的兜底。
 *
 * 用 highlightAuto 而不是直接放弃：用户在 Markdown 里写 ``` 不带语言是很常见的，
 * 而 lowlight 的自动识别对主流语言相当准。识别错了最多是颜色分得不对，
 * 仍然比整段单色可读。
 */
function highlightNodes(code: string, language: string | null): Root | null {
  try {
    if (language && lowlight.registered(language)) {
      return lowlight.highlight(language, code);
    }
    // 空代码块交给 highlightAuto 会抛，先挡掉
    if (!code.trim()) return null;
    return lowlight.highlightAuto(code);
  } catch {
    // 语言没注册、或 highlight.js 内部出错。放弃高亮，保留原文 ——
    // 这里绝不能让异常冒出去，那会让整个导出失败，代价远大于少一点颜色
    return null;
  }
}

/** 从 <code> 的 class 串里取出语言名 */
export function languageFrom(className: string): string | null {
  for (const token of className.split(/\s+/)) {
    if (token.startsWith(LANGUAGE_PREFIX)) {
      const name = token.slice(LANGUAGE_PREFIX.length).trim();
      if (name) return name;
    }
  }
  return null;
}

/**
 * 把 hast 树转成 DOM 片段。
 *
 * 手工建节点而不是拼 HTML 字符串再 innerHTML：代码里 `<`、`&`、`"` 是家常便饭，
 * 拼字符串就得自己做转义，漏一处就是把用户的代码结构塞进 DOM ——
 * 用 createTextNode 由浏览器负责转义，这类错误从根上不存在。
 */
function toFragment(nodes: RootContent[], doc: Document): DocumentFragment {
  const fragment = doc.createDocumentFragment();
  for (const node of nodes) {
    if (node.type === "text") {
      fragment.appendChild(doc.createTextNode(node.value));
      continue;
    }
    if (node.type === "element") {
      const el = doc.createElement(node.tagName);
      const className = node.properties?.className;
      if (Array.isArray(className) && className.length) {
        el.setAttribute("class", className.join(" "));
      }
      el.appendChild(toFragment(node.children as RootContent[], doc));
      fragment.appendChild(el);
      continue;
    }
    // comment / doctype 之类：lowlight 不会产出，但类型上存在。忽略。
  }
  return fragment;
}

/**
 * 就地给 root 里所有 <pre><code> 补上高亮 span。返回处理成功的代码块数。
 *
 * 幂等：已经含 hljs span 的代码块会跳过。导出链路上有多次改写 DOM 的步骤，
 * 重复调用不该把已高亮的内容再拆一遍。
 */
export function highlightCodeBlocks(root: HTMLElement): number {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>("pre > code"));
  let done = 0;

  for (const block of blocks) {
    // 已经高亮过就跳过
    if (block.querySelector("[class*='hljs-']")) continue;

    // 必须用 textContent 而不是 innerHTML：highlight.js 要的是源码文本，
    // 喂它带标签的字符串会把标签当代码高亮
    const code = block.textContent ?? "";
    if (!code) continue;

    const tree = highlightNodes(code, languageFrom(block.getAttribute("class") ?? ""));
    if (!tree || !tree.children.length) continue;

    const doc = block.ownerDocument;
    const fragment = toFragment(tree.children, doc);
    // 只有确实产出了 span 才替换。highlightAuto 对纯文本会返回一个纯 text 节点，
    // 那种情况替换与不替换等价，但跳过能少一次 DOM 改写
    if (!fragment.querySelector("*")) continue;

    block.textContent = "";
    block.appendChild(fragment);
    done++;
  }

  return done;
}
