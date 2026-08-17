import { useEffect, useRef, useState } from "react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { desktopAPIOrigin, isDesktopRuntime } from "../../desktop/runtime";
import { useI18n } from "../../i18n";
import { imageURLForAttempt } from "./imageLoading";
import {
  DESKTOP_IMAGE_UPLOAD_FAILED_EVENT,
  isDesktopLocalImageURL,
  isRemoteHTTPImageSource,
} from "../../desktop/offlineImagesCore";
import { isDesktopLocalModeSelected } from "../../desktop/localMode";

/**
 * Typora 式图片节点：平时渲染图片，点击后浮出 Markdown 源码可编辑。
 *
 * 编辑的是 `![备注](url)` 整段——改 alt 即改备注，改 url 即换图。
 * 提交时解析回 alt/src 写入节点属性；Esc 放弃，Enter 或失焦提交。
 */

const MARKDOWN_IMAGE = /^!\[([^\]]*)\]\(\s*(\S+?)(?:\s+"([^"]*)")?\s*\)$/;

/**
 * 加载失败后最多重试几次，以及第一次重试等多久（之后每次翻倍）。
 *
 * 600ms / 1.2s / 2.4s，累计约 4 秒。上限的取舍：刚上传的图在 CDN 边缘就绪前
 * 会失败，重试能自愈；而真正坏掉的地址不该转太久，那会让用户以为页面卡住。
 */
const MAX_IMAGE_RETRIES = 3;
const IMAGE_RETRY_BASE_MS = 600;

function toMarkdown(alt: string, src: string, title: string): string {
  const titlePart = title ? ` "${title}"` : "";
  return `![${alt}](${src}${titlePart})`;
}

export function ImageNodeView({
  node,
  updateAttributes,
  deleteNode,
  selected,
  editor,
}: NodeViewProps) {
  const { t } = useI18n();
  const src = (node.attrs.src as string) ?? "";
  const alt = (node.attrs.alt as string) ?? "";
  const title = (node.attrs.title as string) ?? "";

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => toMarkdown(alt, src, title));
  const [broken, setBroken] = useState(false);
  const desktopRuntime = isDesktopRuntime();
  const localMode = desktopRuntime && isDesktopLocalModeSelected();
  const imageProxyOrigin = desktopRuntime ? desktopAPIOrigin() : undefined;
  const resolveBeforeDisplay =
    desktopRuntime && (localMode || isDesktopLocalImageURL(src));
  const [displaySrc, setDisplaySrc] = useState(() =>
    resolveBeforeDisplay ? "" : src,
  );
  const [resolvingLocalImage, setResolvingLocalImage] = useState(resolveBeforeDisplay);
  const [syncError, setSyncError] = useState<string | null>(null);
  const blockedByLocalMode = localMode && isRemoteHTTPImageSource(displaySrc);
  const retryableDisplaySource =
    !blockedByLocalMode && !/^(?:data|blob):/i.test(displaySrc);
  // 重试轮次。既驱动退避定时器，也改变实际请求 URL 与 <img> 的 key。
  const [attempt, setAttempt] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // 删除进行中的标记：deleteNode() 会卸载 input 触发 blur → commit，
  // 那时节点已不存在，写属性会报错或复活一个空节点。
  const removing = useRef(false);

  // 外部改动（撤销、协同、切换文档）要同步回草稿，否则显示的源码会过期
  useEffect(() => {
    if (!editing) setDraft(toMarkdown(alt, src, title));
  }, [alt, src, title, editing]);

  // src 变了就重新给这张图一次机会（比如用户点开源码把地址改对）。
  // 同时把重试轮次归零 —— 换了地址，之前那张图的失败次数不该算在它头上。
  useEffect(() => {
    setBroken(false);
    setAttempt(0);
    setSyncError(null);
  }, [src]);

  useEffect(() => {
    if (!desktopRuntime) {
      setDisplaySrc(src);
      setResolvingLocalImage(false);
      return;
    }
    let disposed = false;
    const localSource = isDesktopLocalImageURL(src);
    const mustResolveBeforeDisplay = localMode || localSource;
    if (mustResolveBeforeDisplay) setDisplaySrc("");
    setResolvingLocalImage(mustResolveBeforeDisplay);
    void import("../../desktop/offlineStore")
      .then(({ desktopImageSyncError, desktopResolveImageSource }) =>
        Promise.all([
          desktopResolveImageSource(src),
          desktopImageSyncError(src),
        ]),
      )
      .then(([resolved, imageSyncError]) => {
        if (disposed) return;
        setSyncError(imageSyncError);
        setResolvingLocalImage(false);
        if (!resolved) {
          setDisplaySrc("");
          setBroken(true);
          return;
        }
        setDisplaySrc(resolved);
        setBroken(false);
        setAttempt(0);
      })
      .catch(() => {
        if (disposed) return;
        setResolvingLocalImage(false);
        setDisplaySrc(mustResolveBeforeDisplay ? "" : src);
        if (mustResolveBeforeDisplay) setBroken(true);
      });
    return () => {
      disposed = true;
    };
  }, [desktopRuntime, localMode, src]);

  useEffect(() => {
    if (!desktopRuntime) return;
    const onUploadFailed = (event: Event) => {
      const detail = (event as CustomEvent<{ localURL?: string; code?: string }>).detail;
      if (detail?.localURL === src && detail.code) setSyncError(detail.code);
    };
    window.addEventListener(DESKTOP_IMAGE_UPLOAD_FAILED_EVENT, onUploadFailed);
    return () =>
      window.removeEventListener(DESKTOP_IMAGE_UPLOAD_FAILED_EVENT, onUploadFailed);
  }, [desktopRuntime, src]);

  // 加载失败后退避重试。
  //
  // 为什么必须有这个：刚上传的图 src 从头到尾不变，所以「src 变化时重置
  // broken」那条救不了它 —— onError 一触发就永久显示"加载失败"，而图在服务端
  // 是好的（实测：R2 里有对象、账本有记录、CDN 与 Worker 代理都返回 200）。
  //
  // 自有图床从第一次显示就走同源 /images/...，避免本地代理 fake-IP 触发 Chrome
  // local address space 拦截。重试仍用于处理 Worker/R2 的瞬时失败和普通外链弱网。
  //
  // 退避而不是立刻重试：立刻重试大概率撞上同一个还没就绪的边缘节点，
  // 白费一次请求还是失败。600ms / 1.2s / 2.4s 三次，累计约 4 秒 —— 覆盖边缘
  // 回源的正常耗时，又不会让真正坏掉的地址转很久。
  useEffect(() => {
    if (!broken || !retryableDisplaySource || attempt >= MAX_IMAGE_RETRIES) return;
    const delay = IMAGE_RETRY_BASE_MS * 2 ** attempt;
    const timer = setTimeout(() => {
      setAttempt((n) => n + 1);
      setBroken(false); // 清掉才会重新渲染 <img>，配合 key 变化触发新请求
    }, delay);
    return () => clearTimeout(timer);
  }, [broken, attempt, retryableDisplaySource]);

  useEffect(() => {
    if (!editing) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    // 光标落在 alt 里：备注是最常改的部分
    const start = draft.indexOf("[") + 1;
    const end = draft.indexOf("]");
    if (start > 0 && end > start) input.setSelectionRange(start, end);
    else input.select();
    // 仅在进入编辑态时聚焦一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing]);

  /**
   * 收回焦点给编辑器。
   *
   * 只在键盘操作（Enter / Esc / 退格删图）后调用 —— 那时用户想继续打字，
   * 把焦点送回正文是对的。
   *
   * 失焦退出时**绝不能**调它：`focus()` 不带位置时，若当前选区不是文本选区
   * （点过图片之后就是这张图的 NodeSelection），TipTap 会走 delayedFocus 并
   * 顺手 scrollIntoView —— 滚回那个 NodeSelection，也就是刚才那张图。
   * 于是「点图 A → 往下滚 → 点图 B」会在 B 的 mousedown 触发 A 的 blur 时
   * 被拽回 A。见 @tiptap/core 的 focus 命令：position === null 且选区非文本
   * 选区时进 delayedFocus，其中 scrollIntoView 默认为 true。
   */
  function refocusEditor() {
    editor.commands.focus();
  }

  /**
   * 提交草稿。
   *
   * refocus 由调用方决定：键盘操作要把焦点送回正文，失焦退出不要 ——
   * 那时焦点该落在用户刚点的地方。
   */
  function commit({ refocus }: { refocus: boolean }) {
    if (removing.current) return; // 节点正在被删，不要再写属性
    const matched = MARKDOWN_IMAGE.exec(draft.trim());
    if (!matched) {
      // 解析不出来就当放弃，不静默写入坏数据
      setDraft(toMarkdown(alt, src, title));
      setEditing(false);
      return;
    }
    const [, nextAlt, nextSrc, nextTitle] = matched;
    updateAttributes({
      alt: nextAlt,
      src: nextSrc,
      title: nextTitle ?? null,
    });
    setEditing(false);
    if (refocus) refocusEditor();
  }

  function cancel() {
    setDraft(toMarkdown(alt, src, title));
    setEditing(false);
    // Esc 是键盘操作，焦点该回到正文
    refocusEditor();
  }

  /**
   * 删掉整个图片节点。
   *
   * 先退出编辑态再删：留在编辑态时 input 会随节点一起卸载，
   * 触发 blur → commit，对着已不存在的节点写属性。
   */
  function removeImage() {
    removing.current = true;
    setEditing(false);
    deleteNode();
    // 删图是键盘操作（退格/删除），焦点该回到正文继续编辑。
    // 这里也不会有跳位问题：节点已经删掉，那个 NodeSelection 不复存在
    refocusEditor();
  }

  return (
    <NodeViewWrapper className="my-2">
      <figure className="m-0">
        {/* 源码行在图片上方：编辑时视线与光标都在这一行，
            图片留在下方作为即时预览，改完立刻知道换的是哪张。 */}
        {editing && (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            // 失焦提交但不抢焦点：用户点了别处，焦点该留在那儿。
            // 送回编辑器会连带 scrollIntoView 滚回这张图 —— 就是「点另一张图
            // 却被拽回上一张」那个 bug。见 refocusEditor 的注释。
            onBlur={() => commit({ refocus: false })}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                // 回车是显式确认，焦点回正文继续打字
                commit({ refocus: true });
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                cancel();
                return;
              }
              // 退格/删除意在「删掉这张图」，不是逐字符改源码。
              // 但整段选中时放行原生行为，否则改不了备注里的错字——
              // 进入编辑态默认选中 alt，直接打字即替换，这条才成立。
              if (e.key === "Backspace" || e.key === "Delete") {
                const input = e.currentTarget;
                const hasSelection =
                  input.selectionStart !== input.selectionEnd;
                if (hasSelection) return; // 有选区：正常编辑文本
                e.preventDefault();
                removeImage();
              }
            }}
            spellCheck={false}
            aria-label={t.editor.imageMarkdownLabel}
            className="mb-1.5 w-full rounded-lg border border-cinnabar-500/40 bg-cinnabar-50/40 px-3 py-2 font-mono text-[13px] outline-none focus:border-cinnabar-500 dark:bg-cinnabar-950/20"
          />
        )}

        <button
          type="button"
          // 编辑中点图片不该收起源码行。阻止默认行为避免抢走 input 焦点，
          // 否则 blur 触发 commit，源码行刚打开就被关掉。
          onMouseDown={(e) => {
            if (editing) e.preventDefault();
          }}
          onClick={() => {
            if (!editing) setEditing(true);
          }}
          // 图片本身获得焦点时（Tab 或点击后），退格/删除同样删整张图。
          // 焦点在 button 上，ProseMirror 收不到这个按键，得自己接。
          onKeyDown={(e) => {
            if (editing) return;
            if (e.key === "Backspace" || e.key === "Delete") {
              e.preventDefault();
              removeImage();
            }
          }}
          title={t.editor.imageClickToEdit}
          aria-expanded={editing}
          className={`block w-full overflow-hidden rounded-lg border text-left transition ${
            editing
              ? "cursor-default border-cinnabar-500"
              : selected
                ? "cursor-pointer border-cinnabar-500"
                : "cursor-pointer border-transparent hover:border-cinnabar-500/40"
          }`}
        >
          {resolvingLocalImage ? (
            <span className="block px-3 py-6 text-center text-xs text-neutral-400">
              {t.editor.imageRetrying}
            </span>
          ) : broken || blockedByLocalMode ? (
            // 图挂了也要能点开改 URL，否则用户被困在一个坏节点上。
            // 还在重试期间给不同的文案：那几秒里说"加载失败"会让人以为已经没救，
            // 于是去动一个其实马上就会自己好的地址
            <span className="block px-3 py-6 text-center text-xs text-neutral-400">
              {retryableDisplaySource && attempt < MAX_IMAGE_RETRIES
                ? t.editor.imageRetrying
                : t.editor.imageBroken}
            </span>
          ) : (
            <img
              // key 强制重挂 DOM；自有 CDN 从首次显示起就映射到同源 /images/...，
              // 其他图片重试时用轮次查询串绕过失败缓存。正文 src 始终不变。
              key={attempt}
              src={imageURLForAttempt(displaySrc, attempt, imageProxyOrigin)}
              alt={alt}
              title={title || undefined}
              onError={() => setBroken(true)}
              className="mx-auto block max-w-full"
            />
          )}
        </button>

        {syncError && (
          <p className="mt-1 text-center text-xs text-red-600 dark:text-red-400" role="alert">
            {t.errors[syncError] || t.editor.uploadFailed}
          </p>
        )}

        {/* 非编辑态用 alt 当图注。编辑态下源码行已经把 alt 显示出来了，
            再挂一行图注是重复信息。 */}
        {!editing && alt && (
          <figcaption className="mt-1 text-center text-xs text-neutral-400">
            {alt}
          </figcaption>
        )}
      </figure>
    </NodeViewWrapper>
  );
}
