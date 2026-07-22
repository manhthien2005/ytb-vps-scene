import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createGoogleDriveFilesAdapter } from "@/lib/adapters/google/drive-files";
import { createGoogleOAuthAdapter } from "@/lib/adapters/google/oauth";
import { createDriveAccessProvider } from "@/lib/application/drive-access";
import {
  createDriveWorkspaceService,
  type DriveWorkspaceService,
} from "@/lib/application/drive-workspace";
import { parseServerEnv, type ServerEnv } from "@/lib/config/env";
import { AppError, publicErrorBody } from "@/lib/domain/errors";
import { HttpError, requireAdmin, requireMutationOrigin } from "@/lib/http/requests";
import { createNeonDriveControlPlaneRepository } from "@/lib/repositories/neon-drive-control-plane";
import { createCredentialCipher } from "@/lib/security/credential-cipher";

export const runtime = "nodejs";
const uuid = z.string().uuid();
const RESPONSE_HEADERS = { "cache-control": "no-store" } as const;

type RouteContext = Readonly<{
  params: Promise<Readonly<{ artifactId: string }>>;
}>;

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

function workspaceService(env: ServerEnv): DriveWorkspaceService {
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
  return createDriveWorkspaceService({
    repository,
    access,
    files: createGoogleDriveFilesAdapter(),
  });
}

async function artifactId(context: RouteContext): Promise<string> {
  const parsed = uuid.safeParse((await context.params).artifactId);
  if (!parsed.success) throw new HttpError(400, "INVALID_REQUEST");
  return parsed.data;
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const env = parseServerEnv(process.env);
    await requireAdmin(request, env.sessionSecret);
    requireMutationOrigin(request, env.appOrigin);
    const id = await artifactId(context);
    const result = await workspaceService(env).delete(id);
    if (result.status !== "DELETED") throw new Error("Unexpected Drive deletion result");
    return NextResponse.json({ status: "DELETED" }, { headers: RESPONSE_HEADERS });
  } catch (error) {
    if (error instanceof AppError) return errorResponse(error);
    return unexpectedErrorResponse();
  }
}
