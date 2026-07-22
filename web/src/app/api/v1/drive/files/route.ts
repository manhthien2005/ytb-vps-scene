import { NextRequest, NextResponse } from "next/server";
import { createGoogleDriveFilesAdapter } from "@/lib/adapters/google/drive-files";
import { createGoogleOAuthAdapter } from "@/lib/adapters/google/oauth";
import { createDriveAccessProvider } from "@/lib/application/drive-access";
import {
  createDriveWorkspaceService,
  type DriveWorkspaceFile,
  type DriveWorkspaceService,
} from "@/lib/application/drive-workspace";
import { parseServerEnv, type ServerEnv } from "@/lib/config/env";
import { AppError, publicErrorBody } from "@/lib/domain/errors";
import { requireAdmin } from "@/lib/http/requests";
import { createNeonDriveControlPlaneRepository } from "@/lib/repositories/neon-drive-control-plane";
import { createCredentialCipher } from "@/lib/security/credential-cipher";

export const runtime = "nodejs";
const RESPONSE_HEADERS = { "cache-control": "no-store" } as const;

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
    onDiagnostic: (diagnostic) => console.error("[drive-workspace] inspection", diagnostic),
  });
}

function publicFile(file: DriveWorkspaceFile): DriveWorkspaceFile {
  return {
    artifactId: file.artifactId,
    name: file.name,
    sizeBytes: file.sizeBytes,
    uploadedAt: file.uploadedAt,
    durationMillis: file.durationMillis,
    width: file.width,
    height: file.height,
    readiness: file.readiness,
    viewUrl: file.viewUrl,
    downloadUrl: file.downloadUrl,
  };
}

export async function GET(request: NextRequest) {
  try {
    const env = parseServerEnv(process.env);
    await requireAdmin(request, env.sessionSecret);
    const view = await workspaceService(env).list();
    return NextResponse.json({
      input: view.input.map(publicFile),
      output: view.output.map((group) => ({
        projectId: group.projectId,
        name: group.name,
        files: group.files.map(publicFile),
      })),
      processingCount: view.processingCount,
    }, { headers: RESPONSE_HEADERS });
  } catch (error) {
    if (error instanceof AppError) return errorResponse(error);
    return unexpectedErrorResponse();
  }
}
