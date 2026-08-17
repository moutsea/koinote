import { koinoteImageObjectKey } from "../components/editor/imageLoading";

export const DESKTOP_LOCAL_IMAGE_PREFIX = "koinote-local-image://";
export const DESKTOP_IMAGE_UPLOADED_EVENT = "koinote:desktop-image-uploaded";
export const DESKTOP_IMAGE_UPLOAD_FAILED_EVENT = "koinote:desktop-image-upload-failed";
export const DESKTOP_IMAGE_MAPPING_META = "koinote:desktop-image-mapping";

const LOCAL_IMAGE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function desktopLocalImageURL(imageID: string): string {
  if (!LOCAL_IMAGE_ID_PATTERN.test(imageID)) {
    throw new Error("invalid_local_image_id");
  }
  return `${DESKTOP_LOCAL_IMAGE_PREFIX}${imageID.toLowerCase()}`;
}

export function desktopLocalImageID(source: string): string | null {
  const value = source.trim();
  if (!value.startsWith(DESKTOP_LOCAL_IMAGE_PREFIX)) return null;
  const imageID = value.slice(DESKTOP_LOCAL_IMAGE_PREFIX.length);
  return LOCAL_IMAGE_ID_PATTERN.test(imageID) ? imageID.toLowerCase() : null;
}

export function isDesktopLocalImageURL(source: string): boolean {
  return desktopLocalImageID(source) !== null;
}

export function isRemoteHTTPImageSource(source: string): boolean {
  return /^(?:https?:|[\\/]{2})/i.test(source.trim());
}

export function imageObjectKeyFromSource(source: string): string | null {
  return koinoteImageObjectKey(source);
}

export function replaceDesktopLocalImageURLs(
  content: string,
  replacements: ReadonlyMap<string, string>,
): string {
  let output = content;
  for (const [localURL, remoteURL] of replacements) {
    if (!isDesktopLocalImageURL(localURL) || !remoteURL) continue;
    output = output.split(localURL).join(remoteURL);
  }
  return output;
}
