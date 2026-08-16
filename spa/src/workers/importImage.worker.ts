/// <reference lib="webworker" />

import {
  IMPORT_IMAGE_MAX_PIXELS,
  importImageEncodingAttempts,
  importImageFlattensAnimation,
  importImageCompressionPlan,
  importImageOutputType,
  shouldUseCompressedImportImage,
} from "../importImageCompressionCore";
import { MAX_IMPORT_UPLOAD_IMAGE_BYTES } from "../documentTransferCore";

type CompressRequest = {
  id: number;
  buffer: ArrayBuffer;
  type: string;
};

type CompressResponse =
  | {
      id: number;
      ok: true;
      buffer: ArrayBuffer;
      type: string;
      compressed: boolean;
      flattenedAnimation: boolean;
    }
  | { id: number; ok: false; error: string };

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.onmessage = async (event: MessageEvent<CompressRequest>) => {
  const { id, buffer, type } = event.data;
  let bitmap: ImageBitmap | null = null;
  try {
    if (
      typeof OffscreenCanvas === "undefined" ||
      typeof createImageBitmap === "undefined"
    ) {
      throw new Error("compression_unsupported");
    }
    const original = new Blob([buffer], { type });
    bitmap = await createImageBitmap(original, { imageOrientation: "from-image" });
    if (bitmap.width * bitmap.height > IMPORT_IMAGE_MAX_PIXELS) {
      throw new Error("image_too_large");
    }
    const plan = importImageCompressionPlan(
      type,
      original.size,
      bitmap.width,
      bitmap.height,
    );
    const mustFitUploadLimit = original.size > MAX_IMPORT_UPLOAD_IMAGE_BYTES;
    if (!plan.shouldEncode && !mustFitUploadLimit) {
      const response: CompressResponse = {
        id,
        ok: true,
        buffer,
        type,
        compressed: false,
        flattenedAnimation: false,
      };
      workerScope.postMessage(response, [buffer]);
      return;
    }

    const outputType = importImageOutputType(
      type,
      original.size,
      MAX_IMPORT_UPLOAD_IMAGE_BYTES,
    );
    const flattenedAnimation = importImageFlattensAnimation(
      type,
      original.size,
      MAX_IMPORT_UPLOAD_IMAGE_BYTES,
    );
    const canvas = new OffscreenCanvas(plan.width, plan.height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("compression_failed");
    const attempts = importImageEncodingAttempts(bitmap.width, bitmap.height);
    for (const [index, attempt] of attempts.entries()) {
      if (!mustFitUploadLimit && index > 0) break;
      canvas.width = attempt.width;
      canvas.height = attempt.height;
      context.drawImage(bitmap, 0, 0, attempt.width, attempt.height);
      const encoded = await canvas.convertToBlob({
        type: outputType,
        quality: outputType === "image/png" ? undefined : attempt.quality,
      });
      if (mustFitUploadLimit && encoded.size > MAX_IMPORT_UPLOAD_IMAGE_BYTES) {
        continue;
      }
      const useCompressed = shouldUseCompressedImportImage(
        original.size,
        encoded.size,
        MAX_IMPORT_UPLOAD_IMAGE_BYTES,
      );
      const result = useCompressed ? await encoded.arrayBuffer() : buffer;
      const response: CompressResponse = {
        id,
        ok: true,
        buffer: result,
        type: useCompressed ? encoded.type || outputType : type,
        compressed: useCompressed,
        flattenedAnimation: useCompressed && flattenedAnimation,
      };
      workerScope.postMessage(response, [result]);
      return;
    }
    throw new Error("image_too_large");
  } catch (error) {
    const response: CompressResponse = {
      id,
      ok: false,
      error: error instanceof Error ? error.message : "compression_failed",
    };
    workerScope.postMessage(response);
  } finally {
    bitmap?.close();
  }
};

export {};
