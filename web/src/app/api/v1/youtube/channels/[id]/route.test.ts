import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/domain/errors";

const { currentAdmin, disconnectYouTubeChannel } = vi.hoisted(() => ({
  currentAdmin: vi.fn(),
  disconnectYouTubeChannel: vi.fn(),
}));
vi.mock("@/lib/auth/current-admin", () => ({ currentAdmin }));
vi.mock("@/lib/application/youtube-connection", () => ({ disconnectYouTubeChannel }));
vi.mock("@/lib/repositories/neon-youtube-control-plane", () => ({
  createNeonYouTubeControlPlaneRepository: () => ({ kind: "youtube-repository" }),
}));
vi.mock("@/lib/repositories/neon-drive-control-plane", () => ({
  createNeonDriveControlPlaneRepository: () => ({ kind: "states-repository" }),
}));
vi.mock("@/lib/application/configured-youtube", () => ({
  createConfiguredYouTube: () => ({
    oauth: { kind: "oauth" },
    cipher: { kind: "cipher" },
    data: { kind: "data" },
    analytics: { kind: "analytics" },
  }),
}));

import { DELETE } from "./route";

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

function request(origin = "http://localhost:3000") {
  return new NextRequest(`http://localhost:3000/api/v1/youtube/channels/${CHANNEL_UID}`, {
    method: "DELETE",
    headers: { origin },
  });
}

function context(id = CHANNEL_UID) {
  return { params: Promise.resolve({ id }) };
}

describe("DELETE /api/v1/youtube/channels/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv();
    currentAdmin.mockResolvedValue(true);
    disconnectYouTubeChannel.mockResolvedValue({ status: "DISCONNECTED" });
  });

  it("authenticates before Origin, the id, or provider work", async () => {
    currentAdmin.mockResolvedValue(false);
    const response = await DELETE(request("https://attacker.test"), context("not-a-uuid"));

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ code: "AUTH_REQUIRED" });
    expect(disconnectYouTubeChannel).not.toHaveBeenCalled();
  });

  it("requires the exact Origin before revoking anything", async () => {
    const response = await DELETE(request("https://attacker.test"), context());

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ code: "ORIGIN_REJECTED" });
    expect(disconnectYouTubeChannel).not.toHaveBeenCalled();
  });

  it("rejects a non-UUID channel id before provider work", async () => {
    const response = await DELETE(request(), context("../../etc/passwd"));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ code: "INVALID_REQUEST" });
    expect(disconnectYouTubeChannel).not.toHaveBeenCalled();
  });

  it("disconnects the channel and returns its terminal status", async () => {
    const response = await DELETE(request(), context());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ status: "DISCONNECTED" });
    expect(disconnectYouTubeChannel).toHaveBeenCalledOnce();
    expect(disconnectYouTubeChannel.mock.calls[0]![0]).toMatchObject({ id: CHANNEL_UID });
    expect(disconnectYouTubeChannel.mock.calls[0]![1]).toMatchObject({
      repository: { kind: "youtube-repository" },
      states: { kind: "states-repository" },
      oauth: { kind: "oauth" },
      cipher: { kind: "cipher" },
    });
  });

  it("returns 404 for a channel that does not exist", async () => {
    disconnectYouTubeChannel.mockRejectedValue(new AppError("YOUTUBE_CHANNEL_NOT_FOUND", 404));
    const response = await DELETE(request(), context());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ code: "YOUTUBE_CHANNEL_NOT_FOUND" });
  });

  it("surfaces a retryable revocation refusal as a provider code", async () => {
    disconnectYouTubeChannel.mockRejectedValue(new AppError("YOUTUBE_PROVIDER_REJECTED", 502));
    const response = await DELETE(request(), context());

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ code: "YOUTUBE_PROVIDER_REJECTED" });
  });

  it("hides an unexpected failure behind INTERNAL_ERROR", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    disconnectYouTubeChannel.mockRejectedValue(new Error("refresh_token=1//secret"));

    const response = await DELETE(request(), context());
    expect(response.status).toBe(500);
    const body = JSON.stringify(await response.json());
    expect(body).toBe('{"code":"INTERNAL_ERROR"}');
    expect(body).not.toContain("secret");
    consoleError.mockRestore();
  });
});
