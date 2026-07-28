import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/domain/errors";

const { currentAdmin, refreshChannelStats } = vi.hoisted(() => ({
  currentAdmin: vi.fn(),
  refreshChannelStats: vi.fn(),
}));
vi.mock("@/lib/auth/current-admin", () => ({ currentAdmin }));
vi.mock("@/lib/application/youtube-stats", () => ({ refreshChannelStats }));
vi.mock("@/lib/repositories/neon-youtube-control-plane", () => ({
  createNeonYouTubeControlPlaneRepository: () => ({ kind: "youtube-repository" }),
}));
vi.mock("@/lib/application/configured-youtube", () => ({
  createConfiguredYouTube: () => ({
    oauth: { kind: "oauth" },
    cipher: { kind: "cipher" },
    data: { kind: "data" },
    analytics: { kind: "analytics" },
  }),
}));

import { maxDuration, POST } from "./route";

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

function request(origin = "http://localhost:3000", body = "{}") {
  return new NextRequest(
    `http://localhost:3000/api/v1/youtube/channels/${CHANNEL_UID}/refresh`,
    { method: "POST", headers: { origin, "content-type": "application/json" }, body },
  );
}

function context(id = CHANNEL_UID) {
  return { params: Promise.resolve({ id }) };
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

describe("POST /api/v1/youtube/channels/[id]/refresh", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv();
    currentAdmin.mockResolvedValue(true);
    refreshChannelStats.mockResolvedValue(stats());
  });

  // A full refresh makes up to 20 paginated Data API calls plus an Analytics query,
  // which exceeds the platform's default serverless budget.
  it("declares a raised duration budget for the multi-call refresh", () => {
    expect(maxDuration).toBe(30);
  });

  it("authenticates before Origin, the id, or provider work", async () => {
    currentAdmin.mockResolvedValue(false);
    const response = await POST(request("https://attacker.test", "not-json"), context("nope"));

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ code: "AUTH_REQUIRED" });
    expect(refreshChannelStats).not.toHaveBeenCalled();
  });

  it("requires the exact Origin before spending quota", async () => {
    const response = await POST(request("https://attacker.test"), context());

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ code: "ORIGIN_REJECTED" });
    expect(refreshChannelStats).not.toHaveBeenCalled();
  });

  it("rejects a non-UUID channel id before spending quota", async () => {
    const response = await POST(request(), context("not-a-uuid"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ code: "INVALID_REQUEST" });
    expect(refreshChannelStats).not.toHaveBeenCalled();
  });

  it("returns the refreshed snapshot", async () => {
    const response = await POST(request(), context());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ stats: stats() });
    expect(refreshChannelStats).toHaveBeenCalledOnce();
    expect(refreshChannelStats.mock.calls[0]![0]).toMatchObject({ id: CHANNEL_UID });
    expect(refreshChannelStats.mock.calls[0]![1]).toMatchObject({
      repository: { kind: "youtube-repository" },
      oauth: { kind: "oauth" },
      cipher: { kind: "cipher" },
      data: { kind: "data" },
      analytics: { kind: "analytics" },
    });
  });

  it("returns 404 for a channel that does not exist", async () => {
    refreshChannelStats.mockRejectedValue(new AppError("YOUTUBE_CHANNEL_NOT_FOUND", 404));
    const response = await POST(request(), context());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ code: "YOUTUBE_CHANNEL_NOT_FOUND" });
  });

  it("surfaces a reauthentication demand so the UI can prompt a reconnect", async () => {
    refreshChannelStats.mockRejectedValue(new AppError("YOUTUBE_REAUTH_REQUIRED", 401));
    const response = await POST(request(), context());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ code: "YOUTUBE_REAUTH_REQUIRED" });
  });

  it("hides an unexpected failure behind INTERNAL_ERROR", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    refreshChannelStats.mockRejectedValue(new Error("access_token=ya29.secret"));

    const response = await POST(request(), context());
    expect(response.status).toBe(500);
    const body = JSON.stringify(await response.json());
    expect(body).toBe('{"code":"INTERNAL_ERROR"}');
    expect(body).not.toContain("secret");
    consoleError.mockRestore();
  });
});
