export const COVER_MIN_WIDTH = 320;
export const COVER_MIN_HEIGHT = 136;
export const COVER_MAX_SIDE = 940;

export function parseCoverRatio(value: string): [number, number] | null {
  const match = /^((?:0\.[0-9]{1,2}|[1-9][0-9]*(?:\.[0-9]{1,2})?)):((?:0\.[0-9]{1,2}|[1-9][0-9]*(?:\.[0-9]{1,2})?))$/.exec(value.trim());
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  const ratio = width / height;
  if (width <= 0 || height <= 0 || width > 100 || height > 100 || ratio < COVER_MIN_WIDTH / COVER_MAX_SIDE || ratio > COVER_MAX_SIDE / COVER_MIN_HEIGHT) return null;
  return [width, height];
}

export function isValidCoverRatio(value: string): boolean {
  return parseCoverRatio(value) !== null;
}
