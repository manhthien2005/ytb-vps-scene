export const YOUTUBE_READONLY_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
export const YT_ANALYTICS_READONLY_SCOPE = "https://www.googleapis.com/auth/yt-analytics.readonly";

export const YOUTUBE_SCOPES = [
  YOUTUBE_READONLY_SCOPE,
  YT_ANALYTICS_READONLY_SCOPE,
] as const;

export const YOUTUBE_TITLE_MAX_CHARS = 100;
export const YOUTUBE_DESCRIPTION_MAX_CHARS = 5_000;
export const YOUTUBE_TAGS_MAX_TOTAL_CHARS = 500;

const CHANNEL_ID_PATTERN = /^UC[A-Za-z0-9_-]{22}$/;

export function isChannelId(value: unknown): value is string {
  return typeof value === "string" && CHANNEL_ID_PATTERN.test(value);
}

export function sameScopeSet(
  granted: readonly string[],
  expected: readonly string[],
): boolean {
  if (!Array.isArray(granted)) return false;
  const grantedSet = new Set(granted);
  if (grantedSet.size !== granted.length) return false;
  if (grantedSet.size !== expected.length) return false;
  return expected.every((scope) => grantedSet.has(scope));
}
