import "server-only";

import { AppError } from "@/lib/domain/errors";

export function providerRejected(): AppError {
  return new AppError("YOUTUBE_PROVIDER_REJECTED", 502);
}

export function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// googleJson raises DRIVE-prefixed AppErrors (it is shared with the Drive adapter).
// A YouTube call must never surface a "DRIVE_..." code to callers, so every
// googleJson invocation across the YouTube adapters is funnelled through here.
export function remapProviderError(error: unknown): never {
  if (error instanceof AppError) {
    switch (error.code) {
      case "DRIVE_RATE_LIMITED":
        throw new AppError("YOUTUBE_RATE_LIMITED", 429);
      case "DRIVE_REAUTH_REQUIRED":
        throw new AppError("YOUTUBE_REAUTH_REQUIRED", 401);
      case "DRIVE_TEMPORARILY_UNAVAILABLE":
      case "DRIVE_PROVIDER_REJECTED":
        throw providerRejected();
      default:
        throw error;
    }
  }
  throw error;
}
