import { DashboardShell } from "@/components/dashboard-shell";
import type { FreeTierHealthView, PublicProject, UsageView } from "@/components/dashboard-types";
import { LoginForm } from "@/components/login-form";
import { createGoogleDriveFilesAdapter } from "@/lib/adapters/google/drive-files";
import { createGoogleOAuthAdapter } from "@/lib/adapters/google/oauth";
import { createDriveAccessProvider } from "@/lib/application/drive-access";
import { createFreeTierHealthService } from "@/lib/application/free-tier-health";
import { currentAdmin } from "@/lib/auth/current-admin";
import { parseServerEnv } from "@/lib/config/env";
import type { Project } from "@/lib/domain/drive";
import type { UsageSnapshot } from "@/lib/ports/drive";
import { createNeonControlPlaneRepository } from "@/lib/repositories/neon-control-plane";
import { createNeonDriveControlPlaneRepository } from "@/lib/repositories/neon-drive-control-plane";
import { createCredentialCipher } from "@/lib/security/credential-cipher";

export const dynamic = "force-dynamic";

function usageView(snapshot: UsageSnapshot | null): UsageView | null {
  return snapshot === null ? null : {
    usedBytes: snapshot.usedBytes,
    limitBytes: snapshot.limitBytes,
    appManagedBytes: snapshot.appManagedBytes,
    observedAt: snapshot.observedAt,
  };
}

function publicProject(project: Project): PublicProject {
  return {
    id: project.id,
    status: project.status,
    name: project.name,
    sourceStatus: project.sourceStatus,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export default async function HomePage() {
  const env = parseServerEnv(process.env);
  if (!(await currentAdmin(env.sessionSecret))) {
    return (
      <main className="page-shell">
        <LoginForm />
      </main>
    );
  }

  const repository = createNeonDriveControlPlaneRepository(env.databaseUrl);
  const oauth = createGoogleOAuthAdapter({
    clientId: env.googleOAuthClientId,
    clientSecret: env.googleOAuthClientSecret,
  });
  const access = createDriveAccessProvider({
    repository,
    oauth,
    cipher: createCredentialCipher(env.driveTokenKeyV1),
  });
  const healthService = createFreeTierHealthService({
    repository,
    access,
    files: createGoogleDriveFilesAdapter(),
    neonLimitBytes: env.neonStorageLimitBytes,
    softPercent: env.freeTierSoftPercent,
    staleAfterSeconds: env.quotaStaleAfterSeconds,
  });
  const [jobs, credential, health, projects] = await Promise.all([
    createNeonControlPlaneRepository(env.databaseUrl).listJobs(),
    repository.getCredential(),
    healthService.getHealth(new Date()),
    repository.listProjects(),
  ]);
  const healthView: FreeTierHealthView = {
    mode: health.mode,
    reasons: [...health.reasons],
    driveConnection: health.driveConnection,
    drive: usageView(health.drive),
    neon: usageView(health.neon),
  };
  const drive = {
    status: credential?.status ?? "DISCONNECTED",
    accountHint: credential?.accountHint ?? null,
    rootReady: credential?.status === "CONNECTED" && credential.rootFolderId !== null,
  } as const;

  return (
    <DashboardShell
      workerOnline={false}
      jobs={jobs}
      drive={drive}
      health={healthView}
      projects={projects.map(publicProject)}
    />
  );
}
