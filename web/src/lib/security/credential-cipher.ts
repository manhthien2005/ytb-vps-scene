import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { DRIVE_FILE_SCOPE } from "@/lib/domain/drive";
import { YOUTUBE_SCOPES } from "@/lib/domain/youtube";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 4096;
const MAX_CIPHERTEXT_TEXT_LENGTH = Math.ceil(MAX_PLAINTEXT_BYTES * 4 / 3);

export type CipherProfile = Readonly<{
  domain: string;
  scopes: readonly string[];
}>;

export const DRIVE_CIPHER_PROFILE: CipherProfile = Object.freeze({
  domain: "drive-refresh-token",
  scopes: [DRIVE_FILE_SCOPE] as const,
});

export const YOUTUBE_CIPHER_PROFILE: CipherProfile = Object.freeze({
  domain: "youtube-refresh-token",
  scopes: YOUTUBE_SCOPES,
});

export type EncryptedCredential = Readonly<{
  ciphertext: string;
  nonce: string;
  authTag: string;
  keyVersion: 1;
  scope: string;
}>;

export interface CredentialCipher {
  encrypt(id: string, scope: string, plaintext: string): EncryptedCredential;
  decrypt(id: string, envelope: EncryptedCredential): string;
}

// Unchanged for Drive: domain "drive-refresh-token" reproduces the original
// `ytb-vps:drive-refresh-token:v1:<id>:<scope>` byte-for-byte, so credentials
// stored before this refactor still decrypt.
function aad(domain: string, id: string, scope: string): Buffer {
  return Buffer.from(`ytb-vps:${domain}:v1:${id}:${scope}`, "utf8");
}

function decodeCanonicalBase64url(
  value: unknown,
  expectedBytes?: number,
  allowEmpty = false,
): Buffer | null {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    (expectedBytes !== undefined && value.length !== Math.ceil(expectedBytes * 4 / 3)) ||
    (value.length > 0 && !/^[A-Za-z0-9_-]+$/.test(value))
  ) {
    return null;
  }

  const decoded = Buffer.from(value, "base64url");
  if (
    decoded.toString("base64url") !== value ||
    (expectedBytes !== undefined && decoded.length !== expectedBytes)
  ) {
    return null;
  }
  return decoded;
}

function unavailable(): Error {
  return new Error("CREDENTIAL_UNAVAILABLE");
}

export function createCredentialCipher(
  keyBase64url: string,
  profile: CipherProfile,
): CredentialCipher {
  let key: Buffer | null = null;
  try {
    key = decodeCanonicalBase64url(keyBase64url, KEY_BYTES);
  } catch {
    key = null;
  }
  if (!key) throw new Error("INVALID_TOKEN_KEY");
  if (
    typeof profile?.domain !== "string" ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(profile.domain) ||
    !Array.isArray(profile.scopes) ||
    profile.scopes.length === 0
  ) {
    throw new Error("INVALID_CIPHER_PROFILE");
  }

  return {
    encrypt(id, scope, plaintext) {
      if (!profile.scopes.includes(scope) || typeof plaintext !== "string") throw unavailable();
      if (Buffer.byteLength(plaintext, "utf8") > MAX_PLAINTEXT_BYTES) {
        throw new Error("TOKEN_TOO_LARGE");
      }

      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, nonce, {
        authTagLength: AUTH_TAG_BYTES,
      });
      cipher.setAAD(aad(profile.domain, id, scope));
      const ciphertext = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
      ]);

      return {
        ciphertext: ciphertext.toString("base64url"),
        nonce: nonce.toString("base64url"),
        authTag: cipher.getAuthTag().toString("base64url"),
        keyVersion: 1,
        scope,
      };
    },

    decrypt(id, envelope) {
      try {
        if (
          typeof envelope !== "object" ||
          envelope === null ||
          envelope.keyVersion !== 1 ||
          !profile.scopes.includes(envelope.scope) ||
          typeof envelope.ciphertext !== "string" ||
          envelope.ciphertext.length > MAX_CIPHERTEXT_TEXT_LENGTH
        ) {
          throw unavailable();
        }

        const nonce = decodeCanonicalBase64url(envelope.nonce, NONCE_BYTES);
        const authTag = decodeCanonicalBase64url(envelope.authTag, AUTH_TAG_BYTES);
        const ciphertext = decodeCanonicalBase64url(envelope.ciphertext, undefined, true);
        if (!nonce || !authTag || !ciphertext || ciphertext.length > MAX_PLAINTEXT_BYTES) {
          throw unavailable();
        }

        const decipher = createDecipheriv("aes-256-gcm", key, nonce, {
          authTagLength: AUTH_TAG_BYTES,
        });
        decipher.setAAD(aad(profile.domain, id, envelope.scope));
        decipher.setAuthTag(authTag);
        const plaintext = Buffer.concat([
          decipher.update(ciphertext),
          decipher.final(),
        ]);
        return plaintext.toString("utf8");
      } catch {
        throw unavailable();
      }
    },
  };
}
