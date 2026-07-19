import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";
import { AppError } from "@/lib/domain/errors";

const STATE_PREFIX = "ytb-vps:oauth-state:v1:";
const STATE_LIFETIME_SECONDS = 600;
const NONCE_BYTES = 32;
const MAX_STATE_TOKEN_LENGTH = 256;
const CLAIM_KEYS = ["v", "nonce", "iat", "exp", "returnPath"] as const;

export type OAuthState = Readonly<{
  v: 1;
  nonce: string;
  iat: number;
  exp: number;
  returnPath: "/";
}>;

function invalidState(): AppError {
  return new AppError("OAUTH_STATE_INVALID", 400);
}

function decodeCanonicalBase64url(value: unknown, expectedBytes?: number): Buffer | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.toString("base64url") !== value ||
    (expectedBytes !== undefined && decoded.length !== expectedBytes)
  ) {
    return null;
  }
  return decoded;
}

function canonicalJson(state: OAuthState): string {
  return JSON.stringify({
    v: state.v,
    nonce: state.nonce,
    iat: state.iat,
    exp: state.exp,
    returnPath: state.returnPath,
  });
}

function sign(secret: string, payloadSegment: string): Buffer {
  return createHmac("sha256", secret)
    .update(STATE_PREFIX + payloadSegment, "utf8")
    .digest();
}

function validUnixSecond(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseCanonicalState(payloadBytes: Buffer): OAuthState | null {
  const payloadText = payloadBytes.toString("utf8");
  const parsed: unknown = JSON.parse(payloadText);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;

  const claims = parsed as Record<string, unknown>;
  const keys = Object.keys(claims);
  if (
    keys.length !== CLAIM_KEYS.length ||
    !keys.every((key, index) => key === CLAIM_KEYS[index]) ||
    claims.v !== 1 ||
    claims.returnPath !== "/" ||
    !validUnixSecond(claims.iat) ||
    !validUnixSecond(claims.exp) ||
    claims.exp !== claims.iat + STATE_LIFETIME_SECONDS ||
    typeof claims.nonce !== "string" ||
    !decodeCanonicalBase64url(claims.nonce, NONCE_BYTES)
  ) {
    return null;
  }

  const state: OAuthState = {
    v: 1,
    nonce: claims.nonce,
    iat: claims.iat,
    exp: claims.exp,
    returnPath: "/",
  };
  return canonicalJson(state) === payloadText ? state : null;
}

export function issueOAuthState(secret: string, now: Date, nonce: string): string {
  const iat = Math.floor(now.getTime() / 1000);
  if (!validUnixSecond(iat) || !decodeCanonicalBase64url(nonce, NONCE_BYTES)) {
    throw invalidState();
  }

  const state: OAuthState = {
    v: 1,
    nonce,
    iat,
    exp: iat + STATE_LIFETIME_SECONDS,
    returnPath: "/",
  };
  if (!validUnixSecond(state.exp)) throw invalidState();

  const payloadSegment = Buffer.from(canonicalJson(state), "utf8").toString("base64url");
  const signatureSegment = sign(secret, payloadSegment).toString("base64url");
  return `${payloadSegment}.${signatureSegment}`;
}

export function verifyOAuthState(secret: string, token: string, now: Date): OAuthState {
  try {
    if (typeof token !== "string" || token.length > MAX_STATE_TOKEN_LENGTH) {
      throw invalidState();
    }
    const parts = token.split(".");
    if (parts.length !== 2) throw invalidState();

    const [payloadSegment, signatureSegment] = parts;
    const payloadBytes = decodeCanonicalBase64url(payloadSegment);
    const receivedSignature = decodeCanonicalBase64url(signatureSegment, 32);
    if (!payloadBytes || !receivedSignature) throw invalidState();

    const expectedSignature = sign(secret, payloadSegment!);
    if (
      receivedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(receivedSignature, expectedSignature)
    ) {
      throw invalidState();
    }

    const state = parseCanonicalState(payloadBytes);
    const current = Math.floor(now.getTime() / 1000);
    if (!state || !validUnixSecond(current) || state.iat > current) throw invalidState();
    if (current >= state.exp) throw new AppError("OAUTH_STATE_EXPIRED", 400);
    return state;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalidState();
  }
}
