import { describe, expect, it } from "vitest";
import { parseServerEnv } from "./env";

const valid = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://user:pass@example.neon.tech/app?sslmode=require",
  ADMIN_KEY_HASH: "scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  SESSION_SECRET: "s".repeat(64),
  APP_ORIGIN: "https://example.vercel.app",
};

describe("parseServerEnv", () => {
  it("accepts a production free-tier configuration", () => {
    expect(parseServerEnv(valid).appOrigin).toBe("https://example.vercel.app");
  });

  it("rejects an OpenAI API key to prevent separate billing", () => {
    expect(() => parseServerEnv({ ...valid, OPENAI_API_KEY: "forbidden" })).toThrow(
      "OPENAI_API_KEY is forbidden",
    );
  });

  it("rejects an insecure production origin", () => {
    expect(() => parseServerEnv({ ...valid, APP_ORIGIN: "http://example.test" })).toThrow(
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
    expect(() => parseServerEnv({ ...valid, ADMIN_KEY_HASH: adminKeyHash })).toThrow();
  });
});
