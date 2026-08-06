import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createEditorExtensions } from "./extensions";
import { EditorToolbar } from "./EditorToolbar";
import { useI18n, interpolate } from "../../i18n";
import { ThemePicker } from "./ThemePicker";
import { THEME_SCOPE, editorContentClass, themeToCSS } from "./themeCss";
import type { DocPatch, SaveStatus } from "./useDocumentSaver";
import { ApiError, uploadImage } from "../../api";
import type { Document } from "../../documents";

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
        const files = imageFilesFrom(event.clipboardData?.files);
        if (files.length === 0) return false;
        event.preventDefault();
        void uploadFiles(files);
        return true; // 已接手，阻止默认粘贴（否则会插入 base64 或本地 blob URL）
      },
      handleDrop: (view, event) => {
        const dragEvent = event as DragEvent;
        const files = imageFilesFrom(dragEvent.dataTransfer?.files);
        if (files.length === 0) return false;
        event.preventDefault();
        void uploadFiles(files);
        return true;
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
      <div className="flex items-center gap-3 border-b border-black/5 px-4 py-2 dark:border-white/10">
        {leadingControls}
        <input
          value={title}
          onChange={(e) => handleTitleChange(e.target.value)}
          placeholder={t.editor.titlePlaceholder}
          aria-label={t.editor.titlePlaceholder}
          className="min-w-0 flex-1 bg-transparent text-sm font-medium outline-none placeholder:text-neutral-400"
        />
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
              <EditorContent editor={editor} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
