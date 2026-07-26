import "server-only";

import { AppError, type PublicCode } from "@/lib/domain/errors";

export type GoogleJsonOptions = Readonly<{
  timeoutMs: number;
  maxResponseBytes: number;
  attempts: number;
  acceptInvalidTokenAsRevoked?: boolean;
  notFoundCode?: "DRIVE_FILE_NOT_FOUND";
}>;

const MAX_PROVIDER_TIMEOUT_MS = 5_000;
const MAX_PROVIDER_RESPONSE_BYTES = 64 * 1_024;
const MAX_PROVIDER_ATTEMPTS = 3;

function providerError(code: PublicCode): AppError {
  const statuses: Readonly<Partial<Record<PublicCode, number>>> = {
    DRIVE_REAUTH_REQUIRED: 401,
    DRIVE_RATE_LIMITED: 429,
    DRIVE_TEMPORARILY_UNAVAILABLE: 503,
    DRIVE_PROVIDER_REJECTED: 502,
    DRIVE_FILE_NOT_FOUND: 404,
  };
  return new AppError(code, statuses[code] ?? 502);
}

function validOptions(options: GoogleJsonOptions): boolean {
  return (
    Number.isSafeInteger(options.timeoutMs) &&
    options.timeoutMs >= 1 &&
    options.timeoutMs <= MAX_PROVIDER_TIMEOUT_MS &&
    Number.isSafeInteger(options.maxResponseBytes) &&
    options.maxResponseBytes >= 1 &&
    options.maxResponseBytes <= MAX_PROVIDER_RESPONSE_BYTES &&
    Number.isSafeInteger(options.attempts) &&
    options.attempts >= 1 &&
    options.attempts <= MAX_PROVIDER_ATTEMPTS &&
    (
      options.acceptInvalidTokenAsRevoked === undefined ||
      typeof options.acceptInvalidTokenAsRevoked === "boolean"
    ) &&
    (
      options.notFoundCode === undefined ||
      options.notFoundCode === "DRIVE_FILE_NOT_FOUND"
    )
  );
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Cancellation is best-effort; provider details must never escape.
  }
}

async function readBoundedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) {
      await cancelBody(response);
      throw providerError("DRIVE_PROVIDER_REJECTED");
    }
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared > maxBytes) {
      await cancelBody(response);
      throw providerError("DRIVE_PROVIDER_REJECTED");
    }
  }

  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw providerError("DRIVE_PROVIDER_REJECTED");
      }
      chunks.push(part.value);
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    try {
      await reader.cancel();
    } catch {
      // Cancellation is best-effort; provider details must never escape.
    }
    // Rethrow unwrapped: a mid-body abort or network drop is as transient as the
    // same failure during the connection phase, so the caller's attempt loop must
    // classify it retryable. Stable AppErrors (byte cap) already rethrew above.
    throw error;
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseJson(bytes: Uint8Array): unknown {
  if (bytes.byteLength === 0) return null;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw providerError("DRIVE_PROVIDER_REJECTED");
  }
}

function isProviderError(value: unknown, code: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).error === code
  );
}

function isValidInvalidTokenEvidence(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    record.error !== "invalid_token" ||
    keys.some((key) => key !== "error" && key !== "error_description")
  ) {
    return false;
  }
  return (
    record.error_description === undefined ||
    (
      typeof record.error_description === "string" &&
      new TextEncoder().encode(record.error_description).byteLength <= 2_048
    )
  );
}

export async function googleJson<T>(
  fetcher: typeof fetch,
  url: string,
  init: RequestInit,
  options: GoogleJsonOptions,
): Promise<T> {
  if (!validOptions(options)) throw providerError("DRIVE_PROVIDER_REJECTED");

  let lastCode: "DRIVE_RATE_LIMITED" | "DRIVE_TEMPORARILY_UNAVAILABLE" =
    "DRIVE_TEMPORARILY_UNAVAILABLE";
  for (let attempt = 0; attempt < options.attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await fetcher(url, { ...init, signal: controller.signal });
      if (response.status === 401) {
        await cancelBody(response);
        throw providerError("DRIVE_REAUTH_REQUIRED");
      }
      if (response.status === 429 || response.status >= 500) {
        lastCode = response.status === 429
          ? "DRIVE_RATE_LIMITED"
          : "DRIVE_TEMPORARILY_UNAVAILABLE";
        await cancelBody(response);
        continue;
      }
      if (response.status === 404 && options.notFoundCode !== undefined) {
        await cancelBody(response);
        throw providerError(options.notFoundCode);
      }

      const value = parseJson(await readBoundedBytes(response, options.maxResponseBytes));
      if (response.ok) return value as T;
      if (isProviderError(value, "invalid_grant")) throw providerError("DRIVE_REAUTH_REQUIRED");
      if (
        response.status === 400 &&
        options.acceptInvalidTokenAsRevoked === true &&
        isValidInvalidTokenEvidence(value)
      ) {
        return null as T;
      }
      throw providerError("DRIVE_PROVIDER_REJECTED");
    } catch (error) {
      if (error instanceof AppError) throw error;
      lastCode = "DRIVE_TEMPORARILY_UNAVAILABLE";
    } finally {
      clearTimeout(timer);
    }
  }
  throw providerError(lastCode);
}
