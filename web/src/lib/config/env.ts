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

export type ServerEnv = Readonly<{
  nodeEnv: "development" | "test" | "production";
  databaseUrl: string;
  adminKeyHash: string;
  sessionSecret: string;
  appOrigin: string;
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

  if (value.NODE_ENV === "production" && !value.APP_ORIGIN.startsWith("https://")) {
    throw new Error("APP_ORIGIN must use https in production");
  }

  return Object.freeze({
    nodeEnv: value.NODE_ENV,
    databaseUrl: value.DATABASE_URL,
    adminKeyHash: value.ADMIN_KEY_HASH,
    sessionSecret: value.SESSION_SECRET,
    appOrigin: value.APP_ORIGIN,
  });
}
