import "server-only";

import { createGoogleDriveFilesAdapter } from "@/lib/adapters/google/drive-files";
import { createGoogleOAuthAdapter } from "@/lib/adapters/google/oauth";
import { createDriveAccessProvider } from "@/lib/application/drive-access";
import { createFreeTierHealthService } from "@/lib/application/free-tier-health";
import type { ServerEnv } from "@/lib/config/env";
import type { DriveControlPlaneRepository } from "@/lib/repositories/drive-control-plane";
import { createCredentialCipher } from "@/lib/security/credential-cipher";

/** Build the real Drive/Neon guard for server mutations. */
export function createConfiguredFreeTierHealthService(
  env: ServerEnv,
  repository: DriveControlPlaneRepository,
) {
  const oauth = createGoogleOAuthAdapter({
    clientId: env.googleOAuthClientId,
    clientSecret: env.googleOAuthClientSecret,
  });
  const access = createDriveAccessProvider({
    repository,
    oauth,
    cipher: createCredentialCipher(env.driveTokenKeyV1),
  });
  return createFreeTierHealthService({
    repository,
    access,
    files: createGoogleDriveFilesAdapter(),
    neonLimitBytes: env.neonStorageLimitBytes,
    softPercent: env.freeTierSoftPercent,
    staleAfterSeconds: env.quotaStaleAfterSeconds,
  });
}
