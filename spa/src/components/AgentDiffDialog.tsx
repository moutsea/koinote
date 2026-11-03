import { Fragment, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { useI18n } from "../i18n";
import { agentPanelText } from "../i18n/agentPanel";
import { pushModal } from "../modalStack";
import { jsx, jsxs } from "react/jsx-runtime";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import type { RootContent } from "hast";
import { defaultUrlTransform, type Components } from "react-markdown";
import { renderMathInElement } from "./editor/renderMath";
import { articleChanges } from "./agentArticleChanges";
import { desktopAPIOrigin, isDesktopRuntime } from "../desktop/runtime";
import { imageURLForAttempt } from "./editor/imageLoading";

function PreviewImage({ src, alt = "", title, width, height }: {
  src: string; alt?: string; title?: string; width?: string | number; height?: string | number;
}) {
  const { t } = useI18n();
  const desktop = isDesktopRuntime();
  const [resolved, setResolved] = useState(desktop ? "" : src);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!desktop) return;
    let active = true;
    void import("../desktop/offlineStore")
      .then(({ desktopResolveImageSource }) => desktopResolveImageSource(src))
      .then((value) => {
        if (active) { setResolved(value ?? ""); setFailed(!value); }
      })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [src, desktop]);
  if (failed || !resolved) return <span className="agent-preview-image-placeholder" role="img" aria-label={alt}>
    {failed ? t.editor.wechatCoverImageFailed : t.editor.loading}{alt && ` · ${alt}`}
  </span>;
  const source = imageURLForAttempt(resolved, attempt, desktop ? desktopAPIOrigin() : undefined);
  const displayURL = desktop && source.startsWith("/") ? new URL(source, desktopAPIOrigin()).toString() : source;
  return <img src={displayURL} alt={alt} title={title} width={width} height={height}
    loading="lazy" decoding="async" referrerPolicy="no-referrer"
    onError={() => {
      if (attempt === 0 && !/^(?:data|blob):/i.test(displayURL)) setAttempt(1);
      else setFailed(true);
    }} />;
}

const previewComponents: Components = {
  img: ({ src, alt, title, width, height }) => typeof src === "string" && src
    ? <PreviewImage key={src} src={defaultUrlTransform(src)} alt={alt} title={title} width={width} height={height} /> : <span>{alt}</span>,
  a: ({ href, children }) => <a href={href && defaultUrlTransform(href)} target="_blank" rel="noopener noreferrer">{children}</a>,
  source: () => null,
  table: ({ children }) => <div className="agent-preview-table"><table>{children}</table></div>,
};

function Blocks({ nodes }: { nodes: RootContent[] }) {
  return toJsxRuntime({ type: "root", children: nodes }, { Fragment, jsx, jsxs, components: previewComponents });
}

function ArticlePreview({ beforeTitle, beforeContent, afterTitle, afterContent }: {
  beforeTitle: string; beforeContent: string; afterTitle: string; afterContent: string;
}) {
  const { locale } = useI18n();
  const labels = agentPanelText[locale];
  const runs = useMemo(() => articleChanges(beforeTitle, beforeContent, afterTitle, afterContent),
    [beforeTitle, beforeContent, afterTitle, afterContent]);
  const article = useRef<HTMLElement>(null);
  useEffect(() => { if (article.current) renderMathInElement(article.current); }, [runs]);
  return <article ref={article} className="agent-article-preview prose prose-sm dark:prose-invert">
    {runs.every(run => run.kind === "equal") && <p className="agent-change-label">{labels.noVisibleChanges}</p>}
    {runs.map((run, index) => {
      if (run.kind === "equal") return <Blocks key={index} nodes={run.blocks} />;
      const kind = run.before.length === 0 ? "added" : run.after.length === 0 ? "removed" : "modified";
      return <div key={index} className="agent-article-change" data-change={kind}>
        {kind === "added"
          ? <p className="agent-change-label">{labels.addedPassage}</p>
          : <details className="agent-original-passage">
              <summary className="agent-change-label">{kind === "removed" ? labels.removedPassage : labels.modifiedPassage}</summary>
              <div className="agent-old-text"><Blocks nodes={run.before} /></div>
            </details>}
        {run.after.length > 0 && <Blocks nodes={run.after} />}
      </div>;
    })}
  </article>;
}

export function AgentDiffDialog({
  beforeTitle, afterTitle, beforeContent, afterContent, actions, error, onClose,
}: {
  beforeTitle: string;
  afterTitle: string;
  beforeContent: string;
  afterContent: string;
  actions: ReactNode;
  error?: string;
  onClose: () => void;
}) {
  const { locale, t } = useI18n();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const release = pushModal();
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    const dialog = dialogRef.current;
    document.body.style.overflow = "hidden";
    dialog?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeRef.current();
      } else if (event.key === "Tab") {
        const elements = Array.from(dialog?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), summary, a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        ) ?? []).filter((element) => element.getClientRects().length > 0);
        const first = elements[0];
        const last = elements.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      release();
      window.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = previousOverflow;
      // An action may deliberately move focus to the composer or unmount the
      // panel. Restore the trigger only when focus still belongs to this dialog.
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected &&
          (document.activeElement === document.body || dialog?.contains(document.activeElement))) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, []);

  return createPortal(
    <div className="agent-diff-backdrop" onClick={(event) => {
      event.stopPropagation();
      if (event.target === event.currentTarget) onClose();
    }}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} className="agent-diff-dialog">
        <header className="agent-diff-dialog-header">
          <div className="min-w-0">
            <h2 id={titleId}>{agentPanelText[locale].diff}</h2>
            <p className="truncate" title={afterTitle || beforeTitle}>{afterTitle || beforeTitle || t.editor.untitled}</p>
          </div>
          <button type="button" className="agent-control" aria-label={t.editor.shareClose} onClick={onClose}><X size={20} /></button>
        </header>
        <div className="agent-diff-dialog-scroll" tabIndex={0} role="region" aria-labelledby={titleId}>
          <ArticlePreview {...{ beforeTitle, beforeContent, afterTitle, afterContent }} />
        </div>
        <footer className="agent-diff-dialog-footer">
          {error && <p role="alert" className="mb-3 text-sm text-red-700 dark:text-red-300">{error}</p>}
          {actions}
        </footer>
      </div>
    </div>, document.body,
  );
}
