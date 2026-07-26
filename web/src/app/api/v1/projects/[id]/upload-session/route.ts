import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createConfiguredUploadService } from "@/lib/application/configured-uploads";
import { parseServerEnv } from "@/lib/config/env";
import { AppError, publicErrorBody } from "@/lib/domain/errors";
import { HttpError, readStrictJson, requireAdmin, requireMutationOrigin } from "@/lib/http/requests";

export const runtime = "nodejs";
const BODY_BYTES = 1_024;
const uuid = z.string().uuid();
const uploadIntentBody = z.object({
  fileName: z.string().min(1).max(255),
  mimeType: z.enum(["video/mp4", "video/quicktime", "video/x-matroska", "video/webm"]),
  sizeBytes: z.number().int().positive(),
  lastModified: z.number().int().nonnegative(),
}).strict();
const SESSION_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
} as const;

type RouteContext = Readonly<{ params: Promise<Readonly<{ id: string }>> }>;

function errorResponse(error: AppError): NextResponse {
  return NextResponse.json(publicErrorBody(error), {
    status: error.status,
    headers: SESSION_HEADERS,
  });
}

function unexpectedErrorResponse(error: unknown): NextResponse {
  console.error("[api] unhandled error", error);
  return NextResponse.json(
    { code: "INTERNAL_ERROR" },
    { status: 500, headers: SESSION_HEADERS },
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
    const intent = await readStrictJson(request, uploadIntentBody, BODY_BYTES);
    const result = await createConfiguredUploadService(env, {
      browserOrigin: env.appOrigin,
      onDiagnostic: (event) => console.error("[drive-upload] session-failed", event),
    }).createSession({
      projectId: id,
      intent,
      now: new Date(),
    });
    if ("status" in result) {
      return NextResponse.json({
        artifactId: result.artifactId,
        status: result.status,
        actualSizeBytes: result.actualSizeBytes,
      }, { headers: SESSION_HEADERS });
    }
    return NextResponse.json({
      artifactId: result.artifactId,
      sessionUri: result.sessionUri,
      chunkBytes: result.chunkBytes,
      expiresAt: result.expiresAt,
    }, { headers: SESSION_HEADERS });
  } catch (error) {
    if (error instanceof AppError) return errorResponse(error);
    return unexpectedErrorResponse(error);
  }
}
