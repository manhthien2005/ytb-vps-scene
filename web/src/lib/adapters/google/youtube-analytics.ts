import "server-only";

import { AppError } from "@/lib/domain/errors";
import type { YouTubeAnalyticsPort, YouTubeWatchTime } from "@/lib/ports/youtube";
import { googleJson } from "./http";

const YOUTUBE_ANALYTICS_API = "https://youtubeanalytics.googleapis.com/v2/reports";
const YOUTUBE_ANALYTICS_TIMEOUT_MS = 5_000;
const YOUTUBE_ANALYTICS_RESPONSE_BYTES = 64 * 1_024;
const YOUTUBE_ANALYTICS_ATTEMPTS = 2;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function providerRejected(): AppError {
  return new AppError("YOUTUBE_PROVIDER_REJECTED", 502);
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

// googleJson raises DRIVE-prefixed AppErrors (it is shared with the Drive adapter).
// A YouTube call must never surface a "DRIVE_..." code to callers, so every
// googleJson invocation in this module is funnelled through here.
function remapProviderError(error: unknown): never {
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

function reportsUrl(startDate: string, endDate: string): string {
  const url = new URL(YOUTUBE_ANALYTICS_API);
  url.searchParams.set("ids", "channel==MINE");
  url.searchParams.set("metrics", "estimatedMinutesWatched");
  url.searchParams.set("startDate", startDate);
  url.searchParams.set("endDate", endDate);
  return url.toString();
}

async function youtubeAnalyticsJson<T>(
  fetcher: typeof fetch,
  url: string,
  accessToken: string,
): Promise<T> {
  try {
    return await googleJson<T>(
      fetcher,
      url,
      { headers: { authorization: `Bearer ${accessToken}` } },
      {
        timeoutMs: YOUTUBE_ANALYTICS_TIMEOUT_MS,
        maxResponseBytes: YOUTUBE_ANALYTICS_RESPONSE_BYTES,
        attempts: YOUTUBE_ANALYTICS_ATTEMPTS,
      },
    );
  } catch (error) {
    remapProviderError(error);
  }
}

// A brand-new (or inactive-in-window) channel legitimately has no rows for the
// period — that is success with zero minutes, not a provider error. Once a row
// is present, its single cell must be a well-formed non-negative counter.
function parseWatchTime(value: unknown): YouTubeWatchTime {
  const record = objectRecord(value);
  if (!record) throw providerRejected();
  if (!Array.isArray(record.rows) || record.rows.length === 0) {
    return { estimatedMinutesWatched: 0 };
  }

  const firstRow = record.rows[0];
  if (!Array.isArray(firstRow) || firstRow.length === 0) throw providerRejected();

  const estimatedMinutesWatched = firstRow[0];
  if (!Number.isSafeInteger(estimatedMinutesWatched) || estimatedMinutesWatched < 0) {
    throw providerRejected();
  }

  return { estimatedMinutesWatched };
}

function isValidDate(value: string): boolean {
  return DATE_PATTERN.test(value);
}

export function createYouTubeAnalyticsAdapter(
  fetcher: typeof fetch = fetch,
): YouTubeAnalyticsPort {
  return {
    async totalWatchTime(accessToken, { startDate, endDate }) {
      if (!isValidDate(startDate) || !isValidDate(endDate)) {
        throw new AppError("INVALID_REQUEST", 400);
      }
      const response = await youtubeAnalyticsJson<unknown>(
        fetcher,
        reportsUrl(startDate, endDate),
        accessToken,
      );
      return parseWatchTime(response);
    },
  };
}
