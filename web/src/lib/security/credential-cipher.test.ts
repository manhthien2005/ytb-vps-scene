// @vitest-environment node
import { createCipheriv } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DRIVE_FILE_SCOPE } from "@/lib/domain/drive";
import { YOUTUBE_SCOPES } from "@/lib/domain/youtube";
import {
  createCredentialCipher,
  DRIVE_CIPHER_PROFILE,
  YOUTUBE_CIPHER_PROFILE,
  type EncryptedCredential,
} from "./credential-cipher";

const KEY = Buffer.alloc(32, 7).toString("base64url");

function replaceEnvelope(
  envelope: EncryptedCredential,
  replacement: Partial<Record<keyof EncryptedCredential, unknown>>,
): EncryptedCredential {
  return { ...envelope, ...replacement } as EncryptedCredential;
}

// Builds an envelope entirely independently of `aad()` / DRIVE_CIPHER_PROFILE, using the
// pre-change wire-format AAD string spelled out as a literal. This is the only test in the
// file that pins the actual byte layout: it never routes through the production AAD builder,
// so a future edit to `aad()` or to `DRIVE_CIPHER_PROFILE.domain` (including a silent typo)
// breaks this test even though it would not break the self-consistent round-trip tests above.
function knownAnswerEnvelope(
  key: Buffer,
  nonce: Buffer,
  aadLiteral: string,
  plaintext: string,
): EncryptedCredential {
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aadLiteral, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64url"),
    nonce: nonce.toString("base64url"),
    authTag: cipher.getAuthTag().toString("base64url"),
    keyVersion: 1,
    scope: DRIVE_FILE_SCOPE,
  };
}

describe("credential cipher", () => {
  it("round-trips only with the matching credential id and scope", () => {
    const cipher = createCredentialCipher(KEY, DRIVE_CIPHER_PROFILE);
    const envelope = cipher.encrypt("1", DRIVE_FILE_SCOPE, "refresh-token");

    expect(cipher.decrypt("1", envelope)).toBe("refresh-token");
    expect(() => cipher.decrypt("2", envelope)).toThrow("CREDENTIAL_UNAVAILABLE");
    expect(() => cipher.decrypt(
      "1",
      replaceEnvelope(envelope, { scope: "https://www.googleapis.com/auth/drive" }),
    )).toThrow("CREDENTIAL_UNAVAILABLE");
  });

  it("enforces the plaintext limit in UTF-8 bytes", () => {
    const cipher = createCredentialCipher(KEY, DRIVE_CIPHER_PROFILE);

    expect(() => cipher.encrypt("1", DRIVE_FILE_SCOPE, "x".repeat(4097)))
      .toThrow("TOKEN_TOO_LARGE");
    expect(() => cipher.encrypt("1", DRIVE_FILE_SCOPE, "😀".repeat(1025)))
      .toThrow("TOKEN_TOO_LARGE");
    expect(cipher.decrypt(
      "1",
      cipher.encrypt("1", DRIVE_FILE_SCOPE, "😀".repeat(1024)),
    )).toBe("😀".repeat(1024));
  });

  it("rejects tampering without exposing envelope values", () => {
    const cipher = createCredentialCipher(KEY, DRIVE_CIPHER_PROFILE);
    const envelope = cipher.encrypt("1", DRIVE_FILE_SCOPE, "refresh-token");
    const first = envelope.ciphertext[0] === "A" ? "B" : "A";
    const tampered = replaceEnvelope(envelope, {
      ciphertext: first + envelope.ciphertext.slice(1),
    });

    let thrown: unknown;
    try {
      cipher.decrypt("1", tampered);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("CREDENTIAL_UNAVAILABLE");
    expect((thrown as Error).message).not.toContain(envelope.ciphertext);
  });

  it.each([
    ["key version", { keyVersion: 2 }],
    ["nonce length", { nonce: Buffer.alloc(11).toString("base64url") }],
    ["tag length", { authTag: Buffer.alloc(15).toString("base64url") }],
    ["noncanonical nonce", { nonce: "A===" }],
    ["noncanonical tag", { authTag: "A===" }],
    ["noncanonical ciphertext", { ciphertext: "A===" }],
    ["oversized ciphertext", { ciphertext: Buffer.alloc(4097).toString("base64url") }],
  ])("rejects an invalid %s before decryption", (_case, replacement) => {
    const cipher = createCredentialCipher(KEY, DRIVE_CIPHER_PROFILE);
    const envelope = cipher.encrypt("1", DRIVE_FILE_SCOPE, "refresh-token");

    expect(() => cipher.decrypt("1", replaceEnvelope(envelope, replacement)))
      .toThrow("CREDENTIAL_UNAVAILABLE");
  });

  it.each([
    Buffer.alloc(31).toString("base64url"),
    `${KEY}=`,
    "not_base64url!",
  ])("rejects an invalid encryption key without echoing it", (key) => {
    let thrown: unknown;
    try {
      createCredentialCipher(key, DRIVE_CIPHER_PROFILE);
    } catch (error) {
      thrown = error;
    }

    expect((thrown as Error).message).toBe("INVALID_TOKEN_KEY");
    expect((thrown as Error).message).not.toContain(key);
  });

  it.each(["nonce", "authTag"] as const)(
    "rejects an oversized %s before base64url decoding",
    (field) => {
      const cipher = createCredentialCipher(KEY, DRIVE_CIPHER_PROFILE);
      const envelope = cipher.encrypt("1", DRIVE_FILE_SCOPE, "refresh-token");
      const oversized = "A".repeat(100_000);
      const from = vi.spyOn(Buffer, "from");
      try {
        expect(() => cipher.decrypt(
          "1",
          replaceEnvelope(envelope, { [field]: oversized }),
        )).toThrow("CREDENTIAL_UNAVAILABLE");
        expect(from.mock.calls.some(([value]) => value === oversized)).toBe(false);
      } finally {
        from.mockRestore();
      }
    },
  );

  it("keeps Drive envelopes decryptable after profiles were introduced", () => {
    const key = Buffer.alloc(32, 7).toString("base64url");
    const cipher = createCredentialCipher(key, DRIVE_CIPHER_PROFILE);
    const envelope = cipher.encrypt("1", DRIVE_FILE_SCOPE, "refresh-token-value");

    expect(envelope.scope).toBe(DRIVE_FILE_SCOPE);
    expect(cipher.decrypt("1", envelope)).toBe("refresh-token-value");
  });

  it("refuses a scope the profile does not allow", () => {
    const key = Buffer.alloc(32, 7).toString("base64url");
    const cipher = createCredentialCipher(key, DRIVE_CIPHER_PROFILE);
    expect(() => cipher.encrypt("1", YOUTUBE_SCOPES[0], "x")).toThrow();
  });

  it("cannot decrypt an envelope produced under a different profile", () => {
    const key = Buffer.alloc(32, 7).toString("base64url");
    const drive = createCredentialCipher(key, DRIVE_CIPHER_PROFILE);
    const youtube = createCredentialCipher(key, YOUTUBE_CIPHER_PROFILE);
    const envelope = youtube.encrypt("abc", YOUTUBE_SCOPES[0], "secret");

    expect(() => drive.decrypt("abc", envelope)).toThrow("CREDENTIAL_UNAVAILABLE");
  });

  it("decrypts a known-answer envelope built independently with the literal pre-change Drive AAD", () => {
    const key = Buffer.alloc(32, 7);
    const nonce = Buffer.alloc(12, 3);
    const envelope = knownAnswerEnvelope(
      key,
      nonce,
      "ytb-vps:drive-refresh-token:v1:1:https://www.googleapis.com/auth/drive.file",
      "known-plaintext-value",
    );

    const cipher = createCredentialCipher(key.toString("base64url"), DRIVE_CIPHER_PROFILE);
    expect(cipher.decrypt("1", envelope)).toBe("known-plaintext-value");
  });

  it("refuses a known-answer envelope encrypted under the wrong AAD literal", () => {
    const key = Buffer.alloc(32, 7);
    const nonce = Buffer.alloc(12, 3);
    const envelope = knownAnswerEnvelope(
      key,
      nonce,
      "ytb-vps:drive-refresh-tokenX:v1:1:https://www.googleapis.com/auth/drive.file",
      "known-plaintext-value",
    );

    const cipher = createCredentialCipher(key.toString("base64url"), DRIVE_CIPHER_PROFILE);
    expect(() => cipher.decrypt("1", envelope)).toThrow("CREDENTIAL_UNAVAILABLE");
  });
});
