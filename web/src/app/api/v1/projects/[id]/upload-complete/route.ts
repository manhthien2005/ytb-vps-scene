import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createGoogleDriveFilesAdapter } from "@/lib/adapters/google/drive-files";
import { createGoogleOAuthAdapter } from "@/lib/adapters/google/oauth";
import { createDriveAccessProvider } from "@/lib/application/drive-access";
import { createFreeTierHealthService } from "@/lib/application/free-tier-health";
import { createUploadService, type UploadService } from "@/lib/application/uploads";
import { parseServerEnv, type ServerEnv } from "@/lib/config/env";
import { AppError, publicErrorBody } from "@/lib/domain/errors";
import { HttpError, readStrictJson, requireAdmin, requireMutationOrigin } from "@/lib/http/requests";
import { createNeonDriveControlPlaneRepository } from "@/lib/repositories/neon-drive-control-plane";
import { createCredentialCipher } from "@/lib/security/credential-cipher";

export const runtime = "nodejs";
const BODY_BYTES = 1_024;
const uuid = z.string().uuid();
const completionBody = z.object({ artifactId: uuid }).strict();
const RESPONSE_HEADERS = { "cache-control": "no-store" } as const;

type RouteContext = Readonly<{ params: Promise<Readonly<{ id: string }>> }>;

function errorResponse(error: AppError): NextResponse {
  return NextResponse.json(publicErrorBody(error), {
    status: error.status,
    headers: RESPONSE_HEADERS,
  });
}

function unexpectedErrorResponse(): NextResponse {
  return NextResponse.json(
    { code: "INTERNAL_ERROR" },
    { status: 500, headers: RESPONSE_HEADERS },
  );
}

function uploadService(env: ServerEnv): UploadService {
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
  const files = createGoogleDriveFilesAdapter();
  const health = createFreeTierHealthService({
    repository,
    access,
    files,
    neonLimitBytes: env.neonStorageLimitBytes,
    softPercent: env.freeTierSoftPercent,
    staleAfterSeconds: env.quotaStaleAfterSeconds,
  });
  return createUploadService({
    repository,
    access,
    files,
    health,
    maximumBytes: env.driveUploadMaxBytes,
    softPercent: env.freeTierSoftPercent,
    staleAfterSeconds: env.quotaStaleAfterSeconds,
  });
}

async function projectId(context: RouteContext): Promise<string> {
  const parsed = uuid.safeParse((await context.params).id);
  if (!parsed.success) throw new HttpError(400, "INVALID_REQUEST");
  return parsed.data;
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const env = parseServerEnv(process.env);
    await requireAdmin(request, env.sessionSecret);
    requireMutationOrigin(request, env.appOrigin);
    const id = await projectId(context);
    const body = await readStrictJson(request, completionBody, BODY_BYTES);
    const result = await uploadService(env).complete({
      projectId: id,
      artifactId: body.artifactId,
      now: new Date(),
    });
    if (result.status === "SOURCE_READY") {
      return NextResponse.json({
        status: "SOURCE_READY",
        actualSizeBytes: result.actualSizeBytes,
      }, { status: 200, headers: RESPONSE_HEADERS });
    }
    if (result.status === "UPLOAD_PENDING") {
      return NextResponse.json({
        status: "UPLOAD_PENDING",
        retryAfterMs: result.retryAfterMs,
      }, { status: 202, headers: RESPONSE_HEADERS });
    }
    throw new Error("Unexpected upload completion result");
  } catch (error) {
    if (error instanceof AppError) return errorResponse(error);
    return unexpectedErrorResponse();
  }
}
