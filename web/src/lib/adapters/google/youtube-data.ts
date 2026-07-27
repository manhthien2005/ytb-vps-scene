import "server-only";

import { AppError } from "@/lib/domain/errors";
import { isChannelId } from "@/lib/domain/youtube";
import type {
  YouTubeChannelProfile,
  YouTubeDataPort,
  YouTubeVideoSummary,
} from "@/lib/ports/youtube";
import { googleJson } from "./http";
import { objectRecord, providerRejected, remapProviderError } from "./youtube-errors";

const YOUTUBE_API = "https://www.googleapis.com/youtube/v3";
const YOUTUBE_TIMEOUT_MS = 5_000;
const YOUTUBE_RESPONSE_BYTES = 64 * 1_024;
const YOUTUBE_ATTEMPTS = 2;
const PLAYLIST_PAGE_SIZE = 50;
const MAX_PLAYLIST_PAGES = 20;

const COUNTER_PATTERN = /^\d{1,15}$/;

const CHANNEL_FIELDS =
  "items(id,snippet(title,publishedAt,thumbnails/medium/url),statistics(viewCount,subscriberCount,hiddenSubscriberCount,videoCount),contentDetails/relatedPlaylists/uploads)";
const PLAYLIST_ITEMS_FIELDS = "items/contentDetails/videoId,nextPageToken";
const VIDEOS_FIELDS = "items(id,snippet(title,thumbnails/medium/url),statistics/viewCount)";

async function youtubeJson<T>(
  fetcher: typeof fetch,
  url: string,
  accessToken: string,
): Promise<T> {
  try {
    return await googleJson<T>(
      fetcher,
      url,
      { headers: { authorization: `Bearer ${accessToken}` } },
      { timeoutMs: YOUTUBE_TIMEOUT_MS, maxResponseBytes: YOUTUBE_RESPONSE_BYTES, attempts: YOUTUBE_ATTEMPTS },
    );
  } catch (error) {
    remapProviderError(error);
  }
}

// Counters arrive from the API as strings. Number() would silently coerce
// garbage like "" or "1e5", so every counter is matched against a strict
// digit pattern before conversion.
function parseCounter(value: unknown): number {
  if (typeof value !== "string" || !COUNTER_PATTERN.test(value)) throw providerRejected();
  return Number(value);
}

function parseThumbnailUrl(value: unknown): string | null {
  const thumbnails = objectRecord(value);
  const medium = thumbnails ? objectRecord(thumbnails.medium) : null;
  const url = medium ? medium.url : undefined;
  if (url === undefined) return null;
  if (typeof url !== "string" || url.length < 1 || url.length > 2_048) throw providerRejected();
  return url;
}

function parseChannelItem(value: unknown): YouTubeChannelProfile {
  const record = objectRecord(value);
  if (!record) throw providerRejected();
  if (!isChannelId(record.id)) throw providerRejected();

  const snippet = objectRecord(record.snippet);
  if (!snippet || typeof snippet.title !== "string" || typeof snippet.publishedAt !== "string") {
    throw providerRejected();
  }

  const statistics = objectRecord(record.statistics);
  if (!statistics || typeof statistics.hiddenSubscriberCount !== "boolean") throw providerRejected();
  const subscriberCount = statistics.hiddenSubscriberCount ? null : parseCounter(statistics.subscriberCount);

  const contentDetails = objectRecord(record.contentDetails);
  const relatedPlaylists = contentDetails ? objectRecord(contentDetails.relatedPlaylists) : null;
  const uploadsPlaylistId = relatedPlaylists ? relatedPlaylists.uploads : undefined;
  if (typeof uploadsPlaylistId !== "string" || uploadsPlaylistId.length < 1) throw providerRejected();

  return {
    channelId: record.id,
    title: snippet.title,
    avatarUrl: parseThumbnailUrl(snippet.thumbnails),
    publishedAt: snippet.publishedAt,
    subscriberCount,
    viewCount: parseCounter(statistics.viewCount),
    videoCount: parseCounter(statistics.videoCount),
    uploadsPlaylistId,
  };
}

function parseVideoItem(value: unknown): YouTubeVideoSummary {
  const record = objectRecord(value);
  if (!record || typeof record.id !== "string" || record.id.length < 1) throw providerRejected();
  const snippet = objectRecord(record.snippet);
  if (!snippet || typeof snippet.title !== "string") throw providerRejected();
  const statistics = objectRecord(record.statistics);
  if (!statistics) throw providerRejected();
  return {
    videoId: record.id,
    title: snippet.title,
    thumbnailUrl: parseThumbnailUrl(snippet.thumbnails),
    viewCount: parseCounter(statistics.viewCount),
  };
}

function channelsUrl(): string {
  const url = new URL(`${YOUTUBE_API}/channels`);
  url.searchParams.set("part", "snippet,statistics,contentDetails");
  url.searchParams.set("mine", "true");
  url.searchParams.set("fields", CHANNEL_FIELDS);
  return url.toString();
}

function playlistItemsUrl(playlistId: string, pageToken: string | undefined): string {
  const url = new URL(`${YOUTUBE_API}/playlistItems`);
  url.searchParams.set("playlistId", playlistId);
  url.searchParams.set("part", "contentDetails");
  url.searchParams.set("maxResults", String(PLAYLIST_PAGE_SIZE));
  url.searchParams.set("fields", PLAYLIST_ITEMS_FIELDS);
  if (pageToken !== undefined) url.searchParams.set("pageToken", pageToken);
  return url.toString();
}

function videosUrl(ids: readonly string[]): string {
  const url = new URL(`${YOUTUBE_API}/videos`);
  url.searchParams.set("part", "snippet,statistics");
  url.searchParams.set("id", ids.join(","));
  url.searchParams.set("fields", VIDEOS_FIELDS);
  return url.toString();
}

async function fetchUploadedVideoIds(
  fetcher: typeof fetch,
  accessToken: string,
  uploadsPlaylistId: string,
): Promise<readonly string[]> {
  const videoIds: string[] = [];
  let pageToken: string | undefined;

  // Capped so a channel with tens of thousands of uploads cannot burn
  // unbounded quota: 20 pages * 50 items/page = 1000 videos, then stop.
  for (let page = 0; page < MAX_PLAYLIST_PAGES; page += 1) {
    const response = await youtubeJson<unknown>(
      fetcher,
      playlistItemsUrl(uploadsPlaylistId, pageToken),
      accessToken,
    );
    const record = objectRecord(response);
    if (!record || !Array.isArray(record.items)) throw providerRejected();

    for (const item of record.items) {
      const itemRecord = objectRecord(item);
      const contentDetails = itemRecord ? objectRecord(itemRecord.contentDetails) : null;
      const videoId = contentDetails ? contentDetails.videoId : undefined;
      if (typeof videoId !== "string" || videoId.length < 1) throw providerRejected();
      videoIds.push(videoId);
    }

    if (record.nextPageToken === undefined) break;
    if (typeof record.nextPageToken !== "string" || record.nextPageToken.length < 1) {
      throw providerRejected();
    }
    pageToken = record.nextPageToken;
  }

  return videoIds;
}

async function fetchVideoSummaries(
  fetcher: typeof fetch,
  accessToken: string,
  videoIds: readonly string[],
): Promise<readonly YouTubeVideoSummary[]> {
  const summaries: YouTubeVideoSummary[] = [];
  for (let offset = 0; offset < videoIds.length; offset += PLAYLIST_PAGE_SIZE) {
    const batch = videoIds.slice(offset, offset + PLAYLIST_PAGE_SIZE);
    const response = await youtubeJson<unknown>(fetcher, videosUrl(batch), accessToken);
    const record = objectRecord(response);
    if (!record || !Array.isArray(record.items)) throw providerRejected();
    for (const item of record.items) summaries.push(parseVideoItem(item));
  }
  return summaries;
}

export function createYouTubeDataAdapter(fetcher: typeof fetch = fetch): YouTubeDataPort {
  return {
    async inspectMyChannel(accessToken) {
      const response = await youtubeJson<unknown>(fetcher, channelsUrl(), accessToken);
      const record = objectRecord(response);
      if (!record || !Array.isArray(record.items)) throw providerRejected();
      if (record.items.length === 0) throw new AppError("YOUTUBE_CHANNEL_NOT_FOUND", 404);
      return parseChannelItem(record.items[0]);
    },

    async listTopVideos(accessToken, uploadsPlaylistId, limit) {
      const cappedLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : 0;
      const videoIds = await fetchUploadedVideoIds(fetcher, accessToken, uploadsPlaylistId);
      const summaries = await fetchVideoSummaries(fetcher, accessToken, videoIds);
      return [...summaries]
        .sort((left, right) => right.viewCount - left.viewCount)
        .slice(0, cappedLimit);
    },
  };
}
