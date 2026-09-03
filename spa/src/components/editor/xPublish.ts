export const X_MAX_IMAGES = 20;
export const X_ARTICLE_MAX_WEIGHT = 10_000;

const X_TRANSFORMED_URL_LENGTH = 23;
const X_URL_PATTERN = /https?:\/\/[^\s<>"']+/giu;

export type XArticleImage = { src: string; alt: string };

export type XArticleDraft = {
  title: string;
  markdown: string;
  images: XArticleImage[];
  invalid: boolean;
  tooLong: boolean;
  tooManyImages: boolean;
};

export function buildXArticle(
  title: string,
  markdownBody: string,
  articleImages: XArticleImage[],
): XArticleDraft {
  const normalizedTitle = titleToXText(title);
  const markdown = markdownBody
    .replace(/^\uFEFF?---\s*\n[\s\S]*?\n---\s*(?:\n|$)/, "")
    .trim();
  return {
    title: normalizedTitle,
    markdown,
    images: articleImages.slice(0, X_MAX_IMAGES),
    invalid: !normalizedTitle || (!markdown && articleImages.length === 0),
    tooLong: xTextWeight(markdown) > X_ARTICLE_MAX_WEIGHT,
    tooManyImages: articleImages.length > X_MAX_IMAGES,
  };
}

function titleToXText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function xTextWeight(value: string): number {
  return xTextPieces(value).reduce((total, piece) => total + piece.weight, 0);
}

function xRuneWeight(rune: string): number {
  const codePoint = rune.codePointAt(0) ?? 0;
  return codePoint <= 0x10ff ||
    (codePoint >= 0x2000 && codePoint <= 0x200d) ||
    (codePoint >= 0x2010 && codePoint <= 0x201f) ||
    (codePoint >= 0x2032 && codePoint <= 0x2037)
    ? 1
    : 2;
}

function xTextPieces(value: string): Array<{ text: string; weight: number }> {
  const pieces: Array<{ text: string; weight: number }> = [];
  let cursor = 0;
  for (const match of value.matchAll(X_URL_PATTERN)) {
    const start = match.index ?? cursor;
    for (const rune of Array.from(value.slice(cursor, start))) {
      pieces.push({ text: rune, weight: xRuneWeight(rune) });
    }
    const text = match[0];
    pieces.push({ text, weight: X_TRANSFORMED_URL_LENGTH });
    cursor = start + text.length;
  }
  for (const rune of Array.from(value.slice(cursor))) {
    pieces.push({ text: rune, weight: xRuneWeight(rune) });
  }
  return pieces;
}
