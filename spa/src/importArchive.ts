import { unpackImportArchive } from "./importArchiveCore";
import { ImportValidationError } from "./documentTransferCore";

type ArchiveResponse =
  | { ok: true; entries: Array<[string, ArrayBuffer]> }
  | {
      ok: false;
      error: string;
      reason?: ImportValidationError["reason"];
      filename?: string;
    };

async function unpackOnMainThread(
  file: File,
  remainingFiles: number,
  remainingBytes: number,
): Promise<Record<string, Uint8Array>> {
  return unpackImportArchive(
    await file.arrayBuffer(),
    remainingFiles,
    remainingBytes,
  );
}

export async function unpackImportArchiveFile(
  file: File,
  remainingFiles: number,
  remainingBytes: number,
): Promise<Record<string, Uint8Array>> {
  if (typeof Worker === "undefined") {
    return unpackOnMainThread(file, remainingFiles, remainingBytes);
  }

  let worker: Worker;
  try {
    worker = new Worker(
      new URL("./workers/importArchive.worker.ts", import.meta.url),
      { type: "module" },
    );
  } catch {
    return unpackOnMainThread(file, remainingFiles, remainingBytes);
  }

  const buffer = await file.arrayBuffer();
  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<ArchiveResponse>) => {
      worker.terminate();
      const response = event.data;
      if (!response.ok) {
        if (response.reason) {
          reject(new ImportValidationError(response.reason, response.filename));
        } else {
          reject(new Error(response.error));
        }
        return;
      }
      resolve(
        Object.fromEntries(
          response.entries.map(([path, entryBuffer]) => [
            path,
            new Uint8Array(entryBuffer),
          ]),
        ),
      );
    };
    worker.onerror = () => {
      worker.terminate();
      void unpackOnMainThread(file, remainingFiles, remainingBytes).then(
        resolve,
        reject,
      );
    };
    worker.postMessage(
      { buffer, remainingFiles, remainingBytes },
      [buffer],
    );
  });
}
