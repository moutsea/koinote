import { EditorContent, useEditor } from "@tiptap/react";
import { Check, Copy, RefreshCw, ScanLine, UploadCloud } from "lucide-react";
import { Fragment, useRef } from "react";
import { agentWorkspaceReadmeExtensions } from "../agentWorkspaceReadmeExtensions";
import { useI18n } from "../i18n";

type Props = {
  content: string | null;
  loading: boolean;
  failed: boolean;
  copying: boolean;
  copied: boolean;
  uploading: boolean;
  promptError: boolean;
  promptErrorMessage?: string | null;
  uploadError: boolean;
  uploadErrorMessage?: string | null;
  uploadSuccess: boolean;
  scanningLocal: boolean;
  scanError: boolean;
  scanErrorMessage?: string | null;
  canScanLocal: boolean;
  onCopy: () => void;
  onImport: (files: File[]) => void;
  onScanLocal: () => void;
  onRetry: () => void;
};

export function AgentWorkspaceReadme(props: Props) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="border-t" style={{ borderColor: "var(--ink-line)" }}>
      <div className="px-5 py-5 sm:px-6" style={{ background: "var(--ink-wash)" }}>
        <p className="text-xs" style={{ color: "var(--ink-faint)" }}>{t.agentWorkspace.readmeDescription}</p>
      </div>
      <div className="px-5 py-6 sm:px-6" style={{ color: "var(--ink-mid)" }}>
        {props.loading ? <p className="text-sm">{t.agentWorkspace.loading}</p> : props.failed ? <div role="alert" className="text-sm"><p>{t.agentWorkspace.readmeLoadFailed}</p><button type="button" onClick={props.onRetry} className="mt-2 underline">{t.agentWorkspace.refresh}</button></div> : props.content !== null ? <ReadmeDocument content={props.content} inputRef={inputRef} props={props} /> : null}
      </div>
    </div>
  );
}

function ReadmeDocument({ content, inputRef, props }: { content: string; inputRef: React.RefObject<HTMLInputElement | null>; props: Props }) {
  const { t } = useI18n();
  const sections = splitReadmeSections(content);
  const hasClientSection = sections.some((section) => section.action === "client");
  const hasCopySection = sections.some((section) => section.action === "copy");
  const hasImportSection = sections.some((section) => section.action === "import");
  return <>
    {!hasClientSection && props.canScanLocal && <ReadmeAction action="client" inputRef={inputRef} props={props} t={t} />}
    {sections.map((section, index) => <Fragment key={`${section.action ?? "text"}-${index}`}>
      <ReadmePreview content={section.content} />
      {section.action === "client" && props.canScanLocal && <ReadmeAction action="client" inputRef={inputRef} props={props} t={t} />}
      {section.action === "copy" && <ReadmeAction action="copy" inputRef={inputRef} props={props} t={t} />}
      {section.action === "import" && <ReadmeAction action="import" inputRef={inputRef} props={props} t={t} />}
    </Fragment>)}
    {!hasCopySection && <ReadmeAction action="copy" inputRef={inputRef} props={props} t={t} />}
    {!hasImportSection && <ReadmeAction action="import" inputRef={inputRef} props={props} t={t} />}
  </>;
}

function ReadmeAction({ action, inputRef, props, t }: { action: "client" | "copy" | "import"; inputRef: React.RefObject<HTMLInputElement | null>; props: Props; t: ReturnType<typeof useI18n>["t"] }) {
  return <div className="my-6 rounded-xl border px-4 py-4" style={{ borderColor: "var(--ink-line)", background: "var(--ink-wash)" }}>
    {action === "copy" ? <button type="button" onClick={props.onCopy} disabled={props.copying || props.uploading} className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50" style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}>
      {props.copying ? <RefreshCw className="h-4 w-4 animate-spin" /> : props.copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
      {props.copied ? t.agentWorkspace.copied : t.agentWorkspace.copyPrompt}
    </button> : action === "client" ? <button type="button" onClick={props.onScanLocal} disabled={props.uploading || props.scanningLocal} className="inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50" style={{ background: "var(--ink-strong)", color: "var(--ink-paper)" }}>
      {props.scanningLocal ? <RefreshCw className="h-4 w-4 animate-spin" /> : <ScanLine className="h-4 w-4" />}
      {t.agentWorkspace.scanLocal}
    </button> : <>
      <button type="button" onClick={() => inputRef.current?.click()} disabled={props.uploading || props.scanningLocal} className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm disabled:opacity-50" style={{ borderColor: "var(--ink-line)", color: "var(--ink-mid)" }}>
        {props.uploading ? <RefreshCw className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
        {t.agentWorkspace.importFolder}
      </button>
      <input ref={inputRef} type="file" multiple hidden disabled={props.uploading || props.scanningLocal} {...({ webkitdirectory: "", directory: "" } as Record<string, string>)} onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; if (files.length > 0 && !props.uploading && !props.scanningLocal) props.onImport(files); }} />
    </>}
    {action === "copy" && props.promptError && <p role="alert" className="mt-3 text-sm" style={{ color: "var(--cinnabar)" }}>{props.promptErrorMessage || t.agentWorkspace.promptFailed}</p>}
    {(action === "client" || action === "import") && props.uploadError && <p role="alert" className="mt-3 text-sm" style={{ color: "var(--cinnabar)" }}>{props.uploadErrorMessage || t.agentWorkspace.saveFailed}</p>}
    {(action === "client" || action === "import") && props.scanError && <p role="alert" className="mt-3 text-sm" style={{ color: "var(--cinnabar)" }}>{props.scanErrorMessage || t.agentWorkspace.scanLocalFailed}</p>}
    {(action === "client" || action === "import") && props.uploadSuccess && <p role="status" className="mt-3 text-sm" style={{ color: "var(--ink-strong)" }}>{t.agentWorkspace.saved}</p>}
  </div>;
}

function splitReadmeSections(content: string): Array<{ content: string; action?: "client" | "copy" | "import" }> {
  const lines = content.split("\n");
  const starts = lines.reduce<number[]>((result, line, index) => { if (/^##\s+/.test(line)) result.push(index); return result; }, []);
  if (starts.length === 0) return [{ content }];
  const boundaries = [0, ...starts, lines.length];
  return boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1];
    const section = lines.slice(start, end).join("\n");
    const heading = lines[start] ?? "";
    const action = isClientSection(heading) ? "client" : isCopySection(heading) ? "copy" : isImportSection(heading) ? "import" : undefined;
    return { content: section, action };
  });
}

function isClientSection(heading: string) {
  return ["Recommended: one-click upload from the desktop app", "首选方式：通过客户端一键上传", "Méthode recommandée : import en un clic depuis l’application de bureau", "おすすめ：デスクトップアプリからワンクリックでアップロード"].some((value) => heading.includes(value));
}

function isCopySection(heading: string) {
  return ["Alternative: connect an Agent through MCP", "备选方式：通过 MCP 连接 Agent", "Alternative : connecter un Agent via MCP", "代替方法：MCP で Agent を接続", "The easiest way to get started", "最简单的开始方式", "Le moyen le plus simple de commencer", "まず始める方法", "使用 AI Agent 开始", "Commencer avec un Agent IA", "AI Agent で始める"].some((value) => heading.includes(value));
}

function isImportSection(heading: string) {
  return ["Import a folder manually", "手动导入文件夹", "Importer un dossier manuellement", "フォルダーを手動で取り込む", "Upload your files manually", "手动上传文件", "Importer vos fichiers", "ファイルを手動でアップロードする", "Import Skills and Agent settings", "Importer des Skills et réglages Agent", "Skills と Agent 設定を取り込む"].some((value) => heading.includes(value));
}

function ReadmePreview({ content }: { content: string }) {
  const editor = useEditor({
    extensions: agentWorkspaceReadmeExtensions(),
    content,
    editable: false,
    injectCSS: false,
    editorProps: { attributes: { class: "prose prose-sm max-w-none break-words dark:prose-invert prose-headings:text-[var(--ink-strong)] prose-p:text-[var(--ink-mid)] prose-pre:overflow-x-auto" } },
  }, [content]);
  return <EditorContent editor={editor} />;
}
