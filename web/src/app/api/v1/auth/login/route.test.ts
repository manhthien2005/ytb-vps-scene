import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAdminKey } from "@/lib/auth/admin-key";

const { repository } = vi.hoisted(() => ({
  repository: {
    consumeLoginAttempt: vi.fn(),
    clearLoginAttempts: vi.fn(),
  },
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
      ADMIN_KEY_HASH: await encodeAdminKey("correct private key", Buffer.alloc(16, 3)),
      SESSION_SECRET: "s".repeat(64),
      APP_ORIGIN: "http://localhost:3000",
    });
    delete process.env.OPENAI_API_KEY;
    repository.consumeLoginAttempt.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    repository.clearLoginAttempts.mockResolvedValue(undefined);
  });

  function request(origin: string, key: string) {
    return new NextRequest("http://localhost:3000/api/v1/auth/login", {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/json",
        "x-forwarded-for": "127.0.0.1",
      },
      body: JSON.stringify({ key }),
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

  it("sets every production session-cookie security attribute", async () => {
    Object.assign(process.env, {
      NODE_ENV: "production",
      APP_ORIGIN: "https://example.vercel.app",
    });
    const response = await POST(request("https://example.vercel.app", "correct private key"));
    const cookie = response.headers.get("set-cookie");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=43200");
  });
});
