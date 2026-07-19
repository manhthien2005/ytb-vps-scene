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
    APP_ORIGIN: z.string().url(),
  })
  .strict();

const cp2Schema = z.object({
  GOOGLE_OAUTH_CLIENT_ID: z.string().trim().min(1).max(512),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1).max(4096),
  DRIVE_TOKEN_KEY_V1: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  NEON_STORAGE_LIMIT_BYTES: z.coerce.number().int().positive().max(536_870_912),
  DRIVE_UPLOAD_MAX_BYTES: z.coerce.number().int().positive().max(10_737_418_240),
  FREE_TIER_SOFT_PERCENT: z.coerce.number().int().min(50).max(90),
  QUOTA_STALE_AFTER_SECONDS: z.coerce.number().int().min(60).max(900),
});

function decodeDriveKey(value: string): Uint8Array {
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== value) {
    throw new Error("DRIVE_TOKEN_KEY_V1 must encode exactly 32 bytes");
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
  neonStorageLimitBytes: number;
  driveUploadMaxBytes: number;
  freeTierSoftPercent: number;
  quotaStaleAfterSeconds: number;
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
  const cp2 = cp2Schema.parse({
    GOOGLE_OAUTH_CLIENT_ID: source.GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: source.GOOGLE_OAUTH_CLIENT_SECRET,
    DRIVE_TOKEN_KEY_V1: source.DRIVE_TOKEN_KEY_V1,
    NEON_STORAGE_LIMIT_BYTES: source.NEON_STORAGE_LIMIT_BYTES,
    DRIVE_UPLOAD_MAX_BYTES: source.DRIVE_UPLOAD_MAX_BYTES,
    FREE_TIER_SOFT_PERCENT: source.FREE_TIER_SOFT_PERCENT,
    QUOTA_STALE_AFTER_SECONDS: source.QUOTA_STALE_AFTER_SECONDS,
  });
  decodeDriveKey(cp2.DRIVE_TOKEN_KEY_V1);

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
    neonStorageLimitBytes: cp2.NEON_STORAGE_LIMIT_BYTES,
    driveUploadMaxBytes: cp2.DRIVE_UPLOAD_MAX_BYTES,
    freeTierSoftPercent: cp2.FREE_TIER_SOFT_PERCENT,
    quotaStaleAfterSeconds: cp2.QUOTA_STALE_AFTER_SECONDS,
  });
}
