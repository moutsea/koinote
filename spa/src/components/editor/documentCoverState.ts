import type { WechatCoverMode, WechatCoverRatio } from "../../api";

export type DocumentCoverState = {
  coverMode: WechatCoverMode;
  coverRatio: WechatCoverRatio;
  coverImageSource: string;
  coverPrompt: string;
};

export type SaveDocumentCover = (
  cover: DocumentCoverState,
  signal: AbortSignal,
) => Promise<DocumentCoverState>;

export function documentCoverState(document: Partial<DocumentCoverState>): DocumentCoverState {
  return {
    coverMode: document.coverMode ?? "default",
    coverRatio: document.coverRatio ?? "2.35:1",
    coverImageSource: document.coverImageSource ?? "",
    coverPrompt: document.coverPrompt ?? "",
  };
}
