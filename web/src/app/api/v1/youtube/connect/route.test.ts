import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/domain/errors";

const { beginYouTubeConnection, currentAdmin } = vi.hoisted(() => ({
  beginYouTubeConnection: vi.fn(),
  currentAdmin: vi.fn(),
}));
vi.mock("@/lib/auth/current-admin", () => ({ currentAdmin }));
vi.mock("@/lib/application/youtube-connection", () => ({ beginYouTubeConnection }));
vi.mock("@/lib/repositories/neon-youtube-control-plane", () => ({
  createNeonYouTubeControlPlaneRepository: () => ({ kind: "youtube-repository" }),
}));
vi.mock("@/lib/repositories/neon-drive-control-plane", () => ({
  createNeonDriveControlPlaneRepository: () => ({ kind: "states" }),
}));
vi.mock("@/lib/application/configured-youtube", () => ({
  createConfiguredYouTube: () => ({
    oauth: { kind: "oauth" },
    cipher: { kind: "cipher" },
    data: { kind: "data" },
    analytics: { kind: "analytics" },
  }),
}));

import { POST } from "./route";

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

function request(origin = "http://localhost:3000", body = "{}", contentLength?: string) {
  return new NextRequest("http://localhost:3000/api/v1/youtube/connect", {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      ...(contentLength === undefined ? {} : { "content-length": contentLength }),
    },
    body,
  });
}

describe("POST /api/v1/youtube/connect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv();
    currentAdmin.mockResolvedValue(true);
    beginYouTubeConnection.mockResolvedValue({
      authorizationUrl: "https://accounts.google.test/authorize",
      forbidden: "must-not-leak",
    });
  });

  it("authenticates before Origin, body, or provider work", async () => {
    currentAdmin.mockResolvedValue(false);
    const response = await POST(request("https://attacker.test", "not-json"));

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ code: "AUTH_REQUIRED" });
    expect(beginYouTubeConnection).not.toHaveBeenCalled();
  });

  it("requires the exact Origin before reading the body or calling providers", async () => {
    const response = await POST(request("https://attacker.test", "not-json"));

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ code: "ORIGIN_REJECTED" });
    expect(beginYouTubeConnection).not.toHaveBeenCalled();
  });

  it.each([
    ["{\"extra\":true}", undefined, 400, "INVALID_REQUEST"],
    ["x".repeat(129), "1", 413, "REQUEST_TOO_LARGE"],
  ])("rejects a non-empty or oversized body before providers", async (
    body,
    contentLength,
    status,
    code,
  ) => {
    const response = await POST(request("http://localhost:3000", body, contentLength));

    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ code });
    expect(beginYouTubeConnection).not.toHaveBeenCalled();
  });

  it("returns exactly authorizationUrl with no-store", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      authorizationUrl: "https://accounts.google.test/authorize",
    });
    expect(beginYouTubeConnection).toHaveBeenCalledOnce();
    expect(beginYouTubeConnection.mock.calls[0]![0]).toEqual({
      redirectUri: "http://localhost:3000/api/v1/youtube/callback",
      stateSecret: "s".repeat(64),
      now: expect.any(Date),
    });
  });

  it("passes both the YouTube repository and the shared oauth_states repository", async () => {
    await POST(request());

    expect(beginYouTubeConnection.mock.calls[0]![1]).toEqual({
      repository: { kind: "youtube-repository" },
      states: { kind: "states" },
      oauth: { kind: "oauth" },
      data: { kind: "data" },
      cipher: { kind: "cipher" },
    });
  });

  it("returns only a stable application code and emits no provider diagnostics", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    beginYouTubeConnection.mockRejectedValue(new AppError("YOUTUBE_PROVIDER_REJECTED", 502));

    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await response.json())).toBe('{"code":"YOUTUBE_PROVIDER_REJECTED"}');
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("hides an unexpected failure behind INTERNAL_ERROR", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    beginYouTubeConnection.mockRejectedValue(new Error("refresh_token=1//secret"));

    const response = await POST(request());
    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = JSON.stringify(await response.json());
    expect(body).toBe('{"code":"INTERNAL_ERROR"}');
    expect(body).not.toContain("secret");
    expect(consoleError).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });
});
