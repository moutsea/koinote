import { unzipSync } from "fflate";
import {
  ImportValidationError,
  importFileKind,
  validateImportEntrySize,
} from "./documentTransferCore";

export function unpackImportArchive(
  buffer: ArrayBuffer,
  remainingFiles: number,
  remainingBytes: number,
): Record<string, Uint8Array> {
  let fileCount = 0;
  let totalBytes = 0;
  let validationError: Error | null = null;
  const unpacked = unzipSync(new Uint8Array(buffer), {
    filter(info) {
      fileCount += 1;
      if (fileCount > remainingFiles) {
        validationError ??= new ImportValidationError("too_many_files");
        return false;
      }
      const kind = importFileKind(info.name);
      if (
        kind !== "markdown" &&
        kind !== "image" &&
        kind !== "manifest"
      ) {
        return false;
      }
      totalBytes += info.originalSize;
      if (totalBytes > remainingBytes) {
        validationError ??= new ImportValidationError("import_too_large");
        return false;
      }
      try {
        validateImportEntrySize(info.name, info.originalSize, kind);
      } catch (error) {
        validationError ??=
          error instanceof Error ? error : new Error("invalid_import_entry");
        return false;
      }
      return validationError === null;
    },
  });
  if (validationError) throw validationError;
  return unpacked;
}
