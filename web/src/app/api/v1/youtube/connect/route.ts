import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { beginYouTubeConnection } from "@/lib/application/youtube-connection";
import { createConfiguredYouTube } from "@/lib/application/configured-youtube";
import { parseServerEnv } from "@/lib/config/env";
import { AppError, publicErrorBody } from "@/lib/domain/errors";
import { readStrictJson, requireAdmin, requireMutationOrigin } from "@/lib/http/requests";
import { createNeonDriveControlPlaneRepository } from "@/lib/repositories/neon-drive-control-plane";
import { createNeonYouTubeControlPlaneRepository } from "@/lib/repositories/neon-youtube-control-plane";
import { redactSecrets } from "@/lib/security/redact";

export const runtime = "nodejs";
const BODY_BYTES = 128;
const RESPONSE_HEADERS = { "cache-control": "no-store" } as const;
const emptyBody = z.object({}).strict();

function errorResponse(error: AppError): NextResponse {
  return NextResponse.json(publicErrorBody(error), {
    status: error.status,
    headers: RESPONSE_HEADERS,
  });
}

export async function POST(request: NextRequest) {
  const env = parseServerEnv(process.env);
  try {
    await requireAdmin(request, env.sessionSecret);
    requireMutationOrigin(request, env.appOrigin);
    await readStrictJson(request, emptyBody, BODY_BYTES);

    const youtube = createConfiguredYouTube(env);
    const result = await beginYouTubeConnection({
      redirectUri: `${env.appOrigin}/api/v1/youtube/callback`,
      stateSecret: env.sessionSecret,
      now: new Date(),
    }, {
      repository: createNeonYouTubeControlPlaneRepository(env.databaseUrl),
      // The nonce lives in `oauth_states`, which the Drive flow owns.
      states: createNeonDriveControlPlaneRepository(env.databaseUrl),
      oauth: youtube.oauth,
      data: youtube.data,
      cipher: youtube.cipher,
    });
    return NextResponse.json(
      { authorizationUrl: result.authorizationUrl },
      { headers: RESPONSE_HEADERS },
    );
  } catch (error) {
    if (error instanceof AppError) return errorResponse(error);
    console.error("[api] unhandled error", redactSecrets(error));
    return NextResponse.json(
      { code: "INTERNAL_ERROR" },
      { status: 500, headers: RESPONSE_HEADERS },
    );
  }
}
