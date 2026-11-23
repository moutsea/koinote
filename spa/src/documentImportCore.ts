export type TransferProgress = (done: number, total: number) => void;
export const IMPORT_OWNER_HEADER = "X-Koinote-Import-Owner";
export const IMPORT_ACCOUNT_CHANGED_CODE = "import_account_changed";

export type ImportDocumentsResult = {
  imported: number;
  flattenedGifCount: number;
};

export type ImportRunOptions = {
  owner?: string;
  signal?: AbortSignal;
  assertActive?: () => void;
  checkSession?: () => Promise<void>;
  onWaitingChange?: (waiting: boolean) => void;
};

// Kept separate from the transfer implementation so the application shell can
// retain a task without loading archive/image/export code on the home page.
export class ImportInterruptedError extends Error {
  constructor(
    readonly cause: unknown,
    readonly imported: number,
    readonly total: number,
    readonly canResume: boolean,
    readonly resume: (onProgress?: TransferProgress, options?: ImportRunOptions) => Promise<ImportDocumentsResult>,
    readonly discard: () => Promise<void>,
    readonly phase: "write" | "session-check" | "image-check" = "write",
  ) {
    super("Document import interrupted");
    this.name = "ImportInterruptedError";
  }
}
