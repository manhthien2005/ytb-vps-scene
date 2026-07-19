import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback) as (
  key: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
) => Promise<Buffer>;
const N = 16_384;
const r = 8;
const p = 1;
const length = 32;

export async function encodeAdminKey(key: string, salt = randomBytes(16)): Promise<string> {
  const digest = (await scrypt(key, salt, length, {
    N,
    r,
    p,
    maxmem: 64 * 1024 * 1024,
  })) as Buffer;
  return `scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${digest.toString("base64url")}`;
}

function decodeBase64url(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;

  const decoded = Buffer.from(value, "base64url");
  return decoded.toString("base64url") === value ? decoded : null;
}

export async function verifyAdminKey(candidate: string, encoded: string): Promise<boolean> {
  try {
    const parts = encoded.split("$");
    if (parts.length !== 6) return false;

    const [name, n, rr, pp, saltText, digestText] = parts;
    if (
      name !== "scrypt" ||
      n !== String(N) ||
      rr !== String(r) ||
      pp !== String(p) ||
      !saltText ||
      !digestText
    ) {
      return false;
    }

    const salt = decodeBase64url(saltText);
    const expected = decodeBase64url(digestText);
    if (!salt || salt.length !== 16 || !expected || expected.length !== length) return false;

    const actual = (await scrypt(candidate, salt, length, {
      N,
      r,
      p,
      maxmem: 64 * 1024 * 1024,
    })) as Buffer;

    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}
