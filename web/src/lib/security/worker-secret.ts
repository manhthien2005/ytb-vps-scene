import { createHmac, randomBytes } from "node:crypto";

const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const DOMAIN = Buffer.from("ytb-vps-worker-secret-v1\0", "utf8");

function decodeCanonical32(value: string, label: string): Buffer {
  if (!SECRET_PATTERN.test(value)) throw new Error(`${label} must be canonical base64url`);
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== value) {
    throw new Error(`${label} must encode exactly 32 bytes in canonical base64url`);
  }
  return bytes;
}

export function generateBearerSecret(random: (size: number) => Buffer = randomBytes): string {
  const bytes = random(32);
  if (bytes.length !== 32) throw new Error("Worker bearer entropy source must return exactly 32 bytes");
  return bytes.toString("base64url");
}

export function digestBearerSecret(secret: string, key: string): string {
  const secretBytes = decodeCanonical32(secret, "Worker bearer secret");
  const keyBytes = decodeCanonical32(key, "Worker authentication key");
  return createHmac("sha256", keyBytes).update(DOMAIN).update(secretBytes).digest("hex");
}
