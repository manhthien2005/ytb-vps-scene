import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createGoogleDriveFilesAdapter } from "@/lib/adapters/google/drive-files";
import { createGoogleOAuthAdapter } from "@/lib/adapters/google/oauth";
import { beginDriveConnection } from "@/lib/application/drive-connection";
import { parseServerEnv } from "@/lib/config/env";
import { AppError } from "@/lib/domain/errors";
import { readStrictJson, requireAdmin, requireMutationOrigin } from "@/lib/http/requests";
import { createNeonDriveControlPlaneRepository } from "@/lib/repositories/neon-drive-control-plane";
import { createCredentialCipher } from "@/lib/security/credential-cipher";
import { redactSecrets } from "@/lib/security/redact";

export const runtime = "nodejs";
const BODY_BYTES = 128;
const emptyBody = z.object({}).strict();

function errorResponse(error: AppError): NextResponse {
  return NextResponse.json(
    { code: error.code },
    { status: error.status, headers: { "cache-control": "no-store" } },
  );
}

export async function POST(request: NextRequest) {
  const env = parseServerEnv(process.env);
  try {
    await requireAdmin(request, env.sessionSecret);
    requireMutationOrigin(request, env.appOrigin);
    await readStrictJson(request, emptyBody, BODY_BYTES);

    const repository = createNeonDriveControlPlaneRepository(env.databaseUrl);
    const oauth = createGoogleOAuthAdapter({
      clientId: env.googleOAuthClientId,
      clientSecret: env.googleOAuthClientSecret,
    });
    const result = await beginDriveConnection({
      redirectUri: `${env.appOrigin}/api/v1/drive/callback`,
      stateSecret: env.sessionSecret,
      now: new Date(),
    }, {
      repository,
      oauth,
      files: createGoogleDriveFilesAdapter(),
      cipher: createCredentialCipher(env.driveTokenKeyV1),
    });
    return NextResponse.json(
      { authorizationUrl: result.authorizationUrl },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof AppError) return errorResponse(error);
    console.error("[api] unhandled error", redactSecrets(error));
    return NextResponse.json({ code: "INTERNAL_ERROR" }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}
