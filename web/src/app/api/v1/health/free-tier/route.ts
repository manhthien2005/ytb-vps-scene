import { NextRequest, NextResponse } from "next/server";
import { createGoogleDriveFilesAdapter } from "@/lib/adapters/google/drive-files";
import { createGoogleOAuthAdapter } from "@/lib/adapters/google/oauth";
import { createDriveAccessProvider } from "@/lib/application/drive-access";
import { createFreeTierHealthService } from "@/lib/application/free-tier-health";
import { parseServerEnv } from "@/lib/config/env";
import { DRIVE_FILE_SCOPE } from "@/lib/domain/drive";
import { AppError } from "@/lib/domain/errors";
import { requireAdmin } from "@/lib/http/requests";
import type { UsageSnapshot } from "@/lib/ports/drive";
import { createNeonDriveControlPlaneRepository } from "@/lib/repositories/neon-drive-control-plane";
import { createCredentialCipher, DRIVE_CIPHER_PROFILE } from "@/lib/security/credential-cipher";

export const runtime = "nodejs";
const HEADERS = { "cache-control": "no-store" } as const;

function usageView(snapshot: UsageSnapshot | null) {
  return snapshot === null ? null : {
    usedBytes: snapshot.usedBytes,
    limitBytes: snapshot.limitBytes,
    appManagedBytes: snapshot.appManagedBytes,
    observedAt: snapshot.observedAt,
  };
}

export async function GET(request: NextRequest) {
  try {
    const env = parseServerEnv(process.env);
    await requireAdmin(request, env.sessionSecret);
    const repository = createNeonDriveControlPlaneRepository(env.databaseUrl);
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
    const health = await createFreeTierHealthService({
      repository,
      access,
      files: createGoogleDriveFilesAdapter(),
      neonLimitBytes: env.neonStorageLimitBytes,
      softPercent: env.freeTierSoftPercent,
      staleAfterSeconds: env.quotaStaleAfterSeconds,
    }).getHealth(new Date());

    return NextResponse.json({
      mode: health.mode,
      reasons: health.reasons,
      driveConnection: health.driveConnection,
      drive: usageView(health.drive),
      neon: usageView(health.neon),
    }, { headers: HEADERS });
  } catch (error) {
    if (error instanceof AppError) {
      return NextResponse.json({ code: error.code }, { status: error.status, headers: HEADERS });
    }
    return NextResponse.json({ code: "HEALTH_UNAVAILABLE" }, { status: 503, headers: HEADERS });
  }
}
