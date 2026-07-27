import "server-only";

import { AppError } from "@/lib/domain/errors";
import type { DriveOAuthPort } from "@/lib/ports/drive";
import type { YouTubeAnalyticsPort, YouTubeDataPort } from "@/lib/ports/youtube";
import type {
  YouTubeControlPlaneRepository,
  YouTubeStatsRecord,
} from "@/lib/repositories/youtube-control-plane";
import type { CredentialCipher } from "@/lib/security/credential-cipher";
import { youtubeAccessToken } from "./youtube-connection";

const TOP_VIDEO_COUNT = 5;

type RefreshStatsDependencies = Readonly<{
  repository: YouTubeControlPlaneRepository;
  oauth: DriveOAuthPort;
  cipher: CredentialCipher;
  data: YouTubeDataPort;
  analytics: YouTubeAnalyticsPort;
}>;

type RefreshChannelStatsInput = Readonly<{ id: string; now: Date }>;

function providerRejected(): AppError {
  return new AppError("YOUTUBE_PROVIDER_REJECTED", 502);
}

function validNow(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

/**
 * YYYY-MM-DD in UTC, which is the only date form the Analytics API accepts.
 *
 * Returns null rather than throwing: the input can be a provider-supplied publish
 * date, and `new Date("garbage").toISOString()` raises a raw RangeError that would
 * escape as a 500 instead of the mapped provider error.
 */
function analyticsDate(value: Date): string | null {
  return Number.isFinite(value.getTime()) ? value.toISOString().slice(0, 10) : null;
}

function validCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Pulls a fresh stats snapshot for one connected channel and caches it.
 *
 * Two different Google APIs back one row: the Data API owns the lifetime counters,
 * the Analytics API owns watch time. Analytics is the flakier of the two and is not
 * worth losing the whole snapshot over, so a failure there degrades `watchHours` to
 * null rather than propagating — the counters that did arrive are still written.
 */
export async function refreshChannelStats(
  input: RefreshChannelStatsInput,
  dependencies: RefreshStatsDependencies,
): Promise<YouTubeStatsRecord> {
  if (!validNow(input.now)) throw new AppError("INVALID_REQUEST", 400);

  const channel = await dependencies.repository.getChannel(input.id);
  if (!channel) throw new AppError("YOUTUBE_CHANNEL_NOT_FOUND", 404);
  const envelope = channel.envelope;

  const accessToken = await youtubeAccessToken(channel, {
    repository: dependencies.repository,
    oauth: dependencies.oauth,
    cipher: dependencies.cipher,
  });

  const profile = await dependencies.data.inspectMyChannel(accessToken);
  if (
    profile.channelId !== channel.channelId ||
    !validCounter(profile.viewCount) ||
    !validCounter(profile.videoCount) ||
    (profile.subscriberCount !== null && !validCounter(profile.subscriberCount))
  ) {
    // A different channel behind the same stored credential means the grant no longer
    // belongs to this row; writing its numbers here would silently mix two channels.
    throw providerRejected();
  }

  const topVideos = await dependencies.data.listTopVideos(
    accessToken,
    profile.uploadsPlaylistId,
    TOP_VIDEO_COUNT,
  );
  if (topVideos.length > TOP_VIDEO_COUNT) throw providerRejected();

  // Lifetime watch time: the channel's own publish date is the earliest meaningful
  // start, and Analytics rejects a start date before the channel existed.
  const startDate = analyticsDate(new Date(profile.publishedAt));
  const endDate = analyticsDate(input.now);
  let watchHours: number | null = null;
  if (startDate !== null && endDate !== null) {
    try {
      const watchTime = await dependencies.analytics.totalWatchTime(accessToken, {
        startDate,
        endDate,
      });
      watchHours = validCounter(watchTime.estimatedMinutesWatched)
        ? Math.floor(watchTime.estimatedMinutesWatched / 60)
        : null;
    } catch {
      watchHours = null;
    }
  }

  const stats: YouTubeStatsRecord = {
    subscriberCount: profile.subscriberCount,
    viewCount: profile.viewCount,
    videoCount: profile.videoCount,
    watchHours,
    topVideos: topVideos.map((video) => ({
      videoId: video.videoId,
      title: video.title,
      thumbnailUrl: video.thumbnailUrl,
      viewCount: video.viewCount,
    })),
    observedAt: input.now.toISOString(),
  };

  // Titles and avatars change upstream, so a refresh is also the moment to re-sync
  // them. The stored envelope is passed straight back: this use-case never needs the
  // plaintext, so it must not mint a second envelope for the same credential.
  if (envelope !== null) {
    await dependencies.repository.saveConnectedChannel({
      id: channel.id,
      channelId: channel.channelId,
      title: profile.title,
      avatarUrl: profile.avatarUrl,
      publishedAt: profile.publishedAt,
      envelope,
    });
  }

  await dependencies.repository.saveStats(channel.id, stats);
  await dependencies.repository.recordAudit({
    eventType: "YOUTUBE_STATS_REFRESHED",
    targetId: channel.id,
    payload: { status: "REFRESHED", watchHoursAvailable: watchHours !== null },
  });
  return stats;
}
