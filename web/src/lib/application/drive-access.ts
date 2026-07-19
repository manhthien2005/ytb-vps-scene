import "server-only";

import { AppError } from "@/lib/domain/errors";
import type { DriveAccessProvider, DriveOAuthPort } from "@/lib/ports/drive";
import type { DriveControlPlaneRepository } from "@/lib/repositories/drive-control-plane";
import type { CredentialCipher } from "@/lib/security/credential-cipher";

const CREDENTIAL_ID = "1";
const PROVIDER_TIMEOUT_MS = 5_000;

type DriveAccessDependencies = Readonly<{
  repository: DriveControlPlaneRepository;
  cipher: CredentialCipher;
  oauth: DriveOAuthPort;
}>;

async function markReauthentication(repository: DriveControlPlaneRepository): Promise<void> {
  await repository.setCredentialStatus("REAUTH_REQUIRED");
  await repository.recordAudit({
    eventType: "DRIVE_REAUTH_REQUIRED",
    actorClass: "admin",
    payload: { reasonCode: "DRIVE_REAUTH_REQUIRED", status: "REAUTH_REQUIRED" },
  });
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
        if (
          typeof accessToken !== "string" ||
          accessToken.length < 1 ||
          accessToken.length > 8_192 ||
          !/^[\x21-\x7E]+$/.test(accessToken)
        ) {
          throw new AppError("DRIVE_PROVIDER_REJECTED", 502);
        }
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
