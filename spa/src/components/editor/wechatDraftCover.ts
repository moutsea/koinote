import type { DocumentCoverState } from "./DocumentCoverDialog";
import { isDesktopRuntime } from "../../desktop/runtime";
import { isDesktopLocalImageURL } from "../../desktop/offlineImagesCore";
import { ApiError } from "../../api";
import { KOINOTE_IMAGE_ORIGIN, koinoteImageObjectKey } from "./imageLoading";

export async function wechatDraftCoverInput(cover: DocumentCoverState) {
  let source = cover.coverImageSource.trim();
  if (!source) return {};
  if (isDesktopLocalImageURL(source)) {
    const resolved = isDesktopRuntime()
      ? await (await import("../../desktop/offlineStore")).desktopResolveImageSource(source)
      : null;
    if (!resolved) throw new ApiError(400, "Cover image is unavailable", "wechat_cover_input_invalid");
    source = resolved;
  }
  const objectKey = source.startsWith("/images/") ? koinoteImageObjectKey(source) : null;
  if (objectKey) source = `${KOINOTE_IMAGE_ORIGIN}/${objectKey}`;
  return {
    coverMode: cover.coverMode,
    coverRatio: cover.coverRatio,
    coverImageSource: source,
  };
}
