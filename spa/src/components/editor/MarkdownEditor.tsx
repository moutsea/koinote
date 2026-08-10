import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createEditorExtensions } from "./extensions";
import { DocTitle } from "./DocTitle";
import { EditorToolbar } from "./EditorToolbar";
import { useI18n, interpolate } from "../../i18n";
import { ThemePicker } from "./ThemePicker";
import { THEME_SCOPE, editorContentClass, themeToCSS } from "./themeCss";
import type { DocPatch, SaveStatus } from "./useDocumentSaver";
import { ApiError, fetchImageToBucket, uploadImage } from "../../api";
import {
  dataUriToFile,
  imageSrcsFromHtml,
  isDataUri,
  needsRehost,
  replaceImageSrcs,
} from "./rehost";
import type { Document } from "../../documents";

/**
 * 没套主题时标题的排版。
 *
 * 有主题时由主题的 h1 规则接管（themeCss.ts），这里只管「不套主题」那种情况。
 * 不能直接用 prose 的 h1 样式：prose 只作用在 .ProseMirror 内部，标题在它外面。
 * 数值对着 exportStyles.ts 的 `h1 { font-size: 1.9em }` 抄 —— 那是导出 HTML/PDF
 * 时不套主题的标题样式，两边保持一致，编辑区才等于预览。
 */
const DEFAULT_TITLE_CLASS =
  "mb-3 mt-4 text-[1.9em] font-bold leading-[1.3] tracking-tight";

/** 从粘贴/拖放事件里挑出可上传的图片文件 */
function imageFilesFrom(list: FileList | null | undefined): File[] {
  if (!list) return [];
  return Array.from(list).filter((f) => f.type.startsWith("image/"));
}

/**
 * 文档驱动的编辑器。受控组件 —— 待存内容与保存状态都在页面层（useDocumentSaver）。
 *
 * 为什么保存不放在这里（原来就在这里）：多开标签后实例会被 LRU 淘汰，卸载时组件里
 * 的待存内容就没了。而且保存失败时组件已经不存在，没人重试也没人提示。
 */
export default function MarkdownEditor({
  document,
  status,
  onChange,
  onFlush,
  onEditorReady,
  scrollContainerRef,
  outlineSlot,
  leadingControls,
  trailingControls,
}: {
  document: Document;
  /** 保存状态由页面给 —— 待存内容不再随实例存亡，见 useDocumentSaver */
  status: SaveStatus;
  onChange: (patch: DocPatch) => void;
  /** 立刻存。换主题时用：那是一次显式动作，等防抖没意义 */
  onFlush: () => void;
  onEditorReady?: (editor: Editor | null) => void;
  /** 滚动容器。多开时由外层持有，用于在标签隐藏/显示间存取滚动位置 */
  scrollContainerRef?: React.RefObject<HTMLDivElement | null>;
  /** 大纲渲染在正文区左侧、标题栏之下——它是正文的一部分，不是独立侧栏 */
  outlineSlot?: React.ReactNode;
  /** 标题栏左侧的控件（面板展开按钮） */
  leadingControls?: React.ReactNode;
  /** 标题栏右侧的控件（分享、导出） */
  trailingControls?: React.ReactNode;
}) {
  const { t } = useI18n();
  const [charCount, setCharCount] = useState(0);
  const [title, setTitle] = useState(document.title);
  const [themeId, setThemeId] = useState(document.theme ?? "");
  // 粘贴/拖放处理器在 useEditor 的配置里，那时 editor 还不存在，
  // 所以经 ref 间接拿实例，打破循环依赖。
  const editorRef = useRef<Editor | null>(null);
  const [uploading, setUploading] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const uploadFiles = useCallback(
    async (files: File[]) => {
      setUploadError(null);
      for (const file of files) {
        setUploading((n) => n + 1);
        try {
          const image = await uploadImage(file);
          const instance = editorRef.current;
          if (!instance) continue;
          instance
            .chain()
            .focus()
            .setImage({ src: image.url, alt: file.name })
            .run();
        } catch (err) {
          // 上传失败必须显形。静默失败会让人以为图片存进去了，
          // 等到重开文档才发现图没了。
          if (err instanceof ApiError) {
            setUploadError(
              (err.code && t.errors[err.code]) || err.message || t.editor.uploadFailed,
            );
          } else {
            setUploadError(t.editor.uploadFailed);
          }
        } finally {
          setUploading((n) => Math.max(0, n - 1));
        }
      }
    },
    [t],
  );
  /**
   * 把正文里的外链图片转存进图床。
   *
   * 走「插入之后再扫一遍」而不是拦住粘贴、先改 HTML 再插入：粘贴 HTML、粘贴
   * Markdown（tiptap-markdown 会把 ![](url) 解析成图片节点）、拖入链接三条路都会汇到
   * 同一处，只写一遍。代价是外链地址会先在编辑器里显示一小会儿 —— 那反而是好事，
   * 用户立刻看到图，转存在背后进行。
   *
   * 按 src 值定位节点而不是记位置：转存是异步的，期间用户可能继续打字，位置会失效。
   * 同一个 src 出现多次时一次全换掉。
   */
  const rehostRemoteImages = useCallback(async () => {
    const instance = editorRef.current;
    if (!instance) return;

    const targets = new Set<string>();
    instance.state.doc.descendants((node) => {
      if (node.type.name !== "image") return;
      const src = node.attrs.src;
      if (typeof src === "string" && needsRehost(src)) targets.add(src);
    });
    if (targets.size === 0) return;

    setUploadError(null);
    for (const src of targets) {
      setUploading((n) => n + 1);
      try {
        const { image } = await fetchImageToBucket(src);
        const live = editorRef.current;
        if (!live) continue;

        // 一个事务里把所有引用这个 src 的节点都换掉
        const tr = live.state.tr;
        let touched = false;
        live.state.doc.descendants((node, pos) => {
          if (node.type.name !== "image" || node.attrs.src !== src) return;
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: image.url });
          touched = true;
        });
        // addToHistory: false —— 转存是后台行为，不该占一步撤销。
        // 否则用户按一次 Ctrl+Z 只是把图片地址退回外链，很费解
        if (touched) live.view.dispatch(tr.setMeta("addToHistory", false));
      } catch (err) {
        // 转存失败不撤掉已插入的图：外链虽然可能失效，但比让图直接消失好。
        // 提示要给到，否则用户以为图已经进图床了
        if (err instanceof ApiError) {
          setUploadError(
            (err.code && t.errors[err.code]) || err.message || t.editor.rehostFailed,
          );
        } else {
          setUploadError(t.editor.rehostFailed);
        }
      } finally {
        setUploading((n) => Math.max(0, n - 1));
      }
    }
  }, [t]);

  /**
   * 粘贴带 base64 图的 HTML（Word、Google Docs、部分截图工具）。
   *
   * 这一条必须在解析前接手：编辑器配了 allowBase64: false，解析器会把 data: 的图片
   * 节点直接丢掉 —— 图无声消失。所以先把 data URI 抽出来上传，把 HTML 里的地址换成
   * R2 的，再交给编辑器解析。
   *
   * 返回 true 表示已接手。
   */
  const pasteHtmlWithDataUris = useCallback(
    (html: string): boolean => {
      const dataUris = imageSrcsFromHtml(html).filter(isDataUri);
      if (dataUris.length === 0) return false;

      void (async () => {
        setUploadError(null);
        const mapping = new Map<string, string>();
        for (const [i, uri] of dataUris.entries()) {
          const file = dataUriToFile(uri, i);
          if (!file) continue;
          setUploading((n) => n + 1);
          try {
            const image = await uploadImage(file);
            mapping.set(uri, image.url);
          } catch (err) {
            if (err instanceof ApiError) {
              setUploadError(
                (err.code && t.errors[err.code]) || err.message || t.editor.uploadFailed,
              );
            } else {
              setUploadError(t.editor.uploadFailed);
            }
          } finally {
            setUploading((n) => Math.max(0, n - 1));
          }
        }

        const instance = editorRef.current;
        if (!instance) return;
        // 上传失败的 data URI 留在 mapping 外，替换后仍是 data: —— 解析器会丢掉它们，
        // 这时错误提示已经给出去了
        instance.chain().focus().insertContent(replaceImageSrcs(html, mapping)).run();
        // 插进去的 HTML 里可能还有外链图，接着扫一遍
        void rehostRemoteImages();
      })();

      return true;
    },
    [t, rehostRemoteImages],
  );

  const extensions = useMemo(
    () => createEditorExtensions(t.editor.placeholder),
    [t.editor.placeholder],
  );

  /**
   * 换主题：立刻存，不进防抖队列。
   *
   * 打字要防抖是因为每个字符都触发保存太吵；换主题是一次显式点击，等 800ms
   * 再存没有意义，而且用户可能立刻关掉标签页 —— 那时防抖里的改动就丢了。
   */
  const changeTheme = useCallback(
    (next: string) => {
      setThemeId(next);
      onChange({ theme: next });
      onFlush();
    },
    [onChange, onFlush],
  );

  const themeCSS = useMemo(() => themeToCSS(themeId), [themeId]);


  const editor = useEditor({
    extensions,
    immediatelyRender: false,
    editorProps: {
      attributes: { class: editorContentClass(document.theme ?? "") },
      handlePaste: (view, event) => {
        // 1) 剪贴板里直接是图片文件（截图、从 Finder 复制）—— 上传后插入
        const files = imageFilesFrom(event.clipboardData?.files);
        if (files.length > 0) {
          event.preventDefault();
          void uploadFiles(files);
          return true; // 已接手，阻止默认粘贴（否则会插入 base64 或本地 blob URL）
        }

        // 2) HTML 里带 base64 图 —— 必须在解析前接手，否则 allowBase64: false
        //    会让解析器把这些节点直接丢掉
        const html = event.clipboardData?.getData("text/html");
        if (html && pasteHtmlWithDataUris(html)) {
          event.preventDefault();
          return true;
        }

        // 3) 其余情况（HTML 里的外链图、Markdown 的 ![](url)）交给默认粘贴，
        //    插进来之后再扫一遍转存。放在微任务里等这次事务落定
        queueMicrotask(() => void rehostRemoteImages());
        return false;
      },
      handleDrop: (view, event) => {
        const dragEvent = event as DragEvent;
        const files = imageFilesFrom(dragEvent.dataTransfer?.files);
        if (files.length > 0) {
          event.preventDefault();
          void uploadFiles(files);
          return true;
        }
        // 拖进来的可能是一个图片链接，同样走转存
        queueMicrotask(() => void rehostRemoteImages());
        return false;
      },
    },
    onUpdate: ({ editor }) => {
      onChange({ content: editor.storage.markdown.getMarkdown() });
      setCharCount(editor.getText().length);
    },
  });

  // 把编辑器实例交给外层（大纲面板需要它），同时填进 ref 供上传回调使用
  useEffect(() => {
    editorRef.current = editor;
    onEditorReady?.(editor);
    return () => onEditorReady?.(null);
  }, [editor, onEditorReady]);

  // editorProps 只在 useEditor 初始化时读一次，换主题必须显式改写。
  // 切的是 prose 的有无：套主题时 prose 会用 code::before 给行内代码补反引号，
  // 还有一堆主题不知道的 margin，留着就打架
  useEffect(() => {
    if (!editor) return;
    editor.setOptions({
      editorProps: { attributes: { class: editorContentClass(themeId) } },
    });
  }, [editor, themeId]);

  // 挂载或换文档时灌入内容。
  //
  // document 由页面传下来，已经把未落库的待存改动合并进去了（见 EditorPage 的
  // peek 合并）—— 所以被 LRU 淘汰又点回来的标签会恢复到离开时的文字，而不是
  // 退回服务端那份。撕销历史与光标位置恢复不了，那是 3 个活实例上限的代价。
  //
  // 只依赖 docId：document 对象本身会因保存而变新引用，依赖它会导致每次保存后
  // 重灌内容、光标跳回开头。
  useEffect(() => {
    if (!editor) return;
    editor.commands.setContent(document.content);
    setCharCount(editor.getText().length);
    setTitle(document.title);
    setThemeId(document.theme ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, document.docId]);

  function handleTitleChange(next: string) {
    setTitle(next);
    onChange({ title: next });
  }

  /**
   * 标题里按回车 → 光标进正文开头。
   *
   * 标题和正文现在上下相邻，回车是「写完标题开始写内容」最自然的动作。
   * 不这么做的话，textarea 里的回车会被剥成空格（见 DocTitle），什么也不发生 ——
   * 那种"按了没反应"比换行更让人困惑。
   */
  const focusBody = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    // 'start' 而不是 focus()：后者会落回上次的光标位置，可能在文档中间。
    // 刚写完标题，要去的是正文开头。
    editor.commands.focus("start");
  }, []);

  const statusText =
    status === "saving"
      ? t.editor.saving
      : status === "saved"
        ? t.editor.saved
        : status === "failed"
          ? t.editor.saveFailed
          : "";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 控件栏不再放标题输入框 —— 标题挪到正文列里了（见下方 DocTitle）。
          这一行现在只承载状态与操作，所以留一个 flex-1 的空位把右侧控件推到边上 */}
      <div className="flex items-center gap-3 border-b border-black/5 px-4 py-2 dark:border-white/10">
        {leadingControls}
        <span className="min-w-0 flex-1" />
        <span className="shrink-0 text-xs text-neutral-400">
          {interpolate(t.editor.charCount, { n: charCount })}
        </span>
        {uploading > 0 && (
          <span className="shrink-0 text-xs text-neutral-400">
            {interpolate(t.editor.uploadingImages, { n: uploading })}
          </span>
        )}
        {uploadError && (
          <button
            type="button"
            onClick={() => setUploadError(null)}
            title={uploadError}
            className="shrink-0 truncate text-xs text-red-600 hover:underline dark:text-red-400"
          >
            {uploadError}
          </button>
        )}
        {statusText && (
          <span
            className={`shrink-0 text-xs ${
              status === "failed" ? "text-red-600 dark:text-red-400" : "text-neutral-400"
            }`}
          >
            {statusText}
          </span>
        )}
        <ThemePicker value={themeId} onChange={changeTheme} />
        {trailingControls}
      </div>

      {/* 大纲与正文同处一行：无分隔线、同底色，读起来是文档的导航而非另一个面板 */}
      <div className="flex min-h-0 flex-1">
        {outlineSlot}

        <div className="flex min-w-0 flex-1 flex-col">
          <EditorToolbar editor={editor} />

          <div ref={scrollContainerRef} className="min-h-0 flex-1 overflow-y-auto">
            {/* 主题 CSS 随文档走，挂在作用域容器上。空串时 themeCSS 是空的，
                editorContentClass 会把 prose 加回来，观感回到没有主题的样子 */}
            {themeCSS && <style>{themeCSS}</style>}
            <div
              className={`mx-auto w-full max-w-3xl px-4 ${themeId ? THEME_SCOPE : ""}`}
            >
              {/* 标题在作用域容器内、正文之前：这样它拿得到主题的 h1 规则，
                  且与正文同宽同左边缘 —— 它本来就是这篇文档的第一个 h1 */}
              <div className={themeId ? "" : DEFAULT_TITLE_CLASS}>
                <DocTitle
                  value={title}
                  onChange={handleTitleChange}
                  onEnter={focusBody}
                />
              </div>
              <EditorContent editor={editor} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
