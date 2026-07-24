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
  WORKER_AUTH_KEY_V1: "A".repeat(43),
  WORKER_RELEASE_REPOSITORY: "https://github.com/manhthien2005/ytb-vps-scene.git",
  WORKER_RELEASE_COMMIT: "a".repeat(40),
  WORKER_PIPELINE_BRIDGE_VERSION: "cp4-media-v1",
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

  it("accepts the canonical worker release and security configuration", () => {
    const env = parseServerEnv(cp2Valid);
    expect(env.workerAuthKeyV1).toHaveLength(43);
    expect(env.workerReleaseRepository).toBe("https://github.com/manhthien2005/ytb-vps-scene.git");
    expect(env.workerReleaseCommit).toHaveLength(40);
    expect(env.workerPipelineBridgeVersion).toBe("cp4-media-v1");
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
    "https://example.vercel.app/path",
    "https://example.vercel.app?query=value",
    "https://example.vercel.app/",
    "https://user:password@example.vercel.app",
  ])("rejects a non-origin APP_ORIGIN: %s", (appOrigin) => {
    expect(() => parseServerEnv({ ...cp2Valid, APP_ORIGIN: appOrigin })).toThrow();
  });

  it.each(["development", "test"] as const)(
    "accepts a localhost HTTP origin in %s",
    (nodeEnv) => {
      expect(parseServerEnv({
        ...cp2Valid,
        NODE_ENV: nodeEnv,
        APP_ORIGIN: "http://localhost:3000",
      }).appOrigin).toBe("http://localhost:3000");
    },
  );

  it("rejects a worker release repository with a non-default port", () => {
    expect(() => parseServerEnv({
      ...cp2Valid,
      WORKER_RELEASE_REPOSITORY: "https://github.com:444/example/repo.git",
    })).toThrow();
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
    ["WORKER_AUTH_KEY_V1", "not-canonical"],
    ["WORKER_RELEASE_REPOSITORY", "https://gitlab.com/example/repo.git"],
    ["WORKER_RELEASE_COMMIT", "A".repeat(40)],
    ["WORKER_PIPELINE_BRIDGE_VERSION", "contains spaces"],
  ])("rejects unsafe %s", (name, value) => {
    expect(() => parseServerEnv({ ...cp2Valid, [name]: value })).toThrow();
  });
});
