import { useEffect, useState } from "react";
import type { WechatCoverRatio } from "../../api";
import { useI18n } from "../../i18n";
import { desktopAPIOrigin, isDesktopRuntime } from "../../desktop/runtime";
import { imageURLForAttempt } from "./imageLoading";
import { DocTitle } from "./DocTitle";
import { parseCoverRatio } from "./coverRatio";

export function DocumentCoverPreview({
  title,
  coverRatio,
  coverImageSource,
  fallbackTitleClassName,
  onChange,
  onEnter,
  onOpenCover,
}: {
  title: string;
  coverRatio: WechatCoverRatio;
  coverImageSource: string;
  fallbackTitleClassName?: string;
  onChange: (next: string) => void;
  onEnter?: () => void;
  onOpenCover?: () => void;
}) {
  const { t } = useI18n();
  const [image, setImage] = useState({ source: "", resolved: "", failed: false });
  const [attempt, setAttempt] = useState(0);
  const source = coverImageSource.trim();

  useEffect(() => {
    if (!source || !isDesktopRuntime()) {
      setImage({ source, resolved: source, failed: false });
      setAttempt(0);
      return;
    }
    let cancelled = false;
    setImage({ source, resolved: "", failed: false });
    setAttempt(0);
    void import("../../desktop/offlineStore")
      .then(({ desktopResolveImageSource }) => desktopResolveImageSource(source))
      .then((resolved) => {
        if (!cancelled) setImage({ source, resolved: resolved ?? "", failed: !resolved });
      })
      .catch(() => {
        if (!cancelled) setImage({ source, resolved: "", failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [source]);

  const current = image.source === source;
  if (!current || !image.resolved || image.failed) {
    return (
      <div className={fallbackTitleClassName}>
        <DocTitle value={title} onChange={onChange} onEnter={onEnter} onOpenCover={onOpenCover} />
        {current && image.failed && <p role="status" className="px-2 text-xs text-neutral-500">{t.editor.wechatCoverImageFailed}</p>}
      </div>
    );
  }
  const [width, height] = parseCoverRatio(coverRatio) ?? [235, 100];
  const displayURL = imageURLForAttempt(image.resolved, attempt, isDesktopRuntime() ? desktopAPIOrigin() : undefined);
  const src = isDesktopRuntime() && displayURL.startsWith("/")
    ? new URL(displayURL, desktopAPIOrigin()).toString()
    : displayURL;

  return (
    <div
      data-koinote-document-cover
      className="relative mb-5 overflow-hidden rounded-xl border border-black/10 bg-black/[0.03] dark:border-white/10 dark:bg-white/[0.03]"
      style={{ aspectRatio: `${width} / ${height}` }}
    >
      <img
        src={src}
        onError={() => {
          if (attempt === 0 && !/^(?:data|blob):/i.test(src)) setAttempt(1);
          else setImage((previous) => ({ ...previous, failed: true }));
        }}
        alt={t.editor.wechatCoverPreview}
        className="absolute inset-0 block h-full w-full object-cover"
      />
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 via-black/45 to-transparent px-4 pb-3 pt-16 text-white">
        <DocTitle
          value={title}
          onChange={onChange}
          onEnter={onEnter}
          onOpenCover={onOpenCover}
          overlay
        />
      </div>
    </div>
  );
}
