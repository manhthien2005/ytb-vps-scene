import "server-only";

import { AppError } from "@/lib/domain/errors";
import type { DriveAccessProvider, DriveOAuthPort } from "@/lib/ports/drive";
import type { DriveControlPlaneRepository } from "@/lib/repositories/drive-control-plane";
import type { CredentialCipher } from "@/lib/security/credential-cipher";

const CREDENTIAL_ID = "1";
const PROVIDER_TIMEOUT_MS = 5_000;
// Google access tokens live ~1h; a short reuse window removes the per-request OAuth
// grant (claim polls, upload sessions) while keeping the revocation blast radius small.
const TOKEN_REUSE_MS = 5 * 60_000;

type CachedAccessToken = Readonly<{ ciphertext: string; token: string; expiresAt: number }>;
let cachedAccessToken: CachedAccessToken | null = null;

export function resetDriveAccessTokenCache(): void {
  cachedAccessToken = null;
}

type DriveAccessDependencies = Readonly<{
  repository: DriveControlPlaneRepository;
  cipher: CredentialCipher;
  oauth: DriveOAuthPort;
}>;

export async function markReauthentication(repository: DriveControlPlaneRepository): Promise<void> {
  await repository.setCredentialStatus("REAUTH_REQUIRED");
  await repository.recordAudit({
    eventType: "DRIVE_REAUTH_REQUIRED",
    actorClass: "admin",
    payload: { reasonCode: "DRIVE_REAUTH_REQUIRED", status: "REAUTH_REQUIRED" },
  });
}

/** One shared definition of an acceptable Google access token for both the
 * connection flow and the access provider. */
export function validGoogleAccessToken(token: unknown): token is string {
  return (
    typeof token === "string" &&
    token.length >= 1 &&
    token.length <= 8_192 &&
    /^[\x21-\x7E]+$/.test(token)
  );
}

function reauthenticationRequired(): AppError {
  return new AppError("DRIVE_REAUTH_REQUIRED", 401);
}

export function createDriveAccessProvider(
  dependencies: DriveAccessDependencies,
): DriveAccessProvider {
  return {
    async getAccessToken() {
      const credential = await dependencies.repository.getCredential();
      if (credential?.status === "REAUTH_REQUIRED") throw reauthenticationRequired();
      if (!credential || credential.status !== "CONNECTED" || credential.envelope === null) {
        throw new AppError("DRIVE_NOT_CONNECTED", 409);
      }

      // Same envelope ciphertext means the same refresh token; the credential status
      // above was still checked live, so disconnect/revoke takes effect immediately.
      if (
        cachedAccessToken !== null &&
        cachedAccessToken.ciphertext === credential.envelope.ciphertext &&
        Date.now() < cachedAccessToken.expiresAt
      ) {
        return cachedAccessToken.token;
      }

      let refreshToken: string;
      try {
        refreshToken = dependencies.cipher.decrypt(CREDENTIAL_ID, credential.envelope);
      } catch {
        await markReauthentication(dependencies.repository);
        throw reauthenticationRequired();
      }

      try {
        const accessToken = await dependencies.oauth.refreshAccessToken(
          refreshToken,
          PROVIDER_TIMEOUT_MS,
        );
        if (!validGoogleAccessToken(accessToken)) {
          throw new AppError("DRIVE_PROVIDER_REJECTED", 502);
        }
        cachedAccessToken = {
          ciphertext: credential.envelope.ciphertext,
          token: accessToken,
          expiresAt: Date.now() + TOKEN_REUSE_MS,
        };
        return accessToken;
      } catch (error) {
        if (error instanceof AppError && error.code === "DRIVE_REAUTH_REQUIRED") {
          await markReauthentication(dependencies.repository);
          throw reauthenticationRequired();
        }
        if (error instanceof AppError) throw error;
        throw new AppError("DRIVE_PROVIDER_REJECTED", 502);
      }
    },
  };
}
