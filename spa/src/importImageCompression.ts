import {
  IMPORT_IMAGE_COMPRESSION_THRESHOLD,
  importImageEncodingAttempts,
  importImageFlattensAnimation,
  IMPORT_IMAGE_MAX_PIXELS,
  IMPORT_IMAGE_QUALITY,
  importImageCompressionPlan,
  importImageOutputType,
  shouldUseCompressedImportImage,
} from "./importImageCompressionCore";
import {
  ImportValidationError,
  MAX_IMPORT_UPLOAD_IMAGE_BYTES,
} from "./documentTransferCore";

type WorkerResponse =
  | {
      id: number;
      ok: true;
      buffer: ArrayBuffer;
      type: string;
      compressed: boolean;
      flattenedAnimation: boolean;
    }
  | { id: number; ok: false; error: string };

let compressionWorker: Worker | null = null;
let nextRequestID = 1;
const pending = new Map<
  number,
  { resolve: (response: WorkerResponse) => void; reject: (error: Error) => void }
>();

function rejectPending(error: Error) {
  for (const request of pending.values()) request.reject(error);
  pending.clear();
}

function getCompressionWorker(): Worker | null {
  if (compressionWorker) return compressionWorker;
  if (typeof Worker === "undefined") return null;
  try {
    compressionWorker = new Worker(
      new URL("./workers/importImage.worker.ts", import.meta.url),
      { type: "module" },
    );
    compressionWorker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const request = pending.get(event.data.id);
      if (!request) return;
      pending.delete(event.data.id);
      request.resolve(event.data);
    };
    compressionWorker.onerror = () => {
      rejectPending(new Error("compression_worker_failed"));
      compressionWorker?.terminate();
      compressionWorker = null;
    };
    return compressionWorker;
  } catch {
    compressionWorker = null;
    return null;
  }
}

export type PreparedImportedImage = {
  file: File;
  flattenedAnimation: boolean;
};

function encodedFilename(filename: string, type: string): string {
  if (type !== "image/webp") return filename;
  return `${filename.replace(/\.[^.]+$/, "") || "image"}.webp`;
}

async function compressInWorker(
  file: File,
): Promise<PreparedImportedImage | null> {
  const worker = getCompressionWorker();
  if (!worker) return null;
  const id = nextRequestID++;
  const buffer = await file.arrayBuffer();
  const responsePromise = new Promise<WorkerResponse>((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
  worker.postMessage({ id, buffer, type: file.type }, [buffer]);
  const response = await responsePromise;
  if (!response.ok) {
    if (response.error === "compression_unsupported") return null;
    if (response.error === "image_too_large") {
      throw new ImportValidationError("image_too_large", file.name);
    }
    throw new Error(response.error);
  }
  return {
    file: new File([response.buffer], encodedFilename(file.name, response.type), {
      type: response.type,
      lastModified: file.lastModified,
    }),
    flattenedAnimation: response.flattenedAnimation,
  };
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality = IMPORT_IMAGE_QUALITY,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("compression_failed"))),
      type,
      quality,
    );
  });
}

async function compressOnMainThread(
  file: File,
): Promise<PreparedImportedImage> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  try {
    if (bitmap.width * bitmap.height > IMPORT_IMAGE_MAX_PIXELS) {
      throw new ImportValidationError("image_too_large", file.name);
    }
    const plan = importImageCompressionPlan(
      file.type,
      file.size,
      bitmap.width,
      bitmap.height,
    );
    const mustFitUploadLimit = file.size > MAX_IMPORT_UPLOAD_IMAGE_BYTES;
    if (!plan.shouldEncode && !mustFitUploadLimit) {
      return { file, flattenedAnimation: false };
    }
    const outputType = importImageOutputType(
      file.type,
      file.size,
      MAX_IMPORT_UPLOAD_IMAGE_BYTES,
    );
    const flattenedAnimation = importImageFlattensAnimation(
      file.type,
      file.size,
      MAX_IMPORT_UPLOAD_IMAGE_BYTES,
    );
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) throw new Error("compression_failed");
    const attempts = importImageEncodingAttempts(bitmap.width, bitmap.height);
    for (const [index, attempt] of attempts.entries()) {
      if (!mustFitUploadLimit && index > 0) break;
      canvas.width = attempt.width;
      canvas.height = attempt.height;
      context.drawImage(bitmap, 0, 0, attempt.width, attempt.height);
      const encoded = await canvasToBlob(
        canvas,
        outputType,
        outputType === "image/png" ? undefined : attempt.quality,
      );
      if (mustFitUploadLimit && encoded.size > MAX_IMPORT_UPLOAD_IMAGE_BYTES) {
        continue;
      }
      if (
        !shouldUseCompressedImportImage(
          file.size,
          encoded.size,
          MAX_IMPORT_UPLOAD_IMAGE_BYTES,
        )
      ) {
        return { file, flattenedAnimation: false };
      }
      return {
        file: new File(
          [encoded],
          encodedFilename(file.name, encoded.type || outputType),
          {
            type: encoded.type || outputType,
            lastModified: file.lastModified,
          },
        ),
        flattenedAnimation,
      };
    }
    throw new ImportValidationError("image_too_large", file.name);
  } finally {
    bitmap.close();
  }
}

export async function prepareImportedImage(
  file: File,
): Promise<PreparedImportedImage> {
  if (
    file.type === "image/gif" &&
    file.size <= MAX_IMPORT_UPLOAD_IMAGE_BYTES
  ) {
    return { file, flattenedAnimation: false };
  }
  if (file.size <= IMPORT_IMAGE_COMPRESSION_THRESHOLD) {
    return { file, flattenedAnimation: false };
  }
  let workerResult: PreparedImportedImage | null = null;
  try {
    workerResult = await compressInWorker(file);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "compression_worker_failed") {
      throw error;
    }
  }
  const result = workerResult ?? (await compressOnMainThread(file));
  if (result.file.size > MAX_IMPORT_UPLOAD_IMAGE_BYTES) {
    throw new ImportValidationError("image_too_large", file.name);
  }
  return result;
}
