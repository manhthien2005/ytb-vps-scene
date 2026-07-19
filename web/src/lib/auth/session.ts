import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export type SessionClaims = Readonly<{
  role: "admin";
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}>;

const sessionLifetimeSeconds = 12 * 60 * 60;

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function isSessionClaims(value: unknown): value is SessionClaims {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

  const claims = value as Record<string, unknown>;
  return (
    claims.role === "admin" &&
    typeof claims.issuedAt === "number" &&
    typeof claims.expiresAt === "number" &&
    Number.isSafeInteger(claims.issuedAt) &&
    Number.isSafeInteger(claims.expiresAt) &&
    claims.expiresAt === claims.issuedAt + sessionLifetimeSeconds &&
    typeof claims.nonce === "string"
  );
}

export function issueSession(secret: string, now = new Date()): string {
  const issuedAt = Math.floor(now.getTime() / 1000);
  const claims: SessionClaims = {
    role: "admin",
    issuedAt,
    expiresAt: issuedAt + sessionLifetimeSeconds,
    nonce: randomUUID(),
  };
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  return `${payload}.${sign(payload, secret)}`;
}

export function verifySession(token: string, secret: string, now = new Date()): SessionClaims | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 2) return null;

    const [payload, signature] = parts;
    if (!payload || !signature) return null;

    const expected = Buffer.from(sign(payload, secret));
    const received = Buffer.from(signature);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;

    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!isSessionClaims(claims)) return null;

    const current = Math.floor(now.getTime() / 1000);
    return claims.role === "admin" && claims.issuedAt <= current && current < claims.expiresAt
      ? claims
      : null;
  } catch {
    return null;
  }
}
