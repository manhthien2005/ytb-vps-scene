import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/domain/errors";

const { beginDriveConnection, currentAdmin } = vi.hoisted(() => ({
  beginDriveConnection: vi.fn(),
  currentAdmin: vi.fn(),
}));
vi.mock("@/lib/auth/current-admin", () => ({ currentAdmin }));
vi.mock("@/lib/application/drive-connection", () => ({ beginDriveConnection }));
vi.mock("@/lib/repositories/neon-drive-control-plane", () => ({
  createNeonDriveControlPlaneRepository: () => ({ kind: "repository" }),
}));
vi.mock("@/lib/adapters/google/oauth", () => ({
  createGoogleOAuthAdapter: () => ({ kind: "oauth" }),
}));
vi.mock("@/lib/adapters/google/drive-files", () => ({
  createGoogleDriveFilesAdapter: () => ({ kind: "files" }),
}));
vi.mock("@/lib/security/credential-cipher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/credential-cipher")>()),
  createCredentialCipher: () => ({ kind: "cipher" }),
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
  return new NextRequest("http://localhost:3000/api/v1/drive/connect", {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      ...(contentLength === undefined ? {} : { "content-length": contentLength }),
    },
    body,
  });
}

describe("POST /api/v1/drive/connect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv();
    currentAdmin.mockResolvedValue(true);
    beginDriveConnection.mockResolvedValue({
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
    expect(beginDriveConnection).not.toHaveBeenCalled();
  });

  it("requires the exact Origin before reading the body or calling providers", async () => {
    const response = await POST(request("https://attacker.test", "not-json"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ code: "ORIGIN_REJECTED" });
    expect(beginDriveConnection).not.toHaveBeenCalled();
  });

  it.each([
    ["{\"extra\":true}", undefined, 400, "INVALID_REQUEST"],
    ["x".repeat(129), "1", 413, "REQUEST_TOO_LARGE"],
  ])("rejects a non-empty or streamed oversized body before providers", async (
    body,
    contentLength,
    status,
    code,
  ) => {
    const response = await POST(request("http://localhost:3000", body, contentLength));

    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ code });
    expect(beginDriveConnection).not.toHaveBeenCalled();
  });

  it("returns exactly authorizationUrl with no-store", async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      authorizationUrl: "https://accounts.google.test/authorize",
    });
    expect(beginDriveConnection).toHaveBeenCalledOnce();
    expect(beginDriveConnection.mock.calls[0]![0]).toMatchObject({
      redirectUri: "http://localhost:3000/api/v1/drive/callback",
      stateSecret: "s".repeat(64),
    });
  });

  it("returns only a stable application code and emits no provider diagnostics", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    beginDriveConnection.mockRejectedValue(new AppError("DRIVE_PROVIDER_REJECTED", 502));

    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = JSON.stringify(await response.json());
    expect(body).toBe('{"code":"DRIVE_PROVIDER_REJECTED"}');
    expect(body).not.toContain("provider diagnostic");
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
