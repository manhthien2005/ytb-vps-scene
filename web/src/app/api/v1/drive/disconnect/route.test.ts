import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/domain/errors";

const { currentAdmin, disconnectDrive } = vi.hoisted(() => ({
  currentAdmin: vi.fn(),
  disconnectDrive: vi.fn(),
}));
vi.mock("@/lib/auth/current-admin", () => ({ currentAdmin }));
vi.mock("@/lib/application/drive-connection", () => ({ disconnectDrive }));
vi.mock("@/lib/repositories/neon-drive-control-plane", () => ({
  createNeonDriveControlPlaneRepository: () => ({ kind: "repository" }),
}));
vi.mock("@/lib/adapters/google/oauth", () => ({
  createGoogleOAuthAdapter: () => ({ kind: "oauth" }),
}));
vi.mock("@/lib/adapters/google/drive-files", () => ({
  createGoogleDriveFilesAdapter: () => ({ kind: "files", deleteFile: vi.fn() }),
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
  return new NextRequest("http://localhost:3000/api/v1/drive/disconnect", {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      ...(contentLength === undefined ? {} : { "content-length": contentLength }),
    },
    body,
  });
}

describe("POST /api/v1/drive/disconnect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setEnv();
    currentAdmin.mockResolvedValue(true);
    disconnectDrive.mockResolvedValue({ status: "DISCONNECTED", extra: "must-not-leak" });
  });

  it("authenticates before Origin, body, or revoke work", async () => {
    currentAdmin.mockResolvedValue(false);
    const response = await POST(request("https://attacker.test", "not-json"));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ code: "AUTH_REQUIRED" });
    expect(disconnectDrive).not.toHaveBeenCalled();
  });

  it("checks exact Origin before the strict body or revoke work", async () => {
    const response = await POST(request("https://attacker.test", "not-json"));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ code: "ORIGIN_REJECTED" });
    expect(disconnectDrive).not.toHaveBeenCalled();
  });

  it.each([
    ["{\"extra\":true}", undefined, 400, "INVALID_REQUEST"],
    ["x".repeat(129), "1", 413, "REQUEST_TOO_LARGE"],
  ])("rejects invalid or streamed oversized bodies before revoke", async (
    body,
    contentLength,
    status,
    code,
  ) => {
    const response = await POST(request("http://localhost:3000", body, contentLength));
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ code });
    expect(disconnectDrive).not.toHaveBeenCalled();
  });

  it.each(["DISCONNECTED", "REVOKE_PENDING", "REAUTH_REQUIRED"])(
    "returns exactly sanitized status %s with no-store",
    async (status) => {
      disconnectDrive.mockResolvedValue({ status, extra: "must-not-leak" });
      const response = await POST(request());

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({ status });
    },
  );

  it("sanitizes known revoke failures without logging secrets", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    disconnectDrive.mockRejectedValue(new AppError("DRIVE_TEMPORARILY_UNAVAILABLE", 503));

    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await response.json())).toBe('{"code":"DRIVE_TEMPORARILY_UNAVAILABLE"}');
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
