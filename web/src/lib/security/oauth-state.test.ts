// @vitest-environment node
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issueOAuthState, verifyOAuthState } from "./oauth-state";

const SECRET = "state-signing-secret";
const NOW = new Date("2026-07-19T00:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const NONCE = Buffer.alloc(32, 9).toString("base64url");
const PREFIX = "ytb-vps:oauth-state:v1:";

function signPayloadText(payloadText: string): string {
  const payload = Buffer.from(payloadText, "utf8").toString("base64url");
  const signature = createHmac("sha256", SECRET)
    .update(PREFIX + payload, "utf8")
    .digest("base64url");
  return `${payload}.${signature}`;
}

function signClaims(claims: unknown): string {
  return signPayloadText(JSON.stringify(claims));
}

function validClaims(): Record<string, unknown> {
  return { v: 1, nonce: NONCE, iat: NOW_SECONDS, exp: NOW_SECONDS + 600, returnPath: "/" };
}

describe("OAuth state", () => {
  it("issues the exact compact canonical state and verifies it", () => {
    const token = issueOAuthState(SECRET, NOW, NONCE);
    const [payload, signature] = token.split(".");

    expect(Buffer.from(payload!, "base64url").toString("utf8")).toBe(
      JSON.stringify(validClaims()),
    );
    expect(signature).toBe(
      createHmac("sha256", SECRET).update(PREFIX + payload!, "utf8").digest("base64url"),
    );
    expect(verifyOAuthState(SECRET, token, NOW)).toEqual(validClaims());
  });

  it("rejects an expired or future-issued state", () => {
    const token = issueOAuthState(SECRET, NOW, NONCE);

    expect(() => verifyOAuthState(
      SECRET,
      token,
      new Date(NOW.getTime() + 11 * 60 * 1000),
    )).toThrow("OAUTH_STATE_EXPIRED");
    expect(() => verifyOAuthState(
      SECRET,
      token,
      new Date(NOW.getTime() - 60 * 1000),
    )).toThrow("OAUTH_STATE_INVALID");
  });

  it("accepts the last second and expires exactly at exp", () => {
    const token = issueOAuthState(SECRET, NOW, NONCE);

    expect(() => verifyOAuthState(
      SECRET,
      token,
      new Date((NOW_SECONDS + 599) * 1000),
    )).not.toThrow();
    expect(() => verifyOAuthState(
      SECRET,
      token,
      new Date((NOW_SECONDS + 600) * 1000),
    )).toThrow("OAUTH_STATE_EXPIRED");
  });

  it.each([
    ["version", { v: 2 }],
    ["return path", { returnPath: "/admin" }],
    ["lifetime", { exp: NOW_SECONDS + 601 }],
    ["fractional iat", { iat: NOW_SECONDS + 0.5, exp: NOW_SECONDS + 600.5 }],
    ["unsafe exp", { exp: Number.MAX_SAFE_INTEGER + 1 }],
    ["negative iat", { iat: -1, exp: 599 }],
    ["short nonce", { nonce: Buffer.alloc(31).toString("base64url") }],
    ["noncanonical nonce", { nonce: `${NONCE}=` }],
  ])("rejects a signed payload with an invalid %s", (_case, replacement) => {
    expect(() => verifyOAuthState(
      SECRET,
      signClaims({ ...validClaims(), ...replacement }),
      NOW,
    )).toThrow("OAUTH_STATE_INVALID");
  });

  it.each([
    ["missing claim", JSON.stringify((() => {
      const claims = validClaims();
      delete claims.exp;
      return claims;
    })())],
    ["extra claim", JSON.stringify({ ...validClaims(), extra: true })],
    ["wrong claim order", JSON.stringify({ nonce: NONCE, v: 1, iat: NOW_SECONDS, exp: NOW_SECONDS + 600, returnPath: "/" })],
    ["whitespace", JSON.stringify(validClaims(), null, 2)],
    ["duplicate claim", `{"v":1,"v":1,"nonce":"${NONCE}","iat":${NOW_SECONDS},"exp":${NOW_SECONDS + 600},"returnPath":"/"}`],
  ])("rejects noncanonical JSON with a %s", (_case, payloadText) => {
    expect(() => verifyOAuthState(SECRET, signPayloadText(payloadText), NOW))
      .toThrow("OAUTH_STATE_INVALID");
  });

  it.each([
    ["wrong signature", (token: string) => `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`],
    ["short signature", (token: string) => token.slice(0, -1)],
    ["padded payload", (token: string) => token.replace(".", "=.")],
    ["extra segment", (token: string) => `${token}.extra`],
  ])("rejects a malformed token with a %s", (_case, mutate) => {
    const token = issueOAuthState(SECRET, NOW, NONCE);
    expect(() => verifyOAuthState(SECRET, mutate(token), NOW)).toThrow("OAUTH_STATE_INVALID");
  });

  it("rejects invalid issue inputs", () => {
    expect(() => issueOAuthState(SECRET, new Date(Number.NaN), NONCE))
      .toThrow("OAUTH_STATE_INVALID");
    expect(() => issueOAuthState(SECRET, NOW, Buffer.alloc(31).toString("base64url")))
      .toThrow("OAUTH_STATE_INVALID");
  });

  it("rejects an oversized token", () => {
    expect(() => verifyOAuthState(SECRET, `${"A".repeat(10_000)}.${"A".repeat(43)}`, NOW))
      .toThrow("OAUTH_STATE_INVALID");
  });
});
