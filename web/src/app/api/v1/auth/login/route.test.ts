import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { repository, verifyAdminKey } = vi.hoisted(() => ({
  repository: {
    consumeLoginAttempt: vi.fn(),
    clearLoginAttempts: vi.fn(),
  },
  verifyAdminKey: vi.fn(),
}));
vi.mock("@/lib/auth/admin-key", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/admin-key")>()),
  verifyAdminKey,
}));
vi.mock("@/lib/repositories/neon-control-plane", () => ({
  createNeonControlPlaneRepository: () => repository,
}));

import { POST } from "./route";

describe("POST /api/v1/auth/login", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    Object.assign(process.env, {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://test:test@localhost/test",
      ADMIN_KEY_HASH: "scrypt$16384$8$1$AwMDAwMDAwMDAwMDAwMDAw$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      SESSION_SECRET: "s".repeat(64),
      APP_ORIGIN: "http://localhost:3000",
      GOOGLE_OAUTH_CLIENT_ID: "example-client-id",
      GOOGLE_OAUTH_CLIENT_SECRET: "example-client-secret",
      DRIVE_TOKEN_KEY_V1: "A".repeat(43),
      NEON_STORAGE_LIMIT_BYTES: "536870912",
      DRIVE_UPLOAD_MAX_BYTES: "10737418240",
      FREE_TIER_SOFT_PERCENT: "90",
      QUOTA_STALE_AFTER_SECONDS: "900",
      WORKER_AUTH_KEY_V1: "A".repeat(43),
      WORKER_RELEASE_REPOSITORY: "https://github.com/Vanvuong2005827/REUP-RENDER.git",
      WORKER_RELEASE_COMMIT: "a".repeat(40),
      WORKER_PIPELINE_BRIDGE_VERSION: "cp3-control-only",
    });
    delete process.env.OPENAI_API_KEY;
    repository.consumeLoginAttempt.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    repository.clearLoginAttempts.mockResolvedValue(undefined);
    verifyAdminKey.mockImplementation(async (candidate: string) => candidate === "correct private key");
  });

  function request(origin: string, key: string) {
    return rawRequest(origin, JSON.stringify({ key }));
  }

  function validLoginRequest() {
    return request("http://localhost:3000", "correct private key");
  }

  function rawRequest(origin: string, body: string, contentLength?: string) {
    return new NextRequest("http://localhost:3000/api/v1/auth/login", {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        "x-forwarded-for": "127.0.0.1",
        ...(contentLength === undefined ? {} : { "content-length": contentLength }),
      },
      body,
    });
  }

  it("rejects a cross-origin request before consuming an attempt", async () => {
    expect((await POST(request("https://attacker.test", "correct private key"))).status).toBe(403);
    expect(repository.consumeLoginAttempt).not.toHaveBeenCalled();
  });

  it("returns retry-after when the persistent limiter blocks", async () => {
    repository.consumeLoginAttempt.mockResolvedValue({ allowed: false, retryAfterSeconds: 900 });
    const response = await POST(request("http://localhost:3000", "correct private key"));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("900");
    expect(repository.clearLoginAttempts).not.toHaveBeenCalled();
  });

  it("rejects extra JSON fields before rate limiting or key derivation", async () => {
    const response = await POST(rawRequest(
      "http://localhost:3000",
      JSON.stringify({ key: "correct private key", extra: true }),
    ));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ code: "INVALID_REQUEST" });
    expect(repository.consumeLoginAttempt).not.toHaveBeenCalled();
    expect(verifyAdminKey).not.toHaveBeenCalled();
  });

  it("rejects an overlong admin key before rate limiting or scrypt", async () => {
    const response = await POST(request("http://localhost:3000", "k".repeat(257)));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ code: "INVALID_REQUEST" });
    expect(repository.consumeLoginAttempt).not.toHaveBeenCalled();
    expect(verifyAdminKey).not.toHaveBeenCalled();
  });

  it.each([undefined, "1"])(
    "rejects a streamed oversized body before rate limiting even with content-length %s",
    async (contentLength) => {
      const response = await POST(rawRequest(
        "http://localhost:3000",
        JSON.stringify({ key: "k", padding: "x".repeat(4096) }),
        contentLength,
      ));

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toEqual({ code: "REQUEST_TOO_LARGE" });
      expect(repository.consumeLoginAttempt).not.toHaveBeenCalled();
      expect(verifyAdminKey).not.toHaveBeenCalled();
    },
  );

  it("does not clear attempts after an invalid key", async () => {
    const response = await POST(request("http://localhost:3000", "wrong private key"));
    expect(response.status).toBe(401);
    expect(repository.clearLoginAttempts).not.toHaveBeenCalled();
  });

  it("sets a private session and clears failed attempts after a valid key", async () => {
    const response = await POST(request("http://localhost:3000", "correct private key"));
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(repository.clearLoginAttempts).toHaveBeenCalledOnce();
  });

  it("sets SameSite=Lax for the OAuth top-level callback", async () => {
    const response = await POST(validLoginRequest());
    expect(response.headers.get("set-cookie")).toContain("SameSite=lax");
  });

  it("sets every production session-cookie security attribute", async () => {
    Object.assign(process.env, {
      NODE_ENV: "production",
      APP_ORIGIN: "https://example.vercel.app",
    });
    const response = await POST(request("https://example.vercel.app", "correct private key"));
    const cookie = response.headers.get("set-cookie");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=43200");
  });
});
