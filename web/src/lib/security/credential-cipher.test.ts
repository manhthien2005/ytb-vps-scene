// @vitest-environment node
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
});
