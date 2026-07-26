import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createGoogleDriveFilesAdapter } from "@/lib/adapters/google/drive-files";
import { createGoogleOAuthAdapter } from "@/lib/adapters/google/oauth";
import { createDriveAccessProvider } from "@/lib/application/drive-access";
import { createProjectService, type ProjectService } from "@/lib/application/projects";
import { parseServerEnv, type ServerEnv } from "@/lib/config/env";
import { AppError } from "@/lib/domain/errors";
import type { Project } from "@/lib/domain/drive";
import {
  HttpError,
  readStrictJson,
  requireAdmin,
  requireMutationOrigin,
} from "@/lib/http/requests";
import { createNeonDriveControlPlaneRepository } from "@/lib/repositories/neon-drive-control-plane";
import { createCredentialCipher } from "@/lib/security/credential-cipher";
import { redactSecrets } from "@/lib/security/redact";

export const runtime = "nodejs";
const BODY_BYTES = 1_024;
const createProjectBody = z.object({ name: z.string().trim().min(1).max(160) }).strict();
const idempotencyKey = z.string().min(16).max(128).regex(/^[A-Za-z0-9._:-]+$/);

function publicProject(project: Project) {
  return {
    id: project.id,
    status: project.status,
    name: project.name,
    sourceStatus: project.sourceStatus,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function errorResponse(error: AppError): NextResponse {
  return NextResponse.json(
    { code: error.code },
    { status: error.status, headers: { "cache-control": "no-store" } },
  );
}

function unexpectedErrorResponse(error: unknown): NextResponse {
  console.error("[api] unhandled error", redactSecrets(error));
  return NextResponse.json(
    { code: "INTERNAL_ERROR" },
    { status: 500, headers: { "cache-control": "no-store" } },
  );
}

function parseIdempotencyKey(request: NextRequest): string {
  const value = request.headers.get("idempotency-key");
  if (value === null) throw new HttpError(400, "INVALID_REQUEST");
  const parsed = idempotencyKey.safeParse(value);
  if (!parsed.success) throw new HttpError(400, "INVALID_REQUEST");
  return parsed.data;
}

function projectService(env: ServerEnv): ProjectService {
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
  return createProjectService({
    repository,
    access,
    files: createGoogleDriveFilesAdapter(),
  });
}

export async function POST(request: NextRequest) {
  const env = parseServerEnv(process.env);
  try {
    await requireAdmin(request, env.sessionSecret);
    requireMutationOrigin(request, env.appOrigin);
    const key = parseIdempotencyKey(request);
    const body = await readStrictJson(request, createProjectBody, BODY_BYTES);
    const result = await projectService(env).createProject({
      idempotencyKey: key,
      name: body.name,
    });

    return NextResponse.json(
      { project: publicProject(result.project) },
      { status: result.outcome === "CREATED" ? 201 : 200, headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof AppError) return errorResponse(error);
    return unexpectedErrorResponse(error);
  }
}

export async function GET(request: NextRequest) {
  const env = parseServerEnv(process.env);
  try {
    await requireAdmin(request, env.sessionSecret);
    const projects = await projectService(env).listProjects();
    return NextResponse.json(
      { projects: projects.map(publicProject) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof AppError) return errorResponse(error);
    return unexpectedErrorResponse(error);
  }
}
