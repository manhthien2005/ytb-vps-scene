import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { parseServerEnv } from "@/lib/config/env";
import { AppError, publicErrorBody } from "@/lib/domain/errors";
import {
  HttpError,
  readStrictJson,
  requireAdmin,
  requireMutationOrigin,
} from "@/lib/http/requests";
import { createNeonControlPlaneRepository } from "@/lib/repositories/neon-control-plane";

export const runtime = "nodejs";
const HEADERS = { "cache-control": "no-store" } as const;
const BODY_BYTES = 128;
const uuid = z.string().uuid();
const cancellationBody = z.object({ action: z.literal("cancel") }).strict();

type Context = Readonly<{ params: Promise<Readonly<{ id: string }>> }>;

function errorResponse(error: unknown): NextResponse {
  if (error instanceof AppError) {
    return NextResponse.json(publicErrorBody(error), {
      status: error.status,
      headers: HEADERS,
    });
  }
  return NextResponse.json(
    { code: "INTERNAL_ERROR" },
    { status: 500, headers: HEADERS },
  );
}

async function jobId(context: Context): Promise<string> {
  const parsed = uuid.safeParse((await context.params).id);
  if (!parsed.success) throw new HttpError(400, "INVALID_REQUEST");
  return parsed.data;
}

export async function GET(request: NextRequest, context: Context) {
  try {
    const env = parseServerEnv(process.env);
    await requireAdmin(request, env.sessionSecret);
    const id = await jobId(context);
    const repository = createNeonControlPlaneRepository(env.databaseUrl);
    const job = await repository.getJobDetail(id);
    if (job === null) {
      return NextResponse.json(
        { code: "NOT_FOUND" },
        { status: 404, headers: HEADERS },
      );
    }
    return NextResponse.json({ job }, { headers: HEADERS });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: NextRequest, context: Context) {
  try {
    const env = parseServerEnv(process.env);
    await requireAdmin(request, env.sessionSecret);
    requireMutationOrigin(request, env.appOrigin);
    const id = await jobId(context);
    await readStrictJson(request, cancellationBody, BODY_BYTES);
    const repository = createNeonControlPlaneRepository(env.databaseUrl);
    const outcome = await repository.requestJobCancellation(id, new Date());
    return NextResponse.json(
      { outcome },
      { status: outcome === "NOT_FOUND" ? 404 : 200, headers: HEADERS },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
