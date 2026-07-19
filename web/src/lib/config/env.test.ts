import { describe, expect, it } from "vitest";
import { parseServerEnv } from "./env";

const cp2Valid = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://user:pass@example.neon.tech/app?sslmode=require",
  ADMIN_KEY_HASH: "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  SESSION_SECRET: "s".repeat(64),
  APP_ORIGIN: "https://example.vercel.app",
  GOOGLE_OAUTH_CLIENT_ID: "example-client-id",
  GOOGLE_OAUTH_CLIENT_SECRET: "example-client-secret",
  DRIVE_TOKEN_KEY_V1: "A".repeat(43),
  NEON_STORAGE_LIMIT_BYTES: "536870912",
  DRIVE_UPLOAD_MAX_BYTES: "10737418240",
  FREE_TIER_SOFT_PERCENT: "90",
  QUOTA_STALE_AFTER_SECONDS: "900",
};

describe("parseServerEnv", () => {
  it("accepts a production free-tier configuration", () => {
    expect(parseServerEnv(cp2Valid).appOrigin).toBe("https://example.vercel.app");
  });

  it("accepts the exact CP-2 production limits", () => {
    const env = parseServerEnv(cp2Valid);
    expect(env.driveUploadMaxBytes).toBe(10_737_418_240);
    expect(env.freeTierSoftPercent).toBe(90);
  });

  it("rejects an OpenAI API key to prevent separate billing", () => {
    expect(() => parseServerEnv({ ...cp2Valid, OPENAI_API_KEY: "forbidden" })).toThrow(
      "OPENAI_API_KEY is forbidden",
    );
  });

  it("rejects an insecure production origin", () => {
    expect(() => parseServerEnv({ ...cp2Valid, APP_ORIGIN: "http://example.test" })).toThrow(
      "APP_ORIGIN must use https",
    );
  });

  it.each([
    "argon2$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAA=$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAA",
  ])("rejects a noncanonical admin hash: %s", (adminKeyHash) => {
    expect(() => parseServerEnv({ ...cp2Valid, ADMIN_KEY_HASH: adminKeyHash })).toThrow();
  });

  it.each([
    ["DRIVE_TOKEN_KEY_V1", "not-canonical"],
    ["FREE_TIER_SOFT_PERCENT", "91"],
    ["QUOTA_STALE_AFTER_SECONDS", "901"],
  ])("rejects unsafe %s", (name, value) => {
    expect(() => parseServerEnv({ ...cp2Valid, [name]: value })).toThrow();
  });
});
