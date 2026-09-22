import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Editor } from "@tiptap/react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  Code2,
  Download,
  FileDown,
  FileText,
  FileType,
  Cloud,
  ExternalLink,
  X,
  MessageSquare,
} from "lucide-react";
import { useI18n } from "../../i18n";
import {
  exportHTML,
  exportMarkdown,
  exportPDF,
  saveExportBlob,
  safeFilename,
} from "./exportDocument";
import { MediaExportDialog } from "./WechatDialog";
import {
  ApiError,
  getWechatOfficialAccounts,
  getMediaPlatformSettings,
  MEDIA_PLATFORM_SETTINGS_QUERY_KEY,
  prepareWechatDraftDocument,
  trackProductEvent,
  type CustomMediaPlatform,
  type WechatOfficialAccount,
} from "../../api";
import type { MediaPlatform } from "./mediaExportStrategy";
import {
  feishuErrorText,
  getFeishuAccount,
  syncFeishuDocument,
  type FeishuSyncResult,
} from "../../feishu";
import { useDesktopMenuActions } from "../../desktop/menu";
import { isDesktopRuntime } from "../../desktop/runtime";

function exportErrorText(
  error: unknown,
  fallback: string,
  errors: Record<string, string>,
): string {
  const code =
    error instanceof ApiError
      ? error.code
      : typeof error === "string"
        ? error
        : error instanceof Error
          ? error.message
          : "";
  return (code && errors[code]) || fallback;
}

export function ExportMenu({
  editor,
  docId,
  title,
  coverImageSource,
  themeId,
  member,
  localMode,
  onBeforeExternalExport,
}: {
  editor: Editor | null;
  docId: string;
  title: string;
  coverImageSource?: string;
  /** 文档当前的排版主题，微信导出直接用它 —— 不在导出弹窗里二次选择 */
  themeId: string;
  member: boolean;
  localMode: boolean;
  onBeforeExternalExport: () => Promise<boolean>;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);
  const [wechatDraftOpen, setWechatDraftOpen] = useState(false);
  const [wechatAccounts, setWechatAccounts] = useState<WechatOfficialAccount[]>(
    [],
  );
  const [wechatDraftOpening, setWechatDraftOpening] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feishuResult, setFeishuResult] = useState<FeishuSyncResult | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const busyRef = useRef(false);
  const mediaSettingsQuery = useQuery({
    queryKey: MEDIA_PLATFORM_SETTINGS_QUERY_KEY,
    queryFn: getMediaPlatformSettings,
    enabled: !localMode,
    retry: false,
  });
  const enabledPlatforms: MediaPlatform[] | undefined = mediaSettingsQuery.data
    ? [
        ...(mediaSettingsQuery.data.settings.wechatEnabled ? ["wechat" as const] : []),
        ...(mediaSettingsQuery.data.settings.zhihuEnabled ? ["zhihu" as const] : []),
        ...(mediaSettingsQuery.data.settings.xEnabled ? ["x" as const] : []),
      ]
    : undefined;
  const customPlatforms: CustomMediaPlatform[] =
    mediaSettingsQuery.data?.customPlatforms.filter((item) => item.enabled) ?? [];
  const showMediaExport =
    !mediaSettingsQuery.isSuccess ||
    (enabledPlatforms?.length ?? 0) > 0 ||
    customPlatforms.length > 0;

  useDesktopMenuActions((action) => {
    if (action === "export-markdown") runMarkdownExport();
    if (action === "export-html") runHTMLExport();
    if (action === "export-docx") runDOCXExport();
    if (action === "export-pdf") runPDFExport();
    if (action === "export-media" && showMediaExport && editor && !busyRef.current) {
      setOpen(false);
      setMediaOpen(true);
    }
  });

  // 点外部或按 Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("click", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  async function run(
    kind: string,
    action: () => void | boolean | Promise<void | boolean>,
  ) {
    setError(null);
    setFeishuResult(null);
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(kind);
    try {
      const completed = await action();
      if (completed !== false) {
        void trackProductEvent("first_export").catch(() => undefined);
      }
      setOpen(false);
    } catch (caught) {
      setOpen(false);
      // 导出失败必须显形，静默失败会让用户以为文件已经下载了
      setError(
        kind === "feishu"
          ? feishuErrorText(caught, t.feishu)
          : exportErrorText(caught, t.editor.exportFailed, t.errors),
      );
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  }

  function runFeishuSync() {
    if (localMode) return;
    if (!member) {
      setOpen(false);
      void navigate({ to: "/pricing" });
      return;
    }
    void run("feishu", async () => {
      const saved = await onBeforeExternalExport();
      if (saved === false) {
        throw new ApiError(409, "Document save required", "feishu_save_required");
      }
      const account = await getFeishuAccount();
      if (!account.configured) {
        throw new ApiError(503, "Feishu not configured", "feishu_not_configured");
      }
      if (!account.account) {
        await navigate({ to: "/settings", search: { section: "feishu" } });
        return false;
      }
      const result = await syncFeishuDocument(docId);
      setFeishuResult(result);
    });
  }

  function runMarkdownExport() {
    if (!editor) return;
    void run("md", () => exportMarkdown(editor, title, t.editor.untitled));
  }

  function runHTMLExport() {
    if (!editor) return;
    void run("html", () => exportHTML(editor, title, t.editor.untitled));
  }

  function runDOCXExport() {
    if (!editor) return;
    void run("docx", async () => {
      // 只动态引入 exportDocx（docx 库约 1 MB，不该压在编辑器首屏）。
      // exportDocument 已静态引入，再动态引一次拆不出 chunk，只会让
      // Rollup 报警。
      const { buildDocx } = await import("./exportDocx");
      const blob = await buildDocx(editor, title, {
        imageFailed: t.editor.exportFailed,
      });
      return saveExportBlob(
        blob,
        `${safeFilename(title, t.editor.untitled)}.docx`,
        "docx",
      );
    });
  }

  function runPDFExport() {
    if (!editor) return;
    const printSource = containerRef.current
      ?.closest<HTMLElement>("[data-koinote-editor-instance]")
      ?.querySelector<HTMLElement>("[data-koinote-print-source]");
    void run("pdf", () => {
      if (!printSource) throw new Error("pdf_export_source_missing");
      return exportPDF(printSource, title, t.editor.untitled);
    });
  }

  async function openWechatDraft(): Promise<string | undefined> {
    setOpen(false);
    if (!member) {
      await navigate({ to: "/pricing" });
      return undefined;
    }
    if (localMode || wechatDraftOpening) return undefined;
    setError(null);
    setWechatDraftOpening(true);
    try {
      const result = await getWechatOfficialAccounts();
      if (result.accounts.length === 0) {
        await navigate({ to: "/settings", search: { section: "wechat" } });
        return undefined;
      }
      if (!(await onBeforeExternalExport())) return t.editor.saveFailed;
      await prepareWechatDraftDocument(docId);
      setWechatAccounts(result.accounts);
      setMediaOpen(false);
      setWechatDraftOpen(true);
    } catch (caught) {
      // 只把错误交回调用方（导出弹窗）显示。菜单自己的浮层是 z-40，会被弹窗的
      // 半透明遮罩压成一个发暗的红框，而且关窗后还留着不清
      return exportErrorText(caught, t.editor.wechatAccountLoadFailed, t.errors);
    } finally {
      setWechatDraftOpening(false);
    }
  }

  if (!editor) return null;

  return (
    <div ref={containerRef} className="relative shrink-0">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setError(null);
          setFeishuResult(null);
          setOpen((v) => !v);
        }}
        title={t.editor.exportLabel}
        aria-label={t.editor.exportLabel}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex h-7 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-neutral-400 transition hover:bg-black/5 hover:text-neutral-700 dark:hover:bg-white/10 dark:hover:text-neutral-200"
      >
        <Download className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">{t.editor.exportLabel}</span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-9 z-40 w-72 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-black/10 bg-[var(--background)] py-1 shadow-lg dark:border-white/15"
        >
          <Item
            icon={<FileText className="h-3.5 w-3.5" />}
            label={t.editor.exportMarkdown}
            busy={busy === "md"}
            disabled={busy !== null}
            onClick={runMarkdownExport}
          />
          <Item
            icon={<Code2 className="h-3.5 w-3.5" />}
            label={t.editor.exportHTML}
            busy={busy === "html"}
            disabled={busy !== null}
            onClick={runHTMLExport}
          />
          <Item
            icon={<FileType className="h-3.5 w-3.5" />}
            label={t.editor.exportDOCX}
            busy={busy === "docx"}
            disabled={busy !== null}
            onClick={runDOCXExport}
          />
          <Item
            icon={<FileDown className="h-3.5 w-3.5" />}
            label={t.editor.exportPDF}
            hint={t.editor.exportPrintHint}
            busy={busy === "pdf"}
            disabled={busy !== null}
            onClick={runPDFExport}
          />
          {!localMode && (
            <Item
              icon={<Cloud className="h-3.5 w-3.5" />}
              label={t.feishu.sync}
              hint={member ? t.feishu.syncHint : t.feishu.membersOnly}
              busy={busy === "feishu"}
              busyLabel={t.feishu.syncing}
              disabled={busy !== null}
              onClick={runFeishuSync}
            />
          )}
          {showMediaExport && (
            <Item
              icon={<MessageSquare className="h-3.5 w-3.5" />}
              label={t.editor.mediaExport}
              hint={t.editor.mediaExportHint}
              disabled={busy !== null}
              onClick={() => {
                setOpen(false);
                setMediaOpen(true);
              }}
            />
          )}
        </div>
      )}

      {feishuResult && (
        <div
          role="status"
          className="absolute right-0 top-9 z-40 w-72 max-w-[calc(100vw-2rem)] rounded-lg bg-emerald-50 px-3 py-2 text-xs text-emerald-700 shadow dark:bg-emerald-950 dark:text-emerald-300"
        >
          <div className="flex items-center justify-between gap-2">
            <p>{feishuResult.created ? t.feishu.created : t.feishu.updated}</p>
            <button type="button" aria-label={t.feishu.close} onClick={() => setFeishuResult(null)} className="rounded p-1 hover:bg-black/5 dark:hover:bg-white/10"><X className="h-3.5 w-3.5" /></button>
          </div>
          {feishuResult.coverSyncFailed && <p className="mt-1 text-amber-700 dark:text-amber-300">{t.feishu.coverSyncFailed}</p>}
          <a
            href={feishuResult.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => {
              if (!isDesktopRuntime()) return;
              event.preventDefault();
              void import("@tauri-apps/plugin-opener")
                .then(({ openUrl }) => openUrl(feishuResult.url))
                .catch(() => {
                  setFeishuResult(null);
                  setError(t.feishu.failed);
                });
            }}
            className="mt-1 inline-flex items-center gap-1 underline"
          >
            {t.feishu.open}<ExternalLink className="h-3 w-3" />
          </a>
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="absolute right-0 top-9 z-40 w-72 max-w-[calc(100vw-2rem)] rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600 shadow dark:bg-red-950 dark:text-red-400"
        >
          {error}
        </p>
      )}

      {mediaOpen && (
        <MediaExportDialog
          editor={editor}
          docId={docId}
          title={title}
          coverImageSource={coverImageSource}
          themeId={themeId}
          member={member}
          localMode={localMode}
          enabledPlatforms={enabledPlatforms}
          customPlatforms={customPlatforms}
          onBeforeExternalExport={onBeforeExternalExport}
          onOpenWechatDraft={openWechatDraft}
          wechatDraftOpening={wechatDraftOpening}
          onClose={() => setMediaOpen(false)}
        />
      )}
      {wechatDraftOpen && (
        <MediaExportDialog
          editor={editor}
          docId={docId}
          title={title}
          coverImageSource={coverImageSource}
          themeId={themeId}
          member={member}
          localMode={localMode}
          enabledPlatforms={enabledPlatforms}
          customPlatforms={customPlatforms}
          onBeforeExternalExport={onBeforeExternalExport}
          wechatAccounts={wechatAccounts}
          draftOnly
          onClose={() => setWechatDraftOpen(false)}
        />
      )}
    </div>
  );
}

function Item({
  icon,
  label,
  hint,
  busy,
  busyLabel,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  hint?: string;
  busy?: boolean;
  busyLabel?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      role="menuitem"
      disabled={busy || disabled}
      onClick={onClick}
      className="flex w-full items-start gap-2.5 px-3 py-2 text-left transition hover:bg-black/5 disabled:opacity-60 dark:hover:bg-white/10"
    >
      <span className="mt-0.5 shrink-0 text-neutral-400">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm">
          {busy ? busyLabel ?? t.editor.exporting : label}
        </span>
        {hint && (
          <span className="mt-0.5 block text-[11px] leading-relaxed text-neutral-400">
            {hint}
          </span>
        )}
      </span>
    </button>
  );
}
