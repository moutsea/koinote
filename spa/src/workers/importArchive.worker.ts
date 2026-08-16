/// <reference lib="webworker" />

import { unpackImportArchive } from "../importArchiveCore";
import { ImportValidationError } from "../documentTransferCore";

type ArchiveRequest = {
  buffer: ArrayBuffer;
  remainingFiles: number;
  remainingBytes: number;
};

type ArchiveResponse =
  | { ok: true; entries: Array<[string, ArrayBuffer]> }
  | {
      ok: false;
      error: string;
      reason?: ImportValidationError["reason"];
      filename?: string;
    };

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.onmessage = (event: MessageEvent<ArchiveRequest>) => {
  try {
    const unpacked = unpackImportArchive(
      event.data.buffer,
      event.data.remainingFiles,
      event.data.remainingBytes,
    );
    const transfers: ArrayBuffer[] = [];
    const entries = Object.entries(unpacked).map(([path, bytes]) => {
      const exactBuffer =
        bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
          ? (bytes.buffer as ArrayBuffer)
          : bytes.slice().buffer;
      transfers.push(exactBuffer);
      return [path, exactBuffer] as [string, ArrayBuffer];
    });
    const response: ArchiveResponse = { ok: true, entries };
    workerScope.postMessage(response, transfers);
  } catch (error) {
    const response: ArchiveResponse = {
      ok: false,
      error: error instanceof Error ? error.message : "archive_failed",
      ...(error instanceof ImportValidationError
        ? { reason: error.reason, filename: error.filename }
        : {}),
    };
    workerScope.postMessage(response);
  }
};

export {};
