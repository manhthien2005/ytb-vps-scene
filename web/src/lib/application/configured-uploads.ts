import "server-only";

import { createConfiguredDrive } from "@/lib/application/configured-drive";
import { createFreeTierHealthService } from "@/lib/application/free-tier-health";
import { createUploadService, type UploadService } from "@/lib/application/uploads";
import type { ServerEnv } from "@/lib/config/env";
import { createNeonDriveControlPlaneRepository } from "@/lib/repositories/neon-drive-control-plane";

type UploadServiceDependencies = Parameters<typeof createUploadService>[0];
type UploadServiceExtras = Readonly<
  Pick<UploadServiceDependencies, "browserOrigin" | "onDiagnostic">
>;

/** Build the real upload service shared by the project upload routes. */
export function createConfiguredUploadService(
  env: ServerEnv,
  extras: UploadServiceExtras = {},
): UploadService {
  const repository = createNeonDriveControlPlaneRepository(env.databaseUrl);
  const drive = createConfiguredDrive(env, repository);
  const health = createFreeTierHealthService({
    repository,
    access: drive.access,
    files: drive.files,
    neonLimitBytes: env.neonStorageLimitBytes,
    softPercent: env.freeTierSoftPercent,
    staleAfterSeconds: env.quotaStaleAfterSeconds,
  });
  return createUploadService({
    repository,
    access: drive.access,
    files: drive.files,
    health,
    maximumBytes: env.driveUploadMaxBytes,
    softPercent: env.freeTierSoftPercent,
    staleAfterSeconds: env.quotaStaleAfterSeconds,
    ...extras,
  });
}
