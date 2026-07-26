// Generates (once) and prints the throwaway environment the E2E rig runs with.
//   node env.mjs            -> JSON on stdout
//   node env.mjs --export   -> `export K=V` lines for `eval` in a shell
//
// Values are random per state directory and only ever used by the local rig.
import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const stateDir = process.env.FAKE_CLOUD_STATE ?? join(tmpdir(), "ytb-vps-e2e-cloud");
const target = join(stateDir, "env.json");
const port = process.env.FAKE_CLOUD_PORT ?? "4680";

async function adminKeyHash(key) {
  const salt = randomBytes(16);
  const digest = await scrypt(key, salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString("base64url")}$${digest.toString("base64url")}`;
}

async function generate() {
  const adminKey = `e2e-${randomBytes(18).toString("base64url")}`;
  return {
    ADMIN_KEY_PLAINTEXT: adminKey,
    ADMIN_KEY_HASH: await adminKeyHash(adminKey),
    SESSION_SECRET: randomBytes(48).toString("base64url"),
    DRIVE_TOKEN_KEY_V1: randomBytes(32).toString("base64url"),
    WORKER_AUTH_KEY_V1: randomBytes(32).toString("base64url"),
    DATABASE_URL: "postgresql://e2e:e2e@ep-e2e-fake.local.test/main",
    GOOGLE_OAUTH_CLIENT_ID: "e2e-fake-client-id.apps.googleusercontent.test",
    GOOGLE_OAUTH_CLIENT_SECRET: "e2e-fake-client-secret",
    NEON_STORAGE_LIMIT_BYTES: "536870912",
    DRIVE_UPLOAD_MAX_BYTES: "10737418240",
    FREE_TIER_SOFT_PERCENT: "90",
    QUOTA_STALE_AFTER_SECONDS: "900",
    WORKER_RELEASE_REPOSITORY: "https://github.com/manhthien2005/ytb-vps-scene.git",
    WORKER_PIPELINE_BRIDGE_VERSION: "cp4-media-v1",
    FAKE_CLOUD_ORIGIN: `http://127.0.0.1:${port}`,
    FAKE_CLOUD_PORT: String(port),
    FAKE_CLOUD_STATE: stateDir,
  };
}

mkdirSync(stateDir, { recursive: true });
const values = existsSync(target)
  ? JSON.parse(readFileSync(target, "utf8"))
  : await generate();
if (!existsSync(target)) writeFileSync(target, `${JSON.stringify(values, null, 2)}\n`, { mode: 0o600 });

if (process.argv.includes("--export")) {
  for (const [key, value] of Object.entries(values)) {
    process.stdout.write(`export ${key}='${String(value).replaceAll("'", "'\\''")}'\n`);
  }
} else {
  process.stdout.write(`${JSON.stringify(values, null, 2)}\n`);
}
