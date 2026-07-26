import { z } from "zod";
import { parseAdminKeyHash } from "@/lib/auth/admin-key";

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]),
    DATABASE_URL: z.string().url().startsWith("postgresql://"),
    ADMIN_KEY_HASH: z.string().refine((value) => parseAdminKeyHash(value) !== null, {
      message: "ADMIN_KEY_HASH must be a canonical supported scrypt hash",
    }),
    SESSION_SECRET: z.string().min(64),
    APP_ORIGIN: z.string().url().refine((value) => value === new URL(value).origin, {
      message: "APP_ORIGIN must be a canonical origin",
    }),
  })
  .strict();

const cp2Schema = z.object({
  GOOGLE_OAUTH_CLIENT_ID: z.string().trim().min(1).max(512),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1).max(4096),
  DRIVE_TOKEN_KEY_V1: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  YOUTUBE_TOKEN_KEY_V1: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  NEON_STORAGE_LIMIT_BYTES: z.coerce.number().int().positive().max(536_870_912),
  DRIVE_UPLOAD_MAX_BYTES: z.coerce.number().int().positive().max(10_737_418_240),
  FREE_TIER_SOFT_PERCENT: z.coerce.number().int().min(50).max(90),
  QUOTA_STALE_AFTER_SECONDS: z.coerce.number().int().min(60).max(900),
  WORKER_AUTH_KEY_V1: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  WORKER_RELEASE_REPOSITORY: z.string().url().refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" &&
      url.port === "" && url.username === "" && url.password === "" &&
      url.search === "" && url.hash === "" &&
      /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git$/.test(url.pathname);
  }, "WORKER_RELEASE_REPOSITORY must be a credential-free HTTPS GitHub repository"),
  WORKER_RELEASE_COMMIT: z.string().regex(/^[0-9a-f]{40}$/),
  WORKER_PIPELINE_BRIDGE_VERSION: z.string().min(1).max(80).regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/),
});

function decodeDriveKey(value: string): Uint8Array {
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== value) {
    throw new Error("DRIVE_TOKEN_KEY_V1 must encode exactly 32 bytes");
  }
  return bytes;
}

function decodeWorkerKey(value: string): Uint8Array {
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== value) {
    throw new Error("WORKER_AUTH_KEY_V1 must encode exactly 32 bytes");
  }
  return bytes;
}

function decodeYoutubeKey(value: string): Uint8Array {
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== value) {
    throw new Error("YOUTUBE_TOKEN_KEY_V1 must encode exactly 32 bytes");
  }
  return bytes;
}

export type ServerEnv = Readonly<{
  nodeEnv: "development" | "test" | "production";
  databaseUrl: string;
  adminKeyHash: string;
  sessionSecret: string;
  appOrigin: string;
  googleOAuthClientId: string;
  googleOAuthClientSecret: string;
  driveTokenKeyV1: string;
  youtubeTokenKeyV1: string;
  neonStorageLimitBytes: number;
  driveUploadMaxBytes: number;
  freeTierSoftPercent: number;
  quotaStaleAfterSeconds: number;
  workerAuthKeyV1: string;
  workerReleaseRepository: string;
  workerReleaseCommit: string;
  workerPipelineBridgeVersion: string;
}>;

export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  for (const name of ["OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "CODEX_API_KEY"] as const) {
    if (source[name]) throw new Error(`${name} is forbidden: Codex must use ChatGPT login`);
  }

  const value = schema.parse({
    NODE_ENV: source.NODE_ENV,
    DATABASE_URL: source.DATABASE_URL,
    ADMIN_KEY_HASH: source.ADMIN_KEY_HASH,
    SESSION_SECRET: source.SESSION_SECRET,
    APP_ORIGIN: source.APP_ORIGIN,
  });
  const tokenDefaults = value.NODE_ENV === "production" ? {} : {
    YOUTUBE_TOKEN_KEY_V1: "A".repeat(43),
  };
  const workerDefaults = value.NODE_ENV === "production" ? {} : {
    WORKER_AUTH_KEY_V1: "A".repeat(43),
    WORKER_RELEASE_REPOSITORY: "https://github.com/manhthien2005/ytb-vps-scene.git",
    WORKER_RELEASE_COMMIT: "0".repeat(40),
    WORKER_PIPELINE_BRIDGE_VERSION: "cp4-media-v1",
  };
  const cp2 = cp2Schema.parse({
    GOOGLE_OAUTH_CLIENT_ID: source.GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: source.GOOGLE_OAUTH_CLIENT_SECRET,
    DRIVE_TOKEN_KEY_V1: source.DRIVE_TOKEN_KEY_V1,
    YOUTUBE_TOKEN_KEY_V1: source.YOUTUBE_TOKEN_KEY_V1 ?? tokenDefaults.YOUTUBE_TOKEN_KEY_V1,
    NEON_STORAGE_LIMIT_BYTES: source.NEON_STORAGE_LIMIT_BYTES,
    DRIVE_UPLOAD_MAX_BYTES: source.DRIVE_UPLOAD_MAX_BYTES,
    FREE_TIER_SOFT_PERCENT: source.FREE_TIER_SOFT_PERCENT,
    QUOTA_STALE_AFTER_SECONDS: source.QUOTA_STALE_AFTER_SECONDS,
    WORKER_AUTH_KEY_V1: source.WORKER_AUTH_KEY_V1 ?? workerDefaults.WORKER_AUTH_KEY_V1,
    WORKER_RELEASE_REPOSITORY: source.WORKER_RELEASE_REPOSITORY ?? workerDefaults.WORKER_RELEASE_REPOSITORY,
    WORKER_RELEASE_COMMIT: source.WORKER_RELEASE_COMMIT ?? workerDefaults.WORKER_RELEASE_COMMIT,
    WORKER_PIPELINE_BRIDGE_VERSION: source.WORKER_PIPELINE_BRIDGE_VERSION ?? workerDefaults.WORKER_PIPELINE_BRIDGE_VERSION,
  });
  decodeDriveKey(cp2.DRIVE_TOKEN_KEY_V1);
  decodeYoutubeKey(cp2.YOUTUBE_TOKEN_KEY_V1);
  decodeWorkerKey(cp2.WORKER_AUTH_KEY_V1);

  if (value.NODE_ENV === "production" && !value.APP_ORIGIN.startsWith("https://")) {
    throw new Error("APP_ORIGIN must use https in production");
  }

  return Object.freeze({
    nodeEnv: value.NODE_ENV,
    databaseUrl: value.DATABASE_URL,
    adminKeyHash: value.ADMIN_KEY_HASH,
    sessionSecret: value.SESSION_SECRET,
    appOrigin: value.APP_ORIGIN,
    googleOAuthClientId: cp2.GOOGLE_OAUTH_CLIENT_ID,
    googleOAuthClientSecret: cp2.GOOGLE_OAUTH_CLIENT_SECRET,
    driveTokenKeyV1: cp2.DRIVE_TOKEN_KEY_V1,
    youtubeTokenKeyV1: cp2.YOUTUBE_TOKEN_KEY_V1,
    neonStorageLimitBytes: cp2.NEON_STORAGE_LIMIT_BYTES,
    driveUploadMaxBytes: cp2.DRIVE_UPLOAD_MAX_BYTES,
    freeTierSoftPercent: cp2.FREE_TIER_SOFT_PERCENT,
    quotaStaleAfterSeconds: cp2.QUOTA_STALE_AFTER_SECONDS,
    workerAuthKeyV1: cp2.WORKER_AUTH_KEY_V1,
    workerReleaseRepository: cp2.WORKER_RELEASE_REPOSITORY,
    workerReleaseCommit: cp2.WORKER_RELEASE_COMMIT,
    workerPipelineBridgeVersion: cp2.WORKER_PIPELINE_BRIDGE_VERSION,
  });
}
