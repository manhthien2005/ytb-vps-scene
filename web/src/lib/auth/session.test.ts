import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issueSession, verifySession } from "./session";

const secret = "x".repeat(64);
const now = new Date("2026-07-19T00:00:00Z");

function signClaims(claims: unknown): string {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

describe("admin session", () => {
  it("accepts a fresh signed token", () => {
    const token = issueSession(secret, now);
    expect(verifySession(token, secret, new Date("2026-07-19T11:59:59Z"))?.role).toBe("admin");
  });

  it("rejects tampering and a token at the twelve-hour expiry", () => {
    const token = issueSession(secret, now);
    expect(verifySession(`${token}x`, secret, now)).toBeNull();
    expect(verifySession(`${token}.extra`, secret, now)).toBeNull();
    expect(verifySession(token, secret, new Date("2026-07-19T12:00:00Z"))).toBeNull();
  });

  it("rejects signed payloads outside the session-claim format", () => {
    const token = signClaims({
      role: "admin",
      issuedAt: 0,
      expiresAt: Math.floor(now.getTime() / 1000) + 1,
      nonce: 42,
    });

    expect(verifySession(token, secret, now)).toBeNull();
  });
});
