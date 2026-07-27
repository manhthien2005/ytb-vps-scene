import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/domain/errors";

const { currentAdmin, repository } = vi.hoisted(() => ({
  currentAdmin: vi.fn(),
  repository: { listChannels: vi.fn(), getStats: vi.fn() },
}));
vi.mock("@/lib/auth/current-admin", () => ({ currentAdmin }));
vi.mock("@/lib/repositories/neon-youtube-control-plane", () => ({
  createNeonYouTubeControlPlaneRepository: () => repository,
}));

import { GET } from "./route";

const CHANNEL_UID = "30000000-0000-4000-8000-000000000001";

function setEnv() {
  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: "postgresql://test:test@localhost/test",
    ADMIN_KEY_HASH: "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    SESSION_SECRET: "s".repeat(64),
    APP_ORIGIN: "http://localhost:3000",
    GOOGLE_OAUTH_CLIENT_ID: "example-client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "example-client-secret",
    DRIVE_TOKEN_KEY_V1: "A".repeat(43),
    NEON_STORAGE_LIMIT_BYTES: "536870912",
    DRIVE_UPLOAD_MAX_BYTES: "10737418240",
    FREE_TIER_SOFT_PERCENT: "90",
    QUOTA_STALE_AFTER_SECONDS: "900",
  });
  delete process.env.OPENAI_API_KEY;
}

function request() {
  return new NextRequest("http://localhost:3000/api/v1/youtube/channels");
}

const envelope = {
  ciphertext: "Y2lwaGVydGV4dC1zZWNyZXQ",
  nonce: "bm9uY2UtdHdlbHZl",
  authTag: "YXV0aC10YWctc2l4dGVlbg",
  keyVersion: 1,
  scope: "https://www.googleapis.com/auth/youtube.readonly",
} as const;

function channel() {
  return {
    id: CHANNEL_UID,
    channelId: "UCabcdefghijklmnopqrstuv",
    title: "Kênh mẫu",
    avatarUrl: "https://yt3.example/avatar.jpg",
    publishedAt: "2020-01-01T00:00:00.000Z",
    status: "CONNECTED" as const,
    envelope,
    titlePrompt: "tiêu đề",
    descriptionPrompt: "mô tả",
    descriptionTemplate: "khuôn",
    defaultTags: ["a", "b"],
    thumbnailPromptTemplate: "thumb",
  };
}

function stats() {
  return {
    subscriberCount: 1_230,
    viewCount: 45_000,
    videoCount: 12,
    watchHours: 340,
    topVideos: [
      { videoId: "vid1", title: "Video 1", thumbnailUrl: null, viewCount: 900 },
    ],
    observedAt: "2026-07-27T00:00:00.000Z",
  };
}

describe("GET /api/v1/youtube/channels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv();
    currentAdmin.mockResolvedValue(true);
    repository.listChannels.mockResolvedValue([channel()]);
    repository.getStats.mockResolvedValue(stats());
  });

  it("requires an authenticated admin before reading any channel", async () => {
    currentAdmin.mockResolvedValue(false);
    const response = await GET(request());

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ code: "AUTH_REQUIRED" });
    expect(repository.listChannels).not.toHaveBeenCalled();
  });

  it("returns each channel with its stats snapshot", async () => {
    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      channels: [{
        id: CHANNEL_UID,
        channelId: "UCabcdefghijklmnopqrstuv",
        title: "Kênh mẫu",
        avatarUrl: "https://yt3.example/avatar.jpg",
        status: "CONNECTED",
        stats: stats(),
      }],
    });
  });

  // The repository hands back the encrypted refresh token on every channel; this
  // response is the boundary where it must not cross into the browser.
  it("never serialises the credential envelope or any of its parts", async () => {
    const response = await GET(request());
    const body = JSON.stringify(await response.json());

    expect(body).not.toContain("envelope");
    expect(body).not.toContain("ciphertext");
    expect(body).not.toContain("nonce");
    expect(body).not.toContain("authTag");
    expect(body).not.toContain("keyVersion");
    expect(body).not.toContain(envelope.ciphertext);
    expect(body).not.toContain(envelope.nonce);
    expect(body).not.toContain(envelope.authTag);
  });

  it("omits the envelope for a channel that still holds one while REAUTH_REQUIRED", async () => {
    repository.listChannels.mockResolvedValue([
      { ...channel(), status: "REAUTH_REQUIRED" as const },
    ]);
    const response = await GET(request());
    const payload = await response.json() as { channels: Record<string, unknown>[] };

    expect(payload.channels[0]!.status).toBe("REAUTH_REQUIRED");
    expect(Object.keys(payload.channels[0]!).sort()).toEqual([
      "avatarUrl", "channelId", "id", "stats", "status", "title",
    ]);
  });

  it("reports a null stats snapshot for a channel never refreshed", async () => {
    repository.getStats.mockResolvedValue(null);
    const response = await GET(request());
    const payload = await response.json() as { channels: Record<string, unknown>[] };

    expect(payload.channels[0]!.stats).toBeNull();
  });

  it("returns an empty list when no channel is connected", async () => {
    repository.listChannels.mockResolvedValue([]);
    const response = await GET(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ channels: [] });
    expect(repository.getStats).not.toHaveBeenCalled();
  });

  it("returns a stable application code without provider detail", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    repository.listChannels.mockRejectedValue(new AppError("YOUTUBE_PROVIDER_REJECTED", 502));

    const response = await GET(request());
    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ code: "YOUTUBE_PROVIDER_REJECTED" });
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("hides an unexpected failure behind INTERNAL_ERROR", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    repository.listChannels.mockRejectedValue(new Error("connection string postgres://secret"));

    const response = await GET(request());
    expect(response.status).toBe(500);
    const body = JSON.stringify(await response.json());
    expect(body).toBe('{"code":"INTERNAL_ERROR"}');
    expect(body).not.toContain("secret");
    expect(consoleError).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });
});
