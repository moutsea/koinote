import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createEditorExtensions } from "./extensions";
import { EditorToolbar } from "./EditorToolbar";
import { useI18n, interpolate } from "../../i18n";
import { useSaveDocument } from "../../documents";
import { ApiError, uploadImage } from "../../api";
import type { Document } from "../../documents";

const SAVE_DEBOUNCE_MS = 800;

/** 从粘贴/拖放事件里挑出可上传的图片文件 */
function imageFilesFrom(list: FileList | null | undefined): File[] {
  if (!list) return [];
  return Array.from(list).filter((f) => f.type.startsWith("image/"));
}

type SaveStatus = "idle" | "saving" | "saved" | "failed";

/**
 * 文档驱动的编辑器。
 *
 * 与早期版本的区别：内容不再存 localStorage，而是防抖写回后端。
 * 保存失败会显式提示——静默失败会让用户以为写进去了。
 */
export default function MarkdownEditor({
  document,
  onEditorReady,
  onTitleCommitted,
  outlineSlot,
  leadingControls,
}: {
  document: Document;
  onEditorReady?: (editor: Editor | null) => void;
  onTitleCommitted?: () => void;
  /** 大纲渲染在正文区左侧、标题栏之下——它是正文的一部分，不是独立侧栏 */
  outlineSlot?: React.ReactNode;
  /** 标题栏左侧的控件（面板展开按钮） */
  leadingControls?: React.ReactNode;
}) {
  const { t } = useI18n();
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [charCount, setCharCount] = useState(0);
  const [title, setTitle] = useState(document.title);

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  // 最新待存内容，防抖回调触发时读它，避免闭包捕获旧值
  const pending = useRef<{ title: string; content: string }>({
    title: document.title,
    content: document.content,
  });
  // 标题落库后要刷新侧边栏列表，但内容变化不需要——用它区分
  const titleDirty = useRef(false);
  const save = useSaveDocument();

  const extensions = useMemo(
    () => createEditorExtensions(t.editor.placeholder),
    [t.editor.placeholder],
  );

  const flush = useCallback(async () => {
    const payload = pending.current;
    setStatus("saving");
    try {
      await save.mutateAsync({
        docId: document.docId,
        title: payload.title,
        content: payload.content,
      });
      setStatus("saved");
      if (titleDirty.current) {
        titleDirty.current = false;
        onTitleCommitted?.();
      }
    } catch {
      // 明确告知失败，不静默吞掉
      setStatus("failed");
    }
  }, [document.docId, save, onTitleCommitted]);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
  }, [flush]);

  const editor = useEditor({
    extensions,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class:
          "prose prose-neutral dark:prose-invert max-w-none focus:outline-none min-h-[60vh] px-2 py-4",
      },
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
      pending.current = {
        ...pending.current,
        content: editor.storage.markdown.getMarkdown(),
      };
      setCharCount(editor.getText().length);
      scheduleSave();
    },
  });

  // 把编辑器实例交给外层（大纲面板需要它），同时填进 ref 供上传回调使用
  useEffect(() => {
    editorRef.current = editor;
    onEditorReady?.(editor);
    return () => onEditorReady?.(null);
  }, [editor, onEditorReady]);

  // 切换文档时重新灌入内容。docId 变化才重置，避免自己保存后被回写覆盖。
  useEffect(() => {
    if (!editor) return;
    editor.commands.setContent(document.content);
    setCharCount(editor.getText().length);
    setTitle(document.title);
    pending.current = { title: document.title, content: document.content };
    titleDirty.current = false;
    setStatus("idle");
    // 仅在文档切换或实例就绪时执行；document 对象本身会因保存而变新引用，
    // 依赖它会导致每次保存后重灌内容、光标跳回开头。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, document.docId]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  function handleTitleChange(next: string) {
    setTitle(next);
    pending.current = { ...pending.current, title: next };
    titleDirty.current = true;
    scheduleSave();
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
      </div>

      {/* 大纲与正文同处一行：无分隔线、同底色，读起来是文档的导航而非另一个面板 */}
      <div className="flex min-h-0 flex-1">
        {outlineSlot}

        <div className="flex min-w-0 flex-1 flex-col">
          <EditorToolbar editor={editor} />

          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-3xl px-4">
              <EditorContent editor={editor} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
