import "server-only";

import { createConfiguredDrive } from "@/lib/application/configured-drive";
import { createFreeTierHealthService } from "@/lib/application/free-tier-health";
import type { ServerEnv } from "@/lib/config/env";
import type { DriveControlPlaneRepository } from "@/lib/repositories/drive-control-plane";

/** Build the real Drive/Neon guard for server mutations. */
export function createConfiguredFreeTierHealthService(
  env: ServerEnv,
  repository: DriveControlPlaneRepository,
) {
  const drive = createConfiguredDrive(env, repository);
  return createFreeTierHealthService({
    repository,
    access: drive.access,
    files: drive.files,
    neonLimitBytes: env.neonStorageLimitBytes,
    softPercent: env.freeTierSoftPercent,
    staleAfterSeconds: env.quotaStaleAfterSeconds,
  });
}
