// @vitest-environment node
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createYouTubeControlPlaneRepository } from "./neon-youtube-control-plane";
import type { YouTubeStatsRecord } from "./youtube-control-plane";
import type { EncryptedCredential } from "@/lib/security/credential-cipher";

const CHANNEL_ID = "UC1234567890123456789012";
const CHANNEL_UUID = "10000000-0000-4000-8000-000000000001";

const ENVELOPE: EncryptedCredential = {
  ciphertext: Buffer.from("refresh-token").toString("base64url"),
  nonce: Buffer.alloc(12, 1).toString("base64url"),
  authTag: Buffer.alloc(16, 2).toString("base64url"),
  keyVersion: 1,
  scope: "https://www.googleapis.com/auth/youtube.readonly",
};

describe("YouTube control-plane repository", () => {
  let db: PGlite;

  beforeEach(async () => {
    db = new PGlite();
    await db.exec(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  });

  afterEach(async () => {
    await db.close();
  });

  function repo() {
    return createYouTubeControlPlaneRepository({
      query: (text, parameters) => db.query(text, parameters),
    });
  }

  it("round-trips a connected channel including its envelope", async () => {
    const repository = repo();
    await repository.saveConnectedChannel({
      id: CHANNEL_UUID,
      channelId: CHANNEL_ID,
      title: "Demo Channel",
      avatarUrl: "https://example.com/avatar.png",
      publishedAt: "2020-01-01T00:00:00.000Z",
      envelope: ENVELOPE,
    });

    const channel = await repository.getChannel(CHANNEL_UUID);
    expect(channel).toMatchObject({
      id: CHANNEL_UUID,
      channelId: CHANNEL_ID,
      title: "Demo Channel",
      avatarUrl: "https://example.com/avatar.png",
      publishedAt: "2020-01-01T00:00:00.000Z",
      status: "CONNECTED",
      envelope: ENVELOPE,
      titlePrompt: null,
      descriptionPrompt: null,
      descriptionTemplate: null,
      defaultTags: [],
      thumbnailPromptTemplate: null,
    });
  });

  it("upserts on channel_id so reconnecting the same channel does not duplicate", async () => {
    const repository = repo();
    await repository.saveConnectedChannel({
      id: CHANNEL_UUID,
      channelId: CHANNEL_ID,
      title: "Demo Channel",
      avatarUrl: null,
      publishedAt: null,
      envelope: ENVELOPE,
    });
    await repository.saveConnectedChannel({
      id: CHANNEL_UUID,
      channelId: CHANNEL_ID,
      title: "Demo Channel Renamed",
      avatarUrl: null,
      publishedAt: null,
      envelope: ENVELOPE,
    });

    const channels = await repository.listChannels();
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({ title: "Demo Channel Renamed", status: "CONNECTED" });
  });

  it("clears credential columns when status moves to DISCONNECTED", async () => {
    const repository = repo();
    await repository.saveConnectedChannel({
      id: CHANNEL_UUID,
      channelId: CHANNEL_ID,
      title: "Demo Channel",
      avatarUrl: null,
      publishedAt: null,
      envelope: ENVELOPE,
    });

    await repository.setChannelStatus(CHANNEL_UUID, "DISCONNECTED");

    const channel = await repository.getChannel(CHANNEL_UUID);
    expect(channel).toMatchObject({ status: "DISCONNECTED", envelope: null });
  });

  it("savePrompts returns false for an unknown channel", async () => {
    const repository = repo();
    const result = await repository.savePrompts("90000000-0000-4000-8000-000000000009", {
      titlePrompt: "Write a title",
      descriptionPrompt: "Write a description",
      descriptionTemplate: "{{title}}",
      defaultTags: ["a", "b"],
      thumbnailPromptTemplate: "Make a thumbnail",
    });
    expect(result).toBe(false);
  });

  it("saveStats replaces the previous snapshot", async () => {
    const repository = repo();
    await repository.saveConnectedChannel({
      id: CHANNEL_UUID,
      channelId: CHANNEL_ID,
      title: "Demo Channel",
      avatarUrl: null,
      publishedAt: null,
      envelope: ENVELOPE,
    });

    const first: YouTubeStatsRecord = {
      subscriberCount: 1_000,
      viewCount: 50_000,
      videoCount: 12,
      watchHours: 300,
      topVideos: [
        { videoId: "abc123", title: "First video", thumbnailUrl: "https://example.com/1.jpg", viewCount: 100 },
      ],
      observedAt: "2026-07-20T00:00:00.000Z",
    };
    await repository.saveStats(CHANNEL_UUID, first);
    await expect(repository.getStats(CHANNEL_UUID)).resolves.toEqual(first);

    const second: YouTubeStatsRecord = {
      subscriberCount: 2_000,
      viewCount: 60_000,
      videoCount: 13,
      watchHours: 320,
      topVideos: [
        { videoId: "def456", title: "Second video", thumbnailUrl: null, viewCount: 200 },
      ],
      observedAt: "2026-07-21T00:00:00.000Z",
    };
    await repository.saveStats(CHANNEL_UUID, second);
    await expect(repository.getStats(CHANNEL_UUID)).resolves.toEqual(second);
  });
});
