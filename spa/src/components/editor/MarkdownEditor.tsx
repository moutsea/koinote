import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
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
import {
  DESKTOP_IMAGE_MAPPING_META,
  DESKTOP_IMAGE_UPLOADED_EVENT,
} from "../../desktop/offlineImagesCore";
import { isLocalModeNetworkDisabled } from "../../desktop/localMode";
import { isDesktopRuntime } from "../../desktop/runtime";
import { normalizeLegacyImageAdjacentHeadings } from "./markdownImage";
import { applyUploadedImageMappingToEditor } from "./imageUploadMapping";
import { DocumentFindBar } from "./DocumentFindBar";
import { readTreeDragPayload } from "./treeDrag";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { cellAround, CellSelection } from "@tiptap/pm/tables";
import { TextSelection } from "@tiptap/pm/state";
import {
  ArrowLeft,
  ArrowUp,
  AlignCenter,
  AlignLeft,
  AlignRight,
  Eraser,
  PanelTop,
  TableColumnsSplit,
  TableRowsSplit,
  Trash2,
} from "lucide-react";
import {
  clearSelectedTableCells,
  clearTableAxis,
  hasTableHeaderRow,
  insertTableMatrix,
  isTableCellSelection,
  selectCurrentTableColumn,
  selectCurrentTableRow,
  setTableColumnAlignment,
  tableMatrixFromClipboard,
  tableSelectionToMarkdown,
  shouldInterceptTablePaste,
} from "./tableActions";
import { TableContextToolbar } from "./TableContextToolbar";

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
  onContentLoaded,
  onImageSourceMapped,
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
  /** 记录真正喂给编辑器的 Markdown，供同步判断是否需要重建实例。 */
  onContentLoaded?: (content: string) => void;
  onImageSourceMapped?: (localURL: string, remoteURL: string) => void;
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
  const [uploadNotice, setUploadNotice] = useState<string | null>(null);
  const [tableContextMenu, setTableContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const editorRootRef = useRef<HTMLDivElement | null>(null);
  const onContentLoadedRef = useRef(onContentLoaded);
  onContentLoadedRef.current = onContentLoaded;

  useEffect(() => {
    if (!uploadNotice) return;
    const timer = window.setTimeout(() => setUploadNotice(null), 5_000);
    return () => window.clearTimeout(timer);
  }, [uploadNotice]);

  const uploadFiles = useCallback(
    async (files: File[]) => {
      setUploadError(null);
      for (const file of files) {
        setUploading((n) => n + 1);
        try {
          const image = await uploadImage(file);
          if (image.flattenedAnimation) {
            setUploadNotice(interpolate(t.transfer.importGifFlattened, { count: 1 }));
          }
          const instance = editorRef.current;
          if (!instance) continue;
          // alt 留空，不拿 file.name 顶上。
          //
          // 文件名不是备注：截图默认叫 image.png / 企业微信截图_xxx.png，
          // 粘贴一张图就白得一行"image.png"图注，还得手动删。空 alt 时
          // ImageNodeView 不渲染 figcaption，导出的 Markdown 是 ![](url)，
          // 想写备注点开源码行加就行。
          instance.chain().focus().setImage({ src: image.url }).run();
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
        if (isLocalModeNetworkDisabled(err)) {
          setUploadError(t.desktopLocalMode.networkDisabled);
        } else if (err instanceof ApiError) {
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
            if (image.flattenedAnimation) {
              setUploadNotice(interpolate(t.transfer.importGifFlattened, { count: 1 }));
            }
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
      clipboardTextSerializer: (slice) => {
        const instance = editorRef.current;
        const tableMarkdown = instance
          ? tableSelectionToMarkdown(instance, slice)
          : null;
        if (tableMarkdown !== null) return tableMarkdown;
        const serializer = instance
          ? (
              instance.storage.markdown as {
                serializer?: { serialize: (content: typeof slice.content) => string };
              }
            ).serializer
          : undefined;
        return serializer?.serialize(slice.content) ?? "";
      },
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

        // 3) 从 Excel、表格应用复制的 TSV/HTML 表格：直接填充当前表格，
        //    不把多行数据拆成普通段落。带图片的 HTML 表格留给默认解析器，
        //    这样图片仍会走图床转存流程。
        // 代码块中的制表符是代码缩进或文本内容，必须保留默认粘贴目标。
        const shouldIntercept = shouldInterceptTablePaste(
          view.state.selection.$from.parent.type.name,
        );
        const matrix = shouldIntercept
          ? tableMatrixFromClipboard(
              event.clipboardData?.getData("text/plain") ?? "",
              html ?? null,
              view.dom.ownerDocument,
            )
          : null;
        if (matrix) {
          event.preventDefault();
          const instance = editorRef.current;
          if (instance) insertTableMatrix(instance, matrix);
          return true;
        }

        // 4) 其余情况（HTML 里的外链图、Markdown 的 ![](url)）交给默认粘贴，
        //    插进来之后再扫一遍转存。放在微任务里等这次事务落定
        queueMicrotask(() => void rehostRemoteImages());
        return false;
      },
      handleDrop: (view, event) => {
        const dragEvent = event as DragEvent;
        if (
          dragEvent.dataTransfer &&
          readTreeDragPayload(dragEvent.dataTransfer)
        ) {
          event.preventDefault();
          return true;
        }
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
    onUpdate: ({ editor, transaction }) => {
      if (!transaction.getMeta(DESKTOP_IMAGE_MAPPING_META)) {
        onChange({ content: editor.storage.markdown.getMarkdown() });
      }
      setCharCount(editor.getText().length);
    },
  });

  // 把编辑器实例交给外层（大纲面板需要它），同时填进 ref 供上传回调使用
  useEffect(() => {
    editorRef.current = editor;
    onEditorReady?.(editor);
    return () => onEditorReady?.(null);
  }, [editor, onEditorReady]);

  useEffect(() => {
    if (!editor || !isDesktopRuntime()) return;
    const replaceUploadedImage = (event: Event) => {
      const detail = (event as CustomEvent<{
        localURL?: string;
        remoteURL?: string;
      }>).detail;
      if (!detail?.localURL || !detail.remoteURL) return;
      const scrollContainer = scrollContainerRef?.current;
      const scrollTop = scrollContainer?.scrollTop;
      const scrollLeft = scrollContainer?.scrollLeft;
      if (
        applyUploadedImageMappingToEditor(
          editor,
          detail.localURL,
          detail.remoteURL,
        )
      ) {
        onImageSourceMapped?.(detail.localURL, detail.remoteURL);
        // 图片上传完成只是把本地占位地址换成图床地址，不是用户主动导航。
        // ProseMirror 更新图片节点时可能把当前选区滚回可视区，React NodeView
        // 随后更新又可能触发一次浏览器滚动锚定；同步恢复并在下一帧再校正一次，
        // 保住用户正在阅读的位置，同时不改选区、不抢焦点。
        if (scrollContainer && scrollTop !== undefined && scrollLeft !== undefined) {
          const restoreScrollPosition = () => {
            scrollContainer.scrollTop = scrollTop;
            scrollContainer.scrollLeft = scrollLeft;
          };
          restoreScrollPosition();
          window.requestAnimationFrame(restoreScrollPosition);
        }
      }
    };
    window.addEventListener(DESKTOP_IMAGE_UPLOADED_EVENT, replaceUploadedImage);
    return () =>
      window.removeEventListener(
        DESKTOP_IMAGE_UPLOADED_EVENT,
        replaceUploadedImage,
      );
  }, [editor, onImageSourceMapped, scrollContainerRef]);

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
  // 退回服务端那份。撤销历史仍是 3 个活实例上限的代价；光标位置由页面层按
  // docId 记录，即使实例被淘汰，重新挂载后也会恢复。
  //
  // 只依赖 docId：document 对象本身会因保存而变新引用，依赖它会导致每次保存后
  // 重灌内容、光标跳回开头。onContentLoaded 经 ref 读取，调用方身份变化也不能让
  // 这个 effect 重跑。
  useEffect(() => {
    if (!editor) return;
    const normalizedContent = normalizeLegacyImageAdjacentHeadings(
      document.content,
    );
    editor.commands.setContent(normalizedContent);
    onContentLoadedRef.current?.(normalizedContent);
    if (normalizedContent !== document.content) {
      // 让兼容恢复不只停留在当前 DOM：排入正常的 CAS 保存链，分享页和下一次
      // 打开也会读到修复后的 Markdown。
      onChange({ content: normalizedContent });
    }
    setCharCount(editor.getText().length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, document.docId]);

  useEffect(() => setTitle(document.title), [document.docId, document.title]);
  useEffect(
    () => setThemeId(document.theme ?? ""),
    [document.docId, document.theme],
  );

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

  const handleEditorContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (!editor) return;
      if (!editor.view.dom.contains(event.target as Node)) return;
      const coordinates = editor.view.posAtCoords({
        left: event.clientX,
        top: event.clientY,
      });
      if (!coordinates) return;

      const $position = editor.state.doc.resolve(coordinates.pos);
      const $cell = cellAround($position);
      if (!$cell) return;

      event.preventDefault();
      const targetSelection = TextSelection.near($position, 1);
      const currentSelection = editor.state.selection;
      let preserveCellSelection = false;
      if (currentSelection instanceof CellSelection) {
        currentSelection.forEachCell((_cell, position) => {
          if (position === $cell.pos) preserveCellSelection = true;
        });
      }
      if (!preserveCellSelection && !currentSelection.eq(targetSelection)) {
        editor.view.dispatch(editor.state.tr.setSelection(targetSelection));
      }
      setTableContextMenu({ x: event.clientX, y: event.clientY });
    },
    [editor],
  );

  const closeTableContextMenu = useCallback(() => {
    setTableContextMenu(null);
  }, []);

  const tableContextMenuItems = useMemo<ContextMenuItem[] | null>(() => {
    if (!editor || !tableContextMenu) return null;
    return [
      {
        key: "add-row-before",
        label: t.editor.toolbar.tableAddRowBefore,
        icon: <ArrowUp className="h-4 w-4" />,
        onSelect: () => editor.chain().focus().addRowBefore().run(),
        disabled: !editor.can().addRowBefore(),
      },
      {
        key: "add-row",
        label: t.editor.toolbar.tableAddRow,
        icon: <TableRowsSplit className="h-4 w-4" />,
        onSelect: () => editor.chain().focus().addRowAfter().run(),
        disabled: !editor.can().addRowAfter(),
      },
      {
        key: "add-column-before",
        label: t.editor.toolbar.tableAddColumnBefore,
        icon: <ArrowLeft className="h-4 w-4" />,
        onSelect: () => editor.chain().focus().addColumnBefore().run(),
        disabled: !editor.can().addColumnBefore(),
      },
      {
        key: "add-column",
        label: t.editor.toolbar.tableAddColumn,
        icon: <TableColumnsSplit className="h-4 w-4" />,
        onSelect: () => editor.chain().focus().addColumnAfter().run(),
        disabled: !editor.can().addColumnAfter(),
      },
      {
        key: "header-row",
        label: t.editor.toolbar.tableHeaderRow,
        icon: <PanelTop className="h-4 w-4" />,
        onSelect: () => editor.chain().focus().toggleHeaderRow().run(),
        disabled: hasTableHeaderRow(editor) || !editor.can().toggleHeaderRow(),
      },
      {
        key: "align-left",
        label: t.editor.toolbar.tableAlignLeft,
        icon: <AlignLeft className="h-4 w-4" />,
        onSelect: () => setTableColumnAlignment(editor, "left"),
      },
      {
        key: "align-center",
        label: t.editor.toolbar.tableAlignCenter,
        icon: <AlignCenter className="h-4 w-4" />,
        onSelect: () => setTableColumnAlignment(editor, "center"),
      },
      {
        key: "align-right",
        label: t.editor.toolbar.tableAlignRight,
        icon: <AlignRight className="h-4 w-4" />,
        onSelect: () => setTableColumnAlignment(editor, "right"),
      },
      ...(isTableCellSelection(editor)
        ? [
            {
              key: "clear-selection",
              label: t.editor.toolbar.tableClearSelection,
              icon: <Eraser className="h-4 w-4" />,
              onSelect: () => clearSelectedTableCells(editor),
            },
          ]
        : []),
      {
        key: "clear-row",
        label: t.editor.toolbar.tableClearRow,
        icon: <Eraser className="h-4 w-4" />,
        onSelect: () => clearTableAxis(editor, "row"),
      },
      {
        key: "clear-column",
        label: t.editor.toolbar.tableClearColumn,
        icon: <Eraser className="h-4 w-4" />,
        onSelect: () => clearTableAxis(editor, "column"),
      },
      {
        key: "delete-row",
        label: t.editor.toolbar.tableDeleteRow,
        icon: <TableRowsSplit className="h-4 w-4" />,
        onSelect: () => editor.chain().focus().deleteRow().run(),
        danger: true,
        disabled: !editor.can().deleteRow(),
      },
      {
        key: "delete-column",
        label: t.editor.toolbar.tableDeleteColumn,
        icon: <TableColumnsSplit className="h-4 w-4" />,
        onSelect: () => editor.chain().focus().deleteColumn().run(),
        danger: true,
        disabled: !editor.can().deleteColumn(),
      },
      {
        key: "delete-table",
        label: t.editor.toolbar.tableDelete,
        icon: <Trash2 className="h-4 w-4" />,
        onSelect: () => editor.chain().focus().deleteTable().run(),
        danger: true,
        disabled: !editor.can().deleteTable(),
      },
    ];
  }, [editor, t, tableContextMenu]);

  const statusText =
    status === "saving"
      ? t.editor.saving
      : status === "saved"
        ? t.editor.saved
        : status === "backed-up"
          ? `${t.editor.saveFailed} · ${t.editor.saveFailedBackedUp}`
          : status === "failed"
            ? `${t.editor.saveFailed} · ${t.editor.saveBackupFailed}`
            : status === "conflict"
              ? t.editor.resolveConflict
              : "";
  const retryableSave = status === "backed-up" || status === "failed";

  return (
    <div
      ref={editorRootRef}
      data-koinote-editor-instance
      onContextMenu={handleEditorContextMenu}
      className="relative flex min-h-0 flex-1 flex-col"
    >
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
        {uploadNotice && (
          <button
            type="button"
            onClick={() => setUploadNotice(null)}
            title={uploadNotice}
            className="shrink-0 truncate text-xs text-neutral-500 hover:underline dark:text-neutral-400"
          >
            {uploadNotice}
          </button>
        )}
        {statusText &&
          (retryableSave ? (
            <button
              type="button"
              onClick={onFlush}
              title={`${statusText} · ${t.editor.retrySave}`}
              className={`min-w-0 max-w-[16rem] truncate text-xs hover:underline ${
                status === "backed-up"
                  ? "text-amber-700 dark:text-amber-400"
                  : "text-red-600 dark:text-red-400"
              }`}
            >
              {statusText} · {t.editor.retrySave}
            </button>
          ) : (
            <span
              className={`shrink-0 text-xs ${
                status === "conflict"
                  ? "text-red-600 dark:text-red-400"
                  : "text-neutral-400"
              }`}
            >
              {statusText}
            </span>
          ))}
        <DocumentFindBar
          editor={editor}
          title={title}
          editorRootRef={editorRootRef}
        />
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
            {themeCSS && <style data-koinote-document-theme>{themeCSS}</style>}
            <div
              data-koinote-print-source
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
      {tableContextMenu && tableContextMenuItems && (
        <ContextMenu
          x={tableContextMenu.x}
          y={tableContextMenu.y}
          items={tableContextMenuItems}
          onClose={closeTableContextMenu}
          ariaLabel={t.editor.toolbar.tableActions}
        />
      )}
      <TableContextToolbar editor={editor} />
    </div>
  );
}
