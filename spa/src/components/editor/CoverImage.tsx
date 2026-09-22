import { useEffect, useState, type CSSProperties } from "react";
import { Loader2 } from "lucide-react";
import { useI18n } from "../../i18n";
import { desktopAPIOrigin, isDesktopRuntime } from "../../desktop/runtime";
import { imageURLForAttempt } from "./imageLoading";

export function CoverImage({
  source,
  alt,
  className,
  style,
}: {
  source: string;
  alt: string;
  className?: string;
  style?: CSSProperties;
}) {
  const { t } = useI18n();
  const [image, setImage] = useState({ source: "", resolved: "", failed: false });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setAttempt(0);
    setImage({ source, resolved: "", failed: false });
    const resolve = async () => {
      if (!isDesktopRuntime()) return source;
      const { desktopResolveImageSource } = await import("../../desktop/offlineStore");
      return desktopResolveImageSource(source);
    };
    void resolve()
      .then((resolved) => {
        if (!cancelled) setImage({ source, resolved: resolved ?? "", failed: !resolved });
      })
      .catch(() => {
        if (!cancelled) setImage({ source, resolved: "", failed: true });
      });
    return () => { cancelled = true; };
  }, [source]);

  const current = image.source === source;
  if (!current || !image.resolved || image.failed) {
    return (
      <div className={`${className ?? ""} flex min-h-24 items-center justify-center gap-2 bg-black/5 p-3 text-center text-xs text-neutral-500 dark:bg-white/5`} style={style} role="img" aria-label={alt}>
        {current && image.failed ? t.editor.wechatCoverImageFailed : <Loader2 className="h-4 w-4 animate-spin" />}
      </div>
    );
  }

  const displayURL = imageURLForAttempt(image.resolved, attempt, isDesktopRuntime() ? desktopAPIOrigin() : undefined);
  const src = isDesktopRuntime() && displayURL.startsWith("/")
    ? new URL(displayURL, desktopAPIOrigin()).toString()
    : displayURL;
  return (
    <img
      src={src}
      alt={alt}
      className={className}
      style={style}
      onError={() => {
        if (attempt === 0 && !/^(?:data|blob):/i.test(src)) setAttempt(1);
        else setImage((currentImage) => ({ ...currentImage, failed: true }));
      }}
    />
  );
}
