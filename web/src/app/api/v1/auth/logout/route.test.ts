import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { ADMIN_COOKIE } from "@/lib/auth/current-admin";
import { POST } from "./route";

describe("POST /api/v1/auth/logout", () => {
  beforeEach(() => {
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
  });

  function request(origin: string) {
    return new NextRequest("http://localhost:3000/api/v1/auth/logout", {
      method: "POST",
      headers: { origin },
    });
  }

  it("rejects a foreign origin without emitting a clearing cookie", async () => {
    const response = await POST(request("https://attacker.test"));
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("clears the private cookie for the exact application origin", async () => {
    const response = await POST(request("http://localhost:3000"));
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie");
    expect(cookie).toContain(`${ADMIN_COOKIE}=`);
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=lax");
    expect(cookie).toContain("Path=/");
  });
});
