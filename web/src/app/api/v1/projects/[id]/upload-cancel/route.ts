import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createConfiguredUploadService } from "@/lib/application/configured-uploads";
import { parseServerEnv } from "@/lib/config/env";
import { AppError, publicErrorBody } from "@/lib/domain/errors";
import { HttpError, readStrictJson, requireAdmin, requireMutationOrigin } from "@/lib/http/requests";
import { redactSecrets } from "@/lib/security/redact";

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

function unexpectedErrorResponse(error: unknown): NextResponse {
  console.error("[api] unhandled error", redactSecrets(error));
  return NextResponse.json(
    { code: "INTERNAL_ERROR" },
    { status: 500, headers: RESPONSE_HEADERS },
  );
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
    await createConfiguredUploadService(env).cancel({
      projectId: id,
      artifactId: body.artifactId,
      now: new Date(),
    });
    return NextResponse.json({ status: "CANCELLED" }, { headers: RESPONSE_HEADERS });
  } catch (error) {
    if (error instanceof AppError) return errorResponse(error);
    return unexpectedErrorResponse(error);
  }
}
