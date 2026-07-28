import "server-only";

import { createGoogleDriveFilesAdapter } from "@/lib/adapters/google/drive-files";
import { createGoogleOAuthAdapter } from "@/lib/adapters/google/oauth";
import { createDriveAccessProvider } from "@/lib/application/drive-access";
import type { ServerEnv } from "@/lib/config/env";
import { DRIVE_FILE_SCOPE } from "@/lib/domain/drive";
import type { DriveControlPlaneRepository } from "@/lib/repositories/drive-control-plane";
import { createCredentialCipher, DRIVE_CIPHER_PROFILE } from "@/lib/security/credential-cipher";

export function createConfiguredDrive(
  env: ServerEnv,
  repository: DriveControlPlaneRepository,
) {
  const oauth = createGoogleOAuthAdapter({
    clientId: env.googleOAuthClientId,
    clientSecret: env.googleOAuthClientSecret,
    scopes: [DRIVE_FILE_SCOPE],
  });
  const access = createDriveAccessProvider({
    repository,
    oauth,
    cipher: createCredentialCipher(env.driveTokenKeyV1, DRIVE_CIPHER_PROFILE),
  });
  return Object.freeze({
    access,
    files: createGoogleDriveFilesAdapter(),
  });
}
