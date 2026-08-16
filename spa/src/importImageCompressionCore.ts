export const IMPORT_IMAGE_COMPRESSION_THRESHOLD = 1 * 1024 * 1024;
export const IMPORT_IMAGE_MAX_DIMENSION = 2_560;
export const IMPORT_IMAGE_MAX_PIXELS = 50_000_000;
export const IMPORT_IMAGE_QUALITY = 0.85;
export const IMPORT_IMAGE_MIN_SAVINGS_RATIO = 0.9;
const IMPORT_IMAGE_RETRY_TARGETS = [
  { maxDimension: 2_560, quality: 0.85 },
  { maxDimension: 1_920, quality: 0.78 },
  { maxDimension: 1_280, quality: 0.68 },
  { maxDimension: 960, quality: 0.58 },
  { maxDimension: 640, quality: 0.5 },
] as const;

export type ImportImageCompressionPlan = {
  width: number;
  height: number;
  shouldEncode: boolean;
};

export type ImportImageEncodingAttempt = {
  width: number;
  height: number;
  quality: number;
};

export function importImageCompressionPlan(
  type: string,
  size: number,
  width: number,
  height: number,
): ImportImageCompressionPlan {
  const scale = Math.min(
    1,
    IMPORT_IMAGE_MAX_DIMENSION / Math.max(width, height),
  );
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    shouldEncode:
      type !== "image/gif" &&
      (size > IMPORT_IMAGE_COMPRESSION_THRESHOLD || scale < 1),
  };
}

export function shouldUseCompressedImportImage(
  originalSize: number,
  compressedSize: number,
  uploadLimit: number,
): boolean {
  if (compressedSize > uploadLimit) return false;
  if (originalSize > uploadLimit) return true;
  return compressedSize <= originalSize * IMPORT_IMAGE_MIN_SAVINGS_RATIO;
}

export function importImageOutputType(
  sourceType: string,
  sourceSize: number,
  uploadLimit: number,
): string {
  return sourceSize > uploadLimit ? "image/webp" : sourceType;
}

export function importImageFlattensAnimation(
  sourceType: string,
  sourceSize: number,
  uploadLimit: number,
): boolean {
  return sourceType === "image/gif" && sourceSize > uploadLimit;
}

export function importImageEncodingAttempts(
  width: number,
  height: number,
): ImportImageEncodingAttempt[] {
  const attempts: ImportImageEncodingAttempt[] = [];
  for (const target of IMPORT_IMAGE_RETRY_TARGETS) {
    const scale = Math.min(
      1,
      target.maxDimension / Math.max(1, width, height),
    );
    const attempt = {
      width: Math.max(1, Math.round(width * scale)),
      height: Math.max(1, Math.round(height * scale)),
      quality: target.quality,
    };
    const previous = attempts.at(-1);
    if (
      previous &&
      previous.width === attempt.width &&
      previous.height === attempt.height
    ) {
      continue;
    }
    attempts.push(attempt);
  }
  return attempts;
}
