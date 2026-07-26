import type { UploadIntent, UploadIntentInput } from "./drive";
import { AppError } from "./errors";
import { canonicalUploadFileName } from "./upload-filename";

const EXTENSION_MIME_TYPES = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  webm: "video/webm",
} as const;

type UploadExtension = keyof typeof EXTENSION_MIME_TYPES;

export type RetryDecision =
  | Readonly<{ kind: "RETRY"; delayMs: number }>
  | Readonly<{ kind: "EXHAUSTED"; delayMs: 0 }>;

function isSafeIntegerInRange(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

export function validateUploadIntent(source: UploadIntentInput, maximumBytes: number): UploadIntent {
  if (!isSafeIntegerInRange(maximumBytes, 1, Number.MAX_SAFE_INTEGER)) {
    throw new AppError("INVALID_REQUEST", 400);
  }
  if (!isSafeIntegerInRange(source.sizeBytes, 1, maximumBytes)) {
    if (Number.isSafeInteger(source.sizeBytes) && source.sizeBytes > maximumBytes) {
      throw new AppError("UPLOAD_TOO_LARGE", 413);
    }
    throw new AppError("INVALID_REQUEST", 400);
  }
  if (!isSafeIntegerInRange(source.lastModified, 0, Number.MAX_SAFE_INTEGER)) {
    throw new AppError("INVALID_REQUEST", 400);
  }

  const fileName = canonicalUploadFileName(source.fileName);
  if (fileName === null) throw new AppError("UPLOAD_TYPE_REJECTED", 400);
  // Mirror upload-filename.ts: names without a real extension ("mp4", ".mp4")
  // must not fall through to the whole-name-as-extension case.
  const dot = fileName.lastIndexOf(".");
  if (dot < 1) throw new AppError("UPLOAD_TYPE_REJECTED", 400);
  const extension = fileName.slice(dot + 1).toLowerCase();
  if (
    !(extension in EXTENSION_MIME_TYPES) ||
    EXTENSION_MIME_TYPES[extension as UploadExtension] !== source.mimeType
  ) {
    throw new AppError("UPLOAD_TYPE_REJECTED", 400);
  }

  return { ...source, fileName, normalizedExtension: extension as UploadExtension };
}

export function parseAcknowledgedRange(range: string | null): number {
  if (range === null) return 0;
  const match = /^bytes=0-(0|[1-9][0-9]*)$/.exec(range);
  if (!match) throw new AppError("UPLOAD_REMOTE_MISMATCH", 409);

  const lastByte = Number(match[1]);
  if (!Number.isSafeInteger(lastByte) || lastByte >= Number.MAX_SAFE_INTEGER) {
    throw new AppError("UPLOAD_REMOTE_MISMATCH", 409);
  }
  return lastByte + 1;
}

export function nextRetry(failedAttempts: number, jitterUnit: number): RetryDecision {
  if (!Number.isSafeInteger(failedAttempts) || failedAttempts < 1 || !Number.isFinite(jitterUnit) || jitterUnit < 0 || jitterUnit >= 1) {
    throw new AppError("INVALID_REQUEST", 400);
  }
  if (failedAttempts >= 5) return { kind: "EXHAUSTED", delayMs: 0 };

  const baseMs = Math.min(30_000, 1_000 * 2 ** (failedAttempts - 1));
  const jitterMs = Math.floor(jitterUnit * 250);
  return { kind: "RETRY", delayMs: Math.min(30_000, baseMs + jitterMs) };
}
