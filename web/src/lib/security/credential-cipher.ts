import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import { DRIVE_FILE_SCOPE } from "@/lib/domain/drive";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 4096;
const MAX_CIPHERTEXT_TEXT_LENGTH = Math.ceil(MAX_PLAINTEXT_BYTES * 4 / 3);

export type EncryptedCredential = Readonly<{
  ciphertext: string;
  nonce: string;
  authTag: string;
  keyVersion: 1;
  scope: typeof DRIVE_FILE_SCOPE;
}>;

export interface CredentialCipher {
  encrypt(
    id: string,
    scope: typeof DRIVE_FILE_SCOPE,
    plaintext: string,
  ): EncryptedCredential;
  decrypt(id: string, envelope: EncryptedCredential): string;
}

function aad(id: string, scope: string): Buffer {
  return Buffer.from(`ytb-vps:drive-refresh-token:v1:${id}:${scope}`, "utf8");
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

export function createCredentialCipher(keyBase64url: string): CredentialCipher {
  let key: Buffer | null = null;
  try {
    key = decodeCanonicalBase64url(keyBase64url, KEY_BYTES);
  } catch {
    key = null;
  }
  if (!key) throw new Error("INVALID_TOKEN_KEY");

  return {
    encrypt(id, scope, plaintext) {
      if (scope !== DRIVE_FILE_SCOPE || typeof plaintext !== "string") throw unavailable();
      if (Buffer.byteLength(plaintext, "utf8") > MAX_PLAINTEXT_BYTES) {
        throw new Error("TOKEN_TOO_LARGE");
      }

      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, nonce, {
        authTagLength: AUTH_TAG_BYTES,
      });
      cipher.setAAD(aad(id, scope));
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
          envelope.scope !== DRIVE_FILE_SCOPE ||
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
        decipher.setAAD(aad(id, DRIVE_FILE_SCOPE));
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
