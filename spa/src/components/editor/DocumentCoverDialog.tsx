import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ImagePlus, Loader2, Lock, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  AGENT_CREDITS_QUERY_KEY,
  ApiError,
  WECHAT_COVER_RATIO_PRESETS,
  generateWechatCover,
  uploadImage,
  type WechatCoverMode,
  type WechatCoverRatio,
  type WechatGeneratedCover,
} from "../../api";
import { useI18n } from "../../i18n";
import { pushModal } from "../../modalStack";
import { CoverImage } from "./CoverImage";
import { dataUriToFile } from "./rehost";
import { createDefaultWechatCover } from "./wechatCover";
import { isValidCoverRatio } from "./coverRatio";

export type DocumentCoverState = {
  coverMode: WechatCoverMode;
  coverRatio: WechatCoverRatio;
  coverImageSource: string;
  coverPrompt: string;
};

type ArticleImage = { src: string; alt: string };

export function DocumentCoverDialog({
  title,
  member,
  articleImages,
  initial,
  purpose = "document",
  onSave,
  onClose,
}: {
  title: string;
  member: boolean;
  articleImages: ArticleImage[];
  initial: DocumentCoverState;
  purpose?: "document" | "wechat-draft";
  onSave: (next: DocumentCoverState) => Promise<void> | void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<WechatCoverMode>(initial.coverMode);
  const initialRatio = isValidCoverRatio(initial.coverRatio) ? initial.coverRatio : "2.35:1";
  const [ratio, setRatio] = useState(initialRatio);
  const [customRatio, setCustomRatio] = useState(initialRatio);
  const [selectedImageSource, setSelectedImageSource] = useState(
    initial.coverMode === "article" && initial.coverImageSource
      ? initial.coverImageSource
      : articleImages[0]?.src || "",
  );
  const [prompt, setPrompt] = useState(initial.coverPrompt || "");
  const [defaultCover, setDefaultCover] = useState<WechatGeneratedCover | null>(null);
  const [cover, setCover] = useState<WechatGeneratedCover | null>(null);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const savingRef = useRef(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const releaseModal = pushModal();
    const previousFocus = document.activeElement;
    dialogRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!savingRef.current) closeRef.current();
      }
      if (event.key === "Tab") {
        const elements = dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        );
        const first = elements?.[0];
        const last = elements?.[elements.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
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
      window.removeEventListener("keydown", onKey, true);
      abortRef.current?.abort();
      releaseModal();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  const availableImages = useMemo(() => {
    if (initial.coverMode !== "article" || !initial.coverImageSource || articleImages.some((image) => image.src === initial.coverImageSource)) return articleImages;
    return [{ src: initial.coverImageSource, alt: t.editor.wechatCoverPreview }, ...articleImages];
  }, [articleImages, initial.coverImageSource, initial.coverMode, t.editor.wechatCoverPreview]);
  const validArticleSource = availableImages.some((image) => image.src === selectedImageSource);
  useEffect(() => {
    if (mode !== "default") return;
    let cancelled = false;
    setDefaultCover(null);
    void createDefaultWechatCover(title, ratio)
      .then((result) => {
        if (cancelled) return;
        setDefaultCover(result);
        if (!result) setError(t.editor.wechatCoverGenerateFailed);
      })
      .catch(() => { if (!cancelled) setError(t.editor.wechatCoverGenerateFailed); });
    return () => { cancelled = true; };
  }, [mode, ratio, t.editor.wechatCoverGenerateFailed, title]);

  function chooseRatio(next: string) {
    const value = next.trim();
    if (!isValidCoverRatio(value) || value === ratio) return;
    setRatio(value);
    setCustomRatio(value);
    setDefaultCover(null);
  }

  async function generate() {
    if (!member || !prompt.trim() || abortRef.current || savingRef.current) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setGenerating(true);
    setError(null);
    try {
      const result = await generateWechatCover(prompt.trim(), ratio, controller.signal);
      if (controller.signal.aborted) return;
      setCover(result.cover);
      void queryClient.invalidateQueries({ queryKey: AGENT_CREDITS_QUERY_KEY });
    } catch (caught) {
      if (!controller.signal.aborted) {
        const code = caught instanceof ApiError ? caught.code : undefined;
        setError((code && t.errors[code]) || t.editor.wechatCoverGenerateFailed);
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setGenerating(false);
    }
  }

  const generatedCover = mode === "default" ? defaultCover : mode === "ai" ? cover : null;
  const selectedSource = mode === "article"
    ? selectedImageSource
    : generatedCover
        ? `data:${generatedCover.mimeType};base64,${generatedCover.base64}`
        : mode === "ai" && initial.coverMode === "ai" ? initial.coverImageSource : "";
  const canSave = Boolean(selectedSource) && (mode !== "article" || validArticleSource);

  async function save() {
    if (savingRef.current || generating || !canSave) return;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      let imageSource = selectedSource;
      if (purpose === "document" && generatedCover && selectedSource.startsWith("data:")) {
        const file = dataUriToFile(selectedSource);
        if (!file) throw new Error(t.editor.wechatCoverGenerateFailed);
        imageSource = (await uploadImage(file, "persistent")).url;
      }
      await onSave({
        coverMode: mode,
        coverRatio: ratio,
        coverImageSource: imageSource,
        coverPrompt: mode === "ai" ? prompt.trim() : "",
      });
      onClose();
    } catch (caught) {
      const code = caught instanceof ApiError ? caught.code : undefined;
      setError((code && t.errors[code]) || t.editor.wechatCoverGenerateFailed);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  const controlsDisabled = saving || generating;
  const coverOptions: Array<{ value: WechatCoverMode; label: string; hint: string }> = [
    { value: "default", label: t.editor.wechatCoverDefault, hint: t.editor.wechatCoverDefaultHint },
    { value: "article", label: t.editor.wechatCoverArticle, hint: t.editor.wechatCoverArticleHint },
    { value: "ai", label: t.editor.wechatCoverAi, hint: t.editor.wechatCoverAiHint },
  ];

  return createPortal(
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 px-4 py-6"
      role="presentation"
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <div ref={dialogRef} tabIndex={-1} className="max-h-full w-full max-w-lg overflow-y-auto rounded-2xl border border-black/10 bg-[var(--background)] p-5 shadow-2xl outline-none dark:border-white/15" role="dialog" aria-modal="true" aria-labelledby="document-cover-title">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 id="document-cover-title" className="text-base font-semibold">{t.editor.wechatCoverTitle}</h2>
            <p className="mt-1 text-xs text-neutral-400">{title || t.editor.titlePlaceholder}</p>
          </div>
          <button type="button" onClick={onClose} disabled={saving} aria-label={t.editor.shareClose} className="rounded-lg p-1.5 text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10"><X className="h-4 w-4" /></button>
        </div>
        {purpose === "wechat-draft" && <p className="mt-3 text-xs leading-relaxed text-neutral-500">{t.editor.wechatCoverDraftOnly}</p>}
        <div role="radiogroup" aria-label={t.editor.wechatCoverModeLabel} className="mt-4 grid grid-cols-3 gap-1.5">
          {coverOptions.map((option) => {
            const locked = option.value === "ai" && !member;
            return (
              <button key={option.value} type="button" role="radio" aria-checked={mode === option.value} disabled={locked || controlsDisabled} onClick={() => { setMode(option.value); setError(null); }} className={`rounded-lg border px-2.5 py-2 text-left transition disabled:opacity-50 ${mode === option.value ? "border-emerald-500/60 bg-emerald-500/10" : "border-black/10 hover:bg-black/[0.03] dark:border-white/10 dark:hover:bg-white/5"}`}>
                <span className="flex items-center gap-1 text-[11px] font-semibold">{option.label}{locked && <Lock className="h-3 w-3" />}</span>
                <span className="mt-0.5 block text-[10px] leading-4 text-neutral-400">{locked ? t.editor.wechatOfficialMembersOnly : option.hint}</span>
              </button>
            );
          })}
        </div>
        <div className="mt-4">
          <span className="text-[11px] text-neutral-400">{t.editor.wechatCoverRatio}</span>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {WECHAT_COVER_RATIO_PRESETS.map((value) => (
              <button key={value} type="button" disabled={controlsDisabled} onClick={() => chooseRatio(value)} className={`rounded-md px-2 py-1 text-[11px] ${ratio === value ? "bg-emerald-600 text-white" : "bg-black/5 text-neutral-500 dark:bg-white/10"}`}>{value}</button>
            ))}
            <input value={customRatio} onChange={(event) => setCustomRatio(event.target.value)} onBlur={() => { if (isValidCoverRatio(customRatio.trim())) chooseRatio(customRatio); else setCustomRatio(ratio); }} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); chooseRatio(customRatio); } }} aria-label={t.editor.wechatCoverRatio} placeholder="W:H" disabled={controlsDisabled} className="w-16 rounded-md border border-black/10 bg-transparent px-2 py-1 text-[11px] outline-none focus:border-emerald-500/50 dark:border-white/10" />
          </div>
        </div>
        {mode === "article" && (
          availableImages.length === 0 ? <p className="mt-4 rounded-lg bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">{t.editor.wechatCoverArticleEmpty}</p> :
            <div className="mt-4 grid grid-cols-3 gap-1.5">
              {availableImages.map((image, index) => (
                <button key={`${image.src}-${index}`} type="button" disabled={controlsDisabled} aria-pressed={selectedImageSource === image.src} onClick={() => setSelectedImageSource(image.src)} className={`overflow-hidden rounded-lg border ${selectedImageSource === image.src ? "border-emerald-500 ring-2 ring-emerald-500/20" : "border-black/10 dark:border-white/10"}`}>
                  <CoverImage source={image.src} alt={image.alt || `${t.editor.wechatCoverArticle} ${index + 1}`} className="block w-full object-cover" style={{ aspectRatio: ratio.replace(":", " / ") }} />
                  <span className="block truncate px-1.5 py-1 text-[10px] text-neutral-500">{image.alt || `${t.editor.wechatCoverArticle} ${index + 1}`}</span>
                </button>
              ))}
            </div>
        )}
        {mode === "ai" && (
          <>
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} disabled={!member || controlsDisabled} rows={3} maxLength={1200} placeholder={t.editor.wechatCoverPromptPlaceholder} className="mt-4 w-full resize-y rounded-lg border border-black/10 bg-transparent px-2.5 py-2 text-xs leading-relaxed outline-none focus:border-emerald-500/50 disabled:opacity-50 dark:border-white/15" />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <button type="button" disabled={!member || controlsDisabled || !prompt.trim()} onClick={() => void generate()} className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/30 px-3 py-1.5 text-xs font-medium text-emerald-700 disabled:opacity-45 dark:text-emerald-300">{generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ImagePlus className="h-3.5 w-3.5" />}{selectedSource ? t.editor.wechatCoverRegenerate : t.editor.wechatCoverGenerate}</button>
              <span className="text-[10px] text-neutral-400">{t.editor.wechatCoverCreditCost}</span>
            </div>
          </>
        )}
        {mode !== "article" && selectedSource && <CoverImage source={selectedSource} alt={t.editor.wechatCoverPreview} className="mt-4 block w-full rounded-lg border border-black/10 object-cover dark:border-white/10" style={{ aspectRatio: ratio.replace(":", " / ") }} />}
        {mode === "default" && !selectedSource && !error && <p className="mt-3 text-xs text-neutral-400">{t.editor.wechatCoverDefaultPreview}</p>}
        {error && <p role="alert" className="mt-3 text-xs text-red-600 dark:text-red-400">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={saving} className="rounded-full px-4 py-2 text-sm text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10">{t.editor.shareClose}</button>
          <button type="button" onClick={() => void save()} disabled={controlsDisabled || !canSave} className="inline-flex items-center gap-1.5 rounded-full bg-emerald-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{saving && <Loader2 className="h-3.5 w-3.5 animate-spin" />}{purpose === "wechat-draft" ? t.editor.wechatCoverUse : t.editor.wechatCoverSave}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
