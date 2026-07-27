import { describe, expect, it } from "vitest";
import { AppError } from "@/lib/domain/errors";
import { YOUTUBE_READONLY_SCOPE } from "@/lib/domain/youtube";
import type { YouTubeChannelRecord } from "@/lib/repositories/youtube-control-plane";
import {
  createCredentialCipher,
  YOUTUBE_CIPHER_PROFILE,
} from "@/lib/security/credential-cipher";
import { FakeYouTubeControlPlaneRepository } from "@/test/fakes/fake-youtube-control-plane";
import {
  FakeYouTubeAnalytics,
  FakeYouTubeData,
  FakeYouTubeOAuth,
} from "@/test/fakes/fake-youtube";
import { refreshChannelStats } from "./youtube-stats";

const NOW = new Date("2026-07-27T12:34:56.000Z");
const TOKEN_KEY = Buffer.alloc(32, 11).toString("base64url");
const CHANNEL_UUID = "10000000-0000-4000-8000-000000000001";
const CHANNEL_ID = "UCabcdefghijklmnopqrstuv";
const REFRESH_TOKEN = "fake-youtube-refresh-token";

function cipher() {
  return createCredentialCipher(TOKEN_KEY, YOUTUBE_CIPHER_PROFILE);
}

function connectedChannel(
  overrides: Partial<YouTubeChannelRecord> = {},
): YouTubeChannelRecord {
  return {
    id: CHANNEL_UUID,
    channelId: CHANNEL_ID,
    title: "Tên cũ",
    avatarUrl: null,
    publishedAt: null,
    status: "CONNECTED",
    envelope: cipher().encrypt(CHANNEL_UUID, YOUTUBE_READONLY_SCOPE, REFRESH_TOKEN),
    titlePrompt: null,
    descriptionPrompt: null,
    descriptionTemplate: null,
    defaultTags: [],
    thumbnailPromptTemplate: null,
    ...overrides,
  };
}

function dependencies(seed = connectedChannel()) {
  const repository = new FakeYouTubeControlPlaneRepository();
  repository.seed(seed);
  return {
    repository,
    oauth: new FakeYouTubeOAuth(),
    data: new FakeYouTubeData(),
    analytics: new FakeYouTubeAnalytics(),
    cipher: cipher(),
  };
}

describe("refreshChannelStats", () => {
  it("converts analytics minutes to whole watch hours", async () => {
    const deps = dependencies();
    deps.analytics.watchTime = { estimatedMinutesWatched: 987_654 };

    const stats = await refreshChannelStats({ id: CHANNEL_UUID, now: NOW }, deps);

    // 987654 / 60 = 16460.9; a partial hour is not a watched hour.
    expect(stats.watchHours).toBe(16_460);
    await expect(deps.repository.getStats(CHANNEL_UUID))
      .resolves.toMatchObject({ watchHours: 16_460 });
  });

  it("queries analytics from the channel publish date to the current day", async () => {
    const deps = dependencies();

    await refreshChannelStats({ id: CHANNEL_UUID, now: NOW }, deps);

    expect(deps.analytics.watchTimeCalls).toEqual([{
      accessToken: deps.oauth.accessToken,
      startDate: "2024-01-02",
      endDate: "2026-07-27",
    }]);
  });

  it("carries the Data API counters and the observation time into the snapshot", async () => {
    const deps = dependencies();
    deps.data.topVideos = [
      { videoId: "v1", title: "Cao", thumbnailUrl: "https://t/1.jpg", viewCount: 900 },
      { videoId: "v2", title: "Thấp", thumbnailUrl: null, viewCount: 10 },
    ];
    deps.analytics.watchTime = { estimatedMinutesWatched: 120 };

    const stats = await refreshChannelStats({ id: CHANNEL_UUID, now: NOW }, deps);

    expect(stats).toEqual({
      subscriberCount: 123_000,
      viewCount: 1_234_567,
      videoCount: 210,
      watchHours: 2,
      topVideos: [
        { videoId: "v1", title: "Cao", thumbnailUrl: "https://t/1.jpg", viewCount: 900 },
        { videoId: "v2", title: "Thấp", thumbnailUrl: null, viewCount: 10 },
      ],
      observedAt: NOW.toISOString(),
    });
  });

  it("preserves a hidden subscriber count as null rather than zero", async () => {
    const deps = dependencies();
    deps.data.profile = { ...deps.data.profile, subscriberCount: null };

    const stats = await refreshChannelStats({ id: CHANNEL_UUID, now: NOW }, deps);

    expect(stats.subscriberCount).toBeNull();
  });

  it("still writes a snapshot when analytics fails", async () => {
    const deps = dependencies();
    deps.analytics.watchTimeError = new AppError("YOUTUBE_PROVIDER_REJECTED", 502);

    const stats = await refreshChannelStats({ id: CHANNEL_UUID, now: NOW }, deps);

    // Watch time is the one figure that comes from a second API. Losing it must not
    // cost the operator the counters the first API already returned.
    expect(stats.watchHours).toBeNull();
    expect(stats.viewCount).toBe(1_234_567);
    await expect(deps.repository.getStats(CHANNEL_UUID))
      .resolves.toMatchObject({ watchHours: null, viewCount: 1_234_567 });
  });

  it("keeps at most five top videos", async () => {
    const deps = dependencies();

    await refreshChannelStats({ id: CHANNEL_UUID, now: NOW }, deps);

    expect(deps.data.topVideosCalls).toEqual([{
      accessToken: deps.oauth.accessToken,
      uploadsPlaylistId: "UUabcdefghijklmnopqrstuv",
      limit: 5,
    }]);
  });

  it("refreshes the stored title and avatar, which change over a channel's life", async () => {
    const deps = dependencies();
    deps.data.profile = {
      ...deps.data.profile,
      title: "Tên mới",
      avatarUrl: "https://yt3.example/new-avatar.jpg",
    };

    await refreshChannelStats({ id: CHANNEL_UUID, now: NOW }, deps);

    await expect(deps.repository.getChannel(CHANNEL_UUID)).resolves.toMatchObject({
      title: "Tên mới",
      avatarUrl: "https://yt3.example/new-avatar.jpg",
    });
    // Re-saving the row must not mint a new identity for it.
    expect(deps.repository.savedChannels).toHaveLength(1);
    expect(deps.repository.savedChannels[0]!.id).toBe(CHANNEL_UUID);
  });

  it("carries the stored envelope through untouched instead of re-encrypting it", async () => {
    const deps = dependencies();
    const stored = (await deps.repository.getChannel(CHANNEL_UUID))!.envelope!;

    await refreshChannelStats({ id: CHANNEL_UUID, now: NOW }, deps);

    // Refreshing a profile is not a credential operation. Re-encrypting here would
    // put a second AAD-bound envelope in play for no reason; passing the existing
    // one back keeps this use-case unable to touch plaintext at all.
    const saved = deps.repository.savedChannels[0]!;
    expect(saved.envelope).toEqual(stored);
    expect(cipher().decrypt(CHANNEL_UUID, saved.envelope)).toBe(REFRESH_TOKEN);
  });

  it("rejects an unknown channel", async () => {
    const deps = dependencies();

    await expect(refreshChannelStats({
      id: "20000000-0000-4000-8000-000000000002",
      now: NOW,
    }, deps)).rejects.toMatchObject({ code: "YOUTUBE_CHANNEL_NOT_FOUND" });
    expect(deps.data.inspectCalls).toHaveLength(0);
  });

  it("propagates a reauth demand instead of writing a partial snapshot", async () => {
    const deps = dependencies(connectedChannel({ status: "REAUTH_REQUIRED", envelope: null }));

    await expect(refreshChannelStats({ id: CHANNEL_UUID, now: NOW }, deps))
      .rejects.toMatchObject({ code: "YOUTUBE_REAUTH_REQUIRED" });
    expect(deps.data.inspectCalls).toHaveLength(0);
    await expect(deps.repository.getStats(CHANNEL_UUID)).resolves.toBeNull();
  });

  it("does not write a snapshot when the Data API itself fails", async () => {
    const deps = dependencies();
    deps.data.inspectError = new AppError("YOUTUBE_RATE_LIMITED", 429);

    await expect(refreshChannelStats({ id: CHANNEL_UUID, now: NOW }, deps))
      .rejects.toMatchObject({ code: "YOUTUBE_RATE_LIMITED" });
    await expect(deps.repository.getStats(CHANNEL_UUID)).resolves.toBeNull();
  });

  it("audits the refresh without leaking the token or the raw channel id", async () => {
    const deps = dependencies();

    await refreshChannelStats({ id: CHANNEL_UUID, now: NOW }, deps);

    expect(deps.repository.auditEvents).toEqual([{
      eventType: "YOUTUBE_STATS_REFRESHED",
      targetId: CHANNEL_UUID,
      payload: { status: "REFRESHED", watchHoursAvailable: true },
    }]);
    const audit = JSON.stringify(deps.repository.auditEvents);
    expect(audit).not.toContain(REFRESH_TOKEN);
    expect(audit).not.toContain(CHANNEL_ID);
  });

  it("records that watch time was unavailable when analytics degraded", async () => {
    const deps = dependencies();
    deps.analytics.watchTimeError = new AppError("YOUTUBE_PROVIDER_REJECTED", 502);

    await refreshChannelStats({ id: CHANNEL_UUID, now: NOW }, deps);

    expect(deps.repository.auditEvents[0]!.payload).toEqual({
      status: "REFRESHED",
      watchHoursAvailable: false,
    });
  });

  it("still writes a snapshot when the channel's publish date is unparseable", async () => {
    const deps = dependencies();
    // `new Date("hôm qua").toISOString()` throws a raw RangeError. The publish date
    // is provider-supplied, so it must not be able to turn a refresh into a 500.
    deps.data.profile = { ...deps.data.profile, publishedAt: "hôm qua" };

    const stats = await refreshChannelStats({ id: CHANNEL_UUID, now: NOW }, deps);

    expect(stats.watchHours).toBeNull();
    expect(stats.viewCount).toBe(1_234_567);
    expect(deps.analytics.watchTimeCalls).toHaveLength(0);
    await expect(deps.repository.getStats(CHANNEL_UUID)).resolves.toMatchObject({
      watchHours: null,
    });
  });

  it("rejects an invalid clock before doing any provider work", async () => {
    const deps = dependencies();

    await expect(refreshChannelStats({ id: CHANNEL_UUID, now: new Date(Number.NaN) }, deps))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(deps.data.inspectCalls).toHaveLength(0);
  });
});
