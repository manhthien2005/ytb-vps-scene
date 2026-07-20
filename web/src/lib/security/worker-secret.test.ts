import { describe, expect, it } from "vitest";
import { digestBearerSecret, generateBearerSecret } from "./worker-secret";

const KEY = Buffer.alloc(32, 3).toString("base64url");

describe("worker bearer secrets", () => {
  it("generates a canonical 256-bit base64url value", () => {
    const secret = generateBearerSecret(() => Buffer.alloc(32, 7));
    expect(secret).toBe(Buffer.alloc(32, 7).toString("base64url"));
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("stores a deterministic domain-separated HMAC digest", () => {
    const secret = Buffer.alloc(32, 7).toString("base64url");
    expect(digestBearerSecret(secret, KEY)).toMatch(/^[0-9a-f]{64}$/);
    expect(digestBearerSecret(secret, KEY)).toBe(digestBearerSecret(secret, KEY));
    expect(digestBearerSecret(secret, Buffer.alloc(32, 4).toString("base64url")))
      .not.toBe(digestBearerSecret(secret, KEY));
  });

  it.each([Buffer.alloc(31), Buffer.alloc(33)])("rejects a random source that is not 32 bytes", (bytes) => {
    expect(() => generateBearerSecret(() => bytes)).toThrow("32 bytes");
  });

  it.each(["short", "A".repeat(42), "A".repeat(44)])("rejects malformed secret input", (secret) => {
    expect(() => digestBearerSecret(secret, KEY)).toThrow("canonical");
  });
});
